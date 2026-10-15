import { describe, expect, it, vi } from 'vitest';
import { localsOptions, localsReply } from '../../src/agent/bridgeDebugShapes';
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
