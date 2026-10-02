import { describe, expect, it } from 'vitest';
import type { ValueNode, ValueProp } from '../../../src/shared/protocol';
import { buildGraph, edgePath, fitTransform, layoutGraph } from '../../../webview/diagram';

let id = 0;
const n = (type: string, value?: string, extra: Partial<ValueNode> = {}): ValueNode => ({ id: `v${++id}`, queryPath: [`q${id}`], type, value, ...extra });
const p = (name: string, node: ValueNode): ValueProp => ({ ...node, name, keyRepr: `'${name}'` });
const num = (x: number) => n('number', String(x));

function car(): ValueNode {
  return n('Car', undefined, {
    props: [
      { ...n('str', '1DEMC12A1985'), name: 'vin' },
      { ...n('dict', undefined, { props: [p('name', n('str', 'Marty'))] }), name: 'owner' },
      { ...n('dict', undefined, { props: [p('volume', num(10)), p('spec', n('dict', undefined, { props: [p('make', n('str', 'DeLorean'))] }))] }), name: 'engine' },
      { ...n('dict', '{…}', { expandable: true }), name: 'transmission' },
    ],
  });
}

describe('buildGraph', () => {
  it('auto-expands loaded children one level deep and collapses the rest', () => {
    const g = buildGraph(car(), 'delorean', null);
    expect(g.nodes.map((x) => x.id)).toEqual(['delorean.owner', 'delorean.engine', 'delorean']);
    const root = g.nodes.find((x) => x.id === 'delorean')!;
    expect(root.title).toBe('delorean');
    expect(root.typeName).toBe('Car');
    expect(root.rows.map((r) => r.name)).toEqual(['vin', 'owner', 'engine', 'transmission']);
    expect(root.rows[1]?.childId).toBe('delorean.owner');
    expect(root.rows[3]?.collapsed).toBe(true);
    expect(root.rows[3]?.loadable).toBe(true);
    const engine = g.nodes.find((x) => x.id === 'delorean.engine')!;
    expect(engine.rows[1]?.collapsed).toBe(true);
    expect(engine.rows[1]?.text).toBe('{…}');
    expect(g.edges.map((e) => `${e.from}[${e.fromRow}]->${e.to}`)).toEqual(['delorean[1]->delorean.owner', 'delorean[2]->delorean.engine']);
  });
  it('honours an explicit expansion set', () => {
    const g = buildGraph(car(), 'd', new Set(["d.engine", "d.engine['spec']"]));
    expect(g.nodes.map((x) => x.id).sort()).toEqual(["d", "d.engine", "d.engine['spec']"]);
  });
});

describe('layoutGraph', () => {
  it('places nodes left to right and routes edges from the row to the child title', () => {
    const g = layoutGraph(buildGraph(car(), 'd', null));
    const root = g.nodes.find((x) => x.id === 'd')!;
    const owner = g.nodes.find((x) => x.id === 'd.owner')!;
    expect(root.x).toBeLessThan(owner.x);
    const e = g.edges.find((x) => x.to === 'd.owner')!;
    expect(e.points[0]?.x).toBeCloseTo(root.x + root.width);
    expect(e.points[1]?.x).toBeCloseTo(owner.x);
    expect(edgePath(e)).toMatch(/^M .* C .*/);
    expect(g.width).toBeGreaterThan(0);
    const t = fitTransform(g, 800, 400);
    expect(t.k).toBeGreaterThan(0);
    expect(t.k).toBeLessThanOrEqual(1.5);
  });
});
