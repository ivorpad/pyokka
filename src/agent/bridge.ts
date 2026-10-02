/**
 * Agent bridge: one Unix socket per session (when `pyokka.agentAccess` is on) that lets a local
 * agent (the pyokka CLI) read the run and drive the Time Machine. Contract: docs/PROTOCOL.md,
 * "Agent access". NDJSON both ways; the first client line carries the token of the sibling
 * descriptor; every reply is redacted.
 */
import * as vscode from 'vscode';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Session } from '../session/session';
import type { PausedInfo } from '../session/debugState';
import type { RunFinishedEvent } from '../shared/protocol';
import type { SessionManager } from '../session/sessionManager';
import type { TimeMachine, MoveKind } from '../timeMachine/navigator';
import { contextSliceForLine, contextSliceForStep, locationAt, valuesAtStep, valuesForLine, type SliceInputs, type SliceOptions } from '../session/contextSlice';
import { sessionProvenance, sessionVariableHistory } from '../session/variableQuery';
import { redact, redactValueBag, redactValueNode } from '../util/redact';
import { ensureDir } from '../util/paths';
import { BridgeError, awaitIdle, describe, fileIdFor, int, isStale, readSource, redactExceptionReport, redactGraph, redactHistory, redactHttpTable, redactProvenance, redactSlice, redactValues, redactWalkthrough, rm, sessionRecording, sessionsDir, socketPathFor, sliceOptions, sweepDeadDescriptors, walkthroughInputs, type Request } from './bridgeSupport';
import { buildWalkthrough } from '../session/walkthrough';
import { buildExecutionGraph } from '../session/executionGraph';
import { buildHttpTable } from '../session/httpTable';
import { buildExceptionReport } from '../session/exceptionReport';
import { NdjsonDecoder, encodeNdjson } from '../runtime/ndjson';
import { BridgeDebug, stateDebug } from './bridgeDebug';
import { preRecordingPayload } from './bridgeRecordFrom';
import { DebugSocketServer } from './bridgeDebugSocket';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { debugDocument, restartDebugging, stopDebugging } from '../debug/dapAdapter';
import { setting } from '../config/settings';
import { log } from '../util/log';

export const AGENT_ACCESS_SETTING = 'agentAccess';
const REQUEST_TYPES = ['state', 'step', 'context', 'values', 'var', 'why', 'eval', 'exec', 'expand', 'select', 'watch', 'unwatch', 'walkthrough', 'graph', 'exceptions', 'http', 'debug', 'continue', 'pause', 'stop', 'restart', 'break', 'watches', 'locals', 'record', 'recording'] as const;
const MOVE_KINDS: readonly MoveKind[] = ['into', 'over', 'out', 'back', 'backOver', 'backOut'];

interface Client {
  socket: net.Socket;
  authed: boolean;
  watching: boolean;
  /** the request being served, so a socket closed under it can still send the reply */
  pending?: Promise<void>;
}

/** how long a closing socket waits for the reply it owes */
const CLOSE_GRACE_MS = 2_000;

interface SessionServer {
  session: Session;
  server: net.Server;
  sockPath: string;
  jsonPath: string;
  token: string;
  clients: Set<Client>;
  detach: () => void;
}

export class AgentBridge implements vscode.Disposable {
  private readonly servers = new Map<string, SessionServer>();
  private readonly disposables: vscode.Disposable[] = [];
  private counter = 0;
  private windowsNoticeShown = false;
  /** the debugger's requests (bridgeDebug.ts) */
  private readonly debugBridge: BridgeDebug;
  /** the `kind: "debug"` sockets of the Debugger's own sessions (bridgeDebugSocket.ts) */
  private readonly debugSockets: DebugSocketServer;
  private readonly onStarted = (s: Session): void => this.sync(s);
  private readonly onStopped = (s: Session): void => this.close(s);

  constructor(
    private readonly manager: SessionManager,
    private readonly timeMachine: TimeMachine,
    /** the session's cached narration glosses (the Narrator), merged into `walkthrough` replies */
    private readonly glosses: (session: Session) => Record<string, string> | undefined = () => undefined,
    /** the Debugger's registry: its sessions get their own `kind: "debug"` sockets */
    debugSessions: DebugSessionManager,
  ) {
    this.debugSockets = new DebugSocketServer(debugSessions, { runDescriptors: (file) => this.runDescriptors(file) });
    this.debugBridge = new BridgeDebug(timeMachine, {
      slice: (s, step, opts) => this.slice(s, step, opts),
      startDebugging: (s, opts) => debugDocument(s.document, s, { ...opts, record: true }),
      restartDebugging: (s, opts) => restartDebugging(s, opts),
      stopDebugging: (s) => stopDebugging(s),
      startDebugSession: (launch, req) => this.debugSockets.startFor(launch, req),
      debugSessionFor: (s) => this.debugSockets.serveFor(s.filePath),
    });
    manager.on('sessionStarted', this.onStarted);
    manager.on('sessionStopped', this.onStopped);
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`pyokka.${AGENT_ACCESS_SETTING}`)) for (const s of manager.all()) this.sync(s);
      }),
    );
    sweepDeadDescriptors();
    for (const s of manager.all()) this.sync(s);
  }

  dispose(): void {
    this.manager.off('sessionStarted', this.onStarted);
    this.manager.off('sessionStopped', this.onStopped);
    for (const d of this.disposables) d.dispose();
    this.debugSockets.dispose();
    for (const s of [...this.servers.values()]) this.closeServer(s);
  }

  /** Descriptor path of a session's bridge (tests). */
  descriptorFor(session: Session): string | undefined {
    return this.servers.get(session.key)?.jsonPath;
  }

  /** Descriptor path of a debug session's socket (tests). */
  debugDescriptorFor(ds: Parameters<DebugSocketServer['descriptorFor']>[0]): string | undefined {
    return this.debugSockets.descriptorFor(ds);
  }

  /** The run-all descriptors of a file, for the debug socket's `state.others`. */
  private runDescriptors(file: string): { kind: 'run'; displayName: string; descriptor: string; running: boolean; steps: number }[] {
    return [...this.servers.values()].filter((s) => !file || s.session.filePath === file).map((s) => ({ kind: 'run' as const, displayName: s.session.displayName, descriptor: s.jsonPath, running: s.session.running, steps: s.session.trace?.count ?? 0 }));
  }

  private enabled(session: Session): boolean {
    return setting<boolean>(AGENT_ACCESS_SETTING, false, session.document.uri);
  }

  /** Open or close the session's socket so it matches the setting. */
  private sync(session: Session): void {
    const on = this.enabled(session) && !session.isDisposed;
    const has = this.servers.has(session.key);
    if (on && !has) this.open(session);
    else if (!on && has) this.close(session);
  }

  /* ---------- lifecycle ---------- */

  private open(session: Session): void {
    if (process.platform === 'win32') {
      if (!this.windowsNoticeShown) {
        this.windowsNoticeShown = true;
        log.warn('agent access: Unix sockets only for now; named pipes on Windows come later');
      }
      return;
    }
    const dir = ensureDir(sessionsDir());
    const base = `${process.pid}-${++this.counter}`;
    const sockPath = socketPathFor(dir, base);
    const jsonPath = path.join(dir, `${base}.json`);
    rm(sockPath);
    rm(jsonPath);
    const token = crypto.randomBytes(16).toString('hex');
    const clients = new Set<Client>();
    const server = net.createServer((socket) => this.accept(entry, socket));
    const onNav = (): void => this.broadcast(entry, this.stepEvent(session));
    const onRun = (runId: string): void => this.broadcast(entry, { event: 'rerun', runId });
    const onPaused = (info: PausedInfo): void => this.broadcast(entry, this.debugBridge.pausedEvent(session, info, this.stepPayload(session, info.step)));
    const onResumed = (): void => this.broadcast(entry, { event: 'resumed' });
    const onFinished = (ev: RunFinishedEvent): void => {
      if (session.debug.runId === ev.runId) this.broadcast(entry, { event: 'finished', exitCode: ev.exitCode });
    };
    session.on('navChanged', onNav);
    session.on('runStarted', onRun);
    session.on('debugPaused', onPaused);
    session.on('debugResumed', onResumed);
    session.on('runFinished', onFinished);
    const entry: SessionServer = {
      session,
      server,
      sockPath,
      jsonPath,
      token,
      clients,
      detach: () => {
        session.off('navChanged', onNav);
        session.off('runStarted', onRun);
        session.off('debugPaused', onPaused);
        session.off('debugResumed', onResumed);
        session.off('runFinished', onFinished);
      },
    };
    this.servers.set(session.key, entry);
    server.on('error', (err) => {
      log.error(`agent access: socket for ${session.displayName} failed`, err);
      this.closeServer(entry);
    });
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {
        /* best effort */
      }
      const descriptor = {
        socket: sockPath,
        token,
        pid: process.pid,
        // additive: an older CLI ignores it, a newer one prefers the right socket per verb (4.7)
        kind: 'run',
        workspace: session.workspaceRoot,
        file: session.filePath,
        displayName: session.displayName,
        runtimeVersion: session.runner.ready?.runtimeVersion ?? '',
        started: new Date(session.startedAt).toISOString(),
      };
      fs.writeFileSync(jsonPath, JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600 });
      log.info(`agent access: ${session.displayName} listening on ${sockPath}`);
    });
  }

  private close(session: Session): void {
    const entry = this.servers.get(session.key);
    if (entry) this.closeServer(entry);
  }

  private closeServer(entry: SessionServer): void {
    if (this.servers.get(entry.session.key) === entry) this.servers.delete(entry.session.key);
    entry.detach();
    // a request in flight still gets its answer: a `continue` that ran the program to its end is
    // answered `finished` after the session stopped, and destroying the socket now would drop it
    for (const c of entry.clients) {
      if (!c.pending) {
        c.socket.destroy();
        continue;
      }
      void Promise.race([c.pending, new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))]).then(() => c.socket.destroy());
    }
    entry.clients.clear();
    entry.server.close();
    rm(entry.sockPath);
    rm(entry.jsonPath);
    log.info(`agent access: ${entry.session.displayName} socket closed`);
  }

  /* ---------- wire ---------- */

  private accept(entry: SessionServer, socket: net.Socket): void {
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
            log.warn(`agent access: ${entry.session.displayName} rejected a connection (bad token)`);
            socket.destroy();
            return;
          }
          client.authed = true;
          continue;
        }
        const req = (msg && typeof msg === 'object' ? msg : {}) as Request;
        queue = queue.then(() => this.handle(entry, client, req));
        client.pending = queue;
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => entry.clients.delete(client));
  }

  private send(client: Client, msg: unknown): void {
    if (client.socket.destroyed) return;
    client.socket.write(encodeNdjson(msg));
  }

  private broadcast(entry: SessionServer, msg: unknown): void {
    for (const c of entry.clients) if (c.authed && c.watching) this.send(c, msg);
  }

  private async handle(entry: SessionServer, client: Client, req: Request): Promise<void> {
    const id = req.id ?? null;
    const type = String(req.type ?? req.request ?? req.cmd ?? '');
    const session = entry.session;
    log.info(`agent access: [${session.displayName}] ${type || '?'} #${String(id)}${describe(req)}`);
    try {
      if (session.isDisposed) throw new BridgeError('session stopped', 'start a Pyokka session on the file again');
      const result = await this.dispatch(entry, client, type, req);
      this.send(client, { id, ok: true, ...result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const hint = err instanceof BridgeError ? err.hint : 'see the Pyokka output channel';
      this.send(client, { id, ok: false, error: redact(error), hint });
    }
  }

  private async dispatch(entry: SessionServer, client: Client, type: string, req: Request): Promise<Record<string, unknown>> {
    const session = entry.session;
    switch (type) {
      case 'state':
        return this.state(session);
      case 'step':
        return this.step(session, req);
      case 'context':
        return this.context(session, req);
      case 'values': {
        const inputs = this.inputs(session);
        const fileId = fileIdFor(session, req.file);
        const line = int(req.line);
        if (line === undefined) throw new BridgeError('values needs line', 'send {file, line}');
        return { values: redactValues(valuesForLine(inputs, fileId, line, sliceOptions(req))) };
      }
      case 'var': {
        const name = typeof req.name === 'string' ? req.name.trim() : '';
        if (!name) throw new BridgeError('var needs name', 'send {name: "dt"}; an attribute path (self.balance) works too, and file / scope narrow the list');
        await awaitIdle(session);
        this.inputs(session); // throws the "no trace" error with its hint
        const fileId = typeof req.file === 'string' && req.file ? fileIdFor(session, req.file) : undefined;
        const scope = typeof req.scope === 'string' && req.scope ? req.scope : undefined;
        const history = await sessionVariableHistory(session, name, { fileId, scope, limit: int(req.limit) });
        if (!history) throw new BridgeError('no execution trace', 'run the file first (save, or Re-execute)');
        return { ...redactHistory(history) };
      }
      case 'why': {
        const step = int(req.step);
        if (step === undefined) throw new BridgeError('why needs step', 'send {step: N, name?: "total", depth?: 5}: the step of a var change, or of the Time Machine; name empty explains the statement');
        const name = typeof req.name === 'string' ? req.name.trim() : '';
        await awaitIdle(session);
        const trace = this.inputs(session).trace; // throws the "no trace" error with its hint
        if (!trace.valid(step)) throw new BridgeError(`step ${step} is out of range`, `steps are 0..${trace.count - 1}`);
        const tree = await sessionProvenance(session, step, name, int(req.depth));
        if (!tree) throw new BridgeError('no execution trace', 'run the file first (save, or Re-execute)');
        return { ...redactProvenance(tree) };
      }
      case 'eval': {
        const expression = typeof req.expression === 'string' ? req.expression.trim() : '';
        if (!expression) throw new BridgeError('eval needs expression', 'send {expression: "name.attr"}');
        await awaitIdle(session);
        if (!session.debug.paused && (!session.state.finished || session.state.finished.stopped)) throw new BridgeError('no finished run to evaluate against', 'run the file first (save, or Re-execute), or pause a debug run');
        const ev = await session.evaluateLive(expression);
        if (!ev) throw new BridgeError(`not evaluable: ${expression}`, 'pure calls run (builtins like len, sorted, isinstance; non-mutating methods of str, dict, list, tuple, set); a user function and an unknown name are refused');
        return { text: redact(ev.text), valueBag: ev.valueBag ? redactValueBag(ev.valueBag) : undefined, logId: ev.logId };
      }
      case 'expand': {
        const valueId = typeof req.valueId === 'string' ? req.valueId : '';
        const queryPath = Array.isArray(req.queryPath) ? req.queryPath.map(String) : [];
        if (!valueId) throw new BridgeError('expand needs valueId', 'valueId is the id of a value node (eval, or values with valueBag: true)');
        await awaitIdle(session);
        if (!session.state.finished && !session.debug.paused) throw new BridgeError('no finished run to expand from', 'run the file first');
        try {
          const node = await session.runner.expand(session.state.runId, valueId, queryPath);
          return { node: redactValueNode(node) };
        } catch (err) {
          throw new BridgeError(err instanceof Error ? err.message : String(err), 'valueId must come from this run; re-read the value after a re-run');
        }
      }
      case 'select':
        await this.select(session, req);
        return {};
      case 'walkthrough': {
        await awaitIdle(session);
        const inputs = walkthroughInputs(session, this.glosses(session));
        if (!inputs) throw new BridgeError('no execution trace yet', session.running ? 'a run is in flight; retry in a moment' : 'run the file first (save, or Re-execute)');
        const fileId = typeof req.file === 'string' && req.file ? fileIdFor(session, req.file) : undefined;
        const scope = typeof req.scope === 'string' && req.scope ? req.scope : undefined;
        const w = buildWalkthrough(inputs, { fileId, scope, from: int(req.from), to: int(req.to), all: !!req.all });
        return redactWalkthrough(w) as unknown as Record<string, unknown>;
      }
      case 'graph': {
        await awaitIdle(session);
        const inputs = walkthroughInputs(session);
        if (!inputs) throw new BridgeError('no execution trace yet', session.running ? 'a run is in flight; retry in a moment' : 'run the file first (save, or Re-execute)');
        const scope = typeof req.scope === 'string' && req.scope ? req.scope : undefined;
        const expand = Array.isArray(req.expand) ? req.expand.map(String).filter(Boolean) : typeof req.expand === 'string' && req.expand ? [req.expand] : undefined;
        const g = buildExecutionGraph(inputs, { all: !!req.all, scope, expand, statements: req.statements !== false });
        return redactGraph(g) as unknown as Record<string, unknown>;
      }
      case 'http': {
        // no awaitIdle: the table answers mid-run with the rows so far
        const st = session.state;
        const table = buildHttpTable({
          runId: st.runId,
          running: session.running,
          events: st.http,
          finished: st.finished?.http ?? null,
          locate: (rid) => {
            const loc = session.locate(rid);
            return loc && { fileId: loc.fileId, file: loc.path, line: loc.range[0], col: loc.range[1] };
          },
        });
        return redactHttpTable(table) as unknown as Record<string, unknown>;
      }
      case 'exceptions': {
        await awaitIdle(session);
        const inputs = walkthroughInputs(session);
        if (!inputs) throw new BridgeError('no execution trace yet', session.running ? 'a run is in flight; retry in a moment' : 'run the file first (save, or Re-execute)');
        return redactExceptionReport(buildExceptionReport(inputs)) as unknown as Record<string, unknown>;
      }
      case 'recording': {
        // the whole run as a saved run's {meta, events}: `pyokka tour --live` reads it with the saved-run code
        await awaitIdle(session);
        const doc = sessionRecording(session);
        if (!doc) throw new BridgeError('no execution trace yet', session.running ? 'a run is in flight; retry in a moment' : 'run the file first (save, or Re-execute)');
        return doc;
      }
      case 'watch':
        client.watching = true;
        return {};
      case 'unwatch':
        client.watching = false;
        return {};
      case 'debug':
        return this.debugBridge.debug(session, req);
      case 'continue':
        return this.debugBridge.resume(session, req);
      case 'pause':
        return this.debugBridge.pause(session, req);
      case 'stop':
        return this.debugBridge.stopRun(session, req);
      case 'restart':
        return this.debugBridge.restart(session, req);
      case 'break':
        return this.debugBridge.breakpoints(session, req);
      case 'watches':
        return this.debugBridge.watches(session, req);
      case 'locals':
        return this.debugBridge.locals(session, req);
      case 'exec':
        return this.debugBridge.exec(session, req);
      case 'record':
        return this.debugBridge.record(session, req);
      default:
        throw new BridgeError(`unknown request ${JSON.stringify(type)}`, `type is one of ${REQUEST_TYPES.join(', ')}`);
    }
  }

  /* ---------- requests ---------- */

  private state(session: Session): Record<string, unknown> {
    const st = session.state;
    const nav = session.nav;
    const trace = session.trace;
    const out: Record<string, unknown> = {
      kind: 'run',
      runId: st.runId,
      running: session.running,
      finished: !!st.finished,
      stale: isStale(session),
      nav: { active: nav.active, step: nav.active ? nav.currentStep : null, count: trace?.count ?? 0 },
      displayName: session.displayName,
      file: session.filePath,
      http: session.http,
      debug: stateDebug(session),
      others: this.debugSockets.descriptors(session.filePath),
    };
    if (nav.active && trace) out['location'] = locationAt(this.inputs(session), nav.currentStep);
    // the step cap cut this run: the same `recording` a saved run's state carries (recording.py)
    if (trace?.truncated) out['recording'] = { truncated: true, kept: trace.count, ...(trace.cap ?? { cap: trace.count, spentBy: [] }) };
    return out;
  }

  private async step(session: Session, req: Request): Promise<Record<string, unknown>> {
    const to = int(req.to);
    const kind = typeof req.kind === 'string' ? (req.kind as MoveKind) : undefined;
    if (to === undefined && (!kind || !MOVE_KINDS.includes(kind))) throw new BridgeError('step needs kind or to', `kind is one of ${MOVE_KINDS.join(', ')}, or to: N`);
    await awaitIdle(session); // a re-run (Auto Log switched on by the first step) may be scheduled or in flight
    const paused = session.debug.paused;
    if (paused && to !== undefined && to > paused.step) throw new BridgeError(`the run has not reached step ${to} yet`, 'continue or step to get there');
    if (kind && this.debugBridge.executes(session, kind)) return this.debugBridge.step(session, kind, req);
    if (!session.nav.active) {
      const ok = await this.timeMachine.start(session, {});
      if (!ok) throw new BridgeError('the Time Machine could not start: no execution trace', 'run the file first (save, or Re-execute); On Demand mode never runs by itself');
    }
    const trace = session.trace;
    if (!trace || !session.nav.active) throw new BridgeError('no execution trace', 'run the file first');
    if (to !== undefined) {
      if (!trace.valid(to)) throw new BridgeError(`step ${to} is out of range`, `steps are 0..${trace.count - 1}`);
      this.timeMachine.goto(session, to);
    } else if (kind && !this.timeMachine.move(session, kind)) {
      throw new BridgeError(`cannot step ${kind} from step ${session.nav.currentStep}`, 'a dead end: see moves in context for the directions that exist');
    }
    const step = session.nav.currentStep;
    const loc = trace.location(step);
    if (loc) await this.timeMachine.revealLocation(session, loc.fileId, loc.range[0], loc.range[1], loc.range);
    return this.slice(session, step, sliceOptions(req));
  }

  private async context(session: Session, req: Request): Promise<Record<string, unknown>> {
    await awaitIdle(session);
    const inputs = this.inputs(session);
    const opts = sliceOptions(req);
    const step = int(req.step);
    const line = int(req.line);
    if (step !== undefined) {
      if (!inputs.trace.valid(step)) throw new BridgeError(`step ${step} is out of range`, `steps are 0..${inputs.trace.count - 1}`);
      return { ...this.slice(session, step, opts), ...(await this.debugBridge.contextExtras(session, step, opts)) };
    }
    if (line !== undefined) {
      const fileId = fileIdFor(session, req.file);
      const endLine = int(req.endLine);
      const slice = contextSliceForLine(inputs, fileId, line, endLine, opts);
      if (!slice) throw new BridgeError(`no step ran on ${session.displayPath(fileId)}:${line}${endLine ? `-${endLine}` : ''}`, 'pick a line that executed (coverage.notRun lists the others) or send step');
      return redactSlice(slice);
    }
    const at = session.nav.active ? session.nav.currentStep : session.debug.paused?.step;
    if (at !== undefined) return { ...this.slice(session, at, opts), ...(await this.debugBridge.contextExtras(session, at, opts)) };
    return this.debugBridge.pauseContext(session, req); // a plain debug pause of the file, or the error
  }

  private async select(session: Session, req: Request): Promise<void> {
    const line = int(req.line);
    if (line === undefined) throw new BridgeError('select needs line', 'send {file, line, endLine?}');
    const endLine = Math.max(line, int(req.endLine) ?? line);
    const fileId = fileIdFor(session, req.file);
    const uri = session.uriForFileId(fileId);
    if (!uri) throw new BridgeError('file not found in the run', 'file is the path of a file the run instrumented');
    const doc = await vscode.workspace.openTextDocument(uri);
    const existing = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: true, preview: true });
    const last = Math.min(doc.lineCount, endLine);
    const range = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, last - 1), doc.lineAt(Math.max(0, last - 1)).text.length);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /* ---------- helpers ---------- */

  private inputs(session: Session): SliceInputs {
    const trace = session.trace;
    if (!trace) throw new BridgeError('no execution trace yet', session.running ? 'a run is in flight; retry in a moment' : 'run the file first (save, or Re-execute)');
    const st = session.state;
    return {
      trace,
      files: st.files,
      entriesByRid: st.entriesByRid,
      coverage: st.coverage,
      errors: st.errors,
      readSource: (fileId) => readSource(session, fileId),
      stale: isStale(session),
    };
  }

  private slice(session: Session, step: number, opts: SliceOptions): Record<string, unknown> {
    const slice = contextSliceForStep(this.inputs(session), step, opts);
    if (!slice) throw new BridgeError(`step ${step} is out of range`, 'see state.nav.count');
    // step 0 of a recording that began at a pause (`--record-from`): nothing before it was kept
    if (step === 0 && session.state.midRun) return { ...redactSlice(slice), recordingStart: true };
    return redactSlice(slice);
  }

  private stepPayload(session: Session, step: number): { location: unknown; values: unknown } {
    if (!session.trace) return preRecordingPayload(session); // a `--record-from` pause before the recording
    const inputs = this.inputs(session);
    return { location: locationAt(inputs, step), values: redactValues(valuesAtStep(inputs, step)) };
  }

  private stepEvent(session: Session): Record<string, unknown> {
    if (!session.nav.active || !session.trace) return { event: 'stopped' };
    const step = session.nav.currentStep;
    return { event: 'step', step, ...this.stepPayload(session, step) };
  }
}
