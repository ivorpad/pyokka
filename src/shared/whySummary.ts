/**
 * The summary above a provenance tree: one of three states, in sentences built from the tree's own
 * fields (docs/PROTOCOL.md, "Provenance"). The Python twin is `python/pyokka_runtime/agent/why_summary.py`,
 * whose docstring has the rules; the fixture cases pin both to the same summaries, so keep the rules and
 * the wording identical. Pure and vscode-free: the host builds it, the webview and `pyokka why` show it.
 */
import { MAX_LOCALS_ENTRIES, type Provenance, type ProvenanceNode, type WhyLimit, type WhyPiece, type WhySummary } from './protocol';

export const SUMMARY_VALUE = 60;
/** the fallback's two sentences that say no more than "nothing found": the text form leaves them out */
export const NOTHING_FOUND = 'Nothing in this chain changed through another name or differs from what a call received.';
export const FOLLOWING_SHOWS_MORE = 'This recording sees new values given to names, not changes inside objects: following objects can show more.';
const OPAQUE = /^<[^<>]* object(?: at 0x[0-9a-f]+)?>$/;
const NUMBER = /-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y;

/* ----- builtin literals ----- */

interface Lit {
  kind: 'dict' | 'list' | 'tuple' | 'set' | 'str' | 'const' | 'number';
  span: [number, number];
  items?: Lit[];
  pairs?: [Lit, Lit][];
}

class Bail extends Error {}

/** `text` as a tree of builtin literals with spans; undefined for anything else, a cut text included. */
export function parseLiteral(text: string): Lit | undefined {
  if (text.includes('…')) return undefined;
  let pos = 0;
  const ws = (): void => {
    while (pos < text.length && ' \t\n'.includes(text[pos]!)) pos++;
  };
  const peek = (ch: string): boolean => {
    ws();
    if (pos >= text.length) throw new Bail();
    return text[pos] === ch;
  };
  const commaOr = (close: string): void => {
    if (peek(',')) pos++;
    else if (!peek(close)) throw new Bail();
  };
  const value = (): Lit => {
    ws();
    if (pos >= text.length) throw new Bail();
    const start = pos;
    const ch = text[pos]!;
    if (ch === '[' || ch === '(') {
      const [close, kind] = ch === '[' ? [']', 'list' as const] : [')', 'tuple' as const];
      pos++;
      const items: Lit[] = [];
      ws();
      while (!peek(close)) {
        items.push(value());
        commaOr(close);
      }
      pos++;
      return { kind, span: [start, pos], items };
    }
    if (ch === '{') {
      pos++;
      ws();
      if (peek('}')) {
        pos++;
        return { kind: 'dict', span: [start, pos], pairs: [] };
      }
      const first = value();
      ws();
      if (peek(':')) {
        pos++;
        const pairs: [Lit, Lit][] = [[first, value()]];
        commaOr('}');
        while (!peek('}')) {
          const key = value();
          ws();
          if (!peek(':')) throw new Bail();
          pos++;
          pairs.push([key, value()]);
          commaOr('}');
        }
        pos++;
        return { kind: 'dict', span: [start, pos], pairs };
      }
      const members = [first];
      commaOr('}');
      while (!peek('}')) {
        members.push(value());
        commaOr('}');
      }
      pos++;
      return { kind: 'set', span: [start, pos], items: members };
    }
    if (ch === "'" || ch === '"') {
      pos++;
      while (pos < text.length && text[pos] !== ch) pos += text[pos] === '\\' ? 2 : 1;
      if (pos >= text.length) throw new Bail();
      pos++;
      return { kind: 'str', span: [start, pos] };
    }
    for (const word of ['None', 'True', 'False']) {
      const after = text[start + word.length];
      if (text.startsWith(word, start) && !(after !== undefined && /[\p{L}\p{N}_]/u.test(after))) {
        pos += word.length;
        return { kind: 'const', span: [start, pos] };
      }
    }
    NUMBER.lastIndex = start;
    const m = NUMBER.exec(text);
    if (m && m[0].length) {
      pos = start + m[0].length;
      return { kind: 'number', span: [start, pos] };
    }
    throw new Bail();
  };
  try {
    const out = value();
    ws();
    return pos === text.length ? out : undefined;
  } catch (e) {
    if (e instanceof Bail) return undefined;
    throw e;
  }
}

const src = (text: string, n: Lit): string => text.slice(n.span[0], n.span[1]);

/** Where two literal texts first differ: `[path, part of a, part of b]`; undefined when equal or either is not a literal. */
export function literalDiff(a: string, b: string): [string, string, string] | undefined {
  const ta = parseLiteral(a);
  const tb = parseLiteral(b);
  if (!ta || !tb) return undefined;
  const walk = (x: Lit, y: Lit, path: string): [string, string, string] | undefined => {
    const sx = src(a, x);
    const sy = src(b, y);
    if (sx === sy) return undefined;
    if (x.kind !== y.kind) return [path, sx, sy];
    if (x.kind === 'dict') {
      const px = x.pairs!;
      const py = y.pairs!;
      if (px.length !== py.length || px.some(([k], i) => src(a, k) !== src(b, py[i]![0]))) return [path, sx, sy];
      for (let i = 0; i < px.length; i++) {
        const found = walk(px[i]![1], py[i]![1], `${path}[${src(a, px[i]![0])}]`);
        if (found) return found;
      }
      return [path, sx, sy];
    }
    if ((x.kind === 'list' || x.kind === 'tuple') && x.items!.length === y.items!.length) {
      for (let i = 0; i < x.items!.length; i++) {
        const found = walk(x.items![i]!, y.items![i]!, `${path}[${i}]`);
        if (found) return found;
      }
    }
    return [path, sx, sy];
  };
  return walk(ta, tb, '');
}

/** The part of a literal text at `path` (`['lines'][0]['qty']`), or undefined when it has none there. */
export function literalPart(text: string, path: string): string | undefined {
  let node = parseLiteral(text);
  if (!node) return undefined;
  let rest = path;
  while (rest) {
    if (!rest.startsWith('[')) return undefined;
    if (node.kind === 'dict') {
      const hit: [Lit, Lit] | undefined = node.pairs!.find(([k]) => rest.startsWith(`[${src(text, k)}]`));
      if (!hit) return undefined;
      rest = rest.slice(src(text, hit[0]).length + 2);
      node = hit[1];
    } else if (node.kind === 'list' || node.kind === 'tuple') {
      const m = /^\[(\d+)\]/.exec(rest);
      if (!m || Number(m[1]) >= node.items!.length) return undefined;
      node = node.items![Number(m[1])]!;
      rest = rest.slice(m[0].length);
    } else return undefined;
  }
  return src(text, node);
}

/* ----- pieces ----- */

interface Where {
  file?: string;
  fileId?: number;
  line?: number;
  function?: string;
}

function value(node: ProvenanceNode, path = '', text?: string): WhyPiece {
  const out: WhyPiece = { value: text ?? node.text!, of: node.name, at: node.step! };
  if (path) out.path = path;
  return out;
}

function place(step: number, where: Where): WhyPiece {
  const out: WhyPiece = { step };
  if (where.file !== undefined) out.file = where.file;
  if (where.fileId !== undefined) out.fileId = where.fileId;
  if (where.line !== undefined) out.line = where.line;
  if (where.function) out.function = where.function;
  return out;
}

/** Every node of the tree breadth-first, with the nodes above it (root first). */
function nodes(tree: Provenance): [ProvenanceNode, ProvenanceNode[]][] {
  const out: [ProvenanceNode, ProvenanceNode[]][] = [];
  const queue: [ProvenanceNode, ProvenanceNode[]][] = [[tree.root, []]];
  while (queue.length) {
    const [node, above] = queue.shift()!;
    out.push([node, above]);
    for (const r of node.reads ?? []) queue.push([r, [...above, node]]);
  }
  return out;
}

/* ----- the three states ----- */

function answer(tree: Provenance): WhySummary | undefined {
  const root = tree.root;
  for (const [node, above] of nodes(tree)) {
    // below the root only a builtin container whose contents the chain read: an object's change may not reach the value
    if (!changedInPlace(node) || (above.length && parseLiteral(node.text ?? '') === undefined)) continue;
    const s = node.shared!;
    const head: WhyPiece[] =
      s.as !== undefined
        ? [{ name: s.path }, { t: ', the same object as ' }, { name: s.as }, { t: ', was changed at ' }, place(node.step!, node)] // the change came through another name
        : [{ name: s.path }, { t: ' was changed at ' }, place(node.step!, node)]; // through a path of the name itself (`self.totals[k] = v` reaching `ledger.totals`)
    if (node.function) head.push({ t: ' in ' }, { name: node.function });
    if (node.statement) head.push({ t: ': ' }, { code: node.statement });
    const details: WhyPiece[][] = [];
    if (above.length && root.text !== undefined && root.step !== undefined) details.push([{ t: 'It is an input of ' }, { name: root.name }, { t: ', which is ' }, value(root), { t: ' at ' }, place(root.step, root), { t: '.' }]);
    if (s.line !== undefined && s.since !== undefined) {
      const lead: WhyPiece[] = s.as !== undefined ? [{ t: 'They share it since ' }] : [{ name: node.name }, { t: ' holds it since ' }];
      details.push([...lead, place(s.since, s), { t: '.' }]);
    }
    for (const p of [...above, node]) {
      const arg = p.argument;
      if (arg && p.step !== undefined) details.push([{ name: p.name }, { t: ' at ' }, place(p.step, p), { t: ' is the ' }, { name: arg.text }, { t: ' passed at ' }, place(arg.step, arg), { t: '.' }]);
    }
    return { state: 'answer', headline: [...head, { t: '.' }], details };
  }
  return undefined;
}

/** A node the recording saw changed in place, through another name or a path of its own. */
function changedInPlace(node: ProvenanceNode): boolean {
  return !!node.shared?.path && node.resolution === 'seen' && node.step !== undefined;
}

/** The fallback's sentence for an object of the chain that was changed in place but is no answer. */
function touched(node: ProvenanceNode): WhyPiece[] {
  const out: WhyPiece[] = [{ name: node.shared!.path }, { t: ' was changed in place at ' }, place(node.step!, node)];
  if (node.statement) out.push({ t: ': ' }, { code: node.statement });
  return [...out, { t: '. The chain reads it, but this recording does not say whether that change reached this value.' }];
}

function signpost(tree: Provenance, followObjects: boolean, capped: boolean): WhySummary | undefined {
  for (const [node] of nodes(tree)) {
    const arg = node.argument;
    if (!arg || node.text === undefined || node.step === undefined) continue;
    const passed = (node.reads ?? []).find((r) => r.name === arg.text && r.step !== undefined && r.text !== undefined);
    if (!passed) continue;
    const diff = literalDiff(passed.text!, node.text);
    if (!diff) continue;
    const [path, before, after] = diff;
    const name = passed.name;
    const head: WhyPiece[] = [
      { name: name + path }, { t: ' was ' }, value(passed, path, before), { t: ' at ' }, place(passed.step!, passed),
      { t: ', and ' }, { name: node.function ?? '<module>' }, { t: ' received ' }, value(node, path, after), { t: ' as ' }, { name: node.name + path },
      { t: ' at ' }, place(node.step, node), { t: '.' },
    ];
    const details: WhyPiece[][] = [];
    // valueAt gave the last change recorded before the call: there is none after it
    if (tree.recordedLocals !== false && !capped) details.push([{ t: 'This recording has no change of ' }, { name }, { t: ' between ' }, place(passed.step!, passed), { t: ' and the call at ' }, place(arg.step, arg), { t: '.' }]);
    if (followObjects) {
      details.push([{ t: 'Even following objects, no stepped statement changed it in between: it changed in code that was not stepped (a library, a C extension) or along a path the recording did not follow.' }]);
      return { state: 'signpost', headline: head, details };
    }
    details.push([{ t: 'This recording sees new values given to names, not changes inside an object. Record again following objects to see the line that changed it.' }]);
    return { state: 'signpost', headline: head, details, action: 'followObjects' };
  }
  return undefined;
}

function fallback(tree: Provenance, followObjects: boolean, capped: boolean): WhySummary | undefined {
  const root = tree.root;
  if (root.text === undefined || root.step === undefined) return undefined;
  const head: WhyPiece[] = [{ name: root.name || 'the statement' }, { t: ' is ' }, value(root), { t: ' at ' }, place(root.step, root), { t: '.' }];
  const all = nodes(tree).map(([n]) => n);
  const changed = all.find(changedInPlace);
  const details: WhyPiece[][] = [changed ? touched(changed) : [{ t: NOTHING_FOUND }]];
  const limits: WhyLimit[] = [];
  if (tree.recordedLocals === false) {
    limits.push('noLocals');
    details.push([{ t: 'This run recorded no locals: only logged values are known.' }]);
  }
  if (capped) {
    limits.push('cap');
    details.push([{ t: `The recording stopped keeping changes at its limit of ${MAX_LOCALS_ENTRIES.toLocaleString('en-US')} entries, before this step.` }]);
  }
  const opaque = all.find((n) => n.text !== undefined && n.step !== undefined && OPAQUE.test(n.text));
  if (opaque && !followObjects) {
    limits.push('opaque');
    details.push([{ name: opaque.name }, { t: ' shows nothing inside it (' }, value(opaque), { t: '), so this recording cannot see what changed inside it.' }]);
  }
  if (root.text.includes('…')) {
    limits.push('cut');
    details.push([{ t: 'The value is cut: Rerun value gets all of it.' }]);
  }
  if (tree.truncated || all.some((n) => n.cut)) {
    limits.push('chainCut');
    details.push([{ t: "The chain goes on past what is shown: ask why for a node's name at its step." }]);
  }
  if (all.some((n) => n.beforeRecording)) {
    limits.push('beforeRecording');
    details.push([{ t: 'Part of the chain was made before the recording started, at #0.' }]);
  }
  if (!followObjects && !limits.includes('opaque')) details.push([{ t: FOLLOWING_SHOWS_MORE }]);
  const out: WhySummary = { state: 'fallback', headline: head, details, limits };
  if (!followObjects) out.action = 'followObjects';
  return out;
}

/** The summary of a tree, its sentences validated; undefined when the root has no recorded value. */
export function summarize(tree: Provenance, followObjects = false, capped = false): WhySummary | undefined {
  const root = tree.root;
  if (!root.name || root.step === undefined || root.text === undefined) return undefined;
  const summary = answer(tree) ?? signpost(tree, followObjects, capped) ?? fallback(tree, followObjects, capped);
  if (!summary || validateSentence(summary.headline, tree).length) return undefined;
  summary.details = summary.details.filter((d) => !validateSentence(d, tree).length);
  return summary;
}

/* ----- the validator ----- */

function places(tree: Provenance): Set<string> {
  const out = new Set<string>();
  const add = (step: number | undefined, w: Where): void => {
    if (step !== undefined) out.add(`${step}|${w.file}|${w.fileId}|${w.line}`);
  };
  for (const [n] of nodes(tree)) {
    add(n.step, n);
    if (n.argument) add(n.argument.step, n.argument);
    if (n.shared) add(n.shared.since, n.shared);
  }
  return out;
}

function names(tree: Provenance): Set<string> {
  const out = new Set<string>();
  for (const [n] of nodes(tree)) {
    if (n.name) out.add(n.name);
    if (n.function) out.add(n.function);
    if (n.shared?.path) out.add(n.shared.path);
    if (n.shared?.as) out.add(n.shared.as);
    if (n.argument) out.add(n.argument.text);
  }
  return out;
}

/** What in a sentence the tree does not hold, one problem per piece; empty when every piece checks. */
export function validateSentence(pieces: readonly WhyPiece[], tree: Provenance): string[] {
  const problems: string[] = [];
  const all = nodes(tree).map(([n]) => n);
  const byKey = new Map(all.map((n) => [`${n.name}|${n.step}`, n]));
  const where = places(tree);
  const known = names(tree);
  const statements = new Set(all.map((n) => n.statement).filter((s): s is string => !!s));
  for (const p of pieces) {
    if (p.value !== undefined) {
      const node = byKey.get(`${p.of}|${p.at}`);
      if (!node || node.text === undefined) problems.push(`no node ${p.of} at #${p.at}`);
      else if (p.path) {
        if (literalPart(node.text, p.path) !== p.value) problems.push(`${p.of} at #${p.at} has no ${p.of}${p.path} = ${p.value}`);
      } else if (node.text !== p.value) problems.push(`${p.of} at #${p.at} is not ${p.value}`);
    } else if (p.step !== undefined) {
      if (!where.has(`${p.step}|${p.file}|${p.fileId}|${p.line}`)) problems.push(`no place #${p.step} ${p.file}:${p.line}`);
    } else if (p.name !== undefined) {
      const base = p.name.split('[', 1)[0]!;
      if (!known.has(p.name) && !known.has(base)) problems.push(`no name ${p.name}`);
    } else if (p.code !== undefined) {
      if (!statements.has(p.code)) problems.push(`no statement ${p.code}`);
    }
  }
  return problems;
}

/** Every problem of every sentence of the summary; empty for a summary `summarize` made. */
export function validateSummary(summary: WhySummary | undefined, tree: Provenance): string[] {
  if (!summary) return [];
  return [summary.headline, ...summary.details].flatMap((s) => validateSentence(s, tree));
}

/* ----- text ----- */

function clip(text: string): string {
  const s = text.split('\n').join(' ').trim();
  return s.length <= SUMMARY_VALUE ? s : s.slice(0, SUMMARY_VALUE - 1) + '…';
}

function shortFile(path: unknown): string {
  return String(path ?? '').split(/[\\/]/).pop() || '<unknown>';
}

/** A sentence as one line: values cut at 60 characters, places as `#23 promo.py:4`, code as written. */
export function sentenceText(pieces: readonly WhyPiece[]): string {
  return pieces
    .map((p) => {
      if (p.value !== undefined) return clip(p.value);
      if (p.step !== undefined) return `#${p.step} ${shortFile(p.file)}:${p.line ?? '?'}`;
      if (p.name !== undefined) return p.name;
      if (p.code !== undefined) return p.code;
      return p.t ?? '';
    })
    .join('');
}

export const SUMMARY_LABELS: Record<WhySummary['state'], string> = { answer: 'answer', signpost: 'signpost', fallback: 'summary' };
export const SUMMARY_ACTIONS: Record<NonNullable<WhySummary['action']>, string> = { followObjects: 'next: record again following objects (--follow-objects)' };

/**
 * The text form's lines for a summary: `answer: …` or `signpost: …`, one indented line per detail, the action.
 * A fallback says only the limits it found (its headline repeats the conclusion), as `summary: …` lines, and
 * the action only when an object showed nothing inside it; a fallback that found none prints nothing.
 */
export function summaryLines(summary: WhySummary | undefined): string[] {
  if (!summary) return [];
  const details = summary.details.map(sentenceText);
  if (summary.state === 'fallback') {
    const notes = details.filter((d) => d !== NOTHING_FOUND && d !== FOLLOWING_SHOWS_MORE);
    if (!notes.length) return [];
    const out = [`${SUMMARY_LABELS.fallback}: ${notes[0]}`, ...notes.slice(1).map((n) => '  ' + n)];
    if ((summary.limits ?? []).includes('opaque') && summary.action) out.push('  ' + SUMMARY_ACTIONS[summary.action]);
    return out;
  }
  const out = [`${SUMMARY_LABELS[summary.state]}: ${sentenceText(summary.headline)}`, ...details.map((d) => '  ' + d)];
  if (summary.action) out.push('  ' + SUMMARY_ACTIONS[summary.action]);
  return out;
}
