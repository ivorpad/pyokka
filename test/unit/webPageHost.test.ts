import { describe, expect, it } from 'vitest';
import { LOG_PATH, PageHost, PROFILE_PATH, type CodeDecorations, type CodeView, type Link } from '../../web/pageHost';
import { runAgentCommand, webMcpTools } from '../../web/agent';
import { packSteps } from '../../src/timeMachine/traceModel';
import type { BridgeFile, BridgeToPage, PageToBridge, RequestBody } from '../../web/bridgeProtocol';
import type { HostToWebview } from '../../src/shared/webviewProtocol';
import type { RunEvent, RunnerMessage, StatementBinding } from '../../src/shared/protocol';
import type { TourDoc } from '../../src/session/tourTypes';

const SOURCE = ['def add(a, b):', '    s = a + b', '    return s', '', 'x = add(1, 2)', 'print(x)'].join('\n');
const MAIN: BridgeFile = { path: '/w/demo.py', displayName: 'demo.py', language: 'python', content: SOURCE };

class FakeCode implements CodeView {
  shown: string | undefined;
  last: CodeDecorations | undefined;
  narration: { text: string; line: number } | null = null;
  revealed: number[] = [];
  cursor: number | undefined;
  files = new Map<string, BridgeFile>();
  showFile(file: BridgeFile): void {
    this.shown = file.path;
    this.files.set(file.path, file);
  }
  setMain(file: BridgeFile): void {
    this.showFile(file);
  }
  shownPath(): string | undefined {
    return this.shown;
  }
  render(d: CodeDecorations): void {
    this.last = d;
  }
  reveal(line: number): void {
    this.revealed.push(line);
  }
  setNarration(n: { text: string; line: number } | null): void {
    this.narration = n;
  }
  cursorLine(): number | undefined {
    return this.cursor;
  }
  expression: string | undefined;
  expressionAtCursor(): string | undefined {
    return this.expression;
  }
}

class FakeLink implements Link {
  sent: PageToBridge[] = [];
  replies: RunnerMessage[] = [];
  send(msg: PageToBridge): void {
    this.sent.push(msg);
  }
  requests: RequestBody[] = [];
  debugRequests: RequestBody[] = [];
  request(body: RequestBody): Promise<RunnerMessage> {
    this.requests.push(body);
    return Promise.resolve(this.replies.shift() ?? { type: 'error', id: 0, message: 'none' });
  }
  debugRequest(body: RequestBody): Promise<RunnerMessage> {
    this.debugRequests.push(body);
    return Promise.resolve(this.replies.shift() ?? { type: 'error', id: 0, message: 'none' });
  }
}

function b64(steps: Int32Array): string {
  return Buffer.from(steps.buffer).toString('base64');
}

/** A run of SOURCE: module (rids 0..), add's def header, its body, the print. */
function runEvents(runId: string): RunEvent[] {
  // local ranges: 0 whole file, 1 def, 2 `s = a + b`, 3 `return s`, 4 `x = add(1, 2)`, 5 `print(x)`
  const ranges: [number, number, number, number][] = [[1, 0, 6, 8], [1, 0, 3, 12], [2, 4, 2, 13], [3, 4, 3, 12], [5, 0, 5, 13], [6, 0, 6, 8]];
  const steps = packSteps([[1, 0, 0], [4, 0, 0], [1, 1, 1, 4], [2, 1, 1], [3, 1, 1], [5, 0, 0]]);
  let seq = 0;
  const base = { runId };
  return [
    { ...base, seq: ++seq, type: 'run.started', pid: 1 },
    { ...base, seq: ++seq, type: 'file.instrumented', fileId: 1, path: MAIN.path, rangeBase: 0, ranges, statements: [1, 2, 3, 4, 5], functions: [{ rid: 1, name: 'add', bodyRange: [2, 4, 3, 12] }], magic: [] },
    { ...base, seq: ++seq, type: 'log', logId: 'l1', kind: 'log', fileId: 1, rid: 5, hit: 1, step: 5, text: '3', runtimeKey: 'k5' },
    { ...base, seq: ++seq, type: 'coverage', fileId: 1, states: [1, 1, 1, 1, 1, 1], hits: [1, 1, 1, 1, 1, 1] },
    { ...base, seq: ++seq, type: 'locals', entries: [{ step: 2, scopeId: 1, changes: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] }, { step: 4, scopeId: 1, changes: [{ name: 's', text: '3' }] }] },
    { ...base, seq: ++seq, type: 'trace', steps: b64(steps), scopes: [{ scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 5 }, { scopeId: 1, rid: 1, name: 'add', parent: 0, depth: 1, first: 2, last: 4, returned: '3' }], truncated: false },
    { ...base, seq: ++seq, type: 'run.finished', exitCode: 0, durationMs: 5, timedOut: false, stopped: false, stepCount: 6, logCount: 1 },
  ];
}

function setup() {
  const code = new FakeCode();
  const link = new FakeLink();
  const panel: HostToWebview[] = [];
  const host = new PageHost(link, code, (m) => panel.push(m));
  const feed = (m: BridgeToPage) => host.onBridge(m);
  feed({ type: 'hello', file: MAIN, runtime: { command: 'fake', ready: null }, watch: true, canNarrate: false });
  host.onPanel({ type: 'ready' });
  feed({ type: 'run.begin', runId: 'w-1', content: SOURCE, reason: 'start' });
  for (const ev of runEvents('w-1')) feed({ type: 'event', event: ev });
  return { code, link, panel, host, feed };
}

describe('PageHost', () => {
  it('feeds the panel what the extension would: init, entries, timeline, walkthrough, exceptions', () => {
    const { panel } = setup();
    const types = panel.map((m) => m.type);
    expect(types[0]).toBe('init');
    expect(types).toContain('timeline');
    expect(types).toContain('walkthrough');
    expect(types).toContain('exceptions');
    const appended = panel.filter((m): m is Extract<HostToWebview, { type: 'entries.append' }> => m.type === 'entries.append').flatMap((m) => m.entries);
    expect(appended).toEqual([expect.objectContaining({ logId: 'l1', file: 'demo.py', line: 6, text: '3' })]);
    const timeline = panel.find((m): m is Extract<HostToWebview, { type: 'timeline' }> => m.type === 'timeline' && m.model !== null);
    expect(timeline?.model?.stepCount).toBe(6);
    expect(timeline?.model?.lines).toEqual([1, 5, 1, 2, 3, 6]);
  });

  it('draws values and coverage in the code pane', () => {
    const { code } = setup();
    expect(code.last?.inline.get(6)).toBe('3');
    expect(code.last?.coverage.get(2)).toBe(1);
    expect(code.last?.current).toBeNull();
  });

  it('steps the Time Machine like the toolbar and reports where it is', () => {
    const { host, code, panel } = setup();
    expect(host.start({ line: 2 })).toBe(true);
    expect(host.nav.step).toBe(3);
    expect(code.last?.current).toEqual({ line: 2, col: 4 });
    expect(code.last?.callers).toEqual([5]);
    const st = host.state();
    expect(st).toMatchObject({ timeMachine: true, step: 3, location: { file: 'demo.py', line: 2, function: 'add' }, code: '    s = a + b' });
    expect(st.locals).toEqual([{ name: 'a', text: '1' }, { name: 'b', text: '2' }]);
    expect(st.stack.map((f) => f.function)).toEqual(['add', '<module>']);
    // the log on line 6 has not happened yet at step 3
    expect(st.values).toEqual([]);
    // the variables a step records were changed by the statement before it, so they show on that line
    expect(host.move('into')).toBe(true);
    expect(code.last?.inline.get(2)).toBe('s = 3');
    expect(host.move('back')).toBe(true);
    expect(host.move('out')).toBe(true);
    expect(host.state().location?.line).toBe(6);
    expect(host.move('back')).toBe(true);
    expect(host.state().locals).toEqual([{ name: 'a', text: '1' }, { name: 'b', text: '2' }, { name: 's', text: '3' }]);
    const dbg = panel.filter((m): m is Extract<HostToWebview, { type: 'debugger' }> => m.type === 'debugger').pop();
    expect(dbg?.state).toMatchObject({ active: true, currentStep: 4 });
    host.stop();
    expect(host.state().timeMachine).toBe(false);
  });

  it('keeps the Time Machine step across a re-run', () => {
    const { host, feed } = setup();
    host.start({ step: 4 });
    feed({ type: 'run.begin', runId: 'w-2', content: SOURCE, reason: 'disk' });
    for (const ev of runEvents('w-2')) feed({ type: 'event', event: ev });
    expect(host.state()).toMatchObject({ runId: 'w-2', timeMachine: true, step: 4 });
  });

  it('answers agent commands: move with a narration, say, eval', async () => {
    const { host, link, code } = setup();
    const moved = (await runAgentCommand(host, link, { action: 'goto', step: 2, say: 'add is called with 1 and 2' })) as { location: { line: number } };
    expect(moved.location.line).toBe(1);
    expect(code.narration).toEqual({ text: 'add is called with 1 and 2', line: 1 });
    const stepped = (await runAgentCommand(host, link, { action: 'step', kind: 'over' })) as { moved: boolean; state: { step: number; narration: unknown } };
    expect(stepped).toMatchObject({ moved: true, state: { step: 3, narration: null } });
    await runAgentCommand(host, link, { action: 'line', line: 6, say: 'prints 3' });
    expect(host.state()).toMatchObject({ step: 5, narration: { text: 'prints 3', line: 6 } });
    link.replies.push({ type: 'evaluated', id: 1, text: '3', valueBag: { runtimeKey: 'e', data: { type: 'number', value: '3', id: 'v', queryPath: [] } } });
    expect(await runAgentCommand(host, link, { action: 'eval', expression: 'x' })).toEqual({ text: '3' });
  });

  it('declares WebMCP tools that run the same commands', async () => {
    const { host, link } = setup();
    const tools = webMcpTools(host, link);
    expect(tools.map((t) => t.name)).toEqual(['pyokka_state', 'pyokka_goto', 'pyokka_step', 'pyokka_line', 'pyokka_say', 'pyokka_run', 'pyokka_eval', 'pyokka_var', 'pyokka_why', 'pyokka_watch', 'pyokka_breakpoint', 'pyokka_story', 'pyokka_profile', 'pyokka_debug', 'pyokka_scratchpad']);
    const step = tools.find((t) => t.name === 'pyokka_step')!;
    const out = await step.execute({ kind: 'into' });
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ moved: true });
    const bad = await tools.find((t) => t.name === 'pyokka_line')!.execute({ line: 2 });
    expect(bad.isError).toBeUndefined();
  });

  it('turns panel settings into a run config change for the bridge', () => {
    const { host, link } = setup();
    host.onPanel({ type: 'settings.update', patch: { runTimeoutMs: 5000, valuePeek: false }, scope: 'session' });
    expect(link.sent).toContainEqual({ type: 'config', patch: { timeoutMs: 5000 } });
  });
});

/** What each statement of SOURCE assigns and reads, as the runtime's `bindings` answers. */
const BINDINGS: StatementBinding[] = [
  { line: 1, col: 0, assigns: ['add'], reads: [] },
  { line: 2, col: 4, assigns: ['s'], reads: ['a', 'b'] },
  { line: 3, col: 4, assigns: [], reads: ['s'] },
  { line: 5, col: 0, assigns: ['x'], reads: ['add'] },
  { line: 6, col: 0, assigns: [], reads: ['print', 'x'] },
] as StatementBinding[];

const tick = () => new Promise((r) => setTimeout(r, 0));
const last = <T extends HostToWebview['type']>(panel: HostToWebview[], type: T) => panel.filter((m): m is Extract<HostToWebview, { type: T }> => m.type === type).pop();

describe('PageHost views', () => {
  it('answers the Variable History view from the recorded locals and the bindings', async () => {
    const { host, link, panel } = setup();
    link.replies.push({ type: 'bindings', id: 1, statements: BINDINGS });
    host.onPanel({ type: 'variable.query', name: 's' });
    for (let i = 0; i < 5; i++) await tick();
    expect(link.requests[0]).toEqual({ type: 'bindings', source: SOURCE });
    const view = last(panel, 'variable')!.view;
    expect(view.name).toBe('s');
    expect(view.history?.changes).toEqual([expect.objectContaining({ step: 3, line: 2, function: 'add', file: 'demo.py', text: '3' })]);
  });

  it('opens Show Variable History in the panel for the name given, else the one under the cursor', async () => {
    const { host, link, panel, code } = setup();
    link.replies.push({ type: 'bindings', id: 1, statements: BINDINGS });
    // the panel's command message carries the name, as a hover link sends it
    host.onPanel({ type: 'command', command: 'pyokka.showVariableHistory', args: [{ name: 's' }] });
    for (let i = 0; i < 5; i++) await tick();
    expect(last(panel, 'showView')).toEqual({ type: 'showView', view: 'variable' });
    expect(last(panel, 'variable')!.view.history?.changes).toEqual([expect.objectContaining({ step: 3, line: 2, function: 'add', text: '3' })]);
    code.expression = 'x';
    host.onPanel({ type: 'command', command: 'pyokka.showVariableHistory' });
    for (let i = 0; i < 5; i++) await tick();
    expect(last(panel, 'variable')!.view.name).toBe('x');
  });

  it('shows the live debugger\'s pauses in the Variable History view while it runs, and follows new pauses', async () => {
    const { host, link, panel, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 3);
    host.onPanel({ type: 'command', command: 'pyokka.debugCurrentFile' });
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: runEvents('d-1')[1]! });
    const pause = (seq: number, step: number, s: string) => {
      link.replies.length = 0;
      link.replies.push({ type: 'debug.result', id: seq, locals: [{ name: 'a', text: '1' }, { name: 's', text: s }] });
      feed({ type: 'debug.event', event: { runId: 'd-1', seq, type: 'debug.paused', step, rid: 3, fileId: 1, line: 3, scopeId: 1, depth: 1, reason: 'breakpoint', breakpoint: { path: MAIN.path, line: 3 }, stack: [{ frameId: 0, name: 'add', fileId: 1, line: 3 }] } });
    };
    pause(3, 4, '3');
    for (let i = 0; i < 5; i++) await tick();
    host.showVariableHistory('s');
    for (let i = 0; i < 5; i++) await tick();
    expect(last(panel, 'variable')!.view.history).toMatchObject({ pauses: true, changes: [{ step: 1, name: 's', text: '3', function: 'add', line: 3, file: 'demo.py' }] });
    host.onPanel({ type: 'debug.control', action: 'continue' });
    pause(5, 9, '7');
    for (let i = 0; i < 5; i++) await tick();
    expect(last(panel, 'variable')!.view.history?.changes.map((c) => [c.step, c.text])).toEqual([[1, '3'], [2, '7']]);
    // the session ends: the view shows the recording again
    link.replies.length = 0;
    link.replies.push({ type: 'bindings', id: 9, statements: BINDINGS });
    feed({ type: 'debug.end', runId: 'd-1' });
    for (let i = 0; i < 5; i++) await tick();
    const after = last(panel, 'variable')!.view.history;
    expect(after?.pauses).toBeUndefined();
    expect(after?.changes).toEqual([expect.objectContaining({ step: 3, function: 'add', text: '3' })]);
  });

  it('builds the Execution Diagram on request and follows the Time Machine', async () => {
    const { host, panel } = setup();
    host.onPanel({ type: 'executionGraph.request' });
    const graph = last(panel, 'executionGraph')!.graph!;
    expect(graph.runId).toBe('w-1');
    expect(graph.nodes.length).toBeGreaterThan(1);
    host.start({ step: 3 });
    await new Promise((r) => setTimeout(r, 80));
    const stack = last(panel, 'executionGraph.stack')!;
    expect(stack.step).toBe(3);
    expect(stack.stack.length).toBeGreaterThan(0);
  });

  it('sends the HTTP table of the run, and compares two entries', () => {
    const { host, panel } = setup();
    expect(last(panel, 'http')!.panel).toMatchObject({ runId: 'w-1', count: 0, requests: [] });
    host.onPanel({ type: 'compare', leftLogId: 'l1', rightLogId: 'l1' });
    expect(last(panel, 'diff')).toEqual({ type: 'diff', left: { title: 'demo.py:6', text: '3' }, right: { title: 'demo.py:6', text: '3' } });
    expect(last(panel, 'showView')).toEqual({ type: 'showView', view: 'diff' });
  });

  it('records a watch around the Time Machine step with one run, and shows its value', () => {
    const { host, link, panel, feed } = setup();
    host.start({ step: 3 });
    host.onPanel({ type: 'watch.add', exp: 'a + b' });
    const run = link.sent.filter((m) => m.type === 'run').pop() as Extract<typeof link.sent[number], { type: 'run' }>;
    expect(run.watch).toEqual([{ id: expect.any(String), exp: 'a + b' }]);
    expect(run.traceContext).toEqual({ step: 3, prefetch: 10 });
    const id = run.watch![0]!.id;
    feed({ type: 'run.begin', runId: 'w-2', content: SOURCE, reason: 'page' });
    const events = runEvents('w-2');
    events.splice(events.length - 1, 0, { runId: 'w-2', seq: 99, type: 'watch', watchId: id, step: 3, valueBag: { runtimeKey: 'w', data: { type: 'number', value: '3', id: 'w1', queryPath: [] } } });
    for (const ev of events) feed({ type: 'event', event: ev });
    const rows = last(panel, 'debugger')!.state.watches;
    expect(rows).toEqual([expect.objectContaining({ exp: 'a + b', step: 3, valueBag: expect.objectContaining({ runtimeKey: 'w' }) })]);
  });

  it('narrates through the bridge and shows the glosses in the walkthrough', () => {
    const { host, link, panel, feed } = setup();
    host.onPanel({ type: 'narrate' });
    expect(link.sent).toContainEqual({ type: 'narrate' });
    expect(last(panel, 'walkthrough')!.walkthrough!.narrating).toBe(true);
    feed({ type: 'narration', narration: { runId: 'w-1', narrating: false, glosses: { m0: 'the module starts' } } });
    const w = last(panel, 'walkthrough')!.walkthrough!;
    expect(w.narrating).toBe(false);
    expect(w.moments.find((m) => m.id === 'm0')?.gloss).toBe('the module starts');
  });

  it('asks the bridge for the tour when the section opens and draws it', () => {
    const { host, link, panel, feed } = setup();
    host.onPanel({ type: 'tour.open', open: true });
    expect(link.sent).toContainEqual({ type: 'tour', action: 'compute' });
    const doc: TourDoc = {
      tour: 1,
      run: { file: MAIN.path, steps: 6, exitCode: 0, durationMs: 5, http: 0, llm: 0 },
      goal: { kind: 'output', step: 5, text: 'prints 3' },
      small: true,
      budget: { tokens: 0, estimate: 0, found: 1, kept: 1, dropped: 0 },
      chapters: [{ id: 'c1', title: 'add', steps: [0, 5], llm: 0, http: 0 } as TourDoc['chapters'][number]],
      candidates: [{ id: 's1', key: 'k', step: 4, chapter: 'c1', file: 'demo.py', line: 3, function: 'add', scopeId: 1, statement: 'return s', signals: [{ signal: 'call:return' }], values: [{ id: 'v1', role: 'returned', name: 'add', length: 1, text: '3' }] } as unknown as TourDoc['candidates'][number]],
    };
    feed({ type: 'tour', tour: { runId: 'w-1', status: 'ready', doc, narrating: false } });
    const tour = last(panel, 'tour')!.tour!;
    expect(tour).toMatchObject({ status: 'ready', steps: 6, chapters: [expect.objectContaining({ id: 'c1', stops: 1 })] });
    expect(tour.stops[0]).toMatchObject({ id: 's1', fileId: 1, short: 'add = 3' });
    host.onPanel({ type: 'tour.goto', step: 4, stopId: 's1' });
    expect(host.state().step).toBe(4);
  });

  it('starts the live debugger at the first breakpoint, at the first statement only when none can hit', () => {
    const { host, link } = setup();
    const entries = () => link.sent.flatMap((m) => (m.type === 'debug.start' ? [m.stopOnEntry] : []));
    host.debug.start();
    // a file the recorded run never touched: that breakpoint cannot hit, so the run still stops somewhere
    host.debug.setBreakpoint('/w/lib.py', 4);
    host.debug.start();
    host.debug.setBreakpoint(MAIN.path, 2);
    host.debug.start();
    host.debug.start(undefined, true);
    expect(entries()).toEqual([true, true, false, true]);
  });

  it('evaluates an agent eval in the paused frame while the live debugger is paused', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 2);
    host.debug.start();
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: runEvents('d-1')[1]! });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', breakpoint: { path: MAIN.path, line: 2 }, stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }, { frameId: 1, name: '<module>', fileId: 1, line: 5 }] } });
    for (let i = 0; i < 5; i++) await tick();
    link.replies.push({ type: 'evaluated', id: 2, text: '3', valueBag: { runtimeKey: 'e', data: { type: 'int', value: '3', id: 'v', queryPath: [] } } });
    expect(await runAgentCommand(host, link, { action: 'eval', expression: 'a + b' })).toEqual({ text: '3', at: 'demo.py:2' });
    expect(link.debugRequests.at(-1)).toEqual({ type: 'evaluate', runId: 'd-1', expression: 'a + b' });
    // the recorded run, where `a` is not in scope, is never asked
    expect(link.requests.filter((r) => r.type === 'evaluate')).toEqual([]);
    link.replies.push({ type: 'error', id: 3, message: "NameError: name 'nope' is not defined" });
    await expect(runAgentCommand(host, link, { action: 'eval', expression: 'nope' })).rejects.toThrow("NameError: name 'nope' is not defined");
  });

  it('answers an agent debug start as soon as the run ends without pausing, with its exit code', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 2);
    const began = Date.now();
    const answer = runAgentCommand(host, link, { action: 'debug', op: 'start' });
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 9, type: 'run.finished', exitCode: 0, durationMs: 5, timedOut: false, stopped: false, stepCount: 6, logCount: 1 } });
    feed({ type: 'debug.end', runId: 'd-1' });
    expect(await answer).toMatchObject({ running: false, paused: false, exitCode: 0, errors: [] });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('says why a debug run ended: the uncaught error, its file and line', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 2);
    const answer = runAgentCommand(host, link, { action: 'debug', op: 'start' });
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    const message = "'(' was never closed";
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'error', fileId: 0, rid: 0, step: 0, message, errorType: 'SyntaxError', handled: false, stack: [{ fileId: 0, line: 2, col: 0, function: '<module>', path: '/w/bad.py' }] } });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 4, type: 'run.finished', exitCode: 1, durationMs: 5, timedOut: false, stopped: false, stepCount: 0, logCount: 0 } });
    feed({ type: 'debug.end', runId: 'd-1' });
    expect(await answer).toMatchObject({ running: false, exitCode: 1, errors: [{ type: 'SyntaxError', message, file: '/w/bad.py', line: 2 }] });
  });

  it('waitPause reads the cursor, then returns at the next pause or when its timeout runs out', async () => {
    const { host, link, feed } = setup();
    host.debug.setBreakpoint(MAIN.path, 2);
    host.debug.start();
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: runEvents('d-1')[1]! });
    const first = (await runAgentCommand(host, link, { action: 'waitPause' })) as { cursor: number; changed: boolean };
    expect(first).toEqual({ cursor: 0, changed: false });
    const timedOut = await runAgentCommand(host, link, { action: 'waitPause', after: 0, timeoutMs: 50 });
    expect(timedOut).toMatchObject({ cursor: 0, changed: false, timedOut: true });
    const waiting = runAgentCommand(host, link, { action: 'waitPause', after: 0, timeoutMs: 5000 });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'a', text: '1' }] });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', breakpoint: { path: MAIN.path, line: 2 }, stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }] } });
    expect(await waiting).toMatchObject({ cursor: 1, changed: true, state: { paused: true, location: 'demo.py:2' } });
  });

  it('runs the live debugger: breakpoints from the gutter, the pause, its variables', async () => {
    const { host, link, panel, feed, code } = setup();
    expect(host.debug.setBreakpoint(MAIN.path, 2)).toBe(true);
    host.render();
    expect([...(code.last?.breakpoints.keys() ?? [])]).toEqual([2]);
    host.onPanel({ type: 'command', command: 'pyokka.debugCurrentFile' });
    expect(link.sent).toContainEqual({ type: 'debug.start', breakpoints: [{ path: MAIN.path, line: 2 }], exceptions: 'uncaught', stopOnEntry: false });
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    const [, file] = runEvents('d-1');
    feed({ type: 'debug.event', event: file! });
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', breakpoint: { path: MAIN.path, line: 2 }, stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }, { frameId: 1, name: '<module>', fileId: 1, line: 5 }] } });
    for (let i = 0; i < 5; i++) await tick();
    expect(link.debugRequests[0]).toEqual({ type: 'debug', runId: 'd-1', action: 'locals' });
    const st = last(panel, 'debug.session')!.state!;
    expect(st).toMatchObject({ paused: true, reasonText: 'breakpoint', location: 'demo.py:2', stack: [{ name: 'add', file: 'demo.py', line: 2 }, { name: '<module>', file: 'demo.py', line: 5 }], locals: [{ name: 'a', text: '1' }, { name: 'b', text: '2' }] });
    host.render();
    expect(code.last?.paused).toBe(2);
    link.replies.push({ type: 'debug.result', id: 2 });
    host.onPanel({ type: 'debug.control', action: 'stepOver' });
    await tick();
    expect(link.debugRequests[1]).toEqual({ type: 'debug', runId: 'd-1', action: 'step', kind: 'over' });
    feed({ type: 'debug.end', runId: 'd-1' });
    expect(last(panel, 'debug.session')!.state).toMatchObject({ running: false, paused: false, reasonText: 'ended' });
  });

  it('answers the agent var, why and breakpoint commands', async () => {
    const { host, link } = setup();
    link.replies.push({ type: 'bindings', id: 1, statements: BINDINGS });
    const v = (await runAgentCommand(host, link, { action: 'var', name: 's' })) as { changes: { step: number; text: string }[] };
    expect(v.changes).toEqual([expect.objectContaining({ step: 3, line: 2, text: '3' })]);
    const why = (await runAgentCommand(host, link, { action: 'why', name: 's', step: 4 })) as { root: { name: string } };
    expect(why.root.name).toBe('s');
    expect(await runAgentCommand(host, link, { action: 'breakpoint', line: 3 })).toEqual({ line: 3, on: true, breakpoints: [{ line: 3 }] });
    expect(await runAgentCommand(host, link, { action: 'breakpoint', line: 3 })).toEqual({ line: 3, on: false, breakpoints: [] });
  });
});

describe('PageHost: the views VS Code opens as editors', () => {
  it('shows the Code Story in the right panel, following the Time Machine step, the code pane keeping the source', async () => {
    const { host, code, panel } = setup();
    expect(await host.openStory()).toBe(true);
    expect(last(panel, 'showView')).toEqual({ type: 'showView', view: 'story' });
    expect(code.shown).toBe(MAIN.path);
    const story = () => last(panel, 'story')!.story!;
    const text = story().rows.join('\n');
    const rowOf = (needle: string) => story().rows.map((l) => l.includes(needle)).lastIndexOf(true) + 1;
    // the module's pass, the call's pass through add, then the module again
    expect(text).toContain('5  x = add(1, 2)');
    expect(text).toContain('2      s = a + b');
    host.goto(3);
    const row = rowOf('s = a + b');
    expect(story().current).toMatchObject({ line: row });
    expect(story().picks).toContain(row);
    // the code pane follows the step in the source, as it does with the story closed
    expect(code.shown).toBe(MAIN.path);
    expect(code.last!.current?.line).toBe(2);
    // a row picked in the story moves the Time Machine to the step that ran it
    const printRow = rowOf('print(x)');
    host.onPanel({ type: 'story.pick', line: printRow });
    expect(host.nav.step).toBe(5);
    expect(story().values).toContainEqual({ line: printRow, text: '3', error: false });
    // Ctrl/Cmd+click opens the source line; stopping the Time Machine closes the story (D2)
    host.onPanel({ type: 'story.pick', line: printRow, open: true });
    expect(code.shown).toBe(MAIN.path);
    host.stop();
    expect(last(panel, 'story')).toEqual({ type: 'story', story: null });
    expect(code.shown).toBe(MAIN.path);
    expect(await runAgentCommand(host, new FakeLink(), { action: 'story' })).toMatchObject({ step: 0, row: expect.any(Number), text: expect.stringContaining('print(x)') });
  });

  it('stops following the step once the rail shows another view', async () => {
    const { host, panel } = setup();
    await host.openStory();
    host.onPanel({ type: 'viewChanged', view: 'story' });
    const sent = () => panel.filter((m) => m.type === 'story').length;
    host.goto(3);
    const before = sent();
    host.onPanel({ type: 'viewChanged', view: 'output' });
    host.goto(4);
    expect(sent()).toBe(before);
    expect(host.storyShown()).toBe(false);
  });

  it('asks the bridge for a profile and shows its table, rows opening their source', async () => {
    const { host, link, code, feed } = setup();
    host.onPanel({ type: 'command', command: 'pyokka.profile' });
    expect(link.sent).toContainEqual({ type: 'profile' });
    feed({ type: 'profile', profile: { path: '/tmp/p.cpuprofile', summary: { totalMs: 3, rows: [{ name: 'add', file: MAIN.path, line: 1, selfMs: 2, totalMs: 2.5, calls: 1 }] } } });
    expect(code.shown).toBe(PROFILE_PATH);
    expect(code.files.get(PROFILE_PATH)!.content).toMatch(/2\.00\s+2\.50\s+1 {2}add {2}demo\.py:1/);
    host.linePick(PROFILE_PATH, 3, 'open');
    expect(code.shown).toBe(MAIN.path);
  });

  it('shows the instrumented source, the logs, recent files, and honors the run mode', async () => {
    const { host, link, code, feed } = setup();
    link.replies.push({ type: 'source', id: 1, fileId: 1, instrumentedSource: '__pk.step(1)' });
    host.onPanel({ type: 'command', command: 'pyokka.showInstrumentedFile' });
    await tick();
    expect(link.requests).toContainEqual({ type: 'source', runId: 'w-1', fileId: 1 });
    expect(code.shown).toBe('pyokka://instrumented/demo.py');
    expect(code.files.get(code.shown!)!.content).toBe('__pk.step(1)');
    host.onPanel({ type: 'command', command: 'pyokka.showLogs' });
    expect(link.sent).toContainEqual({ type: 'file.read', path: LOG_PATH });
    host.onPanel({ type: 'command', command: 'pyokka.viewRecentFiles' });
    expect(link.sent).toContainEqual({ type: 'recent' });
    let listed: string[] = [];
    host.onRecent = (files) => (listed = files.map((f) => f.path));
    feed({ type: 'recent', files: [{ path: '/w/other.py', displayName: 'other.py', at: 1 }] });
    expect(listed).toEqual(['/w/other.py']);
    host.openFile('/w/other.py');
    expect(link.sent).toContainEqual({ type: 'open', path: '/w/other.py' });
    feed({ type: 'hello', file: { ...MAIN, path: '/w/other.py', displayName: 'other.py' }, runtime: { command: 'fake', ready: null }, watch: true, canNarrate: false });
    expect(host.main?.path).toBe('/w/other.py');
    host.onPanel({ type: 'settings.update', patch: { runMode: 'onDemand' }, scope: 'session' });
    expect(link.sent).toContainEqual({ type: 'runMode', mode: 'onDemand' });
  });
});

describe('agent control checks', () => {
  /** setup() with the live debugger paused in add() at line 2, its locals arrived */
  async function paused() {
    const s = setup();
    s.feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    s.feed({ type: 'debug.event', event: runEvents('d-1')[1]! });
    s.link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'a', text: '1' }] });
    s.feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }, { frameId: 1, name: '<module>', fileId: 1, line: 5 }] } });
    for (let i = 0; i < 5; i++) await tick();
    return s;
  }

  it('reports the live pause as the context beside the recording, and refuses a stale expectation before acting', async () => {
    const { host, link } = await paused();
    expect(host.state()).toMatchObject({ runId: 'w-1', context: { source: 'live', runId: 'd-1', paused: true, step: 3, frame: 0, file: MAIN.path, line: 2, localsReady: true, locals: [{ name: 'a', text: '1' }] } });
    await expect(runAgentCommand(host, link, { action: 'say', text: 'old run', expect: { runId: 'w-1' } })).rejects.toThrow('stale context: runId');
    await expect(runAgentCommand(host, link, { action: 'debug', op: 'step', kind: 'over', expect: { step: 2 } })).rejects.toThrow('stale context: step');
    expect(host.narration).toBeNull();
    expect(link.debugRequests.filter((r) => r.type === 'debug' && r.action === 'step')).toEqual([]);
    // the same check through WebMCP
    const say = webMcpTools(host, link).find((t) => t.name === 'pyokka_say')!;
    expect((await say.execute({ text: 'old frame', expect: { frame: 1 } })).isError).toBe(true);
    expect(host.narration).toBeNull();
  });

  it('refuses recording navigation while the live debugger runs, and a second command while one is pending', async () => {
    const { host, link } = await paused();
    await expect(runAgentCommand(host, link, { action: 'step', kind: 'over' })).rejects.toThrow('live debugger is active');
    // while a step is in flight a second command is refused; the runtime's refusal of the step reaches the agent
    link.replies.push({ type: 'error', id: 2, message: 'runtime refused step' });
    const first = runAgentCommand(host, link, { action: 'debug', op: 'step', kind: 'over' });
    await expect(runAgentCommand(host, link, { action: 'clear' })).rejects.toThrow('pending');
    await expect(first).rejects.toThrow('runtime refused step');
  });
});

describe('step next', () => {
  it('moves exactly one recorded event, into a call where over would skip it, and stops at the last', async () => {
    const { host, link } = setup();
    await runAgentCommand(host, link, { action: 'goto', step: 1 });
    expect(await runAgentCommand(host, link, { action: 'step', kind: 'next' })).toMatchObject({ moved: true, state: { step: 2, location: { line: 1, function: 'add' } } });
    await runAgentCommand(host, link, { action: 'goto', step: 5 });
    expect(await runAgentCommand(host, link, { action: 'step', kind: 'next' })).toMatchObject({ moved: false, state: { step: 5 } });
  });
});

describe('imported sources', () => {
  it('shows a shown import\'s new text from disk without moving the Time Machine or running', async () => {
    const { host, link, code, feed } = setup();
    await runAgentCommand(host, link, { action: 'goto', step: 3 });
    const lib: BridgeFile = { path: '/w/lib.py', displayName: 'lib.py', language: 'python', content: 'X = 1\n' };
    code.showFile(lib);
    feed({ type: 'file', file: lib });
    const sent = link.sent.length;
    feed({ type: 'file', file: { ...lib, content: 'X = 2\n' } });
    expect(code.shown).toBe(lib.path);
    expect(code.files.get(lib.path)?.content).toBe('X = 2\n');
    expect(host.nav.step).toBe(3);
    expect(link.sent.slice(sent).some((m) => m.type === 'run' || m.type === 'debug.start')).toBe(false);
  });
});

describe('peek', () => {
  it('returns the paused binding as a ValueNode tree, walks a dotted path, and expands a child the pause did not capture', async () => {
    const { host, link, feed } = setup();
    feed({ type: 'debug.begin', runId: 'd-1', content: SOURCE });
    feed({ type: 'debug.event', event: runEvents('d-1')[1]! });
    const cfg = { type: 'dict', id: 'v1', queryPath: [], length: 2, expandable: true, props: [
      { name: 'name', type: 'str', value: "'job'", id: 'v1', queryPath: ['name'] },
      { name: 'opts', type: 'dict', length: 1, id: 'v1', queryPath: ['opts'], expandable: true },
    ] } as const;
    link.replies.push({ type: 'debug.result', id: 1, locals: [{ name: 'cfg', text: "{'name': 'job', 'opts': {...}}", valueBag: { runtimeKey: 'k', data: cfg } }] } as RunnerMessage);
    feed({ type: 'debug.event', event: { runId: 'd-1', seq: 3, type: 'debug.paused', step: 3, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', stack: [{ frameId: 0, name: 'add', fileId: 1, line: 2 }] } });
    for (let i = 0; i < 5; i++) await tick();
    expect(await runAgentCommand(host, link, { action: 'peek', name: 'cfg' })).toMatchObject({ name: 'cfg', node: { type: 'dict', props: [{ name: 'name', value: "'job'" }, { name: 'opts' }] }, observed: { runId: 'd-1', step: 3, frame: 0, file: MAIN.path, line: 2 } });
    link.replies.push({ type: 'value', id: 2, node: { type: 'dict', id: 'v1', queryPath: ['opts'], length: 1, props: [{ name: 'retries', type: 'int', value: '3', id: 'v1', queryPath: ['opts', 'retries'] }] } });
    expect(await runAgentCommand(host, link, { action: 'peek', name: 'cfg.opts.retries' })).toMatchObject({ node: { type: 'int', value: '3' } });
    expect(link.debugRequests.filter((r) => r.type === 'expand')).toEqual([{ type: 'expand', runId: 'd-1', valueId: 'v1', queryPath: ['opts'] }]);
    await expect(runAgentCommand(host, link, { action: 'peek', name: 'nope' })).rejects.toThrow('no binding nope');
    // nothing was evaluated
    expect(link.debugRequests.some((r) => r.type === 'evaluate')).toBe(false);
  });
});
