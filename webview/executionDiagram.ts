/**
 * Execution graph -> boxes, diamonds, clusters and edges for the Execution Diagram canvas (the
 * column layout of `execLayout.ts`), plus the time layer's pure helpers: the active path at a step,
 * done and not-yet nodes, the node a step is in, the node of a walkthrough moment.
 * `docs/PROTOCOL.md`, "Execution graph".
 *
 * Statements and decisions stack under their parent's card (its cluster) in `firstStep` order, so a
 * script reads top-down as a pipeline and a function's body sits under its box; a callee's cluster
 * sits one column right of the statement that first calls it.
 */
import type { CallEdge, CallNode, DataEdge, DecisionNode, GraphEdge, GraphNode, GraphRow, StatementNode } from '../src/session/executionGraphTypes';
import type { ExecutionGraphPanel } from '../src/shared/webviewProtocol';
import { CHAR_W, PAD, ROW_H } from './diagram';
import { layoutColumns, MARGIN, routeEdges } from './execLayout';

export { BOX_GAP, CLUSTER_GAP, CLUSTER_PAD, COLUMN_GAP, DATA_ARC, DATA_ARC_MAX_HOPS, MARGIN } from './execLayout';

export const EXEC_TITLE_H = 34;
export const STATEMENT_TITLE_H = 24;
export const DECISION_H = 48;
export const MAX_EXEC_TEXT = 44;
export const MAX_EDGE_WIDTH = 6;

export interface ExecRow {
  kind: GraphRow['kind'];
  /** `x = 0`, `total = 6` (`out` of `return` is just the text), `ValueError: too small`, `↳ hello` (print) */
  text: string;
  step: number;
}

export interface ExecNode {
  id: string;
  kind: GraphNode['kind'];
  /** the label, with `×calls` when called more than once (statements: `×hits`) */
  title: string;
  /** `file:line`, or the package name on a package node; '' for placeholders */
  subtitle: string;
  rows: ExecRow[];
  /** `N more functions` placeholder under the cap */
  placeholder: boolean;
  /** package nodes: scopes entered inside the spans */
  nested?: number;
  /** decisions: the arm taken by the first hit (absent for loops) */
  taken?: string;
  /** decisions: first line of every arm that never ran */
  notRun: number[];
  /** decisions and statements: hits; others: calls */
  hits: number;
  /** scope cards: statements and decisions under the scope in the full graph; 0 for every other box */
  children: number;
  /** scope cards: those are drawn (`ExecView.open`); true for every other box */
  open: boolean;
  node: GraphNode;
  /** the cluster (scope) this box sits in: its own id for a module / function / package header, the parent's for statements and decisions */
  cluster: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * One scope drawn as a column segment: the header box (the module / function / package card) at the
 * top, its statements and decisions stacked under it in `firstStep` order. Clusters sit in columns
 * by call depth (the modules in column 0, a function one column right of its first caller), so a
 * script reads top-down and its callees sit beside the statements that call them.
 */
export interface ExecCluster {
  /** the scope node's id (also the header box's id) */
  id: string;
  kind: 'module' | 'function' | 'package';
  column: number;
  /** box ids in stacking order, the header first */
  boxes: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** the graph's edge kinds (`call`, `tool`, `data`); the layout adds none of its own */
export type ExecEdgeKind = GraphEdge['kind'];

export interface ExecEdge {
  id: string;
  /** the graph edges this one stands for: several when the calls of hidden statements merged into their card's */
  ids: string[];
  from: string;
  to: string;
  kind: ExecEdgeKind;
  /** `×3` on a call edge, the parameter name on a data edge, '' otherwise */
  label: string;
  /** stroke width: 1.5 plus half a pixel per extra call, capped */
  width: number;
  /** the hover text: `call ×3: #40, #52, #63` */
  title: string;
  points: { x: number; y: number }[];
}

export interface ExecDiagram {
  nodes: ExecNode[];
  edges: ExecEdge[];
  /** one per module / function / package node, drawn behind its boxes */
  clusters: ExecCluster[];
  width: number;
  height: number;
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** `in x = 0`, `out 6`, `raised ValueError: too small: 6`, `took i = 0`, `print ↳ hello` (stderr: `↳ stderr: hello`) */
export function rowText(row: GraphRow): string {
  if (row.kind === 'raised') return row.text ? `${row.name}: ${row.text}` : row.name;
  if (row.kind === 'out' && row.name === 'return') return row.text;
  if (row.kind === 'print') return row.name === 'stderr' ? `↳ stderr: ${row.text}` : `↳ ${row.text}`;
  return `${row.name} = ${row.text}`;
}

export function isDecision(n: GraphNode): n is DecisionNode {
  return n.kind === 'decision';
}

export function isStatement(n: GraphNode): n is StatementNode {
  return n.kind === 'statement';
}

export function isCallNode(n: GraphNode): n is CallNode {
  return n.kind === 'module' || n.kind === 'function' || n.kind === 'package';
}

function edgeTitle(e: GraphEdge): string {
  if (e.kind === 'data') return `data: ${e.label} (from #${e.firstStep})`;
  const steps = e.steps.map((s) => `#${s}`).join(', ');
  return `${e.kind} ×${e.count}: ${steps}${e.steps.length < e.count ? ' …' : ''}`;
}

function edgeLabel(e: GraphEdge): string {
  if (e.kind === 'data') return e.label;
  return e.count > 1 ? `×${e.count}` : '';
}

function execRows(rows: GraphRow[]): ExecRow[] {
  return rows.map((r) => ({ kind: r.kind, text: ellipsize(rowText(r), MAX_EXEC_TEXT), step: r.step }));
}

/** A scope card; `children` (statements and decisions under it) widens the title for the chevron and its count. */
function callNode(n: CallNode, children = 0, open = true): ExecNode {
  const placeholder = n.more !== undefined;
  const title = n.calls > 1 && !placeholder ? `${n.label} ×${n.calls}` : n.label;
  const subtitle = n.kind === 'package' ? (placeholder ? n.file ?? '' : n.package ?? '') : n.file ? `${n.file}:${n.line ?? ''}` : n.package ?? '';
  const rows = execRows(n.rows);
  const longest = Math.max(title.length + 4 + (children > 0 ? 7 : 0), subtitle.length + 2, ...rows.map((r) => r.text.length + 7), n.nested !== undefined ? 14 : 0);
  const extra = n.nested !== undefined ? ROW_H : 0;
  return {
    id: n.id,
    kind: n.kind,
    cluster: n.id,
    title,
    subtitle,
    rows,
    placeholder,
    nested: n.nested,
    notRun: [],
    hits: n.calls,
    children,
    open,
    node: n,
    width: Math.max(140, Math.round(longest * CHAR_W + PAD * 2)),
    height: EXEC_TITLE_H + rows.length * ROW_H + extra + 6,
    x: 0,
    y: 0,
  };
}

function decisionNode(n: DecisionNode): ExecNode {
  const title = ellipsize(n.label, MAX_EXEC_TEXT);
  const detail = decisionDetail(n);
  const longest = Math.max(title.length, detail.length) + 8;
  return {
    id: n.id,
    kind: 'decision',
    cluster: n.parent,
    title,
    subtitle: n.file ? `${n.file}:${n.line}` : '',
    rows: execRows(n.rows),
    placeholder: false,
    taken: n.taken,
    notRun: n.notRun,
    hits: n.hits,
    children: 0,
    open: true,
    node: n,
    width: Math.max(120, Math.round(longest * CHAR_W + PAD)),
    height: DECISION_H,
    x: 0,
    y: 0,
  };
}

/** A statement box: the source as the title (monospace, `×hits` when hit more than once), the rows under it, no subtitle line. */
function statementNode(n: StatementNode): ExecNode {
  const title = n.hits > 1 ? `${n.label} ×${n.hits}` : n.label;
  const rows = execRows(n.rows);
  const longest = Math.max(title.length + 3, ...rows.map((r) => r.text.length + 7));
  return {
    id: n.id,
    kind: 'statement',
    cluster: n.parent,
    title,
    subtitle: n.file ? `${n.file}:${n.line}` : '',
    rows,
    placeholder: false,
    notRun: [],
    hits: n.hits,
    children: 0,
    open: true,
    node: n,
    width: Math.max(120, Math.round(longest * CHAR_W + PAD * 2)),
    height: STATEMENT_TITLE_H + rows.length * ROW_H + (rows.length ? 4 : 0),
    x: 0,
    y: 0,
  };
}

/** the diamond's second line: `took False ×3 · not run: 15` (loops: `×3`) */
export function decisionDetail(n: Pick<DecisionNode, 'taken' | 'hits' | 'notRun'>): string {
  const parts: string[] = [];
  if (n.taken !== undefined) parts.push(`took ${n.taken}`);
  if (n.hits !== 1 || n.taken === undefined) parts.push(`×${n.hits}`);
  const head = parts.join(' ');
  return n.notRun.length ? `${head}${head ? ' · ' : ''}not run: ${n.notRun.join(', ')}` : head;
}

/** What the canvas draws of the graph: the scopes whose statements and decisions are open, and whether data edges show. */
export interface ExecView {
  /** scope node ids drawn with their members; 'all' opens every scope */
  open: ReadonlySet<string> | 'all';
  dataEdges: boolean;
}

/** everything: the shape of `pyokka graph` */
export const FULL_VIEW: ExecView = { open: 'all', dataEdges: true };

/** call-site steps kept on an edge merged from several (the graph's own cap) */
const MERGED_STEPS_MAX = 50;

/** The scope a node sits in: itself for a module, function or package, the parent of a statement or decision. */
export function scopeOf(graph: Pick<ExecutionGraphPanel, 'nodes'>, nodeId: string): string | undefined {
  const n = graph.nodes.find((x) => x.id === nodeId);
  if (!n) return undefined;
  return isDecision(n) || isStatement(n) ? n.parent : n.id;
}

/** A node's box without a position: the inspector's view of a node the canvas does not draw (its scope is closed). */
export function execNodeOf(n: GraphNode): ExecNode {
  return isDecision(n) ? decisionNode(n) : isStatement(n) ? statementNode(n) : callNode(n);
}

interface MergedCall {
  ids: string[];
  from: string;
  to: string;
  kind: 'call' | 'tool';
  count: number;
  firstStep: number;
  steps: number[];
  momentIds: string[];
}

/**
 * Boxes, clusters and edges for the canvas: the modules in column 0, every function one column
 * right of its first caller, the statements and decisions of an open scope stacked under its card
 * (`layoutColumns`), every edge a cubic through four points (`routeEdges`). A statement or
 * decision whose parent is not in the graph is dropped: it has no chain to sit in. A closed scope
 * draws its card alone: a call or tool edge leaving one of its hidden members leaves the card, and
 * edges that then share both ends merge (counts add up, steps join, `ids` keeps the originals);
 * data edges draw only between drawn boxes, and not at all with `dataEdges` off. The size covers
 * the clusters and every edge point (self loops and the arcs on the last column stay inside).
 */
export function toDiagram(graph: ExecutionGraphPanel, view: ExecView = FULL_VIEW): ExecDiagram {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const isOpen = (scopeId: string): boolean => view.open === 'all' || view.open.has(scopeId);
  const childCount = new Map<string, number>();
  for (const n of graph.nodes) if ((isDecision(n) || isStatement(n)) && byId.has(n.parent)) childCount.set(n.parent, (childCount.get(n.parent) ?? 0) + 1);
  const nodes: ExecNode[] = [];
  for (const n of graph.nodes) {
    if (isDecision(n) || isStatement(n)) {
      if (byId.has(n.parent) && isOpen(n.parent)) nodes.push(isDecision(n) ? decisionNode(n) : statementNode(n));
    } else nodes.push(callNode(n, childCount.get(n.id) ?? 0, isOpen(n.id)));
  }
  const kept = new Set(nodes.map((n) => n.id));
  const calls = new Map<string, MergedCall>();
  const data: DataEdge[] = [];
  for (const e of graph.edges) {
    if (e.kind === 'data') {
      if (view.dataEdges && kept.has(e.from) && kept.has(e.to)) data.push(e);
      continue;
    }
    let from = e.from;
    if (!kept.has(from)) {
      const src = byId.get(from);
      if (!src || (!isDecision(src) && !isStatement(src)) || !kept.has(src.parent)) continue;
      from = src.parent;
    }
    if (!kept.has(e.to)) continue;
    const key = `${from} ${e.to} ${e.kind}`;
    const acc = calls.get(key);
    if (acc) {
      acc.ids.push(e.id);
      acc.count += e.count;
      acc.steps = [...acc.steps, ...e.steps].sort((a, b) => a - b).slice(0, MERGED_STEPS_MAX);
      acc.momentIds.push(...e.momentIds);
      acc.firstStep = Math.min(acc.firstStep, e.firstStep);
    } else calls.set(key, { ids: [e.id], from, to: e.to, kind: e.kind, count: e.count, firstStep: e.firstStep, steps: [...e.steps], momentIds: [...e.momentIds] });
  }
  const idsOf = new Map<string, string[]>();
  const layoutEdges: GraphEdge[] = [...calls.values()].map((a): CallEdge => {
    idsOf.set(a.ids[0]!, a.ids);
    return { id: a.ids[0]!, from: a.from, to: a.to, kind: a.kind, count: a.count, firstStep: a.firstStep, steps: a.steps, momentIds: a.momentIds };
  });
  layoutEdges.push(...data);
  layoutEdges.sort((a, b) => a.firstStep - b.firstStep || (a.kind === 'data' ? 1 : 0) - (b.kind === 'data' ? 1 : 0));
  const edges: ExecEdge[] = layoutEdges.map((e) => ({
    id: e.id,
    ids: idsOf.get(e.id) ?? [e.id],
    from: e.from,
    to: e.to,
    kind: e.kind,
    label: edgeLabel(e),
    width: e.kind === 'data' ? 1.2 : Math.min(MAX_EDGE_WIDTH, 1.5 + (e.count - 1) * 0.5),
    title: edgeTitle(e),
    points: [],
  }));
  const laid = layoutColumns(nodes, { nodes: graph.nodes, edges: layoutEdges });
  routeEdges(edges, nodes, laid.clusters);
  let width = laid.width;
  let height = laid.height;
  for (const e of edges) {
    for (const p of e.points) {
      width = Math.max(width, p.x + MARGIN);
      height = Math.max(height, p.y + MARGIN);
    }
  }
  return { nodes, edges, clusters: laid.clusters, width, height };
}

/**
 * SVG path for an edge. Six points (start, lead end, two controls, cubic end, end): a straight lead
 * along the source's row, the cubic, a straight lead into the target (a lead of two equal points is
 * left out). Four points: the cubic through them (self loops, the data arcs inside a chain). Two
 * points (the older shape): a vertical bezier between them, a loop on the right for a self edge.
 */
export function execEdgePath(e: Pick<ExecEdge, 'from' | 'to' | 'points'>): string {
  const pts = e.points;
  if (pts.length >= 6) {
    const lead = (from: Point, to: Point): string => (from.x === to.x && from.y === to.y ? '' : ` L ${to.x} ${to.y}`);
    const [p0, p1, c1, c2, p4, p5] = [pts[0]!, pts[1]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!];
    return `M ${p0.x} ${p0.y}${lead(p0, p1)} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p4.x} ${p4.y}${lead(p4, p5)}`;
  }
  const [a, b, c, d] = pts;
  if (!a || !b) return '';
  if (c && d) return `M ${a.x} ${a.y} C ${b.x} ${b.y}, ${c.x} ${c.y}, ${d.x} ${d.y}`;
  if (e.from === e.to) return `M ${a.x} ${a.y - 10} C ${a.x + 36} ${a.y - 28}, ${a.x + 36} ${a.y + 28}, ${a.x} ${a.y + 10}`;
  const dy = Math.max(24, Math.abs(b.y - a.y) / 2);
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
}

type Point = { x: number; y: number };

/** the point of the cubic p0 -> c1 -> c2 -> p3 at `t` */
function cubicAt(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return { x: w0 * p0.x + w1 * c1.x + w2 * c2.x + w3 * p3.x, y: w0 * p0.y + w1 * c1.y + w2 * c2.y + w3 * p3.y };
}

/**
 * Where an edge's label sits: about 18 px before its arrowhead (so `×2` reads with the edge it
 * belongs to), on the final lead when that is long enough, else on the curve and never past its
 * middle; a self loop's label sits at the loop's apex.
 */
export function edgeLabelPoint(e: Pick<ExecEdge, 'from' | 'to' | 'points'>): { x: number; y: number } | null {
  const pts = e.points;
  if (pts.length >= 6) {
    const [p1, c1, c2, p4, p5] = [pts[1]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!];
    const tail = Math.hypot(p5.x - p4.x, p5.y - p4.y);
    if (tail >= 18) {
      const f = 18 / tail;
      return { x: p5.x + (p4.x - p5.x) * f, y: p5.y + (p4.y - p5.y) * f - 3 };
    }
    const t = Math.max(0.5, 1 - (18 - tail) / Math.max(36, Math.hypot(p4.x - p1.x, p4.y - p1.y)));
    const p = cubicAt(p1, c1, c2, p4, t);
    return { x: p.x, y: p.y - 3 };
  }
  const [a, b, c, d] = pts;
  if (!a || !b) return null;
  if (c && d) {
    // the chord of a self loop is 20, so t = 0.5: the apex
    const t = Math.max(0.5, 1 - 18 / Math.max(36, Math.hypot(d.x - a.x, d.y - a.y)));
    const p = cubicAt(a, b, c, d, t);
    return { x: p.x, y: p.y - 3 };
  }
  if (e.from === e.to) return { x: a.x + 30, y: a.y + 4 };
  const dy = Math.max(24, Math.abs(b.y - a.y) / 2);
  const t = Math.max(0.5, 1 - 18 / Math.max(36, Math.hypot(b.x - a.x, b.y - a.y)));
  const p = cubicAt(a, { x: a.x, y: a.y + dy }, { x: b.x, y: b.y - dy }, b, t);
  return { x: p.x, y: p.y - 3 };
}

/**
 * The nodes on the call stack (innermost first) and the edges between consecutive frames: the call
 * edge from frame i+1 (or one of its statements) to frame i, else the tool edge. A frame that is a
 * statement or decision of the next frame (the running statement) sits in that frame's chain and
 * adds no edge.
 */
export function activePath(graph: Pick<ExecutionGraphPanel, 'nodes' | 'edges'>, stack: readonly string[]): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set(stack);
  const edges = new Set<string>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (let i = 0; i + 1 < stack.length; i++) {
    const inner = stack[i]!;
    const outer = stack[i + 1]!;
    const innerNode = byId.get(inner);
    if (innerNode && (isStatement(innerNode) || isDecision(innerNode)) && innerNode.parent === outer) continue;
    const fromOuter = (e: GraphEdge) => e.from === outer || (byId.get(e.from)?.kind === 'statement' && (byId.get(e.from) as StatementNode).parent === outer);
    const e = graph.edges.find((x) => x.kind === 'call' && x.to === inner && fromOuter(x)) ?? graph.edges.find((x) => x.kind === 'tool' && x.to === inner && fromOuter(x));
    if (e) edges.add(e.id);
  }
  return { nodes, edges };
}

/**
 * Nodes whose every call ended before `step`; a decision when its first hit is past; a statement
 * when its first hit is past and its parent is a module or a done function.
 */
export function doneNodes(graph: Pick<ExecutionGraphPanel, 'nodes'>, step: number): Set<string> {
  const out = new Set<string>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    if (!isCallNode(n)) continue;
    if (n.spans.length === 0 || n.spans.length < n.calls) continue;
    if (n.spans.every(([, end]) => end < step)) out.add(n.id);
  }
  for (const n of graph.nodes) {
    if (isCallNode(n) || n.firstStep >= step) continue;
    if (isDecision(n)) {
      out.add(n.id);
      continue;
    }
    const parent = byId.get(n.parent);
    if (!parent || parent.kind === 'module' || out.has(parent.id)) out.add(n.id);
  }
  return out;
}

/** Nodes not entered yet at `step`. */
export function notYet(graph: Pick<ExecutionGraphPanel, 'nodes'>, step: number): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) if (n.firstStep > step) out.add(n.id);
  return out;
}

/** The node the step runs in: the innermost stack frame when given, else the smallest span containing the step. */
export function nodeAtStep(graph: Pick<ExecutionGraphPanel, 'nodes'>, step: number, stack?: readonly string[]): string | null {
  if (stack && stack.length > 0) return stack[0]!;
  let best: { id: string; size: number } | null = null;
  for (const n of graph.nodes) {
    if (!isCallNode(n)) continue;
    for (const [entry, end] of n.spans) {
      if (step < entry || step > end) continue;
      const size = end - entry;
      if (!best || size < best.size) best = { id: n.id, size };
    }
  }
  return best?.id ?? null;
}

/** The node of a walkthrough list moment: by id, else by kind and step (the two lists may differ in ids under `--all`). */
export function momentNode(graph: Pick<ExecutionGraphPanel, 'moments'>, moment: { id: string; kind: string; step: number }): string | null {
  const byId = graph.moments.find((m) => m.id === moment.id);
  if (byId) return byId.nodeId;
  const byStep = graph.moments.find((m) => m.kind === moment.kind && m.step === moment.step);
  return byStep?.nodeId ?? null;
}

/** Call-stack frames (innermost first) as node ids through `graph.scopes`; consecutive frames of one node fold. */
export function stackFromFrames(graph: Pick<ExecutionGraphPanel, 'scopes'>, frames: readonly { scopeId: number }[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const id = graph.scopes[String(f.scopeId)];
    if (id && out[out.length - 1] !== id) out.push(id);
  }
  return out;
}
