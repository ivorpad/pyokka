/** Entry selection semantics: click, shift-click range, cmd/ctrl-click toggle, arrow keys. */

export interface Selection {
  ids: string[];
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null };

export interface ClickModifiers {
  shift?: boolean;
  meta?: boolean;
}

export function selectClick(order: string[], sel: Selection, id: string, mods: ClickModifiers): Selection {
  if (mods.shift && sel.anchor) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return { ids: order.slice(lo, hi + 1), anchor: sel.anchor };
    }
  }
  if (mods.meta) {
    const ids = sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id];
    return { ids, anchor: id };
  }
  if (sel.ids.length === 1 && sel.ids[0] === id) return EMPTY_SELECTION;
  return { ids: [id], anchor: id };
}

export function selectMove(order: string[], sel: Selection, delta: -1 | 1, extend: boolean): Selection {
  if (order.length === 0) return sel;
  const focusId = sel.ids[sel.ids.length - 1] ?? sel.anchor;
  const current = focusId ? order.indexOf(focusId) : -1;
  const next = current < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, current + delta));
  const id = order[next] as string;
  if (extend && sel.anchor) return selectClick(order, sel, id, { shift: true });
  return { ids: [id], anchor: id };
}

/** drop ids that no longer exist */
export function pruneSelection(order: string[], sel: Selection): Selection {
  const set = new Set(order);
  const ids = sel.ids.filter((id) => set.has(id));
  if (ids.length === sel.ids.length) return sel;
  return { ids, anchor: sel.anchor && set.has(sel.anchor) ? sel.anchor : ids[0] ?? null };
}

/** order the selected ids by their position in `order` */
export function orderedSelection(order: string[], sel: Selection): string[] {
  const set = new Set(sel.ids);
  return order.filter((id) => set.has(id));
}
