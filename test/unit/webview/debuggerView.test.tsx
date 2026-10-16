/** The Debugger view rendered: what it shows paused with a stack, running, and after the program ended. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { DebugSessionView } from '../../../webview/components/DebuggerView';
import { breakpointLabel, breakpointRows, debugHeaderLine, frameLabel, frameRows, launchSummary, stackRows, watchArg, watchLabel, watchValue } from '../../../webview/debuggerView';
import { Rail } from '../../../webview/components/Chrome';
import type { DebugSessionPanel } from '../../../src/shared/webviewProtocol';
import type { ValueBag, ValueNode } from '../../../src/shared/protocol';

const noop = () => undefined;

const icons = (html: string): string[] => [...html.matchAll(/codicon-([a-z-]+)/g)].map((m) => m[1]!).filter((n) => !n.startsWith('modifier'));

/** a value node the way the runtime sends one: members as props, each with its own query path */
function node(type: string, value: string | undefined, props?: { name: string; n: ValueNode }[], extra: Partial<ValueNode> = {}): ValueNode {
  const out: ValueNode = { type, id: `${type}-${value ?? 'x'}`, queryPath: [], ...extra };
  if (value !== undefined) out.value = value;
  if (props) {
    out.props = props.map((p) => ({ ...p.n, name: p.name, queryPath: [...out.queryPath, p.name], expressionPath: p.name }));
    out.length = props.length;
  }
  return out;
}
const bag = (data: ValueNode): ValueBag => ({ data, runtimeKey: data.id });

/** the locals of the RRF pause the task came from: a dict of lists, a dataclass, an int */
const SCORES = node('dict', "{'d1': 0.0312, 'd2': 0.0164}", [{ name: 'd1', n: node('number', '0.0312') }, { name: 'd2', n: node('number', '0.0164') }]);
const CANDIDATE = node('Candidate', "Candidate(doc='d1', score=0.5)", [{ name: 'doc', n: node('str', "'d1'") }, { name: 'score', n: node('number', '0.5') }]);
const RRF_LOCALS: DebugSessionPanel['locals'] = [
  { name: 'scores', text: "{'d1': 0.0312, 'd2': 0.0164}", valueBag: bag(SCORES) },
  { name: 'best', text: "Candidate(doc='d1', score=0.5)", valueBag: bag(CANDIDATE) },
  { name: 'k', text: '60', valueBag: bag(node('number', '60')) },
];

const PAUSED: DebugSessionPanel = {
  id: 'debug-2',
  displayName: 'app.py',
  launch: { program: 'app.py', module: null, args: ['--port', '8000'], cwd: 'project', python: '.venv/bin/python', record: false },
  launchTitle: '/ws/.venv/bin/python /ws/app.py --port 8000  ·  cwd /ws/project',
  running: true,
  paused: true,
  record: false,
  modified: false,
  reason: 'breakpoint',
  reasonText: 'breakpoint',
  location: 'app.py:42',
  thread: { name: 'Thread-3', ident: 6108209152 },
  stack: [
    { frameId: 0, name: 'do_GET', file: 'app.py', line: 42 },
    { frameId: 1, name: 'handle_one_request', file: 'http/server.py', line: 427, library: true },
    { frameId: 2, name: '<module>', file: 'app.py', line: 31 },
  ],
  selectedFrame: 0,
  locals: [{ name: 'payload', text: "{'q': 'a'}" }],
  watches: [
    { id: 'w1', exp: 'rank', kind: 'display', text: '2' },
    { id: 'w2', exp: 'rank == 3', kind: 'breakWhen', breakWhen: 'true' },
  ],
  output: [{ stream: 'stdout', text: 'listening on 8000\nGET /health 200\n', t: 120 }],
  outputOpen: null,
  outputSeq: 34,
  outputDropped: 0,
  elapsed: 4200,
  lastOutputAt: 120,
  breakpoints: [
    { file: 'app.py', line: 42, resolvedLine: 42, rid: 88 },
    { file: 'app.py', line: 60, condition: 'i == 3', error: null },
  ],
  files: ['app.py'],
  exceptions: 'uncaught',
  exception: null,
};

const view = (over: Partial<DebugSessionPanel> = {}, open?: string[]): string =>
  render(<DebugSessionView state={{ ...PAUSED, ...over }} onOpen={noop} onWatchAdd={noop} onWatchRemove={noop} onBreakpointRemove={noop} onExceptions={noop} onControl={noop} onSelectFrame={noop} onExpand={noop} initiallyOpen={open} />);

describe('DebugSessionView, paused with a stack', () => {
  it('says where it stopped and why, with the launch and the thread', () => {
    const html = view();
    // the status row: an icon for the reason, the location as a link, the reason and the thread as chips
    expect(html).toContain('codicon-debug-breakpoint');
    expect(html).toContain('class="pk-dbg-loc"');
    expect(html).toContain('>app.py:42<');
    expect(html).toContain('<span class="pk-dbg-chip">breakpoint</span>');
    expect(html).toContain('pk-dbg-chip pk-dbg-thread">Thread-3');
    expect(html).toContain('.venv/bin/python app.py --port 8000');
    // display paths in the row, the absolute command in its title
    expect(html).toContain('cwd project');
    expect(html).toContain('title="/ws/.venv/bin/python /ws/app.py --port 8000  ·  cwd /ws/project"');
    expect(html).not.toContain('>/ws/');
    expect(html).not.toContain('Values were changed');
  });

  it('opens on the frame: its variables, then the call stack, then the step controls, and only then the watches', () => {
    const html = view();
    // the initial view is wherever the values are: the paused frame's variables lead the view
    expect(html).toContain('pk-dbg-title">FRAME');
    expect(html).toContain('pk-dbg-note">app.py:42');
    expect(html).toContain('pk-dbg-name">payload');
    expect(html.indexOf('FRAME')).toBeLessThan(html.indexOf('WATCHES'));
    expect(html.indexOf('pk-dbg-name">payload')).toBeLessThan(html.indexOf('CALL STACK'));
    // the stack: the current frame marked, the library frame told apart, a frame is a button
    expect(html).toContain('pk-dbg-row cur');
    expect(html).toContain('>do_GET<');
    expect(html).toContain('>&lt;module><');
    expect(html).toContain('line 427 · library code');
    expect(html).toContain('class="pk-dbg-rowbtn pk-frame-btn"');
    expect(html.indexOf('CALL STACK')).toBeLessThan(html.indexOf('pk-frame-controls'));
    // the controls, in the debug toolbar's order, under the stack and above the watches
    const controls = icons(html.slice(html.indexOf('pk-frame-controls'), html.indexOf('WATCHES')));
    expect(controls).toEqual(['debug-continue', 'debug-step-over', 'debug-step-into', 'debug-step-out', 'debug-restart', 'debug-stop']);
    // no frame while the program runs: nothing to show, and the Running header has Pause, Restart and Stop
    const running = view({ paused: false, location: '', reasonText: 'running', stack: [], locals: [] });
    expect(running).not.toContain('FRAME');
    expect(running).not.toContain('pk-frame-controls');
  });

  it('opens a dict to its keys and a dataclass to its fields, the way the Details pane does', () => {
    const closed = view({ locals: RRF_LOCALS });
    // closed: one row per local, a twist on the ones with members, the type where the repr does not say it
    expect(closed).toContain('aria-label="Expand scores"');
    expect(closed).toContain('aria-label="Expand best"');
    expect(closed).not.toContain('aria-label="Expand k"');
    expect(closed).toContain('pk-dbg-type">dict<');
    expect(closed).not.toContain('pk-dbg-type">Candidate<');
    expect(closed).not.toContain('pk-dbg-member');
    const open = view({ locals: RRF_LOCALS }, ['scores', 'best']);
    // open: the members indented under their local, keys and fields by name, values rendered
    expect(open).toContain('aria-label="Collapse scores"');
    const members = [...open.matchAll(/pk-dbg-row pk-dbg-member[^>]*>.*?pk-dbg-name">([^<]+)</g)].map((m) => m[1]);
    expect(members).toEqual(['d1', 'd2', 'doc', 'score']);
    expect(open).toContain('padding-left:22px');
    expect(open.indexOf('pk-dbg-name">d1')).toBeLessThan(open.indexOf('pk-dbg-name">best'));
    expect(open).toContain('0.0312');
    expect(open.indexOf('FRAME')).toBeLessThan(open.indexOf('WATCHES'));
  });

  it('says the frame is being read, or that a library frame has no variables', () => {
    expect(view({ locals: [], localsPending: true })).toContain('reading the frame…');
    expect(view({ locals: [] })).toContain('no variables in this frame');
    expect(view({ locals: [], selectedFrame: 1 })).toContain('no variables: library frame');
  });

  it('gives every section a pane header with a count, hover actions and one row-actions column', () => {
    const html = view();
    for (const title of ['WATCHES', 'BREAKPOINTS', 'OUTPUT']) expect(html).toContain(`pk-dbg-title">${title}`);
    // a count where it helps
    expect(html).toContain('<span class="pk-dbg-count">2</span>');
    // the header actions: `+` on WATCHES, remove-all on BREAKPOINTS, the pause-on select
    expect(html).toContain('aria-label="Add a watch expression"');
    expect(html).toContain('aria-label="Remove every breakpoint"');
    expect(html).toContain('class="pk-dbg-select"');
    expect(html).toContain('aria-label="Pause on exception"');
    // the watch box is hidden until the `+` asks for it, and is the Time Machine's input when shown
    expect(html).not.toContain('pk-watch-input');
    // every removable row puts its × in the same column
    // two watches and two breakpoints in the fixture
    expect([...html.matchAll(/pk-dbg-row-actions/g)]).toHaveLength(4);
  });

  it('puts the resolved breakpoints first, mutes the pending ones and collapses a file that is not in this run', () => {
    const html = view({
      breakpoints: [
        { file: 'demo.py', line: 40 },
        { file: 'demo.py', line: 73 },
        { file: 'app.py', line: 42, resolvedLine: 42, rid: 88 },
        { file: 'demo.py', line: 124 },
        { file: 'demo.py', line: 175 },
        { file: 'later.py', line: 7 },
      ],
      files: ['app.py'],
    });
    // the four from another program are one muted line, after the one this run can pause at
    expect(html).toContain('4 in demo.py, not in this run');
    expect(html).not.toContain('demo.py:40');
    expect(html.indexOf('app.py:42')).toBeLessThan(html.indexOf('4 in demo.py'));
    // a file the run has not reached yet is pending, not stale: it keeps its row, muted
    expect(html).toContain('>later.py');
    expect(html).toContain('not resolved yet');
    expect(html).toContain('codicon-debug-breakpoint-unverified');
    expect(html).toMatch(/class="pk-dbg-row unresolved"/);
    // before the first instrumented file nothing is collapsed: anything may still resolve
    const early = view({ breakpoints: [{ file: 'demo.py', line: 40 }], files: [] });
    expect(early).toContain('>demo.py');
    expect(early).toContain('not resolved yet');
    expect(early).not.toContain('not in this run');
  });

  it('shows the watches, the breakpoints and the output', () => {
    const html = view();
    // a watch: the expression mono, its value dim at the right, a badge for a break-when one
    expect(html).toContain('pk-dbg-exp">rank<');
    expect(html).toContain('pk-dbg-badge">break when true');
    expect(html).toContain('>2<');
    expect(html).toContain('>app.py:42<');
    expect(html).toContain('pk-dbg-cond">if i == 3');
    expect(html).toContain('listening on 8000');
    expect(html).toContain('GET /health 200');
    // the output pane is read-only: there is no exec box, the Debug Console is where code runs
    expect(html).not.toContain('<input type="text" aria-label="Run"');
  });

  it('names the exception and the console writes when there are any', () => {
    const html = view({ modified: true, reason: 'exception', reasonText: 'uncaught ValueError: too big: 3', exception: { type: 'ValueError', message: 'too big: 3', uncaught: true } });
    // the chip says the kind of stop; the block below carries the text, so it is not said twice
    expect(html).toContain('<span class="pk-dbg-chip">exception</span>');
    expect(html).toContain('class="pk-dbg-error"');
    expect(html).toContain('codicon-error');
    expect(html).toContain('<b>ValueError</b>: too big: 3');
    expect(html).toContain('class="pk-dbg-warn"');
    expect(html).toContain('Values were changed from the console');
  });
});

describe('DebugSessionView, running and ended', () => {
  it('says the program is running and disables the pause verbs', () => {
    const html = view({ paused: false, location: '', reasonText: 'running', stack: [], locals: [] });
    expect(html).toContain('>Running<');
    expect(html).toContain('it stops at a breakpoint, an exception, or a pause');
    expect(html).toContain('codicon-loading');
    expect(html).toContain('pk-debug-status pk-dbg-status running');
  });

  it('says the program ended', () => {
    const html = view({ paused: false, running: false, location: '', reasonText: 'ended', stack: [], locals: [] });
    expect(html).toContain('The program ended');
  });

  it('says so when nothing was printed, and how much was cut from the head', () => {
    expect(view({ output: [], outputOpen: null })).toContain('the program has printed nothing yet');
    expect(view({ output: [], outputOpen: null })).toContain('class="pk-dbg-empty"');
    expect(view({ outputDropped: 2048 })).toContain('2.0 kB dropped from the start of the run');
  });

  const running = (over: Partial<DebugSessionPanel> = {}): string =>
    view({ paused: false, location: '', reasonText: 'running', stack: [], locals: [], ...over });

  // Where the pane sits is CSS's job now, not the DOM's: the two columns are always in the same
  // source order (context, then output), and debug.css decides from `.running` whether output leads
  // in a narrow panel and from the container query whether it sits in the right-hand column in a
  // wide one. So these assert the hooks the stylesheet keys on rather than the order of the markup.
  it('marks the run so the output pane leads and takes the free space', () => {
    const html = running();
    expect(html).toContain('pk-debug-cols running');
    expect(html).toContain('pk-dbg-grow');
    expect(html).toContain('pk-debug-outcol');
  });

  it('drops that mark at a stop, so the pane goes back under the watches and the breakpoints', () => {
    const html = view({});
    expect(html).toContain('pk-debug-cols"');
    expect(html).not.toContain('pk-debug-cols running');
    expect(html).not.toContain('pk-dbg-grow');
    // the context column still leads in source order, which is the single column a narrow panel shows
    expect(html.indexOf('WATCHES')).toBeLessThan(html.indexOf('OUTPUT'));
    expect(html.indexOf('BREAKPOINTS')).toBeLessThan(html.indexOf('OUTPUT'));
  });

  it('answers whether the program is alive while it prints nothing', () => {
    const html = running({ elapsed: 28_400, lastOutputAt: 14_000 });
    expect(html).toContain('pk-dbg-activity');
    expect(html).toContain('28.4s');          // how long the run has been going
    expect(html).toContain('14.4s ago');      // when the last byte came, which a spinner cannot say
    expect(html).toContain('pk-dbg-idle stale');
    expect(html).toContain('pk-dbg-spark');
  });

  it('says so when a program that has just started has printed nothing', () => {
    const html = running({ output: [], outputOpen: null, lastOutputAt: null, elapsed: 800 });
    expect(html).toContain('no output yet');
  });

  it('shows no activity row once the program has stopped', () => {
    expect(view({})).not.toContain('pk-dbg-activity');
    expect(running({ running: false })).not.toContain('pk-dbg-activity');
  });

  it('tells stderr apart from the answer, and offers to hide it', () => {
    const html = running({
      output: [
        { stream: 'stdout', text: 'Turn 1: booked\n', t: 100 },
        { stream: 'stderr', text: 'INFO:httpx:POST /v1/responses\n', t: 200 },
      ],
      outputOpen: null,
    });
    expect(html).toContain('pk-output-row stderr');
    expect(html).toContain('Hide the 1 stderr lines');
  });

  it('marks the line the program is still writing', () => {
    const html = running({
      output: [{ stream: 'stdout', text: 'Turn 3: done\n', t: 100 }],
      outputOpen: { stream: 'stdout', text: 'Turn 4: Noted — a window', t: 900 },
    });
    expect(html).toContain('pk-output-caret');
    expect(html).toContain('Turn 4: Noted — a window');
  });

  it('marks a silence between the lines either side of it', () => {
    const html = running({
      output: [
        { stream: 'stdout', text: 'before\n', t: 1_000 },
        { stream: 'stdout', text: 'after\n', t: 15_000 },
      ],
      outputOpen: null,
    });
    expect(html).toContain('14.0s with no output');
  });

  it('paints a colour the program asked for instead of printing the escape', () => {
    const html = running({
      output: [{ stream: 'stdout', text: '\x1b[32mrank ok\x1b[0m k=60\n', t: 100 }],
      outputOpen: null,
    });
    expect(html).toContain('var(--vscode-terminal-ansiGreen)');
    expect(html).not.toContain('[32m');
  });

  it('says a watch waits for a pause rather than that the stop had no value', () => {
    const html = running({ watches: [{ id: 'w1', exp: 'user_state.global_memory', kind: 'display' }] });
    expect(html).toContain('at the next pause');
    expect(html).not.toContain('no value at this stop');
  });
});


describe('the rail', () => {
  it('shows the Debugger button only while a debug session exists, between the Time Machine and the Code Story', () => {
    const without = render(<Rail view="output" debuggerActive={false} running={false} onView={noop} onCommand={noop} />);
    expect(icons(without)).not.toContain('debug-alt');
    const withIt = render(<Rail view="debug" debuggerActive={false} debugSessionActive running={false} onView={noop} onCommand={noop} />);
    expect(icons(withIt)).toEqual(['play', 'output', 'history', 'debug-alt', 'book', 'symbol-variable', 'globe', 'pulse', 'settings-gear', 'ellipsis']);
    expect(withIt).toMatch(/pk-icon-btn active"[^>]*data-tip="Show Debugger"/);
  });
});

describe('the view helpers', () => {
  it('builds the header, the labels and the output window', () => {
    expect(debugHeaderLine(PAUSED)).toBe('Paused at app.py:42 · breakpoint');
    expect(launchSummary({ program: null, module: 'app.server', args: ['--port', '8000'], cwd: 'project', python: '.venv/bin/python', record: false })).toBe('.venv/bin/python -m app.server --port 8000  ·  cwd project');
    // no interpreter to name yet: nothing is guessed in its place
    expect(launchSummary({ program: 'app.py', module: null, args: [], cwd: 'project', python: null, record: false })).toBe('app.py  ·  cwd project');
    // the host sends `.` for a cwd that is the workspace folder itself
    expect(launchSummary({ program: null, module: 'api.main', args: [], cwd: '.', python: '.venv/bin/python', record: false })).toBe('.venv/bin/python -m api.main  ·  cwd .');
    expect(frameLabel(PAUSED.stack[1]!)).toBe('handle_one_request  http/server.py:427');
    expect(breakpointLabel({ file: 'app.py', line: 60, condition: 'i == 3' })).toBe('app.py:60  if i == 3');
    expect(breakpointLabel({ file: 'app.py', line: 60, resolvedLine: 61 })).toBe('app.py:60  -> resolved line 61');
    expect(breakpointLabel({ file: 'app.py', line: 60, error: 'no statement there' })).toBe('app.py:60  (no statement there)');
    expect(breakpointLabel({ file: 'demo.py', line: 41, function: 'rrf' })).toBe('rrf  demo.py:41');
    expect(watchLabel({ id: 'w1', exp: 'rank', kind: 'display' })).toBe('rank  (no value at this stop)');
    expect(watchLabel({ id: 'w1', exp: 'rank', kind: 'display', error: 'NameError' })).toBe('rank  (NameError)');
    // a watch has no value because the program has not stopped, not because the stop had none
    expect(watchValue({ id: 'w', exp: 'k', kind: 'display' }, true)).toEqual({ text: 'at the next pause', dim: true });
    expect(watchValue({ id: 'w', exp: 'k', kind: 'display' }, false)).toEqual({ text: 'no value at this stop', dim: true });
    expect(watchValue({ id: 'w', exp: 'k', kind: 'display', text: '2' }, true)).toEqual({ text: '2', dim: false });

    // the add form dropped this argument, so `+` could only ever make a displayed watch however
    // the user meant it, and break-when was reachable from the CLI alone
    expect(watchArg('display')).toBeUndefined();
    expect(watchArg('true')).toBe('true');
    expect(watchArg('change')).toBe('change');
  });
});

describe('frameRows', () => {
  it('lists closed locals as one row each, and an open one with its members under it', () => {
    const closed = frameRows(RRF_LOCALS, new Set());
    expect(closed.map((r) => [r.name, r.depth, r.expandable, r.type])).toEqual([
      ['scores', 0, true, 'dict'],
      ['best', 0, true, ''],
      ['k', 0, false, ''],
    ]);
    const open = frameRows(RRF_LOCALS, new Set(['scores']));
    expect(open.map((r) => `${'  '.repeat(r.depth)}${r.name} = ${r.text}`)).toEqual(['scores = {\'d1\': 0.0312, \'d2\': 0.0164}', '  d1 = 0.0312', '  d2 = 0.0164', "best = Candidate(doc='d1', score=0.5)", 'k = 60']);
    // a member's key is its local and its query path, so it is the same row across state pushes
    expect(open[1]!.key).toBe('scores\n["d1"]');
    expect(open[1]!.local).toBe('scores');
  });

  it('asks the runtime for members it has not sent, and for the rest of a capped container', () => {
    // `expandable` without `props`: the bag was cut at this depth; opening it is an expand request, not a toggle
    const deep = node('dict', '{…}', undefined, { expandable: true, length: 40 });
    const rows = frameRows([{ name: 'index', text: '{…}', valueBag: bag(deep) }], new Set(['index']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ expandable: true, needsLoad: true, open: false });
    // a capped list ends in a `…` row that loads more
    const capped = node('list', undefined, [{ name: '0', n: node('number', '1') }], { cappedElements: true, length: 500 });
    const more = frameRows([{ name: 'items', text: '[1, …]', valueBag: bag(capped) }], new Set(['items']));
    expect(more.map((r) => r.name)).toEqual(['items', '0', '…']);
    expect(more[2]).toMatchObject({ more: true, needsLoad: true, depth: 1, local: 'items' });
    // once loaded (the host spliced the reply in), the same key opens to the members
    const loaded = { ...deep, props: [{ ...node('number', '1'), name: 'a', queryPath: ['a'] }] };
    expect(frameRows([{ name: 'index', text: '{…}', valueBag: bag(loaded) }], new Set(['index'])).map((r) => r.name)).toEqual(['index', 'a']);
  });
});

describe('stackRows', () => {
  it('folds two or more consecutive library frames and opens them on request', () => {
    const stack = [
      { frameId: 0, name: 'rank', file: 'api/main.py', line: 52 },
      { frameId: 1, name: 'run', file: '', line: 1100, library: true },
      { frameId: 2, name: '_bootstrap_inner', file: '', line: 1082, library: true },
    ];
    expect(stackRows(stack, 0).map((r) => r.kind)).toEqual(['frame', 'library']);
    expect(stackRows(stack, 0, new Set([1])).map((r) => r.kind)).toEqual(['frame', 'frame', 'frame']);
    // the selected frame is never hidden in a fold
    expect(stackRows(stack, 2).map((r) => r.current)).toEqual([false, false, true]);
  });
});

describe('breakpointRows', () => {
  it('orders, mutes and collapses without the view', () => {
    const rows = breakpointRows(
      [
        { file: 'demo.py', line: 40 },
        { file: 'app.py', line: 42, rid: 88 },
        { file: 'demo.py', line: 73 },
      ],
      ['app.py'],
    );
    expect(rows.map((r) => [r.label, r.muted])).toEqual([
      ['app.py:42', false],
      ['2 in demo.py, not in this run', true],
    ]);
    expect(rows[1]!.group).toEqual({ file: 'demo.py', count: 2 });
    expect(rows[1]!.bp).toBeUndefined();
    // a file with one resolved breakpoint keeps every row of that file
    const mixed = breakpointRows([{ file: 'app.py', line: 42, rid: 88 }, { file: 'app.py', line: 60 }], ['app.py']);
    expect(mixed.map((r) => r.muted)).toEqual([false, false]);
    // a function breakpoint the runtime has not resolved names no file: pending, never collapsed
    const fn = breakpointRows([{ file: '', function: 'rrf' }], ['app.py']);
    expect(fn).toHaveLength(1);
    expect(fn[0]!.muted).toBe(true);
    expect(fn[0]!.label).toContain('not resolved yet');
    expect(breakpointRows([], ['app.py'])).toEqual([]);
  });
});
