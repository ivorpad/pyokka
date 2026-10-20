/** "Full value": the rules a replay is held to (session/fullValue.ts), without a runner. */
import { describe, expect, it } from 'vitest';
import type { LogEvent, RunRequest } from '../../src/shared/protocol';
import type { ReplayResultEvent } from '../../src/shared/replayProtocol';
import { comparable, compareRecorded, expectPairs, interpret, lastObservation, observationOf, refusal, replayRequest } from '../../src/session/fullValue';

const locals = [
  { step: 1, scopeId: 0, changes: [{ name: 'ORDERS_CSV', text: "'customer,tier…'…(+69 chars)" }] },
  { step: 5, scopeId: 3, changes: [{ name: 'orders', text: '{}' }] },
  { step: 9, scopeId: 3, changes: [{ name: 'orders', text: "{'Ana': {'items': [{...}], 'tier': 'gold'}}" }, { name: 'row', text: "'Ana,gold'" }] },
  { step: 14, scopeId: 3, changes: [{ name: 'orders', text: "{'Ana': {...}, 'Ben': {...}}" }] },
  { step: 20, scopeId: 0, changes: [{ name: 'orders', text: "<module's orders>" }] },
];

function log(step: number, rid: number, text: string, kind: LogEvent['kind'] = 'log'): LogEvent {
  return { type: 'log', runId: 'r', seq: step, logId: `l${step}`, kind, rid, step, text } as LogEvent;
}

function request(overrides: Partial<Omit<RunRequest, 'type' | 'id'>> = {}, config: Partial<RunRequest['config']> = {}): Omit<RunRequest, 'type' | 'id'> {
  return {
    runId: 'r-3',
    file: { path: '/w/invoices.py', displayName: 'invoices.py', content: 'print(1)\n' },
    workspaceRoot: '/w',
    cwd: '/w',
    argv: [],
    env: {},
    projectFiles: [{ path: '/w/helper.py', content: 'x = 1\n' }],
    config: { http: 'off', httpObserve: true, recordLocals: true, ...config } as RunRequest['config'],
    markers: [{ id: 'm1', kind: 'value', range: [3, 0, 3, 4] }],
    expressionsToEvaluate: {},
    watch: [{ id: 'w1', exp: 'total' }],
    mode: 'normal',
    ...overrides,
  };
}

const ok = { midRun: false, httpCount: 0, running: false, paused: false, transport: false, step: 4, count: 81 };

describe('where the recording kept a value', () => {
  it('a row is the snapshot at or after its step, in its scope, with its text', () => {
    // the row of the statement at step 8 that changed orders: the scope's next snapshot is step 9
    expect(observationOf(locals, { step: 8, scopeId: 3, name: 'orders', text: "{'Ana': {'items': [{...}], 'tier': 'gold'}}" })).toEqual({ step: 9, scopeId: 3, text: "{'Ana': {'items': [{...}], 'tier': 'gold'}}" });
    // another scope's snapshot never answers for it
    expect(observationOf(locals, { step: 15, scopeId: 3, name: 'orders' })).toBeUndefined();
  });

  it('a row whose text the panel shows differently still finds its snapshot by name', () => {
    expect(observationOf(locals, { step: 10, scopeId: 3, name: 'orders', text: 'a display copy' })?.step).toBe(14);
  });

  it('a step reads the last snapshot at or before it, its own scope before the module', () => {
    expect(lastObservation(locals, 'orders', 13, [3, 0])?.step).toBe(9);
    expect(lastObservation(locals, 'orders', 25, [3, 0])?.step).toBe(14);
    expect(lastObservation(locals, 'orders', 25, [7, 0])?.step).toBe(20);
    expect(lastObservation(locals, 'orders', 4, [3, 0])).toBeUndefined();
  });
});

describe('what the replay has to match', () => {
  it('expect carries rid and depth of every step up to the target', () => {
    const quads = new Int32Array([1, 0, 0, 0, 2, 0, 0, 0, 33, 4, 1, 1, 9, 4, 1, 0]);
    // copied into an aligned buffer: a decoded Buffer can sit at any offset of Node's pool
    const pairs = new Int32Array(Uint8Array.from(Buffer.from(expectPairs(quads, 2), 'base64')).buffer);
    expect(Array.from(pairs)).toEqual([1, 0, 2, 0, 33, 1]);
  });

  it('addresses never count as a difference', () => {
    expect(comparable('<function main at 0x10719ceb0>')).toBe(comparable('<function main at 0x1032ab470>'));
    expect(comparable("{'a': 0x10}")).toBe("{'a': 0x10}");
  });

  it('the replay sends the recording run\'s own request, without the debugger, the watches or the network', () => {
    const original = request({ breakpoints: [{ path: '/w/invoices.py', line: 3 }], traceContext: { step: 4, prefetch: 10 } }, { debug: true, record: true, stopOnEntry: false, breakOnException: 'raised', recordFrom: 'pause', http: 'record' });
    const sent = replayRequest(original, 'r-3-replay-1', { expect: 'AAAA', at: { step: 4, expr: 'orders' } });
    expect(sent.runId).toBe('r-3-replay-1');
    expect(sent.file).toEqual(original.file);
    expect(sent.projectFiles).toEqual(original.projectFiles);
    expect(sent.markers).toEqual(original.markers);
    expect(sent.watch).toEqual([]);
    expect(sent.breakpoints).toBeUndefined();
    expect(sent.traceContext).toBeUndefined();
    expect(sent.config).not.toHaveProperty('debug');
    expect(sent.config).not.toHaveProperty('recordFrom');
    expect(sent.config).not.toHaveProperty('stopOnEntry');
    expect(sent.config.http).toBe('replay');
    expect(sent.replay).toEqual({ expect: 'AAAA', at: { step: 4, expr: 'orders' } });
    expect(replayRequest(request(), 'x', { expect: '', at: { step: 0, expr: 'a' } }).config.http).toBe('off');
  });

  it('a replay gets twice the run\'s time limit, and none when the run had none', () => {
    expect(replayRequest(request({}, { timeoutMs: 30_000 }), 'x', { expect: '', at: { step: 0, expr: 'a' } }).config.timeoutMs).toBe(60_000);
    expect(replayRequest(request({}, { timeoutMs: 0 }), 'x', { expect: '', at: { step: 0, expr: 'a' } }).config.timeoutMs).toBe(0);
  });
});

describe('a run that cannot be replayed says why', () => {
  it('a run that called the network unrecorded is refused, with the action that fixes it', () => {
    const why = refusal({ ...ok, request: request(), httpCount: 2 });
    expect(why).toContain('called the network (2 requests)');
    expect(why).toContain('Switch HTTP to Record');
    // recorded answers replay without the network
    expect(refusal({ ...ok, request: request({}, { http: 'record' }), httpCount: 2 })).toBeUndefined();
    expect(refusal({ ...ok, request: request() })).toBeUndefined();
  });

  it('with HTTP observation off nobody knows whether it called the network', () => {
    expect(refusal({ ...ok, request: request({}, { httpObserve: false }) })).toContain('cannot tell whether this run called the network');
  });

  it('a recording that began at a pause, a transport, a running run, a module launch and a missing request each say so', () => {
    // a recording that began at a pause replays from where it began; only one with no such point kept is refused
    expect(refusal({ ...ok, request: request(), midRun: true })).toContain('did not keep where');
    expect(refusal({ ...ok, request: request(), midRun: true, startedAt: 1234 })).toBeUndefined();
    expect(refusal({ ...ok, request: request(), transport: true })).toContain('container');
    expect(refusal({ ...ok, request: request(), running: true })).toContain('in flight');
    expect(refusal({ ...ok, request: request(), running: true, paused: true })).toBeUndefined();
    expect(refusal({ ...ok, request: request({ module: 'app.main' }) })).toContain('module launch');
    expect(refusal({ ...ok, request: undefined })).toContain('did not keep how this run was started');
    expect(refusal({ ...ok, request: request(), step: 81 })).toContain('not in this run');
  });
});

describe('the values on the way', () => {
  const replayLocals = locals.map((e) => ({ ...e, changes: e.changes.map((c) => ({ ...c })) }));

  it('the same snapshots and logs before the step are a match, counted', () => {
    const logs = [log(3, 7, 'hello'), log(6, 8, '0.25', 'time')];
    expect(compareRecorded({ locals, logs }, { locals: replayLocals, logs: [log(3, 7, 'hello'), log(6, 8, '0.31', 'time')] }, 14)).toEqual({ difference: undefined, compared: 4 + 1 });
  });

  it('a snapshot that came out different is the first difference, with both texts', () => {
    const changed = replayLocals.map((e) => (e.step === 9 ? { ...e, changes: [{ name: 'orders', text: "{'Ana': {'items': [{...}], 'tier': 'silver'}}" }, e.changes[1]!] } : e));
    expect(compareRecorded({ locals, logs: [] }, { locals: changed, logs: [] }, 20).difference).toEqual({ step: 9, name: 'orders', recorded: "{'Ana': {'items': [{...}], 'tier': 'gold'}}", replay: "{'Ana': {'items': [{...}], 'tier': 'silver'}}" });
  });

  it('a change only one run saw is a difference too, and a printed line counts', () => {
    const extra = [...replayLocals.slice(0, 2), { step: 7, scopeId: 3, changes: [{ name: 'tmp', text: '1' }] }, ...replayLocals.slice(2)];
    expect(compareRecorded({ locals, logs: [] }, { locals: extra, logs: [] }, 20).difference).toEqual({ step: 7, name: 'tmp', recorded: 'nothing at this step', replay: '1' });
    expect(compareRecorded({ locals: [], logs: [log(2, 7, 'ok')] }, { locals: [], logs: [log(2, 7, 'not ok')] }, 20).difference).toEqual({ step: 2, name: 'printed', recorded: 'ok', replay: 'not ok' });
  });

  it('the target step itself is left out: the replay stops before its snapshot', () => {
    expect(compareRecorded({ locals, logs: [] }, { locals: replayLocals.filter((e) => e.step < 14), logs: [] }, 14).difference).toBeUndefined();
  });
});

describe('what the pane says', () => {
  const reached = (extra: Partial<ReplayResultEvent> = {}): ReplayResultEvent => ({ type: 'replay.result', runId: 'x', seq: 1, status: 'reached', step: 14, matched: 14, value: { data: { type: 'dict', id: '1', queryPath: ['r'] } }, ...extra });
  const where = (rid: number): string => `invoices.py:${rid}`;
  const obs = { step: 14, scopeId: 3, text: "{'Ana': {...}, 'Ben': {...}}" };

  it('checked: same steps, every value on the way and the value itself the same', () => {
    const v = interpret('k', { step: 14, name: 'orders' }, reached({ check: { step: 14, text: obs.text } }), { compared: 5 }, obs, where, 412, { inputs: 'handed back' });
    expect(v.status).toBe('checked');
    // and it says how far "the same" goes: the recorder's text of each value, not the whole copy
    expect(v.summary).toBe('The replay took the same 14 steps, and all 6 values the recording kept on the way came out the same. Each was compared as far as the recording kept it (by default 120 characters, three levels deep), so a difference deeper in this copy, from a file or a database that changed since, would not show.');
    expect(v.value?.type).toBe('dict');
    expect(v.ms).toBe(412);
  });

  it('past the recorder\'s cap on changes, the steps after it were compared by path only, and it says so', () => {
    const v = interpret('k', { step: 999_998, name: 'total' }, reached({ step: 999_998, matched: 999_999 }), { compared: 199_998 }, undefined, where, 1, { inputs: 'handed back', valuesUntil: 199_998 });
    expect(v.status).toBe('checked');
    expect(v.summary).toContain('The recording stopped keeping values at step #199998 (its limit of 100,000 changes), so after it only the path was compared.');
    // a step before the cap needs no such sentence
    expect(interpret('k', { step: 1000, name: 'total' }, reached(), { compared: 998 }, undefined, where, 1, { inputs: 'handed back', valuesUntil: 199_998 }).summary).not.toContain('stopped keeping');
  });

  it('checked, but the value itself had no text kept: it says so', () => {
    const v = interpret('k', { step: 14, name: 'self.balance' }, reached(), { compared: 5 }, undefined, where, 1, { inputs: 'handed back' });
    expect(v.status).toBe('checked');
    expect(v.summary).toContain('kept no text of self.balance itself');
  });

  it('differs: the value itself came out different from the text the recording kept', () => {
    const v = interpret('k', { step: 14, name: 'orders' }, reached({ check: { step: 14, text: "{'Ana': {...}}" } }), { compared: 5 }, obs, where, 1, { inputs: 'handed back' });
    expect(v.status).toBe('differs');
    expect(v.difference).toEqual({ step: 14, name: 'orders', recorded: obs.text, replay: "{'Ana': {...}}" });
    expect(v.value).toBeDefined();
  });

  it('path: nothing recorded on the way, and the clock read fresh', () => {
    const v = interpret('k', { step: 14, name: 'orders' }, reached(), { compared: 0 }, undefined, where, 1, { inputs: 'none recorded' });
    expect(v.status).toBe('path');
    expect(v.summary).toContain('only the path is checked');
    expect(v.summary).toContain('read fresh');
  });

  it('a replay that went another way has no value, and says where', () => {
    const d = interpret('k', { step: 14, name: 'orders' }, { type: 'replay.result', runId: 'x', seq: 1, status: 'diverged', step: 9, matched: 9, expected: { rid: 51, depth: 2 }, actual: { rid: 53, depth: 2 } }, { compared: 0 }, obs, where, 1, { inputs: 'handed back' });
    expect(d).toMatchObject({ status: 'diverged', matched: 9 });
    expect(d.value).toBeUndefined();
    expect(d.summary).toBe('The replay went another way at step #9, so it has no value from this run. The recording ran invoices.py:51, the replay ran invoices.py:53.');
    const i = interpret('k', { step: 14, name: 'orders' }, { type: 'replay.result', runId: 'x', seq: 1, status: 'input', step: 12, matched: 12, message: 'the program read time once more than the recorded run did (1 reads)' }, { compared: 0 }, obs, where, 1, { inputs: 'handed back' });
    expect(i.summary).toBe('The replay went another way at step #12: the program read time once more than the recorded run did (1 reads).');
    const e = interpret('k', { step: 14, name: 'orders' }, { type: 'replay.result', runId: 'x', seq: 1, status: 'ended', step: 10, matched: 10 }, { compared: 0 }, obs, where, 1, { inputs: 'none recorded' });
    expect(e.summary).toContain('finished at step #10, before step #14');
  });

  it('a name that is not defined there, an evaluation error and no answer at all are not values', () => {
    expect(interpret('k', { step: 14, name: 'nope' }, reached({ value: undefined, missing: "name 'nope' is not defined" }), { compared: 0 }, undefined, where, 1, { inputs: 'handed back' }).status).toBe('unavailable');
    expect(interpret('k', { step: 14, name: 'x' }, reached({ value: undefined, error: 'ZeroDivisionError: division by zero' }), { compared: 0 }, undefined, where, 1, { inputs: 'handed back' }).summary).toContain('ZeroDivisionError');
    expect(interpret('k', { step: 14, name: 'x' }, undefined, { compared: 0 }, undefined, where, 1, { inputs: 'handed back' }).status).toBe('error');
  });
});
