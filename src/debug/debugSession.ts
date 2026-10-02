/**
 * The Debugger's session (docs/design/debugger-product.md, 3.3): a launch configuration, a runner
 * of its own, one `record: false` run, and the pause. Nothing is recorded, nothing re-runs, there
 * is no run loop and no Time Machine; when the program exits the session is disposed and there is
 * nothing left to read.
 *
 * Not a run-all `Session`: no document, no debounce, no run modes, no save hook. The two share
 * VS Code's gutter breakpoints, the runtime and the runner, and nothing else. One `RunnerClient`
 * per debug session on purpose: a runner serves one child at a time, so sharing would make a
 * run-all re-run kill the paused debug child.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Completions, ErrorEvent, RunEvent, RunFinishedEvent, OutputEvent, ValueBag, ValueNode } from '../shared/protocol';
import { EXEC_CAPABILITY, EXEC_CAPABILITY_ERROR, RECORD_CAPABILITY, RECORD_CAPABILITY_ERROR, RunnerClient } from '../runtime/runnerClient';
import { resolveInterpreter } from '../runtime/interpreter';
import { resolveSessionConfig } from '../config/settings';
import { FileTable } from '../session/fileTable';
import { appendOutput, OutputLog } from '../session/outputBuffer';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import { freshDebugState, mergeBreakpoints, reduceDebugState, type BreakpointSpec, type BreakWatchSpec, type DebugBreakpointEcho, type DebugState, type ExceptionMode, type LocalVar, type PausedInfo, type PausedThread, type StepKind } from '../session/debugState';
import { debugRunRequest, launchName, type LaunchConfig } from './debugSessionState';
import type { ExecResult } from './debugExec';
import { StopWaiters } from './debugWaiters';
import { log } from '../util/log';

export type DebugSessionStatus = 'starting' | 'running' | 'paused' | 'ended';

export interface DebugSessionEvents {
  started: [runId: string];
  paused: [info: PausedInfo];
  resumed: [];
  output: [OutputEvent];
  /** the state (status, breakpoints, watches, files, the exception mode) changed */
  changed: [];
  finished: [ev: RunFinishedEvent];
  ended: [];
}

export interface DebugSessionOptions {
  id: string;
  launch: LaunchConfig;
  /** where the runner is started from (`dist/python`, or `python/` in the repo) */
  runtimeDir: string;
  /** the workspace folder the launch belongs to; '' when none is open */
  workspaceRoot: string;
}

/** A pause waits for the program: as long as it runs, within reason. */
const PAUSE_TIMEOUT_MS = 600_000;
/** How long a finished session lingers so the reply that was waiting reaches its socket. */
const DISPOSE_DELAY_MS = 50;

export class DebugSession extends EventEmitter<DebugSessionEvents> {
  readonly id: string;
  readonly launch: LaunchConfig;
  readonly workspaceRoot: string;
  readonly startedAt = Date.now();
  readonly files = new FileTable();
  runner: RunnerClient | undefined;
  runId: string | undefined;
  status: DebugSessionStatus = 'starting';
  /** what the program printed, in arrival order (the last 64 KB) */
  output = '';
  /** the same window as tagged chunks, for the Debugger view's pane (docs/design/debugger-product.md, 5.6) */
  readonly outputLog = new OutputLog();
  /**
   * What the agent path has already been handed of that log: the stop it answered and the offsets
   * it carried. A stop reply sends the output printed since the previous stop, so an agent reads
   * what its own move produced instead of the same tail every time; re-reading the same pause
   * (`state`, a second `debug`) answers the same delta rather than eating it.
   */
  agentOutput = { step: -1, from: 0, seq: 0 };
  /** when the current run started: every chunk's `t` is relative to it, and so is the view's clock */
  runStartedAt = Date.now();
  /** an `exec` or a `setVariable` wrote in this run (wave 2); reported at every stop */
  modified = false;
  /** the first instrumented file's path: the main file, undefined until the run reports it */
  mainFile: string | undefined;
  /** the uncaught exception that ended the run, when one did */
  errors: ErrorEvent[] = [];
  /** this run has paused at least once: a `debug` request then reads the pause instead of waiting */
  pausedOnce = false;
  /**
   * Watch expressions shown at every stop (the panel's, and the bridge's `watches --add EXPR`
   * without `--break-when`). They are evaluated at the pause, not sent to the runtime: a
   * break-when watch is the one the runtime holds (`debug.watches`).
   */
  readonly displayWatches: { id: string; exp: string }[] = [];
  lastFinished: RunFinishedEvent | undefined;
  lastError: string | undefined;

  private state: DebugState = { ...freshDebugState(), active: true };
  private readonly waiters = new StopWaiters<PausedInfo | 'finished'>();
  private runCounter = 0;
  private disposed = false;
  private restarting = false;
  private interpreterPath = '';
  private readonly runtimeDir: string;
  /** the "run to line" breakpoint: sent with the list for one pause, dropped at the next */
  private transient: BreakpointSpec | undefined;

  constructor(opts: DebugSessionOptions) {
    super();
    this.id = opts.id;
    this.launch = opts.launch;
    this.workspaceRoot = opts.workspaceRoot;
    this.runtimeDir = opts.runtimeDir;
    this.state = { ...this.state, exceptions: opts.launch.breakOnException };
  }

  /* ---------- identity ---------- */

  get displayName(): string {
    return launchName(this.launch);
  }

  /** The file the descriptor and the CLI name: the main file once it arrived, else the launch's. */
  get filePath(): string {
    return this.mainFile ?? this.launch.program ?? this.launch.cwd;
  }

  get record(): boolean {
    return this.launch.record;
  }

  get running(): boolean {
    return this.status === 'running' || this.status === 'paused';
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** A restart is replacing the child: this run's finish is not the end of the session. */
  get isRestarting(): boolean {
    return this.restarting;
  }

  get debug(): DebugState {
    return { ...this.state, breakpoints: [...this.state.breakpoints], watches: [...this.state.watches], modified: this.modified };
  }

  get thread(): PausedThread | undefined {
    return this.state.paused?.thread;
  }

  get interpreter(): string {
    return this.interpreterPath;
  }

  /**
   * The launch with `python` filled in. `start` resolves the interpreter, so the descriptor, the
   * `state` reply and the view can name what the program actually runs instead of a default that
   * may be wrong (a venv, the Python extension's environment).
   */
  get resolvedLaunch(): LaunchConfig {
    return this.interpreterPath ? { ...this.launch, python: this.interpreterPath } : this.launch;
  }

  /* ---------- lifecycle ---------- */

  /**
   * Resolve the interpreter, spawn the runner, check that it can run without recording, and send
   * the one run this session has. Resolves once the runner accepted the run; the pause follows as
   * an event.
   */
  async start(opts: { stopOnEntry?: boolean } = {}): Promise<void> {
    if (this.disposed) throw new Error('the debug session has ended');
    const resource = vscode.Uri.file(this.launch.program ?? this.launch.cwd);
    this.interpreterPath = this.launch.python ?? (await resolveInterpreter(resource)).path;
    const runner = new RunnerClient({
      command: this.interpreterPath,
      cwd: this.runtimeDir,
      version: '1',
      log: (line) => log.info(`[${this.displayName}] ${line}`),
    });
    this.runner = runner;
    runner.on('event', (ev) => this.handleEvent(ev));
    runner.on('runnerError', (message, detail) => {
      this.lastError = message;
      log.error(`debug runner error (${this.displayName}): ${message}${detail ? `\n${detail}` : ''}`);
    });
    runner.on('exit', (code) => {
      if (this.disposed || this.restarting) return;
      // a runner that goes without `run.finished` still ends the session: there is nothing left to read
      log.warn(`[${this.displayName}] debug runner exited (code ${code ?? 'null'})`);
      this.finish({ type: 'run.finished', runId: this.runId ?? '', seq: 0, exitCode: code, durationMs: Date.now() - this.startedAt, timedOut: false, stopped: true, stepCount: this.state.paused?.step ?? 0, logCount: 0 });
    });
    const ready = await runner.start();
    if (!this.launch.record && !ready.capabilities.includes(RECORD_CAPABILITY)) {
      runner.dispose();
      throw new Error(RECORD_CAPABILITY_ERROR);
    }
    await this.send(opts.stopOnEntry ?? this.launch.stopOnEntry);
  }

  /** `DebugTarget.startDebug`: the run is already in flight after `start()`, so this is a no-op. */
  startDebug(_opts?: { stopOnEntry?: boolean }): Promise<void> {
    return Promise.resolve();
  }

  /** The one run request this session sends. */
  private async send(stopOnEntry: boolean): Promise<void> {
    const runner = this.runner;
    if (!runner) throw new Error('the debug session has no runner');
    const runId = `d-${++this.runCounter}`;
    const base = resolveSessionConfig(vscode.Uri.file(this.launch.program ?? this.launch.cwd), this.workspaceRoot || undefined, this.launch.program ? path.dirname(this.launch.program) : this.launch.cwd);
    this.state = reduceDebugState({ ...this.state, active: true }, { type: 'run.started', runId });
    this.runId = runId;
    this.pausedOnce = false;
    this.modified = false;
    this.output = '';
    this.outputLog.reset();
    this.agentOutput = { step: -1, from: 0, seq: 0 };
    this.runStartedAt = Date.now();
    this.errors = [];
    this.mainFile = undefined;
    this.lastFinished = undefined;
    this.status = 'starting';
    const request = debugRunRequest({ runId, launch: this.launch, workspaceRoot: this.workspaceRoot, base, stopOnEntry, exceptions: this.state.exceptions, breakpoints: this.merged() });
    log.info(`[${this.displayName}] debug run ${runId} (${this.launch.record ? 'recording' : 'no recording'}, stopOnEntry ${stopOnEntry}, ${request.breakpoints?.length ?? 0} breakpoints)`);
    this.emit('changed');
    await runner.run(request);
  }

  /**
   * Replace the child inside the same session and the same VS Code debug session: stop the run,
   * wait for it to be gone, send a fresh `run` on the same runner. The launch, the breakpoints, the
   * watches and the exception mode survive; `modified`, `output`, `files` and `mainFile` reset.
   */
  async restart(opts: { stopOnEntry?: boolean } = {}): Promise<void> {
    if (this.disposed) throw new Error('the debug session has ended');
    const runner = this.runner;
    if (!runner) return this.start(opts);
    this.restarting = true;
    try {
      if (this.runId && this.running) {
        const gone = this.waitForFinish(30_000);
        await runner.stop(this.runId);
        await gone;
      }
      await this.send(opts.stopOnEntry ?? this.launch.stopOnEntry);
    } finally {
      this.restarting = false;
    }
  }

  /** Stop the program. The session ends when the run reports it is gone. */
  stopDebug(): void {
    void this.terminateAsync();
  }

  terminate(): void {
    void this.terminateAsync();
  }

  private async terminateAsync(): Promise<void> {
    const runner = this.runner;
    if (!runner || !this.runId) {
      this.dispose();
      return;
    }
    try {
      await runner.stop(this.runId);
    } catch {
      /* the runner is already gone */
    }
  }

  /** Kill the child, shut the runner down, drop the pause and say so. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.status = 'ended';
    this.settle('finished');
    const runner = this.runner;
    this.runner = undefined;
    runner?.dispose();
    this.emit('ended');
    this.removeAllListeners();
  }

  /* ---------- events ---------- */

  private handleEvent(ev: RunEvent): void {
    if (this.disposed) return;
    if ('runId' in ev && ev.runId && this.runId && ev.runId !== this.runId) return; // a superseded run
    switch (ev.type) {
      case 'run.started':
        this.status = 'running';
        this.emit('started', ev.runId);
        this.emit('changed');
        return;
      case 'file.instrumented':
        this.files.add(ev);
        this.mainFile ??= ev.path;
        this.emit('changed');
        return;
      case 'output':
        this.output = appendOutput(this.output, ev.text);
        this.outputLog.append(ev.stream, ev.text, Date.now() - this.runStartedAt);
        this.emit('output', ev);
        return;
      case 'error':
        this.errors.push(ev);
        this.emit('changed');
        return;
      case 'debug.paused': {
        this.state = reduceDebugState(this.state, ev);
        this.modified = this.state.modified;
        this.status = 'paused';
        this.pausedOnce = true;
        if (this.transient) {
          this.transient = undefined;
          void this.pushBreakpoints()?.catch(() => undefined);
        }
        const info = this.state.paused;
        this.emit('changed');
        if (info) {
          this.emit('paused', info);
          this.settle(info);
        }
        return;
      }
      case 'debug.resumed':
        this.state = reduceDebugState(this.state, { type: 'debug.resumed' });
        this.status = 'running';
        this.emit('changed');
        this.emit('resumed');
        return;
      case 'run.finished':
        this.finish(ev);
        return;
      default:
        return;
    }
  }

  private finish(ev: RunFinishedEvent): void {
    if (this.status === 'ended') return;
    this.lastFinished = ev;
    this.state = reduceDebugState(this.state, { type: 'run.finished' });
    this.status = 'ended';
    this.emit('finished', ev);
    // a restart replaces the child inside this session: its finish is not the end of a wait
    if (this.restarting) return;
    this.settle('finished');
    // the command that was waiting holds the `{finished}` reply; one macrotask lets it reach the
    // socket before the socket closes with the session (design decision 12, mechanically)
    setTimeout(() => this.dispose(), DISPOSE_DELAY_MS);
  }

  /* ---------- the pause ---------- */

  async debugContinue(): Promise<void> {
    this.requirePaused('continue');
    await this.action({ action: 'continue' });
  }

  async debugStep(kind: StepKind): Promise<void> {
    this.requirePaused(`step ${kind}`);
    await this.action({ action: 'step', kind });
  }

  async debugPause(): Promise<void> {
    if (this.state.paused) return;
    if (!this.running) throw new Error('the debug session is not running');
    await this.action({ action: 'pause' });
  }

  async debugLocals(opts: { frameId?: number } = {}): Promise<LocalVar[]> {
    this.requirePaused('list the locals');
    const reply = await this.request({ action: 'locals', ...(opts.frameId ? { frameId: opts.frameId } : {}) });
    if (reply['modified'] === true) this.modified = true;
    return (reply['locals'] as LocalVar[] | undefined) ?? [];
  }

  async evaluate(expression: string, opts: { frameId?: number } = {}): Promise<{ text: string; valueBag?: ValueBag } | undefined> {
    if (!expression.trim()) return undefined;
    const runner = this.runner;
    if (!runner || !this.runId || !this.state.paused) return undefined;
    try {
      const r = await runner.evaluate(this.runId, expression, opts);
      return { text: r.text, valueBag: r.valueBag };
    } catch (err) {
      log.info(`[${this.displayName}] evaluate ${JSON.stringify(expression)}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Run a statement in the paused frame (2.7). Any attempt sets `modified`, so every later stop,
   * the view's banner and the status bar tooltip say the values are no longer the program's own.
   */
  async exec(source: string, opts: { frameId?: number } = {}): Promise<ExecResult> {
    this.requirePaused('run a statement');
    const runner = this.runner;
    if (!runner || !this.runId) throw new Error('the debug session has ended');
    if (!runner.ready?.capabilities.includes(EXEC_CAPABILITY)) throw new Error(EXEC_CAPABILITY_ERROR);
    this.modified = true;
    this.state = { ...this.state, modified: true };
    this.emit('changed');
    const r = await runner.exec(this.runId, source, opts);
    if (r.modified) this.modified = true;
    return r;
  }

  async complete(text: string): Promise<Completions> {
    const none: Completions = { prefix: /[A-Za-z_][A-Za-z0-9_]*$/.exec(text)?.[0] ?? '', items: [] };
    const runner = this.runner;
    if (!runner || !this.runId || !this.state.paused) return none;
    try {
      return await runner.complete(this.runId, text);
    } catch {
      return none;
    }
  }

  async expand(valueId: string, queryPath: string[]): Promise<ValueNode | undefined> {
    const runner = this.runner;
    if (!runner || !this.runId) return undefined;
    return runner.expand(this.runId, valueId, queryPath);
  }

  /* ---------- breakpoints, watches, exceptions ---------- */

  async setDebugBreakpoints(specs: BreakpointSpec[]): Promise<DebugBreakpointEcho[]> {
    this.state = { ...this.state, breakpoints: specs.map((b) => ({ ...b })) };
    this.emit('changed');
    return (await this.pushBreakpoints()) ?? specs.map((b) => ({ ...b }));
  }

  /** VS Code's breakpoints changed (debugBreakpoints.ts): the run in flight learns at once. */
  syncVsCodeBreakpoints(): Promise<DebugBreakpointEcho[]> | undefined {
    return this.pushBreakpoints();
  }

  async setDebugWatches(specs: BreakWatchSpec[]): Promise<void> {
    this.state = { ...this.state, watches: specs.map((w) => ({ ...w })) };
    this.emit('changed');
    if (this.inFlight()) await this.request({ action: 'watches', set: this.state.watches });
  }

  async setDebugExceptions(mode: ExceptionMode): Promise<void> {
    this.state = { ...this.state, exceptions: mode };
    this.emit('changed');
    if (this.inFlight()) await this.request({ action: 'exceptions', mode });
  }

  /** Run to a line from the pause: a breakpoint for this pause only, dropped at the next. */
  async runToLine(file: string, line: number): Promise<void> {
    this.requirePaused('run to line');
    this.transient = { path: file, line };
    await this.request({ action: 'breakpoints', set: this.merged() });
    await this.action({ action: 'continue' });
  }

  private merged(): BreakpointSpec[] {
    return mergeBreakpoints(currentSourceBreakpoints(), currentFunctionBreakpoints(), this.state.breakpoints, this.transient ? [this.transient] : undefined);
  }

  private pushBreakpoints(): Promise<DebugBreakpointEcho[]> | undefined {
    if (!this.inFlight()) return undefined;
    return this.request({ action: 'breakpoints', set: this.merged() }).then((reply) => (reply['breakpoints'] as DebugBreakpointEcho[] | undefined) ?? []);
  }

  /** Add a displayed watch expression and answer its row. */
  addDisplayWatch(exp: string): { id: string; exp: string } {
    let max = 0;
    for (const w of this.displayWatches) {
      const m = /^d(\d+)$/.exec(w.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const row = { id: `d${max + 1}`, exp };
    this.displayWatches.push(row);
    this.emit('changed');
    return row;
  }

  /** Remove a displayed watch by id; false when no row had it. */
  removeDisplayWatch(id: string): boolean {
    const i = this.displayWatches.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.displayWatches.splice(i, 1);
    this.emit('changed');
    return true;
  }

  /* ---------- files ---------- */

  pathForFileId(fileId: number): string | undefined {
    return this.files.get(fileId)?.path;
  }

  locate(rid: number): { path: string; line: number } | undefined {
    const loc = this.files.locate(rid);
    return loc ? { path: loc.path, line: loc.range[0] } : undefined;
  }

  /** The function whose body contains `line` (the stop slice's block). */
  functionAt(fileId: number, line: number): { name: string; bodyRange: [number, number, number, number] } | undefined {
    const fn = this.files.functionAt(fileId, line);
    return fn ? { name: fn.name, bodyRange: fn.bodyRange } : undefined;
  }

  /* ---------- waiting ---------- */

  /** The next pause (its info) or the end of the run ('finished'); rejects after `timeoutMs`. */
  waitForPause(timeoutMs = PAUSE_TIMEOUT_MS): Promise<PausedInfo | 'finished'> {
    if (this.disposed) return Promise.resolve('finished');
    return this.waiters.wait(timeoutMs, 'no pause');
  }

  private waitForFinish(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const onFinished = (): void => done();
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.once('finished', onFinished);
    });
  }

  /* ---------- helpers ---------- */

  private settle(result: PausedInfo | 'finished'): void {
    this.waiters.settle(result);
  }

  private inFlight(): boolean {
    return !this.disposed && !!this.runner && !!this.runId && this.running;
  }

  private requirePaused(what: string): void {
    if (this.state.paused) return;
    if (this.running) throw new Error(`cannot ${what}: the program is running`);
    throw new Error(`cannot ${what}: the debug session is not paused`);
  }

  /** A `debug` action whose reply is not read (`continue`, `step`, `pause`). */
  private async action(body: { action: 'continue' | 'step' | 'pause'; kind?: StepKind }): Promise<void> {
    await this.request(body);
  }

  private request(body: { action: 'continue' | 'step' | 'pause' | 'breakpoints' | 'watches' | 'locals' | 'exceptions'; kind?: StepKind; set?: BreakpointSpec[] | BreakWatchSpec[]; mode?: ExceptionMode; frameId?: number }): Promise<Record<string, unknown>> {
    const runner = this.runner;
    if (!runner || !this.runId) return Promise.reject(new Error('the debug session has ended'));
    return runner.debug(this.runId, body);
  }
}
