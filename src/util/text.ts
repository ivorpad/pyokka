/**
 * Pure text helpers shared by Show Value, Value Peek and watch expressions.
 * Columns are 0-based character offsets inside `line`.
 */

const IDENT = /[A-Za-z0-9_]/;

export interface ColumnSpan {
  start: number;
  end: number; // exclusive
  text: string;
}

function skipBalancedLeft(line: string, i: number): number {
  // i points at a closing bracket; returns index of the matching opener, or -1
  const close = line[i];
  const open = close === ')' ? '(' : close === ']' ? '[' : close === '}' ? '{' : '';
  if (!open) return -1;
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const c = line[j];
    if (c === close) depth++;
    else if (c === open) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function skipBalancedRight(line: string, i: number): number {
  const open = line[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '';
  if (!close) return -1;
  let depth = 0;
  let quote = '';
  for (let j = i; j < line.length; j++) {
    const c = line[j]!;
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Identifier span under `col` (also matches when the cursor sits right after the last char). */
export function identifierAt(line: string, col: number): ColumnSpan | undefined {
  let s = col;
  let e = col;
  if (!(IDENT.test(line[s] ?? '') || IDENT.test(line[s - 1] ?? ''))) return undefined;
  while (s > 0 && IDENT.test(line[s - 1]!)) s--;
  while (e < line.length && IDENT.test(line[e]!)) e++;
  if (s === e) return undefined;
  return { start: s, end: e, text: line.slice(s, e) };
}

/**
 * Expand the identifier under the cursor to the member chain that ends with it:
 * cursor on `b` in `a.b.c` gives `a.b`; on `c` gives `a.b.c`; `a.b(1).c` with the cursor
 * on `b` gives `a.b(1)`. Returns undefined when the cursor is not on an identifier.
 */
export function memberChainAt(line: string, col: number): ColumnSpan | undefined {
  const id = identifierAt(line, col);
  if (!id) return undefined;
  let start = id.start;
  // walk left through `.name` / `)` / `]` groups
  for (;;) {
    let k = start - 1;
    while (k >= 0 && (line[k] === ' ' || line[k] === '\t')) k--;
    if (k < 0 || line[k] !== '.') break;
    k--;
    while (k >= 0 && (line[k] === ' ' || line[k] === '\t')) k--;
    if (k < 0) break;
    const c = line[k]!;
    if (c === ')' || c === ']') {
      // possibly several groups: name(...)[...]
      let j = k;
      for (;;) {
        const opener = skipBalancedLeft(line, j);
        if (opener < 0) return { start, end: id.end, text: line.slice(start, id.end) };
        j = opener - 1;
        while (j >= 0 && (line[j] === ' ' || line[j] === '\t')) j--;
        if (j >= 0 && (line[j] === ')' || line[j] === ']')) continue;
        break;
      }
      if (j < 0 || !IDENT.test(line[j]!)) {
        start = skipBalancedLeft(line, k);
        break;
      }
      let s = j;
      while (s > 0 && IDENT.test(line[s - 1]!)) s--;
      start = s;
      continue;
    }
    if (IDENT.test(c)) {
      let s = k;
      while (s > 0 && IDENT.test(line[s - 1]!)) s--;
      start = s;
      continue;
    }
    break;
  }
  // include immediately following call / subscript groups
  let end = id.end;
  for (;;) {
    const c = line[end];
    if (c === '(' || c === '[') {
      const close = skipBalancedRight(line, end);
      if (close < 0) break;
      end = close + 1;
      continue;
    }
    break;
  }
  return { start, end, text: line.slice(start, end) };
}

export function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

export function truncateOneLine(text: string, max = 200): string {
  const one = text.replace(/\s*\n\s*/g, ' ');
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
