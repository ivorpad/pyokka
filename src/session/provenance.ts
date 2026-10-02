/**
 * Provenance: the tree of what produced one value (docs/PROTOCOL.md, "Provenance"). Pure: the
 * walkthrough's inputs plus the statement bindings and the log entries by range id; nothing
 * here touches vscode. The Python twin is `python/pyokka_runtime/agent/provenance.py`; keep the
 * rules identical (`test/unit/fixtures/provenance.json` pins both to one program).
 *
 * The root is the value a name had after a step (the change `var` lists there), else the value
 * it had when the step ran, else a leaf. A node with a step carries its producing statement and,
 * when expanded, that statement's inputs: the names it read (each resolved like `var`'s reads and
 * expanded in turn while its step is earlier than its parent's), the functions it called whose
 * body was stepped (the walkthrough's call rules, from `MomentBuilder`) and the calls no stepped
 * scope claimed. Expansion is breadth-first under a depth and a node budget.
 */
import { PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH, PROVENANCE_NODES, type LogEvent, type Provenance, type ProvenanceCall, type ProvenanceNode, type StatementBinding, type TraceScope } from '../shared/protocol';
import { MomentBuilder } from './moments';
import { History, VAR_READS, type ValueRecord } from './variableHistory';
import type { WalkthroughInputs } from './walkthroughShared';
import { provenanceConclusion } from '../shared/provenanceText';
import type { TraceModel } from '../timeMachine/traceModel';

export interface ProvenanceInputs extends WalkthroughInputs {
  entriesByRid: ReadonlyMap<number, LogEvent[]>;
  /** statement bindings by global range id, per file; a file missing here has no reads and no opaque calls */
  bindings: ReadonlyMap<number, ReadonlyMap<number, StatementBinding>>;
  mainFileId?: number;
  /** the recording began at a pause (`recordFrom`): a name with nothing recorded was made before step 0 */
  midRun?: boolean;
}

export interface ProvenanceQuery {
  step: number;
  /** empty or absent: the statement at `step` itself */
  name?: string;
  /** levels below the root to expand, clamped to 1..PROVENANCE_MAX_DEPTH */
  depth?: number;
  /** the node budget (tests); PROVENANCE_NODES otherwise */
  nodes?: number;
}

/** calls of one statement listed at most, and inputs per call */
export const PROVENANCE_CALLS = 8;
export const PROVENANCE_INPUTS = 8;

/** The callee of a call's source text: the last dotted name before the parenthesis (`describe` for `helper.describe(x)`). */
export function calleeOf(text: string): string {
  const head = text.split('(', 1)[0]!.trim();
  return head.split('.').pop()!.trim();
}

class ProvenanceBuilder {
  private readonly history: History;
  private readonly moments: MomentBuilder;
  /** scopes by parent, in entry order */
  private readonly children = new Map<number, TraceScope[]>();
  private readonly sources = new Map<number, string[] | undefined>();
  private count = 0;
  private truncated = false;

  constructor(private readonly inputs: ProvenanceInputs) {
    const { trace, files, entriesByRid, locals, bindings, mainFileId } = inputs;
    this.history = new History({ trace, files, entriesByRid, locals, bindings, mainFileId });
    this.moments = new MomentBuilder(inputs, true);
    for (const s of trace.scopes) {
      if (s.parent < 0) continue;
      let list = this.children.get(s.parent);
      if (!list) this.children.set(s.parent, (list = []));
      list.push(s);
    }
    for (const list of this.children.values()) list.sort((a, b) => a.first - b.first);
  }

  build(q: ProvenanceQuery): Provenance {
    const depth = Math.max(1, Math.min(PROVENANCE_MAX_DEPTH, q.depth ?? PROVENANCE_DEPTH));
    const budget = q.nodes ?? PROVENANCE_NODES;
    const name = (q.name ?? '').trim();
    const root = this.root(name, q.step);
    this.count = 1;
    let level: ProvenanceNode[] = [root];
    for (let d = 0; level.length; d++) {
      const next: ProvenanceNode[] = [];
      for (const node of level) {
        if (node.step === undefined) continue; // a leaf: nothing recorded
        if (d >= depth) {
          node.cut = true;
          continue;
        }
        const reads = this.history.bindingAt(node.step)?.reads.slice(0, VAR_READS) ?? [];
        if (this.count + reads.length > budget) {
          node.cut = true;
          this.truncated = true;
          continue;
        }
        this.expand(node, reads);
        // a name read from itself, or a loop variable, resolves to the statement itself: the walk ends there
        for (const r of node.reads ?? []) if (r.step !== undefined && r.step < node.step) next.push(r);
      }
      level = next;
    }
    const out: Provenance = { name, step: q.step, depth, nodes: this.count, truncated: this.truncated, recordedLocals: this.history.recordedLocals, root };
    out.conclusion = provenanceConclusion(out); // the answer in words (provenanceText.ts); '' when nothing was recorded
    return out;
  }

  /* ----- the root ----- */

  /**
   * The change `var` lists at `step` (the exact name first), else the value the name had when `step`
   * ran, else a leaf; a dotted name nothing recorded retries its first segment by the read rule.
   */
  private root(name: string, step: number): ProvenanceNode {
    const trace = this.inputs.trace;
    if (!trace.valid(step)) return { name };
    if (!name) return this.place({ name: '' }, step);
    const rows = this.history.changesAt(name, step);
    const row = rows.find((r) => r.name === name) ?? rows[0];
    if (row) {
      const node: ProvenanceNode = { name: row.name, source: row.source };
      if (row.text !== undefined) node.text = row.text;
      const logId = row.logId ?? this.history.logFor(step, row.name);
      if (logId) node.logId = logId;
      if (row.unchanged) node.unchanged = true;
      return this.place(node, step);
    }
    const loc = trace.location(step);
    const scopeId = trace.scopeId(step);
    let v = this.history.valueAt(name, step, scopeId, loc?.fileId ?? -1);
    if (v.step === undefined && name.includes('.')) v = this.history.valueAt(name.split('.')[0]!, step, scopeId, loc?.fileId ?? -1);
    return v.step === undefined ? this.leaf(name) : this.fromRecord(v);
  }

  /* ----- nodes ----- */

  /** Nothing recorded for the name. In a recording that began mid-run that is where the chain ends: at step 0. */
  private leaf(name: string): ProvenanceNode {
    return this.inputs.midRun ? { name, beforeRecording: true } : { name };
  }

  /** Give a node its producing statement: the step, its location and its first source line. */
  private place(node: ProvenanceNode, step: number): ProvenanceNode {
    node.step = step;
    Object.assign(node, this.history.location(step));
    const statement = this.statement(step);
    if (statement !== undefined) node.statement = statement;
    return node;
  }

  private statement(step: number): string | undefined {
    const loc = this.inputs.trace.location(step);
    if (!loc) return undefined;
    if (!this.sources.has(loc.fileId)) this.sources.set(loc.fileId, this.inputs.readSource(loc.fileId));
    const line = this.sources.get(loc.fileId)?.[loc.range[0] - 1];
    if (line === undefined) return undefined;
    return line.trim() + (loc.range[2] > loc.range[0] ? ' …' : '');
  }

  private expand(node: ProvenanceNode, reads: string[]): void {
    const step = node.step!;
    const trace = this.inputs.trace;
    const loc = trace.location(step);
    const scopeId = trace.scopeId(step);
    node.reads = reads.map((n) => this.resolve(n, step, scopeId, loc?.fileId ?? -1));
    const called = this.callsAt(step, scopeId);
    node.calls = called.map((s) => this.call(s, step));
    node.opaque = this.opaque(this.history.bindingAt(step)?.calls ?? [], called);
  }

  /** A read of the statement: the latest value recorded for the name before the step, placed at the statement that made it. */
  private resolve(name: string, step: number, scopeId: number, fileId: number): ProvenanceNode {
    this.count++;
    return this.fromRecord(this.history.valueAt(name, step, scopeId, fileId));
  }

  /** A node for what `valueAt` found: a leaf when nothing was recorded, else the producing statement. */
  private fromRecord(v: ValueRecord): ProvenanceNode {
    if (v.step === undefined && v.text === undefined) return this.leaf(v.name);
    const node: ProvenanceNode = { name: v.name };
    if (v.step === undefined) return node;
    if (v.text !== undefined) node.text = v.text;
    node.source = v.source;
    if (v.logId) node.logId = v.logId;
    return this.place(node, v.step);
  }

  /* ----- calls ----- */

  /** The scopes the statement at `step` entered: children of its scope whose call site is the step, in entry order. */
  private callsAt(step: number, scopeId: number): TraceScope[] {
    const out: TraceScope[] = [];
    for (const s of this.children.get(scopeId) ?? []) {
      if (s.first <= step) continue;
      const site = this.moments.callSite(s);
      if (site > step) break; // call sites grow with the entry step
      if (site === step) out.push(s);
      if (out.length === PROVENANCE_CALLS) break;
    }
    return out;
  }

  private call(s: TraceScope, site: number): ProvenanceCall {
    const files = this.inputs.files;
    const def = files.locate(s.rid);
    this.moments.consumed.clear(); // params and result mark the entries they use; every call node stands alone
    const out: ProvenanceCall = {
      name: s.name,
      scopeId: s.scopeId,
      entryStep: s.first,
      returnStep: s.last,
      file: def ? files.get(def.fileId)?.path ?? '' : '',
      fileId: def?.fileId ?? -1,
      line: def?.range[0] ?? 0,
      inputs: this.moments
        .params(s)
        .slice(0, PROVENANCE_INPUTS)
        .map((v) => ({ name: v.name, text: v.text })),
    };
    const result = this.moments.result(s, site, s.last)[0];
    if (result) out.result = result.text;
    return out;
  }

  /** The statement's calls per the AST that no stepped scope claimed: a scope takes the first unclaimed text whose callee is its name (a class name, for `__init__`). */
  private opaque(texts: readonly string[], scopes: readonly TraceScope[]): string[] {
    const claimed = new Set<number>();
    for (const s of scopes) {
      const i = texts.findIndex((t, n) => {
        if (claimed.has(n)) return false;
        const callee = calleeOf(t);
        return callee === s.name || (s.name === '__init__' && /^[A-Z]/.test(callee));
      });
      if (i >= 0) claimed.add(i);
    }
    return texts.filter((_, n) => !claimed.has(n));
  }
}

/** Why `name` had its value after `step` (docs/PROTOCOL.md, "Provenance"); an empty name explains the statement at `step`. */
export function provenance(inputs: ProvenanceInputs, query: ProvenanceQuery): Provenance {
  return new ProvenanceBuilder(inputs).build(query);
}

/**
 * The step of the statement that logged an entry. An entry is stamped when its statement completes,
 * which is inside the last callee the statement entered, so the statement's own step is the nearest
 * one at or before the stamp with the entry's range; the stamp itself when none has it (a live entry).
 */
export function stepOfEntry(trace: TraceModel, entry: { step: number; rid: number }): number {
  for (let j = Math.min(entry.step, trace.count - 1); j >= 0; j--) if (trace.rid(j) === entry.rid) return j;
  return entry.step;
}
