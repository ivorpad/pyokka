/**
 * The debugger's state on a session and the pure decisions around it: what a `debug.paused`
 * event turns into, which VS Code breakpoints reach the run, whether a Time Machine move at the
 * current position executes (at the frontier) or replays (behind it), and which run reasons a
 * debug run in flight must refuse. vscode-free so vitest covers it (test/unit/debugState.test.ts).
 *
 * A debug run is an ordinary run whose frontier can pause. `frontier` is the step of the pause,
 * the last recorded step; the Time Machine may sit anywhere at or before it.
 */
import type { DebugPausedEvent, DebugBreakpointSpec, DebugWatchSpec, DebugStepKind, ValueBag } from '../shared/protocol';

export type DebugReason = 'start' | 'breakpoint' | 'step' | 'watch' | 'pause' | 'exception';
export type StepKind = DebugStepKind;

/** When the debugger pauses on an exception: never, at the top of one nobody caught, or at every raise in user code. */
export type ExceptionMode = 'off' | 'uncaught' | 'raised';

/** The exception a run paused on (`reason: "exception"`). */
export interface PausedException {
  type: string;
  message: string;
  /** the exception reached the top: continuing ends the run */
  uncaught: boolean;
}

/** How every text form names an exception pause: `uncaught ValueError: too big: 3`. */
export function exceptionText(e: PausedException): string {
  return `${e.uncaught ? 'uncaught' : 'raised'} ${e.type}: ${e.message}`;
}

/**
 * One frame of a pause. Two shapes live in this type, told apart by which members are there: a
 * recording run sends `{scopeId, name, rid, depth}` (the scope chain), a `record: false` run sends
 * `{frameId, name, fileId, line}` (the frame chain, with the caller's real line). Members are
 * optional so both fit and the DAP mapping can prefer the real line when it is there.
 */
export interface DebugFrame {
  /** index into the pause's frame chain, innermost 0; `frameId` on locals / evaluate / exec */
  frameId?: number;
  name: string;
  scopeId?: number;
  rid?: number;
  depth?: number;
  /** the frame's own file and line at the pause (`record: false` carries the real caller line) */
  fileId?: number;
  line?: number;
  /** an uninstrumented frame's own file, so a slice that folds it can say which library it is in */
  path?: string;
}

/** The thread a pause happened on; on every pause in both products. */
export interface PausedThread {
  name: string;
  ident: number;
}

export interface DebugBreakpointEcho {
  /** absent on a function breakpoint that names no file */
  path?: string;
  /** absent on a function breakpoint until the runtime resolved it */
  line?: number;
  condition?: string;
  /** the function whose entry pauses (`--at NAME`), echoed back as it was asked for */
  function?: string;
  rid?: number;
  fileId?: number;
  resolvedLine?: number;
  error?: string;
}

export interface PausedInfo {
  step: number;
  rid: number;
  fileId: number;
  line: number | null;
  scopeId: number;
  depth: number;
  reason: DebugReason;
  kind?: StepKind;
  breakpoint?: DebugBreakpointEcho;
  conditionError?: string;
  watch?: { id: string; exp: string; text: string };
  /** with reason exception: what was raised, and whether it reached the top */
  exception?: PausedException;
  /** the thread being served; absent from an older runtime */
  thread?: PausedThread;
  /** an `exec` or a `setVariable` has written in this run: the values are no longer the program's own */
  modified?: boolean;
  /** the recording started at this pause (`recordFrom`, `record --live`): it is step 0 */
  recordingStarted?: boolean;
  /** innermost first */
  stack: DebugFrame[];
}

export type BreakpointSpec = DebugBreakpointSpec;
export type BreakWatchSpec = DebugWatchSpec;

export interface LocalVar {
  name: string;
  text: string;
  valueBag?: ValueBag;
}

export interface DebugState {
  /** debug mode is on: runs carry `config.debug` and the breakpoints, and pause */
  active: boolean;
  paused: PausedInfo | undefined;
  /** the step of the pause: the last recorded step, where the frame is live */
  frontier: number | undefined;
  /** breakpoints added through the API or the bridge (VS Code's own are merged in at send time) */
  breakpoints: BreakpointSpec[];
  watches: BreakWatchSpec[];
  /** where the debugger pauses on an exception; kept across runs and across `stop` */
  exceptions: ExceptionMode;
  /** an `exec` or a `setVariable` wrote in this run: the values are no longer the program's own */
  modified: boolean;
  /** the run the state describes */
  runId: string | undefined;
}

export function freshDebugState(): DebugState {
  return { active: false, paused: undefined, frontier: undefined, breakpoints: [], watches: [], exceptions: 'uncaught', modified: false, runId: undefined };
}

export function pausedInfo(ev: DebugPausedEvent): PausedInfo {
  const info: PausedInfo = { step: ev.step, rid: ev.rid, fileId: ev.fileId, line: ev.line ?? null, scopeId: ev.scopeId, depth: ev.depth, reason: ev.reason, stack: ev.stack ?? [] };
  if (ev.kind) info.kind = ev.kind;
  if (ev.breakpoint) info.breakpoint = ev.breakpoint;
  if (ev.conditionError) info.conditionError = ev.conditionError;
  if (ev.watch) info.watch = ev.watch;
  if (ev.exception) info.exception = ev.exception;
  if (ev.thread) info.thread = ev.thread;
  if (ev.modified) info.modified = true;
  if (ev.recordingStarted) info.recordingStarted = true;
  return info;
}

/** The runner events that move the debug state. */
export type DebugStateEvent = { type: 'run.started'; runId: string } | DebugPausedEvent | { type: 'debug.resumed' } | { type: 'run.finished' } | { type: 'stop' };

/** Pure: the next state after `ev`. `stop` is `stopDebug()`. */
export function reduceDebugState(state: DebugState, ev: DebugStateEvent): DebugState {
  switch (ev.type) {
    case 'run.started':
      // a new child is a new namespace: nothing has been written from a console yet
      return { ...state, runId: ev.runId, paused: undefined, frontier: undefined, modified: false };
    case 'debug.paused':
      return { ...state, paused: pausedInfo(ev), frontier: ev.step, modified: ev.modified ?? state.modified };
    case 'debug.resumed':
      return { ...state, paused: undefined, frontier: undefined };
    case 'run.finished':
      return { ...state, paused: undefined, frontier: undefined };
    case 'stop':
      return { ...state, active: false, paused: undefined, frontier: undefined };
    default:
      return state;
  }
}

/* ---------- breakpoints ---------- */

/** The shape of a `vscode.SourceBreakpoint` this module reads (structural, so tests need no vscode). */
export interface SourceBreakpointLike {
  enabled: boolean;
  condition?: string;
  logMessage?: string;
  location: { uri: { scheme: string; fsPath: string }; range: { start: { line: number } } };
}

/** Enabled file breakpoints that are not logpoints, as the run wants them (1-based lines). */
export function mapSourceBreakpoints(list: readonly SourceBreakpointLike[]): BreakpointSpec[] {
  const out: BreakpointSpec[] = [];
  for (const bp of list) {
    if (!bp.enabled || bp.logMessage || bp.location.uri.scheme !== 'file') continue;
    const spec: BreakpointSpec = { path: bp.location.uri.fsPath, line: bp.location.range.start.line + 1 };
    if (bp.condition && bp.condition.trim()) spec.condition = bp.condition.trim();
    out.push(spec);
  }
  return out;
}

/**
 * True when the file at `fsPath` carries a breakpoint that can pause the run, by the same rule
 * `mapSourceBreakpoints` applies: enabled, in a file, not a logpoint. Logpoints are markers in
 * Pyokka and never pause, so a file with only logpoints is false here.
 */
export function fileHasBreakpoints(list: readonly SourceBreakpointLike[], fsPath: string): boolean {
  return mapSourceBreakpoints(list).some((bp) => bp.path === fsPath);
}

/**
 * Whether a debug run pauses before its first statement: when asked (`stopOnEntry: true`), or when
 * no breakpoint can hit in the run's files (the file itself and the files of its last run).
 * Otherwise the run goes to the first breakpoint. A run without a stop would go unattended.
 *
 * `anyFile` is the cold start of an agent (`pyokka debug FILE`, the URI handler): no run has
 * instrumented anything yet, so any enabled breakpoint can still hit and the run goes to it;
 * only a start with nothing set pauses at the first statement.
 */
export function entryPause(req: { stopOnEntry?: unknown }, breakpoints: readonly BreakpointSpec[], files: readonly string[], opts: { anyFile?: boolean } = {}): boolean {
  if (req.stopOnEntry === true) return true;
  if (opts.anyFile) return breakpoints.length === 0;
  // a function breakpoint names no file until the runtime resolves it, so it can always still hit
  return !breakpoints.some((bp) => bp.function !== undefined || (bp.path !== undefined && files.includes(bp.path)));
}

/** One list for the run: VS Code's, the session's own and a transient one, without duplicates. */
export function mergeBreakpoints(...lists: (readonly BreakpointSpec[] | undefined)[]): BreakpointSpec[] {
  const seen = new Set<string>();
  const out: BreakpointSpec[] = [];
  for (const list of lists) {
    for (const bp of list ?? []) {
      const key = `${bp.function ?? ''}\n${bp.path ?? ''}\n${bp.line ?? ''}\n${bp.condition ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spec: BreakpointSpec = {};
      if (bp.function !== undefined) spec.function = bp.function;
      if (bp.path !== undefined) spec.path = bp.path;
      if (bp.line !== undefined) spec.line = bp.line;
      if (bp.condition) spec.condition = bp.condition;
      out.push(spec);
    }
  }
  return out;
}

/**
 * A function breakpoint's spec, as `--at NAME` and the Breakpoints view's "Add Function
 * Breakpoint" ask for it. The runtime resolves the name: `info.function_names` by exact match, or
 * by the `Class.method` suffix when the name has a dot.
 */
export function functionBreakpoint(name: string, condition?: string): BreakpointSpec {
  const spec: BreakpointSpec = { function: name.trim() };
  if (condition && condition.trim()) spec.condition = condition.trim();
  return spec;
}

/**
 * The session's own list with its function breakpoints replaced by `specs`: DAP's
 * `setFunctionBreakpoints` sends the whole list every time, and the line breakpoints are not its
 * business.
 */
export function replaceFunctionBreakpoints(current: readonly BreakpointSpec[], specs: readonly BreakpointSpec[]): BreakpointSpec[] {
  return mergeBreakpoints(
    current.filter((bp) => bp.function === undefined),
    specs,
  );
}

/* ---------- moves ---------- */

export type NavigatorMoveKind = 'into' | 'back' | 'over' | 'backOver' | 'out' | 'backOut';
export type MoveDecision = 'execute' | 'replay';

/** At the frontier of a paused debug run a forward move executes; everywhere else it replays the recording. */
export function decideMove(state: DebugState, nav: { active: boolean; currentStep: number }, kind: NavigatorMoveKind): MoveDecision {
  const forward = kind === 'into' || kind === 'over' || kind === 'out';
  if (forward && state.paused && state.frontier !== undefined && nav.active && nav.currentStep === state.frontier) return 'execute';
  return 'replay';
}

export function atFrontier(state: DebugState, nav: { active: boolean; currentStep: number }): boolean {
  return !!state.paused && state.frontier !== undefined && nav.active && nav.currentStep === state.frontier;
}

/* ---------- runs ---------- */

/** Run reasons that nobody asked for by name: they must not kill a debug run that is paused or running. */
export const IMPLICIT_RUN_REASONS: ReadonlySet<string> = new Set(['edit', 'save', 'mode', 'autoLog', 'libraryCode', 'recordLocals', 'maskSecrets', 'marker', 'logpoints', 'evaluate', 'watch', 'hover', 'install', 'dependency', 'restart', 'time-machine']);

/** True when `reason` would start a run while a debug run is in flight, which would kill it. */
export function blocksRun(state: DebugState, running: boolean, reason: string): boolean {
  return state.active && running && IMPLICIT_RUN_REASONS.has(reason);
}
