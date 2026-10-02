import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, orderedSelection, pruneSelection, selectClick, selectMove } from '../../../webview/selection';

const order = ['a', 'b', 'c', 'd', 'e'];

describe('selectClick', () => {
  it('plain click selects one, clicking it again clears', () => {
    const s = selectClick(order, EMPTY_SELECTION, 'b', {});
    expect(s).toEqual({ ids: ['b'], anchor: 'b' });
    expect(selectClick(order, s, 'b', {})).toEqual(EMPTY_SELECTION);
  });
  it('shift-click selects the range from the anchor in list order', () => {
    const s = selectClick(order, { ids: ['d'], anchor: 'd' }, 'b', { shift: true });
    expect(s.ids).toEqual(['b', 'c', 'd']);
    expect(s.anchor).toBe('d');
  });
  it('cmd-click toggles membership', () => {
    const s = selectClick(order, { ids: ['a'], anchor: 'a' }, 'c', { meta: true });
    expect(s.ids).toEqual(['a', 'c']);
    expect(selectClick(order, s, 'a', { meta: true }).ids).toEqual(['c']);
  });
});

describe('selectMove', () => {
  it('moves the focus with arrows and extends with shift', () => {
    const s = selectMove(order, { ids: ['b'], anchor: 'b' }, 1, false);
    expect(s.ids).toEqual(['c']);
    expect(selectMove(order, s, 1, true).ids).toEqual(['c', 'd']);
    expect(selectMove(order, EMPTY_SELECTION, -1, false).ids).toEqual(['e']);
    expect(selectMove(order, { ids: ['e'], anchor: 'e' }, 1, false).ids).toEqual(['e']);
  });
});

describe('prune / ordered', () => {
  it('drops vanished ids and orders by list position', () => {
    const s = { ids: ['d', 'x', 'a'], anchor: 'x' };
    expect(pruneSelection(order, s)).toEqual({ ids: ['d', 'a'], anchor: 'd' });
    expect(orderedSelection(order, s)).toEqual(['a', 'd']);
  });
});
