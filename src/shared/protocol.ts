/**
 * Types for the extension host <-> Python runner NDJSON protocol.
 * Source of truth: docs/PROTOCOL.md. Keep both in sync.
 */

/** [startLine (1-based), startCol (0-based), endLine, endCol] */
export type Range4 = [number, number, number, number];

export type RunMode = 'normal' | 'profile' | 'snaps';

export interface LogLimits {
  inline: { depth: number; elements: number };
  values: {
    default: { stringLength: number };
    autoExpand: { depth: number; elements: number; stringLength: number };
  };
}

/** the HTTP layer of a run: `record` writes every exchange down, `replay` answers from the recording and never touches the network */
export type HttpMode = 'off' | 'record' | 'replay';

export interface RunConfig {
  logLimit: number;
  maxConsoleMessages: number;
  logLimits: LogLimits;
  maxLogEntrySize: number;
  resolveGetters: boolean;
  autoLog: boolean;
  maxTraceSteps: number;
  timeoutMs: number;
  recordLocals: boolean;
  /** instrument third-party packages so the Time Machine can step into them (never the stdlib) */
  libraryCode: boolean;
  /** when non-empty, only these top-level names / dotted globs */
  libraryPackages: string[];
  /** leave these modules or paths out of the recording (dotted names or path globs): they run at full speed, unrecorded */
  exclude?: string[];
  /** characters one recorded value keeps; unset 120 for a local and 200 for a logged value, 0 the 1,000,000 ceiling */
  maxValueChars?: number;
  hints: { ignoreCoverage: string; ignoreCoverageForFile: string };
  plugins: string[];
  /** mask API keys / passwords / tokens by provenance (secret-looking env vars and names); `names` adds words */
  secrets: { mask: boolean; names: string[] };
  /** record the run's HTTP exchanges to the workspace's replay file, or answer every request from it (see "HTTP record and replay") */
  http: HttpMode;
  /** observe the HTTP clients in every run (one `http.exchange` row per request); false leaves them untouched: no rows, no HTTP view */
  httpObserve: boolean;
  /** start paused at the first statement; the run can then pause, step and break (the `debug` request) */
  debug?: boolean;
  /**
   * Record the run (default true), read only when `debug` is true. `false` is the Debugger: the
   * program runs at full speed and only the pauses and its output come back, so there is no trace,
   * no coverage, no locals and no Time Machine (see docs/PROTOCOL.md, `config.record`).
   */
  record?: boolean;
  /** with `debug`: pause before the first statement (the default); false runs to the first breakpoint, or the end */
  stopOnEntry?: boolean;
  /** with `debug`: where an exception pauses the run (default `uncaught`: only one nobody caught, at the top) */
  breakOnException?: DebugExceptionMode;
  /**
   * With `debug` and `record`: run with the debugger's hooks and record from a pause on (the
   * runtime's `recordFrom` capability). `'pause'` is the first pause; a function or a line is the
   * first pause there. The paused statement becomes step 0 and every `trace` event carries `midRun`.
   */
  recordFrom?: RecordFromSpec;
}

/** Where a `recordFrom` run starts recording (`RunConfig.recordFrom`). */
export type RecordFromSpec = 'pause' | { function: string } | { path: string; line: number };

export type MarkerKind = 'value' | 'time' | 'logpoint';

export interface Marker {
  id: string;
  kind: MarkerKind;
  range: Range4;
  /** expression text to evaluate instead of the source range (watch-style) */
  exp?: string | null;
  autoExpand?: boolean;
  context?: string;
  changeId?: string;
  /** logpoints: VS Code logMessage with {expr} interpolations */
  logMessage?: string;
}

export interface WatchRequest {
  id: string;
  exp: string;
  range?: Range4;
}

export interface ExpansionTree {
  [queryPathSegment: string]: ExpansionTree;
}

export interface RunRequest {
  type: 'run';
  id: number;
  runId: string;
  /** the program; exactly one of `file` and `module`. `content` absent means "read it from disk" */
  file?: { path: string; displayName: string; content?: string };
  /** a dotted module name run like `python -m` (a debug launch); mutually exclusive with `file` */
  module?: string;
  workspaceRoot: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  projectFiles: { path: string; content: string }[];
  config: RunConfig;
  markers: Marker[];
  expressionsToEvaluate: Record<string, ExpansionTree>;
  watch: WatchRequest[];
  traceContext?: { step: number; prefetch: number };
  /** pause here; resolved to statements when their file is instrumented (a debug run) */
  breakpoints?: DebugBreakpointSpec[];
  mode: RunMode;
}

/* ---------- the debugger: pause at the frontier (docs/PROTOCOL.md `debug`, `debug.paused`) ---------- */

export type DebugStepKind = 'into' | 'over' | 'out';
export type DebugAction = 'continue' | 'step' | 'pause' | 'breakpoints' | 'watches' | 'locals' | 'exceptions' | 'record';

/** where an exception pauses a debug run: never, at the top of one nobody caught, at every raise in user code */
export type DebugExceptionMode = 'off' | 'uncaught' | 'raised';

/**
 * Where a debug run pauses. Two shapes in one type: a line breakpoint (`path` and `line`), and a
 * function's entry (`function`, optionally narrowed by `path`), which the runtime resolves from its
 * rid-to-name table so a module imported later gets its breakpoint when it loads.
 */
export interface DebugBreakpointSpec {
  /** absent on a function breakpoint that names no file */
  path?: string;
  /** absent on a function breakpoint */
  line?: number;
  condition?: string;
  /** a function's entry: a bare name, or `Class.method` */
  function?: string;
}

/** a watch that pauses the run: when its text changes, or when it turns true */
export interface DebugWatchSpec {
  id: string;
  exp: string;
  breakWhen: 'change' | 'true';
}

export interface DebugRequest {
  type: 'debug';
  id: number;
  runId: string;
  action: DebugAction;
  kind?: DebugStepKind;
  set?: DebugBreakpointSpec[] | DebugWatchSpec[];
  /** with action `exceptions`: the mode for the run in flight */
  mode?: DebugExceptionMode;
  /** with action `locals`: which frame of the pause, innermost 0; absent means 0 */
  frameId?: number;
}

/** One completion for a watch expression (`complete` reply, DAP `completions`, the panel's dropdown). */
export type CompletionKind = 'variable' | 'attribute' | 'function' | 'method' | 'property' | 'class' | 'module' | 'builtin' | 'keyword';
export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** the value's type name for a variable or attribute */
  type?: string;
}
export interface Completions {
  /** the identifier being typed, which a chosen label replaces */
  prefix: string;
  items: CompletionItem[];
  /** why the object before the dot could not be evaluated (then `items` is empty) */
  error?: string;
}

export type HostRequest =
  | { type: 'hello'; id: number; version: string }
  | RunRequest
  | { type: 'expand'; id: number; runId: string; valueId: string; queryPath: string[] }
  | { type: 'evaluate'; id: number; runId: string; expression: string; frameId?: number }
  /** run a statement in the paused frame (docs/design/debugger-product.md, 2.7); paused runs only */
  | { type: 'exec'; id: number; runId: string; source: string; frameId?: number }
  | { type: 'complete'; id: number; runId: string; expression: string; limit?: number }
  | { type: 'shadow'; id: number; runId: string; source: string }
  | { type: 'source'; id: number; runId: string; fileId: number }
  | { type: 'bindings'; id: number; source: string }
  | DebugRequest
  | { type: 'stop'; id: number; runId: string }
  | { type: 'shutdown'; id: number };

/* ---------- variable history (bridge `var` reply, `pyokka var --json`, the panel's Variable pane) ---------- */

export type VariableChangeSource = 'locals' | 'value' | 'assign';

export interface VariableRead {
  name: string;
  /** absent when no value of the name was recorded before the step */
  text?: string;
  /** the step whose statement recorded `text` */
  step?: number;
}

export interface VariableChange {
  /** the step of the statement that made the change (Time Machine target) */
  step: number;
  /** absolute path on the wire; the panel receives the display path */
  file: string;
  fileId: number;
  line: number;
  function: string;
  scopeId: number;
  /** the matched name: the query itself, or a path under or above it (`acct.deposit(x)` for `acct`) */
  name: string;
  /** the new value; absent for `assign` rows (the statement ran, nothing recorded the value) */
  text?: string;
  source: VariableChangeSource;
  /** `assign` rows: the statement ran and the scope's next step observed no change, so `text` is the value it kept */
  unchanged?: boolean;
  /** the log entry behind a `value` row */
  logId?: string;
  /** names the statement read, with their latest recorded value before the step */
  reads?: VariableRead[];
}

export interface VariableHistory {
  name: string;
  changes: VariableChange[];
  total: number;
  truncated: boolean;
  /** the run recorded locals (`recordLocals`); without them only logged values and assignment sites are known */
  recordedLocals: boolean;
}

/** What one statement assigns and reads, from the AST of its file (`bindings` reply); positions as in the range table. */
export interface StatementBinding {
  line: number;
  col: number;
  /** names or attribute paths bound when the statement executes (`def`: its parameters) */
  assigns: string[];
  /** names loaded by the statement's header, builtins excluded */
  reads: string[];
  /** loop headers only: the loop's last line (the header steps once before the loop and once per iteration) */
  loop?: number;
  /** the calls the statement's header makes: the source text of each `Call`, outermost first, at most 8 of at most 80 characters; absent when none */
  calls?: string[];
}

/* ---------- provenance (bridge `why` reply, `pyokka why --json`, the Details pane's "why" tree) ---------- */

/** levels below the root expanded by default, and the most a query may ask for */
export const PROVENANCE_DEPTH = 5;
export const PROVENANCE_MAX_DEPTH = 8;
/** nodes in one tree at most; `truncated` says when the budget cut */
export const PROVENANCE_NODES = 60;

/** A function the producing statement called whose body was stepped (the walkthrough's call moment, in short). */
export interface ProvenanceCall {
  /** the scope's name */
  name: string;
  scopeId: number;
  /** the scope's first and last step */
  entryStep: number;
  returnStep: number;
  /** the `def` header (absolute path on the wire; the panel receives the display path) */
  file: string;
  fileId: number;
  line: number;
  /** the arguments as the walkthrough's call moment lists them (`self`/`cls` left out), at most 8 */
  inputs: { name: string; text: string }[];
  /** the value the call produced, as the walkthrough's call moment reports it (`out`), when any */
  result?: string;
}

/**
 * One value in the tree: a name, what it was, and the statement that made it with that statement's
 * inputs. A node without `step` is a leaf (nothing recorded); one with `cut` was not expanded
 * (the depth or the node budget) and has no `reads`, `calls` or `opaque`.
 */
export interface ProvenanceNode {
  /** the name (or attribute path); empty for the root of a "why this statement" query */
  name: string;
  /** the value, when recorded */
  text?: string;
  /** how the value is known: a recorded local, a logged value, or an assignment with no recorded value */
  source?: VariableChangeSource;
  /** the log entry behind a `value` node */
  logId?: string;
  /** an `assign` node whose statement left the value as it was (see `VariableChange.unchanged`) */
  unchanged?: boolean;
  /** the step of the producing statement (Time Machine target); absent for a leaf */
  step?: number;
  /** the producing statement's location, as a `VariableChange` (absolute path on the wire; display path in the panel) */
  file?: string;
  fileId?: number;
  line?: number;
  function?: string;
  scopeId?: number;
  /** the producing statement's first source line, trimmed, ` …` appended when it spans more lines; absent without the source */
  statement?: string;
  /** the names the statement read, each resolved to the value it had and expanded in turn */
  reads?: ProvenanceNode[];
  /** the functions the statement called whose body was stepped */
  calls?: ProvenanceCall[];
  /** the calls the statement makes per the AST that no stepped scope claimed (builtins, library code not stepped, dataclass constructors) */
  opaque?: string[];
  /** not expanded: the last level, or the node budget */
  cut?: boolean;
  /** a leaf of a recording that began mid-run (`recordFrom`): the value was made before step 0, where nothing was recorded */
  beforeRecording?: boolean;
}

export interface Provenance {
  /** the queried name ('' for a statement query) */
  name: string;
  /** the queried step */
  step: number;
  /** levels below the root that were expanded */
  depth: number;
  /** nodes in the tree */
  nodes: number;
  /** the node budget cut something */
  truncated: boolean;
  recordedLocals: boolean;
  root: ProvenanceNode;
  /** the answer in words, built from the root and its first level; '' when nothing was recorded (see `provenanceConclusion`) */
  conclusion?: string;
}

/* ---------- HTTP table (bridge `http` reply, `pyokka http`, the panel's HTTP view) ---------- */

/** where a row's response came from: the network (`live` while observing, `recorded` in record mode), the recording, or nowhere */
export type HttpSource = 'live' | 'recorded' | 'replayed' | 'miss';

/** The HTTP layer's tally in `run.finished.http`, for every run the plugin observed. */
export interface HttpSummary {
  mode: HttpMode;
  /** `http.exchange` rows emitted */
  requests: number;
  /** exchanges written to the recording */
  recorded: number;
  /** responses answered from the recording */
  served: number;
  /** distinct request keys without a recorded response */
  misses: number;
  /** the recording found for the source file, or the path a record run would write; null when none applies */
  file: string | null;
  /** the recording is on disk after the run */
  exists: boolean;
  /** its header's timestamp (ISO, UTC) and its number of exchanges; null when absent */
  recordedAt: string | null;
  entries: number | null;
}

export interface HttpTableRow {
  n: number;
  client: string;
  method: string;
  /** query values stripped by the runtime; redacted again before it leaves the process */
  url: string;
  /** the URL's last non-empty path segment, else its host, cut at 60 characters */
  name: string;
  /** both null for a miss */
  status: number | null;
  reason: string | null;
  /** response body bytes; null when unknown */
  bytes: number | null;
  ms: number;
  /** replayed rows: the recording's elapsedMs */
  recordedMs: number | null;
  source: HttpSource;
  /** the Time Machine's target; -1 when no user statement was running */
  step: number;
  /** the innermost user statement running when the request started; absolute path on the wire, a display path in the panel */
  location: { file: string; line: number; col: number; fileId: number } | null;
}

export interface HttpTable {
  runId: string;
  /** the run is in flight: the rows are the ones so far */
  running: boolean;
  /** rows in the run (the list holds at most the cap) */
  count: number;
  truncated: boolean;
  totals: { requests: number; bytes: number; ms: number; misses: number; missAttempts: number };
  /** `run.finished.http`; null while the run is in flight or when the clients were not observed */
  finished: HttpSummary | null;
  requests: HttpTableRow[];
}

/* ---------- runner -> host ---------- */

export type ValueType =
  | 'str' | 'number' | 'bool' | 'None' | 'list' | 'tuple' | 'dict' | 'set' | 'frozenset'
  | 'bytes' | 'function' | 'class' | 'module' | (string & {});

export interface ValueNode {
  type: ValueType;
  value?: string;
  length?: number;
  capped?: string | boolean;
  cappedProps?: boolean;
  cappedElements?: boolean;
  props?: ValueProp[];
  id: string;
  queryPath: string[];
  expressionPath?: string;
  expandable?: boolean;
  circular?: boolean;
  nan?: boolean;
  positiveInfinity?: boolean;
  negativeInfinity?: boolean;
  loadActionNode?: boolean;
  /** the value was masked by the runtime (secret name or a secret-looking environment value) */
  secret?: boolean;
}

export interface ValueProp extends ValueNode {
  name: string;
  /** Python repr of the key when the container is a dict with non-str keys */
  keyRepr?: string;
}

export interface ValueBag {
  data: ValueNode;
  runtimeKey: string;
}

export type LogKind = 'log' | 'value' | 'autoLog' | 'autoExpand' | 'time' | 'logpoint' | 'system' | 'error';

export interface RunEventBase {
  runId: string;
  seq: number;
}

export interface FileInstrumentedEvent extends RunEventBase {
  type: 'file.instrumented';
  fileId: number;
  path: string;
  rangeBase: number;
  ranges: Range4[];
  statements: number[];
  functions: { rid: number; name: string; bodyRange: Range4 }[];
  magic: { rid: number; kind: 'value' | 'time' | 'autoExpand' | 'timeAutoExpand' }[];
  /** absent for library files (4-8 MB per run for openai): the `source` request serves it on demand */
  instrumentedSource?: string;
  /** time spent instrumenting or loading this file from the cache; the runner keeps it out of `timeoutMs` */
  instrumentMs?: number;
}

export interface OutputEvent extends RunEventBase {
  type: 'output';
  stream: 'stdout' | 'stderr';
  text: string;
  step?: number;
}

export interface LogEvent extends RunEventBase {
  type: 'log';
  logId: string;
  kind: LogKind;
  fileId: number;
  rid: number;
  hit: number;
  step: number;
  context?: string;
  text: string;
  runtimeKey: string;
  changeId?: string;
  markerId?: string;
  valueBag?: ValueBag;
  /** timing logs */
  time?: { n: number; total: number; min: number; max: number };
  /** host-only: line of a synthetic (live / shadow) entry that has no range id */
  liveLine?: number;
}

export interface StackFrame {
  fileId: number;
  line: number;
  col: number;
  rid?: number;
  function: string;
}

/** Where a caught exception was finally handled (docs/PROTOCOL.md, `error`): the matching `except` clause, or the `with` whose `__exit__` swallowed it. */
export interface HandledAt {
  fileId: number;
  /** the clause's (or the `with` statement's) own line */
  line: number;
  /** the statement that owns the clause: the `try` or the `with` */
  rid: number;
  /** the handler frame's `co_name`, `<module>` at top level */
  function: string;
  /** a bare `except:`, or a clause whose type is `Exception` / `BaseException` (alone or in a tuple) */
  broad: boolean;
}

export interface ErrorEvent extends RunEventBase {
  type: 'error';
  fileId: number;
  rid: number;
  /** the (first) raise's step */
  step: number;
  message: string;
  errorType: string;
  stack: StackFrame[];
  handled: boolean;
  /** caught exceptions: where; absent when caught outside instrumented code (C code, the stdlib, an unstepped library) */
  handledAt?: HandledAt;
  /** caught exceptions: exception objects this event stands for (same type, origin and handler), and the last one's step */
  count?: number;
  lastStep?: number;
  /** the uncaught exception only: the formatted traceback (last 4000 chars) */
  traceback?: string;
}

/** coverage state per local range id */
export const enum CoverageState {
  NotRun = 0,
  Covered = 1,
  Partial = 2,
  ErrorSource = 3,
  ErrorPath = 4,
}

export interface CoverageEvent extends RunEventBase {
  type: 'coverage';
  fileId: number;
  states: number[];
  hits: number[];
}

export interface TimeEvent extends RunEventBase {
  type: 'time';
  rid: number;
  n: number;
  total: number;
  min: number;
  max: number;
}

export const enum StepFlag {
  Log = 1,
  Error = 2,
  ScopeEntry = 4,
  NoCodeMapping = 8,
  Unwinding = 16,
}

export interface TraceScope {
  scopeId: number;
  rid: number;
  name: string;
  parent: number;
  depth: number;
  first: number;
  last: number;
  /** What the function returned, as text (short repr, secrets masked), recorded at its exit; null when the body ran off its end. */
  returned?: string | null;
  /** `returned` was cut at `maxValueChars` and ends in `…(+N chars)` or `…(cut)`. */
  returnedTruncated?: boolean;
  /** The full repr's length of a cut `returned`, when known. */
  returnedLength?: number;
  /** The exception type the function left by, when it returned nothing. */
  raised?: string;
}

export interface TraceEvent extends RunEventBase {
  type: 'trace';
  /** base64 of Int32Array quads [rid, scopeId, depth, flags] */
  steps: string;
  scopes: TraceScope[];
  truncated: boolean;
  /**
   * mid-run delta: steps cover `offset..` and `scopes` holds only the scopes created since the
   * previous delta (`last` of earlier scopes is derived from the steps, see PartialScopes); the
   * final event has no `partial` and is authoritative
   */
  partial?: boolean;
  offset?: number;
  /** the recording began at a pause (`recordFrom`): step 0 is that pause, and nothing before it was recorded */
  midRun?: boolean;
  /** final event of a run cut at `maxTraceSteps`: the cap, the steps the program ran, and the files that ran most of them */
  cap?: number;
  stepsRun?: number;
  spentBy?: TraceSpent[];
}

/** One file's share of a capped run: statement hits over the whole run. */
export interface TraceSpent {
  path: string;
  steps: number;
}

/** What the step cap cut from a run (`TraceEvent` with `truncated`). */
export interface TraceCap {
  cap: number;
  stepsRun?: number;
  spentBy: TraceSpent[];
  /** what to exclude to leave out the busiest file that is not the program (set once paths are displayed) */
  exclude?: string;
}

export interface LocalsEvent extends RunEventBase {
  type: 'locals';
  entries: { step: number; scopeId: number; changes: { name: string; text: string }[] }[];
}

/** `locals` entries the runtime records per run at most; past the cap "no change recorded" stops meaning "unchanged" */
export const MAX_LOCALS_ENTRIES = 100_000;

export interface WatchEvent extends RunEventBase {
  type: 'watch';
  watchId: string;
  step: number;
  valueBag?: ValueBag;
  error?: string;
}

/** a debug run stopped at its frontier, before the statement at `step` executes (the recording so far went out first) */
export interface DebugPausedEvent extends RunEventBase {
  type: 'debug.paused';
  step: number;
  rid: number;
  fileId: number;
  line: number | null;
  scopeId: number;
  depth: number;
  reason: 'start' | 'breakpoint' | 'step' | 'watch' | 'pause' | 'exception';
  kind?: DebugStepKind;
  breakpoint?: DebugBreakpointSpec & { rid?: number; fileId?: number; resolvedLine?: number; error?: string };
  conditionError?: string;
  watch?: { id: string; exp: string; text: string };
  /** with reason `exception`: what was raised at this statement, and whether it reached the top */
  exception?: { type: string; message: string; uncaught: boolean };
  /** the thread being served: `threading.current_thread().name` and `threading.get_ident()` */
  thread?: { name: string; ident: number };
  /** an `exec` or a `setVariable` has written in this run; absent while false */
  modified?: boolean;
  /** the recording started at this pause (`recordFrom`, or the `record` action): this is step 0 */
  recordingStarted?: boolean;
  /**
   * Innermost first. Two shapes in one array: a recording run sends the scope chain
   * (`{scopeId, name, rid, depth}`), a `record: false` run the frame chain with real caller lines
   * (`{frameId, name, fileId, line}`, `fileId: 0` and no `rid` for an uninstrumented frame).
   */
  stack: { frameId?: number; scopeId?: number; name: string; rid?: number; depth?: number; fileId?: number; line?: number }[];
}

export interface DebugResumedEvent extends RunEventBase {
  type: 'debug.resumed';
  step: number;
  action: 'continue' | 'step';
  kind?: DebugStepKind;
}

export interface RunStartedEvent extends RunEventBase {
  type: 'run.started';
  pid: number;
}

/** One HTTP request the program made, emitted when the exchange completes (see "HTTP record and replay", Rows). */
export interface HttpExchangeEvent extends RunEventBase {
  type: 'http.exchange';
  /** request order in the run; in record mode the recording line's n */
  n: number;
  /** httpx | requests | http.client */
  client: string;
  method: string;
  /** query values stripped: names stay, values go */
  url: string;
  /** both null for a miss */
  status: number | null;
  reason: string | null;
  /** response body bytes as the client layer received them; null when unknown */
  bytes: number | null;
  /** request start to body complete (live, recorded); to answered (replayed, miss) */
  ms: number;
  /** replayed rows only: the recording's elapsedMs */
  recordedMs?: number;
  source: HttpSource;
  /** the innermost user statement running when the request started, and its most recent step; -1 when none */
  rid: number;
  step: number;
}

export interface RunFinishedEvent extends RunEventBase {
  type: 'run.finished';
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stopped: boolean;
  stepCount: number;
  logCount: number;
  /** the run answered HTTP from a recording (`config.http` was `replay`) */
  replayed?: true;
  /** the HTTP layer's tally for every observed run; absent when `httpObserve` is off (or the plugin never ran) */
  http?: HttpSummary;
}

export type RunEvent =
  | RunStartedEvent
  | FileInstrumentedEvent
  | OutputEvent
  | LogEvent
  | ErrorEvent
  | CoverageEvent
  | TimeEvent
  | TraceEvent
  | LocalsEvent
  | WatchEvent
  | HttpExchangeEvent
  | DebugPausedEvent
  | DebugResumedEvent
  | RunFinishedEvent;

export type RunnerMessage =
  | RunEvent
  | { type: 'ready'; id: number; pythonVersion: string; executable: string; platform: string; capabilities: string[]; runtimeVersion?: string }
  | { type: 'ok'; id: number }
  | { type: 'value'; id: number; node: ValueNode }
  | { type: 'evaluated'; id: number; text: string; valueBag: ValueBag; kind?: LogKind; context?: string }
  /** an `exec` ran: `text` is the last expression statement's value (else ''), and the frame may have been written */
  | { type: 'executed'; id: number; text: string; modified: boolean; valueBag?: ValueBag; exception?: { type: string; message: string; traceback?: string } }
  | ({ type: 'completed'; id: number } & Completions)
  | { type: 'source'; id: number; fileId: number; instrumentedSource?: string | null }
  | { type: 'bindings'; id: number; statements: StatementBinding[] }
  | ({ type: 'debug.result'; id: number } & Record<string, unknown>)
  | { type: 'error'; id: number; message: string }
  | { type: 'runner.error'; message: string; detail?: string };

/** Decode a `trace.steps` payload into a flat Int32Array of quads. */
export function decodeSteps(b64: string): Int32Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
