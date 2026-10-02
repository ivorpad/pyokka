/**
 * Value tree -> graph (nodes = objects/lists, rows = properties, edges to child nodes) + dagre layout.
 */
import * as dagre from '@dagrejs/dagre';
import type { ValueNode, ValueProp } from '../src/shared/protocol';
import { flat, isStructured, pyQuote } from './format';

export interface DiagramRow {
  name: string;
  text: string;
  /** id of the child node when the row's value is structured and expanded */
  childId?: string;
  /** structured value not currently shown as its own node */
  collapsed?: boolean;
  /** structured value that must be fetched from the host before it can be expanded */
  loadable?: boolean;
  node: ValueNode;
  path: string;
}

export interface DiagramNode {
  id: string;
  title: string;
  typeName: string;
  rows: DiagramRow[];
  node: ValueNode;
  path: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface DiagramEdge {
  from: string;
  fromRow: number;
  to: string;
  points: { x: number; y: number }[];
}

export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
}

export const ROW_H = 20;
export const TITLE_H = 26;
export const CHAR_W = 7.2;
export const PAD = 16;
export const MAX_ROW_TEXT = 40;

function ellipsize(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function typeName(node: ValueNode): string {
  switch (node.type) {
    case 'dict': return 'dict';
    case 'list': return 'list';
    case 'tuple': return 'tuple';
    case 'set': return 'set';
    case 'frozenset': return 'frozenset';
    default: return node.type;
  }
}

function rowName(parent: ValueNode, p: ValueProp): string {
  if (parent.type === 'dict') return p.keyRepr ?? pyQuote(p.name);
  return p.name;
}

function rowPath(parent: ValueNode, parentPath: string, p: ValueProp): string {
  if (p.expressionPath) return p.expressionPath;
  if (parent.type === 'dict') return `${parentPath}[${p.keyRepr ?? pyQuote(p.name)}]`;
  if (parent.type === 'list' || parent.type === 'tuple') return `${parentPath}[${p.name}]`;
  return `${parentPath}.${p.name}`;
}

/**
 * Build the graph. `expanded` holds node ids (paths) whose children are shown as nodes; when
 * `expanded` is empty every loaded structured child up to `autoDepth` is expanded.
 */
export function buildGraph(root: ValueNode, rootName: string, expanded: Set<string> | null, autoDepth = 1): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const visit = (node: ValueNode, name: string, path: string, depth: number) => {
    const id = path;
    const rows: DiagramRow[] = [];
    const props = (node.props ?? []).filter((p) => !p.loadActionNode);
    props.forEach((p, i) => {
      const cpath = rowPath(node, path, p);
      const structured = isStructured(p) && !p.circular;
      const row: DiagramRow = { name: ellipsize(rowName(node, p), MAX_ROW_TEXT), text: '', node: p, path: cpath };
      if (structured) {
        const loaded = !!p.props;
        const isExpanded = expanded ? expanded.has(cpath) : loaded && depth < autoDepth;
        if (isExpanded && loaded) {
          row.childId = cpath;
          row.text = '';
          visit(p, rowName(node, p), cpath, depth + 1);
          edges.push({ from: id, fromRow: i, to: cpath, points: [] });
        } else {
          row.collapsed = true;
          row.loadable = !loaded;
          row.text = p.type === 'list' || p.type === 'tuple' ? '[…]' : '{…}';
        }
      } else {
        row.text = ellipsize(flat(p), MAX_ROW_TEXT);
      }
      rows.push(row);
    });
    if ((node.cappedProps || node.cappedElements) && node.props) {
      rows.push({ name: '…', text: '', node, path, loadable: true, collapsed: true });
    }
    const title = `${name}: ${typeName(node)}`;
    const longest = Math.max(title.length + 3, ...rows.map((r) => r.name.length + 2 + r.text.length));
    nodes.push({
      id,
      title: name,
      typeName: typeName(node),
      rows,
      node,
      path,
      width: Math.max(120, Math.round(longest * CHAR_W + PAD * 2)),
      height: TITLE_H + rows.length * ROW_H + 6,
      x: 0,
      y: 0,
    });
  };
  visit(root, rootName, rootName, 0);
  return { nodes, edges };
}

/** what dagre needs of a node: an id and a box; `x`/`y` are filled in by `layoutGraph` */
export interface LayoutBox {
  id: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

/** what dagre needs of an edge; `fromRow` only matters for the `row-to-title` route */
export interface LayoutLink {
  from: string;
  to: string;
  fromRow?: number;
  points: { x: number; y: number }[];
}

export interface LayoutOptions {
  /** dagre rank direction: left to right (the value diagram) or top to bottom (the execution diagram) */
  rankdir?: 'LR' | 'TB';
  /**
   * `row-to-title`: from the source row's right edge to the target's title (LR only; the value diagram).
   * `centre`: from the source's far side (bottom in TB, right in LR) to the target's near side, both centred;
   * a self edge gets its two points on the source's right side.
   */
  route?: 'row-to-title' | 'centre';
  nodesep?: number;
  ranksep?: number;
}

export function layoutGraph<N extends LayoutBox, E extends LayoutLink>(input: { nodes: N[]; edges: E[] }, opts: LayoutOptions = {}): { nodes: N[]; edges: E[]; width: number; height: number } {
  const rankdir = opts.rankdir ?? 'LR';
  const route = opts.route ?? 'row-to-title';
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, nodesep: opts.nodesep ?? 24, ranksep: opts.ranksep ?? 60, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of input.nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of input.edges) if (e.from !== e.to) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const byId = new Map<string, N>();
  const nodes = input.nodes.map((n) => {
    const pos = g.node(n.id);
    const placed = { ...n, x: pos.x - n.width / 2, y: pos.y - n.height / 2 };
    byId.set(n.id, placed);
    return placed;
  });
  const edges = input.edges.map((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) return e;
    if (e.from === e.to) {
      const p = { x: from.x + from.width, y: from.y + from.height / 2 };
      return { ...e, points: [p, { ...p }] };
    }
    if (route === 'row-to-title') {
      const y1 = from.y + TITLE_H + (e.fromRow ?? 0) * ROW_H + ROW_H / 2;
      return { ...e, points: [{ x: from.x + from.width, y: y1 }, { x: to.x, y: to.y + TITLE_H / 2 }] };
    }
    if (rankdir === 'TB') {
      return { ...e, points: [{ x: from.x + from.width / 2, y: from.y + from.height }, { x: to.x + to.width / 2, y: to.y }] };
    }
    return { ...e, points: [{ x: from.x + from.width, y: from.y + from.height / 2 }, { x: to.x, y: to.y + to.height / 2 }] };
  });
  const gl = g.graph();
  return { nodes, edges, width: gl.width ?? 0, height: gl.height ?? 0 };
}

export function edgePath(e: DiagramEdge): string {
  const [a, b] = e.points;
  if (!a || !b) return '';
  const dx = Math.max(30, (b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** zoom/pan that fits `graph` into a viewport */
export function fitTransform(graph: { width: number; height: number }, viewW: number, viewH: number, maxScale = 1.5): { k: number; x: number; y: number } {
  if (graph.width <= 0 || graph.height <= 0) return { k: 1, x: 0, y: 0 };
  const k = Math.min(maxScale, (viewW - 40) / graph.width, (viewH - 40) / graph.height);
  return { k, x: (viewW - graph.width * k) / 2, y: (viewH - graph.height * k) / 2 };
}
