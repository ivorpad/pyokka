import { describe, expect, it } from 'vitest';
import { CAPABILITIES, DapTranslator } from '../../src/debug/dapTranslator';
import type { DapMessage, DapRequest, DapResponse, DapEvent } from '../../src/debug/dapTypes';
import type { DebugTarget, ReplayMove, ReplayOutcome, ReplaySource } from '../../src/debug/debugTarget';
import type { DebugState, PausedInfo } from '../../src/session/debugState';
import { ReplayIndex, lookupRecorded, replayFrames } from '../../src/session/replayFrames';
import { TraceModel, packSteps } from '../../src/timeMachine/traceModel';
import type { LocalsEvent, LogEvent, TraceScope, ValueNode } from '../../src/shared/protocol';

/** rid == source line; every step is a one-line statement in file 1. */
const resolve = (rid: number) => ({ fileId: 1, range: [rid, 4, rid, 20] as [number, number, number, number] });
const scope = (scopeId: number, name: string, parent: number, depth: number, first: number, last: number, rid = 0): TraceScope => ({ scopeId, rid, name, parent, depth, first, last });

/**
 *  1 def f():
 *  2     a = g()        steps 1, 4
 *  3 def g():
 *  4     x = [1, 2]     step 2
 *  5     return x       step 3
 *  6 total = f()        step 0
 *  7 print(total)       step 5
 */
function trace(): TraceModel {
  const steps = packSteps([
    [6, 0, 0],
    [2, 1, 1],
    [4, 2, 2],
    [5, 2, 2],
    [2, 1, 1],
    [7, 0, 0],
  ]);
  return new TraceModel(steps, [scope(0, '<module>', -1, 0, 0, 5), scope(1, 'f', 0, 1, 1, 4, 1), scope(2, 'g', 1, 2, 2, 3, 3)], false, resolve);
}

const list: ValueNode = { type: 'list', id: 'v1', queryPath: [], length: 2, props: [ { name: '0', type: 'int', value: '1', id: 'v2', queryPath: ['0'] }, { name: '1', type: 'int', value: '2', id: 'v3', queryPath: ['1'] } ] };

function log(step: number, context: string, text: string, extra: Partial<LogEvent> = {}): LogEvent {
  return { type: 'log', runId: 'r', seq: step, logId: `l${step}${context}`, kind: 'autoLog', fileId: 1, rid: 0, hit: 1, step, context, text, runtimeKey: 'k', ...extra };
}

const LOGS: LogEvent[] = [log(2, 'x', '[1, 2]', { valueBag: { data: list, runtimeKey: 'k' } }), log(4, 'a', '[1, 2]'), log(5, 'total', '[1, 2]'), log(2, 'g()', 'not a name')];
const LOCALS: LocalsEvent['entries'] = [{ step: 3, scopeId: 2, changes: [{ name: 'x', text: '[1, 2] (locals)' }] }];

describe('replayFrames', () => {
  it('gives the Time Machine call stack, innermost first, callers at their call sites', () => {
    const frames = replayFrames(trace(), 3);
    expect(frames.map((f) => [f.name, f.line, f.step])).toEqual([['g', 5, 3], ['f', 2, 1], ['<module>', 6, 0]]);
  });

  it('answers a frame from the values recorded in that one call, as of the step', () => {
    const index = new ReplayIndex(trace(), [], LOGS);
    expect(index.variables(2, 1)).toEqual([]);
    expect(index.variables(2, 2).map((v) => [v.name, v.text])).toEqual([['x', '[1, 2]']]);
    expect(index.variables(2, 2)[0]?.node).toBe(list);
    // `g()` is not a name, and `a` belongs to f's frame, not g's
    expect(index.frameVariables(3, 0).map((v) => v.name)).toEqual(['x']);
    expect(index.frameVariables(4, 0).map((v) => v.name)).toEqual(['a']);
    expect(index.frameVariables(5, 0).map((v) => v.name)).toEqual(['total']);
  });

  it('prefers the recorded local when it is as late as the logged value', () => {
    const index = new ReplayIndex(trace(), LOCALS, LOGS);
    expect(index.variables(2, 3).map((v) => [v.text, v.source])).toEqual([['[1, 2] (locals)', 'locals']]);
    expect(index.variables(2, 2).map((v) => v.source)).toEqual(['value']);
  });

  it('looks up a name and its members in the recorded tree; anything else is not in the recording', () => {
    const vars = new ReplayIndex(trace(), [], LOGS).variables(2, 3);
    expect(lookupRecorded(vars, 'x')?.text).toBe('[1, 2]');
    expect(lookupRecorded(vars, 'x[1]')?.text).toBe('2');
    expect(lookupRecorded(vars, 'x[7]')).toBeUndefined();
    expect(lookupRecorded(vars, 'len(x)')).toBeUndefined();
    expect(lookupRecorded(vars, 'y')).toBeUndefined();
  });
});

/** The Time Machine over `trace()`, as replaySession.ts gives it, without vscode. */
class FakeReplay implements ReplaySource {
  active = true;
  step = 0;
  /** the frontier of a paused debug run; a forward move there executes */
  frontier: number | undefined;
  calls: string[] = [];
  private fns: (() => void)[] = [];
  readonly trace = trace();
  private readonly index = new ReplayIndex(this.trace, [], LOGS);
  frames() {
    return replayFrames(this.trace, this.step);
  }
  variables(i: number) {
    return this.index.frameVariables(this.step, i);
  }
  move(kind: ReplayMove): ReplayOutcome {
    this.calls.push(`move ${kind}`);
    if (this.frontier === this.step && (kind === 'into' || kind === 'over' || kind === 'out')) return 'executed';
    const t = this.trace;
    const next = { into: t.stepInto(this.step), back: t.stepBackInto(this.step), over: t.stepOver(this.step), backOver: t.stepBackOver(this.step), out: t.stepOut(this.step), backOut: t.stepBackOut(this.step) }[kind];
    if (next < 0) return 'none';
    this.goto(next);
    return 'moved';
  }
  toBreakpoint(backward: boolean): ReplayOutcome {
    this.calls.push(backward ? 'reverse' : 'forward');
    const next = backward ? 0 : (this.frontier ?? this.trace.count - 1);
    if (next === this.step) return 'none';
    this.goto(next);
    return 'moved';
  }
  goto(step: number): void {
    this.step = step;
    for (const f of this.fns) f();
  }
  stop(): void {
    this.active = false;
    for (const f of this.fns) f();
  }
  onChanged(fn: () => void) {
    this.fns.push(fn);
    return () => void (this.fns = this.fns.filter((f) => f !== fn));
  }
}

function target(replay: FakeReplay, replayOnly: boolean): DebugTarget & { calls: string[]; pause(info: PausedInfo): void } {
  const calls: string[] = [];
  const paused: ((info: PausedInfo) => void)[] = [];
  const debug: DebugState = { active: !replayOnly, paused: undefined, frontier: undefined, breakpoints: [], watches: [], exceptions: 'uncaught', modified: false, runId: 'r' };
  const no = async (): Promise<never> => {
    throw new Error('no program');
  };
  return {
    calls,
    pause(info) {
      debug.paused = info;
      for (const f of paused) f(info);
    },
    id: 'k', kind: 'run', displayName: 'rank.py', record: true, launch: undefined, debug, running: false, output: '', modified: false, thread: undefined,
    replay, replayOnly,
    startDebug: async () => void calls.push('startDebug'),
    stopDebug: () => void calls.push('stopDebug'),
    restart: async () => void calls.push('restart'),
    terminate: () => void calls.push('terminate'),
    debugContinue: async () => void calls.push('continue'),
    debugStep: async (kind) => void calls.push(`step ${kind}`),
    debugPause: async () => void calls.push('pause'),
    debugLocals: async () => [{ name: 'live', text: '1' }],
    evaluate: async () => undefined,
    exec: no,
    complete: async () => ({ prefix: '', items: [] }),
    expand: async () => undefined,
    setDebugBreakpoints: async () => [],
    setDebugWatches: async () => undefined,
    setDebugExceptions: async () => undefined,
    runToLine: no,
    pathForFileId: (id) => (id === 1 ? '/w/rank.py' : undefined),
    locate: () => undefined,
    onPaused: (fn) => {
      paused.push(fn);
      return () => undefined;
    },
    onResumed: () => () => undefined,
    onFinished: () => () => undefined,
    waitForPause: async () => 'finished',
  };
}

function harness(opts: { replayOnly?: boolean; step?: number } = {}) {
  const replay = new FakeReplay();
  replay.step = opts.step ?? 0;
  const t = target(replay, opts.replayOnly ?? true);
  const out: DapMessage[] = [];
  const tr = new DapTranslator(async () => t, (m) => out.push(m), { stepBack: true });
  let seq = 0;
  const send = async (command: string, args?: Record<string, unknown>): Promise<DapResponse> => {
    const req: DapRequest = { seq: ++seq, type: 'request', command, arguments: args };
    await tr.handle(req);
    return out.filter((m): m is DapResponse => m.type === 'response' && m.request_seq === req.seq)[0]!;
  };
  const stops = (): DapEvent[] => out.filter((m): m is DapEvent => m.type === 'event' && m.event === 'stopped');
  return { replay, target: t, tr, send, stops, out };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('DapTranslator in replay', () => {
  it('declares step back only for a session that can replay', async () => {
    const { send } = harness();
    expect((await send('initialize')).body).toEqual({ ...CAPABILITIES, supportsStepBack: true });
    expect(CAPABILITIES.supportsStepBack).toBe(false);
  });

  it('launches a replay without starting a program and stops at the Time Machine step', async () => {
    const { send, stops, target: t } = harness({ step: 2 });
    await send('initialize');
    expect((await send('launch', { program: '/w/rank.py', replay: 'k' })).success).toBe(true);
    await flush();
    expect(t.calls).not.toContain('startDebug');
    expect(stops()).toHaveLength(1);
    expect(stops()[0]!.body).toMatchObject({ reason: 'step', description: 'Time Machine at step 2, rank.py:4' });
    // no preserveFocusHint: with it VS Code focuses no frame, and its Variables view stays empty
    expect(stops()[0]!.body).not.toHaveProperty('preserveFocusHint');
  });

  it('answers the Call Stack, the Variables and the Watch view from the recording', async () => {
    const { send } = harness({ step: 3 });
    await send('launch', { program: '/w/rank.py' });
    await flush();
    const stack = (await send('stackTrace')).body as { stackFrames: { id: number; name: string; line: number; source?: { path: string } }[] };
    expect(stack.stackFrames.map((f) => [f.id, f.name, f.line])).toEqual([[1, 'g', 5], [2, 'f', 2], [3, '<module>', 6]]);
    expect(stack.stackFrames[0]!.source?.path).toBe('/w/rank.py');
    // the page a client asks for: the top frame first, the rest after it, the total either way
    const top = (await send('stackTrace', { threadId: 1, startFrame: 0, levels: 1 })).body as { stackFrames: { id: number }[]; totalFrames: number };
    expect([top.stackFrames.map((f) => f.id), top.totalFrames]).toEqual([[1], 3]);
    const rest = (await send('stackTrace', { threadId: 1, startFrame: 1, levels: 20 })).body as { stackFrames: { id: number }[] };
    expect(rest.stackFrames.map((f) => f.id)).toEqual([2, 3]);
    const scopes = (await send('scopes', { frameId: 1 })).body as { scopes: { name: string; variablesReference: number }[] };
    expect(scopes.scopes[0]!.name).toBe('Locals at step 3');
    const vars = (await send('variables', { variablesReference: scopes.scopes[0]!.variablesReference })).body as { variables: { name: string; value: string; variablesReference: number }[] };
    expect(vars.variables.map((v) => [v.name, v.value])).toEqual([['x', '[1, 2]']]);
    expect(vars.variables[0]!.variablesReference).toBeGreaterThan(0);
    const member = await send('evaluate', { expression: 'x[0]', context: 'watch', frameId: 1 });
    expect(member.body).toMatchObject({ result: '1' });
    const missing = await send('evaluate', { expression: 'len(x)', context: 'hover', frameId: 1 });
    expect(missing.success).toBe(false);
    expect(missing.message).toContain('not in the recording at step 3');
    expect((await send('setVariable', { variablesReference: scopes.scopes[0]!.variablesReference, name: 'x', value: '3' })).success).toBe(false);
    const completions = (await send('completions', { text: 'x', column: 2 })).body as { targets: { label: string }[] };
    expect(completions.targets.map((c) => c.label)).toEqual(['x']);
  });

  it('steps back and reverse-continues through the Time Machine, one stopped event per move', async () => {
    const { send, stops, replay } = harness({ step: 4 });
    await send('launch', { program: '/w/rank.py' });
    await flush();
    await send('stepBack');
    await flush();
    expect(replay.calls).toEqual(['move backOver']);
    // back over g's two steps to the call in f
    expect(replay.step).toBe(1);
    expect(stops()).toHaveLength(2);
    await send('reverseContinue');
    await flush();
    expect(replay.step).toBe(0);
    expect(stops()).toHaveLength(3);
    await send('next');
    await send('stepIn');
    await flush();
    expect(replay.calls.slice(-2)).toEqual(['move over', 'move into']);
    // two moves before the client heard of the first: one stop, at the last step
    expect(stops()).toHaveLength(4);
    expect(stops()[3]!.body).toMatchObject({ description: expect.stringContaining(`step ${replay.step}`) });
  });

  it('answers a dead end with a stop at the same step, so the toolbar leaves "running"', async () => {
    const { send, stops } = harness({ step: 0 });
    await send('launch', { program: '/w/rank.py' });
    await flush();
    await send('reverseContinue');
    await flush();
    expect(stops()).toHaveLength(2);
    expect(stops()[1]!.body).toMatchObject({ description: expect.stringContaining('step 0') });
  });

  it('follows a move made elsewhere (the panel, the bridge) and a frame clicked in the Call Stack', async () => {
    const { send, stops, replay, tr } = harness({ step: 0 });
    await send('launch', { program: '/w/rank.py' });
    await flush();
    replay.goto(3);
    await flush();
    expect(stops()).toHaveLength(2);
    tr.selectFrame(2);
    await flush();
    expect(replay.step).toBe(1);
    expect(stops()).toHaveLength(3);
    tr.selectFrame(1);
    await flush();
    expect(stops()).toHaveLength(3);
  });

  it('closes like a debug session: Stop terminates the target, which closes the Time Machine', async () => {
    const { send, target: t } = harness();
    await send('launch', { program: '/w/rank.py' });
    await send('disconnect');
    expect(t.calls).toContain('terminate');
  });
});

describe('DapTranslator over a recording debug run', () => {
  const PAUSE: PausedInfo = { step: 4, rid: 2, fileId: 1, line: 2, scopeId: 1, depth: 1, reason: 'breakpoint', stack: [{ scopeId: 1, name: 'f', rid: 1, depth: 1 }, { scopeId: 0, name: '<module>', rid: 0, depth: 0 }] };

  it('executes at the frontier, replays behind it, and shows the live pause again on return', async () => {
    const { send, stops, replay, target: t } = harness({ replayOnly: false, step: 4 });
    await send('launch', { program: '/w/rank.py', record: true });
    expect(t.calls).toContain('startDebug');
    replay.frontier = 4;
    t.pause(PAUSE);
    replay.goto(4); // the Time Machine attaches at the frontier
    await flush();
    expect(stops()).toHaveLength(1);
    expect(stops()[0]!.body).toMatchObject({ reason: 'breakpoint' });
    // at the frontier the program takes the step: no replay stop, the run's own pause follows
    await send('next');
    await flush();
    expect(replay.calls).toEqual(['move over']);
    expect(stops()).toHaveLength(1);
    // behind the frontier the views read the recording
    await send('stepBack');
    await flush();
    expect(stops()).toHaveLength(2);
    expect(stops()[1]!.body).toMatchObject({ reason: 'step' });
    const scopes = (await send('scopes', { frameId: 1 })).body as { scopes: { name: string }[] };
    expect(scopes.scopes[0]!.name).toBe(`Locals at step ${replay.step}`);
    // continue from behind runs to the frontier, where the live pause shows again
    await send('continue');
    await flush();
    expect(replay.step).toBe(4);
    expect(stops()).toHaveLength(3);
    expect(stops()[2]!.body).toMatchObject({ reason: 'breakpoint' });
    const live = (await send('scopes', { frameId: 1 })).body as { scopes: { name: string }[] };
    expect(live.scopes[0]!.name).toBe('Locals');
  });

  it('refuses step back when no Time Machine is open', async () => {
    const { send, replay } = harness({ replayOnly: false });
    replay.active = false;
    await send('launch', { program: '/w/rank.py', record: true });
    const r = await send('stepBack');
    expect(r.success).toBe(false);
    expect(r.message).toContain('needs a recording');
  });
});
