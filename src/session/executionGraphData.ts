/**
 * The execution graph's data edges from calls (docs/PROTOCOL.md, the first `data` bullet): a
 * value a call returned, or a value logged in the caller's scope, that a later call took as a
 * parameter. The producer node is the callee of the producing call or the function node of the
 * logged value's location (never a statement node); the consumer is the callee of the taking call.
 */
import type { TraceScope } from '../shared/protocol';
import type { TraceModel } from '../timeMachine/traceModel';
import type { Moment, MomentLocation } from './walkthroughShared';

export interface DataEdgeDraft {
  from: string;
  to: string;
  label: string;
  firstStep: number;
}

export interface CallDataContext {
  trace: TraceModel;
  /** call and tool moments -> their callee node key */
  momentNode: Map<Moment, string>;
  /** call and tool moments -> the caller's scope node key */
  callerOf: Map<Moment, string | undefined>;
  keyOf: (loc: MomentLocation) => string | undefined;
  hasNode: (key: string) => boolean;
}

/** One draft per (producer, callee, parameter) in call order; the caller deduplicates and sorts. */
export function callDataEdges(moments: Moment[], ctx: CallDataContext): DataEdgeDraft[] {
  const producers: { name: string; text: string; step: number; node: string }[] = [];
  for (const m of moments) {
    if (m.kind === 'call' || m.kind === 'tool') {
      const node = ctx.momentNode.get(m);
      if (!node) continue;
      for (const v of m.values) if (v.role === 'out' && v.name !== 'raised') producers.push({ name: v.name, text: v.text, step: m.endStep ?? m.step, node });
    } else if (m.kind === 'value') {
      const node = ctx.keyOf(m.location);
      const v = m.values[0];
      if (node && ctx.hasNode(node) && v) producers.push({ name: v.name, text: v.text, step: m.step, node });
    }
  }
  const out: DataEdgeDraft[] = [];
  for (const m of moments) {
    if (m.kind !== 'call' && m.kind !== 'tool') continue;
    const callee = ctx.momentNode.get(m);
    if (!callee) continue;
    const callerKey = ctx.callerOf.get(m);
    let scope: TraceScope | undefined;
    if (m.kind === 'call') scope = ctx.trace.scope(ctx.trace.scopeId(m.step));
    else {
      const s = m.scopeId !== undefined ? ctx.trace.scope(m.scopeId) : undefined;
      const callerId = m.callerScopeId ?? s?.parent;
      scope = callerId !== undefined ? ctx.trace.scope(callerId) : undefined;
    }
    if (!scope) continue;
    for (const v of m.values) {
      if (v.role !== 'in') continue;
      let best: (typeof producers)[number] | undefined;
      for (const p of producers) {
        if (p.step < scope.first || p.step >= m.step || p.node === callerKey) continue;
        if (p.name !== v.name && p.text !== v.text) continue;
        if (!best || p.step >= best.step) best = p;
      }
      if (best) out.push({ from: best.node, to: callee, label: v.name, firstStep: m.entryStep ?? m.step });
    }
  }
  return out;
}
