/**
 * A homogeneous collection as a table: detection and shaping, no DOM.
 *
 * A list or tuple whose loaded items are all dicts sharing their keys, or all tuples / lists
 * of one length, reads better as columns than as rows of truncated reprs. `tableFor` decides
 * and builds the model; the component (`components/ValueTable.tsx`) renders it. Cells keep
 * their node so a value can still be opened in the tree, and the footer carries the counts
 * that answer the first question a wall of dicts raises: how many rows have None or nothing in
 * a column, and how many rows are not loaded yet.
 */
import type { ValueNode, ValueProp } from '../src/shared/protocol';
import { flat, isContainer, isInstance } from './format';

export type ColumnKind = 'number' | 'string' | 'bool' | 'none' | 'mixed' | 'nested';

export interface ValueTableColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  /** tuple shape: the item position this column reads */
  position?: number;
  /** tuple shape with a dict at the position: the dict key */
  dictKey?: string;
  /** largest finite number in a numeric column, for the bars */
  max?: number;
  /** every number is within [0, 1]: bars scale to 1 instead of the max */
  unit?: boolean;
}

export interface ValueTableCell {
  text: string;
  node?: ValueNode;
  isNone: boolean;
  isEmpty: boolean;
  num?: number;
}

export interface ValueTableRow {
  index: number;
  node: ValueNode;
  /** one per column; undefined when the key is missing in this row */
  cells: (ValueTableCell | undefined)[];
}

export interface ValueTableFooter {
  rows: number;
  loadedRows: number;
  moreAvailable: boolean;
  /** the node to hand to the expand path for more elements */
  loadNode?: ValueNode;
  perColumn: { key: string; label: string; none: number; empty: number; missing: number }[];
}

export interface ValueTableModel {
  shape: 'dicts' | 'tuples';
  columns: ValueTableColumn[];
  rows: ValueTableRow[];
  footer: ValueTableFooter;
}

export const MIN_ROWS = 3;
export const MAX_KEYS = 12;
export const MIN_TUPLE = 2;
export const MAX_TUPLE = 8;
export const CELL_CHARS = 60;

const isLoad = (p: ValueProp): boolean => !!p.loadActionNode;
const loaded = (n: ValueNode): boolean => Array.isArray(n.props);
const isSeq = (n: ValueNode): boolean => n.type === 'list' || n.type === 'tuple';

/** The text of one cell: scalars as the panel prints them, containers collapsed to their size. */
export function cellText(node: ValueNode): string {
  if (node.type === 'None') return 'None';
  if (node.type === 'dict') return node.props ? (node.props.length ? `{${node.props.filter((p) => !isLoad(p)).length} keys}` : '{}') : (node.value ?? '{…}');
  if (isSeq(node) || node.type === 'set' || node.type === 'frozenset') {
    const n = node.props ? node.props.filter((p) => !isLoad(p)).length : node.length;
    const [open, close] = node.type === 'tuple' ? ['(', ')'] : node.type === 'list' ? ['[', ']'] : ['{', '}'];
    return n === undefined ? `${open}…${close}` : n === 0 ? `${open}${close}` : `${open}${n}${close}`;
  }
  const text = isInstance(node) && node.props && node.props.length > 3 ? `${node.type}(…${node.props.length})` : flat(node);
  return text.length > CELL_CHARS ? text.slice(0, CELL_CHARS - 1) + '…' : text;
}

function kindOf(node: ValueNode): ColumnKind {
  switch (node.type) {
    case 'number': return 'number';
    case 'str': return 'string';
    case 'bool': return 'bool';
    case 'None': return 'none';
    default: return isContainer(node) || isInstance(node) ? 'nested' : 'mixed';
  }
}

function toCell(node: ValueNode): ValueTableCell {
  const kind = kindOf(node);
  const empty = kind === 'nested' ? (node.props ? node.props.filter((p) => !isLoad(p)).length === 0 : node.length === 0) : node.type === 'str' && (node.value ?? '') === '';
  const cell: ValueTableCell = { text: cellText(node), node, isNone: node.type === 'None', isEmpty: !!empty };
  if (kind === 'number' && !node.nan && !node.positiveInfinity && !node.negativeInfinity) {
    const num = Number(node.value);
    if (Number.isFinite(num)) cell.num = num;
  }
  return cell;
}

/** dict keys in first-seen order when every key covers at least half the rows and there are at most MAX_KEYS */
function sharedKeys(dicts: ValueNode[]): string[] | undefined {
  const order: string[] = [];
  const count = new Map<string, number>();
  for (const d of dicts) {
    for (const p of d.props ?? []) {
      if (isLoad(p)) continue;
      if (!count.has(p.name)) order.push(p.name);
      count.set(p.name, (count.get(p.name) ?? 0) + 1);
    }
  }
  if (!order.length || order.length > MAX_KEYS) return undefined;
  const half = dicts.length / 2;
  return order.every((k) => (count.get(k) ?? 0) >= half) ? order : undefined;
}

function propNamed(dict: ValueNode, key: string): ValueProp | undefined {
  return dict.props?.find((p) => !isLoad(p) && p.name === key);
}

/** the column's kind from its cells: one kind besides None wins, None alone is `none`, anything else is `mixed` */
function settleKinds(columns: ValueTableColumn[], rows: ValueTableRow[]): void {
  columns.forEach((col, i) => {
    const kinds = new Set<ColumnKind>();
    let max = -Infinity;
    let unit = true;
    for (const r of rows) {
      const c = r.cells[i];
      if (!c?.node) continue;
      const k = kindOf(c.node);
      if (k !== 'none') kinds.add(k);
      if (c.num !== undefined) {
        max = Math.max(max, c.num);
        if (c.num < 0 || c.num > 1) unit = false;
      }
    }
    col.kind = kinds.size === 0 ? 'none' : kinds.size === 1 ? [...kinds][0]! : 'mixed';
    if (col.kind === 'number' && Number.isFinite(max) && max > 0) {
      col.max = max;
      col.unit = unit;
    }
  });
}

function footerFor(node: ValueNode, items: ValueProp[], columns: ValueTableColumn[], rows: ValueTableRow[]): ValueTableFooter {
  const load = node.props?.find(isLoad);
  const capped = !!node.cappedElements || !!node.cappedProps || node.capped === true;
  const loadNode = load ?? (capped ? ({ ...node, name: '…', loadActionNode: true, props: undefined } as ValueProp) : undefined);
  const total = node.length !== undefined && node.length >= items.length ? node.length : items.length;
  return {
    rows: total,
    loadedRows: items.length,
    moreAvailable: !!loadNode || total > items.length,
    loadNode,
    perColumn: columns.map((col, i) => {
      let none = 0;
      let empty = 0;
      let missing = 0;
      for (const r of rows) {
        const c = r.cells[i];
        if (!c) missing++;
        else if (c.isNone) none++;
        else if (c.isEmpty) empty++;
      }
      return { key: col.key, label: col.label, none, empty, missing };
    }),
  };
}

/** The table model for a homogeneous list or tuple, or undefined when a tree reads better. */
export function tableFor(node: ValueNode): ValueTableModel | undefined {
  if (!isSeq(node) || !node.props) return undefined;
  const items = node.props.filter((p) => !isLoad(p));
  if (items.length < MIN_ROWS || !items.every(loaded)) return undefined;
  let columns: ValueTableColumn[] | undefined;
  let shape: 'dicts' | 'tuples' | undefined;
  let cellsOf: ((item: ValueNode) => (ValueTableCell | undefined)[]) | undefined;

  if (items.every((p) => p.type === 'dict')) {
    const keys = sharedKeys(items);
    if (!keys) return undefined;
    shape = 'dicts';
    columns = keys.map((k) => ({ key: k, label: k, kind: 'mixed' as ColumnKind, dictKey: k }));
    cellsOf = (item) => keys.map((k) => {
      const p = propNamed(item, k);
      return p ? toCell(p) : undefined;
    });
  } else if (items.every((p) => isSeq(p))) {
    const width = items[0]!.props!.filter((q) => !isLoad(q)).length;
    if (width < MIN_TUPLE || width > MAX_TUPLE || !items.every((p) => p.props!.filter((q) => !isLoad(q)).length === width)) return undefined;
    shape = 'tuples';
    columns = [];
    const readers: ((item: ValueNode) => (ValueTableCell | undefined)[])[] = [];
    for (let pos = 0; pos < width; pos++) {
      const at = (item: ValueNode): ValueNode => item.props!.filter((q) => !isLoad(q))[pos]!;
      const cells = items.map(at);
      const keys = cells.every((c) => c.type === 'dict' && loaded(c)) ? sharedKeys(cells) : undefined;
      if (keys && keys.length) {
        for (const k of keys) columns.push({ key: `[${pos}].${k}`, label: `[${pos}].${k}`, kind: 'mixed', position: pos, dictKey: k });
        readers.push((item) => keys.map((k) => {
          const p = propNamed(at(item), k);
          return p ? toCell(p) : undefined;
        }));
      } else {
        columns.push({ key: `[${pos}]`, label: `[${pos}]`, kind: 'mixed', position: pos });
        readers.push((item) => [toCell(at(item))]);
      }
    }
    if (columns.length > MAX_KEYS + MAX_TUPLE) return undefined;
    cellsOf = (item) => readers.flatMap((r) => r(item));
  } else {
    return undefined;
  }

  const rows: ValueTableRow[] = items.map((item, index) => ({ index, node: item, cells: cellsOf!(item) }));
  settleKinds(columns, rows);
  return { shape, columns, rows, footer: footerFor(node, items, columns, rows) };
}

/** `38 rows · 31 have [0].patron None · 31 have an empty [1] · 12 more not loaded` */
export function footerText(model: ValueTableModel): string {
  const f = model.footer;
  const parts = [f.loadedRows < f.rows ? `${f.rows} rows (${f.loadedRows} loaded)` : `${f.rows} rows`];
  for (const c of f.perColumn) {
    if (c.none) parts.push(`${c.none} have ${c.label} None`);
    if (c.empty) parts.push(`${c.empty} have an empty ${c.label}`);
    if (c.missing) parts.push(`${c.missing} lack ${c.label}`);
  }
  if (f.moreAvailable) parts.push(f.rows > f.loadedRows ? `${f.rows - f.loadedRows} more not loaded` : 'more not loaded');
  return parts.join(' · ');
}

/** Rows sorted by one column: numbers numerically, strings by locale, None and missing cells last; `dir` -1 reverses the values, not the None rule. */
export function sortRows(rows: ValueTableRow[], column: number, dir: 1 | -1): ValueTableRow[] {
  const rank = (r: ValueTableRow): number => {
    const c = r.cells[column];
    return !c ? 2 : c.isNone ? 1 : 0;
  };
  const cmp = (a: ValueTableRow, b: ValueTableRow): number => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra !== 0) return a.index - b.index;
    const ca = a.cells[column]!;
    const cb = b.cells[column]!;
    let d = 0;
    if (ca.num !== undefined && cb.num !== undefined) d = ca.num - cb.num;
    else if (ca.node?.type === 'bool' && cb.node?.type === 'bool') d = Number(ca.text === 'True') - Number(cb.text === 'True');
    else d = ca.text.localeCompare(cb.text, undefined, { numeric: true });
    return d !== 0 ? d * dir : a.index - b.index;
  };
  return [...rows].sort(cmp);
}

/** `list · 38 × (dict, dict)` / `list · 5 × dict`: the caption's shape part */
export function shapeLabel(node: ValueNode, model: ValueTableModel): string {
  const items = model.rows.map((r) => r.node);
  const inner = model.shape === 'dicts' ? 'dict' : `(${items[0]!.props!.filter((p) => !p.loadActionNode).map((p) => p.type).join(', ')})`;
  return `${node.type} · ${model.footer.rows} × ${inner}`;
}
