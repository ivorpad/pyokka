/** ENTRIES pane: list / tree modes, filter, display menu, selection and keyboard handling. */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Entry } from '../model';
import { lineKey } from '../model';
import { orderedSelection, selectClick, selectMove, type Selection } from '../selection';
import type { UiPrefs } from '../vscode';
import { Checkbox, Icon, IconButton, Menu, MenuButton, Repr, SourceLink, type MenuItem } from './ui';

export interface EntriesProps {
  entries: Entry[];
  /** shown instead of "NO LOGS OR ERRORS" (a run in flight) */
  emptyText?: string;
  /** a notice about the run shown above the entries (the run timed out) */
  notice?: ComponentChildren;
  /** entries before filtering, for the filter dropdown */
  allEntries: Entry[];
  hiddenLines: Set<string>;
  filterMode: boolean;
  selection: Selection;
  prefs: UiPrefs;
  onSelect: (sel: Selection) => void;
  onPrefs: (patch: Partial<UiPrefs>) => void;
  onFilter: (hidden: Set<string>) => void;
  /** show / hide the given line keys (safe under rapid clicks) */
  onFilterToggle: (keys: string[], visible: boolean) => void;
  onFilterMode: (on: boolean) => void;
  onOpen: (e: Entry, sideView: boolean) => void;
  /** the row's "Why" button: the provenance of the entry's value (of its statement, when the context is not a name) */
  onWhy: (e: Entry) => void;
  onFocusDetails: () => void;
  onCopy: (text: string) => void;
  title?: string;
  /** changes when the host asks to scroll the selection into view */
  revealSelection?: number;
}

const KIND_ICON: Record<string, string> = {
  log: 'output',
  value: 'symbol-variable',
  autoLog: 'symbol-variable',
  autoExpand: 'symbol-variable',
  time: 'watch',
  logpoint: 'debug-breakpoint-log',
  system: 'info',
  error: 'error',
};

export function Entries(props: EntriesProps) {
  const { entries, selection, prefs } = props;
  const order = useMemo(() => entries.map((e) => e.logId), [entries]);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [filterOpen, setFilterOpen] = useState(false);

  // auto-scroll when new entries arrive and the user was at the bottom
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  useEffect(() => {
    if (!props.revealSelection) return;
    const id = selection.ids[0];
    if (!id) return;
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [props.revealSelection]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  };

  const click = (id: string, ev: MouseEvent) => {
    props.onSelect(selectClick(order, selection, id, { shift: ev.shiftKey, meta: ev.metaKey || ev.ctrlKey }));
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      props.onSelect(selectMove(order, selection, ev.key === 'ArrowDown' ? 1 : -1, ev.shiftKey));
      const focusId = selection.ids[selection.ids.length - 1];
      const idx = focusId ? order.indexOf(focusId) : -1;
      const next = Math.max(0, Math.min(order.length - 1, idx + (ev.key === 'ArrowDown' ? 1 : -1)));
      listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(order[next] ?? '')}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      props.onSelect({ ids: [], anchor: null });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      props.onFocusDetails();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'c') {
      const ids = new Set(selection.ids);
      const text = entries.filter((e) => ids.has(e.logId)).map((e) => e.text).join('\n');
      if (text) {
        ev.preventDefault();
        props.onCopy(text);
      }
    }
  };

  const menuItems = (): MenuItem[] => [
    { label: 'Display log kind icon for items', toggle: true, checked: prefs.showKindIcon, onSelect: () => props.onPrefs({ showKindIcon: !prefs.showKindIcon }) },
    { label: 'Display file name in source links', toggle: true, checked: prefs.showFileName, onSelect: () => props.onPrefs({ showFileName: !prefs.showFileName }) },
    { label: 'Display value context when available', toggle: true, checked: prefs.showContext, onSelect: () => props.onPrefs({ showContext: !prefs.showContext }) },
    { label: 'Clear selection', hint: 'Escape', separatorAbove: true, disabled: selection.ids.length === 0, onSelect: () => props.onSelect({ ids: [], anchor: null }) },
  ];

  const selectedSet = new Set(selection.ids);

  return (
    <section class="pk-pane pk-entries" aria-label="Entries">
      <header class="pk-pane-header">
        <span class="pk-pane-title">
          {props.title ?? 'ENTRIES'} <span class="pk-count">{entries.length}</span>
        </span>
        <span class="pk-toolbar">
          <IconButton icon="list-selection" title="List with details" active={prefs.entriesMode === 'list'} onClick={() => props.onPrefs({ entriesMode: 'list' })} />
          <IconButton icon="list-tree" title="Tree by file and line" active={prefs.entriesMode === 'tree'} onClick={() => props.onPrefs({ entriesMode: 'tree' })} />
          <span class="pk-menu-anchor">
            <IconButton
              icon="filter"
              title="Filter entries"
              active={props.filterMode || props.hiddenLines.size > 0 || filterOpen}
              onClick={() => {
                if (prefs.entriesMode === 'tree') props.onFilterMode(!props.filterMode);
                else setFilterOpen((o) => !o);
              }}
            />
            {filterOpen && <FilterMenu entries={props.allEntries} hidden={props.hiddenLines} onFilter={props.onFilter} onToggle={props.onFilterToggle} onClose={() => setFilterOpen(false)} />}
          </span>
          <MenuButton icon="ellipsis" title="More" items={menuItems} />
        </span>
      </header>
      {props.notice && (
        <div class="pk-notice" role="status">
          <Icon name="warning" />
          <span class="pk-notice-text">{props.notice}</span>
        </div>
      )}
      <div class="pk-list" ref={listRef} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown} role="listbox" aria-multiselectable>
        {entries.length === 0 ? (
          <div class="pk-empty">{props.emptyText ?? 'NO LOGS OR ERRORS'}</div>
        ) : prefs.entriesMode === 'tree' ? (
          <TreeRows {...props} selectedSet={selectedSet} onClick={click} />
        ) : (
          entries.map((e) => <EntryRow key={e.logId} entry={e} selected={selectedSet.has(e.logId)} prefs={prefs} onClick={click} onOpen={props.onOpen} onWhy={props.onWhy} />)
        )}
      </div>
    </section>
  );
}

function EntryRow({ entry, selected, prefs, onClick, onOpen, onWhy, indent }: { entry: Entry; selected: boolean; prefs: UiPrefs; onClick: (id: string, ev: MouseEvent) => void; onOpen: (e: Entry, side: boolean) => void; onWhy: (e: Entry) => void; indent?: number }) {
  const cls = ['pk-row', 'pk-entry'];
  if (selected) cls.push('selected');
  if (entry.isError || entry.kind === 'error') cls.push('error');
  return (
    <div class={cls.join(' ')} data-id={entry.logId} role="option" aria-selected={selected} onClick={(ev) => onClick(entry.logId, ev)} style={indent ? { paddingLeft: `${indent * 16 + 8}px` } : undefined}>
      {prefs.showKindIcon && <Icon name={KIND_ICON[entry.kind] ?? 'output'} class="pk-kind" />}
      {entry.hit > 1 && <span class="pk-hit">×{entry.hit}</span>}
      <span class="pk-entry-text">{entry.isError || entry.kind === 'error' ? <span class="pk-error-text">{entry.text}</span> : <Repr text={entry.text} />}</span>
      {prefs.showContext && entry.context && <span class="pk-context">{entry.context}</span>}
      <SourceLink file={entry.file} line={entry.line} col={entry.col} showFile={prefs.showFileName} onOpen={(side) => onOpen(entry, side)} />
      <IconButton icon="question" title="Why this value" class="pk-why" onClick={() => onWhy(entry)} />
    </div>
  );
}

interface TreeFile {
  key: string;
  file: string;
  fileId: number;
  count: number;
  lines: TreeLine[];
}
interface TreeLine {
  key: string;
  line: number;
  col: number;
  context?: string;
  entries: Entry[];
  hasError: boolean;
}

function buildTree(entries: Entry[]): TreeFile[] {
  const files = new Map<string, TreeFile>();
  for (const e of entries) {
    let f = files.get(e.file);
    if (!f) {
      f = { key: e.file, file: e.file, fileId: e.fileId, count: 0, lines: [] };
      files.set(e.file, f);
    }
    f.count++;
    const lk = lineKey(e);
    let l = f.lines.find((x) => x.key === lk);
    if (!l) {
      l = { key: lk, line: e.line, col: e.col, context: e.context, entries: [], hasError: false };
      f.lines.push(l);
    }
    l.entries.push(e);
    if (e.isError || e.kind === 'error') l.hasError = true;
  }
  return [...files.values()];
}

function TreeRows(props: EntriesProps & { selectedSet: Set<string>; onClick: (id: string, ev: MouseEvent) => void }) {
  const tree = useMemo(() => buildTree(props.entries), [props.entries]);
  const allTree = useMemo(() => buildTree(props.allEntries), [props.allEntries]);
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set(tree.map((f) => f.key)));
  const [openLines, setOpenLines] = useState<Set<string>>(() => new Set());
  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };
  const setHidden = (key: string, visible: boolean) => props.onFilterToggle([key], visible);
  const rows = props.filterMode ? allTree : tree;
  return (
    <>
      {rows.map((f) => (
        <div key={f.key}>
          <div class="pk-row pk-tree-file" onClick={() => toggle(openFiles, f.key, setOpenFiles)}>
            <Icon name={openFiles.has(f.key) ? 'chevron-down' : 'chevron-right'} class="pk-twistie" />
            <span class="pk-tree-label">{f.file}</span>
            <span class="pk-tree-count">{f.count}</span>
            {props.filterMode && (
              <Checkbox
                checked={f.lines.every((l) => !props.hiddenLines.has(l.key))}
                onChange={(v) => props.onFilterToggle(f.lines.map((l) => l.key), v)}
              />
            )}
          </div>
          {openFiles.has(f.key) &&
            f.lines.map((l) => {
              const first = l.entries[0] as Entry;
              return (
                <div key={l.key}>
                  <div class={`pk-row pk-tree-line${props.hiddenLines.has(l.key) ? ' hidden-by-filter' : ''}`} onClick={() => toggle(openLines, l.key, setOpenLines)}>
                    <Icon name={openLines.has(l.key) ? 'chevron-down' : 'chevron-right'} class="pk-twistie" />
                    <Icon name={l.hasError ? 'error' : 'info'} class={`pk-kind${l.hasError ? ' error' : ''}`} />
                    <span class="pk-tree-label">line {l.line}</span>
                    {props.prefs.showContext && l.context && <span class="pk-context">{l.context}</span>}
                    <SourceLink file={first.file} line={l.line} col={l.col} showFile={props.prefs.showFileName} onOpen={(side) => props.onOpen(first, side)} />
                    <span class="pk-tree-count">{l.entries.length}</span>
                    {props.filterMode && <Checkbox checked={!props.hiddenLines.has(l.key)} onChange={(v) => setHidden(l.key, v)} />}
                  </div>
                  {openLines.has(l.key) && l.entries.map((e) => <EntryRow key={e.logId} entry={e} selected={props.selectedSet.has(e.logId)} prefs={props.prefs} onClick={props.onClick} onOpen={props.onOpen} onWhy={props.onWhy} indent={2} />)}
                </div>
              );
            })}
        </div>
      ))}
    </>
  );
}

function FilterMenu({ entries, hidden, onFilter, onToggle, onClose }: { entries: Entry[]; hidden: Set<string>; onFilter: (h: Set<string>) => void; onToggle: (keys: string[], visible: boolean) => void; onClose: () => void }) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const items: MenuItem[] = [];
  const allKeys = tree.flatMap((f) => f.lines.map((l) => l.key));
  items.push({
    label: hidden.size ? 'Show all' : 'Hide all',
    keepOpen: true,
    onSelect: () => onFilter(hidden.size ? new Set() : new Set(allKeys)),
  });
  for (const f of tree) {
    items.push({ label: f.file, disabled: true, separatorAbove: true });
    for (const l of f.lines) {
      items.push({
        label: `line ${l.line}`,
        toggle: true,
        checked: !hidden.has(l.key),
        hint: String(l.entries.length),
        keepOpen: true,
        onSelect: () => onToggle([l.key], hidden.has(l.key)),
      });
    }
  }
  return <Menu items={items} onClose={onClose} class="pk-filter-menu" />;
}

export { orderedSelection };
