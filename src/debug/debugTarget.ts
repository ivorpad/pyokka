/**
 * One shape for both products (docs/design/debugger-product.md, 3.6): a `record: false`
 * `DebugSession` and a recording run-all `Session` in debug mode look the same to the DAP
 * translator, the agent bridge and the panel. `wrapDebugSession` is the debug half;
 * `wrapSession` in dapAdapter.ts is the run-all half.
 *
 * vscode-free at runtime (`DebugSession` is a type import), so vitest can build a fake target.
 */
import type { Completions, RunFinishedEvent, ValueBag, ValueNode } from '../shared/protocol';
import type { BreakpointSpec, BreakWatchSpec, DebugBreakpointEcho, DebugState, ExceptionMode, LocalVar, PausedInfo, PausedThread, StepKind } from '../session/debugState';
import type { LaunchConfig } from './debugSessionState';
import type { ExecResult } from './debugExec';
import type { DebugSession } from './debugSession';
import type { ReplayFrame, ReplayVar } from '../session/replayFrames';

export type { ExecResult } from './debugExec';

/** a Time Machine move; the same names as navigator.ts `MoveKind` */
export type ReplayMove = 'into' | 'back' | 'over' | 'backOver' | 'out' | 'backOut';

/**
 * What a move asked of the Time Machine did: `moved` to another recorded step, `executed` at the
 * frontier of a paused debug run (the program takes the step and its own pause follows), or
 * `none` at a dead end.
 */
export type ReplayOutcome = 'moved' | 'executed' | 'none';

/**
 * The Time Machine over a recording, as the DAP translator sees it (docs/PROTOCOL.md, "Replay
 * debug session"). A run-all session has one: a replay of a finished run, or a recording debug
 * run, where the moves behind the frontier replay and the ones at it execute.
 */
export interface ReplaySource {
  /** the Time Machine is navigating this recording */
  readonly active: boolean;
  /** the step it shows; -1 while inactive */
  readonly step: number;
  /** the call stack at the step, innermost first */
  frames(): ReplayFrame[];
  /** the variables of frame `index` (innermost 0) as the recording knows them at the step */
  variables(index: number): ReplayVar[];
  move(kind: ReplayMove): ReplayOutcome;
  /** to the next (or previous) step on an enabled breakpoint; else to the frontier or the last step forward, the first recorded step backward */
  toBreakpoint(backward: boolean): ReplayOutcome;
  /** to a recorded step; step 0 is the first one recorded, which is not the program's first statement when the recording started mid-program */
  goto(step: number): void;
  /** the Time Machine moved, started or stopped (the session's `navChanged`) */
  onChanged(fn: () => void): () => void;
}

export interface DebugTarget {
  readonly id: string;
  /** a `DebugSession`, or a run-all `Session` in debug mode */
  readonly kind: 'debug' | 'run';
  readonly displayName: string;
  readonly record: boolean;
  /** undefined for a run-all recording run: it has a document, not a launch configuration */
  readonly launch: LaunchConfig | undefined;
  readonly debug: DebugState;
  readonly running: boolean;
  readonly output: string;
  readonly modified: boolean;
  readonly thread: PausedThread | undefined;
  /** the recording this target can replay; absent for a `record: false` session */
  readonly replay?: ReplaySource;
  /** a replay of a finished run: no program to start, pause or step, only the recording */
  readonly replayOnly?: boolean;

  /** a debug run; `stopOnEntry` pauses before the first statement, else it runs to the first breakpoint */
  startDebug(opts?: { stopOnEntry?: boolean }): Promise<void>;
  stopDebug(): void;
  /** stop the run and start a fresh one of the same program, inside this debug session */
  restart(opts: { stopOnEntry?: boolean }): Promise<void>;
  /** end the run and leave debug mode */
  terminate(): void;

  /** resume; whether the caller waits for the next stop is the caller's business (`noWait` on the wire) */
  debugContinue(): Promise<void>;
  debugStep(kind: StepKind): Promise<void>;
  debugPause(): Promise<void>;
  debugLocals(opts?: { frameId?: number }): Promise<LocalVar[]>;
  /** side-effect-free, in the frame `frameId` names (innermost by default); undefined when it cannot answer */
  evaluate(expression: string, opts?: { frameId?: number }): Promise<{ text: string; valueBag?: ValueBag } | undefined>;
  /**
   * Run a statement in the paused frame: the Debug Console's `context: "repl"`, `setVariable`, and
   * the bridge's `exec`. Everything else (hovers, displayed watches, break-when watches, `eval`,
   * completions, `shadow`) stays on `evaluate`, which is pure.
   */
  exec(source: string, opts?: { frameId?: number }): Promise<ExecResult>;
  /** what the expression typed so far could continue with; empty when there is nothing to ask */
  complete(text: string): Promise<Completions>;
  /** the load-action path of the Value Explorer; undefined when there is no run to ask */
  expand(valueId: string, queryPath: string[]): Promise<ValueNode | undefined>;

  setDebugBreakpoints(specs: BreakpointSpec[]): Promise<DebugBreakpointEcho[]>;
  setDebugWatches(specs: BreakWatchSpec[]): Promise<void>;
  /** where an exception pauses the run: the Breakpoints view's checkboxes */
  setDebugExceptions(mode: ExceptionMode): Promise<void>;
  runToLine(path: string, line: number): Promise<void>;

  pathForFileId(fileId: number): string | undefined;
  /** a statement id's file and first line (a scope's `def` header) */
  locate(rid: number): { path: string; line: number } | undefined;

  onPaused(fn: (info: PausedInfo) => void): () => void;
  onResumed(fn: () => void): () => void;
  onFinished(fn: (exitCode: number | null) => void): () => void;
  waitForPause(timeoutMs?: number): Promise<PausedInfo | 'finished'>;
}

/** The facade over a `record: false` debug session. */
export function wrapDebugSession(ds: DebugSession): DebugTarget {
  return {
    id: ds.id,
    kind: 'debug',
    get displayName() {
      return ds.displayName;
    },
    get record() {
      return ds.launch.record;
    },
    get launch() {
      return ds.launch;
    },
    get debug() {
      return ds.debug;
    },
    get running() {
      return ds.running;
    },
    get output() {
      return ds.output;
    },
    get modified() {
      return ds.modified;
    },
    get thread() {
      return ds.thread;
    },
    startDebug: (opts) => ds.startDebug(opts),
    stopDebug: () => ds.stopDebug(),
    restart: (opts) => ds.restart(opts),
    terminate: () => ds.terminate(),
    debugContinue: () => ds.debugContinue(),
    debugStep: (kind) => ds.debugStep(kind),
    debugPause: () => ds.debugPause(),
    debugLocals: (opts) => ds.debugLocals(opts),
    evaluate: (expression, opts) => ds.evaluate(expression, opts),
    exec: (source, opts) => ds.exec(source, opts),
    complete: (text) => ds.complete(text),
    expand: (valueId, queryPath) => ds.expand(valueId, queryPath),
    setDebugBreakpoints: (specs) => ds.setDebugBreakpoints(specs),
    setDebugWatches: (specs) => ds.setDebugWatches(specs),
    setDebugExceptions: (mode) => ds.setDebugExceptions(mode),
    runToLine: (p, line) => ds.runToLine(p, line),
    pathForFileId: (fileId) => ds.pathForFileId(fileId),
    locate: (rid) => ds.locate(rid),
    onPaused: (fn) => {
      ds.on('paused', fn);
      return () => ds.off('paused', fn);
    },
    onResumed: (fn) => {
      ds.on('resumed', fn);
      return () => ds.off('resumed', fn);
    },
    onFinished: (fn) => {
      // a restart replaces the child inside this session: its finish must not end the debug session
      const finished = (ev: RunFinishedEvent): void => {
        if (!ds.isRestarting) fn(ev.exitCode);
      };
      // the runner can go without a `run.finished`; `ended` then reports what the session knows
      const ended = (): void => fn(ds.lastFinished ? ds.lastFinished.exitCode : null);
      ds.on('finished', finished);
      ds.once('ended', ended);
      return () => {
        ds.off('finished', finished);
        ds.off('ended', ended);
      };
    },
    waitForPause: (timeoutMs) => ds.waitForPause(timeoutMs),
  };
}
