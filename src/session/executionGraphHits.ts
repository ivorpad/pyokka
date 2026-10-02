/**
 * The steps a node of the execution graph ran at, for the Execution Diagram's inspector: every hit
 * of a statement or decision (the steps on its line), every entry of a function (the first step of
 * each trace scope the graph maps to it, beyond the 50 spans the graph carries), with the value
 * logged at each hit when there is one. Modules and packages have no list: their spans suffice.
 * Pure; the host feeds it the trace and the values.
 */
import type { TraceScope } from '../shared/protocol';
import type { ExecutionGraph } from './executionGraphTypes';

export const HITS_MAX = 400;

export interface NodeHits {
  /** hits over the whole run (`steps` holds the first HITS_MAX) */
  total: number;
  steps: number[];
  /** the value logged at each step of `steps`, null when nothing was */
  values: (string | null)[];
}

export interface HitsTrace {
  count: number;
  location(step: number): { fileId: number; range: readonly number[] } | undefined;
  scopes: readonly TraceScope[];
}

export function nodeHits(graph: Pick<ExecutionGraph, 'nodes' | 'scopes'>, trace: HitsTrace, nodeId: string, valueAt: (step: number) => string | undefined = () => undefined): NodeHits | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  let steps: number[];
  if (node.kind === 'statement' || node.kind === 'decision') {
    steps = [];
    for (let i = 0; i < trace.count; i++) {
      const loc = trace.location(i);
      if (loc && loc.fileId === node.fileId && loc.range[0] === node.line) steps.push(i);
    }
  } else if (node.kind === 'function') {
    steps = trace.scopes.filter((s) => graph.scopes[String(s.scopeId)] === nodeId).map((s) => s.first).sort((a, b) => a - b);
  } else return undefined;
  const kept = steps.slice(0, HITS_MAX);
  return { total: steps.length, steps: kept, values: kept.map((s) => (node.kind === 'function' ? null : (valueAt(s) ?? null))) };
}
