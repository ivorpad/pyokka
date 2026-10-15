import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { RunnerClient } from '../../src/runtime/runnerClient';

// A broken stdin pipe rejects the requests in flight instead of leaving them hanging
const fake = path.join(__dirname, 'fixtures', 'fakeRunner.cjs');
const client = () => new RunnerClient({ command: process.execPath, args: [fake], cwd: __dirname, env: { FAKE_MODE: 'normal' }, requestTimeoutMs: 60_000 });
const procOf = (c: RunnerClient) => (c as unknown as { proc: ChildProcess }).proc;

describe('RunnerClient stdin failures', () => {
  it('an EPIPE on stdin rejects every pending request, and one after teardown is ignored', async () => {
    const c = client();
    try {
      await c.start();
      const proc = procOf(c);
      // the fake runner never answers `evaluate`, so both stay in flight until something rejects them
      const pending = Promise.allSettled([c.evaluate('r-1', 'first'), c.evaluate('r-1', 'second')]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      expect(() => proc.stdin!.emit('error', error)).not.toThrow();
      const results = await pending;
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      for (const r of results) if (r.status === 'rejected') expect(String(r.reason.message)).toContain('Pyokka runner input failed: write EPIPE');
      c.dispose();
      expect(() => proc.stdin!.emit('error', error)).not.toThrow();
    } finally {
      c.dispose();
    }
  }, 15_000);

  it('killing the child with a request in flight rejects it', async () => {
    const c = client();
    try {
      await c.start();
      const inFlight = c.evaluate('r-1', 'x');
      const settled = inFlight.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`);
      procOf(c).kill('SIGKILL');
      expect(await settled).toMatch(/^rejected: /);
    } finally {
      c.dispose();
    }
  }, 15_000);
});
