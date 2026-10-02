/**
 * The `kind: "debug"` bridge socket (docs/design/debugger-product.md, 4.1 to 4.6): one Unix socket
 * per `record: false` debug session, so the pyokka CLI can drive the same pause a human drives from
 * the toolbar. Same setting, same default and same descriptor directory as the run-all socket
 * (`pyokka.agentAccess`, off): a socket that serves code execution in the user's process is opt-in,
 * and the debugger is not a reason to loosen that.
 *
 * What it answers: the verbs that need no recording (`state`, `context`, `continue`, `pause`,
 * `step --into/--over/--out`, `locals`, `eval`, `break`, `watches`, `restart`, `stop`, `debug`,
 * `expand`, `select`, `watch`). Every verb that reads a trace is refused with the wording of 4.2,
 * which names `--record`.
 */
import * as vscode from 'vscode';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { DebugSession } from '../debug/debugSession';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { descriptorFor, finishedSlice, launchReply, type LaunchConfig } from '../debug/debugSessionState';
import { startDebugSession } from '../debug/dapAdapter';
import { entryPause, mergeBreakpoints, type PausedInfo } from '../session/debugState';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import { NdjsonDecoder, encodeNdjson } from '../runtime/ndjson';
import { redact, redactValueBag, redactValueNode } from '../util/redact';
import { ensureDir } from '../util/paths';
import { setting } from '../config/settings';
import { log } from '../util/log';
import { BridgeError, int, rm, sessionsDir, socketPathFor, sliceOptions, type Request } from './bridgeSupport';
import { AGENT_ACCESS_SETTING } from './bridge';
import { localsReply, outputTail, pausedReply } from './bridgeDebug';
import { breakpoints, context, execRequest, requirePaused, select, stopOrFinished, stopRunner, stopReply, waitForStop, watches } from './bridgeDebugReply';
import { clampCount, continueTo, continueUntil, stepCount, stepCountExtras } from '../debug/debugExec';
import { parseTo } from './bridgeDebugShapes';

/** A stop reply waits for the program: as long as it runs, within reason. */
const STOP_TIMEOUT_MS = 600_000;
/** The watch stream's `output` events are throttled, with the text accumulated in between. */
const OUTPUT_THROTTLE_MS = 100;

/** Verbs that read a recording, and the hint that says how to get one. */
const RECORDING_VERBS = ['var', 'why', 'walkthrough', 'graph', 'exceptions', 'http', 'values', 'story', 'find', 'steps', 'recording'] as const;
const RECORDING_HINT = 'start the debug session with recording (`pyokka debug FILE --record`, or "Pyokka: Debug Current File (Recording)"), or read a run-all session of the file';
const BACKWARD_REFUSAL = 'this debug session records nothing, so there is nothing behind the pause to replay';
const BACKWARD_HINT = 'into, over and out execute; `--record` gives you the backward moves';

interface Client {
  socket: net.Socket;
  authed: boolean;
  watching: boolean;
}

interface Server {
  ds: DebugSession;
  server: net.Server;
  sockPath: string;
  jsonPath: string;
  token: string;
  clients: Set<Client>;
  detach: () => void;
  /** the descriptor is rewritten once, when a module launch learns its main file */
  file: string;
  pending: string;
  timer: NodeJS.Timeout | undefined;
}

export interface DebugSocketDeps {
  /** the run-all descriptors of a file, for `state.others` */
  runDescriptors: (file: string) => { kind: 'run'; displayName: string; descriptor: string; running: boolean; steps: number }[];
}

export class DebugSocketServer implements vscode.Disposable {
  private readonly servers = new Map<string, Server>();
  private readonly disposables: vscode.Disposable[] = [];
  private counter = 0;

  constructor(
    private readonly manager: DebugSessionManager,
    private readonly deps: DebugSocketDeps,
  ) {
    const started = (ds: DebugSession): void => this.sync(ds);
    const ended = (ds: DebugSession): void => this.close(ds);
    manager.on('sessionStarted', started);
    manager.on('sessionEnded', ended);
    this.disposables.push(
      { dispose: () => {
        manager.off('sessionStarted', started);
        manager.off('sessionEnded', ended);
      } },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`pyokka.${AGENT_ACCESS_SETTING}`)) for (const ds of manager.all()) this.sync(ds);
      }),
    );
    for (const ds of manager.all()) this.sync(ds);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const s of [...this.servers.values()]) this.closeServer(s);
  }

  /** Descriptor path of a debug session's socket (tests). */
  descriptorFor(ds: DebugSession): string | undefined {
    return this.servers.get(ds.id)?.jsonPath;
  }

  /**
   * Serve a request against the debug session whose program is `file`, when one exists: the run
   * socket's pause verbs after a `debug` that started one (route (b)).
   */
  serveFor(file: string): { serve: (type: string, req: Request) => Promise<Record<string, unknown>> } | undefined {
    const ds = this.manager.byPath(file) ?? this.manager.all().find((s) => s.filePath === file);
    if (!ds || ds.isDisposed) return undefined;
    return { serve: (type, req) => this.serve(ds, type, req) };
  }

  /** The debug descriptors of a file, for the run socket's `state.others`. */
  descriptors(file: string): { kind: 'debug'; displayName: string; descriptor: string; running: boolean; paused: boolean }[] {
    return [...this.servers.values()].filter((s) => !file || s.ds.filePath === file || s.ds.launch.program === file).map((s) => ({ kind: 'debug' as const, displayName: s.ds.displayName, descriptor: s.jsonPath, running: s.ds.running, paused: !!s.ds.debug.paused }));
  }

  /**
   * Route (b) of 3.10: the CLI asked a run socket for a debug session. Start one and answer its
   * first stop, so `debug --live` on a run socket reads like `debug --live` on a debug socket.
   */
  async startFor(launch: LaunchConfig, req: Request): Promise<Record<string, unknown>> {
    // the agent entry-pause rule: a cold start with nothing set is guaranteed a stop
    const stopOnEntry = entryPause({ stopOnEntry: launch.stopOnEntry || req.stopOnEntry === true }, mergeBreakpoints(currentSourceBreakpoints(), currentFunctionBreakpoints()), [], { anyFile: true });
    await startDebugSession(launch, { stopOnEntry });
    const ds = this.manager.byKey(launch);
    if (!ds) throw new BridgeError('the debug session did not start', 'see the Pyokka output channel');
    const result = ds.debug.paused ?? (await waitForStop(ds));
    return result === 'finished' ? finishedSlice(ds.lastFinished) : stopReply(ds, result, sliceOptions(req));
  }

  /* ---------- lifecycle ---------- */

  private enabled(ds: DebugSession): boolean {
    return setting<boolean>(AGENT_ACCESS_SETTING, false, vscode.Uri.file(ds.launch.program ?? ds.launch.cwd));
  }

  private sync(ds: DebugSession): void {
    const on = this.enabled(ds) && !ds.isDisposed;
    const has = this.servers.has(ds.id);
    if (on && !has) this.open(ds);
    else if (!on && has) this.close(ds);
  }

  private open(ds: DebugSession): void {
    if (process.platform === 'win32') return; // Unix sockets only for now, as for the run-all socket
    const dir = ensureDir(sessionsDir());
    const base = `${process.pid}-d${++this.counter}`;
    const sockPath = socketPathFor(dir, base);
    const jsonPath = path.join(dir, `${base}.json`);
    rm(sockPath);
    rm(jsonPath);
    const token = crypto.randomBytes(16).toString('hex');
    const server = net.createServer((socket) => this.accept(entry, socket));
    const onPaused = (info: PausedInfo): void => this.broadcast(entry, { event: 'paused', ...pausedReply(context(ds), info) });
    const onResumed = (): void => this.broadcast(entry, { event: 'resumed' });
    const onOutput = (ev: { text: string }): void => this.queueOutput(entry, ev.text);
    const onFinished = (ev: { exitCode: number | null }): void => {
      this.flushOutput(entry);
      // a restart replaces the child: the stream reports the next stop, not an end
      if (!ds.isRestarting) this.broadcast(entry, { event: 'finished', exitCode: ev.exitCode });
    };
    const onChanged = (): void => this.maybeRewrite(entry);
    ds.on('paused', onPaused);
    ds.on('resumed', onResumed);
    ds.on('output', onOutput);
    ds.on('finished', onFinished);
    ds.on('changed', onChanged);
    const entry: Server = {
      ds,
      server,
      sockPath,
      jsonPath,
      token,
      clients: new Set(),
      file: ds.filePath,
      pending: '',
      timer: undefined,
      detach: () => {
        ds.off('paused', onPaused);
        ds.off('resumed', onResumed);
        ds.off('output', onOutput);
        ds.off('finished', onFinished);
        ds.off('changed', onChanged);
      },
    };
    this.servers.set(ds.id, entry);
    server.on('error', (err) => {
      log.error(`agent access: debug socket for ${ds.displayName} failed`, err);
      this.closeServer(entry);
    });
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {
        /* best effort */
      }
      this.write(entry);
      log.info(`agent access: debug session ${ds.displayName} listening on ${sockPath}`);
    });
  }

  private write(entry: Server): void {
    const ds = entry.ds;
    entry.file = ds.filePath;
    const descriptor = descriptorFor({ socket: entry.sockPath, token: entry.token, pid: process.pid, workspace: ds.workspaceRoot, file: entry.file, launch: ds.resolvedLaunch, runtimeVersion: ds.runner?.ready?.runtimeVersion ?? '', started: ds.startedAt });
    fs.writeFileSync(entry.jsonPath, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
  }

  /** A module launch has no file until its first instrumented one arrives: rewrite the descriptor once. */
  private maybeRewrite(entry: Server): void {
    if (entry.ds.filePath === entry.file) return;
    this.write(entry);
    log.info(`agent access: debug descriptor for ${entry.ds.displayName} now names ${entry.file}`);
  }

  private close(ds: DebugSession): void {
    const entry = this.servers.get(ds.id);
    if (entry) this.closeServer(entry);
  }

  private closeServer(entry: Server): void {
    if (this.servers.get(entry.ds.id) === entry) this.servers.delete(entry.ds.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.detach();
    for (const c of entry.clients) c.socket.destroy();
    entry.clients.clear();
    entry.server.close();
    rm(entry.sockPath);
    rm(entry.jsonPath);
    log.info(`agent access: debug socket for ${entry.ds.displayName} closed`);
  }

  /* ---------- wire ---------- */

  private accept(entry: Server, socket: net.Socket): void {
    const client: Client = { socket, authed: false, watching: false };
    entry.clients.add(client);
    socket.setEncoding('utf8');
    const decoder = new NdjsonDecoder((line) => {
      if (!client.authed) return socket.destroy();
      this.send(client, { id: null, ok: false, error: 'invalid JSON', hint: `one JSON object per line: ${line.slice(0, 40)}` });
    });
    let queue: Promise<void> = Promise.resolve();
    socket.on('data', (chunk: string | Buffer) => {
      for (const msg of decoder.push(chunk)) {
        if (!client.authed) {
          const token = msg && typeof msg === 'object' ? (msg as { token?: unknown }).token : undefined;
          if (token !== entry.token) {
            log.warn(`agent access: debug socket for ${entry.ds.displayName} rejected a connection (bad token)`);
            socket.destroy();
            return;
          }
          client.authed = true;
          continue;
        }
        const req = (msg && typeof msg === 'object' ? msg : {}) as Request;
        queue = queue.then(() => this.handle(entry, client, req));
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => entry.clients.delete(client));
  }

  private send(client: Client, msg: unknown): void {
    if (client.socket.destroyed) return;
    client.socket.write(encodeNdjson(msg));
  }

  private broadcast(entry: Server, msg: unknown): void {
    for (const c of entry.clients) if (c.authed && c.watching) this.send(c, msg);
  }

  private queueOutput(entry: Server, text: string): void {
    entry.pending += text;
    if (entry.timer) return;
    entry.timer = setTimeout(() => this.flushOutput(entry), OUTPUT_THROTTLE_MS);
  }

  private flushOutput(entry: Server): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.pending) return;
    const text = entry.pending;
    entry.pending = '';
    this.broadcast(entry, { event: 'output', stream: 'stdout', text: redact(text) });
  }

  private async handle(entry: Server, client: Client, req: Request): Promise<void> {
    const id = req.id ?? null;
    const type = String(req.type ?? req.request ?? req.cmd ?? '');
    log.info(`agent access: [debug ${entry.ds.displayName}] ${type || '?'} #${String(id)}`);
    try {
      if (entry.ds.isDisposed) throw new BridgeError('no live session', 'the debug session ended when the program exited; `pyokka debug FILE` starts another');
      const result = await this.dispatch(entry, client, type, req);
      this.send(client, { id, ok: true, ...result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const hint = err instanceof BridgeError ? err.hint : 'see the Pyokka output channel';
      this.send(client, { id, ok: false, error: redact(error), hint });
    }
  }

  private async dispatch(entry: Server, client: Client, type: string, req: Request): Promise<Record<string, unknown>> {
    if (type === 'watch') {
      client.watching = true;
      return {};
    }
    if (type === 'unwatch') {
      client.watching = false;
      return {};
    }
    return this.serve(entry.ds, type, req);
  }

  /**
   * Serve one request against `ds`. Reachable from the run socket too: a `debug` that arrived
   * there started this session, and the pause verbs that follow on the same connection address it
   * (`serveFor`), so `pyokka shell --live` can start and drive a debug session over one socket.
   */
  async serve(ds: DebugSession, type: string, req: Request): Promise<Record<string, unknown>> {
    if ((RECORDING_VERBS as readonly string[]).includes(type)) throw new BridgeError(`${type} needs a recording`, RECORDING_HINT);
    switch (type) {
      case 'state':
        return this.state(ds);
      case 'context':
        return this.context(ds, req);
      case 'select':
        await select(ds, req);
        return {};
      case 'debug': {
        const paused = ds.debug.paused;
        if (paused) return stopReply(ds, paused, sliceOptions(req));
        // a session that has not paused yet is a start in flight: wait for its first stop, which is
        // what a cold `pyokka debug FILE` reads. One that has already paused and run on is refused:
        // killing a running server on a repeated `debug` is the worse failure.
        if (!ds.pausedOnce && ds.status !== 'ended') return this.stop(ds, req, () => Promise.resolve());
        throw new BridgeError(`the debug session of ${ds.displayName} is running`, '`pause --live` stops it at its next statement; `restart --live` starts it again from the top');
      }
      case 'continue': {
        requirePaused(ds, 'continue');
        if (req.noWait === true) {
          await ds.debugContinue();
          return { resumed: true };
        }
        const until = typeof req.until === 'string' ? req.until.trim() : '';
        // `--until EXPR` is a one-shot break-when watch, `--to FILE:LINE` the run-to-line breakpoint
        if (until) return stopOrFinished(ds, await continueUntil(stopRunner(ds), until), sliceOptions(req));
        if (req.to !== undefined) {
          const to = parseTo(context(ds), req.to);
          if (!to) throw new BridgeError('continue --to wants FILE:LINE', 'send {to: {file: "app.py", line: 82}}');
          return stopOrFinished(ds, await continueTo(stopRunner(ds), to.file, to.line), sliceOptions(req));
        }
        return this.stop(ds, req, () => ds.debugContinue());
      }
      case 'pause': {
        const paused = ds.debug.paused;
        if (paused) return stopReply(ds, paused, sliceOptions(req));
        if (!ds.running) throw new BridgeError('the debug session is not running', '`restart --live` starts it again from the top');
        if (req.noWait === true) {
          await ds.debugPause();
          return { requested: true, paused: false };
        }
        return this.stop(ds, req, () => ds.debugPause());
      }
      case 'step': {
        const kind = typeof req.kind === 'string' ? req.kind : '';
        if (int(req.to) !== undefined || kind === 'back' || kind === 'backOver' || kind === 'backOut' || kind === 'to') throw new BridgeError(BACKWARD_REFUSAL, BACKWARD_HINT);
        if (kind !== 'into' && kind !== 'over' && kind !== 'out') throw new BridgeError('step needs kind', 'kind is one of into, over, out');
        requirePaused(ds, `step ${kind}`);
        // `--count N`: N stops in a row, the last one is the reply (clamped to 1..1000)
        if (req.count !== undefined && clampCount(req.count) > 1) {
          const out = await stepCount(stopRunner(ds), kind, clampCount(req.count));
          return { ...(await stopOrFinished(ds, out.result, sliceOptions(req))), ...stepCountExtras(out) };
        }
        return this.stop(ds, req, () => ds.debugStep(kind));
      }
      case 'stop': {
        const runId = ds.runId;
        ds.stopDebug();
        await waitForStop(ds, 30_000).catch(() => undefined);
        return { stopped: true, runId, ...finishedSlice(ds.lastFinished) };
      }
      case 'restart':
        return this.stop(ds, req, () => ds.restart({ stopOnEntry: req.stopOnEntry === true }));
      case 'break':
        return breakpoints(ds, req);
      case 'watches':
        return watches(ds, req);
      case 'locals':
        requirePaused(ds, 'list the locals');
        return { locals: localsReply(await ds.debugLocals({ frameId: int(req.frameId) }), !!req.valueBag), modified: ds.modified };
      case 'eval': {
        const expression = typeof req.expression === 'string' ? req.expression.trim() : '';
        if (!expression) throw new BridgeError('eval needs expression', 'send {expression: "name.attr"}');
        requirePaused(ds, 'evaluate');
        const r = await ds.evaluate(expression, { frameId: int(req.frameId) });
        if (!r) throw new BridgeError(`not evaluable: ${expression}`, 'pure calls run (builtins like len, sorted, isinstance; non-mutating methods of str, dict, list, tuple, set); a user function and an unknown name are refused');
        return { text: redact(r.text), valueBag: r.valueBag ? redactValueBag(r.valueBag) : undefined };
      }
      case 'exec':
        return execRequest(ds, req);
      case 'expand': {
        const valueId = typeof req.valueId === 'string' ? req.valueId : '';
        if (!valueId) throw new BridgeError('expand needs valueId', 'valueId is the id of a value node (eval, or locals with valueBag: true)');
        const node = await ds.expand(valueId, Array.isArray(req.queryPath) ? req.queryPath.map(String) : []);
        if (!node) throw new BridgeError('nothing to expand from', 'the debug session ended');
        return { node: redactValueNode(node) };
      }
      case 'record':
        // a debug session has no run-all session to hold a trace; a `recordFrom` launch has one
        throw new BridgeError(`the debug session of ${ds.displayName} records nothing, so it cannot start recording here`, 'start it with `pyokka debug FILE --record-from NAME` (or FILE:LINE): it pauses there and records from that pause on; `record --live` at an earlier pause of that run starts it sooner');
      default:
        throw new BridgeError(`unknown request ${JSON.stringify(type)}`, 'a debug session serves state, context, step, continue, pause, stop, restart, debug, break, watches, locals, eval, exec, expand, select, watch, unwatch');
    }
  }

  /* ---------- requests ---------- */

  private state(ds: DebugSession): Record<string, unknown> {
    const d = ds.debug;
    const p = d.paused;
    return {
      kind: 'debug',
      running: ds.running,
      paused: !!p,
      record: ds.launch.record,
      modified: ds.modified,
      displayName: ds.displayName,
      file: ds.filePath,
      launch: launchReply(ds.resolvedLaunch),
      debug: { active: true, paused: p ? pausedReply(context(ds), p) : null, frontier: null, exceptions: d.exceptions, modified: ds.modified },
      thread: p?.thread ?? null,
      output: outputTail(ds.output),
      others: this.deps.runDescriptors(ds.filePath),
    };
  }

  private async context(ds: DebugSession, req: Request): Promise<Record<string, unknown>> {
    const paused = ds.debug.paused;
    if (!paused) throw new BridgeError('the debug session is running, so there is no frame to read', '`pause --live` stops it at its next statement');
    return stopReply(ds, paused, sliceOptions(req));
  }

  /** Run `action`, then wait for the stop it leads to: the next pause, or the end of the run. */
  private async stop(ds: DebugSession, req: Request, action: () => Promise<void>): Promise<Record<string, unknown>> {
    const next = waitForStop(ds);
    try {
      await action();
    } catch (err) {
      next.catch(() => undefined);
      throw err instanceof BridgeError ? err : new BridgeError(err instanceof Error ? err.message : String(err), 'see the Pyokka output channel');
    }
    const result = await next;
    return result === 'finished' ? finishedSlice(ds.lastFinished) : stopReply(ds, result, sliceOptions(req));
  }
}
