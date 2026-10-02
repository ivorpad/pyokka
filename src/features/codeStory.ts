/**
 * Code Story: a generated read-only document listing the executed regions of the source in
 * execution order, one block per pass through a scope, kept in sync with the Time Machine step.
 * The document's shape is `docs/design/code-story.md`; the rules it cites are built in
 * `src/session/storyLines.ts`, which is pure.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import type { TimeMachine } from '../timeMachine/navigator';
import { storyBlocks } from '../timeMachine/traceModel';
import type { StepLocation } from '../timeMachine/traceModel';
import type { DecorationTypes } from '../decorations/styles';
import { renderStoryDocument, scopeTop, storyRowIndex, storyValueRow, storyValueWanted, type Span, type StoryBlockInput, type StoryLine, type StoryValue, type StoryValuesMode } from '../session/storyLines';
import { inlineTextFor } from '../session/valuesAsOf';
import { truncateOneLine } from '../util/text';
import type { InlineKind } from '../decorations/styles';
import { renderWalkthroughLines, type Walkthrough } from '../session/walkthrough';
import { setting } from '../config/settings';

export const STORY_SCHEME = 'pyokka-code-timeline';
const INLINE_KINDS: InlineKind[] = ['log', 'system', 'error'];
/** The story sits in a side pane, so its values are cut shorter than an editor's. The hover has the whole thing. */
const STORY_VALUE_MAX = 120;

interface StoryBlock {
  index: number;
  scopeId: number;
  firstStep: number;
  lastStep: number;
  fileId: number;
}

interface StoryModel {
  text: string;
  lines: StoryLine[];
  blocks: StoryBlock[];
  runId: string;
}

export class CodeStory implements vscode.TextDocumentContentProvider, vscode.DefinitionProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly models = new Map<string, StoryModel>();
  private highlightTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** set while the story moves its own cursor, so the selection handler can never drive navigation from it */
  private moving = false;
  /** what `renderValues` last painted per story document, for the test API */
  private readonly painted = new Map<string, StoryValue[]>();

  constructor(
    private readonly manager: SessionManager,
    private readonly timeMachine: TimeMachine,
    private readonly types: DecorationTypes,
    /** the walkthrough of the session's last run (the Narrator); listed at the top when `pyokka.story.walkthrough` is on (off by default) */
    private readonly walkthroughFor: (session: Session) => Walkthrough | undefined = () => undefined,
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(STORY_SCHEME, this),
      vscode.languages.registerDefinitionProvider({ scheme: STORY_SCHEME }, this),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.highlightAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('pyokka.story')) return;
        // the walkthrough prefix changes the text, the values mode only the paint
        for (const s of this.manager.all()) {
          this.models.delete(s.key);
          this.changeEmitter.fire(this.uriFor(s));
        }
        this.highlightAll();
      }),
    );
    manager.on('sessionStarted', (s) => {
      s.on('trace', () => this.invalidate(s));
      s.on('log', () => this.scheduleHighlight());
      s.on('runFinished', () => this.scheduleHighlight());
      s.on('navChanged', () => {
        // D2: the story exists only while the Time Machine is on
        if (!s.nav.active) this.close(s);
        else this.highlightAll({ follow: true });
      });
    });
    manager.on('sessionStopped', (s) => {
      this.models.delete(s.key);
      this.changeEmitter.fire(this.uriFor(s));
      this.close(s);
    });
    timeMachine.setStoryResolver((doc, line) => this.resolve(doc, line));
  }

  dispose(): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    for (const d of this.disposables) d.dispose();
  }

  uriFor(session: Session): vscode.Uri {
    return vscode.Uri.from({ scheme: STORY_SCHEME, path: 'Pyokka Code Story', query: `session=${encodeURIComponent(session.key)}` });
  }

  private sessionFor(uri: vscode.Uri): Session | undefined {
    const key = new URLSearchParams(uri.query).get('session');
    return key ? this.manager.getByKey(key) : undefined;
  }

  /** Rebuild the story (the walkthrough's glosses arrived). */
  refresh(session: Session): void {
    this.invalidate(session);
  }

  private invalidate(session: Session): void {
    this.models.delete(session.key);
    this.changeEmitter.fire(this.uriFor(session));
    this.scheduleHighlight();
  }

  /** Coalesce the repaints a streaming run would otherwise ask for one per entry. */
  private scheduleHighlight(): void {
    if (this.highlightTimer) return;
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = undefined;
      this.highlightAll();
    }, 50);
  }

  /* ---------- open and close (D2) ---------- */

  async open(): Promise<void> {
    const s = this.manager.active();
    if (!s) {
      void vscode.window.showInformationMessage('Pyokka: start a session first (Cmd/Ctrl+K Q).');
      return;
    }
    if (!s.nav.active) {
      const editor = vscode.window.activeTextEditor;
      const line = editor && editor.document === s.document ? editor.selection.active.line + 1 : undefined;
      const ok = await this.timeMachine.start(s, { line });
      if (!ok) return;
    }
    const uri = this.uriFor(s);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'pyokka-story') await vscode.languages.setTextDocumentLanguage(doc, 'pyokka-story');
    const existing = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    await vscode.window.showTextDocument(doc, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
    this.highlightAll({ follow: true });
  }

  /** Close every editor showing this session's story: the Time Machine (or the session) stopped. */
  private close(session: Session): void {
    const key = session.key;
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tabUri(tab);
        if (!uri || uri.scheme !== STORY_SCHEME) continue;
        if (new URLSearchParams(uri.query).get('session') === key) tabs.push(tab);
      }
    }
    if (tabs.length > 0) void vscode.window.tabGroups.close(tabs);
  }

  /* ---------- content ---------- */

  provideTextDocumentContent(uri: vscode.Uri): string {
    const s = this.sessionFor(uri);
    // the session is gone and the tab is on its way out (D2): no "stopped" text state
    if (!s) return '';
    return this.model(s).text;
  }

  private model(s: Session): StoryModel {
    const cached = this.models.get(s.key);
    if (cached && cached.runId === s.state.runId) return cached;
    const m = this.build(s);
    this.models.set(s.key, m);
    return m;
  }

  private build(s: Session): StoryModel {
    const trace = s.trace;
    const blocks: StoryBlock[] = [];
    if (!trace || trace.count === 0) {
      const lines: StoryLine[] = [{ kind: 'note' }, { kind: 'note' }];
      return { text: '# Pyokka Code Story\n# No execution recorded yet.\n', lines, blocks, runId: s.state.runId };
    }
    const sources = new Map<number, string[]>();
    const sourceLines = (fileId: number): string[] => {
      let src = sources.get(fileId);
      if (!src) {
        if (fileId === s.mainFileId()) src = s.state.content.split(/\r?\n/);
        else {
          const uri = s.uriForFileId(fileId);
          const doc = uri ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) : undefined;
          if (doc) src = doc.getText().split(/\r?\n/);
          else if (uri?.scheme === 'file') {
            // project and library modules that are not open in an editor (library steps, mostly)
            try {
              src = fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
            } catch {
              src = [];
            }
          } else src = [];
        }
        sources.set(fileId, src);
      }
      return src;
    };
    const inputs: StoryBlockInput[] = [];
    // one block per pass through a scope, so a loop body is listed once per iteration
    for (const range of storyBlocks(trace)) {
      const block: StoryBlock = { index: blocks.length, ...range };
      blocks.push(block);
      inputs.push(this.blockInput(s, block, sourceLines(range.fileId)));
    }
    const walkthrough = setting<boolean>('story.walkthrough', false, s.document.uri) ? this.walkthroughLines(s) : undefined;
    const doc = renderStoryDocument(inputs, { walkthrough });
    return { text: doc.text, lines: doc.lines, blocks, runId: s.state.runId };
  }

  /** The walkthrough as comment rows at the top: one line per moment, `#step  sentence`, glosses under them. */
  private walkthroughLines(s: Session): string[] | undefined {
    const w = this.walkthroughFor(s);
    if (!w || w.moments.length === 0) return undefined;
    const head = `# Walkthrough: ${w.total} moments over ${w.count} steps${w.shown < w.total ? ` (showing ${w.shown})` : ''}`;
    // every row of the document is Python (D6), so the walkthrough reads as comments
    return [head, ...renderWalkthroughLines(w, { values: false }).map((l) => (l.trimStart().startsWith('#') ? l : `#${l}`))];
  }

  /** What one block shows: the lines its steps started on (L1) and the columns those steps cover (L6). */
  private blockInput(s: Session, block: StoryBlock, src: string[]): StoryBlockInput {
    const trace = s.trace!;
    const firstStepOfLine = new Map<number, number>();
    const bright = new Map<number, Span[]>();
    for (let k = block.firstStep; k <= block.lastStep; k++) {
      const loc = trace.location(k);
      if (!loc || loc.fileId !== block.fileId) continue;
      // L1: a step's executed line is the first line of its range; the rest of a multi-line
      // statement is listed as context and stays dim
      const line = loc.range[0];
      if (!firstStepOfLine.has(line)) firstStepOfLine.set(line, k);
      const spans = bright.get(line) ?? [];
      spans.push(brightSpan(loc, src[line - 1] ?? ''));
      bright.set(line, spans);
    }
    if (src.length === 0) {
      const f = s.files.get(block.fileId);
      return { fileId: block.fileId, src, firstStepOfLine, note: `${f ? path.basename(f.path) : 'external code'} (no source available)` };
    }
    // every step of the block ran in another file: nothing of this one to list, so the block is dropped
    if (firstStepOfLine.size === 0) return { fileId: block.fileId, src, firstStepOfLine };
    return { fileId: block.fileId, src, firstStepOfLine, bright, span: this.scopeSpan(s, block, src, firstStepOfLine) };
  }

  /**
   * L2: the span context may not leave. A function is its whole body, from the `def` line (walked
   * up over the comments and decorators directly above it) to the last line of the body; the module
   * scope is the whole file, which the builder clamps to anyway.
   */
  private scopeSpan(s: Session, block: StoryBlock, src: string[], firstStepOfLine: ReadonlyMap<number, number>): [number, number] | undefined {
    const scope = s.trace!.scope(block.scopeId);
    if (!scope || scope.parent < 0) return undefined;
    const loc = s.locate(scope.rid);
    if (!loc || loc.fileId !== block.fileId) return undefined;
    const body = s.files.get(block.fileId)?.functions.find((f) => f.rid === loc.localRid)?.bodyRange;
    const def = body ? Math.min(body[0], loc.range[0]) : loc.range[0];
    // without a body range, the last line the scope is known to have reached
    const last = Math.max(...firstStepOfLine.keys(), loc.range[2]);
    return [scopeTop(src, def), Math.max(body ? body[2] : last, def)];
  }

  /* ---------- mapping ---------- */

  resolve(doc: vscode.TextDocument, line: number): { session: Session; fileId: number; line: number; step?: number } | undefined {
    const s = this.sessionFor(doc.uri);
    if (!s) return undefined;
    const m = this.model(s);
    const sl = m.lines[line];
    if (!sl || sl.kind !== 'code' || sl.fileId === undefined || sl.sourceLine === undefined) return undefined;
    return { session: s, fileId: sl.fileId, line: sl.sourceLine, step: sl.step };
  }

  /** Story row of the current step: its source line inside the block that holds the step (T1). */
  private currentRow(s: Session): { row: number; loc: StepLocation; line: StoryLine } | undefined {
    if (!s.nav.active) return undefined;
    const step = s.nav.currentStep;
    const m = this.model(s);
    const loc = s.trace?.location(step);
    if (!loc) return undefined;
    const block = m.blocks.find((b) => step >= b.firstStep && step <= b.lastStep);
    if (!block) return undefined;
    for (let i = 0; i < m.lines.length; i++) {
      const l = m.lines[i]!;
      if (l.kind === 'code' && l.block === block.index && l.sourceLine === loc.range[0]) return { row: i, loc, line: l };
    }
    return undefined;
  }

  /** `follow`: a navigation, so the story scrolls to the step and puts the cursor on it (T2). */
  highlightAll(opts: { follow?: boolean } = {}): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== STORY_SCHEME) continue;
      const s = this.sessionFor(editor.document.uri);
      if (!s || !s.trace) {
        editor.setDecorations(this.types.storyCurrent, []);
        editor.setDecorations(this.types.storyContext, []);
        this.clearValues(editor);
        continue;
      }
      // L6: everything outside the block's own step ranges is dim, navigating or not
      const m = this.model(s);
      const dim: vscode.Range[] = [];
      for (let i = 0; i < m.lines.length && i < editor.document.lineCount; i++) {
        const spans = m.lines[i]!.dim;
        if (!spans) continue;
        const width = editor.document.lineAt(i).text.length;
        for (const [a, b] of spans) {
          const start = Math.min(a, width);
          const end = Math.min(b, width);
          if (end > start) dim.push(new vscode.Range(i, start, i, end));
        }
      }
      editor.setDecorations(this.types.storyContext, dim);
      const cur = this.currentRow(s);
      this.renderValues(editor, s, cur);
      if (!cur || cur.row >= editor.document.lineCount) {
        editor.setDecorations(this.types.storyCurrent, []);
        continue;
      }
      const width = editor.document.lineAt(cur.row).text.length;
      const prefix = cur.line.prefixLength ?? 0;
      const start = Math.min(prefix + cur.loc.range[1], width);
      // T1: the box is the step's range, to the end of the line when the statement carries on below
      let end = cur.loc.range[0] === cur.loc.range[2] ? Math.min(prefix + cur.loc.range[3], width) : width;
      if (end <= start) end = width;
      const box = new vscode.Range(cur.row, start, cur.row, Math.max(start, end));
      editor.setDecorations(this.types.storyCurrent, [box]);
      if (opts.follow) {
        editor.revealRange(box, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        const at = new vscode.Position(cur.row, start);
        // the selection handler ignores an empty selection, and `moving` closes the loop for good
        if (!editor.selection.isEmpty || !editor.selection.active.isEqual(at)) {
          this.moving = true;
          editor.selection = new vscode.Selection(at, at);
          this.moving = false;
        }
      }
    }
  }

  /* ---------- the current step's values (V1, V2) ---------- */

  private clearValues(editor: vscode.TextEditor): void {
    this.painted.delete(editor.document.uri.toString());
    for (const k of INLINE_KINDS) editor.setDecorations(this.types.inline[k], []);
  }

  /** The values the story document of `editor` shows (the e2e suite reads it). */
  values(editor: vscode.TextEditor): StoryValue[] {
    return this.painted.get(editor.document.uri.toString()) ?? [];
  }

  /**
   * The values on the story's lines, by `pyokka.story.values` (`storyValueWanted`): `all` paints
   * every entry in the block whose steps produced it (so the two turns of a loop carry their own),
   * `asOf` only those at or before the current step, `step` only the current step's (Quokka's V1).
   * Placement is `storyValueRow`.
   */
  private renderValues(editor: vscode.TextEditor, s: Session, cur: { row: number } | undefined): void {
    const mode = setting<StoryValuesMode>('story.values', 'all', s.document.uri);
    const m = this.model(s);
    const step = s.nav.active ? s.nav.currentStep : undefined;
    const byKind: Record<InlineKind, vscode.DecorationOptions[]> = { log: [], system: [], error: [] };
    const rows = storyRowIndex(m.lines.slice(0, editor.document.lineCount));
    const painted: StoryValue[] = [];
    const push = (row: number, block: number, text: string, kind: InlineKind, hover: vscode.MarkdownString): void => {
      const pos = new vscode.Position(row, editor.document.lineAt(row).text.length);
      byKind[kind].push({ range: new vscode.Range(pos, pos), renderOptions: { after: { contentText: text } }, hoverMessage: hover });
      painted.push({ row, block, sourceLine: m.lines[row]?.sourceLine ?? 0, text, kind });
    };
    for (const block of m.blocks) {
      for (const [rid, logs] of s.state.entriesByRid) {
        const loc = s.locate(rid);
        if (!loc || loc.fileId !== block.fileId) continue;
        const visible = logs.filter((l) => s.isEntryVisible(l) && storyValueWanted(mode, l.step, block, step));
        if (visible.length === 0) continue;
        const row = storyValueRow(m.lines, rows, block.index, loc.fileId, loc.range) ?? (mode === 'step' ? cur?.row : undefined);
        if (row === undefined) continue;
        const { text, kind } = inlineTextFor(visible);
        const hover = new vscode.MarkdownString();
        hover.appendCodeblock(visible[visible.length - 1]!.text, 'python');
        push(row, block.index, truncateOneLine(text, STORY_VALUE_MAX), kind, hover);
      }
      for (const err of s.state.errors) {
        if (err.handled || !storyValueWanted(mode, err.step, block, step)) continue;
        const loc = s.locate(err.rid);
        if (!loc || loc.fileId !== block.fileId) continue;
        const row = storyValueRow(m.lines, rows, block.index, loc.fileId, loc.range);
        if (row === undefined) continue;
        const hover = new vscode.MarkdownString();
        hover.appendCodeblock(`${err.errorType}: ${err.message}`, 'text');
        push(row, block.index, truncateOneLine(err.message || err.errorType, STORY_VALUE_MAX), 'error', hover);
      }
    }
    for (const k of INLINE_KINDS) editor.setDecorations(this.types.inline[k], byKind[k]);
    this.painted.set(editor.document.uri.toString(), painted);
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
    const r = this.resolve(document, position.line);
    if (!r) return undefined;
    const uri = r.session.uriForFileId(r.fileId);
    if (!uri) return undefined;
    const m = this.model(r.session);
    const prefix = m.lines[position.line]?.prefixLength ?? 0;
    const col = Math.max(0, position.character - prefix);
    return new vscode.Location(uri, new vscode.Position(r.line - 1, col));
  }

  /* ---------- selection -> value at that step (T3) ---------- */

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const doc = e.textEditor.document;
    if (doc.uri.scheme !== STORY_SCHEME || this.moving) return;
    const sel = e.selections[0];
    // placing the cursor does nothing; only selected text moves the Time Machine
    if (!sel || sel.isEmpty || !sel.isSingleLine) return;
    const r = this.resolve(doc, sel.start.line);
    if (!r || !r.session.nav.active) return;
    const m = this.model(r.session);
    const prefix = m.lines[sel.start.line]?.prefixLength ?? 0;
    const startCol = Math.max(0, sel.start.character - prefix);
    const endCol = Math.max(startCol, sel.end.character - prefix);
    if (endCol <= startCol) return;
    const text = doc.getText(sel).trim();
    if (!text) return;
    if (r.step !== undefined && r.step !== r.session.nav.currentStep) this.timeMachine.goto(r.session, r.step, { reveal: false });
    r.session.addValueMarker([r.line, startCol, r.line, endCol], 'story', { context: text });
  }
}

/** The columns a step's range covers on its first line: to its end column, or to the end of the line. */
function brightSpan(loc: StepLocation, text: string): Span {
  return [loc.range[1], loc.range[0] === loc.range[2] ? loc.range[3] : text.length];
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input: unknown = tab.input;
  if (input && typeof input === 'object' && 'uri' in input) {
    const uri = (input as { uri: unknown }).uri;
    if (uri instanceof vscode.Uri) return uri;
  }
  return undefined;
}
