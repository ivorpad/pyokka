/**
 * The column layout of the Execution Diagram (`webview/execLayout.ts`, exercised through
 * `toDiagram`): one cluster per scope with its statements stacked under the header, clusters in
 * columns by call depth beside their call site, edges as leads and a cubic between boxes, and the
 * diagram's size. A small literal graph pins every rule; the two real fixtures pin the invariants
 * over whole programs.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DecisionNode, ExecutionGraph, StatementNode } from '../../../src/session/executionGraphTypes';
import type { ExecutionGraphPanel } from '../../../src/shared/webviewProtocol';
import { BOX_GAP, CLUSTER_GAP, CLUSTER_PAD, COLUMN_GAP, DATA_ARC, DATA_ARC_MAX_HOPS, layoutColumns, MARGIN, routeEdges } from '../../../webview/execLayout';
import { edgeLabelPoint, execEdgePath, toDiagram, type ExecCluster, type ExecDiagram, type ExecEdge, type ExecNode } from '../../../webview/executionDiagram';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

type Pt = { x: number; y: number };
type Four = [Pt, Pt, Pt, Pt];
type Six = [Pt, Pt, Pt, Pt, Pt, Pt];

/**
 * A module with three statements and a decision (declared before the statements: `boxes` has to sort it by
 * firstStep), `f` called twice from the second statement, `g` called from `f`'s last statement and recursing,
 * a package `p` called from the third statement that tool-calls `f` (so `p` and `f` share column 1), and data
 * edges within the module (3 hops), from `f` to its first statement (1 hop) and across clusters `f → g`.
 */
function graph(over: Partial<ExecutionGraphPanel> = {}): ExecutionGraphPanel {
  return {
    runId: 'r',
    expanded: [],
    phases: [],
    stack: [],
    currentStep: null,
    count: 100,
    nodes: [
      { id: 'm', kind: 'module', label: '<module>', file: 'demo.py', line: 1, fileId: 1, function: '<module>', calls: 1, firstStep: 0, spans: [[0, 99]], rows: [] },
      { id: 'd', kind: 'decision', parent: 'm', label: 'if total > 1', file: 'demo.py', line: 12, fileId: 1, text: 'if total > 1 took True', taken: 'True', firstStep: 30, hits: 1, notRun: [14], rows: [{ kind: 'took', name: 'total', text: '2', step: 30 }] },
      { id: 's1', kind: 'statement', parent: 'm', label: 'total = 1', file: 'demo.py', line: 10, fileId: 1, text: 'total = 1', targets: ['total'], reads: [], firstStep: 5, hits: 1, rows: [{ kind: 'out', name: 'total', text: '1', step: 5 }] },
      { id: 's2', kind: 'statement', parent: 'm', label: 'x = f(total)', file: 'demo.py', line: 11, fileId: 1, text: 'x = f(total)', targets: ['x'], reads: ['f', 'total'], firstStep: 20, hits: 2, rows: [{ kind: 'out', name: 'x', text: '2', step: 29 }] },
      { id: 's3', kind: 'statement', parent: 'm', label: 'p.run(total)', file: 'demo.py', line: 13, fileId: 1, text: 'p.run(total)', targets: [], reads: ['p', 'total'], firstStep: 40, hits: 1, rows: [] },
      { id: 'f', kind: 'function', label: 'f', file: 'demo.py', line: 20, fileId: 1, function: 'f', calls: 2, firstStep: 21, spans: [[21, 28], [31, 38]], rows: [{ kind: 'in', name: 'n', text: '1', step: 21 }] },
      { id: 'f1', kind: 'statement', parent: 'f', label: 'y = n * 2', file: 'demo.py', line: 21, fileId: 1, text: 'y = n * 2', targets: ['y'], reads: ['n'], firstStep: 22, hits: 2, rows: [] },
      { id: 'f2', kind: 'statement', parent: 'f', label: 'return g(y)', file: 'demo.py', line: 22, fileId: 1, text: 'return g(y)', targets: [], reads: ['g', 'y'], firstStep: 23, hits: 2, rows: [] },
      { id: 'g', kind: 'function', label: 'g', file: 'demo.py', line: 30, fileId: 1, function: 'g', calls: 5, firstStep: 24, spans: [[24, 27], [25, 26], [34, 37], [35, 36], [36, 36]], rows: [{ kind: 'in', name: 'y', text: '2', step: 24 }, { kind: 'out', name: 'return', text: '4', step: 27 }] },
      { id: 'p', kind: 'package', label: 'libp', package: 'libp', calls: 1, firstStep: 41, spans: [[41, 50]], rows: [], nested: 2 },
    ],
    edges: [
      { id: 'call-f', from: 's2', to: 'f', kind: 'call', count: 2, firstStep: 20, steps: [20, 30], momentIds: [] },
      { id: 'call-g', from: 'f2', to: 'g', kind: 'call', count: 2, firstStep: 23, steps: [23, 33], momentIds: [] },
      { id: 'self-g', from: 'g', to: 'g', kind: 'call', count: 3, firstStep: 25, steps: [25, 35, 36], momentIds: [] },
      { id: 'call-p', from: 's3', to: 'p', kind: 'call', count: 1, firstStep: 40, steps: [40], momentIds: [] },
      { id: 'tool-f', from: 'p', to: 'f', kind: 'tool', count: 1, firstStep: 45, steps: [45], momentIds: [] },
      { id: 'data-s1-s3', from: 's1', to: 's3', kind: 'data', label: 'total', firstStep: 40 },
      { id: 'data-f-f1', from: 'f', to: 'f1', kind: 'data', label: 'n', firstStep: 22 },
      { id: 'data-f-g', from: 'f', to: 'g', kind: 'data', label: 'y', firstStep: 24 },
    ],
    moments: [],
    scopes: { '0': 'm' },
    capped: false,
    truncated: false,
    ...over,
  };
}

function fixture(name: string): ExecutionGraphPanel {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as { default: ExecutionGraph };
  return { ...raw.default, runId: 'r', expanded: [], phases: [], stack: [], currentStep: null };
}

const right = (n: ExecNode): number => n.x + n.width;
const midY = (n: ExecNode): number => n.y + n.height / 2;
const bottom = (c: ExecCluster): number => c.y + c.height;
const clusterRight = (c: ExecCluster): number => c.x + c.width;
const same = (a: Pt, b: Pt): boolean => a.x === b.x && a.y === b.y;
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const tag = (e: ExecEdge): string => `${e.id} (${e.from} → ${e.to})`;

/** self loops and data arcs inside a cluster have four points `[p0, c1, c2, p3]`; calls, tools and data edges between clusters six, `[p0, p1, c1, c2, p4, p5]` (a lead, a cubic, a lead) */
function pts(e: ExecEdge, n: 4): Four;
function pts(e: ExecEdge, n: 6): Six;
function pts(e: ExecEdge, n: 4 | 6): Pt[] {
  expect(e.points, `edge ${tag(e)} has ${n} points`).toHaveLength(n);
  return e.points;
}

/** the cubic of an edge: all of a four-point edge, `p1 c1 c2 p4` of a six-point one */
function cubicOf(e: ExecEdge): Four {
  if (e.points.length === 4) return e.points as Four;
  const [, p1, c1, c2, p4] = pts(e, 6);
  return [p1, c1, c2, p4];
}

function cubicAt([a, b, c, d]: Four, t: number): Pt {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
  return { x: w[0] * a.x + w[1] * b.x + w[2] * c.x + w[3] * d.x, y: w[0] * a.y + w[1] * b.y + w[2] * c.y + w[3] * d.y };
}

/** the points that must lie inside the canvas: the ends and leads, and the cubic's midpoint (control points may poke outside) */
function anchors(e: ExecEdge): Pt[] {
  const p = e.points;
  return [...(p.length === 4 ? [p[0]!, p[3]!] : [p[0]!, p[1]!, p[4]!, p[5]!]), cubicAt(cubicOf(e), 0.5)];
}

function expectPoint(actual: Pt, expected: Pt, what: string): void {
  expect(actual.x, `${what}.x`).toBeCloseTo(expected.x, 5);
  expect(actual.y, `${what}.y`).toBeCloseTo(expected.y, 5);
}

function expectRoute(e: ExecEdge, expected: Pt[]): void {
  const names = expected.length === 4 ? ['p0', 'c1', 'c2', 'p3'] : ['p0', 'p1', 'c1', 'c2', 'p4', 'p5'];
  expect(e.points, `edge ${tag(e)} has ${expected.length} points`).toHaveLength(expected.length);
  e.points.forEach((p, i) => expectPoint(p, expected[i]!, `${tag(e)} ${names[i]}`));
}

/** the points `execEdgePath` writes: `M p0 [L p1] C c1 c2 p4 [L p5]`, a lead of two equal points left out; four points: `M p0 C c1 c2 p3` */
function pathPoints(points: Pt[]): Pt[] {
  if (points.length === 4) return points;
  const [p0, p1, c1, c2, p4, p5] = points as Six;
  return [p0, ...(same(p0, p1) ? [] : [p1]), c1, c2, p4, ...(same(p4, p5) ? [] : [p5])];
}

/** where the label sits: 18 px before the arrowhead on the final lead when that is long enough, else on the cubic that far before its end; 3 px up */
function contractLabelPoint(e: ExecEdge): Pt {
  const cubic = cubicOf(e);
  const lead = e.points.length === 6 ? dist(e.points[4]!, e.points[5]!) : 0;
  if (lead >= 18) {
    const [p4, p5] = [e.points[4]!, e.points[5]!];
    const k = (lead - 18) / lead;
    return { x: p4.x + (p5.x - p4.x) * k, y: p4.y + (p5.y - p4.y) * k - 3 };
  }
  const on = cubicAt(cubic, Math.max(0.5, 1 - (18 - lead) / Math.max(36, dist(cubic[0], cubic[3]))));
  return { x: on.x, y: on.y - 3 };
}

/** rule 5: where an edge's points must be, from the boxes and clusters it joins */
function contractRoute(e: ExecEdge, d: ExecDiagram): Pt[] {
  const s = d.nodes.find((n) => n.id === e.from);
  const t = d.nodes.find((n) => n.id === e.to);
  const cs = d.clusters.find((c) => c.boxes.includes(e.from));
  const ct = d.clusters.find((c) => c.boxes.includes(e.to));
  if (!s || !t || !cs || !ct) throw new Error(`${tag(e)}: both ends must be laid-out nodes inside clusters`);
  const colRight = (col: number) => Math.max(...d.clusters.filter((c) => c.column === col).map(clusterRight));
  const colLeft = (col: number) => Math.min(...d.clusters.filter((c) => c.column === col).map((c) => c.x));
  if (e.from === e.to) {
    const [r, m] = [right(s), midY(s)];
    return [{ x: r, y: m - 10 }, { x: r + 36, y: m - 28 }, { x: r + 36, y: m + 28 }, { x: r, y: m + 10 }];
  }
  if (e.kind === 'data' && cs.id === ct.id) {
    const off = DATA_ARC + 6 * Math.min(Math.abs(ct.boxes.indexOf(e.to) - cs.boxes.indexOf(e.from)), DATA_ARC_MAX_HOPS);
    return [{ x: s.x, y: midY(s) }, { x: s.x - off, y: midY(s) }, { x: t.x - off, y: midY(t) }, { x: t.x, y: midY(t) }];
  }
  if (ct.column > cs.column) {
    const p1 = { x: colRight(cs.column), y: midY(s) };
    const p4 = { x: t.x, y: midY(t) };
    const dx = Math.max(24, Math.abs(p4.x - p1.x) / 2);
    return [{ x: right(s), y: p1.y }, p1, { x: p1.x + dx, y: p1.y }, { x: p4.x - dx, y: p4.y }, p4, { ...p4 }];
  }
  if (ct.column === cs.column) {
    const cr = colRight(cs.column);
    return [{ x: right(s), y: midY(s) }, { x: cr, y: midY(s) }, { x: cr + 48, y: midY(s) }, { x: cr + 48, y: midY(t) }, { x: cr, y: midY(t) }, { x: right(t), y: midY(t) }];
  }
  const p1 = { x: colLeft(cs.column), y: midY(s) };
  const p4 = { x: colRight(ct.column), y: midY(t) };
  const dx = Math.max(24, Math.abs(p4.x - p1.x) / 2);
  return [{ x: s.x, y: p1.y }, p1, { x: p1.x - dx, y: p1.y }, { x: p4.x + dx, y: p4.y }, p4, { x: right(t), y: p4.y }];
}

/** What holds for any graph: rules 1 to 7 of the layout contract, checked over every cluster and edge. */
function checkInvariants(d: ExecDiagram, name: string): void {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  expect(d.clusters.length, `${name}: has clusters`).toBeGreaterThan(0);

  // rule 1: one cluster per scope node, the header first, the id and kind of that node
  const owners = new Map<string, string[]>();
  for (const c of d.clusters) {
    expect(byId.get(c.id)?.kind, `${name}: cluster ${c.id} is a laid-out node of its kind`).toBe(c.kind);
    expect(['module', 'function', 'package'], `${name}: cluster ${c.id} is a scope`).toContain(c.kind);
    expect(c.boxes[0], `${name}: cluster ${c.id} starts with its header`).toBe(c.id);
    for (const id of c.boxes) owners.set(id, [...(owners.get(id) ?? []), c.id]);
    for (const id of c.boxes.slice(1)) {
      expect(byId.get(id)?.cluster, `${name}: box ${id} of cluster ${c.id} is a laid-out node naming its cluster`).toBe(c.id);
      expect(['statement', 'decision'], `${name}: box ${id} of cluster ${c.id} is a statement or decision`).toContain(byId.get(id)!.kind);
    }
  }
  for (const n of d.nodes) expect(owners.get(n.id) ?? [], `${name}: node ${n.id} is in exactly one cluster's boxes`).toHaveLength(1);
  expect([...owners.keys()].sort(), `${name}: every box is a node`).toEqual(d.nodes.map((n) => n.id).sort());

  // rule 2: boxes stacked BOX_GAP apart inside CLUSTER_PAD; the cluster wraps them
  for (const c of d.clusters) {
    const boxes = c.boxes.map((id) => byId.get(id)!);
    let y = c.y + CLUSTER_PAD;
    for (const b of boxes) {
      expect(b.x, `${name}: box ${b.id} x in cluster ${c.id}`).toBeCloseTo(c.x + CLUSTER_PAD, 5);
      expect(b.y, `${name}: box ${b.id} y in cluster ${c.id}`).toBeCloseTo(y, 5);
      y += b.height + BOX_GAP;
    }
    expect(c.width, `${name}: cluster ${c.id} width`).toBeCloseTo(Math.max(...boxes.map((b) => b.width)) + 2 * CLUSTER_PAD, 5);
    expect(c.height, `${name}: cluster ${c.id} height`).toBeCloseTo(boxes.reduce((s, b) => s + b.height, 0) + (boxes.length - 1) * BOX_GAP + 2 * CLUSTER_PAD, 5);
  }

  // rule 3: modules in column 0; column x from the widest cluster of the previous column
  const columns = new Map<number, ExecCluster[]>();
  for (const c of d.clusters) {
    if (c.kind === 'module') expect(c.column, `${name}: module ${c.id} in column 0`).toBe(0);
    columns.set(c.column, [...(columns.get(c.column) ?? []), c]);
  }
  let x = MARGIN;
  for (let col = 0; col <= Math.max(...columns.keys()); col++) {
    const cs = columns.get(col) ?? [];
    expect(cs.length, `${name}: column ${col} is not empty`).toBeGreaterThan(0);
    for (const c of cs) expect(c.x, `${name}: cluster ${c.id} at column ${col}'s x`).toBeCloseTo(x, 5);
    x += Math.max(...cs.map((c) => c.width)) + COLUMN_GAP;
  }

  // rule 4: within a column, ascending header firstStep, CLUSTER_GAP apart, from MARGIN down
  for (const [col, cs] of columns) {
    let prevBottom = MARGIN - CLUSTER_GAP;
    let prevStep = -Infinity;
    for (const c of [...cs].sort((a, b) => a.y - b.y)) {
      const step = byId.get(c.id)!.node.firstStep;
      expect(step, `${name}: column ${col}: cluster ${c.id} comes after earlier scopes`).toBeGreaterThanOrEqual(prevStep);
      expect(c.y, `${name}: column ${col}: cluster ${c.id} at least CLUSTER_GAP under the previous cluster`).toBeGreaterThanOrEqual(prevBottom + CLUSTER_GAP - 1e-6);
      [prevBottom, prevStep] = [bottom(c), step];
    }
  }

  // rule 7: clusters ordered by column, then y; and no two overlap
  d.clusters.forEach((a, i) => {
    const p = d.clusters[i - 1];
    if (p) expect(p.column < a.column || (p.column === a.column && p.y <= a.y), `${name}: clusters ${p.id} then ${a.id} ordered by column then y`).toBe(true);
    for (const b of d.clusters.slice(i + 1)) {
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart, `${name}: clusters ${a.id} [${a.x},${a.y} ${a.width}×${a.height}] and ${b.id} [${b.x},${b.y} ${b.width}×${b.height}] overlap`).toBe(true);
    }
  });

  // rule 5: every edge routed per its kind and the columns of its ends; no chain or decision edges
  for (const e of d.edges) {
    expect(['call', 'tool', 'data'], `${name}: edge ${e.id} kind`).toContain(e.kind);
    expectRoute(e, contractRoute(e, d));
  }

  // rule 6: the size wraps the clusters and every edge's ends, leads and cubic midpoint
  expect(d.width, `${name}: width covers the clusters`).toBeGreaterThanOrEqual(Math.max(...d.clusters.map(clusterRight)) + MARGIN - 1e-6);
  expect(d.height, `${name}: height covers the clusters`).toBeGreaterThanOrEqual(Math.max(...d.clusters.map(bottom)) + MARGIN - 1e-6);
  for (const e of d.edges) {
    anchors(e).forEach((p, i) => {
      const what = `${name}: ${e.id} anchor ${i} (${p.x}, ${p.y}) inside ${d.width}×${d.height}`;
      expect(p.x >= -1e-6 && p.x <= d.width + 1e-6 && p.y >= -1e-6 && p.y <= d.height + 1e-6, what).toBe(true);
    });
  }
}

describe('toDiagram: the column layout of a small program', () => {
  const g = graph();
  const d = toDiagram(g);
  const node = (id: string): ExecNode => {
    const n = d.nodes.find((x) => x.id === id);
    expect(n, `node ${id} is laid out`).toBeDefined();
    return n!;
  };
  const cluster = (id: string): ExecCluster => {
    const c = d.clusters.find((x) => x.id === id);
    expect(c, `cluster ${id} exists`).toBeDefined();
    return c!;
  };
  const edge = (id: string): ExecEdge => {
    const e = d.edges.find((x) => x.id === id);
    expect(e, `edge ${id} exists`).toBeDefined();
    return e!;
  };
  const colRight = (col: number) => Math.max(...d.clusters.filter((c) => c.column === col).map(clusterRight));

  it('exports the layout constants of the contract', () => {
    expect([CLUSTER_PAD, CLUSTER_GAP, COLUMN_GAP, BOX_GAP, DATA_ARC, MARGIN, DATA_ARC_MAX_HOPS]).toEqual([12, 24, 96, 10, 18, 20, 4]);
  });

  it('makes one cluster per scope: the header first, then its statements and decisions by firstStep', () => {
    expect(d.clusters.map((c) => c.id)).toEqual(['m', 'f', 'p', 'g']);
    expect(d.clusters.map((c) => c.kind)).toEqual(['module', 'function', 'package', 'function']);
    expect(cluster('m').boxes).toEqual(['m', 's1', 's2', 'd', 's3']);
    expect(cluster('f').boxes).toEqual(['f', 'f1', 'f2']);
    expect(cluster('g').boxes).toEqual(['g']);
    expect(cluster('p').boxes).toEqual(['p']);
    for (const n of d.nodes) expect(n.cluster, `${n.id}.cluster`).toBe(d.clusters.find((c) => c.boxes.includes(n.id))!.id);
  });

  it('columns: the module in 0, a callee one right of its first caller, recursion ignored', () => {
    expect(cluster('m').column, 'm').toBe(0);
    expect(cluster('f').column, 'f (called from s2, a module statement)').toBe(1);
    expect(cluster('p').column, 'p (called from s3, a module statement)').toBe(1);
    expect(cluster('g').column, 'g (called from f2, a statement of f; its self edge does not count)').toBe(2);
  });

  it('stacks the boxes of a cluster BOX_GAP apart, CLUSTER_PAD inside the cluster', () => {
    const m = cluster('m');
    const boxes = m.boxes.map(node);
    for (const b of boxes) expect(b.x, `${b.id}.x`).toBeCloseTo(m.x + CLUSTER_PAD, 5);
    expect(node('m').y, 'header y').toBeCloseTo(m.y + CLUSTER_PAD, 5);
    boxes.slice(1).forEach((b, i) => expect(b.y, `${b.id} is BOX_GAP under ${boxes[i]!.id}`).toBeCloseTo(boxes[i]!.y + boxes[i]!.height + BOX_GAP, 5));
    expect(m.width).toBeCloseTo(Math.max(...boxes.map((b) => b.width)) + 2 * CLUSTER_PAD, 5);
    expect(m.height).toBeCloseTo(boxes.reduce((s, b) => s + b.height, 0) + (boxes.length - 1) * BOX_GAP + 2 * CLUSTER_PAD, 5);
    // the lone header of g wraps just itself
    expect([cluster('g').width, cluster('g').height]).toEqual([node('g').width + 2 * CLUSTER_PAD, node('g').height + 2 * CLUSTER_PAD]);
  });

  it('puts each column COLUMN_GAP right of the widest cluster of the previous one', () => {
    const [m, f, p] = [cluster('m'), cluster('f'), cluster('p')];
    expect(m.x, 'column 0 at MARGIN').toBe(MARGIN);
    expect(f.x, 'column 1 x').toBeCloseTo(m.x + m.width + COLUMN_GAP, 5);
    expect(p.x, 'p shares column 1 with f').toBeCloseTo(f.x, 5);
    expect(cluster('g').x, 'column 2 x').toBeCloseTo(f.x + Math.max(f.width, p.width) + COLUMN_GAP, 5);
  });

  it('sits a callee beside its call site, and clusters of a column CLUSTER_GAP apart in firstStep order', () => {
    const [m, f, p] = [cluster('m'), cluster('f'), cluster('p')];
    expect(m.y, 'the module starts at MARGIN').toBe(MARGIN);
    // s2 is the third box of the module, well under MARGIN: f's top is exactly its call site's top
    expect(node('s2').y).toBeGreaterThan(MARGIN);
    expect(f.y, 'f.y is the y of its call site s2').toBe(node('s2').y);
    // f before p in column 1 (firstStep 21 < 41); p cannot overlap f even though s3 calls it higher up
    expect(d.clusters.filter((c) => c.column === 1).map((c) => c.id)).toEqual(['f', 'p']);
    expect(p.y, 'p under f').toBeGreaterThanOrEqual(bottom(f) + CLUSTER_GAP);
    expect(p.y, 'p.y = max(its call site s3, f bottom + CLUSTER_GAP)').toBe(Math.max(node('s3').y, bottom(f) + CLUSTER_GAP));
    // g is the only cluster of column 2: exactly beside f2
    expect(cluster('g').y).toBeGreaterThanOrEqual(node('f2').y);
    expect(cluster('g').y, 'g.y is the y of its call site f2').toBe(node('f2').y);
  });

  it('routes a call into the next column: a lead to the edge of its column, then a horizontal S to the left of the callee', () => {
    const [p0, p1, c1, c2, p4, p5] = pts(edge('call-f'), 6);
    expectPoint(p0, { x: right(node('s2')), y: midY(node('s2')) }, 'call-f p0 (right middle of s2)');
    expectPoint(p1, { x: colRight(0), y: p0.y }, 'call-f p1 (the right edge of column 0)');
    expect(p1.x, 'column 0 ends at the module cluster').toBeCloseTo(clusterRight(cluster('m')), 5);
    expectPoint(p4, { x: node('f').x, y: midY(node('f')) }, 'call-f p4 (left middle of f)');
    expectPoint(p5, p4, 'call-f p5 (a copy of p4)');
    expect(c1.y, 'call-f c1.y').toBeCloseTo(p1.y, 5);
    expect(c2.y, 'call-f c2.y').toBeCloseTo(p4.y, 5);
    expect(c1.x, 'call-f c1 right of p1').toBeGreaterThan(p1.x);
    expect(c2.x, 'call-f c2 left of p4').toBeLessThan(p4.x);
    const dx = Math.max(24, Math.abs(p4.x - p1.x) / 2);
    expect(c1.x, 'call-f c1.x = p1.x + dx').toBeCloseTo(p1.x + dx, 5);
    expect(c2.x, 'call-f c2.x = p4.x - dx').toBeCloseTo(p4.x - dx, 5);
    // call-g (f2 → g, column 1 → 2) and call-p (s3 → p, column 0 → 1) take the same shape
    const [g0, g1, , , g4] = pts(edge('call-g'), 6);
    expectPoint(g0, { x: right(node('f2')), y: midY(node('f2')) }, 'call-g p0 (right middle of f2)');
    expectPoint(g1, { x: colRight(1), y: midY(node('f2')) }, 'call-g p1 (the right edge of column 1)');
    expectPoint(g4, { x: node('g').x, y: midY(node('g')) }, 'call-g p4 (left middle of g)');
    const [q0, , , , q4] = pts(edge('call-p'), 6);
    expectPoint(q0, { x: right(node('s3')), y: midY(node('s3')) }, 'call-p p0 (right middle of s3)');
    expectPoint(q4, { x: node('p').x, y: midY(node('p')) }, 'call-p p4 (left middle of p)');
  });

  it('loops a recursive call on the right of the header, with four points', () => {
    const [r, m] = [right(node('g')), midY(node('g'))];
    expectRoute(edge('self-g'), [{ x: r, y: m - 10 }, { x: r + 36, y: m - 28 }, { x: r + 36, y: m + 28 }, { x: r, y: m + 10 }]);
  });

  it('arcs a data edge between two boxes of one cluster on their left with four points, 6 px wider per hop', () => {
    const [s1, s3, f, f1] = [node('s1'), node('s3'), node('f'), node('f1')];
    // s1 → s3 skips s2 and the decision: 3 hops
    expect(cluster('m').boxes.indexOf('s3') - cluster('m').boxes.indexOf('s1')).toBe(3);
    expectRoute(edge('data-s1-s3'), [{ x: s1.x, y: midY(s1) }, { x: s1.x - 36, y: midY(s1) }, { x: s3.x - 36, y: midY(s3) }, { x: s3.x, y: midY(s3) }]);
    expect(pts(edge('data-s1-s3'), 4)[1].x, 'data-s1-s3 c1.x = s1.x - (DATA_ARC + 6 * 3)').toBeCloseTo(s1.x - (DATA_ARC + 6 * 3), 5);
    // the parameter edge from f's header to its first statement: 1 hop
    expectRoute(edge('data-f-f1'), [{ x: f.x, y: midY(f) }, { x: f.x - 24, y: midY(f) }, { x: f1.x - 24, y: midY(f1) }, { x: f1.x, y: midY(f1) }]);
    expect(pts(edge('data-f-f1'), 4)[1].x, 'data-f-f1 c1.x = f.x - (DATA_ARC + 6)').toBeCloseTo(f.x - (DATA_ARC + 6), 5);
  });

  it('arcs an edge between two clusters of one column outside the column: leads to its right edge, a cubic 48 px out', () => {
    expect(cluster('p').column).toBe(cluster('f').column);
    const cr = colRight(1);
    expect(cr, 'column 1 ends at the wider of the f and p clusters').toBeCloseTo(Math.max(clusterRight(cluster('f')), clusterRight(cluster('p'))), 5);
    const [p, f] = [node('p'), node('f')];
    expect(edge('tool-f').kind).toBe('tool');
    expectRoute(edge('tool-f'), [{ x: right(p), y: midY(p) }, { x: cr, y: midY(p) }, { x: cr + 48, y: midY(p) }, { x: cr + 48, y: midY(f) }, { x: cr, y: midY(f) }, { x: right(f), y: midY(f) }]);
  });

  it('routes a data edge between clusters like a call', () => {
    const [f, g] = [node('f'), node('g')];
    const p1 = { x: colRight(1), y: midY(f) };
    const p4 = { x: g.x, y: midY(g) };
    const dx = Math.max(24, Math.abs(p4.x - p1.x) / 2);
    expectRoute(edge('data-f-g'), [{ x: right(f), y: midY(f) }, p1, { x: p1.x + dx, y: p1.y }, { x: p4.x - dx, y: p4.y }, p4, { ...p4 }]);
  });

  it('maps the kinds, labels, widths and titles: ×count on calls, the parameter name on data edges', () => {
    expect(d.edges).toHaveLength(g.edges.length);
    expect(new Set(d.edges.map((e) => e.kind))).toEqual(new Set(['call', 'tool', 'data']));
    expect(edge('call-f')).toMatchObject({ kind: 'call', label: '×2', width: 2, title: 'call ×2: #20, #30' });
    expect(edge('self-g')).toMatchObject({ kind: 'call', label: '×3', width: 2.5 });
    expect(edge('call-p')).toMatchObject({ kind: 'call', label: '', width: 1.5 });
    expect(edge('tool-f')).toMatchObject({ kind: 'tool', label: '', width: 1.5 });
    expect(edge('data-s1-s3')).toMatchObject({ kind: 'data', label: 'total', width: 1.2, title: 'data: total (from #40)' });
    expect(edge('data-f-f1')).toMatchObject({ kind: 'data', label: 'n', width: 1.2 });
    expect(edge('data-f-g')).toMatchObject({ kind: 'data', label: 'y', width: 1.2 });
  });

  it('execEdgePath: M, an L per non-empty lead, one C; the numbers are the points in order', () => {
    const leads: Record<string, number> = { 'call-f': 1, 'tool-f': 2, 'data-f-g': 1, 'self-g': 0, 'data-s1-s3': 0 };
    for (const [id, want] of Object.entries(leads)) {
      const path = execEdgePath(edge(id));
      const points = pathPoints(edge(id).points);
      expect(points.length - 4, `${id}: ${want} non-empty lead(s) in its points`).toBe(want);
      expect(path.startsWith('M'), `${id}: path starts with M: ${path}`).toBe(true);
      expect(path.split('C').length - 1, `${id}: one C: ${path}`).toBe(1);
      expect(path.split('L').length - 1, `${id}: ${want} L: ${path}`).toBe(want);
      const nums = (path.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g) ?? []).map(Number);
      expect(nums, `${id}: ${points.length * 2} numbers: ${path}`).toHaveLength(points.length * 2);
      points.forEach((p, i) => expectPoint({ x: nums[2 * i]!, y: nums[2 * i + 1]! }, p, `${id}: path point ${i}`));
    }
  });

  it('edgeLabelPoint: near the arrowhead (on the final lead, else on the cubic), 3 px up; beside the loop of a self edge', () => {
    for (const id of ['call-f', 'tool-f', 'data-f-g', 'data-f-f1', 'data-s1-s3']) {
      const e = edge(id);
      const at = edgeLabelPoint(e);
      expect(at, `${id} has a label point`).not.toBeNull();
      expect(dist(at!, e.points[e.points.length - 1]!), `${id}: label within 40 px of the arrowhead`).toBeLessThan(40);
      expectPoint(at!, contractLabelPoint(e), `${id} label`);
    }
    // the call into the next column: past the middle of its cubic, before the callee
    const [, p1, , , p4] = pts(edge('call-f'), 6);
    const at = edgeLabelPoint(edge('call-f'))!;
    expect(at.x, 'call-f label past the midpoint of the cubic').toBeGreaterThan((p1.x + p4.x) / 2);
    expect(at.x, 'call-f label before the target').toBeLessThan(p4.x);
    expect(edgeLabelPoint(edge('self-g'))?.x, 'self-g label right of the header').toBeGreaterThan(right(node('g')));
    expect(edgeLabelPoint({ from: 'x', to: 'y', points: [] })).toBeNull();
  });

  it('sizes the diagram around the clusters and every edge, keeps the clusters apart, and boxes every node once', () => {
    checkInvariants(d, 'literal');
    expect(d.width).toBeGreaterThanOrEqual(clusterRight(cluster('g')) + MARGIN);
    expect(d.height).toBeGreaterThanOrEqual(bottom(cluster('p')) + MARGIN);
  });

  it('layoutColumns and routeEdges are the two halves of toDiagram', () => {
    const nodes = d.nodes.map((n) => ({ ...n, x: 0, y: 0 }));
    const laid = layoutColumns(nodes, g);
    expect(laid.clusters).toEqual(d.clusters);
    expect(nodes.map((n) => [n.id, n.x, n.y])).toEqual(d.nodes.map((n) => [n.id, n.x, n.y]));
    expect(laid.width).toBeGreaterThanOrEqual(Math.max(...laid.clusters.map(clusterRight)) + MARGIN);
    expect(laid.height).toBeGreaterThanOrEqual(Math.max(...laid.clusters.map(bottom)) + MARGIN);
    const routed = routeEdges(d.edges.map((e) => ({ ...e, points: [] })), nodes, laid.clusters);
    expect(routed.map((e) => [e.id, e.points])).toEqual(d.edges.map((e) => [e.id, e.points]));
  });

  it('drops a statement or decision whose parent is not in the graph', () => {
    const lost: StatementNode = { id: 'stray', kind: 'statement', parent: 'nope', label: 'lost = 1', file: 'demo.py', line: 99, fileId: 1, text: 'lost = 1', targets: ['lost'], reads: [], firstStep: 7, hits: 1, rows: [] };
    const lostD: DecisionNode = { id: 'strayd', kind: 'decision', parent: 'nope', label: 'if lost', file: 'demo.py', line: 100, fileId: 1, text: 'if lost took True', taken: 'True', firstStep: 8, hits: 1, notRun: [], rows: [] };
    const stray = toDiagram(graph({ nodes: [...g.nodes, lost, lostD] }));
    expect(stray.nodes.map((n) => n.id)).toEqual(d.nodes.map((n) => n.id));
    expect(stray.clusters.flatMap((c) => c.boxes).filter((id) => id.startsWith('stray'))).toEqual([]);
    checkInvariants(stray, 'stray');
  });
});

describe('toDiagram over the fixtures', () => {
  it('execution-graph-statements.json: the module in column 0, its callees in 1, the constructor they call in 2', () => {
    const d = toDiagram(fixture('execution-graph-statements.json'));
    checkInvariants(d, 'statements');
    const column = (id: string) => d.clusters.find((c) => c.id === id)?.column;
    expect(column('n0'), '<module>').toBe(0);
    expect(column('n2'), 'parse_event').toBe(1);
    expect(column('n16'), 'shout').toBe(1);
    expect(column('n6'), 'Event.__init__').toBe(2);
    expect(d.clusters).toHaveLength(4);
  });

  it('execution-graph.json: both modules in column 0, the lambda one right of libq, the whole no longer a strip', () => {
    const d = toDiagram(fixture('execution-graph.json'));
    checkInvariants(d, 'graph');
    const column = (id: string) => d.clusters.find((c) => c.id === id)?.column;
    expect(column('n0'), '<module>').toBe(0);
    expect(column('n2'), 'helper.py').toBe(0);
    expect(column('n25'), 'libq').toBeDefined();
    expect(column('n27'), '<lambda>').toBe(column('n25')! + 1);
    expect(d.width, `width ${d.width} < 3 × height ${d.height}`).toBeLessThan(d.height * 3);
    // the module → module call (e0, both in column 0) leads out to the column's edge and arcs 48 px outside it
    const [p0, p1, c1] = pts(d.edges.find((e) => e.id === 'e0')!, 6);
    const colRight = Math.max(...d.clusters.filter((c) => c.column === 0).map(clusterRight));
    expect(p0.x, 'e0 starts at the module header').toBeCloseTo(right(d.nodes.find((n) => n.id === 'n0')!), 5);
    expect([p1.x, c1.x], 'e0 p1.x, c1.x').toEqual([colRight, colRight + 48]);
  });
});
