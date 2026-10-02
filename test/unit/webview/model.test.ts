import { describe, expect, it } from 'vitest';
import type { DebugOutputChunk, DebugSessionPanel, PanelEntry } from '../../../src/shared/webviewProtocol';
import { allEntries, initialState, reduce, visibleEntries, type PanelState } from '../../../webview/model';

const entry = (logId: string, line: number, step = line): PanelEntry => ({ logId, kind: 'log', fileId: 1, file: 'a.py', line, col: 1, rid: line, hit: 1, step, text: String(line), runtimeKey: `k${line}` });

function seeded(): PanelState {
  let s = initialState();
  s = reduce(s, { type: 'host', message: { type: 'entries.append', entries: [entry('a', 1), entry('b', 2), entry('c', 3)] } });
  return s;
}

describe('reducer', () => {
  it('folds runtime errors in ahead of logs', () => {
    let s = seeded();
    s = reduce(s, { type: 'host', message: { type: 'errors', errors: [{ type: 'error', runId: 'r', seq: 9, fileId: 1, rid: 7, step: 9, message: 'boom', errorType: 'ValueError', stack: [], handled: false, file: 'a.py', line: 9, col: 1 }] } });
    const all = allEntries(s);
    expect(all[0]?.isError).toBe(true);
    expect(all[0]?.errorType).toBe('ValueError');
    expect(all.length).toBe(4);
  });
  it('filters lines and toggles safely under repeated calls', () => {
    let s = seeded();
    s = reduce(s, { type: 'filterToggle', keys: ['1:1'], visible: false });
    s = reduce(s, { type: 'filterToggle', keys: ['1:2'], visible: false });
    expect(visibleEntries(s).map((e) => e.logId)).toEqual(['c']);
    s = reduce(s, { type: 'filterToggle', keys: ['1:1', '1:2'], visible: true });
    expect(visibleEntries(s).length).toBe(3);
  });
  it('handles host-driven selection and switches to the output view', () => {
    let s = seeded();
    s = reduce(s, { type: 'view', view: 'settings' });
    s = reduce(s, { type: 'host', message: { type: 'entries.select', logIds: ['b', 'c'] } });
    expect(s.selection).toEqual({ ids: ['b', 'c'], anchor: 'b' });
    expect(s.view).toBe('output');
    expect(s.revealSelection).toBe(1);
  });
  it('splices expanded nodes back into the entry', () => {
    let s = initialState();
    const data = { id: 'root', queryPath: ['k'], type: 'dict', props: [{ id: 'child', queryPath: ['k', '_p_x'], type: 'list', name: 'x', expandable: true, value: '[…]' }] };
    s = reduce(s, { type: 'host', message: { type: 'entries.append', entries: [{ ...entry('a', 1), valueBag: { runtimeKey: 'k', data } }] } });
    s = reduce(s, { type: 'expandRequested', requestId: 7, logId: 'a', queryPath: ['k', '_p_x'] });
    s = reduce(s, { type: 'host', message: { type: 'value', requestId: 7, node: { id: 'child', queryPath: ['k', '_p_x'], type: 'list', props: [{ id: 'i0', queryPath: ['k', '_p_x', '_p_0'], type: 'number', value: '1', name: '0' }] } } });
    const x = s.logs[0]?.valueBag?.data.props?.[0];
    expect(x?.props?.length).toBe(1);
    expect(x?.name).toBe('x');
    expect(s.pending.size).toBe(0);
  });
  it('keeps the latest watch expression completions with the request they answer', () => {
    let s = initialState();
    expect(s.completions).toBeNull();
    s = reduce(s, { type: 'host', message: { type: 'watch.completions', requestId: 3, prefix: 'pay', items: [{ label: 'payload', kind: 'variable', type: 'dict' }] } });
    expect(s.completions).toEqual({ requestId: 3, prefix: 'pay', items: [{ label: 'payload', kind: 'variable', type: 'dict' }] });
    s = reduce(s, { type: 'host', message: { type: 'watch.completions', requestId: 4, prefix: '', items: [] } });
    expect(s.completions).toEqual({ requestId: 4, prefix: '', items: [] });
  });
  it('auto-shows the debugger view and returns to output when it stops', () => {
    let s = seeded();
    const dbg = { active: true, autoPlaying: false, currentStep: 2, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: true, echo: true, watches: [] };
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: dbg } });
    expect(s.view).toBe('debugger');
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: { ...dbg, active: false } } });
    expect(s.view).toBe('output');
  });
  it('forgets the Time Machine state when the host re-binds (init), so a stopped session leaves no stop button', () => {
    let s = seeded();
    const dbg = { active: true, autoPlaying: false, currentStep: 2, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: true, echo: true, watches: [] };
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: dbg } });
    expect(s.view).toBe('debugger');
    s = reduce(s, { type: 'host', message: { type: 'init', theme: s.theme, settings: s.settings, sessionName: null } });
    expect(s.debugger).toBeNull();
    expect(s.view).toBe('output');
  });
  it('keeps the Variable pane query, answer and view while the Time Machine starts from it', () => {
    let s = seeded();
    s = reduce(s, { type: 'view', view: 'variable' });
    s = reduce(s, { type: 'variableQuery', name: 'acct' });
    expect(s.variable).toEqual({ name: 'acct', history: null });
    const history = { name: 'acct', changes: [], total: 0, truncated: false, recordedLocals: false };
    s = reduce(s, { type: 'host', message: { type: 'variable', view: { name: 'acct', history } } });
    expect(s.variable?.history).toBe(history);
    const dbg = { active: true, autoPlaying: false, currentStep: 2, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: true, echo: true, watches: [] };
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: dbg } });
    expect(s.view).toBe('variable');
    s = reduce(s, { type: 'host', message: { type: 'variable', view: { name: '', history: null } } });
    expect(s.variable).toBeNull();
    s = reduce(s, { type: 'host', message: { type: 'init', theme: s.theme, settings: s.settings, sessionName: null } });
    expect(s.variable).toBeNull();
  });
  it('shows a why tree in the Details pane: the query leaves the Variable view for output, the Time Machine view keeps its own slot', () => {
    let s = seeded();
    s = reduce(s, { type: 'view', view: 'variable' });
    s = reduce(s, { type: 'whyQuery', step: 21, name: 'total' });
    expect(s.why).toEqual({ step: 21, name: 'total', tree: null });
    expect(s.view).toBe('output');
    const tree = { name: 'total', step: 21, depth: 5, nodes: 1, truncated: false, recordedLocals: true, root: { name: 'total', text: '35.0', step: 21 } };
    s = reduce(s, { type: 'host', message: { type: 'why', view: { step: 21, name: 'total', tree } } });
    expect(s.why?.tree).toBe(tree);
    expect(s.view).toBe('output');
    // a click on a node starts the Time Machine: the tree follows into the debugger view, where a new query stays
    const dbg = { active: true, autoPlaying: false, currentStep: 21, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: true, echo: true, watches: [] };
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: dbg } });
    expect(s.view).toBe('debugger');
    s = reduce(s, { type: 'host', message: { type: 'why', view: { step: 20, name: 'acct', tree: null } } });
    expect(s.view).toBe('debugger');
    expect(s.why?.name).toBe('acct');
    // a refresh of the shown tree (the same query after a re-run) leaves the view alone
    const acct = { ...tree, name: 'acct', step: 20 };
    s = reduce(s, { type: 'host', message: { type: 'why', view: { step: 20, name: 'acct', tree: acct } } });
    s = reduce(s, { type: 'view', view: 'settings' });
    s = reduce(s, { type: 'host', message: { type: 'why', view: { step: 20, name: 'acct', tree: acct } } });
    expect(s.view).toBe('settings');
    s = reduce(s, { type: 'whyClose' });
    expect(s.why).toBeNull();
    s = reduce(s, { type: 'whyQuery', step: 21, name: '' });
    expect(s.view).toBe('output');
    s = reduce(s, { type: 'host', message: { type: 'why', view: null } });
    expect(s.why).toBeNull();
    s = reduce(s, { type: 'whyQuery', step: 21, name: '' });
    s = reduce(s, { type: 'host', message: { type: 'init', theme: s.theme, settings: s.settings, sessionName: null } });
    expect(s.why).toBeNull();
  });
  it('keeps the execution graph, its stack and the selection per run', () => {
    let s = seeded();
    const graph = { runId: 'r1', expanded: [], phases: [], stack: [], currentStep: null, count: 3, nodes: [], edges: [], moments: [], scopes: {}, capped: false, truncated: false };
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph } });
    expect(s.executionGraph?.runId).toBe('r1');
    s = reduce(s, { type: 'graphSelect', nodeId: 'n1' });
    s = reduce(s, { type: 'host', message: { type: 'executionGraph.stack', runId: 'r1', step: 2, stack: ['n1', 'n0'] } });
    expect(s.graphSelection).toBe('n1');
    expect(s.graphStack).toEqual({ runId: 'r1', step: 2, stack: ['n1', 'n0'] });
    // a resend for the same run (a package unrolled) keeps the selection and the stack
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: { ...graph, expanded: ['libq'] } } });
    expect(s.graphSelection).toBe('n1');
    expect(s.graphStack?.stack).toEqual(['n1', 'n0']);
    // a new run clears both
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: { ...graph, runId: 'r2' } } });
    expect(s.graphSelection).toBeNull();
    expect(s.graphStack).toBeNull();
    s = reduce(s, { type: 'host', message: { type: 'executionGraph', graph: null } });
    expect(s.executionGraph).toBeNull();
    expect(s.graphSelection).toBeNull();
  });
  it('shows the execution diagram on request and stays there when its scrubber starts the Time Machine', () => {
    let s = seeded();
    s = reduce(s, { type: 'host', message: { type: 'showView', view: 'run-diagram' } });
    expect(s.view).toBe('run-diagram');
    const dbg = { active: true, autoPlaying: false, currentStep: 2, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: true, echo: true, watches: [] };
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: dbg } });
    expect(s.view).toBe('run-diagram');
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: { ...dbg, active: false } } });
    expect(s.view).toBe('run-diagram');
    s = reduce(s, { type: 'view', view: 'run-diagram' });
    expect(s.view).toBe('run-diagram');
    expect(s.diagramLogId).toBeNull();
  });
  it('stays on the HTTP view when a row starts the Time Machine', () => {
    let s = seeded();
    s = reduce(s, { type: 'host', message: { type: 'showView', view: 'http' } });
    const panel = { runId: 'r1', running: false, count: 1, truncated: false, totals: { requests: 1, bytes: 10, ms: 5, misses: 0, missAttempts: 0 }, finished: null, requests: [] };
    s = reduce(s, { type: 'host', message: { type: 'http', panel } });
    expect(s.http).toBe(panel);
    const dbg = { active: true, autoPlaying: false, currentStep: 2, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: true, echo: true, watches: [] };
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: dbg } });
    expect(s.view).toBe('http');
    s = reduce(s, { type: 'host', message: { type: 'debugger', state: { ...dbg, active: false } } });
    expect(s.view).toBe('http');
    s = reduce(s, { type: 'host', message: { type: 'http', panel: null } });
    expect(s.http).toBeNull();
  });
  it('init clears the HTTP panel', () => {
    let s = seeded();
    const panel = { runId: 'r1', running: true, count: 0, truncated: false, totals: { requests: 0, bytes: 0, ms: 0, misses: 0, missAttempts: 0 }, finished: null, requests: [] };
    s = reduce(s, { type: 'host', message: { type: 'http', panel } });
    expect(s.http).toBe(panel);
    s = reduce(s, { type: 'host', message: { type: 'init', theme: s.theme, settings: s.settings, sessionName: null } });
    expect(s.http).toBeNull();
  });
  it('keeps the exceptions report until the host clears it for the next run', () => {
    let s = seeded();
    expect(s.exceptions).toBeNull();
    const report = { runId: 'r1', count: 412, file: 'main.py', exitCode: 1, stale: false, staleFiles: [], total: 0, raises: 0, uncaught: 0, caught: 0, broad: 0, rows: [] };
    s = reduce(s, { type: 'host', message: { type: 'exceptions', report } });
    expect(s.exceptions).toBe(report);
    s = reduce(s, { type: 'host', message: { type: 'entries.reset' } });
    expect(s.exceptions).toBe(report);
    s = reduce(s, { type: 'host', message: { type: 'exceptions', report: null } });
    expect(s.exceptions).toBeNull();
  });
  it('ignores unknown host messages', () => {
    const s = seeded();
    expect(reduce(s, { type: 'host', message: { type: 'nonsense' } as never })).toBe(s);
  });
});

describe('the Debugger view\'s output deltas', () => {
  const SESSION: DebugSessionPanel = {
    id: 'debug-1',
    displayName: 'run.py',
    launch: { program: 'run.py', module: null, args: [], cwd: '.', python: '.venv/bin/python', record: false },
    launchTitle: 'run.py',
    running: true,
    paused: false,
    record: false,
    modified: false,
    reasonText: 'running',
    location: '',
    stack: [],
    selectedFrame: 0,
    locals: [],
    watches: [],
    output: [{ stream: 'stdout', text: 'Turn 1: booked\n', t: 100 }],
    outputOpen: null,
    outputSeq: 15,
    outputDropped: 0,
    elapsed: 2_000,
    lastOutputAt: 100,
    breakpoints: [],
    files: [],
    exceptions: 'uncaught',
    exception: null,
  };

  const opened = (): PanelState => reduce(initialState(), { type: 'host', message: { type: 'debug.session', state: SESSION } });
  const chunk = (text: string, t: number): DebugOutputChunk => ({ stream: 'stdout', text, t });

  it('appends what the host sent instead of replacing the window', () => {
    const s = reduce(opened(), {
      type: 'host',
      message: { type: 'debug.output.append', id: 'debug-1', from: 15, seq: 29, dropped: 0, chunks: [chunk('Turn 2: none\n', 900)], open: null },
    });
    expect(s.debugSession!.output).toHaveLength(2);
    expect(s.debugSession!.outputSeq).toBe(29);
    expect(s.debugSession!.lastOutputAt).toBe(900);
    expect(s.debugOutputGap).toBe(0);
  });

  it('replaces the open line rather than appending it, so a token stream grows in place', () => {
    let s = opened();
    for (const [text, t] of [['Turn 4: No', 1_000], ['Turn 4: Noted', 1_100], ['Turn 4: Noted — a window', 1_200]] as const) {
      s = reduce(s, { type: 'host', message: { type: 'debug.output.append', id: 'debug-1', from: 15, seq: 15, dropped: 0, chunks: [], open: chunk(text, t) } });
    }
    expect(s.debugSession!.output).toHaveLength(1); // nothing committed while the line is still open
    expect(s.debugSession!.outputOpen!.text).toBe('Turn 4: Noted — a window');
    expect(s.debugSession!.lastOutputAt).toBe(1_200);
  });

  it('asks for the whole window when a delta does not continue where it left off', () => {
    const s = reduce(opened(), {
      type: 'host',
      message: { type: 'debug.output.append', id: 'debug-1', from: 900, seq: 950, dropped: 4_096, chunks: [chunk('late\n', 50)], open: null },
    });
    expect(s.debugOutputGap).toBe(1);
    expect(s.debugSession!.output).toHaveLength(1); // untouched until the resync lands
  });

  it('ignores a delta for a session the view is not showing', () => {
    const s = reduce(opened(), {
      type: 'host',
      message: { type: 'debug.output.append', id: 'debug-other', from: 15, seq: 20, dropped: 0, chunks: [chunk('x\n', 0)], open: null },
    });
    expect(s.debugSession!.output).toHaveLength(1);
    expect(s.debugOutputGap).toBe(0);
  });
});
