import { describe, expect, it, vi } from 'vitest';
import { localsOptions, localsReply } from '../../src/agent/bridgeDebugShapes';
import { sliceOptions } from '../../src/agent/bridgeSupport';
import { RunnerClient } from '../../src/runtime/runnerClient';
import { localsRequest } from '../../src/session/debugState';

// the shapes module reaches vscode through its imports; nothing under test touches it
vi.mock('vscode', () => ({}));

// `locals` takes scope, names and namesOnly through both bridges
describe('locals options', () => {
  it('passes scope, names and namesOnly to the runtime request', () => {
    const opts = localsOptions({ type: 'locals', frameId: 2, scope: 'global', names: ['config', 7], namesOnly: true });
    expect(opts).toEqual({ frameId: 2, scope: 'global', names: ['config'], namesOnly: true });
    expect(localsRequest(opts)).toEqual({ frameId: 2, scope: 'global', names: ['config'], namesOnly: true });
    expect(localsRequest(localsOptions({ type: 'locals' }))).toEqual({});
  });
  it('refuses a scope the runtime does not know', () => {
    expect(() => localsOptions({ type: 'locals', scope: 'everything' })).toThrow(/scope must be local, global or all/);
  });
  it('keeps the type a names-only reply carries', () => {
    expect(localsReply([{ name: 'config', text: '', type: 'dict' }], false)).toEqual([{ name: 'config', text: '', type: 'dict' }]);
  });
});

// An agent asks a live pause for longer texts (`textLen`, the runtime's `limits.textLen`); the editor's
// hover, Variables view and watches send nothing and keep the runtime's 200 (smoke test 2026-10-19)
describe('the text length of a live pause', () => {
  it('forwards textLen as limits.textLen, 0 included, and leaves the editor request as it was', () => {
    expect(localsRequest(localsOptions({ type: 'locals', names: ['policy'], textLen: 2000 }))).toEqual({ names: ['policy'], limits: { textLen: 2000 } });
    expect(localsRequest(localsOptions({ type: 'locals', textLen: 0 }))).toEqual({ limits: { textLen: 0 } });
    // what the Variables view asks (debugLocals({frameId})): no limits, so the runtime answers as before
    expect(localsRequest({ frameId: 1 })).toEqual({ frameId: 1 });
  });

  it('carries textLen into a stop through the slice options, and nothing without it', () => {
    expect(sliceOptions({ type: 'continue', scope: true, textLen: 2000 })).toEqual({ scope: true, valueBag: false, textLen: 2000 });
    expect(sliceOptions({ type: 'continue' })).toEqual({ scope: false, valueBag: false });
  });

  it('passes the fields of a cut value through, redacted like its text', () => {
    const text = "Policy(allowed_schemes=frozenset({'https'}), …(+1,123 chars)";
    const fields: [string, string][] = [['.allowed_schemes', "frozenset({'https'})"], ['.header', 'Bearer abcdefghijklmnop']];
    expect(localsReply([{ name: 'policy', text, fields, fieldsMore: 3 }], false)).toEqual([{ name: 'policy', text, fields: [['.allowed_schemes', "frozenset({'https'})"], ['.header', 'Bearer «redacted»']], fieldsMore: 3 }]);
    expect(localsReply([{ name: 'n', text: '3' }], false)).toEqual([{ name: 'n', text: '3' }]);
  });

  it('puts limits on an evaluate request only when it was asked for', async () => {
    const client = new RunnerClient({ command: 'unused', args: [], cwd: '/', env: {}, requestTimeoutMs: 1000 });
    const sent: Record<string, unknown>[] = [];
    (client as unknown as { request: (body: Record<string, unknown>) => Promise<unknown> }).request = async (body) => {
      sent.push(body);
      return { type: 'evaluated', text: '1', valueBag: {} };
    };
    await client.evaluate('r-1', 'policy', { textLen: 2000 });
    await client.evaluate('r-1', 'policy', { frameId: 2 });
    expect(sent).toEqual([
      { type: 'evaluate', runId: 'r-1', expression: 'policy', limits: { textLen: 2000 } },
      { type: 'evaluate', runId: 'r-1', expression: 'policy', frameId: 2 },
    ]);
  });
});
