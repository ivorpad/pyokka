import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { RunnerClient } from '../../src/runtime/runnerClient';
import type { RunEvent, RunRequest } from '../../src/shared/protocol';

const fake = path.join(__dirname, 'fixtures', 'fakeRunner.cjs');

function client(mode = 'normal'): RunnerClient {
  return new RunnerClient({ command: process.execPath, args: [fake], cwd: __dirname, env: { FAKE_MODE: mode }, requestTimeoutMs: 5000 });
}

const runReq: Omit<RunRequest, 'type' | 'id'> = {
  runId: 'r-1',
  file: { path: '/x.py', displayName: 'x.py', content: '' },
  workspaceRoot: '/',
  cwd: '/',
  argv: [],
  env: {},
  projectFiles: [],
  config: { logLimit: 1, maxConsoleMessages: 1, logLimits: { inline: { depth: 1, elements: 1 }, values: { default: { stringLength: 1 }, autoExpand: { depth: 1, elements: 1, stringLength: 1 } } }, maxLogEntrySize: 1, resolveGetters: false, autoLog: false, maxTraceSteps: 1, timeoutMs: 1, recordLocals: false, libraryCode: false, libraryPackages: [], hints: { ignoreCoverage: '', ignoreCoverageForFile: '' }, plugins: [], secrets: { mask: true, names: [] }, http: 'off', httpObserve: true },
  markers: [],
  expressionsToEvaluate: {},
  watch: [],
  mode: 'normal',
};

describe('RunnerClient', () => {
  it('handshakes, correlates replies by id and streams events (with split frames)', async () => {
    const c = client();
    const events: RunEvent[] = [];
    c.on('event', (e) => events.push(e));
    const ready = await c.start();
    expect(ready.pythonVersion).toBe('3.12.0');
    await c.run(runReq);
    await new Promise((r) => setTimeout(r, 80));
    expect(events.map((e) => e.type)).toEqual(['run.started', 'log', 'run.finished']);
    await expect(c.expand('r-1', 'v', [])).rejects.toThrow('no such value');
    expect(await c.source('r-1', 2)).toBe('_pk_s(0)');
    expect(await c.source('r-1', 3)).toBeUndefined();
    expect(await c.bindings('x = 1')).toEqual([{ line: 1, col: 0, assigns: ['x'], reads: [] }]);
    await expect(c.bindings('def (:')).rejects.toThrow('SyntaxError');
    c.dispose();
  });

  it('surfaces runner.error and rejects pending requests on a crash, then restarts', async () => {
    const c = client('crash');
    const errors: string[] = [];
    const exits: (number | null)[] = [];
    c.on('runnerError', (m) => errors.push(m));
    c.on('exit', (code) => exits.push(code));
    await c.start();
    // unknown request type -> runner.error (fake runner sends one for anything it does not know)
    await (c as unknown as { request(body: unknown): Promise<unknown> }).request({ type: 'bogus' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toEqual(['unknown request bogus']);
    await c.run(runReq); // fake runner exits with code 3 shortly after
    await new Promise((r) => setTimeout(r, 80));
    expect(exits).toEqual([3]);
    expect(c.alive).toBe(false);
    // next request re-spawns (with backoff) and works again
    const ready = await c.start();
    expect(ready.executable).toBe('/fake/python');
    c.dispose();
  }, 15000);
});
