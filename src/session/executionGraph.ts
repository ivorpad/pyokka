/**
 * The execution graph: the diagram of a run as a projection of the walkthrough (docs/PROTOCOL.md,
 * "Execution graph"). Pure: one node per module, user function, library package (or unrolled
 * library function), decision statement and simple statement a step ran; call, tool and data
 * edges; the moment and scope maps. `python/pyokka_runtime/agent/graph.py` is the same builder
 * over a saved run; `test/unit/fixtures/execution-graph.json` and
 * `execution-graph-statements.json` pin both to identical JSON.
 */
import type { TraceScope } from '../shared/protocol';
import { MomentBuilder } from './moments';
import { buildWalkthrough } from './walkthrough';
import { displayPath, isUserFile, libraryPackage, type Moment, type MomentLocation, type WalkthroughInputs } from './walkthroughShared';
import { collectStatements, decisionNames, statementDataEdges, statementKey, type StatementDraft } from './executionGraphStatements';
import { callDataEdges, type DataEdgeDraft } from './executionGraphData';
import { finishRows, notRun, parsePrint, parseRaised, splitRaised, upperBound } from './executionGraphRows';
import { DATA_EDGES_MAX, GRAPH_CAP, SPANS_MAX, STEPS_MAX, type CallEdge, type CallNode, type DataEdge, type DecisionNode, type ExecutionGraph, type ExecutionGraphOptions, type GraphEdge, type GraphMomentRef, type GraphNode, type GraphRow, type StatementNode } from './executionGraphTypes';

export * from './executionGraphTypes';
export { renderGraphLines, graphStack } from './executionGraphText';

/* ---------- drafts ---------- */

interface NodeDraft {
  key: string;
  kind: 'module' | 'function' | 'package';
  label: string;
  file?: string | null;
  line?: number;
  fileId?: number;
  function?: string;
  package?: string;
  /** the counted call / tool moments (a folded package: only those entering from another node) */
  calls: Moment[];
  firstStep: number;
  callRows: GraphRow[];
  errorRows: GraphRow[];
  rows: GraphRow[];
  /** placeholder under the cap: dropped functions of `file` */
  more?: number;
  /** placeholder: the dropped nodes' calls */
  droppedCalls?: number;
}

interface DecisionDraft {
  key: string;
  parentKey: string;
  label: string;
  file: string | null;
  line: number;
  fileId: number;
  text: string;
  taken?: string;
  firstStep: number;
  hits: number;
  loop: boolean;
  takens: Set<string>;
  rows: GraphRow[];
  /** for the data edges only: a loop's target and the condition's names */
  targets: string[];
  reads: string[];
}

interface CallEdgeDraft {
  from: string;
  to: string;
  kind: 'call' | 'tool';
  moments: Moment[];
}

const NODE_RANK: Record<string, number> = { module: 0, function: 1, package: 1, decision: 2, statement: 2 };
const EDGE_RANK: Record<string, number> = { call: 0, tool: 0, data: 1 };

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ---------- the builder ---------- */

export function buildExecutionGraph(inputs: WalkthroughInputs, opts: ExecutionGraphOptions = {}): ExecutionGraph {
  const all = !!opts.all;
  const expand = opts.expand ?? [];
  const unroll = all || expand.length > 0;
  const cap = opts.cap ?? GRAPH_CAP;
  const withStatements = opts.statements !== false;
  const w = buildWalkthrough(inputs, { all: unroll, scope: opts.scope, cap: Number.MAX_SAFE_INTEGER });
  const builder = new MomentBuilder(inputs, unroll);
  const trace = inputs.trace;
  const files = inputs.files;
  const root = inputs.workspaceRoot;
  let truncated = false;

  /* ----- keys (rule 2) ----- */
  const user = (file: string | null | undefined): boolean => isUserFile(file, root, inputs.mainFile);
  const folded = (pkg: string): boolean => !all && !expand.includes(pkg);
  const keyOf = (loc: MomentLocation): string | undefined => {
    if (!loc.file) return undefined;
    if (user(loc.file)) return `${loc.fileId}:${loc.function}`;
    const pkg = libraryPackage(loc.file) ?? '?';
    return folded(pkg) ? `pkg:${pkg}` : `${loc.fileId}:${loc.function}`;
  };
  const mainId = builder.mainFileId();
  const mainKey = `${mainId}:<module>`;
  const scopeKey = (s: TraceScope): string | undefined => {
    if (s.parent < 0) return mainKey;
    const loc = files.locate(s.rid);
    if (!loc) return undefined;
    return keyOf({ file: loc.path, line: 0, function: builder.scopeQualname(s.scopeId), fileId: loc.fileId });
  };

  /* ----- nodes ----- */
  const nodes = new Map<string, NodeDraft>();
  const draft = (key: string, kind: NodeDraft['kind'], label: string, firstStep: number): NodeDraft => ({ key, kind, label, calls: [], firstStep, callRows: [], errorRows: [], rows: [] });
  const main = draft(mainKey, 'module', '<module>', 0);
  main.file = files.get(mainId)?.path ?? inputs.mainFile;
  main.line = 1;
  main.fileId = mainId;
  main.function = '<module>';
  nodes.set(mainKey, main);
  const ensureNode = (loc: MomentLocation, key: string, step: number): NodeDraft => {
    let d = nodes.get(key);
    if (d) return d;
    if (key.startsWith('pkg:')) {
      d = draft(key, 'package', key.slice(4), step);
      d.package = key.slice(4);
    } else {
      const isModule = loc.function === '<module>';
      d = draft(key, isModule ? 'module' : 'function', isModule ? displayPath(loc.file, root) : loc.function, step);
      d.file = loc.file;
      d.line = loc.line;
      d.fileId = loc.fileId;
      d.function = loc.function;
      if (!user(loc.file)) d.package = libraryPackage(loc.file) ?? '?';
    }
    nodes.set(key, d);
    return d;
  };

  const decisions = new Map<string, DecisionDraft>();
  const momentNode = new Map<Moment, string>();
  const callerOf = new Map<Moment, string | undefined>();
  const callIntents: { m: Moment; from: string | undefined; to: string }[] = [];
  /** value, print and error moments with the node of their function; the statement pass re-homes them */
  const located: { m: Moment; key: string }[] = [];

  for (const m of w.moments) {
    if (m.kind === 'call' || m.kind === 'tool') {
      if (!m.callee) continue;
      const calleeKey = keyOf(m.callee);
      if (!calleeKey) continue;
      const node = ensureNode(m.callee, calleeKey, m.step);
      let callerKey: string | undefined;
      if (m.kind === 'tool') {
        const s = m.scopeId !== undefined ? trace.scope(m.scopeId) : undefined;
        const callerId = m.callerScopeId ?? s?.parent;
        const p = callerId !== undefined ? trace.scope(callerId) : undefined;
        callerKey = p ? scopeKey(p) : undefined;
      } else callerKey = keyOf(m.location);
      callerOf.set(m, callerKey);
      momentNode.set(m, calleeKey);
      if (node.kind !== 'package' || callerKey !== calleeKey) node.calls.push(m);
      if (callerKey !== undefined && !(callerKey === calleeKey && node.kind === 'package')) callIntents.push({ m, from: callerKey, to: calleeKey });
    } else if (m.kind === 'decision') {
      const parentKey = keyOf(m.location);
      if (!parentKey) continue;
      const loop = m.count !== undefined;
      const sep = loop ? ' ran ' : ' took ';
      const i = m.text.indexOf(sep);
      const label = i >= 0 ? m.text.slice(0, i) : m.text;
      const taken = loop || i < 0 ? undefined : m.text.slice(i + sep.length);
      const key = `dec:${m.location.fileId}:${m.location.line}`;
      let d = decisions.get(key);
      if (!d) {
        const names = decisionNames(builder.fileMapOf(m.location.fileId), m.location.line);
        d = { key, parentKey, label, file: m.location.file, line: m.location.line, fileId: m.location.fileId, text: m.text, firstStep: m.step, hits: 0, loop, takens: new Set(), rows: m.values.filter((v) => v.role === 'took').map((v) => ({ kind: 'took', name: v.name, text: v.text, step: m.step })), targets: names.targets, reads: names.reads };
        if (taken !== undefined) d.taken = taken;
        decisions.set(key, d);
      }
      d.hits += loop ? (m.count ?? 0) : 1;
      if (taken !== undefined) d.takens.add(taken);
      momentNode.set(m, key);
    } else if (m.kind === 'value' || m.kind === 'print' || m.kind === 'error') {
      const key = keyOf(m.location);
      if (!key) continue;
      momentNode.set(m, key);
      located.push({ m, key });
    } else momentNode.set(m, mainKey);
  }

  /* ----- statements (rules S1, S2, S3, S7) ----- */
  let statements = new Map<string, StatementDraft>();
  if (withStatements) {
    let window: [number, number][] | undefined;
    if (opts.scope !== undefined) {
      const scope = opts.scope;
      window = trace.scopes.filter((s) => s.name === scope || builder.scopeQualname(s.scopeId).endsWith(scope)).map((s) => [s.first, s.last]);
    }
    const collected = collectStatements(inputs, { user: (fileId) => user(files.get(fileId)?.path), scopeKey, hasNode: (key) => nodes.has(key), window });
    statements = collected.statements;
    if (collected.truncated) truncated = true;
  }
  const statementAt = (loc: MomentLocation): StatementDraft | undefined => statements.get(statementKey(loc.fileId, loc.line));

  /* ----- rows (rule 5, S4) ----- */
  for (const d of nodes.values()) {
    const first = d.calls[0];
    if (first && d !== main) {
      for (const v of first.values) {
        if (v.role === 'in') d.callRows.push({ kind: 'in', name: v.name, text: v.text, step: first.entryStep ?? first.step });
        else if (v.role === 'out' && v.name === 'raised') d.callRows.push({ kind: 'raised', ...splitRaised(v.text), step: first.endStep ?? first.step });
        else if (v.role === 'out') d.callRows.push({ kind: 'out', name: v.name, text: v.text, step: first.endStep ?? first.step });
      }
    }
  }
  for (const { m, key } of located) {
    const st = statementAt(m.location);
    if (st) {
      momentNode.set(m, st.key);
      if (m.kind === 'value') {
        const v = m.values[0];
        if (v && !st.rows.some((r) => r.kind === 'out')) st.rows.push({ kind: 'out', name: v.name, text: v.text, step: m.step });
      } else if (m.kind === 'print') {
        if (!st.rows.some((r) => r.kind === 'print')) st.rows.push({ kind: 'print', ...parsePrint(m.text), step: m.step });
      } else st.rows.push({ kind: 'raised', ...parseRaised(m.text), step: m.step });
    } else if (m.kind === 'error') {
      const parsed = parseRaised(m.text);
      nodes.get(key)?.errorRows.push({ kind: 'raised', name: parsed.name, text: parsed.text, step: m.step });
    }
  }
  const finish = (rows: GraphRow[]): GraphRow[] => {
    const r = finishRows(rows);
    if (r.truncated) truncated = true;
    return r.rows;
  };
  for (const d of nodes.values()) d.rows = finish([...d.callRows, ...d.errorRows]);
  for (const d of decisions.values()) d.rows = finish(d.rows);
  for (const d of statements.values()) d.rows = finish(d.rows);

  /* ----- call edges (rule 7, S5) ----- */
  const callEdges = new Map<string, CallEdgeDraft>();
  const edgeOf = new Map<Moment, CallEdgeDraft>();
  for (const { m, from: callerKey, to } of callIntents) {
    const site = m.kind === 'call' ? statementAt(m.location) : undefined;
    const from = site ? site.key : callerKey;
    if (from === undefined || !(nodes.has(from) || statements.has(from))) continue;
    const k = `${from} ${to} ${m.kind}`;
    let e = callEdges.get(k);
    if (!e) {
      e = { from, to, kind: m.kind as 'call' | 'tool', moments: [] };
      callEdges.set(k, e);
    }
    e.moments.push(m);
    edgeOf.set(m, e);
  }

  /* ----- data edges (rule 8: a call's out into another call's in) ----- */
  const dataEdges = new Map<string, DataEdgeDraft>();
  const addDataEdge = (e: DataEdgeDraft): void => {
    const k = `${e.from} ${e.to} ${e.label}`;
    if (!dataEdges.has(k)) dataEdges.set(k, e);
  };
  for (const e of callDataEdges(w.moments, { trace, momentNode, callerOf, keyOf, hasNode: (key) => nodes.has(key) })) addDataEdge(e);

  /* ----- data edges from statements (rule S6) ----- */
  if (statements.size) {
    const consumers = [...[...statements.values()].map((s) => ({ key: s.key, parentKey: s.parentKey, firstStep: s.firstStep, reads: s.reads })), ...[...decisions.values()].map((d) => ({ key: d.key, parentKey: d.parentKey, firstStep: d.firstStep, reads: d.reads }))];
    const producerDrafts = [...[...statements.values()].map((s) => ({ key: s.key, parentKey: s.parentKey, firstStep: s.firstStep, targets: s.targets })), ...[...decisions.values()].filter((d) => d.loop).map((d) => ({ key: d.key, parentKey: d.parentKey, firstStep: d.firstStep, targets: d.targets }))];
    const parentIn = (parentKey: string, name: string): boolean => {
      const p = nodes.get(parentKey);
      return !!p && p.kind === 'function' && p.rows.some((r) => r.kind === 'in' && r.name === name);
    };
    for (const e of statementDataEdges(consumers, producerDrafts, parentIn)) addDataEdge(e);
  }

  /* ----- the cap (rule 9) ----- */
  let capped = false;
  const dropped = new Map<string, string>();
  const countable = [...nodes.values()];
  if (countable.length > cap) {
    capped = true;
    const keep = new Set<string>();
    for (const d of countable) if (d.kind !== 'function') keep.add(d.key);
    for (const dec of decisions.values()) if (nodes.has(dec.parentKey)) keep.add(dec.parentKey);
    const fns = countable.filter((d) => d.kind === 'function' && !keep.has(d.key)).sort((a, b) => b.calls.length - a.calls.length || a.firstStep - b.firstStep);
    for (const f of fns) {
      if (keep.size >= cap) break;
      keep.add(f.key);
    }
    const placeholders = new Map<string, NodeDraft>();
    for (const d of countable) {
      if (keep.has(d.key)) continue;
      const pkey = `more:${d.fileId}`;
      let p = placeholders.get(pkey);
      if (!p) {
        p = draft(pkey, 'package', '', d.firstStep);
        p.file = d.file;
        p.fileId = d.fileId;
        p.more = 0;
        p.droppedCalls = 0;
        placeholders.set(pkey, p);
      }
      p.more! += 1;
      p.droppedCalls! += d.calls.length;
      p.firstStep = Math.min(p.firstStep, d.firstStep);
      dropped.set(d.key, pkey);
      nodes.delete(d.key);
    }
    for (const p of placeholders.values()) {
      p.label = `${p.more} more function${p.more === 1 ? '' : 's'}`;
      nodes.set(p.key, p);
    }
  }
  for (const [k, d] of [...decisions]) if (!nodes.has(d.parentKey)) decisions.delete(k);
  for (const [k, s] of [...statements]) if (!nodes.has(s.parentKey)) statements.delete(k);
  const alive = (key: string): boolean => nodes.has(key) || decisions.has(key) || statements.has(key);
  for (const [k, e] of [...callEdges]) if (!alive(e.from) || !alive(e.to)) callEdges.delete(k);
  for (const [k, e] of [...dataEdges]) if (!alive(e.from) || !alive(e.to)) dataEdges.delete(k);

  /* ----- ordering and ids (rule 10, S8) ----- */
  type Sortable = { key: string; firstStep: number; rank: number; label: string };
  const order: Sortable[] = [
    ...[...nodes.values()].map((d) => ({ key: d.key, firstStep: d.firstStep, rank: NODE_RANK[d.kind]!, label: d.label })),
    ...[...decisions.values()].map((d) => ({ key: d.key, firstStep: d.firstStep, rank: NODE_RANK['decision']!, label: d.label })),
    ...[...statements.values()].map((s) => ({ key: s.key, firstStep: s.firstStep, rank: NODE_RANK['statement']!, label: s.label })),
  ];
  order.sort((a, b) => a.firstStep - b.firstStep || a.rank - b.rank || compareStrings(a.label, b.label));
  const nodeIds = new Map<string, string>();
  const nodeIndex = new Map<string, number>();
  order.forEach((s, i) => {
    nodeIds.set(s.key, `n${i}`);
    nodeIndex.set(s.key, i);
  });

  const scopeFirsts = trace.scopes.map((s) => s.first).sort((a, b) => a - b);
  const outNodes: GraphNode[] = order.map((s): GraphNode => {
    const dec = decisions.get(s.key);
    if (dec) {
      // assigned in the field order of the contract (rule 11); JSON keeps insertion order
      const out = { id: nodeIds.get(s.key)!, kind: 'decision', parent: nodeIds.get(dec.parentKey)!, label: dec.label, file: dec.file, line: dec.line, fileId: dec.fileId, text: dec.text } as DecisionNode;
      if (dec.taken !== undefined) out.taken = dec.taken;
      out.firstStep = dec.firstStep;
      out.hits = dec.hits;
      out.notRun = notRun(builder, dec);
      out.rows = dec.rows;
      return out;
    }
    const st = statements.get(s.key);
    if (st) {
      const out: StatementNode = { id: nodeIds.get(s.key)!, kind: 'statement', parent: nodeIds.get(st.parentKey)!, label: st.label, file: st.file, line: st.line, fileId: st.fileId, text: st.text, targets: st.targets, reads: st.reads, firstStep: st.firstStep, hits: st.hits, rows: st.rows };
      return out;
    }
    const d = nodes.get(s.key)!;
    const out = { id: nodeIds.get(s.key)!, kind: d.kind, label: d.label } as CallNode;
    if (d.file !== undefined) out.file = d.file;
    if (d.line !== undefined) out.line = d.line;
    if (d.fileId !== undefined) out.fileId = d.fileId;
    if (d.function !== undefined) out.function = d.function;
    if (d.package !== undefined) out.package = d.package;
    if (d === main) {
      out.calls = 1;
      out.firstStep = 0;
      out.spans = [[0, w.count - 1]];
    } else if (d.more !== undefined) {
      out.calls = d.droppedCalls ?? 0;
      out.firstStep = d.firstStep;
      out.spans = [];
    } else {
      out.calls = d.calls.length;
      out.firstStep = d.calls[0]?.step ?? d.firstStep;
      const spans = d.calls.map((m): [number, number] => [m.entryStep ?? m.step, m.endStep ?? m.step]);
      if (spans.length > SPANS_MAX) truncated = true;
      out.spans = spans.slice(0, SPANS_MAX);
    }
    out.rows = d.rows;
    if (d.kind === 'package' && d.more === undefined) {
      let nested = 0;
      for (const m of d.calls) nested += upperBound(scopeFirsts, m.endStep ?? m.step) - upperBound(scopeFirsts, m.entryStep ?? m.step);
      out.nested = nested;
    }
    if (d.more !== undefined) out.more = d.more;
    return out;
  });

  type EdgeSortable = { firstStep: number; rank: number; from: number; to: number; label: string; build: (id: string) => GraphEdge };
  const edgeOrder: EdgeSortable[] = [];
  const edgeIdOf = new Map<CallEdgeDraft, string>();
  for (const e of callEdges.values()) {
    const steps = e.moments.map((m) => m.step);
    if (steps.length > STEPS_MAX) truncated = true;
    edgeOrder.push({
      firstStep: steps[0]!,
      rank: EDGE_RANK[e.kind]!,
      from: nodeIndex.get(e.from)!,
      to: nodeIndex.get(e.to)!,
      label: '',
      build: (id) => {
        edgeIdOf.set(e, id);
        const out: CallEdge = { id, from: nodeIds.get(e.from)!, to: nodeIds.get(e.to)!, kind: e.kind, count: e.moments.length, firstStep: steps[0]!, steps: steps.slice(0, STEPS_MAX), momentIds: e.moments.map((m) => m.id) };
        return out;
      },
    });
  }
  const dataOrder: EdgeSortable[] = [];
  for (const e of dataEdges.values()) {
    dataOrder.push({
      firstStep: e.firstStep,
      rank: EDGE_RANK['data']!,
      from: nodeIndex.get(e.from)!,
      to: nodeIndex.get(e.to)!,
      label: e.label,
      build: (id) => {
        const out: DataEdge = { id, from: nodeIds.get(e.from)!, to: nodeIds.get(e.to)!, kind: 'data', label: e.label, firstStep: e.firstStep };
        return out;
      },
    });
  }
  const byEdgeOrder = (a: EdgeSortable, b: EdgeSortable): number => a.firstStep - b.firstStep || a.rank - b.rank || a.from - b.from || a.to - b.to || compareStrings(a.label, b.label);
  dataOrder.sort(byEdgeOrder);
  if (dataOrder.length > DATA_EDGES_MAX) truncated = true;
  edgeOrder.push(...dataOrder.slice(0, DATA_EDGES_MAX));
  edgeOrder.sort(byEdgeOrder);
  const outEdges = edgeOrder.map((e, i) => e.build(`e${i}`));

  const moments: GraphMomentRef[] = [];
  for (const m of w.moments) {
    const key = momentNode.get(m);
    const id = key !== undefined ? nodeIds.get(key) : undefined;
    if (!id) continue;
    const ref: GraphMomentRef = { id: m.id, kind: m.kind, step: m.step, nodeId: id };
    const e = edgeOf.get(m);
    const edgeId = e ? edgeIdOf.get(e) : undefined;
    if (edgeId) ref.edgeId = edgeId;
    moments.push(ref);
  }

  const scopes: Record<string, string> = {};
  for (const s of [...trace.scopes].sort((a, b) => a.scopeId - b.scopeId)) {
    let key = scopeKey(s);
    if (key !== undefined && dropped.has(key)) key = dropped.get(key);
    const id = key !== undefined ? nodeIds.get(key) : undefined;
    if (id) scopes[String(s.scopeId)] = id;
  }

  return { count: w.count, nodes: outNodes, edges: outEdges, moments, scopes, capped, truncated };
}
