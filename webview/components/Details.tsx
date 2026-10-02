/**
 * DETAILS pane: one read-only Monaco editor holding every selected entry as
 * `source link` header + pretty-printed Python value, or, while a "why" query is
 * open, the provenance tree's text form. Line metadata maps cursor positions back
 * to value nodes for copy path / copy value / load more, and tree lines to their
 * step and statement.
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'preact/hooks';
import type { Ref } from 'preact';
import type { ValueNode, WhyView } from '../src-shared';
import { formatText, formatValue, type FormattedLine } from '../format';
import type { Entry, Theme } from '../model';
import { monaco, monacoTheme, READONLY_OPTIONS } from '../monaco';
import type { UiPrefs } from '../vscode';
import { shapeLabel, tableFor, type ValueTableModel } from '../valueTable';
import { buildWhyDocument, type WhyLine } from '../why';
import { IconButton, MenuButton, type MenuItem } from './ui';
import { ValueTable } from './ValueTable';

export interface DetailsHandle {
  focus(): void;
}

export interface DetailsProps {
  entries: Entry[];
  total: number;
  theme: Theme;
  prefs: UiPrefs;
  compareEnabled: boolean;
  /** the "why" tree shown instead of the entries until it is closed */
  why: WhyView | null;
  onPrefs: (patch: Partial<UiPrefs>) => void;
  onOpen: (fileId: number, line: number, col: number, sideView: boolean) => void;
  onExpand: (entry: Entry, node: ValueNode) => void;
  onCopy: (text: string) => void;
  onCompare: () => void;
  onDiagram: () => void;
  /** Time Machine to a step (a tree's node or call line; starts it when needed) */
  onGoto: (step: number) => void;
  onCloseWhy: () => void;
  /** rows to mark in the tables, by entry logId: the loop's current item */
  tableMarks?: Record<string, number>;
  handle?: Ref<DetailsHandle>;
}

interface DetailLine extends Omit<WhyLine, 'kind'> {
  kind: 'header' | 'error' | 'frame' | 'blank' | FormattedLine['kind'] | WhyLine['kind'];
  /** the entry behind the line; none in the why document */
  entry?: Entry;
  fmt?: FormattedLine;
}

interface Built {
  text: string;
  lines: DetailLine[];
}

/** the name a value is printed under: its context when it is a plain name or dotted path */
function rootNameOf(e: Entry): string {
  return e.context && /^[A-Za-z_][\w.]*$/.test(e.context) ? e.context : 'value';
}

interface TableEntry {
  entry: Entry;
  model: ValueTableModel;
  name: string;
}

/** the selected entries whose value is a homogeneous collection (see ../valueTable.ts) */
function tablesFor(entries: Entry[]): TableEntry[] {
  const out: TableEntry[] = [];
  for (const e of entries) {
    const model = e.valueBag ? tableFor(e.valueBag.data) : undefined;
    if (model) out.push({ entry: e, model, name: rootNameOf(e) });
  }
  return out;
}

/**
 * `tabled` lists the entries shown as a table above the editor with the rows the user opened:
 * the document then holds those rows only, under the entry's header, instead of the whole value.
 */
function buildDocument(entries: Entry[], tabled: Map<string, { name: string; rows: { index: number; node: ValueNode }[] }> = new Map()): Built {
  const out: string[] = [];
  const lines: DetailLine[] = [];
  const push = (text: string, meta: DetailLine) => {
    out.push(text);
    lines.push(meta);
  };
  entries.forEach((e, idx) => {
    if (idx > 0) push('', { kind: 'blank', entry: e });
    const isError = e.isError || e.kind === 'error';
    if (isError) {
      push(e.errorType ? `${e.errorType}: ${e.text}` : e.text, { kind: 'error', entry: e });
      push('', { kind: 'blank', entry: e });
      const frames = e.stack && e.stack.length ? e.stack : [{ fileId: e.fileId, line: e.line, col: e.col, function: '' }];
      for (const f of frames) {
        const file = f.fileId === e.fileId ? e.file : `file ${f.fileId}`;
        push(`@ ${file}:${f.line}${f.function ? `  ${f.function}` : ''}`, { kind: 'frame', entry: e, link: { fileId: f.fileId, line: f.line, col: f.col } });
      }
      return;
    }
    const table = tabled.get(e.logId);
    if (table && table.rows.length === 0) return; // the table above the editor is the whole rendering
    push(`${e.file}:${e.line}`, { kind: 'header', entry: e, link: { fileId: e.fileId, line: e.line, col: e.col } });
    push('', { kind: 'blank', entry: e });
    if (table) {
      for (const row of table.rows) for (const l of formatValue(row.node, { rootName: `${table.name}[${row.index}]` })) push(l.text, { kind: l.kind, entry: e, fmt: l });
    } else if (e.valueBag) {
      for (const l of formatValue(e.valueBag.data, { rootName: rootNameOf(e) })) push(l.text, { kind: l.kind, entry: e, fmt: l });
    } else {
      push(e.text, { kind: 'value', entry: e });
    }
  });
  return { text: out.join('\n'), lines };
}

export function Details(props: DetailsProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const linesRef = useRef<DetailLine[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [findOpen, setFindOpen] = useState(false);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  // homogeneous collections: shown as a table unless the user switched that value to the list; rows opened from a table go to the document
  const [listMode, setListMode] = useState<Record<string, boolean>>({});
  const [openRows, setOpenRows] = useState<Record<string, number[]>>({});
  const tables = useMemo(() => tablesFor(props.entries), [props.entries]);
  const shownTables = tables.filter((t) => !listMode[t.entry.logId]);
  const toggleRow = (logId: string, index: number) => setOpenRows((cur) => ({ ...cur, [logId]: (cur[logId] ?? []).includes(index) ? (cur[logId] ?? []).filter((i) => i !== index) : [...(cur[logId] ?? []), index].sort((a, b) => a - b) }));

  // two memos, so entries arriving while a tree is shown do not rebuild (and rescroll) the tree
  const whyDoc = useMemo(() => (props.why ? buildWhyDocument(props.why) : null), [props.why]);
  const entriesDoc = useMemo(() => {
    const tabled = new Map<string, { name: string; rows: { index: number; node: ValueNode }[] }>();
    for (const t of shownTables) tabled.set(t.entry.logId, { name: t.name, rows: t.model.rows.filter((r) => (openRows[t.entry.logId] ?? []).includes(r.index)).map((r) => ({ index: r.index, node: r.node })) });
    return buildDocument(props.entries, tabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entries, listMode, openRows]);
  const built: Built = whyDoc ?? entriesDoc;
  linesRef.current = built.lines;
  // the tables above the editor are the whole rendering: the empty editor takes no space
  const emptyUnderTables = !whyDoc && built.lines.length === 0 && shownTables.length > 0;
  useEffect(() => {
    editorRef.current?.layout();
  }, [emptyUnderTables]);

  useImperativeHandle(props.handle ?? { current: null }, () => ({ focus: () => editorRef.current?.focus() }), []);

  // create the editor once
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const model = monaco.editor.createModel('', 'python');
    const editor = monaco.editor.create(host, {
      ...READONLY_OPTIONS,
      model,
      theme: monacoTheme(props.theme),
      lineNumbers: props.prefs.lineNumbers ? 'on' : 'off',
      minimap: { enabled: props.prefs.minimap },
      stickyScroll: { enabled: props.prefs.stickyScroll },
      folding: props.prefs.folding,
      guides: { indentation: props.prefs.folding },
      foldingStrategy: 'indentation',
    });
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection([]);

    const lineAt = (n: number | undefined) => (n ? linesRef.current[n - 1] : undefined);
    const nodeAtCursor = () => lineAt(editor.getPosition()?.lineNumber);

    // the entries document's "load" lines ask the host for more of the value
    const expandAt = (meta: DetailLine | undefined) => {
      if (meta?.entry && meta.fmt?.loadNode) propsRef.current.onExpand(meta.entry, meta.fmt.loadNode);
    };

    editor.onMouseDown((ev) => {
      const ln = ev.target.position?.lineNumber;
      const meta = lineAt(ln);
      if (!meta) return;
      const p = propsRef.current;
      const el = ev.target.element;
      const isEye = !!el?.closest('.pk-md-eye') || (ev.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && ev.target.range && ev.target.range.startColumn > (editor.getModel()?.getLineLength(ln ?? 1) ?? 0));
      if ((meta.kind === 'header' || meta.kind === 'frame') && meta.link) {
        p.onOpen(meta.link.fileId, meta.link.line, meta.link.col, isEye || ev.event.altKey);
        return;
      }
      if ((meta.kind === 'node' || meta.kind === 'call') && meta.step !== undefined) {
        // a tree line: the Time Machine goes to its step; the eye opens the statement to the side, Alt-click in place
        if ((isEye || ev.event.altKey) && meta.link) p.onOpen(meta.link.fileId, meta.link.line, meta.link.col, isEye);
        else p.onGoto(meta.step);
        return;
      }
      if (meta.kind === 'load') {
        expandAt(meta);
        return;
      }
      if (meta.kind === 'string-capped') {
        const len = editor.getModel()?.getLineLength(ln ?? 1) ?? 0;
        const col = ev.target.position?.column ?? 0;
        if (col >= len) expandAt(meta);
      }
    });

    const copyValue = () => {
      const sel = editor.getSelection();
      const selected = sel && !sel.isEmpty() ? editor.getModel()?.getValueInRange(sel) : '';
      if (selected) {
        propsRef.current.onCopy(selected);
        return;
      }
      const meta = nodeAtCursor();
      if (!meta) return;
      if (meta.fmt) propsRef.current.onCopy(formatText(meta.fmt.node, { rootName: meta.fmt.path }));
      else propsRef.current.onCopy(editor.getModel()?.getLineContent(editor.getPosition()?.lineNumber ?? 1) ?? '');
    };

    editor.addAction({
      id: 'pyokka.copyValue',
      label: 'Copy value',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: copyValue,
    });
    editor.addAction({
      id: 'pyokka.copyPath',
      label: 'Copy path',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => {
        const meta = nodeAtCursor();
        if (meta?.fmt) propsRef.current.onCopy(meta.fmt.path);
      },
    });
    editor.addAction({
      id: 'pyokka.loadFullString',
      label: 'Load full string value',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      precondition: 'pyokka.cappedString',
      run: () => expandAt(nodeAtCursor()),
    });
    editor.addAction({
      id: 'pyokka.loadMore',
      label: 'Load more',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 4,
      precondition: 'pyokka.loadable',
      run: () => expandAt(nodeAtCursor()),
    });
    const cappedKey = editor.createContextKey<boolean>('pyokka.cappedString', false);
    const loadKey = editor.createContextKey<boolean>('pyokka.loadable', false);
    editor.onDidChangeCursorPosition(() => {
      const meta = nodeAtCursor();
      cappedKey.set(meta?.kind === 'string-capped');
      loadKey.set(meta?.kind === 'load');
    });
    const findWidget = editor.getContribution('editor.contrib.findController') as unknown as { closeFindWidget?: () => void } | null;
    editor.onDidBlurEditorWidget(() => void findWidget);

    return () => {
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // push document + decorations
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const scrollTop = editor.getScrollTop();
    model.setValue(built.text);
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    const eye = { content: ' ', inlineClassName: 'pk-md-eye codicon codicon-eye' };
    const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
    built.lines.forEach((l, i) => {
      const ln = i + 1;
      const len = model.getLineLength(ln);
      if (l.kind === 'header' || l.kind === 'frame') {
        decos.push({ range: new monaco.Range(ln, 1, ln, len + 1), options: { inlineClassName: 'pk-md-link', after: eye, stickiness } });
      } else if ((l.kind === 'node' || l.kind === 'call') && l.step !== undefined) {
        // a tree line: its location reads as the link, the eye sits at the end of the line
        const [start, end] = l.linkSpan ?? [0, len];
        decos.push({ range: new monaco.Range(ln, start + 1, ln, end + 1), options: { inlineClassName: 'pk-md-link', hoverMessage: { value: `Time Machine to #${l.step} (Alt-click opens the statement, the eye to the side)` }, stickiness } });
        decos.push({ range: new monaco.Range(ln, Math.max(1, len), ln, len + 1), options: { after: eye, stickiness } });
      } else if (l.kind === 'opaque' || l.kind === 'note' || l.kind === 'wait') {
        decos.push({ range: new monaco.Range(ln, 1, ln, len + 1), options: { inlineClassName: 'pk-md-dim' } });
      } else if (l.kind === 'conclusion') {
        // the answer in words under the tree: a tinted whole line, the mockup's box
        decos.push({ range: new monaco.Range(ln, 1, ln, len + 1), options: { className: 'pk-md-conclusion', isWholeLine: true, inlineClassName: 'pk-md-conclusion-text', stickiness } });
      } else if (l.kind === 'error') {
        decos.push({ range: new monaco.Range(ln, 1, ln, len + 1), options: { inlineClassName: 'pk-md-error' } });
      } else if (l.kind === 'load') {
        decos.push({ range: new monaco.Range(ln, 1, ln, len + 1), options: { inlineClassName: 'pk-md-load', hoverMessage: { value: 'Click to load' } } });
      } else if (l.kind === 'string-capped') {
        decos.push({ range: new monaco.Range(ln, Math.max(1, len), ln, len + 1), options: { inlineClassName: 'pk-md-load', hoverMessage: { value: 'Load full string value' } } });
      }
    });
    decorations.current?.set(decos);
    // a tree starts at its root; the entries document keeps its place across updates
    editor.setScrollTop(propsRef.current.why ? 0 : scrollTop);
  }, [built]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      lineNumbers: props.prefs.lineNumbers ? 'on' : 'off',
      minimap: { enabled: props.prefs.minimap },
      stickyScroll: { enabled: props.prefs.stickyScroll },
      folding: props.prefs.folding,
      guides: { indentation: props.prefs.folding },
    });
  }, [props.prefs.lineNumbers, props.prefs.minimap, props.prefs.stickyScroll, props.prefs.folding]);

  useEffect(() => {
    monaco.editor.setTheme(monacoTheme(props.theme));
  }, [props.theme]);

  const toggleFind = () => {
    const editor = editorRef.current;
    if (!editor) return;
    if (findOpen) {
      editor.trigger('pyokka', 'closeFindWidget', null);
      setFindOpen(false);
    } else {
      editor.focus();
      editor.trigger('pyokka', 'actions.find', null);
      setFindOpen(true);
    }
  };

  const copyAll = () => {
    props.onCopy(built.text);
  };

  const menuItems = (): MenuItem[] => [
    { label: 'Display line numbers', toggle: true, checked: props.prefs.lineNumbers, onSelect: () => props.onPrefs({ lineNumbers: !props.prefs.lineNumbers }) },
    { label: 'Display minimap', toggle: true, checked: props.prefs.minimap, onSelect: () => props.onPrefs({ minimap: !props.prefs.minimap }) },
    { label: 'Enable sticky scroll', toggle: true, checked: props.prefs.stickyScroll, onSelect: () => props.onPrefs({ stickyScroll: !props.prefs.stickyScroll }) },
    { label: 'Enable folding and guides', toggle: true, checked: props.prefs.folding, onSelect: () => props.onPrefs({ folding: !props.prefs.folding }) },
  ];

  const why = props.why;
  return (
    <section class="pk-pane pk-details" aria-label="Details">
      <header class="pk-pane-header">
        <span class="pk-pane-title">
          {why ? (
            <>
              WHY {why.name && <span class="pk-why-name">{why.name}</span>} <span class="pk-count">#{why.step}</span>
            </>
          ) : (
            <>
              DETAILS <span class="pk-count">{props.total}</span>
            </>
          )}
        </span>
        <span class="pk-toolbar">
          {!why && props.compareEnabled && <IconButton icon="diff" title="Compare selected values" onClick={props.onCompare} />}
          {!why && <IconButton icon="type-hierarchy-sub" title="Show as diagram" disabled={props.entries.length === 0} onClick={props.onDiagram} />}
          <IconButton icon="search" title="Find" active={findOpen} onClick={toggleFind} />
          <IconButton icon="copy" title="Copy with highlighting" onClick={copyAll} />
          <MenuButton icon="ellipsis" title="More" items={menuItems} />
          {why && <IconButton icon="close" title="Back to entries" onClick={props.onCloseWhy} />}
        </span>
      </header>
      {!why && tables.length > 0 && (
        <div class={`pk-details-tables${emptyUnderTables ? ' pk-details-tables--only' : ''}`}>
          {tables.map(({ entry, model, name }) => {
            const caption = `${name} · ${shapeLabel(entry.valueBag!.data, model)}`;
            if (listMode[entry.logId]) {
              return (
                <div class="pk-vtable-bar-only" key={entry.logId}>
                  <span class="pk-vtable-caption">{caption}</span>
                  <button type="button" class="pk-vtable-toggle" onClick={() => setListMode((cur) => ({ ...cur, [entry.logId]: false }))}>show as table</button>
                </div>
              );
            }
            return (
              <ValueTable
                key={entry.logId}
                model={model}
                caption={caption}
                markIndex={props.tableMarks?.[entry.logId]}
                onShowList={() => setListMode((cur) => ({ ...cur, [entry.logId]: true }))}
                onOpenRow={(row) => toggleRow(entry.logId, row.index)}
                onOpenCell={(node, row) => {
                  if (node.expandable && !node.props) props.onExpand(entry, node);
                  toggleRow(entry.logId, row.index);
                }}
                onLoadMore={(node) => props.onExpand(entry, node)}
              />
            );
          })}
        </div>
      )}
      <div class={`pk-editor-host${emptyUnderTables ? ' pk-editor-host--empty' : ''}`} ref={hostRef} />
    </section>
  );
}
