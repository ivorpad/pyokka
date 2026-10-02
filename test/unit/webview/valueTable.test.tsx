/** The table component: a real table, sortable headers, the marked row, bars, None cells, the footer and the view toggle. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { ValueNode, ValueProp } from '../../../src/shared/protocol';
import { tableFor } from '../../../webview/valueTable';
import { ValueTable } from '../../../webview/components/ValueTable';

let id = 0;
const n = (type: string, value?: string, extra: Partial<ValueNode> = {}): ValueNode => ({ id: `v${++id}`, queryPath: [`q${id}`], type, value, ...extra });
const p = (name: string, node: ValueNode): ValueProp => ({ ...node, name });
const dict = (entries: [string, ValueNode][]) => n('dict', undefined, { props: entries.map(([k, v]) => ({ ...p(k, v), keyRepr: `'${k}'` })), length: entries.length });
const list = (items: ValueNode[], extra: Partial<ValueNode> = {}) => n('list', undefined, { props: items.map((v, i) => p(String(i), v)), length: items.length, ...extra });
const noop = () => undefined;

const root = list([
  dict([['path', n('str', 'a.yaml')], ['score', n('number', '1')], ['patron', n('str', 'LIBRE')]]),
  dict([['path', n('str', 'b.yaml')], ['score', n('number', '0.5')], ['patron', n('None')]]),
  dict([['path', n('str', 'c.yaml')], ['score', n('number', '0.25')], ['patron', n('None')]]),
]);
const model = tableFor(root)!;

describe('ValueTable', () => {
  const html = render(<ValueTable model={model} caption="items · list · 3 × dict" markIndex={1} onShowList={noop} onLoadMore={noop} />);
  it('is a real table with column headers and the caption', () => {
    expect(html).toContain('<table class="pk-vtable-grid" aria-label="items · list · 3 × dict">');
    expect(html.match(/<th scope="col"/g)).toHaveLength(4);
    expect(html).toContain('>path<');
    expect(html).toContain('>score<');
    expect(html).toContain('>patron<');
  });
  it('marks the current row with ▶ and aria-current', () => {
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/<tr class="cur" aria-current="true">[\s\S]*?▶ 1</);
  });
  it('draws bars for the numeric column scaled to the unit interval', () => {
    const bars = [...html.matchAll(/pk-vtable-bar" style="width:\s?(\d+)px;?"/g)].map((m) => Number(m[1]));
    expect(bars).toEqual([48, 24, 12]);
  });
  it('styles None as a keyword and quotes strings', () => {
    expect(html.match(/pk-vtable-none">None</g)).toHaveLength(2);
    expect(html).toContain("<span class=\"tk-str\">'LIBRE'</span>");
  });
  it('prints the footer counts and offers the list side of the toggle', () => {
    expect(html).toContain('3 rows · 2 have patron None');
    expect(html).toContain('aria-pressed="true">table<');
    expect(html).toContain('aria-pressed="false">list<');
  });
  it('shows the load action only when the list has more elements', () => {
    expect(html).not.toContain('load more');
    const capped = tableFor(list(root.props!.map((q) => q as ValueNode), { length: 40, cappedElements: true }))!;
    const more = render(<ValueTable model={capped} onLoadMore={noop} />);
    expect(more).toContain('40 rows (3 loaded) · 2 have patron None · 37 more not loaded');
    expect(more).toContain('pk-vtable-load">load more<');
  });
});
