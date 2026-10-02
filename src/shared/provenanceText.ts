/**
 * The text form of a provenance tree (docs/PROTOCOL.md, "Provenance"): the lines `pyokka why`
 * prints and the Details pane shows. Pure and vscode-free, so the host and the webview share
 * it. The Python twin is `render_why` in `python/pyokka_runtime/agent/render.py`; keep the
 * rules identical.
 */
import { PROVENANCE_NODES, type Provenance, type ProvenanceCall, type ProvenanceNode } from './protocol';

export const WHY_VALUE = 100;
export const WHY_STATEMENT = 80;
export const WHY_INPUT = 60;
/** after a leaf of a recording that began at a pause (`--record-from`): its value was made before step 0 */
export const BEFORE_RECORDING = '   made before #0, where the recording started';

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

function nodeText(n: ProvenanceNode, prefix: string, displayPath: DisplayPath): string {
  const parts: string[] = [];
  if (n.name) {
    if (n.text !== undefined) parts.push(`${n.name} = ${oneLine(n.text, WHY_VALUE)}${n.unchanged ? '  (unchanged)' : ''}`);
    else if (n.step !== undefined) parts.push(`${n.name}  assigned here (value not recorded)`);
    else parts.push(`${n.name} = ?${n.beforeRecording ? BEFORE_RECORDING : ''}`);
  }
  if (n.step !== undefined) parts.push(`#${n.step} ${displayPath(n.fileId, n.file)}:${n.line ?? '?'} ${n.function ?? '<module>'}`);
  if (n.statement) parts.push(oneLine(n.statement, WHY_STATEMENT));
  return prefix + parts.join('   ') + (n.cut ? '  …' : '');
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
  const walk = (n: ProvenanceNode, level: number): void => {
    const pad = '  '.repeat(level);
    out.push({ text: pad + nodeText(n, level ? '← ' : '', displayPath), kind: 'node', indent: level, step: n.step, fileId: n.fileId, line: n.line });
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
  const reads = (root.reads ?? []).filter((r) => r.text !== undefined);
  const calls = root.calls ?? [];
  const second = conditional(root, reads) || calledValue(root, calls) || copied(root, reads) || lookedUp(root, reads) || readValues(reads);
  return first + '.' + (second ? ' ' + second + '.' : '');
}
