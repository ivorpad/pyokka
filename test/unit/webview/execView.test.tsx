/**
 * Semantic zoom on the Execution Diagram: `toDiagram` under an `ExecView` (closed scopes draw their
 * card alone, their members' calls leave the card and merge, data edges follow the toggle), the
 * helpers behind it, and what the rendered view shows: the chevrons, the toolbar toggles, the story
 * tab, the inspector's card for a node the canvas does not draw, and the hit list.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { DebuggerState } from '../../../src/shared/webviewProtocol';
import { execNodeOf, FULL_VIEW, scopeOf, toDiagram } from '../../../webview/executionDiagram';
import { ExecutionDiagram, openScopes, type ExecutionDiagramProps } from '../../../webview/components/ExecutionDiagram';
import { hitNeighbours } from '../../../webview/components/ExecInspector';
import { zoomGraph } from './zoomFixture';

const noop = () => undefined;
const graph = zoomGraph();

describe('toDiagram under a view', () => {
  it('draws everything by default, each edge standing for itself', () => {
    const d = toDiagram(graph);
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
    expect(d.edges.map((e) => e.id).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
    for (const e of d.edges) expect(e.ids).toEqual([e.id]);
    expect(d.nodes.find((n) => n.id === 'n0')!.children).toBe(3);
    expect(d.nodes.find((n) => n.id === 'n0')!.open).toBe(true);
    expect(toDiagram(graph, FULL_VIEW).nodes).toHaveLength(10);
  });
  it('draws the cards alone when every scope is closed, re-homes their members’ calls and merges them, and drops data edges', () => {
    const d = toDiagram(graph, { open: new Set(), dataEdges: false });
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1', 'n2', 'n4', 'n5']);
    const module = d.nodes.find((n) => n.id === 'n0')!;
    expect(module.children).toBe(3);
    expect(module.open).toBe(false);
    expect(d.nodes.find((n) => n.id === 'n2')!.children).toBe(2);
    expect(d.nodes.find((n) => n.id === 'n1')!.children).toBe(0);
    expect(d.edges.map((e) => e.id).sort()).toEqual(['e0', 'e2', 'e6', 'e7']);
    const merged = d.edges.find((e) => e.id === 'e0')!;
    expect(merged.from).toBe('n0');
    expect(merged.to).toBe('n1');
    expect(merged.ids).toEqual(['e0', 'e1']);
    expect(merged.label).toBe('×2');
    expect(merged.title).toBe('call ×2: #4, #19');
    // the callee sits beside the card that now calls it
    const c1 = d.clusters.find((c) => c.id === 'n1')!;
    expect(c1.column).toBe(1);
    expect(c1.y).toBe(module.y);
    expect(d.clusters.find((c) => c.id === 'n5')!.column).toBe(2);
  });
  it('opens one scope at a time: its members draw with their own edges, the other scopes keep their cards', () => {
    const d = toDiagram(graph, { open: new Set(['n0']), dataEdges: true });
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1', 'n2', 'n4', 'n5', 'n6', 'n7', 'n8']);
    expect(d.edges.map((e) => e.id).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
    expect(d.edges.find((e) => e.id === 'e0')!.from).toBe('n6');
    expect(d.edges.find((e) => e.id === 'e1')!.ids).toEqual(['e1']);
    const other = toDiagram(graph, { open: new Set(['n2']), dataEdges: true });
    expect(other.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n9']);
    // the module's chain is folded: its data edges have no boxes; the cross-cluster one between two cards stays
    expect(other.edges.map((e) => e.id).sort()).toEqual(['e0', 'e2', 'e5', 'e6', 'e7']);
    expect(other.edges.find((e) => e.id === 'e0')!.ids).toEqual(['e0', 'e1']);
  });
  it('names the scope of a node and boxes a hidden node for the inspector', () => {
    expect(scopeOf(graph, 'n9')).toBe('n2');
    expect(scopeOf(graph, 'n3')).toBe('n2');
    expect(scopeOf(graph, 'n1')).toBe('n1');
    expect(scopeOf(graph, 'nope')).toBeUndefined();
    const box = execNodeOf(graph.nodes.find((n) => n.id === 'n9')!);
    expect(box.kind).toBe('statement');
    expect(box.title).toBe('raise ValueError(f"too small: {n}")');
    expect(box.children).toBe(0);
    expect(box.open).toBe(true);
    expect(box.x).toBe(0);
  });
  it('turns the base and the toggles into the open set', () => {
    expect([...openScopes(graph, 'closed', [])]).toEqual([]);
    expect([...openScopes(graph, 'closed', ['n2', 'n9'])]).toEqual(['n2']);
    expect([...openScopes(graph, 'open', [])].sort()).toEqual(['n0', 'n1', 'n2', 'n4', 'n5']);
    expect([...openScopes(graph, 'open', ['n2'])].sort()).toEqual(['n0', 'n1', 'n4', 'n5']);
  });
  it('finds the hit before and after a step', () => {
    expect(hitNeighbours([4, 19, 30], 19)).toEqual({ prev: 4, next: 30 });
    expect(hitNeighbours([4, 19, 30], 20)).toEqual({ prev: 19, next: 30 });
    expect(hitNeighbours([4, 19, 30], null)).toEqual({ prev: undefined, next: 4 });
    expect(hitNeighbours([4, 19, 30], 40)).toEqual({ prev: 30, next: undefined });
    expect(hitNeighbours([], 5)).toEqual({ prev: undefined, next: undefined });
  });
});

describe('ExecutionDiagram at the scopes level', () => {
  const debug = (over: Partial<DebuggerState> = {}): DebuggerState => ({ active: true, autoPlaying: false, currentStep: 19, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: false, echo: false, watches: [], ...over });
  const view = (over: Partial<ExecutionDiagramProps> = {}) =>
    render(
      <ExecutionDiagram
        graph={graph}
        graphStack={{ runId: 'r1', step: 19, stack: ['n7', 'n0'] }}
        debug={debug()}
        walkthrough={null}
        selected="n9"
        running={false}
        settings={{ diagramDetail: 'scopes', diagramDataEdges: false }}
        view={{ runId: 'r1', base: null, toggled: [], dataEdges: null, left: 'story' }}
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

  it('draws the cards with chevrons and no statements, the toggles off, and the story tab', () => {
    const html = view();
    expect(html).not.toMatch(/kind-statement[^"]*" data-node=/);
    expect(html).not.toContain('pk-ex-diamond');
    expect(html).toMatch(/data-chevron="n0"[^>]*>.*?pk-ex-chevron-glyph">▸ 3</s);
    expect(html).toMatch(/data-chevron="n2"[^>]*>.*?▸ 2</s);
    expect(html).not.toContain('data-chevron="n1"');
    expect(html).not.toContain('kind-data');
    expect(html).toMatch(/pk-ex-edge kind-call[^"]*" data-edge="e0".*?<title>call ×2: #4, #19</s);
    expect(html).toContain('Statements folded');
    expect(html).toContain('Data edges hidden');
    expect(html).toMatch(/pk-exec-tab-btn active"[^>]*>STORY</);
    expect(html).toMatch(/pk-story-row kind-scope[^"]*" [^>]*data-story="n0"/);
    expect(html).toMatch(/pk-story-row kind-phase[^"]*"[^>]*data-story="n0:p0"/);
    expect(html).toMatch(/pk-story-row kind-statement[^"]*now[^"]*"[^>]*data-story="n7"/);
    // fail and libq start folded: their members are not in the tree
    expect(html).not.toContain('data-story="n9"');
    expect(html).toContain('data-story="n4"');
  });
  it('still shows the selected hidden statement in the inspector, and the running statement under NOW', () => {
    const html = view();
    expect(html).toMatch(/SELECTED<\/div>.*?pk-exec-card-title">raise ValueError/s);
    expect(html).toMatch(/pk-ex-edge kind-call dim" data-edge="e0"/);
    expect(html).toMatch(/NOW #19<\/div>.*?pk-exec-card-title">x = double\(total\)</s);
  });
  it('lights the merged edge when the stack runs through one of the folded calls', () => {
    // inside double, called from the second statement: the merged edge stands for that call too
    const html = view({ graphStack: { runId: 'r1', step: 21, stack: ['n1', 'n7', 'n0'] }, debug: debug({ currentStep: 21 }) });
    expect(html).toMatch(/pk-ex-edge kind-call active" data-edge="e0"/);
    expect(html).toMatch(/pk-ex-node kind-function active[^"]*" data-node="n1"/);
    expect(html).toMatch(/pk-ex-node kind-module active[^"]*" data-node="n0"/);
  });
  it('opens every scope from the toolbar override, or one scope from its toggle, and shows the data edges on demand', () => {
    const all = view({ view: { runId: 'r1', base: 'open', toggled: [], dataEdges: true, left: 'story' } });
    expect(all).toMatch(/kind-statement[^"]*" data-node="n6"/);
    expect(all).toContain('pk-ex-diamond');
    expect(all).toMatch(/data-chevron="n0"[^>]*>.*?▾ 3</s);
    expect(all).toContain('Statements shown');
    expect(all).toContain('Data edges shown');
    expect(all).toContain('kind-data');
    const one = view({ view: { runId: 'r1', base: null, toggled: ['n2'], dataEdges: null, left: 'story' } });
    expect(one).toContain('pk-ex-diamond');
    expect(one).not.toMatch(/kind-statement[^"]*" data-node="n6"/);
    expect(one).toMatch(/kind-statement[^"]*" data-node="n9"/);
    expect(one).toMatch(/data-chevron="n2"[^>]*>.*?▾ 2</s);
  });
  it('lists the hits of the selected node with the current one marked, and the walkthrough tab on request', () => {
    const html = view({ selected: 'n7', hits: { runId: 'r1', nodeId: 'n7', total: 3, steps: [19, 44], values: ['12', null] } });
    expect(html).toMatch(/pk-exec-hits-head"><span>3 hits<\/span>/);
    expect(html).toMatch(/pk-exec-hit current"[^>]*title="Time Machine to #19"/);
    expect(html).toMatch(/pk-exec-hit-step">#44<\/span><span class="pk-dim pk-exec-hit-value">no value logged</);
    expect(html).toContain('… 1 more');
    // the current step is the first hit: nothing earlier, #44 next
    expect(html).toContain('No earlier hit');
    expect(html).toContain('Next hit: #44');
    // hits of another node do not show
    const other = view({ selected: 'n6', hits: { runId: 'r1', nodeId: 'n7', total: 1, steps: [19], values: ['12'] } });
    expect(other).not.toContain('pk-exec-hits-head');
    expect(other).toContain('1 hit · first at #4');
    const walk = view({ view: { runId: 'r1', base: null, toggled: [], dataEdges: null, left: 'walkthrough' } });
    expect(walk).toMatch(/pk-exec-tab-btn active"[^>]*>WALKTHROUGH</);
    expect(walk).toContain('pk-walkthrough');
    expect(walk).not.toContain('pk-story-row');
  });
});
