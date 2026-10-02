/**
 * The execution graph's text form (the lines `pyokka graph` prints, for the Code Story and the
 * tests) and the call stack as node ids (the panel's active path).
 */
import { displayPath } from './walkthroughShared';
import type { DecisionNode, ExecutionGraph, GraphRow, StatementNode } from './executionGraphTypes';

function rowText(r: GraphRow): string {
  if (r.kind === 'raised') return `raised ${r.name}${r.text ? `: ${r.text}` : ''}`;
  if (r.kind === 'out' && r.name === 'return') return `out ${r.text}`;
  return `${r.kind} ${r.name} = ${r.text}`;
}

/** Header, one line per node with its decisions and statements indented under it in firstStep order, then the edges; ≤ `limit` chars each. */
export function renderGraphLines(graph: ExecutionGraph, opts: { limit?: number; workspaceRoot?: string } = {}): string[] {
  const limit = opts.limit ?? 100;
  const root = opts.workspaceRoot ?? '';
  const one = (text: string): string => {
    const indent = text.length - text.trimStart().length;
    const body = text.trimStart().replace(/\s*\n\s*/g, ' ');
    const max = Math.max(10, limit - indent);
    return ' '.repeat(indent) + (body.length <= max ? body : body.slice(0, max - 1) + '…');
  };
  const out: string[] = [one(`${graph.nodes.length} nodes, ${graph.edges.length} edges over ${graph.count} steps`)];
  const byParent = new Map<string, (DecisionNode | StatementNode)[]>();
  for (const n of graph.nodes) {
    if (n.kind !== 'decision' && n.kind !== 'statement') continue;
    const list = byParent.get(n.parent) ?? [];
    list.push(n);
    byParent.set(n.parent, list);
  }
  for (const n of graph.nodes) {
    if (n.kind === 'decision' || n.kind === 'statement') continue;
    const where = n.file ? ` ${displayPath(n.file, root)}${n.line !== undefined ? `:${n.line}` : ''}` : '';
    const parts = [`${n.id} ${n.label}${where}  ×${n.calls}`];
    if (n.nested !== undefined) parts.push(`${n.nested} nested`);
    if (n.rows.length) parts.push(n.rows.map(rowText).join(' · '));
    out.push(one(parts.join('  ')));
    for (const d of (byParent.get(n.id) ?? []).sort((a, b) => a.firstStep - b.firstStep)) {
      const dparts = d.kind === 'decision' ? [`   ${d.id} ${d.text}  ×${d.hits}`] : [`   ${d.id} ${d.label}  ×${d.hits}`];
      if (d.kind === 'decision' && d.notRun.length) dparts.push(`not run: ${d.notRun.join(', ')}`);
      if (d.rows.length) dparts.push(d.rows.map(rowText).join(' · '));
      out.push(one(dparts.join('  ')));
    }
  }
  for (const e of graph.edges) {
    if (e.kind === 'data') out.push(one(`${e.from} ⇢ ${e.to}  ${e.label}`));
    else out.push(one(`${e.from} → ${e.to}  ${e.kind === 'tool' ? 'tool ' : ''}×${e.count}  #${e.firstStep}`));
  }
  return out;
}

/**
 * A call stack (innermost first) as node ids: frames without a node and consecutive repeats
 * dropped. With `current` (the step's file and line), the statement node there, when one exists,
 * comes first: the panel highlights the running statement ahead of its scope.
 */
export function graphStack(graph: ExecutionGraph, frames: { scopeId: number; fileId?: number; line?: number }[], current?: { fileId: number; line: number }): string[] {
  // innermost first: the statement running in each frame (the call site for the outer frames) before the frame's scope node
  const out: string[] = [];
  const push = (id: string | undefined): void => {
    if (id && !out.includes(id)) out.push(id);
  };
  const statementAt = (fileId?: number, line?: number): string | undefined => {
    if (fileId === undefined || line === undefined) return undefined;
    return graph.nodes.find((n) => n.kind === 'statement' && n.fileId === fileId && n.line === line)?.id;
  };
  frames.forEach((f, i) => {
    push(i === 0 && current ? statementAt(current.fileId, current.line) : statementAt(f.fileId, f.line));
    push(graph.scopes[String(f.scopeId)]);
  });
  return out;
}
