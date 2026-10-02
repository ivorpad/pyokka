import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DebugPausedEvent, RunEvent, RunFinishedEvent, RunRequest } from '../../src/shared/protocol';
import { OUTPUT_KEPT } from '../../src/session/outputBuffer';

/* ---------- the host around a DebugSession, faked ---------- */

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
  // the registry asks which workspace folder a launch belongs to, and which editor is active
  workspace: { getWorkspaceFolder: () => undefined, workspaceFolders: [{ uri: { fsPath: '/w' } }] },
  window: { activeTextEditor: undefined },
}));
vi.mock('../../src/util/context', () => ({ setContext: (key: string, value: boolean) => void contextKeys.set(key, value) }));
vi.mock('../../src/debug/debugContext', () => ({ updateDebugContext: () => undefined }));
vi.mock('../../src/runtime/interpreter', () => ({ resolveInterpreter: async () => ({ path: '/v/bin/python', version: [3, 12, 9], source: 'setting', isVenv: true }) }));
vi.mock('../../src/features/debugBreakpoints', () => ({ currentSourceBreakpoints: () => gutter, currentFunctionBreakpoints: () => functionGutter }));
vi.mock('../../src/util/log', () => ({ log: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock('../../src/config/settings', () => ({
  resolveSessionConfig: () => ({ run: { timeoutMs: 30_000, recordLocals: true, autoLog: true, http: 'record', httpObserve: true }, env: { BASE: '1' } }),
  setting: (_k: string, fallback: unknown) => fallback,
}));

/** what the registry wrote to `setContext`, per key */
const contextKeys = new Map<string, boolean>();
let gutter: { path: string; line: number }[] = [];
/** the Breakpoints view's function breakpoints (`--at NAME`); empty for every case here */
let functionGutter: { function: string }[] = [];
let runners: FakeRunner[] = [];

class FakeRunner extends EventEmitter {
  ready: { capabilities: string[]; runtimeVersion?: string } | undefined;
  requests: Omit<RunRequest, 'type' | 'id'>[] = [];
  actions: Record<string, unknown>[] = [];
  stopped: string[] = [];
  disposed = false;
  capabilities = ['record'];
  locals: { name: string; text: string }[] = [];

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
  async stop(runId: string): Promise<void> {
    this.stopped.push(runId);
  }
  dispose(): void {
    this.disposed = true;
  }
  /** what the child would send */
  fire(ev: RunEvent): void {
    this.emit('event', ev);
  }
}

vi.mock('../../src/runtime/runnerClient', async () => {
  const actual = await import('../../src/runtime/runnerClient');
  return { ...actual, RunnerClient: FakeRunner };
});

const { DebugSession } = await import('../../src/debug/debugSession');
const { DebugSessionManager } = await import('../../src/debug/debugSessionManager');
const { parseLaunch } = await import('../../src/debug/debugSessionState');

const APP = '/ws/app.py';

function make(over: Record<string, unknown> = {}): InstanceType<typeof DebugSession> {
  return new DebugSession({ id: 'debug-1', launch: parseLaunch({ program: APP, cwd: '/ws', ...over }), runtimeDir: '/rt', workspaceRoot: '/ws' });
}

function paused(step: number, over: Partial<DebugPausedEvent> = {}): DebugPausedEvent {
  return { type: 'debug.paused', runId: 'd-1', seq: 1, step, rid: 88, fileId: 2, line: 42, scopeId: 7, depth: 1, reason: 'breakpoint', stack: [{ frameId: 0, name: 'do_GET', fileId: 2, line: 42 }], ...over };
}

function finished(over: Partial<RunFinishedEvent> = {}): RunFinishedEvent {
  return { type: 'run.finished', runId: 'd-1', seq: 9, exitCode: 0, durationMs: 12, timedOut: false, stopped: false, stepCount: 1403, logCount: 0, ...over };
}

beforeEach(() => {
  runners = [];
  gutter = [];
});

/** A finished session lingers briefly so a reply that was waiting reaches its socket. */
const disposed = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

describe('DebugSession', () => {
  it('sends one run with no recording, no timeout and no buffer content', async () => {
    gutter = [{ path: APP, line: 42 }];
    const ds = make();
    await ds.start();
    const runner = runners[0]!;
    expect(runner.requests).toHaveLength(1);
    const req = runner.requests[0]!;
    expect(req.config.record).toBe(false);
    expect(req.config.debug).toBe(true);
    expect(req.config.timeoutMs).toBe(0);
    expect(req.config.recordLocals).toBe(false);
    expect(req.config.autoLog).toBe(false);
    expect(req.config.http).toBe('off');
    expect(req.config.httpObserve).toBe(false);
    expect(req.file).toEqual({ path: APP, displayName: 'app.py' });
    expect(req.file?.content).toBeUndefined();
    expect(req.breakpoints).toEqual([{ path: APP, line: 42 }]);
    expect(req.markers).toEqual([]);
    expect(req.watch).toEqual([]);
    expect(req.env).toMatchObject({ BASE: '1' });
    ds.dispose();
  });

  it('sends a module launch as `module`, with its arguments', async () => {
    const ds = make({ program: undefined, module: 'app.server', args: ['--port', '8000'], env: { PORT: '8000' } });
    await ds.start();
    const req = runners[0]!.requests[0]!;
    expect(req.module).toBe('app.server');
    expect(req.file).toBeUndefined();
    expect(req.argv).toEqual(['--port', '8000']);
    expect(req.env).toMatchObject({ BASE: '1', PORT: '8000' });
    expect(ds.displayName).toBe('-m app.server');
    ds.dispose();
  });

  it('walks starting -> running -> paused -> running -> ended', async () => {
    const ds = make();
    const seen: string[] = [];
    ds.on('started', () => seen.push('started'));
    ds.on('paused', () => seen.push('paused'));
    ds.on('resumed', () => seen.push('resumed'));
    ds.on('finished', () => seen.push('finished'));
    ds.on('ended', () => seen.push('ended'));
    expect(ds.status).toBe('starting');
    await ds.start();
    const runner = runners[0]!;
    runner.fire({ type: 'run.started', runId: 'd-1', seq: 0, pid: 4711 });
    expect(ds.status).toBe('running');
    runner.fire(paused(1403));
    expect(ds.status).toBe('paused');
    expect(ds.debug.paused?.step).toBe(1403);
    runner.fire({ type: 'debug.resumed', runId: 'd-1', seq: 2, step: 1403, action: 'continue' });
    expect(ds.status).toBe('running');
    expect(ds.debug.paused).toBeUndefined();
    runner.fire(finished());
    expect(ds.status).toBe('ended');
    expect(seen).toEqual(['started', 'paused', 'resumed', 'finished']);
    // the session lingers one beat so the reply that was waiting reaches its socket, then goes
    await disposed();
    expect(ds.isDisposed).toBe(true);
    expect(runner.disposed).toBe(true);
    expect(seen).toEqual(['started', 'paused', 'resumed', 'finished', 'ended']);
  });

  it('keeps the main file, the output tail and the uncaught error of the run', async () => {
    const ds = make();
    await ds.start();
    const runner = runners[0]!;
    runner.fire({ type: 'file.instrumented', runId: 'd-1', seq: 1, fileId: 2, path: APP, rangeBase: 0, ranges: [], statements: [], functions: [], magic: [] });
    expect(ds.mainFile).toBe(APP);
    runner.fire({ type: 'output', runId: 'd-1', seq: 2, stream: 'stdout', text: 'listening on 8000\n' });
    expect(ds.output).toBe('listening on 8000\n');
    // the buffer keeps the last 64 KB and nothing else
    runner.fire({ type: 'output', runId: 'd-1', seq: 3, stream: 'stdout', text: 'x'.repeat(OUTPUT_KEPT) });
    expect(ds.output).toHaveLength(OUTPUT_KEPT);
    expect(ds.output.endsWith('x')).toBe(true);
    expect(ds.output.includes('listening')).toBe(false);
    runner.fire({ type: 'error', runId: 'd-1', seq: 4, fileId: 2, rid: 88, step: 1403, message: 'too big: 3', errorType: 'ValueError', stack: [], handled: false, traceback: 'Traceback…' });
    expect(ds.errors).toHaveLength(1);
    ds.dispose();
  });

  it('restarts in place, keeping the launch, the breakpoints and the exception mode', async () => {
    const ds = make();
    await ds.start();
    const runner = runners[0]!;
    runner.fire({ type: 'run.started', runId: 'd-1', seq: 0, pid: 1 });
    await ds.setDebugBreakpoints([{ path: APP, line: 60 }]);
    await ds.setDebugExceptions('raised');
    await ds.setDebugWatches([{ id: 'w1', exp: 'rank == 3', breakWhen: 'true' }]);
    runner.fire({ type: 'output', runId: 'd-1', seq: 1, stream: 'stdout', text: 'first run\n' });
    runner.fire({ type: 'file.instrumented', runId: 'd-1', seq: 2, fileId: 2, path: APP, rangeBase: 0, ranges: [], statements: [], functions: [], magic: [] });
    runner.fire(paused(10, { modified: true }));
    expect(ds.modified).toBe(true);

    const restart = ds.restart({ stopOnEntry: true });
    runner.fire(finished({ stopped: true }));
    await restart;
    expect(ds.isDisposed).toBe(false);
    expect(runners).toHaveLength(1); // the same runner, a new child
    expect(runner.requests).toHaveLength(2);
    const second = runner.requests[1]!;
    expect(second.runId).toBe('d-2');
    expect(second.config.stopOnEntry).toBe(true);
    expect(second.config.breakOnException).toBe('raised');
    expect(second.breakpoints).toEqual([{ path: APP, line: 60 }]);
    expect(ds.debug.watches).toEqual([{ id: 'w1', exp: 'rank == 3', breakWhen: 'true' }]);
    expect(ds.launch.program).toBe(APP);
    // the new child has a new namespace and no output yet
    expect(ds.modified).toBe(false);
    expect(ds.output).toBe('');
    expect(ds.mainFile).toBeUndefined();
    ds.dispose();
  });

  it('settles waitForPause on a pause and on a finish', async () => {
    const ds = make();
    await ds.start();
    const runner = runners[0]!;
    const first = ds.waitForPause(5000);
    runner.fire(paused(7));
    expect(await first).toMatchObject({ step: 7 });
    const second = ds.waitForPause(5000);
    runner.fire(finished());
    expect(await second).toBe('finished');
    // a disposed session answers at once rather than hanging
    expect(await ds.waitForPause(5000)).toBe('finished');
  });

  it('ends the session when the runner exits without run.finished', async () => {
    const ds = make();
    await ds.start();
    let ended = false;
    ds.on('ended', () => (ended = true));
    runners[0]!.emit('exit', 1, null, false);
    expect(ds.status).toBe('ended');
    expect(ds.lastFinished?.stopped).toBe(true);
    await disposed();
    expect(ended).toBe(true);
  });

  it('refuses a record: false run against a runtime that cannot serve one', async () => {
    const ds = make();
    const original = FakeRunner.prototype.start;
    FakeRunner.prototype.start = async function (this: FakeRunner) {
      this.ready = { capabilities: [] };
      return this.ready;
    };
    try {
      await expect(ds.start()).rejects.toThrow(/older than the extension/);
    } finally {
      FakeRunner.prototype.start = original;
    }
  });

  it('refuses the pause verbs while the program runs and forwards frameId to locals', async () => {
    const ds = make();
    await ds.start();
    const runner = runners[0]!;
    runner.fire({ type: 'run.started', runId: 'd-1', seq: 0, pid: 1 });
    await expect(ds.debugContinue()).rejects.toThrow(/the program is running/);
    await expect(ds.debugLocals()).rejects.toThrow(/the program is running/);
    runner.fire(paused(3));
    runner.locals = [{ name: 'payload', text: "{'q': 'a'}" }];
    expect(await ds.debugLocals({ frameId: 2 })).toEqual([{ name: 'payload', text: "{'q': 'a'}" }]);
    expect(runner.actions.at(-1)).toEqual({ action: 'locals', frameId: 2 });
    await ds.debugStep('over');
    expect(runner.actions.at(-1)).toEqual({ action: 'step', kind: 'over' });
    ds.dispose();
  });
});

describe('DebugSessionManager', () => {
  it('announces a new session once, and a second start on the same key restarts it instead', async () => {
    const mgr = new DebugSessionManager('/rt');
    const started: string[] = [];
    const ended: string[] = [];
    mgr.on('sessionStarted', (ds) => started.push(ds.id));
    mgr.on('sessionEnded', (ds) => ended.push(ds.id));
    const launch = parseLaunch({ program: APP, cwd: '/ws' });
    const ds = await mgr.start(launch);
    // the panel's reveal hangs off this event, so it must fire once per session, before the run
    expect(started).toEqual([ds.id]);
    expect(runners[0]!.requests).toHaveLength(1);
    expect(contextKeys.get('debugSessionActive')).toBe(true);

    // the same launch key restarts in place: the same session, no second announcement
    const again = await mgr.start(launch);
    expect(again).toBe(ds);
    expect(started).toEqual([ds.id]);
    // the restart sent a fresh run on the same runner
    expect(runners[0]!.requests).toHaveLength(2);

    // a different cwd is a different key and is announced on its own
    const other = await mgr.start(parseLaunch({ program: APP, cwd: '/ws/sub' }));
    expect(other).not.toBe(ds);
    expect(started).toEqual([ds.id, other.id]);

    mgr.dispose();
    expect(ended.sort()).toEqual([ds.id, other.id].sort());
  });

  it('does not announce a session whose start failed', async () => {
    const mgr = new DebugSessionManager('/rt');
    const started: string[] = [];
    mgr.on('sessionStarted', (ds) => started.push(ds.id));
    const original = FakeRunner.prototype.start;
    FakeRunner.prototype.start = async function (this: FakeRunner) {
      this.ready = { capabilities: [] };
      return this.ready;
    };
    try {
      await expect(mgr.start(parseLaunch({ program: APP, cwd: '/ws' }))).rejects.toThrow(/older than the extension/);
    } finally {
      FakeRunner.prototype.start = original;
    }
    // the event went out before the failure, so the panel may have revealed the view; the session
    // is gone from the registry either way and `sessionEnded` takes the view down again
    expect(mgr.all()).toEqual([]);
    expect(started).toHaveLength(1);
    mgr.dispose();
  });
});
