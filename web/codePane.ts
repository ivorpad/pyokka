/**
 * The browser page's code pane: Monaco showing the running file (editable; Ctrl/Cmd+S saves to
 * disk) or a file the Time Machine stepped into (read-only), with what VS Code's editor shows:
 * values after their lines, coverage in the gutter, the Time Machine's line and its callers, the
 * exception, and an agent's narration under a line.
 */
import { monaco, READONLY_OPTIONS } from '../webview/monaco';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
// decorations' `hoverMessage` (inline values, the live pause's values) shows only with the hover contribution
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution';
// Cmd/Ctrl-click and F12 on a name: its definition (web/definitions.ts)
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
// right-click: Show Variable History
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu';
import { registerPythonDefinitions } from './definitions';
import type { BridgeFile } from './bridgeProtocol';
import { PROFILE_PATH, type CodeDecorations, type CodeView } from './pageHost';
import { STORY_PATH } from './story';
import { pausedHover, pausedOccurrences } from './pausedValues';
import { inlineHistory, type HistoryRow } from './codeHistory';
import { NarrationZone } from './narrationZone';

const INLINE_MAX = 160;

export class CodePane implements CodeView {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  /** the content each model last had on disk (or from the bridge), to tell an edit from a reload */
  private readonly loaded = new Map<string, string>();
  private mainPath: string | undefined;
  private shown: string | undefined;
  private decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly narration: NarrationZone;
  private applying = false;
  private pauseSnapshot: string | undefined;
  private lastRender: CodeDecorations | undefined;
  /** a Cmd/Ctrl-clicked definition in another file: open it apart from this pane */
  onDefinitionNavigate: (path: string, line: number, column: number) => void = () => {};
  /** a click in the glyph margin or on a line number: toggle the live debugger's breakpoint there */
  onGutterClick: (path: string, line: number) => void = () => {};
  /** Show Variable History: the context menu on a name, or a hover's link (`name` given) */
  onShowHistory: (name?: string) => void = () => {};
  /** a made-up document's row (the Code Story, the profile): text selected on it, or Ctrl/Cmd+click */
  onLinePick: (path: string, line: number, how: 'select' | 'open') => void = () => {};

  constructor(
    host: HTMLElement,
    private readonly onEdit: (content: string) => void,
    private readonly onSave: (content: string) => void,
  ) {
    this.editor = monaco.editor.create(host, {
      ...READONLY_OPTIONS,
      readOnly: false,
      domReadOnly: false,
      lineNumbers: 'on',
      lineNumbersMinChars: 4,
      glyphMargin: true,
      lineDecorationsWidth: 6,
      renderLineHighlight: 'line',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: true,
      quickSuggestions: false,
      matchBrackets: 'always',
      occurrencesHighlight: 'singleFile',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      gotoLocation: { multipleDefinitions: 'goto' },
    });
    this.decorations = this.editor.createDecorationsCollection();
    this.narration = new NarrationZone(this.editor);
    registerPythonDefinitions();
    // a definition in another file opens in its own tab; one in the shown file moves the cursor (Monaco's default)
    monaco.editor.registerEditorOpener({
      openCodeEditor: (source, resource, selection) => {
        if (source !== this.editor || resource.scheme !== 'file' || resource.toString() === this.editor.getModel()?.uri.toString()) return false;
        const at = selection && 'startLineNumber' in selection ? { line: selection.startLineNumber, column: selection.startColumn } : { line: selection?.lineNumber ?? 1, column: selection?.column ?? 1 };
        this.onDefinitionNavigate(resource.fsPath, at.line, at.column);
        return true;
      },
    });
    // shadows fit the pane's width: lay them out again when it changes
    this.editor.onDidLayoutChange(() => {
      if (this.lastRender?.liveValues) this.render(this.lastRender);
    });
    this.editor.onDidChangeModelContent(() => {
      if (this.applying || this.shown !== this.mainPath) return;
      this.onEdit(this.editor.getValue());
    });
    this.editor.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      // T3: placing the cursor does nothing; selected text on one row picks it
      if (!this.shown || !isVirtual(this.shown) || this.applying || e.source === 'api' || sel.isEmpty() || sel.startLineNumber !== sel.endLineNumber) return;
      this.onLinePick(this.shown, sel.startLineNumber, 'select');
    });
    this.editor.onMouseDown((e) => {
      const t = e.target.type;
      const line = e.target.position?.lineNumber;
      if (!line || !this.shown) return;
      if (isVirtual(this.shown)) {
        if (t === monaco.editor.MouseTargetType.CONTENT_TEXT && (e.event.ctrlKey || e.event.metaKey)) this.onLinePick(this.shown, line, 'open');
        else if (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) this.onLinePick(this.shown, line, 'select');
        return;
      }
      if (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) this.onGutterClick(this.shown, line);
    });
    // the panel's Variable History for the name under the cursor, from the context menu or a hover's link
    this.editor.addAction({ id: 'pyokka.showVariableHistory.here', label: 'Show Variable History', contextMenuGroupId: 'navigation', contextMenuOrder: 1, run: () => this.onShowHistory() });
    monaco.editor.registerCommand('pyokka.showVariableHistory', (_accessor, arg?: { name?: string }) => this.onShowHistory(arg?.name));
    this.editor.addCommand(monaco.KeyCode.F9, () => {
      const line = this.cursorLine();
      if (line && this.shown) this.onGutterClick(this.shown, line);
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (this.shown !== this.mainPath) return;
      const content = this.editor.getValue();
      if (this.mainPath) this.loaded.set(this.mainPath, content);
      this.onSave(content);
    });
  }

  /** the main file has edits the disk does not */
  get dirty(): boolean {
    const m = this.mainPath ? this.models.get(this.mainPath) : undefined;
    return !!m && m.getValue() !== this.loaded.get(this.mainPath!);
  }

  /** the main file's edited text when it differs from the disk, else undefined (runs read the disk) */
  dirtyContent(): string | undefined {
    return this.dirty ? this.mainContent() : undefined;
  }

  /** the main file's text as edited, saved or not */
  mainContent(): string | undefined {
    return this.mainPath ? this.models.get(this.mainPath)?.getValue() : undefined;
  }

  /** Another file is the main one now (Open Recent): it is the editable one from here on. */
  setMain(file: BridgeFile): void {
    this.mainPath = file.path;
    this.showFile(file);
  }

  showFile(file: BridgeFile, opts: { keepDirty?: boolean } = {}): void {
    if (!this.mainPath) this.mainPath = file.path;
    let model = this.models.get(file.path);
    if (!model) {
      // a definition lookup may have made the model already
      model = monaco.editor.getModel(monaco.Uri.file(file.path)) ?? monaco.editor.createModel(file.content, file.language, monaco.Uri.file(file.path));
      if (model.getValue() !== file.content) model.setValue(file.content);
      this.models.set(file.path, model);
      this.loaded.set(file.path, file.content);
    } else if (model.getValue() !== file.content && !(opts.keepDirty && file.path === this.mainPath && this.dirty)) {
      // a change on disk: replace the text, keeping the cursor where it was
      this.applying = true;
      const pos = this.editor.getModel() === model ? this.editor.getPosition() : null;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: file.content }], () => null);
      if (pos) this.editor.setPosition(pos);
      this.applying = false;
      this.loaded.set(file.path, file.content);
    }
    if (this.editor.getModel() !== model) {
      this.narration.set(null);
      this.editor.setModel(model);
    }
    this.shown = file.path;
    this.shownDisplay = file.displayName;
    // the story and the profile carry their own line numbers
    this.editor.updateOptions({ readOnly: file.path !== this.mainPath, domReadOnly: file.path !== this.mainPath, lineNumbers: file.path === STORY_PATH || file.path === PROFILE_PATH ? 'off' : 'on' });
  }

  shownPath(): string | undefined {
    return this.shown;
  }

  private shownDisplay: string | undefined;
  /** the shown file's name for the header: `Code Story`, `demo.py (instrumented)` */
  shownName(): string | undefined {
    return this.shownDisplay;
  }

  isMainShown(): boolean {
    return this.shown === this.mainPath;
  }

  cursorLine(): number | undefined {
    return this.editor.getPosition()?.lineNumber;
  }

  /** The selection on one line, else the name or attribute path under the cursor up to its word (`self.x` on `x`, `self` on `self`). */
  expressionAtCursor(): string | undefined {
    const model = this.editor.getModel();
    const sel = this.editor.getSelection();
    if (!model || !sel || (this.shown && isVirtual(this.shown))) return undefined;
    if (!sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) return model.getValueInRange(sel).trim() || undefined;
    const col = sel.positionColumn - 1;
    for (const m of model.getLineContent(sel.positionLineNumber).matchAll(/[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*/g)) {
      if (col < m.index || col > m.index + m[0].length) continue;
      const end = /^\w*/.exec(m[0].slice(col - m.index))![0].length + col - m.index;
      return m[0].slice(0, end).replace(/\s+/g, '');
    }
    return undefined;
  }

  reveal(line: number): void {
    if (line > 0) this.editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  }

  render(d: CodeDecorations): void {
    // a hover from an earlier pause would show that pause's value
    if (d.liveValues?.snapshot !== this.pauseSnapshot) {
      this.pauseSnapshot = d.liveValues?.snapshot;
      const hover = this.editor.getContribution<monaco.editor.IEditorContribution & { _cancelScheduler?(): void; _hideWidgets?(): void }>('editor.contrib.contentHover');
      hover?._cancelScheduler?.();
      hover?._hideWidgets?.();
    }
    this.lastRender = d;
    const model = this.editor.getModel();
    if (!model) return;
    const lines = model.getLineCount();
    const out: monaco.editor.IModelDeltaDecoration[] = [];
    // the whole line, not its empty end: Monaco drops the injected text of an empty range there
    const endOf = (line: number) => new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    for (const [line, state] of d.coverage) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: `pkw-cov pkw-cov-${state}` } });
    }
    for (const line of d.callers) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-caller-line', glyphMarginClassName: 'codicon codicon-debug-stackframe-dot pkw-caller-glyph' } });
    }
    for (const [line, bp] of d.breakpoints) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: `codicon ${bp.condition ? 'codicon-debug-breakpoint-conditional' : 'codicon-debug-breakpoint'} pkw-breakpoint-glyph`, glyphMarginHoverMessage: { value: bp.condition ? `Breakpoint if \`${bp.condition}\`` : 'Breakpoint (click to remove)' } } });
    }
    if (d.paused !== null && d.paused >= 1 && d.paused <= lines) {
      const line = d.paused;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-paused-line', glyphMarginClassName: 'codicon codicon-debug-stackframe pkw-paused-glyph', overviewRuler: { color: '#ffcc00', position: monaco.editor.OverviewRulerLane.Full } } });
    }
    for (const r of d.dim ?? []) {
      if (r.line < 1 || r.line > lines) continue;
      out.push({ range: new monaco.Range(r.line, r.start + 1, r.line, r.end + 1), options: { inlineClassName: 'pkw-dim' } });
    }
    if (d.box && d.box.line >= 1 && d.box.line <= lines) {
      out.push({ range: new monaco.Range(d.box.line, d.box.start + 1, d.box.line, d.box.end + 1), options: { className: 'pkw-story-box' } });
    }
    if (d.current && d.current.line >= 1 && d.current.line <= lines) {
      const line = d.current.line;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-current-line', glyphMarginClassName: 'codicon codicon-debug-stackframe pkw-current-glyph', overviewRuler: { color: '#ffcc00', position: monaco.editor.OverviewRulerLane.Full } } });
    }
    // the live pause: a hover on each identifier naming the frame's binding, a shadow beside each declaration
    const live = d.liveValues && model.getValue() === d.liveValues.content ? d.liveValues : undefined;
    if (live) {
      for (const o of pausedOccurrences(live)) {
        if (o.line < 1 || o.line > lines) continue;
        out.push({ range: new monaco.Range(o.line, o.start + 1, o.line, o.end + 1), options: { hoverMessage: { value: `${historyLink(o.local.name)}\n\n${pausedHover(o.local)}`, isTrusted: true } } });
      }
    }
    // the code history: each declaration's values over this run's pauses (the current one last)
    const snapshots = [...(d.history ?? [])];
    if (live && !snapshots.some((s) => s.snapshot === live.snapshot)) snapshots.push(live);
    const shadows: Map<number, HistoryRow> = snapshots.length ? inlineHistory(model.getValue(), snapshots) : new Map();
    const font = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
    for (const [line, { preview: text, hover, names }] of shadows) {
      if (line < 1 || line > lines) continue;
      // fit the pane instead of scrolling it sideways: whole `name = value` parts first, else a cut; the hover keeps the full text
      const available = Math.floor(this.editor.getLayoutInfo().contentWidth / font.typicalHalfwidthCharacterWidth) - model.getLineLength(line) - 4;
      const parts: string[] = [];
      for (const part of text.split(' · ')) if ([...parts, part].join(' · ').length <= available) parts.push(part);
      const preview = parts.length ? parts.join(' · ') : available >= 12 ? text.slice(0, available - 1) + '…' : '';
      // the links first: a long history scrolls inside the hover
      const links = names.map(historyLink).join(' · ');
      if (preview) out.push({ range: endOf(line), options: { after: { content: `  ${preview}`, inlineClassName: 'pkw-live-value', cursorStops: monaco.editor.InjectedTextCursorStops.None }, hoverMessage: { value: `${links}\n\n${hover}`, isTrusted: true } } });
    }
    for (const [line, text] of d.inline) {
      // a line with a live shadow shows the pause's value, not the earlier recording's
      if (line < 1 || line > lines || d.errors.has(line) || shadows.has(line)) continue;
      out.push({ range: endOf(line), options: { after: { content: `  ${clip(text)}`, inlineClassName: 'pkw-inline-value' }, hoverMessage: { value: '```\n' + text + '\n```' } } });
    }
    for (const [line, text] of d.errors) {
      if (line < 1 || line > lines) continue;
      out.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pkw-error-line' } });
      out.push({ range: endOf(line), options: { after: { content: `  ${clip(text)}`, inlineClassName: 'pkw-inline-error' } } });
    }
    this.decorations.set(out);
  }

  setNarration(n: { text: string; line: number } | null): void {
    this.narration.set(n);
  }

  layout(): void {
    this.editor.layout();
  }
}

/** A hover's link to the panel's Variable History of `name` (trusted Markdown runs it through the command registered above). */
function historyLink(name: string): string {
  return `[Show history of ${name}](command:pyokka.showVariableHistory?${encodeURIComponent(JSON.stringify({ name }))} "Every value of ${name} in the right panel")`;
}

/** the page's own read-only documents: the Code Story, the profile, the logs, an instrumented source */
function isVirtual(path: string): boolean {
  return path.startsWith('pyokka://');
}

function clip(text: string): string {
  const one = text.replace(/\s*\n\s*/g, ' ');
  return one.length > INLINE_MAX ? `${one.slice(0, INLINE_MAX - 1)}…` : one;
}
