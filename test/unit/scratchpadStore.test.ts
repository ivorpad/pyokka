import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CHANGED_ELSEWHERE, ScratchpadStore } from '../../web/scratchpadStore';
import type { ScratchState } from '../../web/scratchpadProtocol';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-scratch-store-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

const state: ScratchState = {
  id: 'one', title: 'Checkout', open: true, file: '/demo/shop.py', code: 'result = checkout(items, coupon)\n', inputs: "items = [('a', 2)]\n", mocks: '', unavailable: { cart: 'cart is a Cart object' },
  autoRun: true, revision: 1, status: 'dirty', result: null, error: null, provenance: { file: '/demo/shop.py', line: 22, function: 'checkout', runId: 'd-1', step: 4, frame: 0 },
  savedVersion: 0, loadedVersion: null, saveError: null, sandbox: null, liveExecutionChanged: false,
};
const snapshot = { id: 'one', title: 'Checkout', reason: 'create', state, baseline: { code: state.code, inputs: state.inputs, mocks: '' }, expectedVersion: 0 };

describe('scratchpad store', () => {
  it('adds a version per save and keeps every earlier one as it was', () => {
    const store = new ScratchpadStore(directory);
    const first = store.save(snapshot);
    const second = new ScratchpadStore(directory).save({ ...snapshot, expectedVersion: 1, reason: 'run', state: { ...state, code: 'result = 2\n', status: 'completed' } });
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.get('one', 1).state.code).toBe(state.code);
    expect(store.get('one').state.code).toBe('result = 2\n');
    expect(store.history('one').map((e) => [e.version, e.reason])).toEqual([[2, 'run'], [1, 'create']]);
  });

  it('refuses a save built on a version that is no longer the latest, and changes nothing', () => {
    const store = new ScratchpadStore(directory);
    const before = fs.readFileSync(path.join(directory, 'one', '2.json'), 'utf8');
    expect(() => store.save({ ...snapshot, expectedVersion: 1, state: { ...state, code: 'stale = True\n' } })).toThrow(CHANGED_ELSEWHERE);
    expect(fs.readFileSync(path.join(directory, 'one', '2.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(directory, 'one')).sort()).toEqual(['1.json', '2.json']);
  });

  it('refuses ids that would leave its directory', () => {
    expect(() => new ScratchpadStore(directory).get('../one')).toThrow('Invalid scratchpad id');
  });
});
