/**
 * Lines edited since the last run snapshot (1-based, in current document coordinates).
 * Inline values on those lines belong to code that no longer exists, so the decorator hides
 * them until the next run; untouched lines keep their values (Quokka's sticky behaviour).
 */
import type { EditDelta } from './markers';

/** Apply one content change: shift lines after it, mark the touched lines dirty. Returns the new set. */
export function applyEditToDirtyLines(dirty: ReadonlySet<number>, delta: EditDelta): Set<number> {
  const inserted = (delta.text.match(/\n/g) ?? []).length;
  const removed = delta.endLine - delta.startLine;
  const shift = inserted - removed;
  const out = new Set<number>();
  for (const line of dirty) {
    if (line < delta.startLine) out.add(line);
    else if (line > delta.endLine) out.add(line + shift);
    // lines inside the replaced span are re-marked below
  }
  for (let l = delta.startLine; l <= delta.startLine + inserted; l++) out.add(l);
  return out;
}
