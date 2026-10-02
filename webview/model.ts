/** Panel state: everything the host pushes plus local UI state, driven by a reducer. */
import type { CompletionItem, StackFrame, ValueNode } from '../src/shared/protocol';
import type { DebuggerState, DebugSessionPanel, ExceptionsPanel, ExecutionGraphPanel, HostToWebview, HttpPanel, PanelEntry, PanelSettings, PreviewCaller, TimelineModel, TourPanel, VariableView, ViewId, WalkthroughPanel, WhyView } from '../src/shared/webviewProtocol';
import { spliceNode } from './format';
import type { DebugOutputChunk } from './src-shared';
import { EMPTY_SELECTION, pruneSelection, type Selection } from './selection';
import { DEFAULT_PREFS, type UiPrefs } from './vscode';

export type Theme = 'dark' | 'light' | 'hc';

/** The host's answer to a watch expression completion request: which request, the typed prefix, the items. */
export interface WatchCompletions {
  requestId: number;
  prefix: string;
  items: CompletionItem[];
}

/** an entry as displayed: log entries as given, runtime errors folded in with their stack */
export interface Entry extends PanelEntry {
  stack?: StackFrame[];
  errorType?: string;
}

export interface CodePreview {
  step: number;
  file: string;
  startLine: number;
  lines: string[];
  highlightLine: number;
  /** function the step runs in (`<module>` at top level) */
  function: string;
  /** the frame that called that function; absent at top level */
  caller?: PreviewCaller;
}

export interface SessionInfo {
  name: string | null;
  running: boolean;
  durationMs?: number;
  runMode: PanelSettings['runMode'];
  /** the last run was killed by the run timeout after this many ms */
  timedOutMs?: number;
  /** the last run answered HTTP from a recording */
  replayed?: boolean;
}

/** What the Execution Diagram shows beyond the settings: the panel's own overrides and the scopes toggled against them; a new run clears the toggles. */
export interface GraphViewState {
  /** the run the toggles belong to */
  runId: string | null;
  /** statements drawn for every scope ('open') or for none ('closed') before the toggles; null follows `settings.diagramDetail` */
  base: 'open' | 'closed' | null;
  /** scope node ids toggled against the base (opened under 'closed', folded under 'open') */
  toggled: string[];
  /** null follows `settings.diagramDataEdges` */
  dataEdges: boolean | null;
  /** the left pane's tab */
  left: 'story' | 'walkthrough';
}

/** The inspector's hit list: the steps a node ran at (`executionGraph.hits`). */
export interface GraphHits {
  runId: string;
  nodeId: string;
  total: number;
  steps: number[];
  values: (string | null)[];
}

export interface PanelState {
  ready: boolean;
  theme: Theme;
  settings: PanelSettings;
  sessionSettings: PanelSettings | null;
  session: SessionInfo;
  logs: Entry[];
  errors: Entry[];
  timeline: TimelineModel | null;
  debugger: DebuggerState | null;
  /** the Debugger view's live session (`record: false`); null when none exists */
  debugSession: DebugSessionPanel | null;
  /** bumped when an output delta did not line up: App asks the host for the whole window again */
  debugOutputGap: number;
  /** the view that was active when the Debugger view was first shown, so the panel can return to it */
  debugReturnView: ViewId | null;
  /** the WALKTHROUGH section: null until a run finished */
  walkthrough: WalkthroughPanel | null;
  /** the TOUR section: null until the section opened and a run finished */
  tour: TourPanel | null;
  /** the EXCEPTIONS section: null until a run finished */
  exceptions: ExceptionsPanel | null;
  /** the Execution Diagram view's graph: null until a run finished */
  executionGraph: ExecutionGraphPanel | null;
  /** the call stack at the Time Machine's step as node ids (innermost first), from `executionGraph.stack` */
  graphStack: { runId: string; step: number | null; stack: string[] } | null;
  /** the node selected on the Execution Diagram canvas */
  graphSelection: string | null;
  graphView: GraphViewState;
  /** the steps the selected node ran at, once the host answered; null before, and for another run */
  graphHits: GraphHits | null;
  codePreview: CodePreview | null;
  diff: { left: { title: string; text: string }; right: { title: string; text: string } } | null;
  view: ViewId;
  /** entry the host asked to diagram (`showView` with a logId) */
  diagramLogId: string | null;
  /** the Variable pane: the queried name and the host's answer (history null while it computes) */
  variable: VariableView | null;
  /** the HTTP view's table (rows so far while a run is in flight): null before the first run */
  http: HttpPanel | null;
  /** the Details pane's "why" tree: the queried step and name and the host's answer (tree null while it computes) */
  why: WhyView | null;
  selection: Selection;
  /** which entries are hidden by the filter, keyed `${fileId}:${line}` */
  hiddenLines: Set<string>;
  filterMode: boolean;
  prefs: UiPrefs;
  /** pending `expand` requests: requestId -> where to splice the answer */
  pending: Map<number, { logId: string; queryPath: string[] }>;
  /** watch value expansions land here (watchId -> node) */
  watchNodes: Map<string, ValueNode>;
  /** the host's latest answer to a watch expression completion request (the input matches it by requestId) */
  completions: WatchCompletions | null;
  lastError: string | null;
  /** bumped when the host asks to reveal the selection (Entries scrolls to it) */
  revealSelection: number;
}

export const DEFAULT_SETTINGS: PanelSettings = {
  autoLog: false,
  valuePeek: true,
  showValueOnSelection: false,
  showSingleInlineValue: false,
  runMode: 'onSave',
  libraryCode: false,
  maskSecrets: true,
  runTimeoutMs: 30000,
  recordLocals: false,
  http: 'off',
  diagramDetail: 'scopes',
  diagramDataEdges: false,
};

export const DEFAULT_GRAPH_VIEW: GraphViewState = { runId: null, base: null, toggled: [], dataEdges: null, left: 'story' };

export function initialState(prefs: UiPrefs = DEFAULT_PREFS): PanelState {
  return {
    ready: false,
    theme: 'dark',
    settings: DEFAULT_SETTINGS,
    sessionSettings: null,
    session: { name: null, running: false, runMode: 'onSave' },
    logs: [],
    errors: [],
    timeline: null,
    debugger: null,
    debugSession: null,
    debugOutputGap: 0,
    debugReturnView: null,
    walkthrough: null,
    tour: null,
    exceptions: null,
    executionGraph: null,
    graphStack: null,
    graphSelection: null,
    graphView: DEFAULT_GRAPH_VIEW,
    graphHits: null,
    codePreview: null,
    diff: null,
    view: prefs.view,
    diagramLogId: null,
    variable: null,
    http: null,
    why: null,
    selection: EMPTY_SELECTION,
    hiddenLines: new Set(),
    filterMode: false,
    prefs,
    pending: new Map(),
    watchNodes: new Map(),
    completions: null,
    lastError: null,
    revealSelection: 0,
  };
}

export type Action =
  | { type: 'host'; message: HostToWebview }
  | { type: 'select'; selection: Selection }
  | { type: 'view'; view: ViewId; diagramLogId?: string | null }
  | { type: 'graphSelect'; nodeId: string | null }
  /** the Execution Diagram's toolbar and tabs: an override of the settings, the left pane's tab */
  | { type: 'graphView'; patch: Partial<GraphViewState> }
  /** a scope card's chevron (or a click on one of its members): open or fold its statements on the canvas */
  | { type: 'graphToggleScope'; nodeId: string }
  | { type: 'prefs'; patch: Partial<UiPrefs> }
  | { type: 'filter'; hiddenLines: Set<string> }
  | { type: 'filterToggle'; keys: string[]; visible: boolean }
  | { type: 'filterMode'; on: boolean }
  | { type: 'expandRequested'; requestId: number; logId: string; queryPath: string[] }
  | { type: 'watchExpandRequested'; requestId: number; watchId: string; queryPath: string[] }
  /** the Variable pane asked the host for a name (the answer arrives as a `variable` host message) */
  | { type: 'variableQuery'; name: string }
  /** a "Why" button asked the host for a value's provenance (the answer arrives as a `why` host message) */
  | { type: 'whyQuery'; step: number; name: string }
  /** the Details pane's tree closed (the host forgets the query too, see `why.close`) */
  | { type: 'whyClose' };

/** all entries in display order: errors first (like Quokka), then logs in arrival order */
export function allEntries(state: PanelState): Entry[] {
  return state.errors.length ? [...state.errors, ...state.logs] : state.logs;
}

export function visibleEntries(state: PanelState): Entry[] {
  const all = allEntries(state);
  if (state.hiddenLines.size === 0) return all;
  return all.filter((e) => !state.hiddenLines.has(lineKey(e)));
}

export function lineKey(e: Pick<Entry, 'fileId' | 'line'>): string {
  return `${e.fileId}:${e.line}`;
}

function mergeEntries(existing: Entry[], updates: PanelEntry[]): Entry[] {
  const byId = new Map(updates.map((u) => [u.logId, u]));
  return existing.map((e) => {
    const u = byId.get(e.logId);
    return u ? { ...e, ...u } : e;
  });
}

function spliceInto(entries: Entry[], logId: string, node: ValueNode): Entry[] {
  return entries.map((e) => {
    if (e.logId !== logId || !e.valueBag) return e;
    return { ...e, valueBag: { ...e.valueBag, data: spliceNode(e.valueBag.data, node) } };
  });
}

/** the view that shows a why tree: the split view's Details pane; the Time Machine view has its own Details slot, and the Execution Diagram keeps its screen */
function viewForWhy(view: ViewId): ViewId {
  return view === 'debugger' || view === 'run-diagram' ? view : 'output';
}

export function reduce(state: PanelState, action: Action): PanelState {
  switch (action.type) {
    case 'select':
      return { ...state, selection: action.selection };
    case 'view':
      return { ...state, view: action.view, diagramLogId: action.diagramLogId ?? (action.view === 'diagram' ? state.diagramLogId : null) };
    case 'prefs':
      return { ...state, prefs: { ...state.prefs, ...action.patch } };
    case 'filter':
      return { ...state, hiddenLines: action.hiddenLines };
    case 'filterToggle': {
      const hiddenLines = new Set(state.hiddenLines);
      for (const k of action.keys) {
        if (action.visible) hiddenLines.delete(k);
        else hiddenLines.add(k);
      }
      return { ...state, hiddenLines };
    }
    case 'filterMode':
      return { ...state, filterMode: action.on };
    case 'graphSelect':
      return { ...state, graphSelection: action.nodeId };
    case 'graphView':
      return { ...state, graphView: { ...state.graphView, ...action.patch } };
    case 'graphToggleScope': {
      const toggled = state.graphView.toggled.includes(action.nodeId) ? state.graphView.toggled.filter((id) => id !== action.nodeId) : [...state.graphView.toggled, action.nodeId];
      return { ...state, graphView: { ...state.graphView, toggled } };
    }
    case 'expandRequested': {
      const pending = new Map(state.pending);
      pending.set(action.requestId, { logId: action.logId, queryPath: action.queryPath });
      return { ...state, pending };
    }
    case 'watchExpandRequested': {
      const pending = new Map(state.pending);
      pending.set(action.requestId, { logId: `watch:${action.watchId}`, queryPath: action.queryPath });
      return { ...state, pending };
    }
    case 'variableQuery':
      return { ...state, variable: action.name ? { name: action.name, history: null } : null };
    case 'whyQuery':
      return { ...state, why: { step: action.step, name: action.name, tree: null }, view: viewForWhy(state.view) };
    case 'whyClose':
      return { ...state, why: null };
    case 'host':
      return reduceHost(state, action.message);
  }
}

/** New settings; a change of the diagram settings drops the panel's overrides of them, so the setting shows. */
function withSettings(state: PanelState, settings: PanelSettings): PanelState {
  const changed = settings.diagramDetail !== state.settings.diagramDetail || settings.diagramDataEdges !== state.settings.diagramDataEdges;
  return { ...state, settings, graphView: changed ? { ...state.graphView, base: null, dataEdges: null } : state.graphView };
}

function reduceHost(state: PanelState, m: HostToWebview): PanelState {
  switch (m.type) {
    case 'init':
      // a (re)bind: the host pushes the bound session's debugger state right after, and an unbound
      // panel has no Time Machine, so never keep the previous session's flag
      return { ...withSettings(state, m.settings), ready: true, theme: m.theme, session: { ...state.session, name: m.sessionName }, debugger: null, variable: null, http: null, why: null, view: state.view === 'debugger' ? 'output' : state.view };
    case 'theme':
      return { ...state, theme: m.theme };
    case 'settings':
      return withSettings(state, m.settings);
    case 'session':
      return {
        ...state,
        session: { name: m.name, running: m.running, durationMs: m.durationMs, runMode: m.runMode, timedOutMs: m.timedOutMs, replayed: m.replayed },
        sessionSettings: m.settings ?? state.sessionSettings,
      };
    case 'entries.reset':
      return { ...state, logs: [], errors: [], selection: EMPTY_SELECTION, pending: new Map() };
    case 'entries.append': {
      const logs = [...state.logs, ...m.entries];
      return { ...state, logs };
    }
    case 'entries.update':
      return { ...state, logs: mergeEntries(state.logs, m.entries) };
    case 'errors': {
      const errors: Entry[] = m.errors.map((e, i) => ({
        logId: `error:${e.runId}:${e.seq ?? i}`,
        kind: 'error',
        fileId: e.fileId,
        file: e.file,
        line: e.line,
        col: e.col,
        rid: e.rid,
        hit: 1,
        step: e.step,
        text: e.message,
        runtimeKey: '',
        isError: true,
        stack: e.stack,
        errorType: e.errorType,
      }));
      const next = { ...state, errors };
      return { ...next, selection: pruneSelection(allEntries(next).map((e) => e.logId), state.selection) };
    }
    case 'output':
      return state;
    case 'value': {
      const target = state.pending.get(m.requestId);
      if (!target) return state;
      const pending = new Map(state.pending);
      pending.delete(m.requestId);
      if (m.error || !m.node) return { ...state, pending, lastError: m.error ?? 'expand failed' };
      if (target.logId.startsWith('watch:')) {
        const watchNodes = new Map(state.watchNodes);
        const id = target.logId.slice('watch:'.length);
        const w = state.debugger?.watches.find((x) => x.id === id);
        const base = watchNodes.get(id) ?? w?.valueBag?.data;
        if (base) watchNodes.set(id, spliceNode(base, m.node));
        return { ...state, pending, watchNodes };
      }
      return { ...state, pending, logs: spliceInto(state.logs, target.logId, m.node) };
    }
    case 'watch.completions':
      return { ...state, completions: { requestId: m.requestId, prefix: m.prefix, items: m.items } };
    case 'timeline':
      return { ...state, timeline: m.model };
    case 'debug.session': {
      if (!m.state) {
        // the session ended: go back to the view that was active when the Debugger view opened
        const back = state.view === 'debug' ? (state.debugReturnView ?? 'output') : state.view;
        return { ...state, debugSession: null, debugReturnView: null, view: back };
      }
      const first = !state.debugSession;
      // a debug session that appears takes the panel, unless the user is reading another view's answer
      const takes = first && state.view !== 'variable' && state.view !== 'run-diagram' && state.view !== 'http';
      return { ...state, debugSession: m.state, view: takes ? 'debug' : state.view, debugReturnView: takes ? state.view : state.debugReturnView };
    }
    case 'debug.output.append': {
      const ds = state.debugSession;
      // a delta for a session the view is not showing, or one that does not continue where the view
      // left off (a gap the host could not cover, or a restart): ask for the whole window instead
      if (!ds || ds.id !== m.id) return state;
      if (m.from !== ds.outputSeq) return { ...state, debugOutputGap: state.debugOutputGap + 1 };
      return {
        ...state,
        debugSession: {
          ...ds,
          output: m.chunks.length ? [...ds.output, ...m.chunks] : ds.output,
          outputOpen: m.open,
          outputSeq: m.seq,
          outputDropped: m.dropped,
          lastOutputAt: lastChunkAt(m) ?? ds.lastOutputAt,
        },
      };
    }
    case 'debugger': {
      const wasActive = !!state.debugger?.active;
      let view = state.view;
      // a click in the Variable pane, an HTTP row or the Execution Diagram's scrubber starts the Time Machine: stay there, the toolbar and the editor show the step
      if (m.state.active && !wasActive && state.view !== 'variable' && state.view !== 'run-diagram' && state.view !== 'http') view = 'debugger';
      if (!m.state.active && wasActive && state.view === 'debugger') view = 'output';
      // forget expansions of watches that changed
      let watchNodes = state.watchNodes;
      if (state.debugger) {
        const prev = new Map(state.debugger.watches.map((w) => [w.id, w]));
        for (const w of m.state.watches) {
          const p = prev.get(w.id);
          if (p && p.step !== w.step && watchNodes.has(w.id)) {
            if (watchNodes === state.watchNodes) watchNodes = new Map(watchNodes);
            watchNodes.delete(w.id);
          }
        }
      }
      return { ...state, debugger: m.state, view, watchNodes, codePreview: m.state.codePreview ? state.codePreview : null };
    }
    case 'codePreview':
      return { ...state, codePreview: { step: m.step, file: m.file, startLine: m.startLine, lines: m.lines, highlightLine: m.highlightLine, function: m.function, caller: m.caller } };
    case 'walkthrough':
      return { ...state, walkthrough: m.walkthrough };
    case 'tour':
      return { ...state, tour: m.tour };
    case 'tour.reveal':
      return state.prefs.tourOpen ? state : { ...state, prefs: { ...state.prefs, tourOpen: true } };
    case 'exceptions':
      return { ...state, exceptions: m.report };
    case 'executionGraph': {
      const sameRun = !!m.graph && m.graph.runId === state.executionGraph?.runId;
      return {
        ...state,
        executionGraph: m.graph,
        graphSelection: sameRun ? state.graphSelection : null,
        graphStack: m.graph && state.graphStack?.runId === m.graph.runId ? state.graphStack : null,
        // the scopes toggled open belong to a run; the tab and the overrides of the settings stay
        graphView: sameRun ? state.graphView : { ...state.graphView, runId: m.graph?.runId ?? null, toggled: [] },
        graphHits: sameRun ? state.graphHits : null,
      };
    }
    case 'executionGraph.stack':
      return { ...state, graphStack: { runId: m.runId, step: m.step, stack: m.stack } };
    case 'executionGraph.hits':
      return m.runId === state.executionGraph?.runId ? { ...state, graphHits: { runId: m.runId, nodeId: m.nodeId, total: m.total, steps: m.steps, values: m.values } } : state;
    case 'showView':
      return { ...state, view: m.view, diagramLogId: m.view === 'diagram' ? m.logId ?? state.diagramLogId : state.diagramLogId };
    case 'diff':
      return { ...state, diff: { left: m.left, right: m.right }, view: 'diff' };
    case 'variable':
      return { ...state, variable: m.view.name ? m.view : null };
    case 'http':
      return { ...state, http: m.panel };
    case 'why': {
      if (!m.view) return { ...state, why: null };
      // a query and its answer show the Details pane; a refresh of the shown tree (the same query after a re-run) leaves the view alone
      const refresh = !!state.why?.tree && state.why.step === m.view.step && state.why.name === m.view.name;
      return { ...state, why: m.view, view: refresh ? state.view : viewForWhy(state.view) };
    }
    case 'entries.select': {
      // host-driven selection (Explore Value / Show as diagram): replace the selection, reveal the first
      // entry and show Details (the debugger view renders Details for a selection itself)
      const ids = m.logIds;
      const view = state.debugger?.active && state.view === 'debugger' ? state.view : 'output';
      return { ...state, selection: { ids, anchor: ids[0] ?? null }, view, diagramLogId: null, revealSelection: state.revealSelection + 1 };
    }
    default:
      return state;
  }
}

/** entries shown while navigating the trace: only those at or before the current step */
export function entriesForDebugger(entries: Entry[], dbg: DebuggerState | null): Entry[] {
  if (!dbg?.active) return entries;
  return entries.filter((e) => e.step <= dbg.currentStep);
}

/** When the last byte of a delta arrived, for the view's idle clock; null when it carried none. */
function lastChunkAt(m: { chunks: DebugOutputChunk[]; open: DebugOutputChunk | null }): number | null {
  if (m.open) return m.open.t;
  const last = m.chunks[m.chunks.length - 1];
  return last ? last.t : null;
}
