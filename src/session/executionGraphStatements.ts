/**
 * The statement nodes of the execution graph (docs/PROTOCOL.md, "statement"): which trace steps
 * make one, their source label, the names they assign and read, the bound per parent, and the
 * data edges from the statement (or loop) that last assigned a name to the statements and
 * decisions that read it. `executionGraph.ts` calls this; the Python builder's statement pass is
 * the same, rule for rule, so `test/unit/fixtures/execution-graph-statements.json` pins both.
 */
import type { TraceScope } from '../shared/protocol';
import { collapse } from './decisions';
import type { FileMap } from './decisions';
import { namesOf, stripCode } from './names';
import type { WalkthroughInputs } from './walkthroughShared';
import { STATEMENTS_MAX, type GraphRow } from './executionGraphTypes';

export interface StatementDraft {
  key: string;
  parentKey: string;
  label: string;
  file: string | null;
  line: number;
  fileId: number;
  text: string;
  targets: string[];
  reads: string[];
  firstStep: number;
  hits: number;
  rows: GraphRow[];
}

/** What the statement pass needs from the builder: the user-file test, the scope -> node key map, the nodes that exist. */
export interface StatementContext {
  user: (fileId: number) => boolean;
  scopeKey: (s: TraceScope) => string | undefined;
  hasNode: (key: string) => boolean;
  /** the walkthrough's scope window as step ranges; undefined without `scope` */
  window?: [number, number][];
}

export const statementKey = (fileId: number, line: number): string => `stmt:${fileId}:${line}`;

const NAME = /[A-Za-z_][A-Za-z0-9_]*/g;
const DOCSTRING = /^[rRbBfFuU]{0,2}['"]/;

/** The range's lines as `rangeText` slices them: the first from `col`, the middle whole, the last to `endCol`. */
function rangeLines(lines: string[], r: [number, number, number, number]): string[] {
  const [a, ca, b, cb] = r;
  if (a === b) return [(lines[a - 1] ?? '').slice(ca, cb)];
  return [(lines[a - 1] ?? '').slice(ca), ...lines.slice(a, b - 1), (lines[b - 1] ?? '').slice(0, cb)];
}

/**
 * Not a statement node: a compound header (the logical line, from the range's first column to the
 * end of its last line, ends with `:`), an import, `pass`/`break`/`continue`, `global`/`nonlocal`,
 * or a bare string (a docstring).
 */
function skipStatement(lines: string[], r: [number, number, number, number]): boolean {
  const [a, ca, b] = r;
  const logical = stripCode([(lines[a - 1] ?? '').slice(ca), ...lines.slice(a, b)]).trim();
  if (logical.endsWith(':')) return true;
  if (logical.startsWith('import ') || logical.startsWith('from ')) return true;
  if (logical === 'pass' || logical === 'break' || logical === 'continue') return true;
  if (logical.startsWith('global ') || logical.startsWith('nonlocal ')) return true;
  return DOCSTRING.test(logical);
}

/**
 * One draft per (file, start line) a user-code step ran (rule S1), in first-step order, bounded at
 * STATEMENTS_MAX per parent (S7); `truncated` says the bound cut some.
 */
export function collectStatements(inputs: WalkthroughInputs, ctx: StatementContext): { statements: Map<string, StatementDraft>; truncated: boolean } {
  const trace = inputs.trace;
  const files = inputs.files;
  const hitsByRid = new Map<number, number>();
  for (let i = 0; i < trace.count; i++) {
    const rid = trace.rid(i);
    hitsByRid.set(rid, (hitsByRid.get(rid) ?? 0) + 1);
  }
  const statementRids = new Map<number, Set<number>>();
  const isStatement = (fileId: number, localRid: number): boolean => {
    let set = statementRids.get(fileId);
    if (!set) {
      set = new Set(files.get(fileId)?.statements ?? []);
      statementRids.set(fileId, set);
    }
    return set.has(localRid);
  };
  const userScope = new Map<number, boolean>();
  const isUserScope = (s: TraceScope): boolean => {
    let u = userScope.get(s.scopeId);
    if (u === undefined) {
      if (s.parent < 0) u = true;
      else {
        const loc = files.locate(s.rid);
        u = !!loc && ctx.user(loc.fileId);
      }
      userScope.set(s.scopeId, u);
    }
    return u;
  };
  const sources = new Map<number, string[] | undefined>();
  const source = (fileId: number): string[] | undefined => {
    if (!sources.has(fileId)) sources.set(fileId, inputs.readSource(fileId));
    return sources.get(fileId);
  };
  const inWindow = (step: number): boolean => !ctx.window || ctx.window.some(([a, b]) => a <= step && step <= b);

  const drafts = new Map<string, StatementDraft>();
  const skipped = new Set<string>();
  for (let i = 0; i < trace.count; i++) {
    if (!inWindow(i)) continue;
    const scope = trace.scope(trace.scopeId(i));
    if (!scope || !isUserScope(scope)) continue;
    const rid = trace.rid(i);
    const loc = files.locate(rid);
    if (!loc || !ctx.user(loc.fileId) || !isStatement(loc.fileId, loc.localRid)) continue;
    const key = statementKey(loc.fileId, loc.range[0]);
    if (drafts.has(key) || skipped.has(key)) continue;
    const parentKey = ctx.scopeKey(scope);
    const lines = source(loc.fileId);
    if (parentKey === undefined || !ctx.hasNode(parentKey) || !lines || skipStatement(lines, loc.range)) {
      skipped.add(key);
      continue;
    }
    const slice = rangeLines(lines, loc.range);
    const code = stripCode(slice);
    const names = namesOf(slice);
    drafts.set(key, { key, parentKey, label: collapse(code, 60), file: loc.path, line: loc.range[0], fileId: loc.fileId, text: collapse(code, 200), targets: names.targets, reads: names.reads, firstStep: i, hits: hitsByRid.get(rid) ?? 1, rows: [] });
  }

  // the bound: the first STATEMENTS_MAX per parent in firstStep order
  let truncated = false;
  const perParent = new Map<string, number>();
  const statements = new Map<string, StatementDraft>();
  for (const d of drafts.values()) {
    const n = perParent.get(d.parentKey) ?? 0;
    if (n >= STATEMENTS_MAX) {
      truncated = true;
      continue;
    }
    perParent.set(d.parentKey, n + 1);
    statements.set(d.key, d);
  }
  return { statements, truncated };
}

/** A decision's names for the data edges: a loop assigns its `for` target and reads its iterable, an `if`/`while`/`match` reads its condition. */
export function decisionNames(map: FileMap, line: number): { targets: string[]; reads: string[] } {
  const loop = map.loops.get(line);
  if (loop) {
    if (loop.kind === 'while') return { targets: [], reads: namesOf([loop.text]).reads };
    const i = loop.text.indexOf(' in ');
    const left = i >= 0 ? loop.text.slice(0, i) : loop.text;
    const right = i >= 0 ? loop.text.slice(i + ' in '.length) : '';
    return { targets: left.match(NAME) ?? [], reads: namesOf([right]).reads };
  }
  const dec = map.decisions.get(line);
  return { targets: [], reads: dec ? namesOf([dec.text]).reads : [] };
}

export interface Consumer {
  key: string;
  parentKey: string;
  firstStep: number;
  reads: string[];
}
export interface Producer {
  key: string;
  parentKey: string;
  firstStep: number;
  targets: string[];
}

/**
 * The statement data edges (S6): for every consumer's read, the producer under the same parent
 * with the greatest earlier `firstStep` whose targets hold the name, else the parent when it is
 * a function with an `in` row of that name.
 */
export function statementDataEdges(consumers: Consumer[], producers: Producer[], parentIn: (parentKey: string, name: string) => boolean): { from: string; to: string; label: string; firstStep: number }[] {
  const out: { from: string; to: string; label: string; firstStep: number }[] = [];
  const byParent = new Map<string, Producer[]>();
  for (const p of producers) {
    const list = byParent.get(p.parentKey) ?? [];
    list.push(p);
    byParent.set(p.parentKey, list);
  }
  for (const c of [...consumers].sort((a, b) => a.firstStep - b.firstStep)) {
    for (const name of c.reads) {
      let best: Producer | undefined;
      for (const p of byParent.get(c.parentKey) ?? []) {
        if (p.firstStep >= c.firstStep || !p.targets.includes(name)) continue;
        if (!best || p.firstStep > best.firstStep) best = p;
      }
      const from = best ? best.key : parentIn(c.parentKey, name) ? c.parentKey : undefined;
      if (from === undefined) continue;
      out.push({ from, to: c.key, label: name, firstStep: c.firstStep });
    }
  }
  return out;
}
