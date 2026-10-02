/**
 * One Pyokka session per document: owns a runner process, the run loop (modes + debounce),
 * markers, watches and the state produced by the latest run.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import type { Completions, CoverageEvent, ErrorEvent, HttpExchangeEvent, HttpMode, LocalsEvent, LogEvent, OutputEvent, Range4, RunEvent, RunFinishedEvent, RunMode as ProtocolRunMode, StatementBinding, TimeEvent, WatchEvent } from '../shared/protocol';
import { decodeSteps } from '../shared/protocol';
import { RunnerClient } from '../runtime/runnerClient';
import type { Interpreter } from '../runtime/interpreter';
import { FileTable, type RidLocation } from './fileTable';
import { MarkerStore, type EditDelta, type SessionMarker } from './markers';
import { displayCap } from '../shared/traceCap';
import { TraceModel } from '../timeMachine/traceModel';
import { resolveSessionConfig, setting, type ResolvedSessionConfig } from '../config/settings';
import { log } from '../util/log';
import { freshNavState, type NavState, type RunMode, type SessionStatus, type WatchEntry } from './types';
import { applyEditToDirtyLines } from './dirtyLines';
import { PartialScopes } from './traceDelta';
import { DebugController, type DebugStartOptions } from './debugController';
import { appendOutput as appendToBuffer } from './outputBuffer';
import type { BreakpointSpec, BreakWatchSpec, DebugBreakpointEcho, DebugState, ExceptionMode, LocalVar, PausedInfo, StepKind } from './debugState';
import type { ExecResult } from '../debug/debugExec';

export interface RunState {
  runId: string;
  content: string;
  files: FileTable;
  entries: LogEvent[];
  entriesById: Map<string, LogEvent>;
  entriesByRid: Map<number, LogEvent[]>;
  errors: ErrorEvent[];
  coverage: Map<number, { states: number[]; hits: number[] }>;
  times: Map<number, TimeEvent>;
  trace: TraceModel | undefined;
  /** accumulated mid-run trace deltas (quads and scopes), see the `trace` handler */
  tracePartial?: Int32Array;
  tracePartialLength?: number;
  tracePartialScopes?: PartialScopes;
  /** the recording began at a pause (`recordFrom`): step 0 is that pause, not the program's start */
  midRun?: boolean;
  locals: LocalsEvent['entries'];
  /** statement bindings per file (what each statement assigns and reads), fetched from the runner on first use (variableQuery.ts) */
  bindings: Map<number, Promise<ReadonlyMap<number, StatementBinding> | undefined>>;
  /** what the program printed, in arrival order: the runtime's `print` entries and the raw writes it forwards (the last OUTPUT_KEPT characters) */
  output: string;
  /** the run's HTTP requests in arrival order (httpTable.ts builds the table) */
  http: HttpExchangeEvent[];
  finished: RunFinishedEvent | undefined;
  mode: ProtocolRunMode;
}

function appendOutput(st: RunState, text: string): void {
  st.output = appendToBuffer(st.output, text);
}

function emptyRunState(runId: string, content: string, mode: ProtocolRunMode): RunState {
  return { runId, content, files: new FileTable(), entries: [], entriesById: new Map(), entriesByRid: new Map(), errors: [], coverage: new Map(), times: new Map(), trace: undefined, locals: [], bindings: new Map(), output: '', http: [], finished: undefined, mode };
}

export interface SessionOptions {
  document: vscode.TextDocument;
  interpreter: Interpreter;
  runtimeDir: string;
  workspaceRoot: string;
  runMode?: RunMode;
  autoLog?: boolean;
  mode?: ProtocolRunMode;
  extraPythonPath?: string[];
}

export interface SessionEvents {
  stateChanged: [];
  statusChanged: [];
  settingsChanged: [];
  runStarted: [runId: string];
  runFinished: [ev: RunFinishedEvent, state: RunState];
  log: [LogEvent];
  error: [ErrorEvent];
  output: [OutputEvent];
  trace: [TraceModel];
  watch: [WatchEvent];
  /** an HTTP request of the current run completed (the row is in `state.http`) */
  http: [HttpExchangeEvent];
  navChanged: [];
  /** the debugger's state changed (mode, pause, breakpoints, watches); `debugPaused` carries the pause, `debugResumed` the resume */
  debugChanged: [];
  debugPaused: [info: PausedInfo];
  debugResumed: [];
  /** files instrumented so far in the running run (throttled) */
  progress: [];
  disposed: [];
}

export const MISSING_MODULE_RE = /No module named '([A-Za-z0-9_.]+)'/;

export class Session extends EventEmitter<SessionEvents> {
  readonly key: string;
  readonly document: vscode.TextDocument;
  readonly interpreter: Interpreter;
  readonly workspaceRoot: string;
  /** path sent to the runner (synthetic for untitled documents) */
  readonly filePath: string;
  readonly displayName: string;
  readonly runner: RunnerClient;
  readonly markers = new MarkerStore();
  readonly watches: WatchEntry[] = [];
  readonly nav: NavState = freshNavState();
  readonly startedAt = Date.now();
  /** the debugger (docs/HANDOFF-debugger.md): debug mode, the pause at the frontier, breakpoints; use the `debug*` methods below */
  readonly debugCtl = new DebugController(this);

  runMode: RunMode;
  autoLog: boolean;
  /** step into third-party packages (instrumented on import); off unless the setting or the session toggle says so */
  libraryCode: boolean;
  /** mask secrets in every value the run reports (session toggle; a run makes it take effect) */
  maskSecrets: boolean;
  /** kill a run after this many ms, 0 = never (session value; the next run uses it) */
  runTimeoutMs: number;
  /** record every changed local at every step (session toggle; the Variable pane's first source; the next run records) */
  recordLocals: boolean;
  /** the HTTP layer of the next run: record every exchange to the workspace's replay file, or answer from it (session value; a change never runs by itself) */
  http: HttpMode;
  showValueOnSelection: boolean;
  showSingleInlineValue: boolean;
  valuePeek: boolean;
  /** 'normal' or 'snaps' */
  mode: ProtocolRunMode;
  extraPythonPath: string[];
  config: ResolvedSessionConfig;
  /**
   * The three launch attributes a recording debug session sets (docs/design/debugger-product.md,
   * 3.7). Undefined for every ordinary run-all run, so its request is byte for byte what it was.
   */
  argvOverride: string[] | undefined;
  cwdOverride: string | undefined;
  envOverride: Record<string, string> | undefined;

  /** state of the latest run that produced events (may still be running) */
  state: RunState;
  /** the previous finished state, kept while a new run is in flight (stale rendering) */
  previous: RunState | undefined;
  status: SessionStatus = 'idle';
  /** something (marker, watch, auto log, logpoint) wants a run but the run mode forbids implicit runs */
  pendingRun = false;
  /** lines (1-based) edited since the last run snapshot; their inline values are hidden */
  dirtyLines: Set<number> = new Set();
  /** shadow values computed for edited lines from the finished run's state (line -> entry) */
  readonly shadowValues = new Map<number, LogEvent>();
  /** synthetic entries the user explored; the panel lists them after the run's own entries */
  pinnedEntries: LogEvent[] = [];
  missingModules = new Set<string>();
  lastError: string | undefined;

  private runCounter = 0;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pendingFinish = new Map<string, (ev: RunFinishedEvent) => void>();
  private disposed = false;
  private runnerErrorNotified = false;
  private traceContext: { step: number; prefetch: number } | undefined;

  constructor(opts: SessionOptions) {
    super();
    this.document = opts.document;
    this.key = opts.document.uri.toString();
    this.interpreter = opts.interpreter;
    this.workspaceRoot = opts.workspaceRoot;
    this.displayName = path.basename(opts.document.fileName) + (opts.document.isUntitled && !opts.document.fileName.endsWith('.py') ? '.py' : '');
    this.filePath = opts.document.uri.scheme === 'file' ? opts.document.uri.fsPath : path.join(opts.workspaceRoot || os.tmpdir(), this.displayName);
    this.mode = opts.mode ?? 'normal';
    this.extraPythonPath = opts.extraPythonPath ?? [];
    this.config = resolveSessionConfig(opts.document.uri, opts.workspaceRoot, opts.document.uri.scheme === 'file' ? path.dirname(opts.document.uri.fsPath) : undefined);
    this.runMode = opts.runMode ?? this.config.runMode;
    this.autoLog = opts.autoLog ?? this.config.run.autoLog;
    this.libraryCode = this.config.run.libraryCode;
    this.maskSecrets = this.config.run.secrets.mask;
    this.runTimeoutMs = this.config.run.timeoutMs;
    this.recordLocals = this.config.run.recordLocals;
    this.http = this.config.run.http;
    this.showValueOnSelection = this.config.showValueOnSelection;
    this.showSingleInlineValue = this.config.showSingleInlineValue;
    this.valuePeek = setting('valuePeek', true, opts.document.uri);
    this.state = emptyRunState('r-0', '', this.mode);
    // Node throws on an 'error' event with no listener; a session can be unbound from the panel
    this.on('error', () => undefined);
    const env: Record<string, string> = { ...this.config.env };
    this.runner = new RunnerClient({
      command: opts.interpreter.path,
      cwd: opts.runtimeDir,
      env,
      version: '1',
      log: (line) => log.info(`[${this.displayName}] ${line}`),
    });
    this.runner.on('event', (ev) => this.handleEvent(ev));
    this.runner.on('runnerError', (message, detail) => {
      log.error(`runner error (${this.displayName}): ${message}${detail ? `\n${detail}` : ''}`);
      if (!this.runnerErrorNotified) {
        this.runnerErrorNotified = true;
        void vscode.window.showErrorMessage(`Pyokka runtime error: ${message}`, 'Show Logs').then((pick) => {
          if (pick) log.show();
        });
      }
    });
    this.runner.on('exit', (code, _signal, willRestart) => {
      if (this.disposed) return;
      if (this.status === 'running') {
        this.status = 'failed';
        this.lastError = `runner exited with code ${code ?? 'null'}`;
        this.emit('statusChanged');
      }
      if (willRestart) log.warn(`runner for ${this.displayName} exited; it restarts on the next run`);
    });
  }

  /* ---------- lifecycle ---------- */

  async start(): Promise<void> {
    await this.runner.start();
    await this.runNow('start');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    for (const [, resolve] of this.pendingFinish) resolve({ type: 'run.finished', runId: '', seq: 0, exitCode: null, durationMs: 0, timedOut: false, stopped: true, stepCount: 0, logCount: 0 });
    this.pendingFinish.clear();
    this.runner.dispose();
    this.emit('disposed');
    this.removeAllListeners();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get running(): boolean {
    return this.status === 'running';
  }

  /** A debounced run is about to start (Auto Log switched on by the Time Machine, an edit in Automatic mode, ...). */
  get runScheduled(): boolean {
    return this.debounceTimer !== undefined;
  }

  /* ---------- run loop ---------- */

  /** Debounced run (auto mode edits, marker changes). */
  scheduleRun(reason: string, delayMs?: number): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const delay = Math.max(delayMs ?? this.config.delay ?? 0, 40);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runNow(reason).catch((err) => log.error(`run failed (${reason})`, err));
    }, delay);
  }

  setTraceContext(ctx: { step: number; prefetch: number } | undefined): void {
    this.traceContext = ctx;
  }

  /**
   * Only the Automatic run mode may execute the file without an explicit user action
   * (hover, watch, auto log, markers, logpoints). On Save / On Demand queue the request
   * until the next explicit run, because every run re-executes the user's side effects.
   */
  get implicitRunsAllowed(): boolean {
    return this.runMode === 'auto';
  }

  /** Run now if implicit runs are allowed, else remember that a run is needed. */
  scheduleImplicitRun(reason: string): void {
    if (this.implicitRunsAllowed) {
      this.scheduleRun(reason, 0);
      return;
    }
    if (!this.pendingRun) {
      this.pendingRun = true;
      log.info(`[${this.displayName}] ${reason}: run deferred (run mode ${this.runMode})`);
      this.emit('statusChanged');
    }
  }

  private projectFiles(): { path: string; content: string }[] {
    const out: { path: string; content: string }[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (doc === this.document || doc.languageId !== 'python' || doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      out.push({ path: doc.uri.fsPath, content: doc.getText() });
    }
    return out;
  }

  /** Execute now. Resolves with the `run.finished` event of this run (or a stopped stub). */
  runNow(reason: string, opts: { mode?: ProtocolRunMode } = {}): Promise<RunFinishedEvent> {
    if (this.disposed) return Promise.resolve(stoppedStub(''));
    if (this.debugCtl.blocksRun(reason)) return Promise.resolve(stoppedStub(this.state.runId));
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    const runId = `r-${++this.runCounter}`;
    this.pendingRun = false;
    this.dirtyLines = new Set();
    this.shadowValues.clear();
    this.pinnedEntries = [];
    const content = this.document.getText();
    const mode = opts.mode ?? this.mode;
    this.config = resolveSessionConfig(this.document.uri, this.workspaceRoot, this.document.uri.scheme === 'file' ? path.dirname(this.document.uri.fsPath) : undefined);
    const env: Record<string, string> = { ...this.config.env };
    if (this.extraPythonPath.length) env['PYTHONPATH'] = [...this.extraPythonPath, env['PYTHONPATH'] ?? process.env['PYTHONPATH'] ?? ''].filter(Boolean).join(path.delimiter);
    const debugExtras = this.debugCtl.requestExtras();
    const request = {
      runId,
      file: { path: this.filePath, displayName: this.displayName, content },
      workspaceRoot: this.workspaceRoot,
      cwd: this.cwdOverride ?? (this.workspaceRoot || path.dirname(this.filePath)),
      argv: this.argvOverride ?? this.config.argv,
      env: this.envOverride ? { ...env, ...this.envOverride } : env,
      projectFiles: this.projectFiles(),
      config: { ...this.config.run, autoLog: this.autoLog, libraryCode: this.libraryCode, timeoutMs: this.runTimeoutMs, recordLocals: this.recordLocals, http: this.http, secrets: { ...this.config.run.secrets, mask: this.maskSecrets }, ...(debugExtras?.config ?? {}) },
      breakpoints: debugExtras?.breakpoints,
      markers: this.markers.forRun(),
      expressionsToEvaluate: {},
      watch: this.watches.map((w) => ({ id: w.id, exp: w.exp, range: w.range })),
      traceContext: this.nav.active && this.watches.length ? this.traceContext : undefined,
      mode,
    };
    log.info(`[${this.displayName}] run ${runId} (${reason}, ${mode}, ${request.markers.length} markers, ${request.watch.length} watches${this.http === 'off' ? '' : `, http ${this.http}`})`);
    const finished = new Promise<RunFinishedEvent>((resolve) => this.pendingFinish.set(runId, resolve));
    // the new state becomes visible on `run.started`; keep the old one for stale rendering
    const incoming = emptyRunState(runId, content, mode);
    this.incoming.set(runId, incoming);
    this.status = 'running';
    this.emit('statusChanged');
    this.runner.run(request).catch((err) => {
      log.error(`run request failed (${this.displayName})`, err);
      this.incoming.delete(runId);
      this.status = 'failed';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit('statusChanged');
      const resolve = this.pendingFinish.get(runId);
      this.pendingFinish.delete(runId);
      resolve?.(stoppedStub(runId));
    });
    return finished;
  }

  private readonly incoming = new Map<string, RunState>();
  private progressTimer: NodeJS.Timeout | undefined;

  /** `progress` at most every 200 ms: a library run instruments a thousand files. */
  private emitProgress(): void {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      if (!this.disposed) this.emit('progress');
    }, 200);
  }

  async stopRun(): Promise<void> {
    if (this.status !== 'running') return;
    await this.runner.stop(this.state.runId);
  }

  private handleEvent(ev: RunEvent): void {
    if (this.disposed) return;
    const st = this.incoming.get(ev.runId) ?? (this.state.runId === ev.runId ? this.state : undefined);
    if (!st) return; // superseded run
    switch (ev.type) {
      case 'run.started':
        this.debugCtl.handleEvent(ev);
        this.incoming.delete(ev.runId);
        if (this.state.runId !== ev.runId) {
          this.previous = this.state.finished ? this.state : this.previous;
          this.state = st;
        }
        this.emit('runStarted', ev.runId);
        this.emit('stateChanged');
        break;
      case 'file.instrumented':
        st.files.add(ev);
        if (st === this.state) this.emitProgress();
        break;
      case 'output':
        appendOutput(st, ev.text);
        if (st === this.state) this.emit('output', ev);
        break;
      case 'log': {
        // a print is a log entry, not an `output` event: both belong to what the program printed
        if (ev.kind === 'log') appendOutput(st, `${ev.text}\n`);
        st.entries.push(ev);
        st.entriesById.set(ev.logId, ev);
        const list = st.entriesByRid.get(ev.rid);
        if (list) list.push(ev);
        else st.entriesByRid.set(ev.rid, [ev]);
        if (st === this.state) {
          this.emit('log', ev);
          this.emit('stateChanged');
        }
        break;
      }
      case 'error': {
        st.errors.push(ev);
        const m = MISSING_MODULE_RE.exec(ev.message);
        if (m && /ModuleNotFoundError|ImportError/.test(ev.errorType ?? '')) this.missingModules.add(m[1]!.split('.')[0]!);
        if (st === this.state) {
          this.emit('error', ev);
          this.emit('stateChanged');
        }
        break;
      }
      case 'coverage':
        st.coverage.set(ev.fileId, { states: ev.states, hits: ev.hits });
        if (st === this.state) this.emit('stateChanged');
        break;
      case 'time':
        st.times.set(ev.rid, ev);
        break;
      case 'trace': {
        let steps: Int32Array;
        try {
          steps = decodeSteps(ev.steps);
        } catch (err) {
          log.error('bad trace payload', err);
          steps = new Int32Array(0);
        }
        let scopes = ev.scopes;
        if (ev.midRun) st.midRun = true;
        if (ev.partial) {
          // mid-run delta covering steps offset.. ; keep the pieces so a killed run still has a trace
          const offset = (ev.offset ?? 0) * 4;
          const needed = offset + steps.length;
          if (!st.tracePartial || st.tracePartial.length < needed) {
            const grown = new Int32Array(Math.max(needed, (st.tracePartial?.length ?? 0) * 2));
            if (st.tracePartial) grown.set(st.tracePartial);
            st.tracePartial = grown;
          }
          st.tracePartial.set(steps, offset);
          st.tracePartialLength = Math.max(st.tracePartialLength ?? 0, needed);
          st.tracePartialScopes ??= new PartialScopes();
          scopes = st.tracePartialScopes.apply(ev.scopes, steps, ev.offset ?? 0);
          steps = st.tracePartial.subarray(0, st.tracePartialLength);
        } else {
          st.tracePartial = undefined;
          st.tracePartialLength = undefined;
          st.tracePartialScopes = undefined;
        }
        const files = st.files;
        // the final event of a run cut at the step cap says where it stopped and who spent the steps
        const cap = ev.truncated && !ev.partial && typeof ev.cap === 'number' ? displayCap({ cap: ev.cap, ...(ev.stepsRun !== undefined ? { stepsRun: ev.stepsRun } : {}), spentBy: ev.spentBy ?? [] }, this.workspaceRoot, this.filePath) : undefined;
        st.trace = new TraceModel(
          steps,
          scopes,
          ev.truncated,
          (rid) => {
            const loc = files.locate(rid);
            return loc ? { fileId: loc.fileId, range: loc.range } : undefined;
          },
          cap,
        );
        if (st === this.state) this.emit('trace', st.trace);
        break;
      }
      case 'locals':
        st.locals.push(...ev.entries);
        break;
      case 'watch': {
        const w = this.watches.find((x) => x.id === ev.watchId);
        if (w) w.values.set(ev.step, { valueBag: ev.valueBag, error: ev.error });
        if (st === this.state) this.emit('watch', ev);
        break;
      }
      case 'http.exchange':
        st.http.push(ev);
        if (st === this.state) this.emit('http', ev);
        break;
      case 'run.finished': {
        this.debugCtl.handleEvent(ev);
        st.finished = ev;
        this.incoming.delete(ev.runId);
        if (st === this.state) {
          this.previous = undefined;
          if (ev.stopped && this.incoming.size) {
            // killed by a newer run; keep showing until the newer one starts
          } else {
            this.status = ev.stopped ? 'idle' : st.errors.some((e) => !e.handled) || ev.timedOut || (ev.exitCode ?? 0) !== 0 ? 'failed' : 'done';
            this.lastError = ev.timedOut ? `timed out after ${ev.durationMs}ms` : undefined;
            this.emit('statusChanged');
          }
          // the counterpart to the "run ..." line: without it the log says a run started and
          // never what it produced, which makes a run that traces nothing impossible to read
          log.info(
            `[${this.displayName}] run ${ev.runId} done in ${Math.round(ev.durationMs)}ms: exit ${ev.exitCode ?? 'null'}, ${st.trace?.count ?? 0} steps, ${st.entries.length} entries, ${st.errors.length} errors` +
              `${ev.timedOut ? ', timed out' : ''}${ev.stopped ? ', stopped' : ''}`,
          );
          this.emit('runFinished', ev, st);
          this.emit('stateChanged');
        }
        const resolve = this.pendingFinish.get(ev.runId);
        this.pendingFinish.delete(ev.runId);
        resolve?.(ev);
        break;
      }
      case 'debug.paused':
      case 'debug.resumed':
        this.debugCtl.handleEvent(ev);
        break;
      default:
        break;
    }
  }

  /* ---------- the debugger (debugController.ts) ---------- */

  get debug(): DebugState {
    return this.debugCtl.snapshot();
  }

  startDebug(opts?: DebugStartOptions): Promise<void> {
    return this.debugCtl.start(opts);
  }

  stopDebug(): void {
    this.debugCtl.stop();
  }

  debugContinue(): Promise<void> {
    return this.debugCtl.resume();
  }

  debugStep(kind: StepKind): Promise<void> {
    return this.debugCtl.step(kind);
  }

  debugPause(): Promise<void> {
    return this.debugCtl.pause();
  }

  setDebugBreakpoints(specs: BreakpointSpec[]): Promise<DebugBreakpointEcho[]> {
    return this.debugCtl.setBreakpoints(specs);
  }

  setDebugWatches(specs: BreakWatchSpec[]): Promise<void> {
    return this.debugCtl.setWatches(specs);
  }

  setDebugExceptions(mode: ExceptionMode): Promise<void> {
    return this.debugCtl.setExceptions(mode);
  }

  debugLocals(opts?: { frameId?: number }): Promise<LocalVar[]> {
    return this.debugCtl.locals(opts);
  }

  /** Run a statement in the paused frame (the Debug Console, `setVariable`, `exec --live`). */
  debugExec(source: string, opts?: { frameId?: number }): Promise<ExecResult> {
    return this.debugCtl.exec(source, opts);
  }

  waitForPause(timeoutMs?: number): Promise<PausedInfo | 'finished'> {
    return this.debugCtl.waitForPause(timeoutMs);
  }

  /* ---------- document integration ---------- */

  /** Called by the manager for every change of this session's document. */
  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    const deltas: EditDelta[] = e.contentChanges.map((c) => ({
      startLine: c.range.start.line + 1,
      startCol: c.range.start.character,
      endLine: c.range.end.line + 1,
      endCol: c.range.end.character,
      text: c.text,
    }));
    this.markers.applyEdits(deltas);
    for (const delta of deltas) this.dirtyLines = applyEditToDirtyLines(this.dirtyLines, delta);
    this.emit('stateChanged');
    if (this.runMode === 'auto') this.scheduleRun('edit');
  }

  onDocumentSaved(): void {
    if (this.runMode === 'onSave') this.scheduleRun('save', 0);
  }

  setRunMode(mode: RunMode): void {
    if (this.runMode === mode) return;
    this.runMode = mode;
    this.emit('settingsChanged');
    if (mode === 'auto' && this.document.isDirty) this.scheduleRun('mode');
  }

  setAutoLog(on: boolean): void {
    if (this.autoLog === on) return;
    this.autoLog = on;
    this.emit('settingsChanged');
    if (on) this.scheduleImplicitRun('autoLog');
    else if (this.implicitRunsAllowed) this.scheduleRun('autoLog', 0);
  }

  /** Per-session "Step Into Library Code"; needs a run to take effect (instrumentation happens on import). */
  setLibraryCode(on: boolean): void {
    if (this.libraryCode === on) return;
    this.libraryCode = on;
    this.emit('settingsChanged');
    this.scheduleImplicitRun('libraryCode');
  }

  /** Per-session run timeout in ms (0 = no limit); the next run uses it, a running one keeps its deadline. */
  setRunTimeout(ms: number): void {
    const next = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : this.runTimeoutMs;
    if (this.runTimeoutMs === next) return;
    this.runTimeoutMs = next;
    this.emit('settingsChanged');
  }

  /** Per-session HTTP record / replay; the next run uses it. Never an implicit run: a record run reaches the network and may cost money. */
  setHttp(mode: HttpMode): void {
    if (this.http === mode) return;
    this.http = mode;
    this.emit('settingsChanged');
  }

  /** Per-session "Record Variable Changes"; the tracer records locals while running, so a change needs a run. */
  setRecordLocals(on: boolean): void {
    if (this.recordLocals === on) return;
    this.recordLocals = on;
    this.emit('settingsChanged');
    this.scheduleImplicitRun('recordLocals');
  }

  /** Per-session "Mask Secrets"; values are masked in the run child, so a change needs a run. */
  setMaskSecrets(on: boolean): void {
    if (this.maskSecrets === on) return;
    this.maskSecrets = on;
    this.emit('settingsChanged');
    this.scheduleImplicitRun('maskSecrets');
  }

  setShowValueOnSelection(on: boolean): void {
    this.showValueOnSelection = on;
    this.emit('settingsChanged');
  }

  setShowSingleInlineValue(on: boolean): void {
    this.showSingleInlineValue = on;
    if (on) this.trimToSingleValueMarker();
    this.emit('settingsChanged');
    this.emit('stateChanged');
  }

  setValuePeek(on: boolean): void {
    this.valuePeek = on;
    this.emit('settingsChanged');
  }

  /* ---------- markers ---------- */

  /** Add a Show Value style marker; honours "show single inline value". */
  addValueMarker(range: Range4, origin: SessionMarker['origin'], init: { kind?: 'value' | 'time'; context?: string; exp?: string; autoExpand?: boolean; transient?: boolean } = {}): SessionMarker {
    if (!init.transient && this.showSingleInlineValue && (origin === 'showValue' || origin === 'selection' || origin === 'story')) {
      this.markers.removeWhere((m) => !m.transient && (m.origin === 'showValue' || m.origin === 'selection' || m.origin === 'story'));
    }
    // avoid duplicates for the same range
    if (!init.transient) this.markers.removeWhere((m) => !m.transient && m.kind === (init.kind ?? 'value') && sameRange(m.range, range));
    const marker = this.markers.add({ kind: init.kind ?? 'value', range, origin, context: init.context, exp: init.exp ?? null, autoExpand: init.autoExpand, transient: init.transient });
    if (!init.transient) this.scheduleImplicitRun('marker');
    return marker;
  }

  private trimToSingleValueMarker(): void {
    const sticky = this.markers.visible().filter((m) => m.origin === 'showValue' || m.origin === 'selection' || m.origin === 'story');
    if (sticky.length <= 1) return;
    const keep = sticky[sticky.length - 1]!;
    this.markers.removeWhere((m) => !m.transient && (m.origin === 'showValue' || m.origin === 'selection' || m.origin === 'story') && m.id !== keep.id);
  }

  removeMarkers(ids: string[]): void {
    let removed = 0;
    for (const id of ids) if (this.markers.remove(id)) removed++;
    if (removed) {
      this.emit('stateChanged');
      this.scheduleImplicitRun('marker');
    }
  }

  /** Replace all logpoint markers (from VS Code breakpoints) and re-run when they changed. */
  setLogpoints(points: { range: Range4; logMessage: string }[]): void {
    const before = JSON.stringify(this.markers.all().filter((m) => m.kind === 'logpoint').map((m) => [m.range, m.logMessage]));
    this.markers.removeWhere((m) => m.kind === 'logpoint');
    for (const p of points) this.markers.add({ kind: 'logpoint', range: p.range, origin: 'logpoint', logMessage: p.logMessage, context: p.logMessage });
    const after = JSON.stringify(this.markers.all().filter((m) => m.kind === 'logpoint').map((m) => [m.range, m.logMessage]));
    if (before !== after) this.scheduleImplicitRun('logpoints');
  }

  /**
   * Run once with a transient marker and return the log it produced (Value Peek, Copy Value).
   * Returns undefined without running when the run mode forbids implicit runs.
   */
  async evaluateTransient(range: Range4, init: { kind?: 'value' | 'time'; context?: string; exp?: string } = {}): Promise<LogEvent | undefined> {
    if (!this.implicitRunsAllowed) {
      this.scheduleImplicitRun('evaluate');
      return undefined;
    }
    const marker = this.markers.add({ kind: init.kind ?? 'value', range, origin: 'transient', context: init.context, exp: init.exp ?? null, transient: true });
    try {
      const finished = await this.runNow('evaluate');
      const st = this.state.runId === finished.runId ? this.state : undefined;
      return st?.entries.find((e) => e.markerId === marker.id);
    } finally {
      this.markers.remove(marker.id);
    }
  }

  private liveCounter = 0;

  /**
   * Ask the finished run's child for the current value of a side-effect-free expression.
   * Nothing is re-executed. The result is registered by id (not listed) so hover links work.
   * Undefined when there is no finished run, a run is in flight, or the expression is not
   * evaluable (a call to a function of the program's own, an unknown name).
   */
  async evaluateLive(expression: string, line?: number, opts: { frameId?: number } = {}): Promise<LogEvent | undefined> {
    if (!expression.trim()) return undefined; // an empty watch field would come back as a SyntaxError
    // a paused debug run answers in the paused frame (the runner routes `evaluate` there)
    const paused = this.debugCtl.snapshot().paused;
    if (this.disposed || (!paused && (this.running || !this.state.finished || this.state.finished.stopped))) return undefined;
    const runId = this.state.runId;
    try {
      const r = await this.runner.evaluate(runId, expression, opts);
      if (this.state.runId !== runId) return undefined;
      const ev: LogEvent = { type: 'log', runId, seq: 0, logId: `live-${++this.liveCounter}`, kind: 'value', fileId: this.mainFileId() ?? 1, rid: 0, hit: 1, step: paused ? paused.step : this.trace ? this.trace.count - 1 : 0, context: expression, text: r.text, runtimeKey: r.valueBag.runtimeKey, valueBag: r.valueBag, liveLine: line };
      this.state.entriesById.set(ev.logId, ev);
      return ev;
    } catch (err) {
      log.info(`[${this.displayName}] evaluate ${JSON.stringify(expression)}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Completions for a watch expression typed so far (`text` is what precedes the caret): names in
   * scope for a bare prefix, the object's attributes after a dot. Same namespace as `evaluateLive`:
   * the paused frame while a debug run is paused, else the finished run's module. Empty when there
   * is nothing to ask (a run in flight, no finished run) or the runner declined.
   */
  async completeExpression(text: string, limit?: number): Promise<Completions> {
    const paused = this.debugCtl.snapshot().paused;
    const none: Completions = { prefix: /[A-Za-z_][A-Za-z0-9_]*$/.exec(text)?.[0] ?? '', items: [] };
    if (this.disposed || (!paused && (this.running || !this.state.finished || this.state.finished.stopped))) return none;
    try {
      return await this.runner.complete(this.state.runId, text, limit);
    } catch (err) {
      log.info(`[${this.displayName}] complete ${JSON.stringify(text)}: ${err instanceof Error ? err.message : String(err)}`);
      return none;
    }
  }

  /** Shadow value for one edited line: what the statement would show, from the finished run's state. */
  async shadowLine(line: number, source: string): Promise<LogEvent | undefined> {
    if (this.disposed || this.running || !this.state.finished || this.state.finished.stopped) return undefined;
    const runId = this.state.runId;
    try {
      const r = await this.runner.shadow(runId, source);
      if (this.state.runId !== runId) return undefined;
      const kind = r.kind === 'log' ? 'log' : 'value';
      const ev: LogEvent = { type: 'log', runId, seq: 0, logId: `shadow-${line}-${++this.liveCounter}`, kind, fileId: this.mainFileId() ?? 1, rid: 0, hit: 1, step: this.trace ? this.trace.count - 1 : 0, context: r.context, text: r.text, runtimeKey: r.valueBag.runtimeKey, valueBag: r.valueBag, liveLine: line };
      this.state.entriesById.set(ev.logId, ev);
      return ev;
    } catch {
      return undefined;
    }
  }

  /** Keep an entry the list does not show (live / shadow, a transient marker's) in the panel's list so it can be explored. */
  pinEntry(ev: LogEvent): void {
    if (this.pinnedEntries.includes(ev) || (this.state.entries.includes(ev) && this.isEntryVisible(ev))) return;
    this.pinnedEntries = [...this.pinnedEntries.filter((e) => e.context !== ev.context || e.liveLine !== ev.liveLine), ev].slice(-20);
  }

  /* ---------- watches ---------- */

  addWatch(exp: string, range?: Range4, fileId?: number): WatchEntry {
    const w: WatchEntry = { id: `w-${Date.now().toString(36)}-${this.watches.length}`, exp, range, fileId, values: new Map() };
    this.watches.push(w);
    return w;
  }

  removeWatch(id: string): boolean {
    const i = this.watches.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.watches.splice(i, 1);
    return true;
  }

  /* ---------- queries ---------- */

  get files(): FileTable {
    return this.state.files;
  }

  get trace(): TraceModel | undefined {
    return this.state.trace;
  }

  /** Instrumented source of a file of the last run; fetched from the runner when it was not sent (library files). */
  async instrumentedSource(fileId: number): Promise<string | undefined> {
    const f = this.state.files.get(fileId);
    if (f?.instrumentedSource !== undefined) return f.instrumentedSource;
    if (this.disposed || this.running || !this.state.finished) return undefined;
    const text = await this.runner.source(this.state.runId, fileId);
    if (f && text !== undefined) f.instrumentedSource = text;
    return text;
  }

  mainFileId(): number | undefined {
    return this.state.files.byPath(this.filePath)?.fileId ?? this.state.files.all()[0]?.fileId;
  }

  fileIdForDocument(doc: vscode.TextDocument): number | undefined {
    if (doc === this.document || doc.uri.toString() === this.key) return this.mainFileId();
    if (doc.uri.scheme !== 'file') return undefined;
    return this.state.files.byPath(doc.uri.fsPath)?.fileId;
  }

  /** Document/uri for a fileId of the current run (main file resolves to the session document). */
  uriForFileId(fileId: number): vscode.Uri | undefined {
    if (fileId === this.mainFileId()) return this.document.uri;
    const f = this.state.files.get(fileId);
    return f ? vscode.Uri.file(f.path) : undefined;
  }

  locate(rid: number): RidLocation | undefined {
    return this.state.files.locate(rid);
  }

  logsForRid(rid: number): LogEvent[] {
    return this.state.entriesByRid.get(rid) ?? [];
  }

  /** Entries visible in the panel / inline (marker-produced logs whose marker changed are hidden). */
  visibleEntries(state: RunState = this.state): LogEvent[] {
    return state.entries.filter((e) => this.isEntryVisible(e));
  }

  isEntryVisible(e: LogEvent): boolean {
    if (!e.markerId) return true;
    const m = this.markers.byId(e.markerId);
    if (!m || m.transient) return false;
    return !e.changeId || e.changeId === m.changeId;
  }

  displayPath(fileId: number): string {
    const f = this.state.files.get(fileId);
    if (!f) return this.displayName;
    if (f.path === this.filePath) return this.displayName;
    return this.workspaceRoot && f.path.startsWith(this.workspaceRoot) ? path.relative(this.workspaceRoot, f.path) : path.basename(f.path);
  }
}

function sameRange(a: Range4, b: Range4): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function stoppedStub(runId: string): RunFinishedEvent {
  return { type: 'run.finished', runId, seq: 0, exitCode: null, durationMs: 0, timedOut: false, stopped: true, stepCount: 0, logCount: 0 };
}
