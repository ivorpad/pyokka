/**
 * The live debugger's values on the source at a pause: a hover on each identifier that names a
 * binding of the paused frame, and a shadow beside the binding's declaration. Which identifier is
 * which binding comes from the runtime's lexical identities (`bindings` with `identifiers`), so a
 * parameter `x` and a module `x` stay apart. Only the frame's own locals are shown; no source
 * expression is evaluated for display.
 */
import type { LocalVar } from './debugHost';
import type { SourceIdentifiers, ValueNode } from '../src/shared/protocol';

export const NOT_AVAILABLE = 'Not available in this pause';

export interface PausedValues {
  /** the selected frame's line */
  line: number;
  /** the source the identities were computed from (what the pause ran) */
  content: string;
  identifiers: SourceIdentifiers;
  locals: LocalVar[];
  /** the selected frame's function name (`<module>`, `f`, `K`) */
  frameName: string;
  /** run:step:frame, to tell one pause from the next */
  snapshot: string;
}

export interface ValueOccurrence {
  line: number;
  /** UTF-16 columns on the line, 0-based, end exclusive (Monaco column - 1) */
  start: number;
  end: number;
  local: LocalVar;
  declaration: boolean;
  unavailable: boolean;
}

/** UTF-16 offset of each line's start, splitting where Python's AST does (`\r\n`, `\r`, `\n`). */
export function lineStarts(source: string): number[] {
  const out = [0];
  for (const m of source.matchAll(/\r\n|\r|\n/g)) out.push(m.index + m[0].length);
  return out;
}

/** The scope the paused frame is in: the innermost one around the line's first character. A pause
 * on a `def` or `class` header belongs to that scope only when the frame is that function's or
 * class body's own (its entry); the statement that defines it runs in the scope around it. */
export function pausedScope(pause: Pick<PausedValues, 'line' | 'content' | 'identifiers' | 'frameName'>): number {
  const starts = lineStarts(pause.content);
  const lineStart = starts[pause.line - 1];
  if (lineStart === undefined) return -1;
  const next = starts[pause.line] ?? pause.content.length;
  const indent = /^[ \t]*/.exec(pause.content.slice(lineStart, next))![0].length;
  const at = lineStart + indent;
  const { scopes } = pause.identifiers;
  const around = scopes.map((s, i) => [s, i] as const).filter(([s]) => s.start <= at && at < s.end).map(([, i]) => i);
  let current = around.at(-1) ?? 0;
  const s = scopes[current];
  if (s && s.start === at && (s.function || s.class) && s.name !== pause.frameName && around.length > 1) current = around.at(-2)!;
  return current;
}

/** Every identifier that names a binding of the paused frame. A local of the paused scope that has
 * no value yet is listed as unavailable; outer bindings the frame does not hold are left out. */
export function pausedOccurrences(pause: PausedValues): ValueOccurrence[] {
  const { scopes, references } = pause.identifiers;
  if (!scopes.length) return [];
  const current = pausedScope(pause);
  const resolve = (name: string): number => {
    let scope = current;
    while (scope >= 0 && !scopes[scope]!.names.includes(name)) scope = scopes[scope]!.parent;
    return scope;
  };
  const locals = new Map(pause.locals.map((v) => [v.name, v]));
  const starts = lineStarts(pause.content);
  const out: ValueOccurrence[] = [];
  for (const r of references) {
    if (r.scope < 0 || r.scope !== resolve(r.name)) continue;
    const local = locals.get(r.name);
    if (!local && r.scope !== current) continue;
    let line = 1;
    while (line < starts.length && starts[line]! <= r.start) line++;
    const base = starts[line - 1]!;
    out.push({ line, start: r.start - base, end: r.end - base, local: local ?? { name: r.name, text: NOT_AVAILABLE }, declaration: !!r.declaration, unavailable: !local });
  }
  return out;
}

/** Inline space belongs to the source: containers get a short preview and their size, never a dump. */
export function pausedSummary(local: LocalVar): string {
  const node = local.valueBag?.data;
  const text = local.text.replace(/\s*\n\s*/g, ' ');
  if (/^(?:list|tuple|set|frozenset|deque)$/.test(node?.type ?? '') || /^[[(]/.test(text)) {
    const preview = text.length > 48 ? text.slice(0, 47) + '…' : text;
    return preview + (node?.length !== undefined && text.length > 48 ? ` (${node.length} items)` : '');
  }
  if (text.startsWith('{') || node?.type === 'dict') return text.length <= 40 ? text : text.slice(0, 39) + '…';
  return text.length > 40 ? text.slice(0, 39) + '…' : text;
}

export function runtimeCapped(node: ValueNode | undefined, text: string): boolean {
  return !!(node?.capped || node?.cappedProps || node?.cappedElements || /\.\.\. \d+ more|…$/.test(text));
}

/** Markdown for a hover. A runtime value can contain Markdown, so it stays inside an inert fence. */
export function pausedHover(local: LocalVar): string {
  if (local.text === NOT_AVAILABLE) return `Paused frame · ${local.name}\n\n${NOT_AVAILABLE}: the frame's variables have no value for it (not assigned yet, or a module-level function, class or import, which the Variables list leaves out).`;
  const node = local.valueBag?.data;
  const source = node?.functionSource
    ? `\n\n${node.functionLocation ? `Source, ${node.functionLocation.path.split(/[\\/]/).pop()}:${node.functionLocation.line}` : 'Source'}\n\n${fenced(node.functionSource.replace(/\n$/, ''), 'python')}` +
      (node.functionSourceCapped ? '\n\nThe source is cut at 2000 characters.' : '')
    : '';
  return `Paused frame · ${local.name}\n\n${fenced(prettyRepr(local.text), 'python')}` + source +
    (runtimeCapped(node, local.text) ? '\n\nRuntime preview is truncated. Expand the variable in the Debugger for more.' : '');
}

type Piece = string | Group;
interface Group {
  open: string;
  close: string;
  items: Piece[][];
  /** `(1,)` */
  trailing: boolean;
}

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** A repr as pieces: the text between brackets, and each bracket group split at its commas. */
function parseRepr(text: string): Group {
  let i = 0;
  const group = (open: string): Group => {
    const close = CLOSER[open] ?? '';
    const items: Piece[][] = [];
    let cur: Piece[] = [];
    let atom = '';
    const flush = () => {
      if (atom) cur.push(atom);
      atom = '';
    };
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
        atom += text.slice(i, j + 1);
        i = j + 1;
      } else if (ch in CLOSER) {
        flush();
        i++;
        cur.push(group(ch));
      } else if (ch === close) {
        flush();
        i++;
        const trailing = !cur.length && items.length > 0;
        if (cur.length) items.push(cur);
        return { open, close, items, trailing };
      } else if (')]}'.includes(ch)) {
        throw new Error('unbalanced');
      } else if (ch === ',' && open) {
        flush();
        items.push(cur);
        cur = [];
        i++;
        while (text[i] === ' ') i++;
      } else {
        atom += ch;
        i++;
      }
    }
    if (open) throw new Error('unbalanced');
    flush();
    if (cur.length) items.push(cur);
    return { open, close, items, trailing: false };
  };
  return group('');
}

function flatPieces(pieces: Piece[]): string {
  return pieces.map((p) => (typeof p === 'string' ? p : flatGroup(p))).join('');
}

function flatGroup(g: Group): string {
  return g.open + g.items.map(flatPieces).join(', ') + (g.trailing ? ',' : '') + g.close;
}

function prettyPieces(pieces: Piece[], col: number, width: number): string {
  let out = '';
  for (const p of pieces) {
    const s = typeof p === 'string' ? p : prettyGroup(p, col, width);
    out += s;
    const nl = s.lastIndexOf('\n');
    col = nl < 0 ? col + s.length : s.length - nl - 1;
  }
  return out;
}

function prettyGroup(g: Group, col: number, width: number): string {
  const flat = flatGroup(g);
  if (col + flat.length <= width) return flat;
  const inner = col + g.open.length;
  return g.open + g.items.map((it) => prettyPieces(it, inner, width)).join(',\n' + ' '.repeat(inner)) + (g.trailing ? ',' : '') + g.close;
}

/**
 * A Python repr laid out as `pprint` does: whatever fits in `width` stays on one line, a container
 * that does not puts one element per line, aligned after its bracket. Text that is not a balanced
 * repr (a runtime cut) comes back as it was.
 */
export function prettyRepr(text: string, width = 80): string {
  if (text.length <= width || text.includes('\n')) return text;
  try {
    const top = parseRepr(text);
    return top.items.map((it) => prettyPieces(it, 0, width)).join(',');
  } catch {
    return text;
  }
}

function fenced(text: string, language: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}
