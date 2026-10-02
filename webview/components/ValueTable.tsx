/**
 * A homogeneous collection rendered as a table (model from `../valueTable.ts`): one column per
 * shared key or tuple position, the current loop item marked, numeric columns with a bar,
 * sortable headers, and a footer with the counts that matter. Cells and row numbers are links
 * back into the value tree; the load action of a capped list stays reachable.
 */
import { useState } from 'preact/hooks';
import type { ValueNode } from '../../src/shared/protocol';
import { footerText, sortRows, type ValueTableModel, type ValueTableRow } from '../valueTable';
import { Repr } from './ui';

export interface ValueTableProps {
  model: ValueTableModel;
  /** `parent_items · list · 38 × (dict, dict)` */
  caption?: string;
  /** the row to mark with ▶ (the loop's current item) */
  markIndex?: number;
  /** the row number was clicked: show that item in the tree */
  onOpenRow?: (row: ValueTableRow) => void;
  /** a cell was clicked: its node, and the row it belongs to */
  onOpenCell?: (node: ValueNode, row: ValueTableRow) => void;
  /** the footer's load action */
  onLoadMore?: (node: ValueNode) => void;
  /** the "list" side of the view toggle */
  onShowList?: () => void;
}

const BAR_PX = 48;

export function ValueTable({ model, caption, markIndex, onOpenRow, onOpenCell, onLoadMore, onShowList }: ValueTableProps) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = sort ? sortRows(model.rows, sort.col, sort.dir) : model.rows;
  const clickHeader = (col: number) => {
    if (!sort || sort.col !== col) setSort({ col, dir: 1 });
    else if (sort.dir === 1) setSort({ col, dir: -1 });
    else setSort(null);
  };
  const foot = footerText(model);
  return (
    <div class="pk-vtable">
      {(caption || onShowList) && (
        <div class="pk-vtable-head">
          {caption && <span class="pk-vtable-caption">{caption}</span>}
          <span class="pk-vtable-view" role="group" aria-label="View as">
            <button type="button" class="pk-vtable-toggle on" aria-pressed="true">table</button>
            <button type="button" class="pk-vtable-toggle" aria-pressed="false" onClick={onShowList} disabled={!onShowList}>list</button>
          </span>
        </div>
      )}
      <table class="pk-vtable-grid" aria-label={caption ?? 'table'}>
        <thead>
          <tr>
            <th scope="col" class="pk-vtable-idx">#</th>
            {model.columns.map((c, i) => {
              const active = sort?.col === i;
              return (
                <th scope="col" key={c.key} class={`kind-${c.kind}${active ? ' sorted' : ''}`} aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none'} onClick={() => clickHeader(i)} title="Sort by this column">
                  {c.label}
                  {active && <span class="pk-vtable-sort">{sort!.dir === 1 ? '▲' : '▼'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cur = row.index === markIndex;
            return (
              <tr key={row.index} class={cur ? 'cur' : undefined} aria-current={cur ? 'true' : undefined}>
                <td class="pk-vtable-idx">
                  <button type="button" class="pk-vtable-cellbtn" onClick={() => onOpenRow?.(row)} title="Show this item in the tree">
                    {cur ? '▶ ' : ''}{row.index}
                  </button>
                </td>
                {model.columns.map((col, i) => {
                  const c = row.cells[i];
                  if (!c) return <td key={col.key} class="pk-vtable-cell missing">—</td>;
                  const bar = col.max !== undefined && c.num !== undefined && c.num >= 0 ? Math.round((c.num / (col.unit ? 1 : col.max)) * BAR_PX) : undefined;
                  return (
                    <td key={col.key} class={`pk-vtable-cell kind-${col.kind}${c.isNone ? ' is-none' : ''}${c.isEmpty ? ' is-empty' : ''}`}>
                      {bar !== undefined && <span class="pk-vtable-bar" style={{ width: `${bar}px` }} aria-hidden="true" />}
                      <button type="button" class="pk-vtable-cellbtn" onClick={() => c.node && onOpenCell?.(c.node, row)} title="Show in the tree">
                        {col.kind === 'nested' || c.isNone ? <span class={c.isNone ? 'pk-vtable-none' : 'pk-vtable-nested'}>{c.text}</span> : <Repr text={c.text} />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div class="pk-vtable-foot">
        {foot}
        {model.footer.loadNode && onLoadMore && (
          <>
            {' · '}
            <button type="button" class="pk-vtable-load" onClick={() => onLoadMore(model.footer.loadNode!)}>load more</button>
          </>
        )}
      </div>
    </div>
  );
}
