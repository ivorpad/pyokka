import { describe, expect, it } from 'vitest';
import { CAPABILITIES, DapTranslator, THREAD_ID, describe as describePause, type DebugSessionLike } from '../../src/debug/dapTranslator';
import type { DapMessage, DapRequest, DapResponse, DapEvent } from '../../src/debug/dapTypes';
import type { BreakpointSpec, BreakWatchSpec, DebugState, ExceptionMode, LocalVar, PausedInfo } from '../../src/session/debugState';
import type { LaunchConfig } from '../../src/debug/debugSessionState';
import type { ValueNode } from '../../src/shared/protocol';
import type { ExecResult } from '../../src/debug/debugExec';

function node(type: string, value: string | undefined, props?: { name: string; n: ValueNode }[], extra: Partial<ValueNode> = {}): ValueNode {
  const out: ValueNode = { type: type as ValueNode['type'], id: `${type}-${value ?? 'x'}`, queryPath: [], ...extra };
  if (value !== undefined) out.value = value;
  if (props) {
    out.props = props.map((p) => ({ ...p.n, name: p.name }));
    out.length = props.length;
  }
  return out;
}

class FakeSession implements DebugSessionLike {
  id = 'debug-1';
  kind = 'debug' as const;
  displayName = 'rank.py';
  record = false;
  launch: LaunchConfig | undefined = { program: '/w/rank.py', args: [], cwd: '/w', env: {}, stopOnEntry: false, breakOnException: 'uncaught', libraryCode: false, record: false };
  running = true;
  output = '';
  modified = false;
  thread: { name: string; ident: number } | undefined = { name: 'MainThread', ident: 1 };
  debug: DebugState = { active: false, paused: undefined, frontier: undefined, breakpoints: [{ path: '/w/rank.py', line: 4, condition: 'i == 3' }], watches: [], exceptions: 'uncaught', modified: false, runId: 'r-1' };
  calls: string[] = [];
  locals: LocalVar[] = [];
  /** locals per frame; `locals` above answers for any frame the test did not set */
  localsByFrame = new Map<number, LocalVar[]>();
  private pausedFns: ((info: PausedInfo) => void)[] = [];
  private resumedFns: (() => void)[] = [];
  private finishedFns: ((code: number | null) => void)[] = [];
  async startDebug(opts?: { stopOnEntry?: boolean }): Promise<void> {
    this.calls.push(opts?.stopOnEntry ? 'startDebug stopOnEntry' : 'startDebug');
    this.debug = { ...this.debug, active: true };
  }
  stopDebug(): void {
    this.calls.push('stopDebug');
  }
  async restart(opts: { stopOnEntry?: boolean }): Promise<void> {
    this.calls.push(opts.stopOnEntry ? 'restart stopOnEntry' : 'restart');
  }
  async debugContinue(): Promise<void> {
    this.calls.push('continue');
  }
  async debugStep(kind: 'into' | 'over' | 'out'): Promise<void> {
    this.calls.push(`step ${kind}`);
  }
  async debugPause(): Promise<void> {
    this.calls.push('pause');
  }
  async debugLocals(opts?: { frameId?: number }): Promise<LocalVar[]> {
    this.calls.push(opts?.frameId ? `locals frame ${opts.frameId}` : 'locals');
    return this.localsByFrame.get(opts?.frameId ?? 0) ?? this.locals;
  }
  /** every list `setDebugBreakpoints` was given, newest last */
  breakpointSets: BreakpointSpec[][] = [];
  async setDebugBreakpoints(specs: BreakpointSpec[]): Promise<BreakpointSpec[]> {
    this.calls.push(`breakpoints ${specs.length}`);
    this.breakpointSets.push(specs);
    this.debug = { ...this.debug, breakpoints: specs };
    return specs;
  }
  async setDebugWatches(specs: BreakWatchSpec[]): Promise<void> {
    this.calls.push(`watches ${specs.length}`);
  }
  async runToLine(file: string, line: number): Promise<void> {
    this.calls.push(`runToLine ${file}:${line}`);
  }
  async waitForPause(): Promise<PausedInfo | 'finished'> {
    return this.debug.paused ?? 'finished';
  }
  async setDebugExceptions(mode: ExceptionMode): Promise<void> {
    this.calls.push(`exceptions ${mode}`);
    this.debug = { ...this.debug, exceptions: mode };
  }
  async evaluate(expression: string, opts?: { frameId?: number }) {
    this.calls.push(opts?.frameId ? `eval ${expression} frame ${opts.frameId}` : `eval ${expression}`);
    if (expression === 'missing') return undefined;
    return { text: '0.5833', valueBag: { data: node('number', '0.5833'), runtimeKey: 'e:1' } };
  }
  /** what the next `exec` answers; the default is a statement with no value */
  execResult: ExecResult = { text: '', modified: true };
  async exec(source: string, opts?: { frameId?: number }): Promise<ExecResult> {
    this.calls.push(opts?.frameId ? `exec ${source} frame ${opts.frameId}` : `exec ${source}`);
    this.modified = true;
    return this.execResult;
  }
  async complete(text: string) {
    this.calls.push(`complete ${JSON.stringify(text)}`);
    if (text.endsWith('.')) return { prefix: '', items: [{ label: 'items', kind: 'method' as const }, { label: 'keys', kind: 'method' as const }] };
    const prefix = /[A-Za-z_]\w*$/.exec(text)?.[0] ?? '';
    return { prefix, items: prefix && 'payload'.startsWith(prefix) ? [{ label: 'payload', kind: 'variable' as const, type: 'dict' }, { label: 'Point', kind: 'class' as const }] : [] };
  }
  async expand(valueId: string, queryPath: string[]) {
    this.calls.push(`expand ${valueId} ${queryPath.join('/')}`);
    return node('list', undefined, [{ name: '5', n: node('number', '5') }, { name: '6', n: node('number', '6') }]);
  }
  pathForFileId(fileId: number): string | undefined {
    return fileId === 1 ? '/w/rank.py' : fileId === 2 ? '/w/helper.py' : undefined;
  }
  locate(rid: number) {
    return rid === 0 ? { path: '/w/rank.py', line: 1 } : rid === 40 ? { path: '/w/helper.py', line: 12 } : undefined;
  }
  terminate(): void {
    this.calls.push('terminate');
  }
  onPaused(fn: (info: PausedInfo) => void) {
    this.pausedFns.push(fn);
    return () => void (this.pausedFns = this.pausedFns.filter((f) => f !== fn));
  }
  onResumed(fn: () => void) {
    this.resumedFns.push(fn);
    return () => void (this.resumedFns = this.resumedFns.filter((f) => f !== fn));
  }
  onFinished(fn: (code: number | null) => void) {
    this.finishedFns.push(fn);
    return () => void (this.finishedFns = this.finishedFns.filter((f) => f !== fn));
  }
  pause(info: PausedInfo): void {
    this.debug = { ...this.debug, paused: info, frontier: info.step };
    for (const f of this.pausedFns) f(info);
  }
  resume(): void {
    this.debug = { ...this.debug, paused: undefined, frontier: undefined };
    for (const f of this.resumedFns) f();
  }
  finish(code: number | null): void {
    for (const f of this.finishedFns) f(code);
  }
}

/** a `record: false` pause: the frame chain, with the caller's real line */
const FRAME_PAUSE: PausedInfo = {
  step: 1403,
  rid: 88,
  fileId: 2,
  line: 42,
  scopeId: 7,
  depth: 2,
  reason: 'breakpoint',
  thread: { name: 'Thread-3', ident: 6108209152 },
  stack: [
    { frameId: 0, name: 'do_GET', fileId: 2, line: 42 },
    { frameId: 1, name: 'handle_one_request', fileId: 0, line: 427 },
    { frameId: 2, name: '<module>', fileId: 1, line: 31 },
  ],
};

const PAUSE: PausedInfo = {
  step: 3412,
  rid: 17,
  fileId: 2,
  line: 13,
  scopeId: 3,
  depth: 1,
  reason: 'breakpoint',
  breakpoint: { path: '/w/helper.py', line: 13, condition: 'i == 3', rid: 17, fileId: 2, resolvedLine: 13 },
  stack: [
    { scopeId: 3, name: 'twice', rid: 40, depth: 1 },
    { scopeId: 0, name: '<module>', rid: 0, depth: 0 },
  ],
};

function harness() {
  const session = new FakeSession();
  const out: DapMessage[] = [];
  const t = new DapTranslator(async (launch, opts) => {
    session.calls.push(`resolve ${launch.module ? `-m ${launch.module}` : launch.program}${opts.stopOnEntry ? ' stopOnEntry' : ''}${launch.record ? ' record' : ''}`);
    return session;
  }, (m) => out.push(m));
  let seq = 0;
  const send = async (command: string, args?: Record<string, unknown>): Promise<DapResponse> => {
    const req: DapRequest = { seq: ++seq, type: 'request', command, arguments: args };
    await t.handle(req);
    const res = out.filter((m): m is DapResponse => m.type === 'response' && m.request_seq === req.seq);
    expect(res).toHaveLength(1);
    return res[0]!;
  };
  const events = (name?: string): DapEvent[] => out.filter((m): m is DapEvent => m.type === 'event' && (!name || m.event === name));
  return { session, out, t, send, events };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('DapTranslator', () => {
  it('answers initialize with the capabilities, then announces initialized, and launch starts a debug run on the program', async () => {
    const { session, send, events } = harness();
    const init = await send('initialize', { adapterID: 'pyokka' });
    expect(init.success).toBe(true);
    expect(init.body).toEqual(CAPABILITIES);
    expect(CAPABILITIES.supportsSetVariable).toBe(true);
    await flush();
    expect(events('initialized')).toHaveLength(1);
    const launch = await send('launch', { program: '/w/rank.py' });
    expect(launch.success).toBe(true);
    expect(session.calls).toEqual(['resolve /w/rank.py', 'startDebug']);
    expect((await send('configurationDone')).success).toBe(true);
    const bad = await send('launch', {});
    expect(bad.success).toBe(false);
    expect(bad.message).toContain('program');
    // every launch attribute goes through parseLaunch: a module launch names no program
    const mod = harness();
    await mod.send('launch', { module: 'app.server', args: ['--port', '8000'], cwd: '/w', record: false });
    expect(mod.session.calls).toEqual(['resolve -m app.server', 'startDebug']);
    // the run goes to the first breakpoint unless the configuration asks to stop on entry
    const entry = harness();
    await entry.send('launch', { program: '/w/rank.py', stopOnEntry: true });
    expect(entry.session.calls).toEqual(['resolve /w/rank.py stopOnEntry', 'startDebug stopOnEntry']);
  });

  it('turns a pause into a stopped event with the DAP reason and a description, a resume into continued', async () => {
    const { session, send, events } = harness();
    await send('launch', { program: '/w/rank.py' });
    session.pause(PAUSE);
    const [stopped] = events('stopped');
    expect(stopped?.body).toEqual({ reason: 'breakpoint', threadId: THREAD_ID, allThreadsStopped: true, description: 'Paused at helper.py:13 (breakpoint if i == 3)' });
    session.resume();
    expect(events('continued')[0]?.body).toEqual({ threadId: THREAD_ID, allThreadsContinued: true });
    session.pause({ ...PAUSE, reason: 'watch', watch: { id: 'w1', exp: 'payload is None', text: 'True' } });
    const watch = events('stopped')[1]!.body as { reason: string; text?: string };
    expect(watch.reason).toBe('data breakpoint');
    expect(watch.text).toBe('payload is None → True');
    session.pause({ ...PAUSE, reason: 'start' });
    expect((events('stopped')[2]!.body as { reason: string }).reason).toBe('entry');
    session.pause({ ...PAUSE, reason: 'step', kind: 'over' });
    expect((events('stopped')[3]!.body as { description: string }).description).toContain('step over');
    expect(describePause({ ...PAUSE, reason: 'pause' })).toBe('pause');
  });

  it('offers the two exception filters, maps them to a mode before and after launch, and answers exceptionInfo at the pause', async () => {
    expect(CAPABILITIES.exceptionBreakpointFilters).toEqual([
      { filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
      { filter: 'raised', label: 'Raised Exceptions', default: false },
    ]);
    expect(CAPABILITIES.supportsExceptionInfoRequest).toBe(true);
    const { session, send, events } = harness();
    // VS Code ticks the boxes before launch resolves: the mode waits for the session and reaches it at attach
    expect((await send('setExceptionBreakpoints', { filters: ['raised', 'uncaught'] })).success).toBe(true);
    expect(session.calls).toEqual([]);
    await send('launch', { program: '/w/rank.py' });
    expect(session.calls).toEqual(['resolve /w/rank.py', 'exceptions raised', 'startDebug']);
    await send('configurationDone');
    // a click in the Breakpoints view after configuration always applies, an empty list included
    await send('setExceptionBreakpoints', { filters: ['uncaught'] });
    expect(session.debug.exceptions).toBe('uncaught');
    await send('setExceptionBreakpoints', { filters: [] });
    expect(session.debug.exceptions).toBe('off');

    const exception = { type: 'ValueError', message: 'too big: 3', uncaught: true };
    session.pause({ ...PAUSE, reason: 'exception', exception });
    const body = events('stopped')[0]!.body as { reason: string; text?: string; description?: string };
    expect(body.reason).toBe('exception');
    expect(body.text).toBe('ValueError: too big: 3');
    expect(body.description).toBe('Paused at helper.py:13 (uncaught ValueError: too big: 3)');
    expect(describePause({ ...PAUSE, reason: 'exception', exception })).toBe('uncaught ValueError: too big: 3');
    expect(describePause({ ...PAUSE, reason: 'exception', exception: { ...exception, uncaught: false } })).toBe('raised ValueError: too big: 3');
    expect((await send('exceptionInfo', { threadId: THREAD_ID })).body).toEqual({ exceptionId: 'ValueError', description: 'too big: 3', breakMode: 'unhandled', details: { message: 'too big: 3', typeName: 'ValueError' } });
    session.pause({ ...PAUSE, reason: 'exception', exception: { ...exception, uncaught: false } });
    expect(((await send('exceptionInfo', { threadId: THREAD_ID })).body as { breakMode: string }).breakMode).toBe('always');
  });

  it("leaves the session's own exception mode alone when the client's list says nothing", async () => {
    // VS Code sends `filters: []` before launch for a debug type it has not shown yet, and the
    // declared default otherwise: neither may undo the mode the panel or an agent set
    for (const filters of [[], ['uncaught']]) {
      const { session, send } = harness();
      await session.setDebugExceptions('raised');
      session.calls.length = 0;
      await send('setExceptionBreakpoints', { filters });
      await send('launch', { program: '/w/rank.py' });
      expect(session.debug.exceptions).toBe('raised');
      expect(session.calls).toEqual(['resolve /w/rank.py', 'startDebug']);
    }
  });

  it('builds one thread, the stack from the scope chain, a Locals scope for the top frame and variables from the locals', async () => {
    const { session, send } = harness();
    await send('launch', { program: '/w/rank.py' });
    expect((await send('threads')).body).toEqual({ threads: [{ id: 1, name: 'rank.py' }] });
    expect((await send('stackTrace', { threadId: 1 })).body).toEqual({ stackFrames: [], totalFrames: 0 });
    session.pause(PAUSE);
    const stack = (await send('stackTrace', { threadId: 1 })).body as { stackFrames: { id: number; name: string; line: number; source?: { path: string }; presentationHint?: string }[] };
    expect(stack.stackFrames).toEqual([
      { id: 1, name: 'twice', source: { name: 'helper.py', path: '/w/helper.py' }, line: 13, column: 1 },
      { id: 2, name: '<module>', source: { name: 'rank.py', path: '/w/rank.py' }, line: 1, column: 1, presentationHint: 'subtle' },
    ]);
    const scopes = (await send('scopes', { frameId: 1 })).body as { scopes: { name: string; variablesReference: number; expensive: boolean }[] };
    expect(scopes.scopes[0]?.name).toBe('Locals');
    expect(scopes.scopes[0]?.expensive).toBe(false);
    const localsRef = scopes.scopes[0]!.variablesReference;
    expect(localsRef).toBeGreaterThan(0);
    // every frame gets a reference of its own: debugLocals({frameId}) answers for any frame
    const other = (await send('scopes', { frameId: 2 })).body as { scopes: { variablesReference: number; expensive: boolean }[] };
    expect(other.scopes[0]!.expensive).toBe(false);
    expect(other.scopes[0]!.variablesReference).toBeGreaterThan(0);
    expect(other.scopes[0]!.variablesReference).not.toBe(localsRef);
    session.locals = [
      { name: 'n', text: '21', valueBag: { data: node('number', '21'), runtimeKey: 'd:1' } },
      { name: 'payload', text: "{'path': 'a.yaml', 'score': 0.5}", valueBag: { data: node('dict', undefined, [{ name: 'path', n: node('string', "'a.yaml'") }, { name: 'score', n: node('number', '0.5') }]), runtimeKey: 'd:2' } },
      { name: 'items', text: '[…]', valueBag: { data: node('list', undefined, [{ name: '0', n: node('number', '1') }, { name: '…', n: node('list', undefined, undefined, { loadActionNode: true, id: 'items +', queryPath: ['items'] }) }]), runtimeKey: 'd:3' } },
    ];
    const vars = (await send('variables', { variablesReference: localsRef })).body as { variables: { name: string; value: string; type?: string; variablesReference: number; namedVariables?: number; indexedVariables?: number; evaluateName?: string }[] };
    expect(vars.variables.map((v) => [v.name, v.value, v.type, v.variablesReference > 0])).toEqual([
      ['n', '21', 'number', false],
      ['payload', "{'path': 'a.yaml', 'score': 0.5}", 'dict', true],
      ['items', '[…]', 'list', true],
    ]);
    expect(vars.variables[1]?.namedVariables).toBe(2);
    expect(vars.variables[2]?.indexedVariables).toBe(2);
    expect(vars.variables[0]?.evaluateName).toBe('n');
    expect(session.calls.filter((c) => c === 'locals')).toHaveLength(1);
    const nested = (await send('variables', { variablesReference: vars.variables[1]!.variablesReference })).body as { variables: { name: string; value: string; variablesReference: number }[] };
    expect(nested.variables).toEqual([
      { name: 'path', value: "'a.yaml'", type: 'string', variablesReference: 0 },
      { name: 'score', value: '0.5', type: 'number', variablesReference: 0 },
    ]);
    const list = (await send('variables', { variablesReference: vars.variables[2]!.variablesReference })).body as { variables: { name: string; value: string; variablesReference: number }[] };
    expect(list.variables[1]).toMatchObject({ name: '…', value: 'more elements not loaded' });
    expect(list.variables[1]!.variablesReference).toBeGreaterThan(0);
    const loaded = (await send('variables', { variablesReference: list.variables[1]!.variablesReference })).body as { variables: { name: string; value: string }[] };
    expect(loaded.variables.map((v) => v.value)).toEqual(['5', '6']);
    expect(session.calls).toContain('expand items + items');
    // a new pause invalidates the references and the cached locals
    session.pause({ ...PAUSE, step: 3500 });
    expect((await send('variables', { variablesReference: localsRef })).body).toEqual({ variables: [] });
  });

  it('evaluates in the paused frame only, with a reference when the value has children', async () => {
    const { session, send } = harness();
    await send('launch', { program: '/w/rank.py' });
    const before = await send('evaluate', { expression: 'score', context: 'hover' });
    expect(before.success).toBe(false);
    session.pause(PAUSE);
    const ok = await send('evaluate', { expression: 'score', context: 'hover' });
    expect(ok.body).toEqual({ result: '0.5833', type: 'number', variablesReference: 0 });
    expect(session.calls).toContain('eval score');
    const missing = await send('evaluate', { expression: 'missing', context: 'watch' });
    expect(missing.success).toBe(false);
    // an empty Watch row or a bare Enter in the Debug Console never reaches the runtime
    const blank = await send('evaluate', { expression: '  ', context: 'watch' });
    expect(blank.body).toEqual({ result: '', variablesReference: 0 });
    expect(session.calls).not.toContain('eval   ');
  });

  it('runs the Debug Console through exec and every other context through evaluate', async () => {
    const { session, send } = harness();
    await send('launch', { program: '/w/rank.py' });
    session.pause(FRAME_PAUSE);
    // the console: a statement runs, and its value comes back as the result
    session.execResult = { text: "'last'", modified: true, valueBag: { data: node('string', "'last'"), runtimeKey: 'x:7' } };
    const repl = await send('evaluate', { expression: 'items.pop()', context: 'repl', frameId: 2 });
    expect(repl.body).toEqual({ result: "'last'", type: 'string', variablesReference: 0 });
    // a DAP frame id is 1-based here, so frame 2 is index 1 of the pause's frame chain
    expect(session.calls).toContain('exec items.pop() frame 1');
    // a statement that raised: the request succeeded, the statement did not
    session.execResult = { text: '', modified: true, exception: { type: 'ZeroDivisionError', message: 'division by zero' } };
    const raised = await send('evaluate', { expression: '1/0', context: 'repl' });
    expect(raised.success).toBe(true);
    expect((raised.body as { result: string }).result).toBe('ZeroDivisionError: division by zero');
    // a hover and a watch stay pure: nothing reaches exec
    session.calls.length = 0;
    await send('evaluate', { expression: 'score', context: 'hover' });
    await send('evaluate', { expression: 'score', context: 'watch' });
    await send('evaluate', { expression: 'score' });
    expect(session.calls.filter((c) => c.startsWith('exec'))).toEqual([]);
    expect(session.calls.filter((c) => c.startsWith('eval'))).toHaveLength(3);
  });

  it('writes a variable through exec and reports the value the program now holds', async () => {
    const { session, send } = harness();
    await send('launch', { program: '/w/rank.py' });
    session.pause(FRAME_PAUSE);
    session.locals = [{ name: 'rank', text: '2', valueBag: { data: node('number', '2'), runtimeKey: 'd:1' } }];
    const scopes = (await send('scopes', { frameId: 1 })).body as { scopes: { variablesReference: number }[] };
    const localsRef = scopes.scopes[0]!.variablesReference;
    const vars = (await send('variables', { variablesReference: localsRef })).body as { variables: { name: string; variablesReference: number }[] };
    const written = await send('setVariable', { variablesReference: localsRef, name: 'rank', value: '3' });
    expect(session.calls).toContain('exec rank = 3');
    // the reply is `evaluate` of the same path, not what was typed
    expect(written.body).toEqual({ value: '0.5833', type: 'number', variablesReference: 0 });
    expect(session.modified).toBe(true);
    // a nested node writes through its expression path
    session.locals = [{ name: 'payload', text: '{…}', valueBag: { data: node('dict', undefined, [{ name: 'q', n: { ...node('string', "'a'"), expressionPath: "payload['q']" } }]), runtimeKey: 'd:2' } }];
    session.pause({ ...FRAME_PAUSE, step: 1404 });
    const again = (await send('scopes', { frameId: 1 })).body as { scopes: { variablesReference: number }[] };
    const ref2 = again.scopes[0]!.variablesReference;
    const rows = (await send('variables', { variablesReference: ref2 })).body as { variables: { variablesReference: number }[] };
    await send('setVariable', { variablesReference: rows.variables[0]!.variablesReference, name: 'q', value: "'b'" });
    expect(session.calls).toContain("exec payload['q'] = 'b'");
    // a statement that raised is a failed write, not a silent one
    session.execResult = { text: '', modified: true, exception: { type: 'KeyError', message: "'b'" } };
    const failed = await send('setVariable', { variablesReference: ref2, name: 'payload', value: 'oops' });
    expect(failed.success).toBe(false);
    expect(failed.message).toBe("KeyError: 'b'");
    expect(vars.variables).toHaveLength(1);
  });

  it('declares setVariable and function breakpoints, and maps setFunctionBreakpoints to {function} specs', async () => {
    const { session, send } = harness();
    expect(CAPABILITIES.supportsSetVariable).toBe(true);
    expect(CAPABILITIES.supportsFunctionBreakpoints).toBe(true);
    await send('launch', { program: '/w/rank.py' });
    const res = await send('setFunctionBreakpoints', { breakpoints: [{ name: 'rrf' }, { name: 'Ranker.rank', condition: 'i == 3' }, { name: '  ' }] });
    expect(res.body).toEqual({ breakpoints: [{ verified: true }, { verified: true }] });
    // the line breakpoints of the session's own list survive; the function half is replaced
    expect(session.breakpointSets.at(-1)).toEqual([
      { path: '/w/rank.py', line: 4, condition: 'i == 3' },
      { function: 'rrf' },
      { function: 'Ranker.rank', condition: 'i == 3' },
    ]);
  });

  it('completes the text before the caret and tells the client which prefix each target replaces', async () => {
    const { session, send } = harness();
    await send('initialize', { adapterID: 'pyokka', columnsStartAt1: true, linesStartAt1: true });
    await send('launch', { program: '/w/rank.py' });
    expect(CAPABILITIES.supportsCompletionsRequest).toBe(true);
    expect(CAPABILITIES.completionTriggerCharacters).toEqual(['.']);
    // `1 + pa|yload` with the caret after "pa": column 7, 1-based
    const names = (await send('completions', { text: '1 + payload', column: 7 })).body as { targets: { label: string; type: string; start: number; length: number; detail?: string }[] };
    expect(session.calls).toContain('complete "1 + pa"');
    expect(names.targets).toEqual([
      { label: 'payload', type: 'variable', start: 5, length: 2, detail: 'dict' },
      { label: 'Point', type: 'class', start: 5, length: 2 },
    ]);
    const attrs = (await send('completions', { text: 'payload.', column: 9 })).body as { targets: { label: string; type: string; start: number; length: number }[] };
    expect(attrs.targets).toEqual([
      { label: 'items', type: 'method', start: 9, length: 0 },
      { label: 'keys', type: 'method', start: 9, length: 0 },
    ]);
    // a multi-line console text completes the line the caret is on; 0-based clients get 0-based positions
    const t0 = harness();
    await t0.send('initialize', { adapterID: 'pyokka', columnsStartAt1: false, linesStartAt1: false });
    await t0.send('launch', { program: '/w/rank.py' });
    const multi = (await t0.send('completions', { text: 'x = 1\npay', line: 1, column: 3 })).body as { targets: { label: string; start: number; length: number }[] };
    expect(t0.session.calls).toContain('complete "pay"');
    expect(multi.targets[0]).toEqual({ label: 'payload', type: 'variable', start: 0, length: 3, detail: 'dict' });
    const none = (await send('completions', { text: '1 + ', column: 5 })).body as { targets: unknown[] };
    expect(none.targets).toEqual([]);
  });

  it('maps continue, next, stepIn, stepOut and pause to the session and answers before the pause', async () => {
    const { session, send } = harness();
    await send('launch', { program: '/w/rank.py' });
    session.pause(PAUSE);
    expect((await send('continue', { threadId: 1 })).body).toEqual({ allThreadsContinued: true });
    await send('next', { threadId: 1 });
    await send('stepIn', { threadId: 1 });
    await send('stepOut', { threadId: 1 });
    await send('pause', { threadId: 1 });
    expect(session.calls.slice(-5)).toEqual(['continue', 'step over', 'step into', 'step out', 'pause']);
    const bps = (await send('setBreakpoints', { source: { path: '/w/rank.py' }, breakpoints: [{ line: 4 }, { line: 9 }] })).body as { breakpoints: { verified: boolean; line: number }[] };
    expect(bps.breakpoints).toEqual([{ verified: true, line: 4 }, { verified: true, line: 9 }]);
    expect((await send('bogus')).success).toBe(false);
  });

  it('restarts the run inside the same debug session: no terminated event, and the next stop still arrives', async () => {
    const { session, send, events } = harness();
    expect(CAPABILITIES.supportsRestartRequest).toBe(true);
    await send('launch', { program: '/w/rank.py' });
    session.pause(PAUSE);
    const restart = await send('restart', { arguments: { type: 'pyokka', request: 'launch', program: '/w/rank.py', stopOnEntry: false } });
    expect(restart.success).toBe(true);
    expect(session.calls.slice(-1)).toEqual(['restart']);
    expect(events('terminated')).toHaveLength(0);
    expect(events('exited')).toHaveLength(0);
    // the new run's first stop reaches the client through the same subscriptions
    session.pause({ ...PAUSE, reason: 'start', step: 0 });
    expect((events('stopped')[1]?.body as { reason: string }).reason).toBe('entry');
    // the configuration's stopOnEntry wins; without one, what launch asked for
    await send('restart', { arguments: { stopOnEntry: true } });
    expect(session.calls.slice(-1)).toEqual(['restart stopOnEntry']);
    const entry = harness();
    await entry.send('launch', { program: '/w/rank.py', stopOnEntry: true });
    await entry.send('restart', {});
    expect(entry.session.calls.slice(-1)).toEqual(['restart stopOnEntry']);
  });

  it('ends with exited and terminated when the run finishes, and disconnect stops the run', async () => {
    const { session, send, events } = harness();
    await send('launch', { program: '/w/rank.py' });
    session.finish(0);
    expect(events('exited')[0]?.body).toEqual({ exitCode: 0 });
    expect(events('terminated')).toHaveLength(1);
    session.finish(0);
    expect(events('terminated')).toHaveLength(1);
    const { session: s2, send: send2, events: ev2 } = harness();
    await send2('launch', { program: '/w/rank.py' });
    await send2('disconnect', { terminateDebuggee: true });
    expect(s2.calls.slice(-2)).toEqual(['stopDebug', 'terminate']);
    expect(ev2('terminated')).toHaveLength(1);
  });
});
