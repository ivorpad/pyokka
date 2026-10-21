/**
 * The text form of a provenance tree (docs/PROTOCOL.md, "Provenance"): the lines `pyokka why`
 * prints and the Details pane shows. Pure and vscode-free, so the host and the webview share
 * it. The Python twin is `render_why` in `python/pyokka_runtime/agent/render.py`; keep the
 * rules identical.
 */
import { PROVENANCE_NODES, type Provenance, type ProvenanceCall, type ProvenanceNode, type SharedHolding } from './protocol';

export const WHY_VALUE = 100;
export const WHY_STATEMENT = 80;
export const WHY_INPUT = 60;
/** after a leaf of a recording that began at a pause (`--record-from`): its value was made before step 0 */
export const BEFORE_RECORDING = '   made before #0, where the recording started';
/** after a leaf of a run that recorded no locals: why nothing answers for the name */
export const NOT_RECORDED = '   not recorded: this run recorded no locals';

export interface ProvenanceLine {
  text: string;
  kind: 'header' | 'node' | 'call' | 'opaque' | 'note' | 'conclusion';
  /** levels below the root (the header and the note have none) */
  indent: number;
  /** the Time Machine target of a node or call line */
  step?: number;
  fileId?: number;
  line?: number;
}

/** One line, cut to `limit` characters with an ellipsis. */
export function oneLine(text: string | undefined, limit: number): string {
  const s = (text ?? '').split('\n').join(' ').trim();
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}

export type DisplayPath = (fileId: number | undefined, file: string | undefined) => string;

/** The tree's own facts a node line needs: the queried step (a name with no value yet there says so), whether locals were recorded, and whether the tree has a seen node. */
interface TreeFacts {
  step: number;
  recordedLocals: boolean;
  mixed: boolean;
}

function nodeText(n: ProvenanceNode, prefix: string, displayPath: DisplayPath, tree: TreeFacts): string {
  const parts: string[] = [];
  const first = n.step === undefined && n.text === undefined ? n.firstAssigned : undefined;
  if (n.name) {
    if (n.text !== undefined) parts.push(`${n.name} = ${oneLine(n.text, WHY_VALUE)}${n.unchanged ? '  (unchanged)' : ''}`);
    else if (n.step !== undefined) parts.push(`${n.name}  assigned here (value not recorded)`);
    else if (first) {
      const where = `#${first.step} ${displayPath(first.fileId, first.file)}:${first.line ?? '?'} ${first.function ?? '<module>'}`;
      // a recording that began at a pause cannot tell a name made before step 0 from one made later: it says both
      parts.push(n.beforeRecording ? `${n.name} = ?${BEFORE_RECORDING}, or first assigned at ${where}` : `${n.name}  not assigned yet at #${tree.step}, first assigned at ${where}`);
    }
    else parts.push(`${n.name} = ?${n.beforeRecording ? BEFORE_RECORDING : tree.recordedLocals ? '' : NOT_RECORDED}`);
  }
  if (n.step !== undefined) parts.push(`#${n.step} ${displayPath(n.fileId, n.file)}:${n.line ?? '?'} ${n.function ?? '<module>'}`);
  else if (n.defined) parts.push(`def ${displayPath(n.fileId, n.file)}:${n.line}`);
  if (tree.mixed && n.resolution === 'guessed' && parts.length) parts[0] += '  (guessed)'; // only in a tree that has a seen node, so a snapshot tree reads as before
  const statement = first ? first.statement : n.statement;
  if (statement) parts.push(oneLine(statement, WHY_STATEMENT));
  const shared = n.shared ? sharedText(n.shared, displayPath) : '';
  if (shared) parts.push(`[${shared}]`);
  return prefix + parts.join('   ') + (n.cut ? '  …' : '');
}

function hasExact(n: ProvenanceNode): boolean {
  return n.resolution === 'seen' || (n.reads ?? []).some(hasExact);
}

/** How a node holds the object a change came through: `bo['lines'][0] is line, shared since #17 catalog.py:5 new_order`; '' when it says nothing the line does not. */
export function sharedText(s: SharedHolding, displayPath: DisplayPath): string {
  if (s.as === undefined && s.line === undefined) return '';
  let out = s.as !== undefined ? `${s.path} is ${s.as}` : `through ${s.path}`;
  if (s.line !== undefined) out += `, ${s.as !== undefined ? 'shared' : 'held'} since #${s.since} ${displayPath(s.fileId, s.file)}:${s.line} ${s.function ?? '<module>'}`;
  return out;
}

function callText(c: ProvenanceCall, displayPath: DisplayPath): string {
  let s = `↳ ${c.name} #${c.entryStep}–#${c.returnStep} ${displayPath(c.fileId, c.file)}:${c.line}`;
  if (c.inputs.length) s += '   in ' + c.inputs.map((i) => `${i.name} = ${oneLine(i.text, WHY_INPUT)}`).join(', ');
  if (c.result !== undefined) s += `   out ${oneLine(c.result, WHY_STATEMENT)}`;
  return s;
}

/** The lines of a tree: the header, then each node depth-first (its reads, then its calls, then its opaque calls), then the truncation note. */
export function provenanceLines(p: Provenance, displayPath: DisplayPath = (_, file) => file ?? '<unknown>'): ProvenanceLine[] {
  const out: ProvenanceLine[] = [{ text: p.name ? `why ${p.name} at #${p.step}` : `why #${p.step}`, kind: 'header', indent: 0 }];
  const tree: TreeFacts = { step: p.step, recordedLocals: p.recordedLocals !== false, mixed: hasExact(p.root) };
  const walk = (n: ProvenanceNode, level: number): void => {
    const pad = '  '.repeat(level);
    // a name with no value yet links to where it is first assigned
    const target = n.step === undefined && n.text === undefined && n.firstAssigned ? n.firstAssigned : n;
    out.push({ text: pad + nodeText(n, level ? '← ' : '', displayPath, tree), kind: 'node', indent: level, step: target.step, fileId: target.fileId, line: target.line });
    for (const r of n.reads ?? []) walk(r, level + 1);
    for (const c of n.calls ?? []) out.push({ text: pad + '  ' + callText(c, displayPath), kind: 'call', indent: level + 1, step: c.entryStep, fileId: c.fileId, line: c.line });
    for (const o of n.opaque ?? []) out.push({ text: `${pad}  · ${o}   not stepped`, kind: 'opaque', indent: level + 1 });
  };
  walk(p.root, 0);
  if (p.truncated) out.push({ text: `… more inputs than ${PROVENANCE_NODES} nodes show; ask why for a node's name at its step`, kind: 'note', indent: 0 });
  if (p.conclusion) out.push({ text: p.conclusion, kind: 'conclusion', indent: 0 });
  return out;
}

export function renderProvenance(p: Provenance, displayPath?: DisplayPath): string {
  return provenanceLines(p, displayPath).map((l) => l.text).join('\n');
}

/* ----- the conclusion: the answer in words, from the tree alone ----- */

/**
 * The closing sentence or two of a tree, built from its root and first level (docs/PROTOCOL.md,
 * "Provenance"). The Python twin is `conclusion` in `python/pyokka_runtime/agent/why_text.py`;
 * the fixture cases pin both to the same strings, so keep the rules and the wording identical.
 * Nothing here guesses: a clause names a value only when the tree recorded it, and a root without
 * a recorded value yields ''.
 */
export const WHY_CONCLUSION_VALUE = 60;
const FALSY = new Set(['False', 'None', '0', '0.0', "''", '""', '[]', '{}', '()', 'set()']);
const NONE_OR_EMPTY = new Set(['None', "''", '""', '[]', '{}', '()', 'set()', 'frozenset()', "b''", 'b""']);
const KEYWORDS = new Set(['and', 'or', 'not', 'is', 'in', 'if', 'else', 'None', 'True', 'False', 'lambda', 'for']);
const NAME_RE = /^[A-Za-z_][\w.]*$/;
const IDENT_RE = /(?<![\w.])[A-Za-z_]\w*/g;
const STRING_RE = /'[^']*'|"[^"]*"/g;

const clip = (text: unknown): string => oneLine(text === undefined ? '' : String(text), WHY_CONCLUSION_VALUE);

export function shortFile(path: unknown): string {
  return String(path ?? '').split(/[\\/]/).pop() || '<unknown>';
}

function where(node: ProvenanceNode): string {
  return `#${node.step} (${shortFile(node.file)}:${node.line ?? '?'})`;
}

/** The expression after the first `=` of an assignment (`==` is not one); the statement itself otherwise. */
function rhsOf(statement: string): string {
  const m = /(?<![=!<>])=(?!=)/.exec(statement);
  return m ? statement.slice(m.index + 1).trim() : statement.trim();
}

function namesIn(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.replace(STRING_RE, "''").matchAll(IDENT_RE)) {
    if (!KEYWORDS.has(m[0]) && !seen.includes(m[0])) seen.push(m[0]);
  }
  return seen;
}

function byName(reads: ProvenanceNode[]): Map<string, ProvenanceNode> {
  const out = new Map<string, ProvenanceNode>();
  for (const r of reads) out.set(r.name, r);
  return out;
}

function since(test: string, reads: ProvenanceNode[], skip: string | null): string {
  const names = byName(reads);
  const parts = namesIn(test)
    .filter((n) => n !== skip && names.has(n))
    .slice(0, 2)
    .map((n) => `${n} is ${clip(names.get(n)!.text)}`);
  return parts.length ? ', since ' + parts.join(' and ') : '';
}

function conditional(root: ProvenanceNode, reads: ProvenanceNode[]): string {
  const rhs = rhsOf(root.statement ?? '');
  if (!rhs.includes(' if ') || !rhs.includes(' else ')) return '';
  const i = rhs.indexOf(' if ');
  const ifArm = rhs.slice(0, i).trim();
  const rest = rhs.slice(i + 4);
  const j = rest.indexOf(' else ');
  if (j < 0) return '';
  const test = rest.slice(0, j).trim();
  const elseArm = rest.slice(j + 6).trim();
  const names = byName(reads);
  if (NAME_RE.test(test) && names.has(test)) {
    const text = String(names.get(test)!.text);
    const arm = FALSY.has(text) ? 'else' : 'if';
    return `The ${arm} arm ran: ${test} is ${clip(text)}${since(test, reads, test)}`;
  }
  const value = String(root.text);
  if (value === elseArm) return `The else arm ran: ${test} was false${since(test, reads, null)}`;
  if (value === ifArm) return `The if arm ran: ${test} was true${since(test, reads, null)}`;
  return '';
}

function callTextIn(statement: string, name: string): string {
  const m = new RegExp(`((?:[A-Za-z_]\\w*\\.)*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\(`).exec(statement);
  if (!m) return `${name}(...)`;
  let depth = 0;
  for (let k = m.index + m[0].length - 1; k < statement.length; k++) {
    const ch = statement[k];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return statement.slice(m.index, k + 1);
    }
  }
  return statement.slice(m.index);
}

function calledValue(root: ProvenanceNode, calls: ProvenanceCall[]): string {
  for (const call of calls) {
    if (call.result === undefined) continue;
    let text = `${callTextIn(root.statement ?? '', call.name)} returned ${clip(call.result)}`;
    const empty = call.inputs.find((a) => a.text !== undefined && NONE_OR_EMPTY.has(String(a.text)));
    if (empty) text += ` with ${empty.name} = ${empty.text}`;
    return text;
  }
  return '';
}

function copied(root: ProvenanceNode, reads: ProvenanceNode[]): string {
  const earlier = reads.filter((r) => r.step !== undefined && r.step < root.step!);
  if (earlier.length !== 1) return '';
  const read = earlier[0]!;
  if (rhsOf(root.statement ?? '') !== read.name) return '';
  return `It copies ${read.name}, which has been ${clip(read.text)} since ${where(read)}`;
}

/** Top-level keys of a whole dict repr; undefined when the text is not one or is cut. */
function countKeys(text: string): number | undefined {
  if (!(text.startsWith('{') && text.endsWith('}')) || text.includes('…')) return undefined;
  let depth = 0;
  let keys = 0;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ':' && depth === 1) keys++;
  }
  return keys;
}

function lookedUp(root: ProvenanceNode, reads: ProvenanceNode[]): string {
  if (String(root.text) !== 'None') return '';
  const rhs = rhsOf(root.statement ?? '');
  const m = /([A-Za-z_][\w.]*)(\.get\(|\[)/.exec(rhs);
  if (!m) return '';
  const container = m[1]!;
  const names = byName(reads);
  const read = names.get(container) ?? names.get(container.split('.')[0]!);
  if (!read) return '';
  const start = m.index;
  const opener = rhs[start + m[0].length - 1];
  const closer = opener === '(' ? ')' : ']';
  let depth = 0;
  let end = rhs.length;
  for (let k = start + m[0].length - 1; k < rhs.length; k++) {
    if (rhs[k] === opener) depth++;
    else if (rhs[k] === closer) {
      depth--;
      if (depth === 0) {
        end = k + 1;
        break;
      }
    }
  }
  const expr = rhs.slice(start, end);
  const keys = read.name === container ? countKeys(String(read.text)) : undefined;
  return `${expr} is None: the key is not in ${container}${keys !== undefined ? ` (${keys} keys)` : ''}`;
}

function readValues(reads: ProvenanceNode[]): string {
  const parts = reads.slice(0, 3).map((r) => `${r.name} = ${clip(r.text)}`);
  return parts.length ? 'It reads ' + parts.join(', ') : '';
}

export function provenanceConclusion(p: Pick<Provenance, 'root'>): string {
  const root = p.root;
  if (!root.name || root.step === undefined || root.text === undefined) return '';
  const first = `${root.name} is ${clip(root.text)} at ${where(root)}`;
  // a function or class read (no step, `defined`) is not one of the values the statement worked with
  const reads = (root.reads ?? []).filter((r) => r.text !== undefined && r.step !== undefined);
  const calls = root.calls ?? [];
  const second = conditional(root, reads) || calledValue(root, calls) || copied(root, reads) || lookedUp(root, reads) || readValues(reads);
  const third = sharedSentence(root);
  return first + '.' + (second ? ' ' + second + '.' : '') + (third ? ' ' + third + '.' : '');
}

/** The root or one of its reads changed through another name, with the step where the sharing began. */
function sharedSentence(root: ProvenanceNode): string {
  for (const n of [root, ...(root.reads ?? [])]) {
    const s = n.shared;
    if (s?.as === undefined || n.step === undefined) continue;
    const head = `${s.path} is the same object as ${s.as}, changed at ${where(n)}`;
    // no `since` when the holder is the object itself (a global a function returned), not a path into a container
    return s.line === undefined ? head : `${head}; it is shared since #${s.since} (${shortFile(s.file)}:${s.line})`;
  }
  return '';
}
