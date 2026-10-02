/**
 * Sticky Show Value / timing markers, remapped through document edits.
 * Pure: no vscode import so it is unit-testable.
 */
import type { Marker, MarkerKind, Range4 } from '../shared/protocol';

export type MarkerOrigin = 'showValue' | 'selection' | 'lineValues' | 'lineTimings' | 'transient' | 'logpoint' | 'story';

export interface SessionMarker extends Marker {
  origin: MarkerOrigin;
  /** bumped every time the marker's own text changes, so old values are not shown for new code */
  changeId: string;
  /** transient markers (hover / copy) are not rendered inline */
  transient?: boolean;
}

/** A content change in protocol coordinates (1-based lines, 0-based cols). */
export interface EditDelta {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
}

function cmp(l1: number, c1: number, l2: number, c2: number): number {
  return l1 !== l2 ? l1 - l2 : c1 - c2;
}

function shiftAfter(delta: EditDelta, line: number, col: number): [number, number] {
  // position strictly after the edited region
  const inserted = delta.text.split('\n');
  const addedLines = inserted.length - 1;
  const removedLines = delta.endLine - delta.startLine;
  const lineDelta = addedLines - removedLines;
  if (line !== delta.endLine) return [line + lineDelta, col];
  const lastLen = inserted[inserted.length - 1]!.length;
  const newCol = addedLines === 0 ? delta.startCol + lastLen + (col - delta.endCol) : lastLen + (col - delta.endCol);
  return [line + lineDelta, newCol];
}

/**
 * Remap one range through an edit. Returns the new range and whether the marker's own
 * text changed (edit inside it), or `undefined` when the edit destroyed the range.
 */
export function remapRange(range: Range4, delta: EditDelta): { range: Range4; changed: boolean } | undefined {
  const [sl, sc, el, ec] = range;
  // edit entirely after the marker
  if (cmp(delta.startLine, delta.startCol, el, ec) >= 0) return { range, changed: false };
  // edit entirely before the marker
  if (cmp(delta.endLine, delta.endCol, sl, sc) <= 0) {
    const [nsl, nsc] = shiftAfter(delta, sl, sc);
    const [nel, nec] = shiftAfter(delta, el, ec);
    return { range: [nsl, nsc, nel, nec], changed: false };
  }
  // edit fully inside the marker: keep start, move end
  if (cmp(delta.startLine, delta.startCol, sl, sc) >= 0 && cmp(delta.endLine, delta.endCol, el, ec) <= 0) {
    const [nel, nec] = shiftAfter(delta, el, ec);
    if (cmp(nel, nec, sl, sc) <= 0) return undefined;
    return { range: [sl, sc, nel, nec], changed: true };
  }
  // overlap across a boundary: the expression no longer exists as written
  return undefined;
}

let changeCounter = 0;
export function nextChangeId(): string {
  return `c-${++changeCounter}-${Date.now().toString(36)}`;
}

export class MarkerStore {
  private markers: SessionMarker[] = [];
  private idCounter = 0;

  all(): readonly SessionMarker[] {
    return this.markers;
  }

  visible(): SessionMarker[] {
    return this.markers.filter((m) => !m.transient);
  }

  /** Markers sent to the runner (all of them; transient ones simply are not drawn). */
  forRun(): Marker[] {
    return this.markers.map(({ origin: _o, transient: _t, ...m }) => m);
  }

  add(init: { kind: MarkerKind; range: Range4; origin: MarkerOrigin; context?: string; exp?: string | null; autoExpand?: boolean; logMessage?: string; transient?: boolean; id?: string }): SessionMarker {
    const marker: SessionMarker = {
      id: init.id ?? `m-${++this.idCounter}`,
      kind: init.kind,
      range: init.range,
      origin: init.origin,
      context: init.context,
      exp: init.exp ?? null,
      autoExpand: init.autoExpand ?? false,
      logMessage: init.logMessage,
      changeId: nextChangeId(),
      transient: init.transient,
    };
    this.markers.push(marker);
    return marker;
  }

  remove(id: string): boolean {
    const before = this.markers.length;
    this.markers = this.markers.filter((m) => m.id !== id);
    return this.markers.length !== before;
  }

  removeWhere(pred: (m: SessionMarker) => boolean): number {
    const before = this.markers.length;
    this.markers = this.markers.filter((m) => !pred(m));
    return before - this.markers.length;
  }

  clear(): void {
    this.markers = [];
  }

  /** Markers whose range touches `line` (1-based). */
  onLine(line: number): SessionMarker[] {
    return this.markers.filter((m) => !m.transient && m.range[0] <= line && m.range[2] >= line);
  }

  byId(id: string): SessionMarker | undefined {
    return this.markers.find((m) => m.id === id);
  }

  /** Apply document edits (in the order VS Code reports them: already sorted descending by position). */
  applyEdits(deltas: EditDelta[]): { changed: boolean } {
    let changed = false;
    for (const delta of deltas) {
      const next: SessionMarker[] = [];
      for (const m of this.markers) {
        const r = remapRange(m.range, delta);
        if (!r) {
          changed = true;
          continue;
        }
        if (r.range !== m.range) {
          if (r.changed) {
            changed = true;
            next.push({ ...m, range: r.range, changeId: nextChangeId() });
          } else next.push({ ...m, range: r.range });
        } else next.push(m);
      }
      this.markers = next;
    }
    return { changed };
  }
}
