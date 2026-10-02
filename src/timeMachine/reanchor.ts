/**
 * Edit-and-continue: re-anchor the current step after the file re-ran with new source.
 * Primary key: (normalised statement text, occurrence index). Fallback: line diff mapping.
 */
import { diffLines } from 'diff';

export interface AnchorTrace {
  count: number;
  /** statement source text for step i (undefined when unknown) */
  textAt(i: number): string | undefined;
  /** 1-based line of step i in the main file, -1 for other files */
  lineAt(i: number): number;
}

export function normaliseStatement(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.replace(/\s+/g, ' ').trim();
}

/** Map old line numbers (1-based) to new line numbers; unmapped lines return -1. */
export function lineMapping(oldText: string, newText: string): (oldLine: number) => number {
  if (oldText === newText) return (l) => l;
  const changes = diffLines(oldText, newText);
  const map = new Map<number, number>();
  let o = 1;
  let n = 1;
  for (const ch of changes) {
    const count = ch.count ?? ch.value.split('\n').length - (ch.value.endsWith('\n') ? 1 : 0);
    if (ch.added) n += count;
    else if (ch.removed) o += count;
    else {
      for (let k = 0; k < count; k++) map.set(o + k, n + k);
      o += count;
      n += count;
    }
  }
  return (l) => map.get(l) ?? -1;
}

/**
 * Returns the step in `next` corresponding to `oldStep` in `prev`, or -1 when `next` is empty.
 */
export function reanchorStep(prev: AnchorTrace, next: AnchorTrace, oldStep: number, oldSource: string, newSource: string): number {
  if (next.count === 0) return -1;
  if (prev.count === 0 || oldStep < 0) return 0;
  const step = Math.min(oldStep, prev.count - 1);
  const key = normaliseStatement(prev.textAt(step));
  if (key) {
    let occurrence = 0;
    for (let j = 0; j < step; j++) if (normaliseStatement(prev.textAt(j)) === key) occurrence++;
    let seen = 0;
    let last = -1;
    for (let j = 0; j < next.count; j++) {
      if (normaliseStatement(next.textAt(j)) === key) {
        if (seen === occurrence) return j;
        seen++;
        last = j;
      }
    }
    if (last >= 0) return last;
  }
  // fallback: line mapping
  const oldLine = prev.lineAt(step);
  if (oldLine > 0) {
    const mapped = lineMapping(oldSource, newSource)(oldLine);
    if (mapped > 0) {
      let occurrence = 0;
      for (let j = 0; j < step; j++) if (prev.lineAt(j) === oldLine) occurrence++;
      let seen = 0;
      let last = -1;
      for (let j = 0; j < next.count; j++) {
        if (next.lineAt(j) === mapped) {
          if (seen === occurrence) return j;
          seen++;
          last = j;
        }
      }
      if (last >= 0) return last;
    }
  }
  return Math.min(step, next.count - 1);
}
