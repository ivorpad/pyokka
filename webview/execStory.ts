/**
 * The story tree of the Execution Diagram: the run as an outline. Each module is a root; under a
 * scope come its phases (`ExecutionGraphPanel.phases`, when the scope has more than one) or its
 * statements and decisions in `firstStep` order; under a statement, the scopes it calls (the call
 * and tool edges leaving it, in first-call order), each expanded once and a reference row on later
 * mentions; scopes no statement calls (tool callbacks, packages entered from library code,
 * placeholders) follow the modules as roots. Pure; `docs/PROTOCOL.md` "Execution graph" for the nodes.
 */
import type { CallNode, GraphNode } from '../src/session/executionGraphTypes';
import type { GraphPhase } from '../src/session/executionGraphPhases';
import type { ExecutionGraphPanel } from '../src/shared/webviewProtocol';
import { decisionDetail, isCallNode, isDecision, isStatement } from './executionDiagram';

export type StoryRowKind = 'scope' | 'phase' | 'statement' | 'decision' | 'ref';

export interface StoryRow {
  /** unique in the tree: the node id, the phase id, or `ref:<n>:<nodeId>` */
  id: string;
  kind: StoryRowKind;
  /** the graph node the row stands for (a phase: its scope) */
  nodeId: string;
  /** that node's kind (a scope row: module, function or package; a phase: its scope's) */
  nodeKind: GraphNode['kind'];
  label: string;
  /** `×4`, `took False ×2 · not run: 15`, `3 more`; '' when there is nothing to add */
  meta: string;
  /** the step a click moves the Time Machine to */
  step: number;
  children: StoryRow[];
  /** a phase's member node ids */
  members?: string[];
}

export type StoryGraph = Pick<ExecutionGraphPanel, 'nodes' | 'edges'> & { phases?: GraphPhase[] };

function scopeMeta(n: CallNode): string {
  if (n.more !== undefined) return `${n.more} more`;
  if (n.kind === 'module') return '';
  return n.calls > 1 ? `×${n.calls}` : '';
}

function memberMeta(n: GraphNode): string {
  if (isDecision(n)) return decisionDetail(n);
  if (isStatement(n)) return n.hits > 1 ? `×${n.hits}` : '';
  return '';
}

const defined = <T>(x: T | undefined): x is T => x !== undefined;

export function buildStory(graph: StoryGraph): StoryRow[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const members = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (!isDecision(n) && !isStatement(n)) continue;
    if (!byId.has(n.parent)) continue;
    const list = members.get(n.parent) ?? [];
    list.push(n);
    members.set(n.parent, list);
  }
  for (const list of members.values()) list.sort((a, b) => a.firstStep - b.firstStep);
  const callees = new Map<string, string[]>();
  for (const e of [...graph.edges].sort((a, b) => a.firstStep - b.firstStep)) {
    if (e.kind === 'data' || e.from === e.to) continue;
    const list = callees.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    callees.set(e.from, list);
  }
  const phasesOf = new Map<string, GraphPhase[]>();
  for (const p of graph.phases ?? []) {
    const list = phasesOf.get(p.parent) ?? [];
    list.push(p);
    phasesOf.set(p.parent, list);
  }

  const placed = new Set<string>();
  let refs = 0;
  const scopeRow = (id: string, ancestors: ReadonlySet<string>): StoryRow | undefined => {
    const n = byId.get(id);
    if (!n || !isCallNode(n)) return undefined;
    if (placed.has(id) || ancestors.has(id)) return { id: `ref:${refs++}:${id}`, kind: 'ref', nodeId: id, nodeKind: n.kind, label: n.label, meta: scopeMeta(n), step: n.firstStep, children: [] };
    placed.add(id);
    const inner = new Set(ancestors).add(id);
    const memberRow = (m: GraphNode): StoryRow => ({
      id: m.id,
      kind: isDecision(m) ? 'decision' : 'statement',
      nodeId: m.id,
      nodeKind: m.kind,
      label: m.label,
      meta: memberMeta(m),
      step: m.firstStep,
      children: (callees.get(m.id) ?? []).map((c) => scopeRow(c, inner)).filter(defined),
    });
    const own = members.get(id) ?? [];
    const phases = [...(phasesOf.get(id) ?? [])].sort((a, b) => a.firstStep - b.firstStep);
    let children: StoryRow[];
    if (phases.length > 1) {
      children = phases.map((p) => ({ id: p.id, kind: 'phase' as const, nodeId: id, nodeKind: n.kind, label: p.label, meta: '', step: p.firstStep, members: p.members, children: p.members.map((mid) => byId.get(mid)).filter(defined).map(memberRow) }));
      const listed = new Set(phases.flatMap((p) => p.members));
      children.push(...own.filter((m) => !listed.has(m.id)).map(memberRow));
    } else children = own.map(memberRow);
    // calls made from the card itself: a scope without statement nodes (a library function, a package's tool callbacks)
    children.push(...(callees.get(id) ?? []).map((c) => scopeRow(c, inner)).filter(defined));
    return { id, kind: 'scope', nodeId: id, nodeKind: n.kind, label: n.label, meta: scopeMeta(n), step: n.firstStep, children };
  };

  const roots: StoryRow[] = [];
  const scopes = graph.nodes.filter(isCallNode).sort((a, b) => a.firstStep - b.firstStep);
  for (const m of scopes) if (m.kind === 'module') {
    const r = scopeRow(m.id, new Set());
    if (r) roots.push(r);
  }
  for (const s of scopes) if (!placed.has(s.id)) {
    const r = scopeRow(s.id, new Set());
    if (r) roots.push(r);
  }
  return roots;
}

/** Every row of the tree in display order with its depth, skipping the children of rows in `closed`. */
export function flattenStory(rows: readonly StoryRow[], closed: ReadonlySet<string>, depth = 0, out: { row: StoryRow; depth: number }[] = []): { row: StoryRow; depth: number }[] {
  for (const r of rows) {
    out.push({ row: r, depth });
    if (!closed.has(r.id)) flattenStory(r.children, closed, depth + 1, out);
  }
  return out;
}

/** The rows a fresh tree keeps closed: scopes reached through a call (their sub-trees), so the main flow reads first. */
export function defaultClosed(rows: readonly StoryRow[], depth = 0, out = new Set<string>()): Set<string> {
  for (const r of rows) {
    if (r.kind === 'scope' && depth > 0 && r.children.length > 0) out.add(r.id);
    defaultClosed(r.children, depth + 1, out);
  }
  return out;
}
