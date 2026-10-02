/**
 * The column layout of the Execution Diagram. One cluster per module / function / package: the
 * scope's card, then its statements and decisions stacked under it in `firstStep` order. Clusters
 * sit in columns by call depth: the modules in column 0, a callee one column right of the cluster
 * holding the statement that first calls it, its top aligned with that statement. Call edges leave a
 * box along its row to the column's edge and curve across the gap into the callee's card; a data
 * edge inside a chain is an arc on the chain's left (offset by hop count so nested arcs stay
 * apart); an edge within one column is an arc on the column's right. Replaces dagre for this view;
 * the value diagram keeps dagre (`diagram.ts`).
 */
import type { CallNode, GraphEdge } from '../src/session/executionGraphTypes';
import type { ExecutionGraphPanel } from '../src/shared/webviewProtocol';
import type { ExecCluster, ExecEdge, ExecNode } from './executionDiagram';

export const CLUSTER_PAD = 12;
export const CLUSTER_GAP = 24;
export const COLUMN_GAP = 96;
export const BOX_GAP = 10;
export const DATA_ARC = 18;
export const MARGIN = 20;
/** hops beyond this share the widest arc offset (keeps the arcs of column 0 inside the canvas) */
export const DATA_ARC_MAX_HOPS = 4;

interface Point {
  x: number;
  y: number;
}

function isScope(n: { kind: string }): n is CallNode {
  return n.kind === 'module' || n.kind === 'function' || n.kind === 'package';
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** stacking order inside a cluster: `firstStep`, then `line`, then id */
function childOrder(a: ExecNode, b: ExecNode): number {
  return a.node.firstStep - b.node.firstStep || (a.node.line ?? 0) - (b.node.line ?? 0) || compareIds(a.id, b.id);
}

/**
 * Positions the boxes in place (sets `x` / `y` on the given nodes) and returns one cluster per
 * module / function / package node of the graph (ordered by column, then y) plus the size of the
 * clusters' bounding box with MARGIN on the right and bottom.
 *
 * Columns: modules in column 0, always; a function or package one column right of the cluster
 * holding the source box of its first incoming call / tool edge (the one with the smallest
 * `firstStep`; an edge from its own chain, recursion, does not count), column 1 when it has none or
 * when that caller's column is not resolved yet (a cycle). Column 0 starts at MARGIN, every next
 * column COLUMN_GAP right of the previous column's widest cluster. Within a column the clusters
 * follow the ascending `firstStep` of their headers, each at the top of the box that first calls it
 * or, when that would overlap, CLUSTER_GAP under the previous cluster.
 *
 * A scope node without a box, or a statement whose cluster has no scope node, is not placed.
 */
export function layoutColumns(nodes: ExecNode[], graph: Pick<ExecutionGraphPanel, 'nodes' | 'edges'>): { clusters: ExecCluster[]; width: number; height: number } {
  const boxById = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, ExecNode[]>();
  for (const n of nodes) {
    if (n.kind !== 'statement' && n.kind !== 'decision') continue;
    const list = children.get(n.cluster) ?? [];
    list.push(n);
    children.set(n.cluster, list);
  }

  const scopes = graph.nodes.filter((n): n is CallNode => isScope(n) && boxById.has(n.id)).sort((a, b) => a.firstStep - b.firstStep || compareIds(a.id, b.id));
  const clusters: ExecCluster[] = [];
  const clusterById = new Map<string, ExecCluster>();
  for (const s of scopes) {
    const boxes = [boxById.get(s.id)!, ...(children.get(s.id) ?? []).sort(childOrder)];
    const cluster: ExecCluster = {
      id: s.id,
      kind: s.kind,
      column: 0,
      boxes: boxes.map((b) => b.id),
      x: 0,
      y: 0,
      width: Math.max(...boxes.map((b) => b.width)) + 2 * CLUSTER_PAD,
      height: boxes.reduce((sum, b) => sum + b.height, 0) + (boxes.length - 1) * BOX_GAP + 2 * CLUSTER_PAD,
    };
    clusters.push(cluster);
    clusterById.set(s.id, cluster);
  }

  // the first incoming call / tool edge of every cluster: the smallest firstStep among the edges whose
  // source box sits in another cluster
  const firstIn = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    if (e.kind === 'data' || !clusterById.has(e.to)) continue;
    const src = boxById.get(e.from);
    if (!src || src.cluster === e.to || !clusterById.has(src.cluster)) continue;
    const best = firstIn.get(e.to);
    if (!best || e.firstStep < best.firstStep) firstIn.set(e.to, e);
  }
  const callerOf = (c: ExecCluster): ExecCluster | undefined => {
    const e = firstIn.get(c.id);
    return e ? clusterById.get(boxById.get(e.from)!.cluster) : undefined;
  };

  // columns, resolved in ascending firstStep of the headers (the order of `clusters`)
  const resolved = new Set<string>();
  for (const c of clusters) {
    if (c.kind === 'module') c.column = 0;
    else {
      const caller = callerOf(c);
      c.column = caller && resolved.has(caller.id) ? caller.column + 1 : 1;
    }
    resolved.add(c.id);
  }
  const columnCount = clusters.reduce((m, c) => Math.max(m, c.column + 1), 0);
  const widest: number[] = new Array<number>(columnCount).fill(0);
  for (const c of clusters) widest[c.column] = Math.max(widest[c.column]!, c.width);
  const columnX: number[] = [];
  for (let i = 0; i < columnCount; i++) columnX.push(i === 0 ? MARGIN : columnX[i - 1]! + widest[i - 1]! + COLUMN_GAP);

  // vertical placement, column by column: the anchors (in columns to the left) are positioned by then
  const byColumn: ExecCluster[][] = Array.from({ length: columnCount }, () => []);
  for (const c of clusters) byColumn[c.column]!.push(c);
  const placed = new Set<string>();
  for (let col = 0; col < columnCount; col++) {
    let prevBottom: number | null = null;
    for (const c of byColumn[col]!) {
      const e = firstIn.get(c.id);
      const anchor = e ? boxById.get(e.from) : undefined;
      const anchorY = anchor && placed.has(anchor.cluster) ? anchor.y : MARGIN;
      c.x = columnX[col]!;
      c.y = Math.max(anchorY, prevBottom === null ? MARGIN : prevBottom + CLUSTER_GAP);
      let y = c.y + CLUSTER_PAD;
      for (const id of c.boxes) {
        const b = boxById.get(id)!;
        b.x = c.x + CLUSTER_PAD;
        b.y = y;
        y += b.height + BOX_GAP;
      }
      prevBottom = c.y + c.height;
      placed.add(c.id);
    }
  }

  const width = clusters.reduce((m, c) => Math.max(m, c.x + c.width), 0) + MARGIN;
  const height = clusters.reduce((m, c) => Math.max(m, c.y + c.height), 0) + MARGIN;
  clusters.sort((a, b) => a.column - b.column || a.y - b.y);
  return { clusters, width, height };
}

/**
 * Fills the points of every edge from the positioned boxes and returns the same edges. Four points
 * (start, two controls, end) for a cubic: a self edge loops on the right of its box; a data edge
 * inside one chain is an arc on the chain's left, DATA_ARC plus 6 px per hop between the two boxes
 * (capped at DATA_ARC_MAX_HOPS). Six points (start, lead end, two controls, cubic end, end) for any
 * other edge: a straight lead along the source's row to its column's edge, the cubic, a straight
 * lead along the target's row. Left to right into the target's left side when the target is in a
 * later column, mirrored when it is in an earlier one, and as an arc on the right of the column
 * when both are in the same column. An edge with a missing end gets no points.
 */
export function routeEdges(edges: ExecEdge[], nodes: readonly ExecNode[], clusters: readonly ExecCluster[]): ExecEdge[] {
  const boxById = new Map(nodes.map((n) => [n.id, n]));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const indexInChain = new Map<string, number>();
  for (const c of clusters) c.boxes.forEach((id, i) => indexInChain.set(id, i));
  // a column's left and right edges: the lead segments run along a box's row out to them, where nothing else sits
  const columnLeft = new Map<number, number>();
  const columnRight = new Map<number, number>();
  for (const c of clusters) {
    columnLeft.set(c.column, Math.min(columnLeft.get(c.column) ?? Infinity, c.x));
    columnRight.set(c.column, Math.max(columnRight.get(c.column) ?? -Infinity, c.x + c.width));
  }
  const columnOf = (b: ExecNode): number => clusterById.get(b.cluster)?.column ?? 0;
  const midY = (b: ExecNode): number => b.y + b.height / 2;
  const right = (b: ExecNode): number => b.x + b.width;
  const colRight = (b: ExecNode): number => Math.max(columnRight.get(columnOf(b)) ?? right(b), right(b));
  const colLeft = (b: ExecNode): number => Math.min(columnLeft.get(columnOf(b)) ?? b.x, b.x);

  for (const e of edges) {
    const src = boxById.get(e.from);
    const tgt = boxById.get(e.to);
    if (!src || !tgt) {
      e.points = [];
      continue;
    }
    if (e.from === e.to) {
      const r = right(src);
      const m = midY(src);
      e.points = [{ x: r, y: m - 10 }, { x: r + 36, y: m - 28 }, { x: r + 36, y: m + 28 }, { x: r, y: m + 10 }];
      continue;
    }
    if (e.kind === 'data' && src.cluster === tgt.cluster) {
      const hops = Math.abs((indexInChain.get(tgt.id) ?? 0) - (indexInChain.get(src.id) ?? 0));
      const off = DATA_ARC + 6 * Math.min(hops, DATA_ARC_MAX_HOPS);
      const p0: Point = { x: src.x, y: midY(src) };
      const p3: Point = { x: tgt.x, y: midY(tgt) };
      e.points = [p0, { x: p0.x - off, y: p0.y }, { x: p3.x - off, y: p3.y }, p3];
      continue;
    }
    // six points: a lead along the source's row to its column's edge, the cubic across, a lead along
    // the target's row from its column's edge; a lead is empty (two equal points) where the box already
    // touches the edge. Boxes of one chain differ in width, so a curve leaving a narrow box directly
    // would cut through the wider boxes above or below it.
    const sc = columnOf(src);
    const tc = columnOf(tgt);
    if (tc > sc) {
      const p0: Point = { x: right(src), y: midY(src) };
      const p1: Point = { x: colRight(src), y: p0.y };
      const p4: Point = { x: tgt.x, y: midY(tgt) };
      const dx = Math.max(24, Math.abs(p4.x - p1.x) / 2);
      e.points = [p0, p1, { x: p1.x + dx, y: p1.y }, { x: p4.x - dx, y: p4.y }, p4, { ...p4 }];
    } else if (tc === sc) {
      const p0: Point = { x: right(src), y: midY(src) };
      const p1: Point = { x: colRight(src), y: p0.y };
      const p4: Point = { x: p1.x, y: midY(tgt) };
      const p5: Point = { x: right(tgt), y: p4.y };
      e.points = [p0, p1, { x: p1.x + 48, y: p1.y }, { x: p4.x + 48, y: p4.y }, p4, p5];
    } else {
      const p0: Point = { x: src.x, y: midY(src) };
      const p1: Point = { x: colLeft(src), y: p0.y };
      const p4: Point = { x: colRight(tgt), y: midY(tgt) };
      const p5: Point = { x: right(tgt), y: p4.y };
      const dx = Math.max(24, Math.abs(p4.x - p1.x) / 2);
      e.points = [p0, p1, { x: p1.x - dx, y: p1.y }, { x: p4.x + dx, y: p4.y }, p4, p5];
    }
  }
  return edges;
}
