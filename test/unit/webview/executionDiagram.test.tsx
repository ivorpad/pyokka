/** The Execution Diagram: layout of a small graph, the time-layer helpers, and what the rendered view shows. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { DebuggerState, ExecutionGraphPanel, WalkthroughPanel } from '../../../src/shared/webviewProtocol';
import { ROW_H } from '../../../webview/diagram';
import { activePath, BOX_GAP, CLUSTER_GAP, CLUSTER_PAD, DECISION_H, decisionDetail, doneNodes, edgeLabelPoint, execEdgePath, MARGIN, momentNode, nodeAtStep, notYet, rowText, stackFromFrames, STATEMENT_TITLE_H, toDiagram } from '../../../webview/executionDiagram';
import { ExecutionDiagram, type ExecutionDiagramProps } from '../../../webview/components/ExecutionDiagram';

const noop = () => undefined;

type Pt = { x: number; y: number };
type Four = [Pt, Pt, Pt, Pt];
type Six = [Pt, Pt, Pt, Pt, Pt, Pt];

function graph(over: Partial<ExecutionGraphPanel> = {}): ExecutionGraphPanel {
  return {
    runId: 'r1',
    expanded: [],
    phases: [],
    stack: [],
    currentStep: null,
    count: 100,
    nodes: [
      { id: 'n0', kind: 'module', label: '<module>', file: 'main.py', line: 1, fileId: 1, function: '<module>', calls: 1, firstStep: 0, spans: [[0, 99]], rows: [{ kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 54 }] },
      { id: 'n1', kind: 'function', label: 'double', file: 'main.py', line: 10, fileId: 1, function: 'double', calls: 3, firstStep: 5, spans: [[6, 9], [20, 23], [40, 43]], rows: [{ kind: 'in', name: 'x', text: '0', step: 6 }, { kind: 'out', name: 'total', text: '0', step: 9 }] },
      { id: 'n2', kind: 'function', label: 'fail', file: 'main.py', line: 3, fileId: 1, function: 'fail', calls: 2, firstStep: 12, spans: [[13, 17], [50, 54]], rows: [{ kind: 'in', name: 'n', text: '6', step: 13 }, { kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 17 }] },
      { id: 'n3', kind: 'decision', parent: 'n2', label: 'if n > 100', file: 'main.py', line: 5, fileId: 1, text: 'if n > 100 took False', taken: 'False', firstStep: 14, hits: 2, notRun: [7], rows: [{ kind: 'took', name: 'n', text: '6', step: 14 }] },
      { id: 'n4', kind: 'package', label: 'libq', package: 'libq', calls: 1, firstStep: 60, spans: [[61, 70]], rows: [], nested: 4 },
      { id: 'n5', kind: 'function', label: '<lambda>', file: 'main.py', line: 30, fileId: 1, function: '<lambda>', calls: 1, firstStep: 63, spans: [[63, 65]], rows: [{ kind: 'out', name: 'return', text: '7', step: 65 }] },
      { id: 'n6', kind: 'package', label: '2 more functions', file: 'main.py', fileId: 1, calls: 2, firstStep: 80, spans: [], rows: [], more: 2 },
      // statements: two under the module (a pipeline), one under `fail` after its decision
      { id: 'n7', kind: 'statement', parent: 'n0', label: 'total = double(3)', file: 'main.py', line: 20, fileId: 1, text: 'total = double(3)', targets: ['total'], reads: ['double'], firstStep: 4, hits: 1, rows: [{ kind: 'out', name: 'total', text: '6', step: 10 }] },
      { id: 'n8', kind: 'statement', parent: 'n0', label: "print('got', total)", file: 'main.py', line: 21, fileId: 1, text: "print('got', total)", targets: [], reads: ['print', 'total'], firstStep: 11, hits: 2, rows: [{ kind: 'print', name: 'stdout', text: 'got 6', step: 11 }] },
      { id: 'n9', kind: 'statement', parent: 'n2', label: 'raise ValueError(f"too small: {n}")', file: 'main.py', line: 6, fileId: 1, text: 'raise ValueError(f"too small: {n}")', targets: [], reads: ['n'], firstStep: 16, hits: 1, rows: [{ kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 17 }] },
    ],
    edges: [
      { id: 'e0', from: 'n0', to: 'n1', kind: 'call', count: 3, firstStep: 5, steps: [5, 19, 39], momentIds: ['m1', 'm3', 'm5'] },
      { id: 'e1', from: 'n0', to: 'n2', kind: 'call', count: 2, firstStep: 12, steps: [12, 49], momentIds: ['m2', 'm9'] },
      { id: 'e2', from: 'n1', to: 'n2', kind: 'data', label: 'n', firstStep: 13 },
      { id: 'e3', from: 'n0', to: 'n4', kind: 'call', count: 1, firstStep: 60, steps: [60], momentIds: ['m7'] },
      { id: 'e4', from: 'n4', to: 'n5', kind: 'tool', count: 1, firstStep: 63, steps: [63], momentIds: ['m8'] },
      { id: 'e5', from: 'n7', to: 'n1', kind: 'call', count: 1, firstStep: 4, steps: [4], momentIds: ['m11'] },
      { id: 'e6', from: 'n7', to: 'n8', kind: 'data', label: 'total', firstStep: 11 },
    ],
    moments: [
      { id: 'm0', kind: 'start', step: 0, nodeId: 'n0' },
      { id: 'm1', kind: 'call', step: 5, nodeId: 'n1', edgeId: 'e0' },
      { id: 'm2', kind: 'call', step: 12, nodeId: 'n2', edgeId: 'e1' },
      { id: 'm4', kind: 'decision', step: 14, nodeId: 'n3' },
      { id: 'm6', kind: 'error', step: 17, nodeId: 'n2' },
      { id: 'm7', kind: 'call', step: 60, nodeId: 'n4', edgeId: 'e3' },
      { id: 'm8', kind: 'tool', step: 63, nodeId: 'n5', edgeId: 'e4' },
      { id: 'm10', kind: 'print', step: 11, nodeId: 'n8' },
    ],
    scopes: { '0': 'n0', '1': 'n1', '2': 'n2', '3': 'n4', '4': 'n5' },
    capped: true,
    truncated: false,
    ...over,
  };
}

const debug = (over: Partial<DebuggerState> = {}): DebuggerState => ({ active: true, autoPlaying: false, currentStep: 45, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: false, echo: false, watches: [], ...over });

const walkthrough = (): WalkthroughPanel => ({
  runId: 'r1',
  count: 100,
  total: 2,
  shown: 2,
  truncated: false,
  narrating: false,
  canNarrate: false,
  moments: [
    { id: 'm0', kind: 'start', step: 0, fileId: 1, file: 'main.py', line: 1, function: '<module>', text: 'module main.py starts', values: [], gloss: null },
    { id: 'm2', kind: 'call', step: 12, fileId: 1, file: 'main.py', line: 20, function: '<module>', text: 'call to fail from <module>', values: [{ role: 'in', name: 'n', text: '6' }], gloss: 'calls fail with six' },
  ],
});

describe('toDiagram', () => {
  const d = toDiagram(graph());
  const node = (id: string) => d.nodes.find((n) => n.id === id)!;
  const edge = (id: string) => d.edges.find((e) => e.id === id)!;
  const cluster = (id: string) => d.clusters.find((c) => c.id === id)!;
  const right = (id: string) => node(id).x + node(id).width;
  const midY = (id: string) => node(id).y + node(id).height / 2;
  /** self loops and data arcs inside a cluster have four points; calls, tools and data edges between clusters six (a lead, a cubic, a lead) */
  const pts = (id: string, n: 4 | 6): Pt[] => {
    expect(edge(id).points, `edge ${id} has ${n} points`).toHaveLength(n);
    return edge(id).points;
  };
  const expectPoint = (actual: Pt, expected: Pt, what: string) => {
    expect(actual.x, `${what}.x`).toBeCloseTo(expected.x, 5);
    expect(actual.y, `${what}.y`).toBeCloseTo(expected.y, 5);
  };

  it('puts the module in column 0, its callees in column 1 beside their call sites, and the tool callee in column 2', () => {
    expect(cluster('n0').column).toBe(0);
    expect(cluster('n0').x).toBe(MARGIN);
    expect(cluster('n0').y).toBe(MARGIN);
    for (const id of ['n1', 'n2', 'n4', 'n6']) expect(cluster(id).column, `${id} in column 1`).toBe(1);
    expect(cluster('n5').column, '<lambda>, tool-called from libq').toBe(2);
    expect(cluster('n2').boxes).toEqual(['n2', 'n3', 'n9']);
    // double is first called from the statement n7 (#4, before the module's own call at #5): it sits beside n7
    expect(cluster('n1').y).toBe(node('n7').y);
    // the lambda sits beside the libq header that tool-calls it
    expect(cluster('n5').y).toBe(node('n4').y);
    // column 1 in header firstStep order, each cluster CLUSTER_GAP under the previous when its call site is higher up
    expect(d.clusters.filter((c) => c.column === 1).map((c) => c.id)).toEqual(['n1', 'n2', 'n4', 'n6']);
    expect(cluster('n2').y).toBe(cluster('n1').y + cluster('n1').height + CLUSTER_GAP);
    expect(d.clusters.map((c) => c.id)).toEqual(['n0', 'n1', 'n2', 'n4', 'n6', 'n5']);
    expect(d.width).toBeGreaterThan(0);
    // the call edge: a lead from the module header to the edge of column 0, a cubic to the left middle of double, no second lead
    const [p0, p1, , , p4, p5] = pts('e0', 6) as Six;
    expectPoint(p0, { x: right('n0'), y: midY('n0') }, 'e0 p0 (right middle of the module)');
    expectPoint(p1, { x: cluster('n0').x + cluster('n0').width, y: midY('n0') }, 'e0 p1 (the right edge of column 0)');
    expectPoint(p4, { x: node('n1').x, y: midY('n1') }, 'e0 p4 (left middle of double)');
    expectPoint(p5, p4, 'e0 p5 (a copy of p4)');
    const path = execEdgePath(edge('e0'));
    expect(path, `e0 path: M, one L, one C: ${path}`).toMatch(/^M [^LC]+ L [^LC]+ C [^LC]+$/);
  });
  it('titles boxes with the call count and the location, and formats the rows', () => {
    expect(node('n1').title).toBe('double ×3');
    expect(node('n1').subtitle).toBe('main.py:10');
    expect(node('n1').rows.map((r) => `${r.kind} ${r.text}`)).toEqual(['in x = 0', 'out total = 0']);
    expect(node('n5').rows.map((r) => `${r.kind} ${r.text}`)).toEqual(['out 7']);
    expect(node('n2').rows[1]!.text).toBe('ValueError: too small: 6');
    expect(node('n0').title).toBe('<module>');
    expect(rowText({ kind: 'took', name: 'n', text: '6', step: 1 })).toBe('n = 6');
  });
  it('makes decisions diamonds carrying the arm taken and the not-run marker', () => {
    const dec = node('n3');
    expect(dec.kind).toBe('decision');
    expect(dec.height).toBe(DECISION_H);
    expect(dec.taken).toBe('False');
    expect(dec.notRun).toEqual([7]);
    expect(dec.cluster).toBe('n2');
    expect(decisionDetail({ taken: 'False', hits: 2, notRun: [7] })).toBe('took False ×2 · not run: 7');
    expect(decisionDetail({ hits: 3, notRun: [] })).toBe('×3');
    expect(decisionDetail({ taken: 'True', hits: 1, notRun: [] })).toBe('took True');
  });
  it('maps the edge kinds, labels and widths; no chain or decision edges', () => {
    expect(d.edges).toHaveLength(7);
    expect(d.edges.map((e) => e.id).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    expect(new Set(d.edges.map((e) => e.kind))).toEqual(new Set(['call', 'tool', 'data']));
    expect(edge('e0').kind).toBe('call');
    expect(edge('e0').label).toBe('×3');
    expect(edge('e0').width).toBe(2.5);
    expect(edge('e0').title).toBe('call ×3: #5, #19, #39');
    expect(edge('e3').label).toBe('');
    expect(edge('e2').kind).toBe('data');
    expect(edge('e2').label).toBe('n');
    expect(edge('e4').kind).toBe('tool');
    expect(toDiagram(graph({ edges: [{ id: 'e9', from: 'n0', to: 'n1', kind: 'call', count: 40, firstStep: 1, steps: [1], momentIds: [] }] })).edges[0]!.width).toBe(6);
  });
  it('marks package nodes with their nested count and placeholders as such', () => {
    expect(node('n4').nested).toBe(4);
    expect(node('n4').subtitle).toBe('libq');
    expect(node('n6').placeholder).toBe(true);
    expect(node('n6').title).toBe('2 more functions');
    expect(cluster('n6').kind).toBe('package');
    expect(cluster('n6').boxes).toEqual(['n6']);
  });
  it('stacks the statements and decisions under their header, BOX_GAP apart, inside the cluster padding', () => {
    expect(cluster('n0').boxes).toEqual(['n0', 'n7', 'n8']);
    expect(cluster('n2').boxes).toEqual(['n2', 'n3', 'n9']);
    for (const c of d.clusters) {
      let y = c.y + CLUSTER_PAD;
      for (const id of c.boxes) {
        expect(node(id).x, `${id} x in cluster ${c.id}`).toBeCloseTo(c.x + CLUSTER_PAD, 5);
        expect(node(id).y, `${id} y in cluster ${c.id}`).toBeCloseTo(y, 5);
        y += node(id).height + BOX_GAP;
      }
      expect(c.height, `${c.id} height`).toBeCloseTo(y - BOX_GAP + CLUSTER_PAD - c.y, 5);
      expect(c.width, `${c.id} width`).toBeCloseTo(Math.max(...c.boxes.map((id) => node(id).width)) + 2 * CLUSTER_PAD, 5);
    }
    // the callee sits beside the statement that called it, not under it
    expect(node('n1').y).toBeGreaterThanOrEqual(node('n7').y);
    expect(node('n1').x).toBeGreaterThan(right('n7'));
  });
  it('draws a statement as a box with its source, ×hits and rows', () => {
    expect(node('n7').kind).toBe('statement');
    expect(node('n7').title).toBe('total = double(3)');
    expect(node('n7').subtitle).toBe('main.py:20');
    expect(node('n7').rows.map((r) => `${r.kind} ${r.text}`)).toEqual(['out total = 6']);
    expect(node('n7').height).toBe(STATEMENT_TITLE_H + ROW_H + 4);
    expect(node('n8').title).toBe("print('got', total) ×2");
    expect(node('n8').hits).toBe(2);
    expect(node('n8').rows.map((r) => `${r.kind} ${r.text}`)).toEqual(['print ↳ got 6']);
    expect(rowText({ kind: 'print', name: 'stderr', text: 'oops', step: 1 })).toBe('↳ stderr: oops');
    expect(node('n9').rows.map((r) => `${r.kind} ${r.text}`)).toEqual(['raised ValueError: too small: 6']);
    expect(edge('e5').kind).toBe('call');
    expect(edge('e5').from).toBe('n7');
    expect(edge('e6')).toMatchObject({ kind: 'data', label: 'total', from: 'n7', to: 'n8' });
    // the data edge between two consecutive steps of the pipeline arcs on the left of the boxes with four points, DATA_ARC + 6 out for one hop
    const [a0, a1, a2, a3] = pts('e6', 4) as Four;
    expectPoint(a0, { x: node('n7').x, y: midY('n7') }, 'e6 p0 (left middle of n7)');
    expectPoint(a3, { x: node('n8').x, y: midY('n8') }, 'e6 p3 (left middle of n8)');
    expect(a1.x, 'e6 c1.x').toBeCloseTo(node('n7').x - 24, 5);
    expect(a2.x, 'e6 c2.x').toBeCloseTo(node('n8').x - 24, 5);
    // the data edge between two clusters of one column: leads out to the column's right edge, a cubic 48 px outside it, a lead back in
    const colRight = Math.max(...d.clusters.filter((c) => c.column === 1).map((c) => c.x + c.width));
    const [b0, b1, b2, b3, b4, b5] = pts('e2', 6) as Six;
    expectPoint(b0, { x: right('n1'), y: midY('n1') }, 'e2 p0 (right middle of double)');
    expectPoint(b1, { x: colRight, y: midY('n1') }, 'e2 p1 (the right edge of column 1)');
    expectPoint(b2, { x: colRight + 48, y: midY('n1') }, 'e2 c1');
    expectPoint(b3, { x: colRight + 48, y: midY('n2') }, 'e2 c2');
    expectPoint(b4, { x: colRight, y: midY('n2') }, 'e2 p4 (back at the column edge)');
    expectPoint(b5, { x: right('n2'), y: midY('n2') }, 'e2 p5 (right middle of fail)');
    const path = execEdgePath(edge('e2'));
    expect(path, `e2 path: M, L, C, L: ${path}`).toMatch(/^M [^LC]+ L [^LC]+ C [^LC]+ L [^LC]+$/);
  });
  it('puts the edge label near the arrowhead, not at the midpoint', () => {
    const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
    for (const id of ['e6', 'e0', 'e5']) {
      const p = edge(id).points;
      const head = p[p.length - 1]!;
      const at = edgeLabelPoint(edge(id))!;
      expect(dist(at, head), `${id}: label within 40 px of the arrowhead`).toBeLessThan(40);
      expect(dist(at, head), `${id}: label closer to the arrowhead than to the tail`).toBeLessThan(dist(at, p[0]!));
    }
    // a call into the next column: on its cubic past the midpoint, before the callee
    const [, p1, , , p4] = pts('e0', 6) as Six;
    const at = edgeLabelPoint(edge('e0'))!;
    expect(at.x).toBeGreaterThan((p1.x + p4.x) / 2);
    expect(at.x).toBeLessThan(p4.x);
    // the same-column edge e2 ends with a lead back in from the column edge to fail's right side, longer than 18 px: the label sits on that lead 18 px before the arrowhead, 3 px up
    const [, , , , r4, r5] = pts('e2', 6) as Six;
    expect(dist(r4, r5), 'e2 final lead is long enough to carry the label').toBeGreaterThanOrEqual(18);
    const atr = edgeLabelPoint(edge('e2'))!;
    expectPoint(atr, { x: r5.x + 18, y: r5.y - 3 }, 'e2 label (18 px before the arrowhead on the horizontal lead)');
    // a data arc down the pipeline: past the midpoint, above the target
    const [q0, , , q3] = pts('e6', 4) as Four;
    const atq = edgeLabelPoint(edge('e6'))!;
    expect(atq.y).toBeGreaterThan((q0.y + q3.y) / 2);
    expect(atq.y).toBeLessThan(q3.y);
    expect(edgeLabelPoint({ from: 'x', to: 'y', points: [] })).toBeNull();
  });
});

describe('time layer', () => {
  const g = graph();
  it('activePath: the stack nodes and the call edges between consecutive frames', () => {
    const p = activePath(g, ['n2', 'n0']);
    expect([...p.nodes]).toEqual(['n2', 'n0']);
    expect([...p.edges]).toEqual(['e1']);
    expect([...activePath(g, ['n5', 'n4', 'n0']).edges]).toEqual(['e4', 'e3']);
    expect(activePath(g, []).edges.size).toBe(0);
  });
  it('activePath: a running statement first on the stack adds no edge; a call from a statement of the caller counts', () => {
    const p = activePath(g, ['n8', 'n0']);
    expect([...p.nodes]).toEqual(['n8', 'n0']);
    expect([...p.edges]).toEqual([]);
    expect([...activePath(g, ['n9', 'n2', 'n0']).edges]).toEqual(['e1']);
    expect([...activePath(g, ['n1', 'n7', 'n0']).edges]).toEqual(['e5']);
    // no direct edge from the caller: the edge from one of its statements
    const g2 = graph({ edges: g.edges.filter((e) => e.id !== 'e0') });
    expect([...activePath(g2, ['n1', 'n0']).edges]).toEqual(['e5']);
  });
  it('doneNodes: every span ended before the step; a placeholder never is', () => {
    expect([...doneNodes(g, 45)].sort()).toEqual(['n1', 'n3', 'n7', 'n8']);
    expect([...doneNodes(g, 100)].sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n7', 'n8', 'n9']);
    expect(doneNodes(g, 0).size).toBe(0);
  });
  it('doneNodes: a module statement once its first hit is past; a function statement once its parent is', () => {
    expect(doneNodes(g, 5).has('n7')).toBe(true);
    expect(doneNodes(g, 4).has('n7')).toBe(false);
    expect(doneNodes(g, 12).has('n8')).toBe(true);
    // fail runs again at #50: its raise is not done at #45 though its first hit was #16
    expect(doneNodes(g, 45).has('n9')).toBe(false);
    expect(doneNodes(g, 55).has('n9')).toBe(true);
    expect(notYet(g, 3).has('n7')).toBe(true);
  });
  it('notYet: first step after the step', () => {
    expect([...notYet(g, 45)].sort()).toEqual(['n4', 'n5', 'n6']);
    expect(notYet(g, 99).size).toBe(0);
  });
  it('nodeAtStep: the innermost span, or the top of the stack when given', () => {
    expect(nodeAtStep(g, 15)).toBe('n2');
    expect(nodeAtStep(g, 2)).toBe('n0');
    expect(nodeAtStep(g, 15, ['n1', 'n0'])).toBe('n1');
    expect(nodeAtStep(g, 15, [])).toBe('n2');
    expect(nodeAtStep({ nodes: [] }, 1)).toBeNull();
  });
  it('momentNode: by id, else by kind and step', () => {
    expect(momentNode(g, { id: 'm2', kind: 'call', step: 12 })).toBe('n2');
    expect(momentNode(g, { id: 'zz', kind: 'decision', step: 14 })).toBe('n3');
    expect(momentNode(g, { id: 'zz', kind: 'value', step: 14 })).toBeNull();
  });
  it('stackFromFrames: scope ids through graph.scopes, folding consecutive frames of one node', () => {
    expect(stackFromFrames(g, [{ scopeId: 4 }, { scopeId: 3 }, { scopeId: 3 }, { scopeId: 0 }])).toEqual(['n5', 'n4', 'n0']);
    expect(stackFromFrames(g, [{ scopeId: 9 }])).toEqual([]);
  });
});

describe('ExecutionDiagram', () => {
  const view = (over: Partial<ExecutionDiagramProps> = {}) =>
    render(
      <ExecutionDiagram
        graph={graph()}
        graphStack={{ runId: 'r1', step: 45, stack: ['n2', 'n0'] }}
        debug={debug()}
        walkthrough={walkthrough()}
        selected="n1"
        running={false}
        settings={{ diagramDetail: 'statements', diagramDataEdges: true }}
        view={{ runId: 'r1', base: null, toggled: [], dataEdges: null, left: 'walkthrough' }}
        hits={null}
        onSelect={noop}
        onGoto={noop}
        onAction={noop}
        onExpand={noop}
        onNarrate={noop}
        onOpen={noop}
        onClose={noop}
        onView={noop}
        onToggleScope={noop}
        onHits={noop}
        onRequest={noop}
        {...over}
      />,
    );

  it('draws every node with its title and rows', () => {
    const html = view();
    expect(html).toContain('EXECUTION DIAGRAM');
    expect(html).toMatch(/pk-count">10 nodes \(capped\)</);
    expect(html).toContain('pk-ex-title">double ×3<');
    expect(html).toContain('pk-ex-sub">main.py:10<');
    expect(html).toContain('pk-ex-title">&lt;module><');
    expect(html).toMatch(/pk-ex-row-kind">in<.*?tk-name">x<.*?tk-num">0</);
    expect(html).toMatch(/pk-ex-row kind-raised.*?pk-ex-row-kind">raised<.*?ValueError<.*?>too<.*?>small<.*?tk-num">6</);
    expect(html).toContain('pk-ex-decision-label">if n > 100<');
    expect(html).toContain('pk-ex-diamond');
    expect(html).toContain('has-not-run">took False ×2 · not run: 7<');
    expect(html).toContain('4 nested');
    expect(html).toContain('pk-ex-tab');
    expect(html).toMatch(/pk-ex-node kind-package dim placeholder" data-node="n6"/);
    expect(html).toMatch(/pk-ex-edge kind-data dim" data-edge="e2".*?pk-ex-edge-label" text-anchor="middle">n</);
    expect(html).toMatch(/kind-tool.*?data-edge="e4"/);
  });
  it('lights the active path, ticks the done nodes and fades the rest', () => {
    const html = view();
    expect(html).toMatch(/pk-ex-node kind-function active" data-node="n2"/);
    expect(html).toMatch(/pk-ex-node kind-module active" data-node="n0"/);
    expect(html).toMatch(/pk-ex-node kind-function dim done selected" data-node="n1"/);
    expect(html).toMatch(/pk-ex-node kind-package dim" data-node="n4"/);
    expect(html).toMatch(/pk-ex-edge kind-call active" data-edge="e1"/);
    expect(html).toMatch(/pk-ex-edge kind-call dim" data-edge="e0"/);
    expect(html).toMatch(/data-edge="e1"><title>call ×2: #12, #49<\/title>/);
    expect(html).toContain('pk-ex-tick');
  });
  it('prefers the Time Machine call stack over the stack message when the call stack is shown', () => {
    const html = view({ debug: debug({ showCallStack: true, callStack: { frames: [{ fileId: 1, line: 1, col: 0, function: 'double', step: 21, scopeId: 1 }, { fileId: 1, line: 1, col: 0, function: '<module>', step: 20, scopeId: 0 }], selected: 0 } }) });
    expect(html).toMatch(/pk-ex-node kind-function active done selected" data-node="n1"/);
    expect(html).toMatch(/pk-ex-edge kind-call active" data-edge="e0"/);
  });
  it('binds the scrubber to the current step over the run', () => {
    const html = view();
    expect(html).toMatch(/<input type="range" class="pk-exec-range" min="0" max="99" value="45"/);
    expect(html).toContain('pk-exec-step">#45 of 100<');
    expect(html).toContain('codicon-play');
    expect(view({ debug: debug({ autoPlaying: true }) })).toContain('codicon-debug-pause');
    const off = view({ debug: null, graphStack: null });
    expect(off).toMatch(/value="0"/);
    expect(off).toContain('Time Machine off');
    expect(off).toMatch(/pk-ex-node kind-module" data-node="n0"/);
    expect(off).toMatch(/pk-ex-node kind-function selected" data-node="n1"/);
    expect(off).not.toContain('pk-ex-node kind-function active');
    expect(off).not.toContain(' dim');
    expect(off).toContain('TIME MACHINE OFF');
  });
  it('inspects the selected node: rows, calls one per line, the moment gloss, and now', () => {
    const html = view();
    expect(html).toMatch(/SELECTED<\/div>.*?pk-exec-card-title">double ×3 <span class="pk-exec-kind">function</);
    expect(html).toContain('3 calls');
    expect(html).toMatch(/pk-exec-call" title="Time Machine to #6">#6 → #9<.*?#20 → #23<.*?#40 → #43</);
    expect(html).toMatch(/pk-exec-row kind-out.*?tk-name">total</);
    expect(html).toContain('pk-exec-gloss">calls fail with six<');
    expect(html).toMatch(/NOW #45<\/div>.*?pk-exec-card-title">fail ×2<.*?pk-exec-row kind-in/);
    const pkg = view({ selected: 'n4' });
    expect(pkg).toContain('Unroll libq');
    expect(pkg).toContain('1 call · 4 nested');
    const dec = view({ selected: 'n3' });
    expect(dec).toContain('2 hits');
    expect(dec).toContain('not run: line 7');
    const folded = view({ graph: graph({ expanded: ['libq'], nodes: [{ id: 'n0', kind: 'function', label: 'libq.run', file: 'libq/x.py', line: 2, fileId: 9, function: 'run', package: 'libq', calls: 1, firstStep: 0, spans: [[1, 2]], rows: [] }], edges: [], moments: [], scopes: {} }), selected: 'n0' });
    expect(folded).toContain('Fold libq');
    expect(view({ selected: null })).toContain('CLICK A NODE');
  });
  it('draws statement boxes as steps of a pipeline and inspects one: text, chips, hits, rows', () => {
    const html = view({ selected: 'n7' });
    expect(html).toMatch(/pk-ex-node kind-statement dim done selected" data-node="n7".*?pk-ex-step-bar.*?pk-ex-stmt-label">total = double\(3\)</);
    expect(html).toMatch(/pk-ex-node kind-statement dim done" data-node="n8".*?pk-ex-stmt-label">print\('got', total\) ×2<.*?pk-ex-row kind-print.*?pk-ex-row-kind">print<.*?tk-plain">↳ <.*?>got<.*?tk-num">6</);
    expect(html).toMatch(/pk-ex-node kind-statement dim" data-node="n9"/);
    expect(html).toMatch(/pk-ex-edge kind-call dim" data-edge="e5"/);
    expect(html).toMatch(/pk-ex-edge kind-data dim" data-edge="e6".*?pk-ex-edge-label" text-anchor="middle">total</);
    expect(html).toMatch(/SELECTED<\/div>.*?pk-exec-card-title">total = double\(3\) <span class="pk-exec-kind">statement<.*?pk-link[^>]*>main.py:20<.*?pk-exec-stmt-text.*?tk-name">total<.*?pk-exec-chip kind-assigns">assigns total<.*?pk-exec-chip kind-reads">reads double<.*?title="Time Machine to #4">1 hit · first at #4<.*?pk-exec-row kind-out/);
    const printed = view({ selected: 'n8' });
    expect(printed).toMatch(/pk-exec-chip kind-reads">reads print, total<.*?2 hits · first at #11<.*?pk-exec-row kind-print"><span class="pk-exec-row-kind">print<.*?tk-plain">↳ <.*?>got<.*?pk-exec-row-step">#11</);
    expect(printed).not.toContain('pk-exec-chip kind-assigns');
  });
  it('lights the running statement and its cluster, and shows its card under NOW', () => {
    const html = view({ graphStack: { runId: 'r1', step: 45, stack: ['n8', 'n0'] } });
    expect(html).toMatch(/pk-ex-node kind-statement active done" data-node="n8"/);
    expect(html).toMatch(/pk-ex-node kind-module active" data-node="n0"/);
    expect(html).toMatch(/pk-ex-cluster kind-module active" data-cluster="n0"/);
    expect(html).toMatch(/pk-ex-cluster kind-function dim" data-cluster="n2"/);
    expect(html).not.toContain('kind-chain');
    expect(html).toMatch(/NOW #45<\/div>.*?pk-exec-card-title">print\('got', total\) ×2<.*?pk-exec-stmt-text.*?reads print, total<.*?pk-exec-row kind-print/);
  });
  it('draws a cluster behind each scope and selects it with its boxes', () => {
    const html = view();
    const first = html.indexOf('class="pk-ex-cluster ');
    expect(first, 'a cluster group is rendered').toBeGreaterThan(-1);
    expect(first, 'clusters come before the edges').toBeLessThan(html.indexOf('class="pk-ex-edge '));
    expect(first, 'clusters come before the nodes').toBeLessThan(html.indexOf('class="pk-ex-node '));
    expect(html.match(/class="pk-ex-cluster /g), 'one group per module / function / package').toHaveLength(6);
    const m = /<g class="pk-ex-cluster kind-module[^"]*" data-cluster="n0"><rect ([^>]*?)\/?>/.exec(html);
    expect(m, 'the module cluster group wraps a rect').not.toBeNull();
    for (const attr of ['x=', 'y=', 'width=', 'height=', 'rx="6"', 'class="pk-ex-cluster-box"']) expect(m![1], `cluster rect has ${attr}`).toContain(attr);
    expect(html).toMatch(/pk-ex-cluster kind-module active" data-cluster="n0"/);
    expect(html).toMatch(/pk-ex-cluster kind-function dim done selected" data-cluster="n1"/);
    expect(html).toMatch(/pk-ex-cluster kind-package dim" data-cluster="n4"/);
    // a selected statement selects its scope's cluster
    expect(view({ selected: 'n7' })).toMatch(/pk-ex-cluster kind-module active selected" data-cluster="n0"/);
    expect(view({ selected: 'n3' })).toMatch(/pk-ex-cluster kind-function active selected" data-cluster="n2"/);
  });
  it('fades clusters off the stack and ticks done ones', () => {
    const html = view();
    expect(html).toMatch(/pk-ex-cluster kind-function active" data-cluster="n2"/);
    expect(html).toMatch(/pk-ex-cluster kind-module active" data-cluster="n0"/);
    // double's last call ended at #43: done at #45
    expect(html).toMatch(/pk-ex-cluster kind-function dim done selected" data-cluster="n1"/);
    expect(html).toMatch(/pk-ex-cluster kind-function dim" data-cluster="n5"/);
    // at #30 double's third call (#40 → #43) is still ahead: not done
    const earlier = view({ debug: debug({ currentStep: 30 }), graphStack: { runId: 'r1', step: 30, stack: ['n0'] } });
    expect(earlier).toMatch(/pk-ex-cluster kind-function dim selected" data-cluster="n1"/);
    expect(earlier).toMatch(/pk-ex-cluster kind-function dim" data-cluster="n2"/);
    expect(earlier).toMatch(/pk-ex-cluster kind-module active" data-cluster="n0"/);
    // Time Machine off: nothing active, dim or done
    const off = view({ debug: null, graphStack: null });
    expect(off).toMatch(/pk-ex-cluster kind-module" data-cluster="n0"/);
    expect(off).toMatch(/pk-ex-cluster kind-function selected" data-cluster="n1"/);
  });
  it('ends every edge with the arrow marker; the chain links and their marker are gone', () => {
    const html = view();
    const groups = html.split('<g class="pk-ex-edge ').slice(1);
    expect(groups, 'one group per edge').toHaveLength(7);
    for (const g of groups) {
      const id = /data-edge="([^"]*)"/.exec(g)?.[1];
      expect(g.slice(0, g.indexOf('</g>')), `edge ${id} ends with the arrow marker`).toContain('marker-end="url(#pk-exec-arrow)"');
    }
    expect(html).not.toContain('pk-exec-arrow-chain');
    expect(html).not.toContain('pk-ex-edge kind-chain');
    expect(html).not.toContain('pk-ex-edge kind-decision');
    expect(html).not.toContain('data-edge="c:');
    expect(html).not.toContain('data-edge="d:');
  });
  it('offers a fit that aligns the top of the diagram to the viewport', () => {
    expect(view()).toContain('Fit width (top aligned)');
  });
  it('lists the walkthrough on the left', () => {
    const html = view();
    expect(html).toMatch(/pk-exec-left.*?WALKTHROUGH.*?data-step="12"[^>]*class="pk-moment kind-call active"/);
  });
  it('says NO RUN YET without a graph and RUNNING… while a run is in flight', () => {
    expect(view({ graph: null })).toContain('NO RUN YET');
    expect(view({ graph: null })).not.toContain('pk-exec-range');
    expect(view({ graph: null, running: true })).toContain('RUNNING…');
    expect(view({ running: true })).toContain('pk-exec-running">RUNNING…<');
  });
});
