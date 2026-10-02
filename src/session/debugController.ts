/**
 * The debugger on one session: debug mode, the pause at the frontier, the requests that resume it,
 * breakpoints and break-when watches, and the guard against runs that would kill a debug run.
 * Owned by Session as `debugCtl` and reached through its `debug*` methods; the pure decisions live
 * in debugState.ts. Wire contract: docs/PROTOCOL.md (`debug`, `debug.paused`, `debug.resumed`).
 *
 * A debug run is an ordinary run whose frontier can pause. `startDebug` turns the mode on and runs;
 * every run request then carries `config.debug`, `recordLocals` (the "why" tree needs values at
 * every level) and the merged breakpoints: VS Code's gutter, the session's own list, and a
 * transient one for "run to line". While the run is in flight every implicit run (edit, hover,
 * watch, auto log, ...) is refused, because a new run would terminate the paused child.
 */
import type { RecordFromSpec, RunConfig, RunEvent } from '../shared/protocol';
import { setting } from '../config/settings';
import { updateDebugContext } from '../debug/debugContext';
import type { ExecResult } from '../debug/debugExec';
import { EXEC_CAPABILITY, EXEC_CAPABILITY_ERROR, RECORD_FROM_CAPABILITY, RECORD_FROM_CAPABILITY_ERROR } from '../runtime/runnerClient';
import { log } from '../util/log';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import type { Session } from './session';
import { blocksRun, freshDebugState, mergeBreakpoints, reduceDebugState, type BreakpointSpec, type BreakWatchSpec, type DebugBreakpointEcho, type DebugState, type ExceptionMode, type LocalVar, type PausedInfo, type StepKind } from './debugState';

interface Waiter {
  resolve: (r: PausedInfo | 'finished') => void;
  timer: NodeJS.Timeout | undefined;
}

export interface DebugStartOptions {
  /** pause before the first statement (the default); false runs to the first breakpoint, or the end */
  stopOnEntry?: boolean;
  /** record only from this pause on (`--record-from`); the code before it runs at the debugger's speed */
  recordFrom?: RecordFromSpec;
}

export class DebugController {
  private state: DebugState = freshDebugState();
  private waiters: Waiter[] = [];
  private stopOnEntry = true;
  /** where the debug run starts recording, kept for a restart; undefined records from the start */
  recordFrom: RecordFromSpec | undefined;
  /** the "run to line" breakpoint: sent with the list for one pause, dropped at the next */
  private transient: BreakpointSpec | undefined;
  private blockedLogged = false;

  constructor(private readonly session: Session) {}

  snapshot(): DebugState {
    return { ...this.state, breakpoints: [...this.state.breakpoints], watches: [...this.state.watches] };
  }

  /* ---------- runs ---------- */

  /** What a run request carries while debug mode is on; undefined otherwise. */
  requestExtras(): { config: Partial<RunConfig>; breakpoints: BreakpointSpec[] } | undefined {
    if (!this.state.active) return undefined;
    const config: Partial<RunConfig> = { debug: true, stopOnEntry: this.stopOnEntry, recordLocals: true, breakOnException: this.state.exceptions };
    // an older runtime would ignore `recordFrom` and record the whole run: the start refuses instead (`start`)
    if (this.recordFrom) config.recordFrom = this.recordFrom;
    if (setting<boolean>('timeMachine.autoLog', true, this.session.document.uri)) config.autoLog = true;
    return { config, breakpoints: this.merged() };
  }

  /** True when a run for `reason` must not start because it would kill the debug run in flight. Logged once per debug run. */
  blocksRun(reason: string): boolean {
    const blocked = blocksRun(this.state, this.session.running, reason);
    if (blocked && !this.blockedLogged) {
      this.blockedLogged = true;
      log.info(`[${this.session.displayName}] ${reason}: no run while the debug run is ${this.state.paused ? 'paused' : 'running'} (it would end the debug run); continue or stop debugging first`);
    }
    return blocked;
  }

  private merged(): BreakpointSpec[] {
    return mergeBreakpoints(currentSourceBreakpoints(), currentFunctionBreakpoints(), this.state.breakpoints, this.transient ? [this.transient] : undefined);
  }

  /* ---------- mode ---------- */

  async start(opts?: DebugStartOptions): Promise<void> {
    if (opts?.recordFrom && this.session.runner.ready && !this.session.runner.ready.capabilities.includes(RECORD_FROM_CAPABILITY)) throw new Error(RECORD_FROM_CAPABILITY_ERROR);
    this.activate(opts);
    void this.session.runNow('debug').catch((err) => log.error(`debug run failed (${this.session.displayName})`, err));
  }

  /**
   * Debug mode on without a run: the session's next run (its first, for a fresh session) is the
   * debug run, paused before its first statement unless `stopOnEntry` is false (then it runs to
   * the first breakpoint, or the end, as VS Code's F5 does).
   */
  activate(opts?: DebugStartOptions): void {
    this.stopOnEntry = opts?.stopOnEntry ?? true;
    this.recordFrom = opts?.recordFrom;
    this.state = { ...this.state, active: true, paused: undefined, frontier: undefined, runId: undefined };
    this.blockedLogged = false;
    this.emitChanged();
  }

  /** Debug mode off; a paused run is let go. */
  stop(): void {
    const wasPaused = !!this.state.paused;
    const runId = this.runId();
    this.state = reduceDebugState(this.state, { type: 'stop' });
    this.emitChanged();
    if (wasPaused && runId) void this.session.runner.debug(runId, { action: 'continue' }).catch(() => undefined);
  }

  /* ---------- the frontier ---------- */

  async resume(): Promise<void> {
    this.requirePaused('continue');
    await this.send({ action: 'continue' });
  }

  async step(kind: StepKind): Promise<void> {
    this.requirePaused(`step ${kind}`);
    await this.send({ action: 'step', kind });
  }

  async pause(): Promise<void> {
    if (!this.state.active || !this.session.running) throw new Error('no debug run is running');
    if (this.state.paused) return;
    await this.send({ action: 'pause' });
  }

  async locals(opts: { frameId?: number } = {}): Promise<LocalVar[]> {
    this.requirePaused('list the locals');
    const reply = await this.send({ action: 'locals', ...(opts.frameId ? { frameId: opts.frameId } : {}) });
    return (reply['locals'] as LocalVar[] | undefined) ?? [];
  }

  /**
   * Run a statement in the paused frame (docs/design/debugger-product.md, 2.7). The control
   * channel serves `exec` at any pause, recording or not, so a `record: true` session answers it
   * too. Any attempt sets `modified`: a statement that raised halfway may already have written.
   */
  async exec(source: string, opts: { frameId?: number } = {}): Promise<ExecResult> {
    this.requirePaused('run a statement');
    const runId = this.runId();
    if (!runId) throw new Error('no debug run in progress');
    const runner = this.session.runner;
    if (!runner.ready?.capabilities.includes(EXEC_CAPABILITY)) throw new Error(EXEC_CAPABILITY_ERROR);
    this.state = { ...this.state, modified: true };
    this.emitChanged();
    return runner.exec(runId, source, opts);
  }

  /**
   * Record from the current pause on (`record --live`): the runtime swaps its recording hooks in,
   * and the pause is announced again as step 0 with `recordingStarted`. Only a run started with
   * `recordFrom` can: one that records from the start answers `already`.
   */
  async record(): Promise<{ already: boolean }> {
    this.requirePaused('start recording');
    if (!this.recordFrom) return { already: true };
    const reply = await this.send({ action: 'record' });
    return { already: reply['already'] === true };
  }

  /** Replace the session's own breakpoints; a run in flight learns at once and echoes the resolved list. */
  async setBreakpoints(specs: BreakpointSpec[]): Promise<DebugBreakpointEcho[]> {
    this.state = { ...this.state, breakpoints: specs.map((b) => ({ ...b })) };
    this.emitChanged();
    let echo: DebugBreakpointEcho[] | undefined;
    try {
      echo = await this.pushBreakpoints();
    } catch (err) {
      // the run ended (or its runner went with the session) while the push was on its way: the list
      // is kept for the next run, which is all a run that no longer exists can be told
      if (!this.session.runner.isDisposed && this.inFlight()) throw err;
    }
    return echo ?? specs.map((b) => ({ ...b }));
  }

  /** VS Code's breakpoints changed (debugBreakpoints.ts): a run in flight learns at once. */
  syncVsCodeBreakpoints(): Promise<DebugBreakpointEcho[]> | undefined {
    return this.pushBreakpoints();
  }

  private pushBreakpoints(): Promise<DebugBreakpointEcho[]> | undefined {
    if (!this.inFlight()) return undefined;
    return this.send({ action: 'breakpoints', set: this.merged() }).then((reply) => (reply['breakpoints'] as DebugBreakpointEcho[] | undefined) ?? []);
  }

  /** Where an exception pauses: kept for the next run, and applied at once to the one in flight. */
  async setExceptions(mode: ExceptionMode): Promise<void> {
    this.state = { ...this.state, exceptions: mode };
    this.emitChanged();
    if (this.inFlight()) await this.send({ action: 'exceptions', mode });
  }

  async setWatches(specs: BreakWatchSpec[]): Promise<void> {
    this.state = { ...this.state, watches: specs.map((w) => ({ ...w })) };
    this.emitChanged();
    if (this.inFlight()) await this.send({ action: 'watches', set: this.state.watches });
  }

  /** Run to a line from the frontier: a breakpoint for this pause only, dropped at the next. */
  async runToLine(path: string, line: number): Promise<void> {
    this.requirePaused('run to line');
    this.transient = { path, line };
    await this.send({ action: 'breakpoints', set: this.merged() });
    await this.send({ action: 'continue' });
  }

  /** The next `debug.paused` (its info) or `run.finished` ('finished'); rejects after `timeoutMs`. */
  waitForPause(timeoutMs = 60_000): Promise<PausedInfo | 'finished'> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, timer: undefined };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`no pause within ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  /* ---------- events ---------- */

  /** Runner events that move the state (the session forwards them from handleEvent). */
  handleEvent(ev: RunEvent): void {
    switch (ev.type) {
      case 'run.started':
        if (!this.state.active) return;
        this.state = reduceDebugState(this.state, { type: 'run.started', runId: ev.runId });
        this.emitChanged();
        return;
      case 'debug.paused': {
        this.state = reduceDebugState(this.state, ev);
        if (this.transient) {
          this.transient = undefined;
          void this.pushBreakpoints()?.catch(() => undefined);
        }
        const info = this.state.paused;
        this.emitChanged();
        if (info) {
          this.session.emit('debugPaused', info);
          this.settle(info);
        }
        return;
      }
      case 'debug.resumed':
        this.state = reduceDebugState(this.state, { type: 'debug.resumed' });
        this.emitChanged();
        this.session.emit('debugResumed');
        return;
      case 'run.finished':
        if (ev.runId !== this.state.runId) return;
        this.state = reduceDebugState(this.state, { type: 'run.finished' });
        this.emitChanged();
        this.settle('finished');
        return;
      default:
        return;
    }
  }

  /* ---------- helpers ---------- */

  private settle(result: PausedInfo | 'finished'): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve(result);
    }
  }

  private emitChanged(): void {
    this.session.emit('debugChanged');
    // the keys are the union of both products, written only through debugContext.ts
    updateDebugContext({ runAll: { active: this.state.active, paused: !!this.state.paused } });
  }

  private runId(): string | undefined {
    return this.state.runId ?? (this.session.running ? this.session.state.runId : undefined);
  }

  private inFlight(): boolean {
    return this.state.active && this.session.running && this.runId() !== undefined;
  }

  private requirePaused(what: string): void {
    if (!this.state.paused) throw new Error(`cannot ${what}: the debug run is not paused${this.state.active ? '' : ' (debug mode is off: use "Pyokka: Debug Current File")'}`);
  }

  private send(body: { action: 'continue' | 'step' | 'pause' | 'breakpoints' | 'watches' | 'locals' | 'exceptions' | 'record'; kind?: StepKind; set?: BreakpointSpec[] | BreakWatchSpec[]; mode?: ExceptionMode; frameId?: number }): Promise<Record<string, unknown>> {
    const runId = this.runId();
    if (!runId) return Promise.reject(new Error('no debug run in progress'));
    return this.session.runner.debug(runId, body);
  }
}
