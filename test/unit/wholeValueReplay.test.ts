/** "Whole value" end to end against a fake runner: what is sent, what comes back, and that the runner is let go. */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { RunEvent, RunRequest } from '../../src/shared/protocol';
import { replayWholeValue, type ReplayRunner, type ReplaySource } from '../../src/session/wholeValueReplay';

type Sent = Omit<RunRequest, 'type' | 'id'>;

/** Answers a run with `answer(request)`'s events, in order, as the runtime would. */
class FakeRunner extends EventEmitter implements ReplayRunner {
  sent: Sent[] = [];
  disposed = false;
  constructor(
    private readonly answer: (req: Sent) => Record<string, unknown>[],
    private readonly capabilities = ['replay'],
  ) {
    super();
  }
  start(): Promise<{ capabilities: string[] }> {
    return Promise.resolve({ capabilities: this.capabilities });
  }
  run(req: Sent): Promise<void> {
    this.sent.push(req);
    setTimeout(() => {
      for (const ev of this.answer(req)) this.emit('event', { ...ev, runId: req.runId, seq: 1 } as unknown as RunEvent);
    }, 0);
    return Promise.resolve();
  }
  dispose(): void {
    this.disposed = true;
  }
}

const recordedLocals = [
  { step: 2, scopeId: 0, changes: [{ name: 'orders', text: '{}' }] },
  { step: 4, scopeId: 0, changes: [{ name: 'orders', text: "{'Ben': {'items': [{...}]}}" }] },
];

function source(runner: FakeRunner | undefined, overrides: Partial<ReplaySource> = {}): ReplaySource {
  const quads = new Int32Array([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0]);
  return {
    runId: 'r-7',
    request: {
      runId: 'r-7',
      file: { path: '/w/invoices.py', displayName: 'invoices.py', content: '' },
      workspaceRoot: '/w',
      cwd: '/w',
      argv: [],
      env: {},
      projectFiles: [],
      config: { http: 'off', httpObserve: true } as RunRequest['config'],
      markers: [],
      expressionsToEvaluate: {},
      watch: [],
      mode: 'normal',
    },
    steps: quads,
    count: 6,
    scopeId: () => 0,
    locals: recordedLocals,
    logs: [],
    inputs: { seed: 42, reads: [['time', 1792500000.25]] },
    httpCount: 0,
    running: false,
    paused: false,
    transport: false,
    locate: (rid) => `invoices.py:${rid}`,
    makeRunner: () => runner,
    timeoutMs: 2000,
    ...overrides,
  };
}

const value = { data: { type: 'dict', id: '1', queryPath: ['r'], props: [] } };

describe('a replay for a whole value', () => {
  it('asks for the snapshot behind the row, hands the inputs back, compares on the way and lets the runner go', async () => {
    const runner = new FakeRunner((req) => [
      { type: 'locals', entries: [recordedLocals[0]!] },
      { type: 'replay.result', status: 'reached', step: req.replay!.at.step, matched: req.replay!.at.step, value, check: { step: 4, text: "{'Ben': {'items': [{...}]}}" } },
      { type: 'run.finished', exitCode: 0, durationMs: 5, timedOut: false, stopped: false, stepCount: 4, logCount: 0 },
    ]);
    const view = await replayWholeValue(source(runner), { key: 'change:3:0:orders', kind: 'change', step: 3, name: 'orders', scopeId: 0 });
    const sent = runner.sent[0]!;
    expect(sent.runId).toMatch(/^r-7-replay-\d+$/);
    // the row's statement is step 3; the recorder kept the value at the start of step 4
    expect(sent.replay?.at).toEqual({ step: 4, expr: 'orders' });
    expect(sent.replay?.check).toEqual({ step: 4, name: 'orders' });
    expect(sent.replay?.inputs).toEqual({ seed: 42, reads: [['time', 1792500000.25]] });
    expect(new Int32Array(Uint8Array.from(Buffer.from(sent.replay!.expect, 'base64')).buffer).length).toBe(2 * 5);
    expect(view).toMatchObject({ key: 'change:3:0:orders', status: 'checked', step: 4, name: 'orders', matched: 4 });
    expect(view.summary).toBe('The replay took the same 4 steps, and all 2 values the recording kept on the way came out the same.');
    expect(runner.disposed).toBe(true);
  });

  it('a recording that began at a pause sends where it began, so the replay records from there', async () => {
    const runner = new FakeRunner((req) => [
      { type: 'replay.result', status: 'reached', step: req.replay!.at.step, matched: req.replay!.at.step, value },
      { type: 'run.finished', exitCode: 0, durationMs: 5, timedOut: false, stopped: false, stepCount: 4, logCount: 0 },
    ]);
    await replayWholeValue(source(runner, { midRun: true, startedAt: 4321 }), { key: 'k', kind: 'at', step: 5, name: 'orders' });
    expect(runner.sent[0]!.replay?.startAt).toBe(4321);
    const plain = new FakeRunner((req) => [{ type: 'replay.result', status: 'reached', step: req.replay!.at.step, matched: 1, value }, { type: 'run.finished', exitCode: 0, durationMs: 5, timedOut: false, stopped: false, stepCount: 4, logCount: 0 }]);
    await replayWholeValue(source(plain), { key: 'k', kind: 'at', step: 5, name: 'orders' });
    expect(plain.sent[0]!.replay).not.toHaveProperty('startAt');
  });

  it('a runtime without replay is told apart from a failure', async () => {
    const runner = new FakeRunner(() => [], ['watch']);
    const view = await replayWholeValue(source(runner), { key: 'k', kind: 'at', step: 5, name: 'orders' });
    expect(view.status).toBe('unavailable');
    expect(view.summary).toContain('older than the extension');
    expect(runner.sent).toHaveLength(0);
    expect(runner.disposed).toBe(true);
  });

  it('a run that called the network unrecorded starts no runner', async () => {
    let made = 0;
    const view = await replayWholeValue(source(undefined, { httpCount: 1, makeRunner: () => (made++, undefined) }), { key: 'k', kind: 'at', step: 5, name: 'orders' });
    expect(view.status).toBe('unavailable');
    expect(view.summary).toContain('called the network (one request)');
    expect(made).toBe(0);
  });

  it('a runner that exits before it answers, and a replay that never finishes, are errors with a reason', async () => {
    const dies = new FakeRunner(() => []);
    dies.run = (req) => {
      dies.sent.push(req);
      setTimeout(() => dies.emit('exit', 1, null, true), 0);
      return Promise.resolve();
    };
    expect((await replayWholeValue(source(dies), { key: 'k', kind: 'at', step: 5, name: 'orders' })).summary).toContain('exited (code 1) before it answered');
    const hangs = new FakeRunner(() => []);
    const view = await replayWholeValue(source(hangs, { timeoutMs: 20 }), { key: 'k', kind: 'at', step: 5, name: 'orders' });
    expect(view.status).toBe('error');
    expect(view.summary).toContain('did not reach step #5 within');
    expect(hangs.disposed).toBe(true);
  });

  it('a replay the runtime stopped at its time limit says which limit, and what to raise', async () => {
    const runner = new FakeRunner(() => [{ type: 'run.finished', exitCode: null, durationMs: 60_000, timedOut: true, stopped: false, stepCount: 3, logCount: 0 }]);
    const src = source(runner);
    const view = await replayWholeValue({ ...src, request: { ...src.request!, config: { ...src.request!.config, timeoutMs: 30_000 } } }, { key: 'k', kind: 'at', step: 5, name: 'orders' });
    expect(view).toMatchObject({ status: 'error', summary: 'The replay hit its time limit (60 s, twice the Run Timeout) before step #5. Raise the Run Timeout in Settings and ask again.' });
  });

  it('a refused replay answers at once, without waiting for the program', async () => {
    const runner = new FakeRunner(() => [{ type: 'replay.result', status: 'error', step: 0, matched: 0, message: 'a replay cannot start from a pause' }]);
    const view = await replayWholeValue(source(runner), { key: 'k', kind: 'at', step: 5, name: 'orders' });
    expect(view).toMatchObject({ status: 'error', summary: 'The replay failed: a replay cannot start from a pause.' });
  });

  it('a row with no snapshot after it has nothing to replay to', async () => {
    const view = await replayWholeValue(source(new FakeRunner(() => [])), { key: 'k', kind: 'change', step: 5, name: 'orders', scopeId: 0 });
    expect(view.status).toBe('unavailable');
    expect(view.summary).toContain('no snapshot of orders after step #5');
  });
});
