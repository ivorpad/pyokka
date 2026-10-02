/** Root component: message plumbing, layout, view switching. */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { canCompare, Compare, compareSides, CompareUnavailable } from './components/Compare';
import { DebugToolbar, NoSession, Rail } from './components/Chrome';
import { DebuggerView } from './components/Debugger';
import { DebugSessionView } from './components/DebuggerView';
import { Details, type DetailsHandle } from './components/Details';
import { Diagram } from './components/Diagram';
import { Entries } from './components/Entries';
import { Exceptions } from './components/Exceptions';
import { ExecutionDiagram } from './components/ExecutionDiagram';
import { HttpPane } from './components/HttpPane';
import { SettingsView, timeoutLabel } from './components/SettingsView';
import { Walkthrough } from './components/Walkthrough';
import { Tour } from './components/Tour';
import { tourGotoMessage } from './tourView';
import { VariablePane } from './components/VariablePane';
import { allEntries, entriesForDebugger, initialState, reduce, visibleEntries, type Entry } from './model';
import { applyTheme } from './monaco';
import { orderedSelection, pruneSelection } from './selection';
import type { HostToWebview, PanelSettings, ValueNode, ViewId } from './src-shared';
import { copyText, loadPrefs, post, requestId, savePrefs, type UiPrefs } from './vscode';
import { whyName } from './why';

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState(loadPrefs()));
  const detailsRef = useRef<DetailsHandle>(null);
  const [dragging, setDragging] = useState(false);

  // host messages
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const m = ev.data as HostToWebview | undefined;
      if (!m || typeof m !== 'object' || !('type' in m)) return;
      dispatch({ type: 'host', message: m });
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    document.body.dataset.theme = state.theme;
    applyTheme(state.theme);
  }, [state.theme]);

  useEffect(() => {
    savePrefs(state.prefs);
  }, [state.prefs]);

  // remember the last non-transient view
  useEffect(() => {
    if (state.view === 'output' || state.view === 'settings') dispatch({ type: 'prefs', patch: { view: state.view } });
  }, [state.view]);

  // the host keeps `pyokka.panelView` so the Debugger's title buttons can gate on the view showing
  useEffect(() => {
    post({ type: 'viewChanged', view: state.view });
  }, [state.view]);

  // an output delta that did not continue where the view left off: ask for the whole window again
  useEffect(() => {
    if (state.debugOutputGap) post({ type: 'debug.output.resync' });
  }, [state.debugOutputGap]);

  const all = useMemo(() => allEntries(state), [state.logs, state.errors]);
  const visible = useMemo(() => entriesForDebugger(visibleEntries(state), state.debugger), [state.logs, state.errors, state.hiddenLines, state.debugger]);
  const order = useMemo(() => visible.map((e) => e.logId), [visible]);

  // drop selections of entries that disappeared
  useEffect(() => {
    const pruned = pruneSelection(order, state.selection);
    if (pruned !== state.selection) dispatch({ type: 'select', selection: pruned });
  }, [order]);

  const selectedEntries = useMemo(() => {
    const ids = orderedSelection(order, state.selection);
    const byId = new Map(visible.map((e) => [e.logId, e]));
    return ids.map((id) => byId.get(id)).filter((e): e is Entry => !!e);
  }, [order, state.selection, visible]);
  const detailEntries = selectedEntries.length ? selectedEntries : visible;

  const onPrefs = useCallback((patch: Partial<UiPrefs>) => dispatch({ type: 'prefs', patch }), []);
  const setView = useCallback((view: ViewId, logId?: string | null) => dispatch({ type: 'view', view, diagramLogId: logId }), []);
  const onCommand = useCallback((command: string, args?: unknown[]) => post({ type: 'command', command, args }), []);
  const openEntry = useCallback((e: Entry, sideView: boolean) => post({ type: 'openLocation', fileId: e.fileId, line: e.line, col: e.col, sideView }), []);
  const openLocation = useCallback((fileId: number, line: number, col: number, sideView: boolean) => post({ type: 'openLocation', fileId, line, col, sideView }), []);

  const expand = useCallback((entry: Entry, node: ValueNode) => {
    const id = requestId();
    dispatch({ type: 'expandRequested', requestId: id, logId: entry.logId, queryPath: node.queryPath });
    post({ type: 'expand', requestId: id, runtimeKey: entry.valueBag?.runtimeKey ?? entry.runtimeKey, valueId: node.id, queryPath: node.queryPath });
  }, []);

  const watchExpand = useCallback(
    (watchId: string, node: ValueNode) => {
      const w = state.debugger?.watches.find((x) => x.id === watchId);
      const id = requestId();
      dispatch({ type: 'watchExpandRequested', requestId: id, watchId, queryPath: node.queryPath });
      post({ type: 'expand', requestId: id, runtimeKey: w?.valueBag?.runtimeKey ?? '', valueId: node.id, queryPath: node.queryPath });
    },
    [state.debugger],
  );

  const updateSettings = useCallback((scope: 'global' | 'session') => (patch: Partial<PanelSettings>) => post({ type: 'settings.update', patch, scope }), []);
  const queryVariable = useCallback((name: string) => {
    dispatch({ type: 'variableQuery', name });
    post({ type: 'variable.query', name });
  }, []);
  // `logId` names the entry a Why came from: an entry is stamped inside the last callee its statement
  // entered, so the host roots the tree at the entry's own statement rather than at `step`
  const queryWhy = useCallback((step: number, name: string, logId?: string) => {
    dispatch({ type: 'whyQuery', step, name });
    post(logId ? { type: 'why.query', step, name, logId } : { type: 'why.query', step, name });
  }, []);
  const closeWhy = useCallback(() => {
    dispatch({ type: 'whyClose' });
    post({ type: 'why.close' });
  }, []);

  const compareEnabled = selectedEntries.length === 2 && canCompare(selectedEntries[0], selectedEntries[1]);
  const openCompare = () => {
    const [a, b] = selectedEntries;
    if (!a || !b) return;
    post({ type: 'compare', leftLogId: a.step <= b.step ? a.logId : b.logId, rightLogId: a.step <= b.step ? b.logId : a.logId });
    if (!canCompare(a, b)) {
      dispatch({ type: 'view', view: 'diff' });
      return;
    }
    const [left, right] = compareSides(a, b);
    if (left && right) dispatch({ type: 'host', message: { type: 'diff', left, right } });
  };
  const openDiagram = () => {
    const target = selectedEntries[0] ?? visible[0];
    if (!target) return;
    post({ type: 'diagram', logId: target.logId });
    setView('diagram', target.logId);
  };

  // splitter
  const rootRef = useRef<HTMLDivElement>(null);
  const startDrag = (e: MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = Math.max(160, Math.min(rect.width - 240, ev.clientX - rect.left));
      dispatch({ type: 'prefs', patch: { splitPx: px } });
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // global Escape clears selection when nothing else handles it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (e.target === document.body || e.target === rootRef.current)) dispatch({ type: 'select', selection: { ids: [], anchor: null } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const dbg = state.debugger;
  const debuggerActive = !!dbg?.active;
  const diagramEntry = state.diagramLogId ? all.find((e) => e.logId === state.diagramLogId) ?? null : selectedEntries[0] ?? visible[0] ?? null;

  const exceptionsPane = (
    <Exceptions
      model={state.exceptions}
      open={state.prefs.exceptionsOpen}
      onToggle={() => onPrefs({ exceptionsOpen: !state.prefs.exceptionsOpen })}
      onGoto={(step) => post({ type: 'debugger.goto', step })}
      onOpen={(fileId, line, sideView) => post({ type: 'openLocation', fileId, line, col: 0, sideView })}
    />
  );

  const walkthroughPane = (
    <Walkthrough
      model={state.walkthrough}
      currentStep={dbg?.active ? dbg.currentStep : null}
      open={state.prefs.walkthroughOpen}
      onToggle={() => onPrefs({ walkthroughOpen: !state.prefs.walkthroughOpen })}
      onGoto={(step) => post({ type: 'debugger.goto', step })}
      onNarrate={() => post({ type: 'narrate' })}
      onOpen={(fileId, line, sideView) => post({ type: 'openLocation', fileId, line, col: 0, sideView })}
    />
  );

  // the host computes a tour only while the section is open: tell it, and again for every session it binds
  useEffect(() => {
    post({ type: 'tour.open', open: state.prefs.tourOpen });
  }, [state.prefs.tourOpen, state.session.name]);

  const tourPane = (
    <Tour
      model={state.tour}
      currentStep={dbg?.active ? dbg.currentStep : null}
      open={state.prefs.tourOpen}
      onToggle={() => onPrefs({ tourOpen: !state.prefs.tourOpen })}
      onGoto={(stop) => post(tourGotoMessage(stop))}
      onNarrate={() => post({ type: 'tour.narrate' })}
      onRecordLocals={() => post({ type: 'tour.recordLocals' })}
      onOpen={(fileId, line, file) => post(fileId >= 0 ? { type: 'openLocation', fileId, line, col: 0 } : { type: 'openLocation', fileId: -1, line, col: 0, file })}
    />
  );

  const timedOut = !state.session.running && state.session.timedOutMs !== undefined ? state.session.timedOutMs : undefined;
  const runNotice =
    timedOut !== undefined ? (
      <>
        Run timed out after {timeoutLabel(timedOut)} while the program was still working, so the values stop where it was killed and nothing can be expanded or evaluated until the next run. Raise the Run Timeout in{' '}
        <a href="#" class="pk-link" onClick={(e) => { e.preventDefault(); setView('settings'); }}>
          Settings
        </a>
        , then re-execute (F5).
      </>
    ) : undefined;

  const entriesPane = (bare?: boolean) => (
    <Entries
      emptyText={state.session.running ? 'RUNNING…' : undefined}
      notice={runNotice}
      entries={visible}
      allEntries={entriesForDebugger(all, dbg)}
      hiddenLines={state.hiddenLines}
      filterMode={state.filterMode}
      selection={state.selection}
      prefs={state.prefs}
      onSelect={(selection) => dispatch({ type: 'select', selection })}
      onPrefs={onPrefs}
      onFilter={(hiddenLines) => dispatch({ type: 'filter', hiddenLines })}
      onFilterToggle={(keys, visible) => dispatch({ type: 'filterToggle', keys, visible })}
      onFilterMode={(on) => dispatch({ type: 'filterMode', on })}
      onOpen={openEntry}
      onWhy={(e) => queryWhy(e.step, whyName(e), e.logId)}
      onFocusDetails={() => detailsRef.current?.focus()}
      onCopy={copyText}
      title={bare ? 'ENTRIES' : undefined}
      revealSelection={state.revealSelection}
    />
  );

  const detailsPane = (
    <Details
      entries={detailEntries}
      total={detailEntries.length}
      theme={state.theme}
      prefs={state.prefs}
      compareEnabled={selectedEntries.length === 2}
      why={state.why}
      onPrefs={onPrefs}
      onOpen={openLocation}
      onExpand={expand}
      onCopy={copyText}
      onCompare={openCompare}
      onDiagram={openDiagram}
      onGoto={(step) => post({ type: 'debugger.goto', step })}
      onCloseWhy={closeWhy}
      handle={detailsRef}
    />
  );

  let rightPane;
  switch (state.view) {
    case 'settings':
      rightPane = (
        <SettingsView
          settings={state.sessionSettings ?? state.settings}
          onUpdate={updateSettings(state.session.name ? 'session' : 'global')}
          onSaveDefaults={({ runMode: _perSession, ...rest }) => updateSettings('global')(rest)}
          onCommand={onCommand}
        />
      );
      break;
    case 'diagram':
      rightPane = <Diagram entry={diagramEntry} onExpand={expand} onCopy={copyText} onClose={() => setView('output')} />;
      break;
    case 'diff':
      rightPane = state.diff ? <Compare left={state.diff.left} right={state.diff.right} theme={state.theme} onClose={() => setView('output')} /> : <CompareUnavailable onClose={() => setView('output')} />;
      break;
    case 'variable':
      rightPane = (
        <VariablePane
          view={state.variable}
          settings={state.sessionSettings ?? state.settings}
          showFileName={state.prefs.showFileName}
          onQuery={queryVariable}
          onGoto={(step) => post({ type: 'debugger.goto', step })}
          onOpen={openLocation}
          onWhy={queryWhy}
          onEnableRecordLocals={() => updateSettings(state.session.name ? 'session' : 'global')({ recordLocals: true })}
          onClose={() => setView('output')}
        />
      );
      break;
    case 'http':
      rightPane = (
        <HttpPane
          panel={state.http}
          mode={(state.sessionSettings ?? state.settings).http}
          onGoto={(step) => post({ type: 'debugger.goto', step })}
          onOpen={openLocation}
          onMode={(http) => updateSettings(state.session.name ? 'session' : 'global')({ http })}
          onOpenRecording={() => onCommand('pyokka.openHttpRecording')}
          onClose={() => setView('output')}
        />
      );
      break;
    default:
      rightPane = detailsPane;
  }

  const leftStyle = state.prefs.splitPx > 0 ? { flex: `0 0 ${state.prefs.splitPx}px` } : undefined;

  return (
    <div class={`pk-root${dragging ? ' dragging' : ''}`} ref={rootRef}>
      {debuggerActive && dbg && (
        <DebugToolbar
          state={dbg}
          session={state.session}
          onAction={(action) => post({ type: 'debugger.action', action })}
          onStop={() => onCommand('pyokka.stopTraceNavigation')}
          onShowDiagram={() => setView(state.view === 'run-diagram' ? 'debugger' : 'run-diagram')}
          diagramShown={state.view === 'run-diagram'}
        />
      )}
      <div class="pk-main">
        <div class="pk-content">
          {state.view === 'debug' && state.debugSession ? (
            <DebugSessionView
              state={state.debugSession}
              onOpen={(file, line) => post({ type: 'openLocation', fileId: -1, line, col: 0, file })}
              onWatchAdd={(exp, breakWhen) => post(breakWhen ? { type: 'debug.watch.add', exp, breakWhen } : { type: 'debug.watch.add', exp })}
              onWatchRemove={(id) => post({ type: 'debug.watch.remove', id })}
              onBreakpointRemove={(file, line, fn) => post({ type: 'debug.breakpoint.remove', file, ...(line !== undefined ? { line } : {}), ...(fn ? { function: fn } : {}) })}
              onExceptions={(mode) => post({ type: 'debug.exceptions', mode })}
              onView={(v) => setView(v)}
            />
          ) : state.view === 'run-diagram' ? (
            <ExecutionDiagram
              graph={state.executionGraph}
              graphStack={state.graphStack}
              debug={dbg}
              walkthrough={state.walkthrough}
              selected={state.graphSelection}
              running={state.session.running}
              settings={state.sessionSettings ?? state.settings}
              view={state.graphView}
              hits={state.graphHits}
              onSelect={(nodeId) => dispatch({ type: 'graphSelect', nodeId })}
              onGoto={(step) => post({ type: 'debugger.goto', step })}
              onAction={(action) => post({ type: 'debugger.action', action })}
              onExpand={(nodeId, collapse) => post(collapse ? { type: 'executionGraph.expand', nodeId, collapse: true } : { type: 'executionGraph.expand', nodeId })}
              onNarrate={() => post({ type: 'narrate' })}
              onOpen={(fileId, line, sideView) => post({ type: 'openLocation', fileId, line, col: 0, sideView })}
              onClose={() => setView(debuggerActive ? 'debugger' : 'output')}
              onView={(patch) => dispatch({ type: 'graphView', patch })}
              onToggleScope={(nodeId) => dispatch({ type: 'graphToggleScope', nodeId })}
              onHits={(nodeId) => post({ type: 'executionGraph.hits', nodeId })}
              onRequest={() => post({ type: 'executionGraph.request' })}
            />
          ) : state.view === 'debugger' && dbg && dbg.active ? (
            <DebuggerView
              model={state.timeline}
              state={dbg}
              entries={visible}
              watchNodes={state.watchNodes}
              theme={state.theme}
              codePreview={state.codePreview}
              onGoto={(step) => post({ type: 'debugger.goto', step })}
              onPreviewRequest={(step) => post({ type: 'debugger.previewRequest', step })}
              onAction={(action) => post({ type: 'debugger.action', action })}
              onWatch={(op, id) => post(op === 'remove' ? { type: 'watch.remove', id } : { type: 'watch.refresh', id })}
              onWatchAdd={(exp) => post({ type: 'watch.add', exp })}
              onWatchEdit={(id, exp) => post({ type: 'watch.edit', id, exp })}
              onWatchEvaluate={(id) => post({ type: 'watch.evaluate', id })}
              completions={state.completions}
              onWatchComplete={(requestId, text) => post({ type: 'watch.complete', requestId, text })}
              onWatchExpand={watchExpand}
              onOpen={openLocation}
              onCopy={copyText}
              onCommand={onCommand}
              showFileName={state.prefs.showFileName}
              details={selectedEntries.length > 0 || state.why ? detailsPane : null}
            >
              {entriesPane(true)}
              {exceptionsPane}
              {walkthroughPane}
              {tourPane}
            </DebuggerView>
          ) : !state.session.name && !state.debugSession && state.view === 'output' ? (
            <NoSession onCommand={onCommand} />
          ) : (
            <div class="pk-split">
              <div class="pk-split-left" style={leftStyle}>
                {entriesPane()}
                {exceptionsPane}
                {walkthroughPane}
                {tourPane}
              </div>
              <div class="pk-splitter" onMouseDown={startDrag} role="separator" aria-orientation="vertical" />
              <div class="pk-split-right">{rightPane}</div>
            </div>
          )}
        </div>
        <Rail
          view={state.view}
          debuggerActive={debuggerActive}
          debugSessionActive={!!state.debugSession}
          running={state.session.running}
          http={(state.sessionSettings ?? state.settings).http}
          onView={(v) => setView(v)}
          onCommand={onCommand}
        />
      </div>
    </div>
  );
}
