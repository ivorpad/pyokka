/**
 * The debugger over the agent bridge (docs/PROTOCOL.md, "Debugging over the bridge"): `debug`,
 * `continue`, `pause`, `stop`, `restart`, the frontier-aware `step`, `break`, `watches`, `locals`,
 * the `debug` field of `state`, the exception mode, the `paused` + `locals` + `output` extras of `context`, and the stop
 * events of the `watch` stream. Every stop reply is the frontier's context slice plus `paused`, the
 * frame's `locals` and the program's `output` so far, or
 * `{finished}` when the run ended instead. `debug` and `restart` run to the first breakpoint of the
 * session's files (`entryPause`); with none, or with `stopOnEntry`, they pause before the first
 * statement. Breakpoints an agent adds go into VS Code's own list, so the gutter shows
 * them and the host's breakpoint feature pushes them to the run in flight like any other. The
 * session API is src/session/debugController.ts; execute-or-replay is src/session/debugState.ts.
 */
import * as vscode from 'vscode';
import type { Session } from '../session/session';
import type { TimeMachine } from '../timeMachine/navigator';
import type { SliceOptions } from '../session/contextSlice';
import { decideMove, entryPause, mergeBreakpoints, type BreakpointSpec, type DebugBreakpointEcho, type LocalVar, type NavigatorMoveKind, type PausedInfo } from '../session/debugState';
import { parseLaunch, type LaunchConfig } from '../debug/debugSessionState';
import { clampCount, continueTo, continueUntil, execReply, stepCount, stepCountExtras, type StopRunner } from '../debug/debugExec';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import { redact } from '../util/redact';
import { BridgeError, int, sliceOptions, type Request } from './bridgeSupport';
import { applyWatchRequest, breakpointReply, displayWatchItems, exceptionMode, localsReply, nodeText, outputTail, parseBreakItems, parseTo, pathContext, pausedReply, type BreakItem } from './bridgeDebugShapes';
import { applyAt, removeFunctionBreakpoints } from './bridgeDebugReply';
import { preRecordingSlice, recordHere } from './bridgeRecordFrom';

/** the rule every debug start shares (debugState.ts); re-exported for the bridge's tests and readers */
export { entryPause };

/** A stop reply waits for the program: as long as it runs, within reason. */
export const STOP_TIMEOUT_MS = 600_000;
/** VS Code confirms a breakpoint change asynchronously; the reply waits for the list to show it. */
const BREAKPOINT_SETTLE_MS = 1_500;

/** The reply shapes, split out so this file stays about the handlers (bridgeDebugShapes.ts). */
export { OUTPUT_TAIL, applyWatchRequest, breakpointReply, displayFile, displayWatchItems, exceptionMode, localsReply, nextWatchId, nodeText, outputTail, parseBreakItems, pathContext, pausedReply, resolveFile } from './bridgeDebugShapes';
export type { BreakItem, PathContext } from './bridgeDebugShapes';

export function finishedReply(session: Session): Record<string, unknown> {
  const fin = session.state.finished;
  return { finished: { exitCode: fin?.exitCode ?? null, stepCount: fin?.stepCount ?? session.trace?.count ?? 0, durationMs: fin?.durationMs ?? 0 } };
}

/** `state.debug`: the debugger while a debug run exists, else null. */
export function stateDebug(session: Session): Record<string, unknown> | null {
  const d = session.debug;
  if (!d.active && !d.paused) return null;
  // a `--record-from` run: where it records from, and whether it has started (its trace exists)
  const recording = session.debugCtl.recordFrom ? { recordFrom: session.debugCtl.recordFrom, recording: !!session.trace } : {};
  return { active: d.active, paused: d.paused ? pausedReply(pathContext(session), d.paused) : null, frontier: d.frontier ?? null, exceptions: d.exceptions, modified: d.modified, ...recording };
}

/* ---------- the handlers ---------- */

export interface BridgeDebugDeps {
  /** the context slice of a step, redacted (the bridge's own builder) */
  slice: (session: Session, step: number, opts: SliceOptions) => Record<string, unknown>;
  /** start a debug run of the session's file inside a VS Code debug session (dapAdapter.ts `debugDocument`) */
  startDebugging: (session: Session, opts: { stopOnEntry: boolean; recordFrom?: string }) => Promise<void>;
  /** stop the debug run and start a fresh one of the same file inside the same debug session; `onStopped` runs once the old run is gone (dapAdapter.ts `restartDebugging`) */
  restartDebugging: (session: Session, opts: { stopOnEntry: boolean; onStopped: () => void }) => Promise<void>;
  /** leave debug mode and stop the run, then wait for it to be gone (dapAdapter.ts `stopDebugging`) */
  stopDebugging: (session: Session) => Promise<void>;
  /**
   * Route (b) of 3.10: start a `record: false` debug session for `launch` and answer its first
   * stop. The run socket is the window already answering, so no URI is needed (bridgeDebugSocket.ts).
   */
  startDebugSession: (launch: LaunchConfig, req: Request) => Promise<Record<string, unknown>>;
  /**
   * The `record: false` debug session of this session's file, when one exists. A `debug` that
   * arrived on this socket started it, and the pause verbs that follow on the same connection
   * address it: that is what makes `pyokka shell --live` able to start and drive a debug session
   * over one socket (bridgeDebugSocket.ts).
   */
  debugSessionFor: (session: Session) => { serve: (type: string, req: Request) => Promise<Record<string, unknown>> } | undefined;
}

export class BridgeDebug {
  constructor(
    private readonly timeMachine: TimeMachine,
    private readonly deps: BridgeDebugDeps,
  ) {}

  /** A forward `step` at the frontier of a paused run is the program's own step. */
  executes(session: Session, kind: NavigatorMoveKind): boolean {
    // the debug session this socket started owns the pause: its forward moves execute
    if (!session.debug.active && this.deps.debugSessionFor(session)) return true;
    return decideMove(session.debug, session.nav, kind) === 'execute';
  }

  /**
   * Serve `type` against the debug session this socket started, when its own session has no pause
   * of its own. A run-all session in debug mode (`record: true`) keeps every verb for itself.
   */
  private served(session: Session, type: string, req: Request): Promise<Record<string, unknown>> | undefined {
    if (session.debug.active) return undefined;
    return this.deps.debugSessionFor(session)?.serve(type, req);
  }

  /**
   * `debug` on a run socket (4.8, third row). A recording run that is already paused answers its
   * pause. Otherwise the request starts a session: `launch` absent or `launch.record` false gives a
   * `record: false` debug session of its own, `launch.record: true` today's recording run on this
   * run-all session. Either way the reply is the first stop.
   */
  async debug(session: Session, req: Request): Promise<Record<string, unknown>> {
    const paused = session.debug.paused;
    if (paused) return this.stopReply(session, paused, req);
    // a run already in flight (a `--record` start through the URI): its first stop is the answer
    if (session.debug.active && !req.launch) return this.stop(session, req, async () => undefined);
    const launch = this.launchFor(session, req);
    if (!launch.record) return this.deps.startDebugSession(launch, req);
    // the run opens in a VS Code debug session too, so the standard views show what the agent does
    return this.stop(session, req, () => this.deps.startDebugging(session, { stopOnEntry: this.entryPause(session, req), ...(launch.recordFrom ? { recordFrom: launch.recordFrom } : {}) }));
  }

  /** The launch a `debug` request asks for; `program` defaults to the session's file. */
  private launchFor(session: Session, req: Request): LaunchConfig {
    const raw = req.launch && typeof req.launch === 'object' && !Array.isArray(req.launch) ? { ...(req.launch as Record<string, unknown>) } : {};
    if (!raw['program'] && !raw['module']) raw['program'] = session.filePath;
    if (raw['stopOnEntry'] === undefined && req.stopOnEntry !== undefined) raw['stopOnEntry'] = req.stopOnEntry === true;
    try {
      return parseLaunch(raw, { workspaceRoot: session.workspaceRoot });
    } catch (err) {
      throw new BridgeError(err instanceof Error ? err.message : String(err), 'send {type: "debug", launch: {program, args, cwd, env, python, record}}; every field is optional');
    }
  }

  /** `stop`: end the debug run and leave debug mode. The session and its recording stay, and so does the Time Machine. */
  async stopRun(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'stop', req);
    if (served) return served;
    if (!session.debug.active) return { stopped: false, hint: 'no debug run is in flight; `debug --live` starts one' };
    const runId = session.debug.runId ?? session.state.runId;
    await this.act(() => this.deps.stopDebugging(session));
    return { stopped: true, runId, ...finishedReply(session) };
  }

  /** `restart`: the debug run again from the top, in the same VS Code debug session; with no run in flight it is `debug`. */
  async restart(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'restart', req);
    if (served) return served;
    const stopOnEntry = this.entryPause(session, req);
    // nothing in flight: `restart` does what `debug` does, which is a `record: false` session
    if (!session.debug.active) return this.debug(session, req);
    // the wait for the first stop starts once the old run is gone: its finish would settle an earlier one
    let next: Promise<PausedInfo | 'finished'> | undefined;
    try {
      await this.act(() => this.deps.restartDebugging(session, { stopOnEntry, onStopped: () => void (next = this.waitForStop(session)) }));
    } catch (err) {
      next?.catch(() => undefined); // the restart failed on the way: nobody reads the waiter
      throw err;
    }
    if (!next) throw new BridgeError('the debug run did not restart', 'see the Pyokka output channel');
    return this.reply(session, await next, req);
  }

  /**
   * `continue`; `noWait` answers `{resumed: true}` at once instead of waiting for the next stop,
   * `until` runs to the first moment an expression is true (a one-shot break-when watch), `to`
   * runs to a line through the transient run-to-line breakpoint.
   */
  async resume(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'continue', req);
    if (served) return served;
    this.requirePaused(session, 'continue');
    if (req.noWait === true) {
      await this.act(() => session.debugContinue());
      return { resumed: true };
    }
    const until = typeof req.until === 'string' ? req.until.trim() : '';
    if (until) return this.reply(session, await continueUntil(this.runner(session), until), req);
    if (req.to !== undefined) {
      const to = parseTo(pathContext(session), req.to);
      if (!to) throw new BridgeError('continue --to wants FILE:LINE', 'send {to: {file: "app.py", line: 82}}');
      return this.reply(session, await continueTo(this.runner(session), to.file, to.line), req);
    }
    return this.stop(session, req, () => session.debugContinue());
  }

  /** `exec`: run a statement in the paused frame. The control channel serves it at any pause. */
  async exec(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'exec', req);
    if (served) return served;
    const source = typeof req.source === 'string' ? req.source : typeof req.expression === 'string' ? req.expression : '';
    if (!source.trim()) throw new BridgeError('exec needs source', 'send {source: "x = 3"}; a statement, an assignment, an import or a call all run');
    this.requirePaused(session, 'run a statement');
    try {
      return execReply(await session.debugExec(source, { frameId: int(req.frameId) }), redact);
    } catch (err) {
      throw new BridgeError(err instanceof Error ? err.message : String(err), 'a statement runs only at a pause: `pause --live` stops the program first');
    }
  }

  /** The moves `--until`, `--to` and `--count` are built from, over a recording run-all session. */
  private runner(session: Session): StopRunner {
    return {
      watches: () => session.debug.watches,
      setWatches: (specs) => session.setDebugWatches(specs),
      resume: () => session.debugContinue(),
      step: (kind) => session.debugStep(kind),
      runTo: (file, line) => session.debugCtl.runToLine(file, line),
      stop: async (action) => {
        const next = this.waitForStop(session);
        try {
          await this.act(action);
        } catch (err) {
          next.catch(() => undefined);
          throw err;
        }
        return next;
      },
    };
  }

  /**
   * `pause`; `noWait` answers `{requested: true, paused: false}` at once. A server can sit in
   * `accept()` for minutes, and a ten-minute hang is worse than a second call.
   */
  async pause(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'pause', req);
    if (served) return served;
    const paused = session.debug.paused;
    if (paused) return this.stopReply(session, paused, req);
    if (!session.debug.active || !session.running) throw new BridgeError('no debug run is running', 'start one with `debug --live`');
    if (req.noWait === true) {
      await this.act(() => session.debugPause());
      return { requested: true, paused: false };
    }
    return this.stop(session, req, () => session.debugPause());
  }

  async step(session: Session, kind: NavigatorMoveKind, req: Request): Promise<Record<string, unknown>> {
    if (kind !== 'into' && kind !== 'over' && kind !== 'out') throw new BridgeError(`cannot execute ${kind}`, 'only into, over and out execute at the frontier');
    const served = this.served(session, 'step', { ...req, kind });
    if (served) return served;
    // `--count N`: N stops in a row, the last one is the reply (clamped to 1..1000)
    if (req.count !== undefined && clampCount(req.count) > 1) {
      const out = await stepCount(this.runner(session), kind, clampCount(req.count));
      return { ...(await this.reply(session, out.result, req)), ...stepCountExtras(out) };
    }
    return this.stop(session, req, () => session.debugStep(kind));
  }

  /** `record`: record from the current pause on; the reply is the same pause as step 0 (bridgeRecordFrom.ts). */
  async record(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'record', req);
    if (served) return served;
    const { result, already } = await recordHere(session, (action) => this.runner(session).stop(action));
    const paused = session.debug.paused;
    if (already) return { already: true, ...(paused ? await this.stopReply(session, paused, req) : {}) };
    return { already: false, ...(await this.reply(session, result ?? 'finished', req)) };
  }

  async locals(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'locals', req);
    if (served) return served;
    this.requirePaused(session, 'list the locals');
    return { locals: localsReply(await session.debugLocals(), !!req.valueBag) };
  }

  /**
   * `context` on the run socket when this session has no step to read (no Time Machine, no pause
   * of its own) and a `record: false` debug session of the same file is paused: that pause, as
   * its own socket answers it (`recording: false`). The bridge asks only once it has no step of
   * its own, so with no such pause the answer is that error.
   */
  async pauseContext(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = session.nav.active || session.debug.paused ? undefined : this.served(session, 'context', req);
    if (served) return served;
    throw new BridgeError('context needs step or file/line while the Time Machine is not active', 'send {step: N}, {file, line}, or step first; a plain `pyokka debug FILE` pause of this file answers here too');
  }

  /** `paused`, `locals` and `output` for a `context` reply that is the frontier's, else nothing. */
  async contextExtras(session: Session, step: number, opts: SliceOptions): Promise<Record<string, unknown>> {
    const paused = session.debug.paused;
    if (!paused || paused.step !== step) return {};
    return this.pauseExtras(session, paused, opts);
  }

  /** What a stop carries besides the slice: the pause, the live frame's variables and the output so far. */
  private async pauseExtras(session: Session, info: PausedInfo, opts: SliceOptions): Promise<Record<string, unknown>> {
    let locals: LocalVar[] = [];
    try {
      locals = await session.debugLocals();
    } catch {
      locals = []; // the run resumed or ended between the pause and this request
    }
    return { paused: pausedReply(pathContext(session), info), locals: localsReply(locals, !!opts.valueBag), output: outputTail(session.state.output) };
  }

  async breakpoints(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'break', req);
    if (served) return served;
    const ctx = pathContext(session);
    const mode = exceptionMode(req.exceptions);
    if (mode) await session.setDebugExceptions(mode);
    await applyAt(ctx, req, session.debug.breakpoints, (specs) => session.setDebugBreakpoints(specs));
    await removeFunctionBreakpoints(req, session.debug.breakpoints, (specs) => session.setDebugBreakpoints(specs));
    const source = (): vscode.SourceBreakpoint[] => vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint);
    const matches = (b: vscode.SourceBreakpoint, it: BreakItem, withCondition: boolean): boolean => b.location.uri.scheme === 'file' && b.location.uri.fsPath === it.path && b.location.range.start.line === it.line - 1 && (!withCondition || (b.condition ?? '') === (it.condition ?? ''));
    const toAdd: BreakItem[] = [];
    const toRemove: vscode.SourceBreakpoint[] = [];
    if (Array.isArray(req.set)) {
      toRemove.push(...source());
      await session.setDebugBreakpoints([]);
      toAdd.push(...parseBreakItems(ctx, req.set));
    }
    if (Array.isArray(req.add)) for (const it of parseBreakItems(ctx, req.add)) if (!source().some((b) => matches(b, it, true)) && !toAdd.some((a) => a.path === it.path && a.line === it.line && (a.condition ?? '') === (it.condition ?? ''))) toAdd.push(it);
    if (Array.isArray(req.remove)) {
      const items = parseBreakItems(ctx, req.remove);
      for (const b of source()) if (items.some((it) => matches(b, it, false)) && !toRemove.includes(b)) toRemove.push(b);
      const own = session.debug.breakpoints.filter((bp) => !items.some((it) => it.path === bp.path && it.line === bp.line));
      if (own.length !== session.debug.breakpoints.length) await session.setDebugBreakpoints(own);
    }
    if (toRemove.length) vscode.debug.removeBreakpoints(toRemove);
    if (toAdd.length) vscode.debug.addBreakpoints(toAdd.map((it) => new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(it.path), new vscode.Position(it.line - 1, 0)), true, it.condition)));
    if (toRemove.length || toAdd.length) await this.settleBreakpoints(() => toAdd.every((it) => source().some((b) => matches(b, it, true))) && toRemove.every((b) => !source().includes(b)));
    let echo: DebugBreakpointEcho[] | undefined;
    if (session.debug.active && session.running) echo = await session.debugCtl.syncVsCodeBreakpoints()?.catch(() => undefined);
    return { breakpoints: breakpointReply(ctx, mergeBreakpoints(currentSourceBreakpoints(), currentFunctionBreakpoints(), session.debug.breakpoints), echo), exceptions: session.debug.exceptions };
  }

  async watches(session: Session, req: Request): Promise<Record<string, unknown>> {
    const served = this.served(session, 'watches', req);
    if (served) return served;
    const next = applyWatchRequest(session.debug.watches, req);
    if (Array.isArray(req.set) || Array.isArray(req.add) || Array.isArray(req.remove)) await session.setDebugWatches(next);
    // displayed watch expressions: the panel's, evaluated at the current step (in the paused frame at the frontier)
    if (Array.isArray(req.set)) for (const w of [...session.watches]) this.timeMachine.removeWatch(session, w.id);
    for (const exp of [...displayWatchItems(req.set), ...displayWatchItems(req.add)]) this.timeMachine.addWatch(session, exp);
    if (Array.isArray(req.remove)) for (const id of req.remove.map(String)) if (session.watches.some((w) => w.id === id)) this.timeMachine.removeWatch(session, id);
    let echo: { id?: string; error?: string }[] | undefined;
    if (session.debug.active && session.running && next.length) {
      try {
        const reply = await session.runner.debug(session.state.runId, { action: 'watches', set: next });
        echo = Array.isArray(reply['watches']) ? (reply['watches'] as { id?: string; error?: string }[]) : undefined;
      } catch {
        echo = undefined; // the run ended between the two requests
      }
    }
    const displayed = await this.displayedWatches(session);
    return {
      watches: [
        ...next.map((w) => {
          const e = echo?.find((x) => x.id === w.id);
          return { id: w.id, exp: w.exp, breakWhen: w.breakWhen, ...(e?.error ? { error: e.error } : {}) };
        }),
        ...displayed,
      ],
    };
  }

  /** The panel's watch expressions with their value at the current step; waits up to 1.5 s for an evaluation still in flight. */
  private async displayedWatches(session: Session): Promise<Record<string, unknown>[]> {
    const step = session.nav.active ? session.nav.currentStep : undefined;
    if (step !== undefined) {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && session.watches.some((w) => !w.values.has(step))) await new Promise((r) => setTimeout(r, 50));
    }
    return session.watches.map((w) => {
      const v = step !== undefined ? w.values.get(step) : undefined;
      const out: Record<string, unknown> = { id: w.id, exp: w.exp, kind: 'display' };
      if (v?.error) out.error = v.error;
      else if (v) {
        const text = v.text ?? nodeText(v.valueBag?.data);
        if (text !== undefined) out.text = redact(text);
      }
      return out;
    });
  }

  /** The `watch` stream's line for a pause: the step event's location and values plus the pause. */
  pausedEvent(session: Session, info: PausedInfo, payload: { location: unknown; values: unknown }): Record<string, unknown> {
    const paused = pausedReply(pathContext(session), info);
    const { stack: _stack, ...rest } = paused;
    return { event: 'paused', ...rest, ...payload };
  }

  /* ---------- helpers ---------- */

  private requirePaused(session: Session, what: string): void {
    if (session.debug.paused) return;
    if (session.debug.active && session.running) throw new BridgeError(`cannot ${what}: the program is running`, '`pause --live` stops it at its next statement');
    throw new BridgeError(`cannot ${what}: no debug run is paused`, 'start one with `debug --live`');
  }

  /** Run `action`, then wait for the stop it leads to: the next pause (its reply) or the end of the run. */
  private async stop(session: Session, req: Request, action: () => Promise<void>): Promise<Record<string, unknown>> {
    const next = this.waitForStop(session);
    await this.act(action);
    return this.reply(session, await next, req);
  }

  /** Whether the run pauses before its first statement: the request asked, or no breakpoint of the session's files can hit. */
  private entryPause(session: Session, req: Request): boolean {
    return entryPause({ stopOnEntry: req.stopOnEntry }, mergeBreakpoints(currentSourceBreakpoints(), currentFunctionBreakpoints(), session.debug.breakpoints), [session.filePath, ...session.files.all().map((f) => f.path)]);
  }

  /** Whatever the host throws on the way to a stop, as a `BridgeError`. */
  private async act(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError(err instanceof Error ? err.message : String(err), 'see the Pyokka output channel');
    }
  }

  private async reply(session: Session, result: PausedInfo | 'finished', req: Request): Promise<Record<string, unknown>> {
    return result === 'finished' ? finishedReply(session) : this.stopReply(session, result, req);
  }

  private waitForStop(session: Session): Promise<PausedInfo | 'finished'> {
    return new Promise((resolve, reject) => {
      const onDisposed = (): void => reject(new BridgeError('session stopped', 'start a Pyokka session on the file again'));
      session.once('disposed', onDisposed);
      session.waitForPause(STOP_TIMEOUT_MS).then(
        (r) => {
          session.off('disposed', onDisposed);
          resolve(r);
        },
        (err: unknown) => {
          session.off('disposed', onDisposed);
          reject(new BridgeError(err instanceof Error ? err.message : String(err), 'the program did not stop; `pause --live` stops it at its next statement, or stop the session'));
        },
      );
    });
  }

  private async stopReply(session: Session, info: PausedInfo, req: Request): Promise<Record<string, unknown>> {
    // a `recordFrom` run paused before its recording started: no trace to slice yet
    if (!session.trace) return { ...preRecordingSlice(session, info, sliceOptions(req)), ...(await this.pauseExtras(session, info, sliceOptions(req))) };
    const loc = session.trace?.location(info.step);
    if (loc) await this.timeMachine.revealLocation(session, loc.fileId, loc.range[0], loc.range[1], loc.range);
    const opts = sliceOptions(req);
    return { ...this.deps.slice(session, info.step, opts), ...(await this.pauseExtras(session, info, opts)) };
  }

  private settleBreakpoints(settled: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = (): void => {
        if (settled() || Date.now() - started > BREAKPOINT_SETTLE_MS) resolve();
        else setTimeout(tick, 40);
      };
      tick();
    });
  }
}
