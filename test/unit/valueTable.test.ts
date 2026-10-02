/** Homogeneous collections as a table: detection, columns, cells, footer counts, sorting. */
import { describe, expect, it } from 'vitest';
import type { ValueNode, ValueProp } from '../../src/shared/protocol';
import { cellText, footerText, shapeLabel, sortRows, tableFor } from '../../webview/valueTable';

let id = 0;
const n = (type: string, value?: string, extra: Partial<ValueNode> = {}): ValueNode => ({ id: `v${++id}`, queryPath: [`q${id}`], type, value, ...extra });
const p = (name: string, node: ValueNode): ValueProp => ({ ...node, name, ...(node.type === 'dict' ? {} : {}) });
const dict = (entries: [string, ValueNode][], extra: Partial<ValueNode> = {}) => n('dict', undefined, { props: entries.map(([k, v]) => ({ ...p(k, v), keyRepr: `'${k}'` })), length: entries.length, ...extra });
const seq = (type: 'list' | 'tuple', items: ValueNode[], extra: Partial<ValueNode> = {}) => n(type, undefined, { props: items.map((v, i) => p(String(i), v)), length: items.length, ...extra });
const str = (s: string, extra: Partial<ValueNode> = {}) => n('str', s, extra);
const num = (x: number) => n('number', String(x));
const none = () => n('None');

/** the mockup's parent_items: 38 pairs (candidate, entry); the first seven have a patron and a filled entry, 31 have neither */
function parentItems(): ValueNode {
  const pairs: ValueNode[] = [];
  for (let i = 0; i < 38; i++) {
    const preferred = i < 7;
    const candidate = dict([
      ['path', str(`components/item_${i}.yaml`)],
      ['score', num(preferred ? 1 : Math.round((0.3 + (i % 7) / 10) * 1e6) / 1e6)],
      ['retrieval_score', num(preferred ? 1 : 0.5)],
      ['patron', preferred ? str('LIBRE') : none()],
    ]);
    const entry = preferred ? dict([['a', num(1)], ['b', num(2)], ['c', num(3)], ['d', num(4)]]) : dict([]);
    pairs.push(seq('tuple', [candidate, entry]));
  }
  return seq('list', pairs);
}

describe('tableFor: tuples of dicts (the mockup)', () => {
  const root = parentItems();
  const model = tableFor(root)!;
  it('accepts and expands the dict position into sub-columns, keeps the sparse one whole', () => {
    expect(model.shape).toBe('tuples');
    expect(model.columns.map((c) => c.label)).toEqual(['[0].path', '[0].score', '[0].retrieval_score', '[0].patron', '[1]']);
    expect(model.columns.map((c) => c.kind)).toEqual(['string', 'number', 'number', 'string', 'nested']);
    expect(model.rows).toHaveLength(38);
  });
  it('collapses nested cells to their size and marks None and empty', () => {
    const row3 = model.rows[3]!;
    const row9 = model.rows[9]!;
    expect(row9.cells.map((c) => c?.text)).toEqual(["'components/item_9.yaml'", '0.5', '0.5', 'None', '{}']);
    expect(row9.cells[3]!.isNone).toBe(true);
    expect(row9.cells[4]!.isEmpty).toBe(true);
    expect(row3.cells[3]!.text).toBe("'LIBRE'");
    expect(model.rows[0]!.cells[4]!.text).toBe('{4 keys}');
    expect(model.rows[0]!.cells[3]!.text).toBe("'LIBRE'");
  });
  it('counts what matters in the footer and scales bars to the unit interval', () => {
    expect(footerText(model)).toBe('38 rows · 31 have [0].patron None · 31 have an empty [1]');
    expect(model.columns[1]!.max).toBe(1);
    expect(model.columns[1]!.unit).toBe(true);
    expect(shapeLabel(root, model)).toBe('list · 38 × (dict, dict)');
  });
  it('keeps every cell tied to its node so the tree can open it', () => {
    expect(model.rows[3]!.cells[0]!.node!.type).toBe('str');
    expect(model.rows[3]!.node.type).toBe('tuple');
  });
});

describe('tableFor: lists of dicts', () => {
  it('accepts three or more dicts sharing their keys, in first-seen key order', () => {
    const root = seq('list', [dict([['a', num(1)], ['b', str('x')]]), dict([['a', num(2)], ['b', str('y')]]), dict([['b', str('z')], ['a', num(3)]])]);
    const model = tableFor(root)!;
    expect(model.shape).toBe('dicts');
    expect(model.columns.map((c) => c.label)).toEqual(['a', 'b']);
    expect(model.rows.map((r) => r.cells.map((c) => c!.text))).toEqual([['1', "'x'"], ['2', "'y'"], ['3', "'z'"]]);
    expect(footerText(model)).toBe('3 rows');
  });
  it('tolerates a key missing in fewer than half the rows and counts it', () => {
    const rows = [dict([['a', num(1)], ['b', num(2)]]), dict([['a', num(1)], ['b', num(2)]]), dict([['a', num(1)], ['b', num(2)]]), dict([['a', num(1)]])];
    const model = tableFor(seq('list', rows))!;
    expect(model.columns.map((c) => c.label)).toEqual(['a', 'b']);
    expect(model.rows[3]!.cells[1]).toBeUndefined();
    expect(footerText(model)).toBe('4 rows · 1 lack b');
  });
  it('refuses a key that covers less than half the rows, more than twelve keys, unloaded items, mixed items and short lists', () => {
    expect(tableFor(seq('list', [dict([['a', num(1)], ['z', num(0)]]), dict([['a', num(1)]]), dict([['a', num(1)]]), dict([['a', num(1)]]), dict([['a', num(1)]])]))).toBeUndefined();
    const wide = Array.from({ length: 3 }, () => dict(Array.from({ length: 13 }, (_, k) => [`k${k}`, num(k)] as [string, ValueNode])));
    expect(tableFor(seq('list', wide))).toBeUndefined();
    expect(tableFor(seq('list', [n('dict', '{…}', { expandable: true }), dict([['a', num(1)]]), dict([['a', num(1)]])]))).toBeUndefined();
    expect(tableFor(seq('list', [dict([['a', num(1)]]), num(2), dict([['a', num(1)]])]))).toBeUndefined();
    expect(tableFor(seq('list', [dict([['a', num(1)]]), dict([['a', num(1)]])]))).toBeUndefined();
    expect(tableFor(dict([['a', num(1)], ['b', num(2)], ['c', num(3)]]))).toBeUndefined();
  });
});

describe('tableFor: tuples of scalars', () => {
  it('uses the positions as columns and refuses ragged or long tuples', () => {
    const model = tableFor(seq('list', [seq('tuple', [num(1), str('a')]), seq('tuple', [num(2), str('b')]), seq('tuple', [num(3), str('c')])]))!;
    expect(model.columns.map((c) => [c.label, c.kind])).toEqual([['[0]', 'number'], ['[1]', 'string']]);
    expect(tableFor(seq('list', [seq('tuple', [num(1), str('a')]), seq('tuple', [num(2)]), seq('tuple', [num(3), str('c')])]))).toBeUndefined();
    const long = Array.from({ length: 3 }, () => seq('tuple', Array.from({ length: 9 }, (_, k) => num(k))));
    expect(tableFor(seq('list', long))).toBeUndefined();
  });
});

describe('footer and loading', () => {
  it('reports rows not loaded and keeps the load action', () => {
    const root = seq('list', [dict([['a', num(1)]]), dict([['a', num(2)]]), dict([['a', num(3)]])], { length: 100, cappedElements: true });
    const model = tableFor(root)!;
    expect(footerText(model)).toBe('100 rows (3 loaded) · 97 more not loaded');
    expect(model.footer.loadNode?.loadActionNode).toBe(true);
    expect(model.footer.moreAvailable).toBe(true);
  });
  it('uses the host-provided load node when the list already carries one', () => {
    const loadNode: ValueProp = { ...n('list'), name: '…', loadActionNode: true };
    const root = n('list', undefined, { props: [p('0', dict([['a', num(1)]])), p('1', dict([['a', num(2)]])), p('2', dict([['a', num(3)]])), loadNode], length: 10 });
    const model = tableFor(root)!;
    expect(model.rows).toHaveLength(3);
    expect(model.footer.loadNode).toBe(loadNode);
    expect(footerText(model)).toBe('10 rows (3 loaded) · 7 more not loaded');
  });
});

describe('sortRows', () => {
  const model = tableFor(seq('list', [dict([['s', num(0.6)], ['t', str('b')]]), dict([['s', none()], ['t', str('a')]]), dict([['s', num(1)], ['t', str('c')]]), dict([['s', num(0.3)], ['t', none()]])]))!;
  it('sorts numbers numerically with None last, and reverses the values only', () => {
    expect(sortRows(model.rows, 0, 1).map((r) => r.index)).toEqual([3, 0, 2, 1]);
    expect(sortRows(model.rows, 0, -1).map((r) => r.index)).toEqual([2, 0, 3, 1]);
  });
  it('sorts strings by locale with None last and leaves the model untouched', () => {
    expect(sortRows(model.rows, 1, 1).map((r) => r.index)).toEqual([1, 0, 2, 3]);
    expect(model.rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('cellText', () => {
  it('collapses containers, quotes strings, marks capped strings and cuts long text', () => {
    expect(cellText(dict([['a', num(1)], ['b', num(2)]]))).toBe('{2 keys}');
    expect(cellText(dict([]))).toBe('{}');
    expect(cellText(seq('list', []))).toBe('[]');
    expect(cellText(seq('tuple', [num(1), num(2)]))).toBe('(2)');
    expect(cellText(n('list', undefined, { expandable: true, length: 7 }))).toBe('[7]');
    expect(cellText(str('abc', { capped: 'first 3' }))).toBe("'abc'…");
    expect(cellText(none())).toBe('None');
    expect(cellText(str('x'.repeat(200)))).toHaveLength(60);
    expect(cellText(n('Point', undefined, { props: [p('x', num(1)), p('y', num(2))] }))).toBe('Point(x=1, y=2)');
  });
});
