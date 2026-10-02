import { describe, expect, it } from 'vitest';
import { MarkerStore, remapRange } from '../../src/session/markers';

describe('remapRange', () => {
  const marker: [number, number, number, number] = [10, 4, 10, 9];

  it('shifts down when lines are inserted above', () => {
    expect(remapRange(marker, { startLine: 3, startCol: 0, endLine: 3, endCol: 0, text: 'a\nb\n' })).toEqual({ range: [12, 4, 12, 9], changed: false });
  });

  it('shifts up when lines are deleted above', () => {
    expect(remapRange(marker, { startLine: 2, startCol: 0, endLine: 4, endCol: 0, text: '' })).toEqual({ range: [8, 4, 8, 9], changed: false });
  });

  it('shifts columns for an edit earlier on the same line', () => {
    expect(remapRange(marker, { startLine: 10, startCol: 0, endLine: 10, endCol: 0, text: 'xy' })).toEqual({ range: [10, 6, 10, 11], changed: false });
  });

  it('ignores edits after the marker', () => {
    expect(remapRange(marker, { startLine: 10, startCol: 9, endLine: 10, endCol: 9, text: 'zzz' })).toEqual({ range: marker, changed: false });
    expect(remapRange(marker, { startLine: 20, startCol: 0, endLine: 21, endCol: 0, text: '' })).toEqual({ range: marker, changed: false });
  });

  it('grows and flags a change for an edit inside the marker', () => {
    expect(remapRange(marker, { startLine: 10, startCol: 6, endLine: 10, endCol: 6, text: '_x' })).toEqual({ range: [10, 4, 10, 11], changed: true });
  });

  it('drops the marker when an edit crosses its boundary or empties it', () => {
    expect(remapRange(marker, { startLine: 10, startCol: 2, endLine: 10, endCol: 6, text: '' })).toBeUndefined();
    expect(remapRange(marker, { startLine: 10, startCol: 4, endLine: 10, endCol: 9, text: '' })).toBeUndefined();
  });

  it('handles a newline typed inside the marker (multi-line result)', () => {
    expect(remapRange(marker, { startLine: 10, startCol: 6, endLine: 10, endCol: 6, text: '\n' })).toEqual({ range: [10, 4, 11, 3], changed: true });
  });
});

describe('MarkerStore', () => {
  it('bumps changeId only for markers whose text changed', () => {
    const store = new MarkerStore();
    const a = store.add({ kind: 'value', range: [5, 0, 5, 3], origin: 'showValue' });
    const b = store.add({ kind: 'value', range: [9, 2, 9, 8], origin: 'showValue' });
    store.applyEdits([{ startLine: 1, startCol: 0, endLine: 1, endCol: 0, text: '# hi\n' }]);
    expect(store.byId(a.id)?.range).toEqual([6, 0, 6, 3]);
    expect(store.byId(a.id)?.changeId).toBe(a.changeId);
    store.applyEdits([{ startLine: 10, startCol: 4, endLine: 10, endCol: 4, text: 'Q' }]);
    expect(store.byId(b.id)?.range).toEqual([10, 2, 10, 9]);
    expect(store.byId(b.id)?.changeId).not.toBe(b.changeId);
    expect(store.onLine(6).map((m) => m.id)).toEqual([a.id]);
    expect(store.forRun()[0]).not.toHaveProperty('origin');
  });

  it('transient markers are sent to the runner but not visible', () => {
    const store = new MarkerStore();
    store.add({ kind: 'value', range: [1, 0, 1, 1], origin: 'transient', transient: true });
    expect(store.visible()).toHaveLength(0);
    expect(store.forRun()).toHaveLength(1);
  });
});
