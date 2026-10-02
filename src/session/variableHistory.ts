/**
 * Variable history: every recorded change of one name, in step order (docs/PROTOCOL.md,
 * "Variable history"). Pure: takes the run's trace, file table, log entries, recorded locals
 * and the statement bindings fetched from the runner; nothing here touches vscode. The Python
 * twin is `python/pyokka_runtime/agent/history.py`; keep the rules identical.
 *
 * Three sources, in order of trust: recorded locals (`recordLocals`), logged values whose
 * context is the name (`# ?`, Auto Log, identifier statements), and the statements that
 * assign the name (bindings from the AST) when nothing recorded the value.
 *
 * A locals entry at step S is the state at the *start* of S, so a change it reports was made
 * by the scope's previous step; when that statement binds the name the change is attributed
 * to it, which is where the Time Machine should land. Loop headers are the exception: the
 * per-iteration step fires after the target is bound, so an iteration step owns the change
 * it observes. Each change carries `reads`: the names the statement loaded, with the latest
 * value recorded for each before the step, one level, so a reader can walk backwards.
 *
 * The provenance builder (provenance.ts) reuses the pieces: `History.changesAt` for its root,
 * `valueAt` for the reads it expands, `bindingAt` and `location` for the producing statement.
 */
import { MAX_LOCALS_ENTRIES, type LocalsEvent, type LogEvent, type StatementBinding, type VariableChange, type VariableChangeSource, type VariableHistory, type VariableRead } from '../shared/protocol';
import type { TraceModel } from '../timeMachine/traceModel';
import type { FileTable, InstrumentedFile } from './fileTable';

export type { VariableChange, VariableChangeSource, VariableHistory, VariableRead } from '../shared/protocol';

export const VAR_CAP = 200;
export const VAR_READS = 8;
/** log kinds that carry a variable's value under its name */
const VALUE_KINDS: ReadonlySet<string> = new Set(['value', 'autoLog', 'autoExpand']);

export interface HistoryInputs {
  trace: TraceModel;
  files: FileTable;
  entriesByRid: ReadonlyMap<number, LogEvent[]>;
  locals: readonly LocalsEvent['entries'][number][];
  /** statement bindings by global range id, per file; a file missing here has no assignment rows and no reads */
  bindings: ReadonlyMap<number, ReadonlyMap<number, StatementBinding>>;
  mainFileId?: number;
}

export interface HistoryOptions {
  /** only changes in this file */
  fileId?: number;
  /** only changes inside this function */
  scope?: string;
  limit?: number;
}

/** A value `valueAt` found: where it came from and the step of the statement that made it; `name` alone when nothing was recorded. */
export interface ValueRecord {
  name: string;
  text?: string;
  step?: number;
  source?: 'locals' | 'value';
  /** the log entry behind a `value` record, or the one the statement of a `locals` record logged for the name (`logFor`) */
  logId?: string;
}

/** The producing statement's place, as a `VariableChange` carries it. */
export type StatementLocation = Pick<VariableChange, 'file' | 'fileId' | 'line' | 'function' | 'scopeId'>;

/** The name rule: exact, or one path under the other (`acct` ~ `acct.deposit(x)`, `self` ~ `self.balance`). */
export function matchesName(candidate: string | undefined, query: string): boolean {
  if (!candidate || !query) return false;
  if (candidate === query) return true;
  for (const sep of ['.', '[']) if (candidate.startsWith(query + sep) || query.startsWith(candidate + sep)) return true;
  return false;
}

/** The repr of a function or a class: a value no statement of the run made. */
export function isDefinition(text: string | undefined): boolean {
  return !!text && (text.startsWith('<function ') || text.startsWith('<class '));
}

/** Bindings keyed by global range id, via the `(line, col)` the range table and the AST share; statements win over `def` headers at one position. */
export function indexBindings(file: InstrumentedFile, entries: readonly StatementBinding[]): Map<number, StatementBinding> {
  const byPos = new Map<string, number>();
  for (const local of [...file.functions.map((fn) => fn.rid), ...file.statements]) {
    const r = file.ranges[local];
    if (r) byPos.set(`${r[0]}:${r[1]}`, local);
  }
  const out = new Map<number, StatementBinding>();
  for (const e of entries) {
    const local = byPos.get(`${e.line}:${e.col}`);
    if (local !== undefined) out.set(file.rangeBase + local, e);
  }
  return out;
}

interface LocalRecord {
  step: number;
  scopeId: number;
  text: string;
}

export class History {
  private readonly localsByName = new Map<string, LocalRecord[]>();
  private readonly valuesByContext = new Map<string, LogEvent[]>();
  private readonly moduleScopeCache = new Map<number, Set<number>>();
  /** every step was observed, so a name with no recorded change at the next step of its scope kept its object */
  private readonly observedAll: boolean;

  constructor(private readonly inputs: HistoryInputs) {
    this.observedAll = inputs.locals.length > 0 && inputs.locals.length < MAX_LOCALS_ENTRIES;
    for (const entry of inputs.locals) {
      for (const ch of entry.changes) {
        if (!ch.name) continue;
        let list = this.localsByName.get(ch.name);
        if (!list) this.localsByName.set(ch.name, (list = []));
        list.push({ step: entry.step, scopeId: entry.scopeId, text: ch.text });
      }
    }
    for (const list of this.localsByName.values()) list.sort((a, b) => a.step - b.step);
    for (const entries of inputs.entriesByRid.values()) {
      for (const e of entries) {
        if (!e.context || !VALUE_KINDS.has(e.kind)) continue;
        let list = this.valuesByContext.get(e.context);
        if (!list) this.valuesByContext.set(e.context, (list = []));
        list.push(e);
      }
    }
    for (const list of this.valuesByContext.values()) list.sort((a, b) => a.step - b.step);
  }

  private get trace(): TraceModel {
    return this.inputs.trace;
  }

  /** The run recorded locals (`recordLocals`); without them only logged values and assignment sites are known. */
  get recordedLocals(): boolean {
    return this.inputs.locals.length > 0;
  }

  /** Scopes that are a module body of the file: scope 0 for the main file, the depth-1 module scope of an imported project file. */
  private moduleScopes(fileId: number): Set<number> {
    let out = this.moduleScopeCache.get(fileId);
    if (out) return out;
    out = new Set<number>();
    for (const s of this.trace.scopes) {
      const loc = this.inputs.files.locate(s.rid);
      if (loc && loc.fileId === fileId && loc.localRid === 0) out.add(s.scopeId);
    }
    if (fileId === this.inputs.mainFileId) out.add(0);
    this.moduleScopeCache.set(fileId, out);
    return out;
  }

  private previousStepInScope(step: number, scopeId: number): number {
    const first = this.trace.scope(scopeId)?.first ?? 0;
    for (let j = step - 1; j >= first && j >= 0; j--) if (this.trace.scopeId(j) === scopeId) return j;
    return -1;
  }

  private nextStepInScope(step: number, scopeId: number): number {
    const last = this.trace.scope(scopeId)?.last ?? this.trace.count - 1;
    for (let j = step + 1; j <= last && j < this.trace.count; j++) if (this.trace.scopeId(j) === scopeId) return j;
    return -1;
  }

  /** What the statement at `step` assigns and reads, when its file has bindings. */
  bindingAt(step: number): StatementBinding | undefined {
    const loc = this.trace.location(step);
    return loc ? this.inputs.bindings.get(loc.fileId)?.get(this.trace.rid(step)) : undefined;
  }

  /** A loop header step that follows a step of the loop's own lines in the same scope (not the step before the loop). */
  private isIterationStep(step: number, binding: StatementBinding): boolean {
    if (binding.loop === undefined) return false;
    const prev = this.previousStepInScope(step, this.trace.scopeId(step));
    if (prev < 0) return false;
    const here = this.trace.location(step);
    const there = this.trace.location(prev);
    return !!here && !!there && there.fileId === here.fileId && here.range[0] <= there.range[0] && there.range[0] <= binding.loop;
  }

  /** The step whose statement made the change observed at `observed`. */
  private attribute(observed: number, scopeId: number, changed: string): number {
    const own = this.bindingAt(observed);
    if (own && own.loop !== undefined && own.assigns.some((a) => matchesName(a, changed)) && this.isIterationStep(observed, own)) return observed;
    const prev = this.previousStepInScope(observed, scopeId);
    if (prev >= 0) {
      const binding = this.bindingAt(prev);
      if (binding && binding.assigns.some((a) => matchesName(a, changed))) return prev;
    }
    return observed;
  }

  /** Where the statement at `step` is: its file, line and scope, as a change row carries them. */
  location(step: number): StatementLocation {
    const loc = this.trace.location(step);
    const scopeId = this.trace.scopeId(step);
    return {
      file: loc ? this.inputs.files.get(loc.fileId)?.path ?? '' : '',
      fileId: loc?.fileId ?? -1,
      line: loc?.range[0] ?? 0,
      function: this.trace.scope(scopeId)?.name ?? '<module>',
      scopeId,
    };
  }

  /**
   * The log entry the statement at `step` wrote for `name`, when there is one. A value is logged when
   * its statement completes, so the entry's step is the last step the statement ran (inside a callee
   * when it called one): the entry whose range is the statement's, at or after the step and before
   * the scope's next step, is the statement's.
   */
  logFor(step: number, name: string): string | undefined {
    const rid = this.trace.rid(step);
    let end = this.nextStepInScope(step, this.trace.scopeId(step));
    if (end < 0) end = this.trace.count;
    let found: LogEvent | undefined;
    for (const e of this.valuesByContext.get(name) ?? []) {
      if (e.step >= end) break;
      if (e.step >= step && e.rid === rid) found = e;
    }
    return found?.logId || undefined;
  }

  private row(step: number, name: string, text: string | undefined, source: VariableChangeSource): VariableChange {
    const out: VariableChange = { step, ...this.location(step), name, source };
    if (text !== undefined) out.text = text;
    return out;
  }

  /** The latest recorded value of `name` visible at the start of `step`, from the step's scope or its module. */
  valueAt(name: string, step: number, scopeId: number, fileId: number): ValueRecord {
    const scopes = new Set(this.moduleScopes(fileId));
    scopes.add(scopeId);
    let bestStep = -1;
    let bestText: string | undefined;
    let bestScope = scopeId;
    const locals = this.localsByName.get(name) ?? [];
    for (let i = locals.length - 1; i >= 0; i--) {
      const rec = locals[i]!;
      if (rec.step > step) continue;
      if (scopes.has(rec.scopeId)) {
        bestStep = rec.step;
        bestText = rec.text;
        bestScope = rec.scopeId;
        break;
      }
    }
    let fromLocals = bestStep >= 0;
    let logId: string | undefined;
    const values = this.valuesByContext.get(name) ?? [];
    for (let i = values.length - 1; i >= 0; i--) {
      const e = values[i]!;
      if (e.step >= step || e.step <= bestStep) continue;
      if (scopes.has(this.trace.scopeId(e.step))) {
        bestStep = e.step;
        bestText = e.text;
        fromLocals = false;
        logId = e.logId;
        break;
      }
    }
    const out: ValueRecord = { name };
    if (bestStep < 0) return out;
    out.text = bestText;
    // a recorded local that is a definition has no producing step: `def` and `class` statements are never
    // steps, so the recorder saw the binding at whatever statement ran next
    if (fromLocals && isDefinition(bestText)) {
      out.source = 'locals';
      return out;
    }
    // the same step the change list names for it: the statement that made it
    out.step = fromLocals ? this.attribute(bestStep, bestScope, name) : bestStep;
    out.source = fromLocals ? 'locals' : 'value';
    if (fromLocals) logId = this.logFor(out.step, name);
    if (logId) out.logId = logId;
    return out;
  }

  private readsFor(step: number): VariableRead[] {
    const loc = this.trace.location(step);
    const binding = this.bindingAt(step);
    if (!loc || !binding) return [];
    const scopeId = this.trace.scopeId(step);
    return binding.reads.slice(0, VAR_READS).map((n) => {
      const v = this.valueAt(n, step, scopeId, loc.fileId);
      const read: VariableRead = { name: n };
      if (v.step !== undefined) {
        read.text = v.text;
        read.step = v.step;
      }
      return read;
    });
  }

  /** Every change row of `name` from the three sources, merged by step and matched name; unordered, without reads. */
  private rows(name: string): VariableChange[] {
    const rows = new Map<string, VariableChange>();
    const add = (row: VariableChange): void => {
      const key = `${row.step}:${row.name}`;
      const have = rows.get(key);
      if (!have) rows.set(key, row);
      else if (row.logId && !have.logId) have.logId = row.logId;
    };
    // 1. recorded locals, attributed to the statement that bound the name
    for (const entry of this.inputs.locals) {
      if (!this.trace.valid(entry.step)) continue;
      for (const ch of entry.changes) {
        if (!matchesName(ch.name, name)) continue;
        add(this.row(this.attribute(entry.step, entry.scopeId, ch.name), ch.name, ch.text, 'locals'));
      }
    }
    // 2. logged values whose context is the name (or a path under it)
    for (const [ctx, events] of this.valuesByContext) {
      if (!matchesName(ctx, name)) continue;
      for (const e of events) {
        if (!this.trace.valid(e.step)) continue;
        const row = this.row(e.step, ctx, e.text, 'value');
        row.logId = e.logId;
        add(row);
      }
    }
    // 3. statements that assign the name, where nothing recorded the value (a loop header only on its iteration steps)
    const assigning = new Map<number, { name: string; binding: StatementBinding }>();
    for (const table of this.inputs.bindings.values()) {
      for (const [rid, binding] of table) {
        const a = binding.assigns.find((x) => matchesName(x, name));
        if (a !== undefined) assigning.set(rid, { name: a, binding });
      }
    }
    if (assigning.size) {
      const stepsWithRows = new Set([...rows.values()].map((r) => r.step));
      for (let step = 0; step < this.trace.count; step++) {
        const hit = assigning.get(this.trace.rid(step));
        if (!hit || stepsWithRows.has(step)) continue;
        if (hit.binding.loop !== undefined && !this.isIterationStep(step, hit.binding)) continue;
        const row = this.row(step, hit.name, undefined, 'assign');
        // observed unchanged: the scope's next step recorded no change for the name, so it kept its object
        if (this.observedAll && hit.name === name && this.nextStepInScope(step, row.scopeId) >= 0) {
          const before = this.valueAt(hit.name, step, row.scopeId, row.fileId);
          if (before.text !== undefined) {
            row.text = before.text;
            row.unchanged = true;
          }
        }
        add(row);
      }
    }
    return [...rows.values()];
  }

  /** The rows `var` lists at `step` for `name`, in `var`'s order (by matched name); none when the statement did not change it. */
  changesAt(name: string, step: number): VariableChange[] {
    return this.rows(name)
      .filter((r) => r.step === step)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  build(name: string, opts: HistoryOptions): VariableHistory {
    let ordered = this.rows(name).sort((a, b) => a.step - b.step || a.name.localeCompare(b.name));
    if (opts.fileId !== undefined) ordered = ordered.filter((r) => r.fileId === opts.fileId);
    if (opts.scope !== undefined) ordered = ordered.filter((r) => r.function === opts.scope);
    const shown = ordered.slice(0, Math.max(1, opts.limit ?? VAR_CAP));
    for (const row of shown) {
      const reads = this.readsFor(row.step);
      if (reads.length) row.reads = reads;
    }
    return { name, changes: shown, total: ordered.length, truncated: ordered.length > shown.length, recordedLocals: this.recordedLocals };
  }
}

/** Every recorded change of `name`, ascending by step; `opts` narrow by file or function and cap the list. */
export function variableHistory(inputs: HistoryInputs, name: string, opts: HistoryOptions = {}): VariableHistory {
  return new History(inputs).build(name.trim(), opts);
}
