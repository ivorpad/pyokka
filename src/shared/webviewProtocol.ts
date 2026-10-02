/**
 * Messages between the extension host and the Pyokka panel webview.
 * Host -> webview: `HostToWebview`; webview -> host: `WebviewToHost`.
 * The webview is a pure view: all state it renders is pushed by the host.
 */
import type { CompletionItem, LogEvent, ErrorEvent, HttpMode, HttpTable, TraceCap, TraceScope, ValueNode, ValueBag, StackFrame, VariableHistory, Provenance } from './protocol';
import type { ExecutionGraph } from '../session/executionGraphTypes';
import type { GraphPhase } from '../session/executionGraphPhases';
import type { ExceptionReport } from '../session/exceptionReportTypes';

export type { HttpTable, HttpTableRow } from './protocol';

/**
 * The panel's views. `'debugger'` is the Time Machine (its `DebugStatus` header and
 * `FrontierLocals` serve a recording debug run); `'debug'` is the Debugger view, the live
 * `record: false` session. The two names are confusing and stay: renaming `'debugger'` would touch
 * every panel path for no user-visible gain.
 */
export type ViewId = 'output' | 'debugger' | 'settings' | 'diagram' | 'diff' | 'variable' | 'run-diagram' | 'http' | 'debug';

/** The HTTP view's table: the wire shape with a display path in every `location.file`. */
export type HttpPanel = HttpTable;

export interface PanelEntry {
  logId: string;
  kind: LogEvent['kind'];
  fileId: number;
  file: string;          // display path
  line: number;
  col: number;
  rid: number;
  hit: number;
  step: number;
  context?: string;
  text: string;
  runtimeKey: string;
  valueBag?: ValueBag;
  isError?: boolean;
  time?: LogEvent['time'];
}

export interface PanelSettings {
  autoLog: boolean;
  valuePeek: boolean;
  showValueOnSelection: boolean;
  showSingleInlineValue: boolean;
  runMode: 'auto' | 'onSave' | 'onDemand';
  /** step into third-party packages (session toggle; needs a run) */
  libraryCode: boolean;
  /** mask API keys / passwords / tokens in reported values (session toggle; needs a run) */
  maskSecrets: boolean;
  /** kill a run after this many milliseconds, 0 = no limit (session value; applies to the next run) */
  runTimeoutMs: number;
  /** record every changed local at every step, the Variable pane's first source (session toggle; needs a run) */
  recordLocals: boolean;
  /** record the next run's HTTP exchanges, or answer them from the recording (session value; applies to the next run, never starts one) */
  http: HttpMode;
  /** the Execution Diagram's first level of detail: the cards only, or every statement (`pyokka.diagram.detail`) */
  diagramDetail: 'scopes' | 'statements';
  /** draw the Execution Diagram's data edges (`pyokka.diagram.dataEdges`) */
  diagramDataEdges: boolean;
}

/** The Variable pane's state: the queried name and what the host found for it. */
export interface VariableView {
  name: string;
  /** null while the host computes, or when there is no run yet (`error` says so) */
  history: VariableHistory | null;
  error?: string;
}

/**
 * The Details pane's "why" tree (docs/PROTOCOL.md, "Provenance"): the queried step and name
 * (empty name: the statement itself) and the host's answer, with display paths in every `file`.
 */
export interface WhyView {
  step: number;
  name: string;
  /** null while the host computes, or when there is no run yet (`error` says so) */
  tree: Provenance | null;
  error?: string;
}

export interface StepInfo {
  index: number;
  rid: number;
  fileId: number;
  line: number;
  col: number;
  scopeId: number;
  depth: number;
  flags: number;
}

export interface TimelineModel {
  stepCount: number;
  /** compact per-step arrays, same length as stepCount */
  scopeIds: number[];
  flags: number[];
  lines: number[];
  cols: number[];
  fileIds: number[];
  scopes: TraceScope[];
  /** scopeId -> colour index into the Timeline Guide palette */
  functionColors: Record<number, number>;
  truncated: boolean;
  /** the step cap cut the recording: where, of how many, and the files that spent the steps */
  cap?: TraceCap;
  /** steps before this index cannot be navigated to (rendered as the hatched locked region); default 0 */
  lockedBefore?: number;
}

/** The frame that called the previewed step's function (Steps strip hover). */
export interface PreviewCaller {
  step: number;
  function: string;
  /** display path */
  file: string;
  line: number;
}

/**
 * The debugger (docs/HANDOFF-debugger.md) as the Time Machine view shows it: present while debug mode is
 * on. `paused` is the frontier: the run stopped before `frontier` executed, the frame there is live and
 * `locals` are its variables; `location` is a display path with the line. Reason detail for the header.
 */
export interface DebugPanelInfo {
  active: boolean;
  paused: boolean;
  frontier?: number;
  reason?: 'start' | 'breakpoint' | 'step' | 'watch' | 'pause' | 'exception';
  kind?: 'into' | 'over' | 'out';
  location?: string;
  breakpoint?: { line: number; condition?: string };
  conditionError?: string;
  watch?: { id: string; exp: string; text: string; breakWhen?: 'change' | 'true' };
  /** with reason `exception`: what was raised, and whether it reached the top */
  exception?: { type: string; message: string; uncaught: boolean };
  stack?: { name: string; scopeId: number; depth: number }[];
  locals?: { name: string; text: string; valueBag?: ValueBag }[];
}

/** One frame of the Debugger view's call stack; `file` is a display path. */
export interface DebugSessionFrame {
  frameId: number;
  name: string;
  file: string;
  line: number;
  /** the frame is not in an instrumented file of the run (a stdlib or library frame) */
  library?: boolean;
}

/** One row of the Debugger view's breakpoint list; `file` is a display path. */
export interface DebugSessionBreakpoint {
  file: string;
  line?: number;
  /** a function breakpoint (`--at NAME`, wave 2) */
  function?: string;
  resolvedLine?: number;
  /** the statement the runtime resolved it to; absent while it has not (the view mutes those) */
  rid?: number;
  condition?: string;
  error?: string | null;
}

/** One row of the Debugger view's watch list: a displayed value, or a watch that pauses the run. */
export interface DebugSessionWatch {
  id: string;
  exp: string;
  kind: 'display' | 'breakWhen';
  text?: string;
  breakWhen?: 'change' | 'true';
  error?: string;
}

/**
 * The Debugger view's whole state (docs/design/debugger-product.md, 5.2): one `record: false`
 * debug session, pushed on every change and on every `output` event (throttled). Every `file` is a
 * display path; `locals` rows are the value-table rows `FrontierLocals` already renders.
 */
/** One run of bytes the program printed, stamped with when it arrived (ms since the run started). */
export interface DebugOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
  t: number;
}

export interface DebugSessionPanel {
  id: string;
  displayName: string;
  launch: { program: string | null; module: string | null; args: string[]; cwd: string; python: string | null; record: boolean };
  /** the same command with every path absolute: the launch row's `title` */
  launchTitle: string;
  running: boolean;
  paused: boolean;
  record: boolean;
  /** an `exec` or a `setVariable` wrote: the values are no longer the program's own (wave 2) */
  modified: boolean;
  reason?: 'start' | 'breakpoint' | 'step' | 'watch' | 'pause' | 'exception';
  /** the reason in words, as the header prints it */
  reasonText: string;
  /** `app.py:42`, '' while the program runs */
  location: string;
  thread?: { name: string; ident: number };
  stack: DebugSessionFrame[];
  selectedFrame: number;
  locals: { name: string; text: string; valueBag?: ValueBag }[];
  watches: DebugSessionWatch[];
  /** the committed tail the host keeps (64 KB) as tagged chunks; afterwards only deltas */
  output: DebugOutputChunk[];
  /** the incomplete trailing line, sent whole every time so redaction never sees half a secret */
  outputOpen: DebugOutputChunk | null;
  /** the offset `output` ends at; a delta that does not start here means resync */
  outputSeq: number;
  /** bytes cut from the head of the window */
  outputDropped: number;
  /** ms since the run started; the view's elapsed clock counts on from it */
  elapsed: number;
  /** ms since the run started when the last byte arrived, null when nothing has printed */
  lastOutputAt: number | null;
  breakpoints: DebugSessionBreakpoint[];
  /** the run's instrumented files as display paths; a breakpoint in no other file can pause it */
  files: string[];
  exceptions: 'off' | 'uncaught' | 'raised';
  exception: { type: string; message: string; uncaught: boolean } | null;
}

export interface DebuggerState {
  active: boolean;
  autoPlaying: boolean;
  currentStep: number;
  canStep: { into: boolean; back: boolean; over: boolean; backOver: boolean; out: boolean; backOut: boolean };
  echoSteps: number[];
  callStack?: { frames: (StackFrame & { step: number; scopeId: number })[]; selected: number };
  showCallStack: boolean;
  codePreview: boolean;
  echo: boolean;
  /** `text` alone (no value bag) is a recorded variable's value as of the step, `note` where it was recorded; `needsRun` offers one run of the file to record the value */
  watches: { id: string; exp: string; valueBag?: ValueBag; text?: string; note?: string; error?: string; needsRun?: boolean; step?: number }[];
  locals?: { name: string; text: string }[];
  /** present while debug mode is on (DebugPanelInfo) */
  debug?: DebugPanelInfo;
}

/** One walkthrough moment as the panel shows it (docs/PROTOCOL.md, "Walkthrough"; `file` is a display path). */
export interface PanelMoment {
  id: string;
  kind: 'start' | 'end' | 'call' | 'tool' | 'decision' | 'value' | 'print' | 'error';
  step: number;
  fileId: number;
  file: string;
  line: number;
  function: string;
  text: string;
  values: { role: 'in' | 'out' | 'took' | 'value'; name: string; text: string }[];
  gloss: string | null;
  /** collapsed under the cap: this many more like it */
  more?: number;
  entryStep?: number;
  endStep?: number;
}

export interface WalkthroughPanel {
  runId: string;
  count: number;
  total: number;
  shown: number;
  truncated: boolean;
  moments: PanelMoment[];
  /** a narration request is in flight */
  narrating: boolean;
  /** the last narration of this run failed with this message */
  narrationError?: string;
  /** a backend exists (claude / codex on the PATH, the setting, or Copilot); the Narrate button is disabled otherwise */
  canNarrate: boolean;
}

/** One stop of the TOUR section: a `tour.json` candidate shaped for display (`file` is a display path). */
export interface PanelTourStop {
  id: string;
  /** the candidate's `key`: same statement, same key in a re-recorded run (resume matches on it) */
  key: string;
  step: number;
  chapter: string;
  /** -1 when the file is not in the run's table */
  fileId: number;
  file: string;
  line: number;
  function: string;
  /** the prose title when a narration was merged, else the first signal and the statement */
  title: string;
  /** the prose text, null before a narration */
  text: string | null;
  signal: string;
  statement: string;
  /** one value, cut to 80 characters, shown unfolded; null when the stop has none */
  short: string | null;
  /** every value of the stop, folded under the row */
  values: { role: string; name: string; text: string; cut: boolean }[];
  /** the slice of a long value the prose quotes, cut by Pyokka from the recording */
  quote: { name: string; text: string } | null;
  /** picked by the narration (always false before one) */
  picked: boolean;
}

export interface PanelTourChapter {
  id: string;
  /** 1-based position in the run */
  n: number;
  title: string;
  text: string | null;
  first: number;
  last: number;
  llm: number;
  http: number;
  /** candidates in the chapter, and how many of them the narration picked */
  stops: number;
  picked: number;
}

/** The TOUR section: chapters and stops of the bound session's last run (`pyokka tour`, docs/TOUR.md). */
export interface TourPanel {
  runId: string;
  /** `computing` while the Python command runs; `error` with `error` when it failed */
  status: 'computing' | 'ready' | 'error';
  error?: string;
  steps: number;
  goal: { step: number; text: string } | null;
  intro: string | null;
  chapters: PanelTourChapter[];
  /** every candidate in run order */
  stops: PanelTourStop[];
  /** a narration was merged: `picked` marks the stops it chose, and only those show until "all candidates" is unfolded */
  narrated: boolean;
  narrating: boolean;
  /** the last Narrate Tour of this run failed: the reasons, once */
  narrationError?: string;
  canNarrate: boolean;
  /** the stop the user last opened for this file, when this run has it (workspace state) */
  resumeStopId: string | null;
  /**
   * the run recorded no variable changes (Record Variable Changes off): calls carry no arguments and
   * `why` finds no assignments, so repeated calls fold into one stop and the spine is missing
   */
  noLocals: boolean;
}

/**
 * The Execution Diagram view's graph (docs/PROTOCOL.md, "Execution graph") with display paths in every
 * `file`, the packages currently unrolled, and the Time Machine's position when it was built. The call
 * stack follows separately (`executionGraph.stack`) so navigation does not resend the graph.
 */
export interface ExecutionGraphPanel extends ExecutionGraph {
  runId: string;
  /** package names unrolled into their functions (`executionGraph.expand`) */
  expanded: string[];
  /** node ids on the call stack at `currentStep`, innermost first; [] while the Time Machine is inactive */
  stack: string[];
  currentStep: number | null;
  /** the story tree's grouping of each scope's statements (`pyokka.diagram.phases`); [] when off */
  phases: GraphPhase[];
}

/** The EXCEPTIONS section of the Output view (docs/PROTOCOL.md, "Exceptions report"); every `file` is a display path. */
export interface ExceptionsPanel extends ExceptionReport {
  runId: string;
}

export type HostToWebview =
  | { type: 'init'; theme: 'dark' | 'light' | 'hc'; settings: PanelSettings; sessionName: string | null }
  | { type: 'session'; name: string | null; running: boolean; durationMs?: number; runMode: PanelSettings['runMode']; settings?: PanelSettings; /** the last run was killed by the run timeout after this many ms */ timedOutMs?: number; /** the last run answered HTTP from a recording */ replayed?: boolean }
  | { type: 'entries.reset' }
  | { type: 'entries.append'; entries: PanelEntry[] }
  | { type: 'entries.update'; entries: PanelEntry[] }
  /** host asks the panel to select (and reveal in Details) these entries, e.g. Explore Value */
  | { type: 'entries.select'; logIds: string[] }
  | { type: 'errors'; errors: (ErrorEvent & { file: string; line: number; col: number })[] }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'value'; requestId: number; node?: ValueNode; error?: string }
  | { type: 'timeline'; model: TimelineModel | null }
  | { type: 'debugger'; state: DebuggerState }
  /** the Debugger view's state; null when the last debug session ended */
  | { type: 'debug.session'; state: DebugSessionPanel | null }
  /**
   * Output the view has not seen, sent instead of the whole 64 KB window on every `output` event.
   * `from` is the offset the chunks start at: when it is not the offset the view holds, the view
   * asks for a full `debug.session` with `debug.output.resync` rather than guessing. `open` is the
   * incomplete trailing line in full and replaces whatever open line the view is showing.
   */
  | { type: 'debug.output.append'; id: string; from: number; seq: number; dropped: number; chunks: DebugOutputChunk[]; open: DebugOutputChunk | null }
  | { type: 'codePreview'; step: number; file: string; startLine: number; lines: string[]; highlightLine: number; function: string; caller?: PreviewCaller }
  | { type: 'settings'; settings: PanelSettings }
  | { type: 'showView'; view: ViewId; logId?: string }
  | { type: 'diff'; left: { title: string; text: string }; right: { title: string; text: string } }
  | { type: 'walkthrough'; walkthrough: WalkthroughPanel | null }
  /** the TOUR section: null before a run finished, while one is in flight, and while the section was never opened */
  | { type: 'tour'; tour: TourPanel | null }
  /** the Show Tour command: expand the TOUR section */
  | { type: 'tour.reveal' }
  /** the EXCEPTIONS section: null until a run finished (and while one is in flight) */
  | { type: 'exceptions'; report: ExceptionsPanel | null }
  /** the Variable pane's answer for a name (file paths are display paths); an empty name clears the pane */
  | { type: 'variable'; view: VariableView }
  /** the Details pane's "why" tree: the query (tree null while it computes), then the answer; null clears it */
  | { type: 'why'; view: WhyView | null }
  /** the Execution Diagram view: null until a run finished; resent when a package is unrolled */
  | { type: 'executionGraph'; graph: ExecutionGraphPanel | null }
  /** the call stack at the Time Machine's step as node ids (innermost first; each frame's running statement, when it has a node, precedes the frame's scope), at most every 50 ms; [] when inactive */
  | { type: 'executionGraph.stack'; runId: string; step: number | null; stack: string[] }
  /** the answer to `executionGraph.hits`: the steps a node ran at (the first 400 of `total`) and the value logged at each, null when none */
  | { type: 'executionGraph.hits'; runId: string; nodeId: string; total: number; steps: number[]; values: (string | null)[] }
  /** the HTTP view's table (rows so far while a run is in flight); null before the first run */
  | { type: 'http'; panel: HttpPanel | null }
  /** the answer to `watch.complete`: what the typed prefix could continue with (the panel drops answers to older requests) */
  | { type: 'watch.completions'; requestId: number; prefix: string; items: CompletionItem[] }
  | { type: 'theme'; theme: 'dark' | 'light' | 'hc' };

export type WebviewToHost =
  | { type: 'ready' }
  /** the panel's active view changed: the host keeps `pyokka.panelView` so the title buttons can gate on it */
  | { type: 'viewChanged'; view: ViewId }
  /** `file` (a display path) names the file instead of `fileId`: the Debugger view has no run table */
  | { type: 'openLocation'; fileId: number; line: number; col: number; sideView?: boolean; file?: string }
  | { type: 'expand'; requestId: number; runtimeKey: string; valueId: string; queryPath: string[] }
  | { type: 'copy'; text: string }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'settings.update'; patch: Partial<PanelSettings>; scope: 'session' | 'global' }
  | { type: 'debugger.goto'; step: number }
  | { type: 'debugger.action'; action: 'stepInto' | 'stepBackInto' | 'stepOver' | 'stepBackOver' | 'stepOut' | 'stepBackOut' | 'runToLine' | 'runBackToLine' | 'stop' | 'start' | 'autoPlay' | 'pause' | 'toggleCallStack' | 'toggleEcho' | 'toggleCodePreview' }
  | { type: 'debugger.previewRequest'; step: number }
  | { type: 'debugger.selectFrame'; index: number }
  /** the debugger's toolbar and pane (docs/HANDOFF-debugger.md): resume, pause at the next statement, execute a step at the frontier, stop debugging */
  | { type: 'debugContinue' }
  | { type: 'debugPause' }
  | { type: 'debugStep'; kind: 'into' | 'over' | 'out' }
  | { type: 'debugStop' }
  /* ---------- the Debugger view (docs/design/debugger-product.md, 5.3) ---------- */
  /** a frame was clicked: reveal it and scope locals and eval to it */
  | { type: 'debug.selectFrame'; index: number }
  | { type: 'debug.watch.add'; exp: string; breakWhen?: 'change' | 'true' }
  | { type: 'debug.watch.edit'; id: string; exp: string }
  | { type: 'debug.watch.remove'; id: string }
  | { type: 'debug.breakpoint.remove'; file: string; line?: number; function?: string }
  | { type: 'debug.exceptions'; mode: 'off' | 'uncaught' | 'raised' }
  /** the view missed bytes (a gap, or a run it did not see start): send the whole window again */
  | { type: 'debug.output.resync' }
  /** next to the title-bar commands, so the view works when the title bar overflows */
  | { type: 'debug.control'; action: 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop' }
  | { type: 'watch.remove'; id: string }
  | { type: 'watch.refresh'; id: string }
  | { type: 'watch.add'; exp: string }
  | { type: 'watch.edit'; id: string; exp: string }
  /** completions for the watch expression typed so far (`text` is what precedes the caret) */
  | { type: 'watch.complete'; requestId: number; text: string }
  /** the row's "Evaluate" action: run the file once to record the watch at the current step (outside Automatic mode) */
  | { type: 'watch.evaluate'; id: string }
  | { type: 'compare'; leftLogId: string; rightLogId: string }
  | { type: 'diagram'; logId: string }
  /** the WALKTHROUGH section's Narrate button: one model call for this run, never automatic */
  | { type: 'narrate' }
  /** the TOUR section opened (the host computes the tour of this run and of every later one) or closed */
  | { type: 'tour.open'; open: boolean }
  /** a stop was clicked: the host remembers it for this file and moves the Time Machine to `step` (the `debugger.goto` path) */
  | { type: 'tour.goto'; step: number; stopId: string }
  /** Narrate Tour: one model call for this run, never automatic */
  | { type: 'tour.narrate' }
  /** the TOUR section's notice: switch the session's Record Variable Changes on and run the file once */
  | { type: 'tour.recordLocals' }
  /** the Variable pane asks for a name's history (empty clears it); the host answers with `variable` */
  | { type: 'variable.query'; name: string }
  /**
   * "Why" on an entry, a Variable pane row or a hover: the value `name` had after `step` (empty name: the statement at `step`);
   * the host answers with `why`. `logId` names the entry the query came from, when any: an entry is stamped when its statement
   * completes (inside the last callee it entered), so the host lands on the entry's own statement instead of `step`.
   */
  | { type: 'why.query'; step: number; name: string; logId?: string }
  /** the Details pane closed the tree: the host forgets the query (no more refreshes after a run) */
  | { type: 'why.close' }
  /** unroll a package node of the Execution Diagram into its functions (`collapse` folds it back) */
  | { type: 'executionGraph.expand'; nodeId: string; collapse?: boolean }
  /** the Execution Diagram opened (or a run finished while it was open) without a graph: build and send it (`pyokka.diagram.build`) */
  | { type: 'executionGraph.request' }
  /** the inspector asks for the steps a statement, decision or function ran at; the host answers with `executionGraph.hits` */
  | { type: 'executionGraph.hits'; nodeId: string }
  | { type: 'log'; level: 'info' | 'error'; message: string };
