/**
 * The Debugger view's host (src/views/debuggerView.ts) over a real DebugSessionManager and a fake
 * runner: the frame's variables at a pause, a watch added on the session itself (the bridge's
 * `watches --add`) valued at that pause, and a member loaded through `debug.expand` kept in the
 * state. The fakes are debugSession.test.ts's, with `evaluate` and `expand` added.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DebugPausedEvent, RunEvent, RunRequest, ValueBag, ValueNode } from '../../src/shared/protocol';
import type { DebugSessionPanel, HostToWebview } from '../../src/shared/webviewProtocol';
import { watchValue } from '../../webview/debuggerView';

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
  workspace: { getWorkspaceFolder: () => undefined, workspaceFolders: [{ uri: { fsPath: '/w' } }], openTextDocument: async () => ({}) },
  window: { activeTextEditor: undefined, visibleTextEditors: [], showTextDocument: async () => undefined, showErrorMessage: () => undefined },
  debug: { breakpoints: [], removeBreakpoints: () => undefined },
  Position: class {},
  Range: class {},
  ViewColumn: { One: 1 },
}));
vi.mock('../../src/util/context', () => ({ setContext: () => undefined }));
vi.mock('../../src/debug/debugContext', () => ({ updateDebugContext: () => undefined }));
vi.mock('../../src/runtime/interpreter', () => ({
  resolveInterpreter: async () => ({ path: '/v/bin/python', version: [3, 12, 9], source: 'setting', isVenv: true }),
}));
vi.mock('../../src/features/debugBreakpoints', () => ({ currentSourceBreakpoints: () => [], currentFunctionBreakpoints: () => [] }));
vi.mock('../../src/util/log', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock('../../src/config/settings', () => ({
  resolveSessionConfig: () => ({ run: { timeoutMs: 30_000, recordLocals: true, autoLog: true, http: 'record', httpObserve: true }, env: {} }),
  setting: (_k: string, fallback: unknown) => fallback,
}));

let runners: FakeRunner[] = [];

/** the `rankings` local: a dict the runtime cut at this depth (`expandable`, no `props`) */
const RANKINGS: ValueNode = { type: 'dict', id: 'v-rankings', queryPath: [], value: "{'a': [1, 2], 'b': [3]}", expandable: true, length: 2 };
const bag = (data: ValueNode): ValueBag => ({ data, runtimeKey: data.id });

class FakeRunner extends EventEmitter {
  ready: { capabilities: string[]; runtimeVersion?: string } | undefined;
  requests: Omit<RunRequest, 'type' | 'id'>[] = [];
  actions: Record<string, unknown>[] = [];
  /** every expression evaluated, in order */
  evaluated: string[] = [];
  expanded: { valueId: string; queryPath: string[] }[] = [];
  disposed = false;
  capabilities = ['record'];
  locals: { name: string; text: string; valueBag?: ValueBag }[] = [
    { name: 'rankings', text: "{'a': [1, 2], 'b': [3]}", valueBag: bag(RANKINGS) },
    { name: 'k', text: '60', valueBag: bag({ type: 'number', id: 'v-k', queryPath: [], value: '60' }) },
  ];

  constructor() {
    super();
    runners.push(this);
  }
  async start(): Promise<{ capabilities: string[] }> {
    this.ready = { capabilities: this.capabilities, runtimeVersion: '0.1.0' };
    return this.ready;
  }
  async run(req: Omit<RunRequest, 'type' | 'id'>): Promise<void> {
    this.requests.push(req);
  }
  async debug(_runId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.actions.push(body);
    return body['action'] === 'locals' ? { locals: this.locals } : {};
  }
  /** the paused frame knows `k` and `rankings`; `scores` is assigned later in the body */
  async evaluate(_runId: string, expression: string): Promise<{ text: string; valueBag: ValueBag }> {
    this.evaluated.push(expression);
    const local = this.locals.find((l) => l.name === expression);
    if (!local) throw new Error(`NameError: name '${expression}' is not defined`);
    return { text: local.text, valueBag: local.valueBag! };
  }
  async expand(_runId: string, valueId: string, queryPath: string[]): Promise<ValueNode> {
    this.expanded.push({ valueId, queryPath });
    return {
      ...RANKINGS,
      props: [
        { name: 'a', type: 'list', id: 'v-a', queryPath: ['a'], value: '[1, 2]', length: 2 },
        { name: 'b', type: 'list', id: 'v-b', queryPath: ['b'], value: '[3]', length: 1 },
      ],
    };
  }
  async stop(): Promise<void> {
    return undefined;
  }
  dispose(): void {
    this.disposed = true;
  }
  fire(ev: RunEvent): void {
    this.emit('event', ev);
  }
}

vi.mock('../../src/runtime/runnerClient', async () => {
  const actual = await import('../../src/runtime/runnerClient');
  return { ...actual, RunnerClient: FakeRunner };
});

const { DebugSessionManager } = await import('../../src/debug/debugSessionManager');
const { DebuggerViewHost } = await import('../../src/views/debuggerView');
const { parseLaunch } = await import('../../src/debug/debugSessionState');

const APP = '/ws/app.py';

function paused(step: number, over: Partial<DebugPausedEvent> = {}): DebugPausedEvent {
  return { type: 'debug.paused', runId: 'd-1', seq: 1, step, rid: 88, fileId: 2, line: 42, scopeId: 7, depth: 1, reason: 'breakpoint', stack: [{ frameId: 0, name: 'rrf', fileId: 2, line: 42 }], ...over };
}

/** poll until `fn` answers, the way the e2e helper does; the host's work is a few awaited promises */
async function until<T>(fn: () => T | undefined, what: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - started > 2000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function setup(): Promise<{ manager: InstanceType<typeof DebugSessionManager>; host: InstanceType<typeof DebuggerViewHost>; states: DebugSessionPanel[]; runner: FakeRunner }> {
  const manager = new DebugSessionManager('/rt');
  const states: DebugSessionPanel[] = [];
  const host = new DebuggerViewHost(manager, (msg: HostToWebview) => {
    if (msg.type === 'debug.session' && msg.state) states.push(msg.state);
  });
  await manager.start(parseLaunch({ program: APP, cwd: '/ws' }));
  const runner = runners[0]!;
  runner.fire({ type: 'run.started', runId: 'd-1', seq: 0, pid: 4711 });
  runner.fire({ type: 'file.instrumented', runId: 'd-1', seq: 1, fileId: 2, path: APP, rangeBase: 0, ranges: [], statements: [], functions: [], magic: [] });
  return { manager, host, states, runner };
}

const last = (states: DebugSessionPanel[]): DebugSessionPanel | undefined => states[states.length - 1];

beforeEach(() => {
  runners = [];
});

describe('DebuggerViewHost at a pause', () => {
  it('sends the frame: its variables with their bags, pending until they are read, and the stack', async () => {
    const { manager, states, runner } = await setup();
    runner.fire(paused(1403));
    // the state at the pause goes out before the locals arrive, and says they are on their way
    expect(last(states)?.paused).toBe(true);
    expect(last(states)?.localsPending).toBe(true);
    const withLocals = await until(() => (last(states)?.locals.length ? last(states) : undefined), 'the locals');
    expect(withLocals.localsPending).toBeUndefined();
    expect(withLocals.locals.map((l) => l.name)).toEqual(['rankings', 'k']);
    expect(withLocals.locals[0]!.valueBag?.data.expandable).toBe(true);
    // no folder holds the launch (the fake's is /w), so its cwd /ws is the project and the display path is relative to it
    expect(withLocals.stack).toEqual([{ frameId: 0, name: 'rrf', file: 'app.py', line: 42 }]);
    expect(withLocals.selectedFrame).toBe(0);
    manager.dispose();
  });

  it('values a watch added on the session itself at this pause, and leaves one with no value honest', async () => {
    const { manager, host, states, runner } = await setup();
    runner.fire(paused(1403));
    await until(() => (last(states)?.locals.length ? true : undefined), 'the locals');
    // what `pyokka watches --live --add rankings --add k --add scores` does: no view message involved
    const ds = manager.all()[0]!;
    ds.addDisplayWatch('rankings');
    ds.addDisplayWatch('k');
    ds.addDisplayWatch('scores');
    const valued = await until(() => {
      const s = last(states);
      return s && s.watches.length === 3 && s.watches.filter((w) => w.text !== undefined).length === 2 ? s : undefined;
    }, 'the watch values');
    expect(valued.watches).toEqual([
      { id: 'd1', exp: 'rankings', kind: 'display', text: "{'a': [1, 2], 'b': [3]}" },
      { id: 'd2', exp: 'k', kind: 'display', text: '60' },
      { id: 'd3', exp: 'scores', kind: 'display' },
    ]);
    // `scores` is not bound yet there: the row says so, and does not invent an error
    expect(watchValue(valued.watches[2]!, false)).toEqual({ text: 'no value at this stop', dim: true });
    // three `changed` events, one evaluation per watch
    expect(runner.evaluated).toEqual(['rankings', 'k', 'scores']);

    // the program runs on: the values belonged to that stop
    runner.fire({ type: 'debug.resumed', runId: 'd-1', seq: 5, step: 1403, action: 'continue' });
    expect(last(states)?.watches.map((w) => w.text)).toEqual([undefined, undefined, undefined]);
    expect(watchValue(last(states)!.watches[0]!, true).text).toBe('at the next pause');
    // and the next stop reads them again, in its own frame
    runner.fire(paused(1500, { seq: 6 }));
    const again = await until(() => (last(states)?.watches[1]?.text === '60' ? last(states) : undefined), 'the values at the next stop');
    expect(again.watches[0]!.text).toBe("{'a': [1, 2], 'b': [3]}");
    expect(runner.evaluated.slice(3)).toEqual(['rankings', 'k', 'scores']);

    // the view's own `+` goes through the same path
    await host.handle({ type: 'debug.watch.add', exp: 'k' });
    const four = await until(() => (last(states)?.watches.length === 4 && last(states)?.watches[3]?.text ? last(states) : undefined), 'the fourth watch');
    expect(four.watches[3]).toEqual({ id: 'd4', exp: 'k', kind: 'display', text: '60' });
    manager.dispose();
  });

  it('loads a member on request and keeps it in every state from then on', async () => {
    const { manager, host, states, runner } = await setup();
    runner.fire(paused(1403));
    await until(() => (last(states)?.locals.length ? true : undefined), 'the locals');
    await host.handle({ type: 'debug.expand', name: 'rankings', valueId: 'v-rankings', queryPath: [] });
    expect(runner.expanded).toEqual([{ valueId: 'v-rankings', queryPath: [] }]);
    const keys = (s: DebugSessionPanel | undefined): string[] | undefined => s?.locals[0]?.valueBag?.data.props?.map((p) => p.name);
    expect(keys(last(states))).toEqual(['a', 'b']);
    // a later push (any change) still carries the loaded members
    manager.all()[0]!.addDisplayWatch('k');
    await until(() => (last(states)?.watches[0]?.text ? true : undefined), 'the watch');
    expect(keys(last(states))).toEqual(['a', 'b']);
    // the next stop reads the frame afresh
    runner.fire({ type: 'debug.resumed', runId: 'd-1', seq: 5, step: 1403, action: 'continue' });
    runner.fire(paused(1500, { seq: 6 }));
    const fresh = await until(() => (last(states)?.locals.length ? last(states) : undefined), 'the next locals');
    expect(keys(fresh)).toBeUndefined();
    manager.dispose();
  });

  it('scopes the frame and the watches to a clicked frame, and goes back to the top frame at the next stop', async () => {
    const { manager, host, states, runner } = await setup();
    runner.fire(paused(1403, { stack: [{ frameId: 0, name: 'rrf', fileId: 2, line: 42 }, { frameId: 1, name: '<module>', fileId: 2, line: 80 }] }));
    await until(() => (last(states)?.locals.length ? true : undefined), 'the locals');
    manager.all()[0]!.addDisplayWatch('k');
    await until(() => (last(states)?.watches[0]?.text ? true : undefined), 'the watch');
    await host.handle({ type: 'debug.selectFrame', index: 1 });
    const scoped = await until(() => (last(states)?.selectedFrame === 1 && !last(states)?.localsPending ? last(states) : undefined), 'the frame');
    expect(runner.actions.filter((a) => a['action'] === 'locals').map((a) => a['frameId'])).toEqual([undefined, 1]);
    expect(scoped.watches[0]!.text).toBe('60');
    runner.fire({ type: 'debug.resumed', runId: 'd-1', seq: 5, step: 1403, action: 'continue' });
    runner.fire(paused(1500, { seq: 6 }));
    const next = await until(() => (last(states)?.locals.length ? last(states) : undefined), 'the next locals');
    expect(next.selectedFrame).toBe(0);
    manager.dispose();
  });
});
