/**
 * What a source file's statements *are*, for the walkthrough: decisions, loops, returns,
 * qualified names. The host has no Python parser, so this reads indentation and the
 * statement ranges of `file.instrumented`; `python/pyokka_runtime/agent/decisions.py` is the
 * `ast` version and `test/unit/fixtures/walkthrough-*` pins both to the same moments.
 *
 * Shapes (1-based lines):
 * - `decisions` by header line: `if`/`elif` `{kind: 'if', label, line, text, body: [first, last],
 *   orelse: [first, last]}` (`orelse` is the `else` block, or the `elif` header through the end of
 *   the chain, like Python's `_span(node.orelse)`; `[0, 0]` without one), `match` `{kind: 'match',
 *   line, text, arms: [{text, body}]}`.
 * - `loops` by header line: `{kind: 'for' | 'while', line, text, end}`.
 * - `returns`: lines holding a `return` statement.
 * - `qualnames` by `def` line: `Class.method`; `functions` by `def` line: `{name, line, end}`.
 */
import type { Range4 } from '../shared/protocol';

export const WORD_CUT = 60;

export interface IfDecision {
  kind: 'if';
  label: 'if' | 'elif';
  line: number;
  text: string;
  body: [number, number];
  /** the else arm: the `else` block, or the `elif` header through the end of the chain; [0, 0] without one */
  orelse: [number, number];
}
export interface MatchDecision {
  kind: 'match';
  line: number;
  text: string;
  arms: { text: string; body: [number, number] }[];
}
export type Decision = IfDecision | MatchDecision;
export interface Loop {
  kind: 'for' | 'while';
  line: number;
  text: string;
  end: number;
}
export interface FunctionSpan {
  name: string;
  line: number;
  end: number;
}
export interface FileMap {
  decisions: Map<number, Decision>;
  loops: Map<number, Loop>;
  returns: Set<number>;
  qualnames: Map<number, string>;
  functions: Map<number, FunctionSpan>;
}

/** Whitespace runs to one space, cut at `limit` with an ellipsis (Python's `collapse`). */
export function collapse(text: string, limit = WORD_CUT): string {
  const s = text.trim().split(/\s+/).join(' ');
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function hasCode(line: string): boolean {
  const t = line.trim();
  return t !== '' && !t.startsWith('#');
}

/** Text of a range, lines joined by a space, before whitespace collapsing. */
function rangeText(lines: string[], r: Range4): string {
  const [a, ca, b, cb] = r;
  if (a === b) return (lines[a - 1] ?? '').slice(ca, cb);
  const parts = [(lines[a - 1] ?? '').slice(ca), ...lines.slice(a, b - 1), (lines[b - 1] ?? '').slice(0, cb)];
  return parts.join(' ');
}

/** Strip parentheses that wrap the whole text (`((a))` -> `a`, `(a) and (b)` unchanged), like the AST does. */
function unwrap(text: string): string {
  let s = text.trim();
  // the header range ends where the test node ends: inside the parentheses of `if (a and\n b):`
  let balance = (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
  while (balance > 0 && s.startsWith('(')) {
    s = s.slice(1).trim();
    balance--;
  }
  for (;;) {
    if (!s.startsWith('(') || !s.endsWith(')')) return s;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0 && i < s.length - 1) return s;
      }
    }
    s = s.slice(1, -1).trim();
  }
}

/** Last line with code before the next line with code at `indent` or less, starting after `from`. */
function blockEnd(lines: string[], from: number, indent: number): number {
  let end = from;
  for (let l = from + 1; l <= lines.length; l++) {
    const text = lines[l - 1] ?? '';
    if (!hasCode(text)) continue;
    if (indentOf(text) <= indent) break;
    end = l;
  }
  return end;
}

const KEYWORDS: Record<string, 'if' | 'elif' | 'for' | 'while' | 'match'> = { if: 'if', elif: 'elif', for: 'for', while: 'while', match: 'match' };

function keywordOf(text: string): { keyword: 'if' | 'elif' | 'for' | 'while' | 'match'; rest: string } | undefined {
  const m = /^(async\s+)?([a-z]+)\b/.exec(text);
  if (!m) return undefined;
  const kw = m[2]!;
  if (!(kw in KEYWORDS)) return undefined;
  if (m[1] && kw !== 'for') return undefined;
  // `match` / soft keywords: only a compound header (ends with `:` after the range) counts
  return { keyword: KEYWORDS[kw]!, rest: text.slice(m[0].length) };
}

/** Build the map from the source lines and the file's statement ranges (source order). */
export function fileMap(lines: string[], statements: Range4[]): FileMap {
  const out: FileMap = { decisions: new Map(), loops: new Map(), returns: new Set(), qualnames: new Map(), functions: new Map() };
  const sorted = [...statements].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const firstStatementAfter = (line: number, col: number): number => {
    for (const r of sorted) if (r[0] > line && r[1] > col) return r[0];
    return 0;
  };
  const nextCodeLine = (after: number): number => {
    for (let l = after + 1; l <= lines.length; l++) if (hasCode(lines[l - 1] ?? '')) return l;
    return 0;
  };
  // the else arm of an `if` whose body ends at `bodyLast`: an `else` block, or an `elif` header
  // through the end of the whole chain (Python's `_end(orelse[-1])`)
  const elseArm = (bodyLast: number, indent: number): [number, number] => {
    if (!bodyLast) return [0, 0];
    let first = 0;
    let end = bodyLast;
    for (;;) {
      const l = nextCodeLine(end);
      if (!l) break;
      const text = lines[l - 1] ?? '';
      if (indentOf(text) !== indent) break;
      const t = text.trim();
      if (/^else\s*:/.test(t)) {
        if (!first) first = firstStatementAfter(l, indent);
        end = Math.max(l, blockEnd(lines, l, indent));
        break;
      }
      if (!/^elif\b/.test(t)) break;
      if (!first) first = l;
      const header = sorted.find((r) => r[0] === l);
      end = Math.max(l, blockEnd(lines, header ? header[2] : l, indent));
    }
    return first ? [first, Math.max(first, end)] : [0, 0];
  };
  for (let l = 1; l <= lines.length; l++) {
    const text = lines[l - 1] ?? '';
    if (!hasCode(text)) continue;
    const indent = indentOf(text);
    const stripped = text.trim();
    const def = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(stripped);
    if (def) {
      const classes: string[] = [];
      let cur = indent;
      for (let k = l - 1; k >= 1 && cur > 0; k--) {
        const t = lines[k - 1] ?? '';
        if (!hasCode(t) || indentOf(t) >= cur) continue;
        cur = indentOf(t);
        const cls = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t.trim());
        if (cls) classes.unshift(cls[1]!);
      }
      const name = [...classes, def[1]!].join('.');
      out.qualnames.set(l, name);
      out.functions.set(l, { name, line: l, end: blockEnd(lines, l, indent) });
      continue;
    }
  }
  for (const r of sorted) {
    const [line, col] = r;
    const text = (lines[line - 1] ?? '').slice(col);
    if (/^return\b/.test(text)) out.returns.add(line);
    const kw = keywordOf(text);
    if (!kw) continue;
    const header = rangeText(lines, r);
    const rest = header.replace(/^(async\s+)?[a-z]+\s*/, '');
    const indent = indentOf(lines[line - 1] ?? '');
    const bodyFirst = firstStatementAfter(r[2], col);
    const bodyLast = bodyFirst ? blockEnd(lines, r[2], indent) : 0;
    const body: [number, number] = bodyFirst ? [bodyFirst, Math.max(bodyFirst, bodyLast)] : [0, 0];
    if (kw.keyword === 'if' || kw.keyword === 'elif') {
      out.decisions.set(line, { kind: 'if', label: kw.keyword, line, text: collapse(unwrap(rest)), body, orelse: elseArm(bodyLast, indent) });
    } else if (kw.keyword === 'while') {
      out.loops.set(line, { kind: 'while', line, text: collapse(unwrap(rest)), end: Math.max(line, bodyLast) });
    } else if (kw.keyword === 'for') {
      out.loops.set(line, { kind: 'for', line, text: collapse(rest), end: Math.max(line, bodyLast) });
    } else {
      const arms: MatchDecision['arms'] = [];
      const end = Math.max(line, bodyLast);
      for (let l = r[2] + 1; l <= end; l++) {
        const t = lines[l - 1] ?? '';
        if (!hasCode(t) || indentOf(t) <= indent) continue;
        const caseLine = /^case\s+(.*?):\s*(#.*)?$/.exec(t.trim());
        if (!caseLine) continue;
        const caseIndent = indentOf(t);
        let pattern = caseLine[1]!;
        const guard = / if /.exec(pattern);
        if (guard) pattern = pattern.slice(0, guard.index);
        const first = firstStatementAfter(l, caseIndent);
        const last = first ? blockEnd(lines, l, caseIndent) : 0;
        arms.push({ text: collapse(unwrap(pattern)), body: first ? [first, Math.max(first, last)] : [0, 0] });
      }
      out.decisions.set(line, { kind: 'match', line, text: collapse(unwrap(rest)), arms });
    }
  }
  return out;
}

/** The innermost function whose span holds `line` (undefined at module level). */
export function enclosingFunction(map: FileMap, line: number): FunctionSpan | undefined {
  let best: FunctionSpan | undefined;
  for (const fn of map.functions.values()) if (fn.line <= line && line <= fn.end && (!best || fn.end - fn.line <= best.end - best.line)) best = fn;
  return best;
}
