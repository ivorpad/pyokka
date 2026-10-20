import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunnerClient } from '../../src/runtime/runnerClient';
import { transportRunnerOptions, probeTransportInterpreter } from '../../src/runtime/transportRunner';
import { parseLaunch } from '../../src/debug/debugSessionState';

const repo = path.resolve(__dirname, '../..');
const python = path.join(repo, 'python/.venv/bin/python');

describe('transport runner', () => {
  it('stages the bundled runtime over stdin, preserves wrapper state, maps recorded paths and removes staging on shutdown', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'pyokka-transport-'));
    const remote = path.join(scratch, 'remote');
    mkdirSync(remote);
    const wrapper = path.join(scratch, 'wrapper.sh');
    writeFileSync(wrapper, '#!/bin/sh\nexport WRAPPER_SESSION=present\nexec "$@"\n');
    const launch = parseLaunch({ program: '/local/project/main.py', cwd: remote, python,
      transport: { command: '/bin/sh', args: [wrapper] }, pathMappings: [{ localRoot: '/local/project', remoteRoot: remote }], record: true });
    const options = transportRunnerOptions(launch, path.join(repo, 'python'), scratch);
    const client = new RunnerClient(options);
    const events: Record<string, unknown>[] = [];
    let stderr = '';
    client.on('stderr', (text) => { stderr += text; });
    client.on('event', (e) => events.push(e as unknown as Record<string, unknown>));
    try {
      const interpreter = await probeTransportInterpreter(launch, scratch);
      expect(interpreter.version[0]).toBe(3);
      const ready = await client.start().catch((err: Error) => { throw new Error(`${err.message}\n${stderr}`); });
      expect(ready.runtimeVersion).toBeTruthy();
      const finished = new Promise<void>((resolve) => client.on('event', (e) => { if (e.type === 'run.finished') resolve(); }));
      await client.forward({ type: 'run', runId: 'transport-test', file: { path: '/local/project/main.py', displayName: 'main.py',
        content: 'import os, sys, pyokka_runtime\nroot = pyokka_runtime.__file__\nstate = os.environ["WRAPPER_SESSION"]\nprint(state, os.getcwd())\n' },
        workspaceRoot: '/local/project', cwd: remote, argv: [], env: {}, projectFiles: [], config: { record: true, timeoutMs: 10000, http: 'off', httpObserve: false } } as never);
      await finished;
      expect(events.find((e) => e.type === 'run.finished')).toMatchObject({ exitCode: 0 });
      expect(events.find((e) => e.type === 'file.instrumented')).toMatchObject({ path: '/local/project/main.py' });
      expect(events.some((e) => e.type === 'trace')).toBe(true);
      expect((await client.evaluate('transport-test', 'state')).text).toContain('present');
      const staged = (await client.evaluate('transport-test', 'root')).text.replace(/^['"]|['"]$/g, '');
      expect(staged).toContain('pyokka-transport-');
      expect(staged).not.toContain(path.join(repo, 'python'));
      expect(existsSync(staged)).toBe(true);
      await client.shutdown();
      expect(existsSync(staged)).toBe(false);
    } finally {
      await client.shutdown();
      client.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
