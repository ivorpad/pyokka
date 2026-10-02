/**
 * Phases: the statements and decisions of a scope grouped the way the source groups them, for the
 * Execution Diagram's story tree. A new phase starts at a member on the scope's base indentation
 * when a blank line or a comment line sits between the previous member's line and its own; members
 * indented deeper (a loop body, an if arm) stay in the phase of the header above them. A phase is
 * labelled by the comment block directly above its first line, else by the names its statements
 * assign, else by its first member's label. Panel-only (`ExecutionGraphPanel.phases`): `pyokka
 * graph` and the bridge do not carry it and the Python builder is not involved. Pure.
 */
import { isDecisionNode, isStatementNode, type DecisionNode, type ExecutionGraph, type StatementNode } from './executionGraphTypes';

export interface GraphPhase {
  /** `<parent>:p<index>` */
  id: string;
  /** the scope node the members belong to */
  parent: string;
  label: string;
  /** the label is a comment from the source */
  comment: boolean;
  /** member node ids (statements and decisions) in `firstStep` order */
  members: string[];
  /** the first source line of the phase */
  line: number;
  firstStep: number;
}

export const PHASE_LABEL_MAX = 60;
/** names listed in a label built from the statements' targets */
const LABEL_TARGETS_MAX = 3;

type Member = StatementNode | DecisionNode;

function isComment(line: string | undefined): boolean {
  return line !== undefined && line.trim().startsWith('#');
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === '';
}

function indentOf(line: string | undefined): number {
  if (line === undefined) return 0;
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** The comment block directly above `line` (1-based), joined with spaces and stripped of its `#`; '' when the line above is not a comment. */
export function commentAbove(source: readonly string[], line: number): string {
  const parts: string[] = [];
  for (let l = line - 1; l >= 1; l--) {
    const text = source[l - 1];
    if (!isComment(text)) break;
    parts.unshift(text!.trim().replace(/^#+\s?/, ''));
  }
  return parts.join(' ').trim();
}

function labelOf(members: readonly Member[], source: readonly string[] | undefined): { label: string; comment: boolean } {
  const first = members[0]!;
  if (source) {
    const c = commentAbove(source, first.line);
    if (c) return { label: ellipsize(c, PHASE_LABEL_MAX), comment: true };
  }
  const targets: string[] = [];
  for (const m of members) if (isStatementNode(m)) for (const t of m.targets) if (!targets.includes(t)) targets.push(t);
  if (targets.length) {
    const shown = targets.slice(0, LABEL_TARGETS_MAX).join(', ') + (targets.length > LABEL_TARGETS_MAX ? ', …' : '');
    return { label: ellipsize(shown, PHASE_LABEL_MAX), comment: false };
  }
  return { label: ellipsize(first.label, PHASE_LABEL_MAX), comment: false };
}

/** A separator between two member lines: a blank or a comment-only line strictly between them. */
function separated(source: readonly string[], from: number, to: number): boolean {
  for (let l = from + 1; l < to; l++) {
    const text = source[l - 1];
    if (isBlank(text) || isComment(text)) return true;
  }
  return false;
}

export function buildPhases(graph: Pick<ExecutionGraph, 'nodes'>, readSource: (fileId: number) => string[] | undefined): GraphPhase[] {
  const scopes = new Set(graph.nodes.filter((n) => !isDecisionNode(n) && !isStatementNode(n)).map((n) => n.id));
  const byParent = new Map<string, Member[]>();
  for (const n of graph.nodes) {
    if (!isDecisionNode(n) && !isStatementNode(n)) continue;
    if (!scopes.has(n.parent)) continue;
    const list = byParent.get(n.parent) ?? [];
    list.push(n);
    byParent.set(n.parent, list);
  }
  const out: GraphPhase[] = [];
  for (const [parent, members] of byParent) {
    members.sort((a, b) => a.line - b.line || a.firstStep - b.firstStep);
    const source = readSource(members[0]!.fileId);
    const groups: Member[][] = [];
    if (!source) groups.push(members);
    else {
      const base = Math.min(...members.map((m) => indentOf(source[m.line - 1])));
      let cur: Member[] = [];
      for (const m of members) {
        const prev = cur[cur.length - 1];
        const top = indentOf(source[m.line - 1]) === base;
        if (prev && top && separated(source, prev.line, m.line)) {
          groups.push(cur);
          cur = [];
        }
        cur.push(m);
      }
      if (cur.length) groups.push(cur);
    }
    groups.forEach((g, i) => {
      const { label, comment } = labelOf(g, source);
      const ordered = [...g].sort((a, b) => a.firstStep - b.firstStep);
      out.push({ id: `${parent}:p${i}`, parent, label, comment, members: ordered.map((m) => m.id), line: g[0]!.line, firstStep: Math.min(...g.map((m) => m.firstStep)) });
    });
  }
  return out;
}
