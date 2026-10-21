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
import { MAX_LOCALS_ENTRIES, PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH, PROVENANCE_NODES, type LogEvent, type Provenance, type ProvenanceArgument, type ProvenanceCall, type ProvenanceFirstAssigned, type ProvenanceNode, type StatementBinding, type TraceScope, type WhyPiece } from '../shared/protocol';
import { MomentBuilder } from './moments';
import { className, instanceClass, parameterArgument } from './parameterArgument';
import { History, type ValueRecord } from './variableHistory';
import type { WalkthroughInputs } from './walkthroughShared';
import { provenanceConclusion } from '../shared/provenanceText';
import { summarize } from '../shared/whySummary';
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
        const reads = this.history.readNames(node.step);
        const passed = this.argument(node);
        if (passed) node.argument = passed.argument; // a parameter: the argument the call passed, whose names are its reads
        if (this.count + reads.length + (passed?.names.length ?? 0) > budget) {
          node.cut = true;
          this.truncated = true;
          continue;
        }
        this.expand(node, reads);
        if (passed) {
          const recorded = this.history.recordedReads(passed.argument.step);
          node.reads!.push(...passed.names.map((n) => this.resolve(n, passed.argument.step, passed.scopeId, passed.fileId, recorded)));
        }
        // a name read from itself, or a loop variable, resolves to the statement itself: the walk ends there
        for (const r of node.reads ?? []) if (r.step !== undefined && r.step < node.step) next.push(r);
      }
      level = next;
    }
    const out: Provenance = { name, step: q.step, depth, nodes: this.count, truncated: this.truncated, recordedLocals: this.history.recordedLocals, root };
    out.conclusion = provenanceConclusion(out); // the answer in words (provenanceText.ts); '' when nothing was recorded
    const follow = this.history.followedObjects; // the recording followed objects (some change is exact)
    if (follow) out.followObjects = true;
    const summary = summarize(out, follow, this.cappedBefore(q.step)); // the state and its sentences (whySummary.ts), each checked against the tree
    if (summary) out.summary = summary;
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
    if (!name) return this.label(this.place({ name: '' }, step), this.history.recordedReads(step)); // the statement itself: exact when its reads were recorded
    const rows = this.history.changesAt(name, step);
    const row = rows.find((r) => r.name === name) ?? rows[0];
    if (row) {
      const node: ProvenanceNode = { name: row.name, source: row.source };
      if (row.text !== undefined) node.text = row.text;
      const logId = row.logId ?? this.history.logFor(step, row.name);
      if (logId) node.logId = logId;
      if (row.unchanged) node.unchanged = true;
      if (row.shared) node.shared = row.shared;
      return this.label(this.place(node, step), row.source === 'locals' && this.history.exactChange(step, row.name));
    }
    const loc = trace.location(step);
    const scopeId = trace.scopeId(step);
    let v = this.history.valueAt(name, step, scopeId, loc?.fileId ?? -1);
    if (v.step === undefined && name.includes('.')) v = this.history.valueAt(name.split('.')[0]!, step, scopeId, loc?.fileId ?? -1);
    return v.step === undefined ? this.notYet(name, step, scopeId, loc?.fileId ?? -1) : this.label(this.fromRecord(v), !!v.exact);
  }

  /** `node` with its `resolution` when it has a step (docs/PROTOCOL.md, "Provenance"). */
  private label(node: ProvenanceNode, exact: boolean): ProvenanceNode {
    if (node.step !== undefined) node.resolution = exact ? 'seen' : 'guessed';
    return node;
  }

  /**
   * A root name with no value at `step`. A later assignment in its scope (or its module) says it has
   * none yet only when every earlier value would have been seen: locals recorded from the program's
   * start, under the recorder's cap. Otherwise an earlier value may only have gone unrecorded: a run
   * without locals answers the leaf, and a recording that began at a pause names the later assignment
   * without ruling out a value made before step 0 (`beforeRecording` with `firstAssigned`).
   */
  private notYet(name: string, step: number, scopeId: number, fileId: number): ProvenanceNode {
    let later = this.history.firstChangeAfter(name, step, scopeId, fileId);
    if (!later && name.includes('.')) later = this.history.firstChangeAfter(name.split('.')[0]!, step, scopeId, fileId);
    if (!later || !this.history.recordedLocals || this.cappedBefore(step)) return this.leaf(name);
    const first: ProvenanceFirstAssigned = { step: later.step, ...this.history.location(later.step) };
    const statement = this.statement(later.step);
    if (statement !== undefined) first.statement = statement;
    return this.inputs.midRun ? { name: later.name, beforeRecording: true, firstAssigned: first } : { name: later.name, firstAssigned: first };
  }

  /** The recorder keeps no changes past its cap, so a step after the last one it kept was not observed. */
  private cappedBefore(step: number): boolean {
    const locals = this.inputs.locals;
    return locals.length >= MAX_LOCALS_ENTRIES && locals[locals.length - 1]!.step < step;
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
    const recorded = this.history.recordedReads(step);
    node.reads = reads.map((n) => this.resolve(n, step, scopeId, loc?.fileId ?? -1, recorded));
    const called = this.callsAt(step, scopeId);
    node.calls = called.map((s) => this.call(s, step));
    node.opaque = this.opaque(this.history.bindingAt(step)?.calls ?? [], called);
  }

  /** A read of the statement: the latest value recorded for the name before the step, placed at the statement that made it. */
  private resolve(name: string, step: number, scopeId: number, fileId: number, recorded: boolean): ProvenanceNode {
    this.count++;
    const v = this.history.valueAt(name, step, scopeId, fileId);
    return this.label(this.fromRecord(v), recorded && !!v.exact);
  }

  /**
   * A node for what `valueAt` found: a leaf when nothing was recorded, else the producing statement. A function
   * or class has a value and no step; its node is placed at the `def` or `class` that made it (`defined`).
   */
  private fromRecord(v: ValueRecord): ProvenanceNode {
    if (v.step === undefined && v.text === undefined) return this.leaf(v.name);
    const node: ProvenanceNode = { name: v.name };
    if (v.text !== undefined) node.text = v.text;
    if (v.step === undefined) {
      if (v.source) node.source = v.source;
      if (v.defined) Object.assign(node, { file: v.defined.file, fileId: v.defined.fileId, line: v.defined.line, defined: true });
      return node;
    }
    node.source = v.source;
    if (v.logId) node.logId = v.logId;
    if (v.shared) node.shared = v.shared;
    return this.place(node, v.step);
  }

  /**
   * For a parameter (a node at the `def` header that entered its function): where the call passed it and the names that
   * argument read there, resolved at the call site like a statement's reads. Undefined when the node is not a parameter
   * or the call site does not say which argument it was (`parameterArgument`).
   */
  private argument(node: ProvenanceNode): { argument: ProvenanceArgument; names: string[]; scopeId: number; fileId: number } | undefined {
    const trace = this.inputs.trace;
    const step = node.step!;
    const scope = trace.scope(trace.scopeId(step));
    if (!node.name || !scope || scope.first !== step || scope.parent < 0) return undefined;
    const def = this.history.bindingAt(step);
    if (!def?.params || !def.assigns.includes(node.name)) return undefined;
    const site = this.moments.callSite(scope);
    const loc = trace.location(site);
    if (site >= step || !loc || trace.scopeId(site) !== scope.parent) return undefined;
    const valueOf = (text: string): string | undefined => this.history.valueAt(text, site, scope.parent, loc.fileId).text;
    const calls = this.history.bindingAt(site)?.args ?? [];
    // the times this statement entered this function, in entry order: which call this one was
    const same = (this.children.get(scope.parent) ?? []).filter((s) => s.rid === scope.rid && this.moments.callSite(s) === site);
    let made: string | undefined;
    if ((scope.name === '__init__' || scope.name === '__new__') && def.params.positional.length) {
      const first = this.root(def.params.positional[0]!, step); // self (cls for __new__), as recorded at the entry
      made = (scope.name === '__new__' ? className : instanceClass)(first.text ?? '');
    }
    const arg = parameterArgument(node.name, scope.name, def.params, calls, valueOf, made, same.indexOf(scope), same.length);
    if (!arg) return undefined;
    const argument: ProvenanceArgument = { text: arg.text, step: site, ...this.history.location(site) };
    const statement = this.statement(site);
    if (statement !== undefined) argument.statement = statement;
    return { argument, names: arg.names, scopeId: scope.parent, fileId: loc.fileId };
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

/** The tree with display paths on every node, call, first assignment, argument and shared holding; the wire shape carries absolute ones. The panel host (views/whyPane.ts) and the browser bridge (web/panes.ts) both send it. */
export function withDisplayPaths(tree: Provenance, displayPath: (fileId: number) => string): Provenance {
  const node = (n: ProvenanceNode): ProvenanceNode => ({
    ...n,
    ...(n.fileId !== undefined ? { file: displayPath(n.fileId) } : {}),
    ...(n.firstAssigned?.fileId !== undefined ? { firstAssigned: { ...n.firstAssigned, file: displayPath(n.firstAssigned.fileId) } } : {}),
    ...(n.argument?.fileId !== undefined ? { argument: { ...n.argument, file: displayPath(n.argument.fileId) } } : {}),
    ...(n.shared?.fileId !== undefined ? { shared: { ...n.shared, file: displayPath(n.shared.fileId) } } : {}),
    ...(n.reads ? { reads: n.reads.map(node) } : {}),
    ...(n.calls ? { calls: n.calls.map((c) => ({ ...c, file: displayPath(c.fileId) })) } : {}),
  });
  const piece = (p: WhyPiece): WhyPiece => (p.fileId !== undefined ? { ...p, file: displayPath(p.fileId) } : p);
  const summary = tree.summary ? { ...tree.summary, headline: tree.summary.headline.map(piece), details: tree.summary.details.map((d) => d.map(piece)) } : undefined;
  return { ...tree, root: node(tree.root), ...(summary ? { summary } : {}) };
}
