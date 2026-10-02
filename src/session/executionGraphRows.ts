/**
 * Row helpers of the execution graph builder: moment sentences to `raised` / `print` rows, the
 * dedupe and the 12-row cut, a decision's untaken arms, and a sorted-array upper bound.
 */
import type { MomentBuilder } from './moments';
import { ROWS_MAX, type GraphRow } from './executionGraphTypes';

/** `raised ValueError: too small, handled at main.py:49` -> the type and the message. */
export function parseRaised(text: string): { name: string; text: string } {
  let s = text.startsWith('raised ') ? text.slice('raised '.length) : text;
  if (s.endsWith(' uncaught')) s = s.slice(0, -' uncaught'.length);
  else if (s.endsWith(' (handled)')) s = s.slice(0, -' (handled)'.length);
  else {
    const i = s.lastIndexOf(', handled at ');
    if (i >= 0) s = s.slice(0, i);
  }
  return splitRaised(s);
}

export function splitRaised(s: string): { name: string; text: string } {
  const i = s.indexOf(': ');
  return i >= 0 ? { name: s.slice(0, i), text: s.slice(i + 2) } : { name: s, text: '' };
}

/** `prints to stderr x` / `prints x` -> the stream and the text. */
export function parsePrint(text: string): { name: string; text: string } {
  if (text.startsWith('prints to stderr ')) return { name: 'stderr', text: text.slice('prints to stderr '.length) };
  return { name: 'stdout', text: text.startsWith('prints ') ? text.slice('prints '.length) : text };
}

/** Duplicates (kind, name, text) kept once in order; over ROWS_MAX the `in` rows go first, from the end. */
export function finishRows(rows: GraphRow[]): { rows: GraphRow[]; truncated: boolean } {
  const seen = new Set<string>();
  const out: GraphRow[] = [];
  for (const r of rows) {
    const k = `${r.kind} ${r.name} ${r.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  let truncated = false;
  if (out.length > ROWS_MAX) {
    // a long parameter list must not push the result or the exception off the card: drop `in` rows first
    truncated = true;
    while (out.length > ROWS_MAX && out.some((r) => r.kind === 'in')) {
      let lastIn = -1;
      out.forEach((r, i) => r.kind === 'in' && (lastIn = i));
      out.splice(lastIn, 1);
    }
  }
  return { rows: out.slice(0, ROWS_MAX), truncated };
}

/** The first line of every arm the decision never took (rule 6). */
export function notRun(builder: MomentBuilder, dec: { loop: boolean; fileId: number; line: number; takens: Set<string> }): number[] {
  if (dec.loop) return [];
  const entry = builder.fileMapOf(dec.fileId).decisions.get(dec.line);
  if (!entry) return [];
  if (entry.kind === 'match') return entry.arms.filter((a) => !dec.takens.has(`case ${a.text}`)).map((a) => a.body[0]);
  const t = dec.takens.has('True');
  const f = dec.takens.has('False');
  if (t && f) return [];
  if (f) return entry.body[0] ? [entry.body[0]] : [];
  if (t) return entry.orelse[0] ? [entry.orelse[0]] : [];
  return [];
}

export function upperBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
