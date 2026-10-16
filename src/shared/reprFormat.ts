/**
 * A Python `repr` as indented lines, the way the Details pane prints a logged value: a bracket
 * group that does not fit in `width` opens with one item per line, four spaces deeper. It works on
 * the text alone, because a recorded local carries no value tree. A cut repr keeps its tail
 * (`…(+18 chars)`, `…(cut)`) after the last line, and a group the cut left open gets no closer.
 * Pure and vscode-free: the hover and the webview share it.
 */

type Part = string | Group;

interface Group {
  open: string;
  items: Part[][];
  /** '' when the text ended before the group closed */
  close: string;
  /** `(1,)`: a one-item tuple keeps its comma */
  trailing: boolean;
}

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CUT_TAIL = /…(?:\(\+[\d,]+ chars\)|\(cut\))$/;

export function formatRepr(text: string, width = 80): string {
  const tail = CUT_TAIL.exec(text)?.[0] ?? '';
  const body = tail ? text.slice(0, -tail.length) : text;
  const { items } = parse(body, 0, undefined);
  return render(items[0] ?? [], 0, width) + tail;
}

/** The index after the string literal that opens at `i`; the text's end when the cut left it open. */
function stringEnd(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === q) return j + 1;
  }
  return s.length;
}

function parse(s: string, start: number, closer: string | undefined): { items: Part[][]; i: number; closed: boolean } {
  const items: Part[][] = [];
  let cur: Part[] = [];
  let buf = '';
  const flush = () => {
    if (buf) cur.push(buf);
    buf = '';
  };
  let i = start;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const j = stringEnd(s, i);
      buf += s.slice(i, j);
      i = j;
    } else if (CLOSER[c]) {
      flush();
      const inner = parse(s, i + 1, CLOSER[c]);
      const last = inner.items[inner.items.length - 1];
      const trailing = inner.items.length > 1 && last !== undefined && last.length === 0;
      if (trailing || (inner.items.length === 1 && inner.items[0]!.length === 0)) inner.items.pop();
      cur.push({ open: c, items: inner.items, close: inner.closed ? CLOSER[c]! : '', trailing });
      i = inner.i;
    } else if (closer !== undefined && c === closer) {
      flush();
      items.push(cur);
      return { items, i: i + 1, closed: true };
    } else if (closer !== undefined && c === ',') {
      flush();
      items.push(cur);
      cur = [];
      i++;
      while (s[i] === ' ') i++;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  items.push(cur);
  return { items, i, closed: false };
}

function flat(parts: Part[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : flatGroup(p))).join('');
}

function flatGroup(g: Group): string {
  return g.open + g.items.map(flat).join(', ') + (g.trailing ? ',' : '') + g.close;
}

function render(parts: Part[], indent: number, width: number): string {
  if (indent + flat(parts).length <= width) return flat(parts);
  return parts.map((p) => (typeof p === 'string' ? p : renderGroup(p, indent, width))).join('');
}

function renderGroup(g: Group, indent: number, width: number): string {
  const one = flatGroup(g);
  if (indent + one.length <= width || g.items.length === 0) return one;
  const pad = ' '.repeat(indent + 4);
  const body = g.items.map((item) => pad + render(item, indent + 4, width)).join(',\n') + (g.trailing ? ',' : '');
  return g.close ? `${g.open}\n${body}\n${' '.repeat(indent)}${g.close}` : `${g.open}\n${body}`;
}
