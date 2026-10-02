import { describe, expect, it } from 'vitest';
import type { ValueNode, ValueProp } from '../../../src/shared/protocol';
import { flat, formatText, formatValue, pyQuote, spliceNode, valueCategory } from '../../../webview/format';

let id = 0;
const n = (type: string, value?: string, extra: Partial<ValueNode> = {}): ValueNode => ({ id: `v${++id}`, queryPath: [`q${id}`], type, value, ...extra });
const p = (name: string, node: ValueNode, keyRepr?: string): ValueProp => ({ ...node, name, ...(keyRepr ? { keyRepr } : {}) });
const dict = (entries: [string, ValueNode][], extra: Partial<ValueNode> = {}) => n('dict', undefined, { props: entries.map(([k, v]) => p(k, v, `'${k}'`)), length: entries.length, ...extra });
const list = (items: ValueNode[], extra: Partial<ValueNode> = {}) => n('list', undefined, { props: items.map((v, i) => p(String(i), v)), length: items.length, ...extra });
const str = (s: string, extra: Partial<ValueNode> = {}) => n('str', s, extra);
const num = (x: number) => n('number', String(x));

describe('pyQuote', () => {
  it('quotes with single quotes by default and escapes', () => {
    expect(pyQuote('abc')).toBe("'abc'");
    expect(pyQuote("it's")).toBe('"it\'s"');
    expect(pyQuote('a\nb\\c')).toBe("'a\\nb\\\\c'");
  });
  it('keeps values that already are literals', () => {
    expect(pyQuote("'already'")).toBe("'already'");
    expect(pyQuote("b'bytes'")).toBe("b'bytes'");
  });
});

describe('flat', () => {
  it('renders primitives and containers on one line', () => {
    expect(flat(dict([['a', num(1)], ['b', str('x')]]))).toBe("{'a': 1, 'b': 'x'}");
    expect(flat(list([num(1), n('bool', 'True'), n('None')]))).toBe('[1, True, None]');
    expect(flat(n('tuple', undefined, { props: [p('0', num(1))] }))).toBe('(1,)');
    expect(flat(n('set', undefined, { props: [] }))).toBe('set()');
    expect(flat(n('number', undefined, { nan: true }))).toBe('nan');
  });
  it('renders instances as ClassName(a=1, b=2)', () => {
    expect(flat(n('Point', undefined, { props: [p('x', num(1)), p('y', num(2))] }))).toBe('Point(x=1, y=2)');
  });
  it('marks capped containers and unloaded values with an ellipsis', () => {
    expect(flat(list([num(1)], { cappedElements: true }))).toBe('[1, …]');
    expect(flat(n('dict', '{…}', { expandable: true }))).toBe('{…}');
    expect(flat(str('abc', { capped: 'first 3' }))).toBe("'abc'…");
  });
});

describe('formatValue', () => {
  it('keeps short values on one line', () => {
    const lines = formatValue(dict([['a', num(1)]]), { rootName: 'v' });
    expect(lines.map((l) => l.text)).toEqual(["{'a': 1}"]);
    expect(lines[0]?.path).toBe('v');
  });
  it('splits long containers over lines with 4-space indents and trailing commas', () => {
    const long = dict([
      ['rss', num(77955072)],
      ['heapTotal', num(27983872)],
      ['heapUsed', num(21560616)],
      ['external', num(6562737)],
      ['arrayBuffers', num(156494)],
      ['nested', dict([['deep', str('a fairly long string value that pushes the width over the limit')]])],
    ]);
    const text = formatText(long, { width: 60, rootName: 'mem' });
    expect(text.split('\n')[0]).toBe('{');
    expect(text).toContain("    'rss': 77955072,");
    expect(text.trim().endsWith('}')).toBe(true);
    const lines = formatValue(long, { width: 60, rootName: 'mem' });
    const deep = lines.find((l) => l.text.includes("'deep'"));
    expect(deep?.path).toBe("mem['nested']['deep']");
  });
  it('emits a clickable load line for capped containers', () => {
    const capped = list(Array.from({ length: 30 }, (_, i) => num(i)), { cappedElements: true });
    const lines = formatValue(capped, { width: 40 });
    const load = lines.find((l) => l.kind === 'load');
    expect(load?.text.trim()).toBe('…');
    expect(load?.loadNode).toBeDefined();
  });
  it('uses expressionPath and attribute access for instances', () => {
    const inst = n('Car', undefined, { props: [p('owner', dict([['name', str('Marty McFly with a very long name indeed to force wrapping over the width')]]))] });
    const lines = formatValue(inst, { width: 50, rootName: 'car' });
    expect(lines.find((l) => l.text.includes("'name'"))?.path).toBe("car.owner['name']");
  });
});

describe('spliceNode', () => {
  it('replaces the node with the matching queryPath', () => {
    const child = n('dict', '{…}', { expandable: true, queryPath: ['k', '_p_t'] });
    const root = n('Car', undefined, { queryPath: ['k'], props: [p('t', child)] });
    const full = { ...child, value: undefined, expandable: false, props: [p('gears', num(5))] };
    const out = spliceNode(root, full);
    expect(flat(out)).toBe('Car(t={gears: 5})'.replace('gears', "'gears'").replace("{'gears': 5}", "{'gears': 5}"));
    expect(out).not.toBe(root);
  });
});

describe('valueCategory', () => {
  it('classifies values for compare', () => {
    expect(valueCategory(dict([]))).toBe('object');
    expect(valueCategory(n('Point', undefined, { props: [] }))).toBe('object');
    expect(valueCategory(list([]))).toBe('list');
    expect(valueCategory(str('x'))).toBe('string');
    expect(valueCategory(num(1))).toBe('other');
  });
});
