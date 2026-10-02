/**
 * Show Value / Line Values / Line Timings / Copy Value / Clear, selection + auto-log toggles,
 * copy path/data, and the hover's links (copy, explore, show as diagram).
 */
import * as vscode from 'vscode';
import type { LogEvent, Range4 } from '../shared/protocol';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import type { Decorator } from '../decorations/decorator';
import type { OutputPanel } from '../views/outputPanel';
import { entryText } from '../views/panelSupport';
import { memberChainAt } from '../util/text';
import { setContext } from '../util/context';
import { setting } from '../config/settings';
import { existingValue } from './valuePeek';

export function selectionRange4(editor: vscode.TextEditor, sel: vscode.Range = editor.selection): Range4 {
  return [sel.start.line + 1, sel.start.character, sel.end.line + 1, sel.end.character];
}

/** Range of the selection, or of the member chain under the cursor. */
export function expressionAtCursor(editor: vscode.TextEditor, allowMultiline = true): { range: Range4; text: string } | undefined {
  const sel = editor.selection;
  if (!sel.isEmpty) {
    if (!sel.isSingleLine && !allowMultiline) return undefined;
    const text = editor.document.getText(sel).trim();
    if (!text) return undefined;
    // trim surrounding whitespace out of the range
    const full = editor.document.getText(sel);
    const lead = full.length - full.trimStart().length;
    const trail = full.length - full.trimEnd().length;
    const start = editor.document.positionAt(editor.document.offsetAt(sel.start) + lead);
    const end = editor.document.positionAt(editor.document.offsetAt(sel.end) - trail);
    return { range: [start.line + 1, start.character, end.line + 1, end.character], text };
  }
  const line = editor.document.lineAt(sel.active.line).text;
  const span = memberChainAt(line, sel.active.character);
  if (!span) return undefined;
  return { range: [sel.active.line + 1, span.start, sel.active.line + 1, span.end], text: span.text };
}

export class LiveValues implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private selectionTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly manager: SessionManager,
    private readonly decorator: Decorator,
    private readonly panel: OutputPanel,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChanged(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKeys()),
    );
    manager.on('activeChanged', () => this.updateContextKeys());
    manager.on('sessionStarted', (s) => {
      s.on('settingsChanged', () => this.updateContextKeys());
      s.on('stateChanged', () => this.updateContextKeys());
      this.updateContextKeys();
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private sessionFor(editor: vscode.TextEditor | undefined): Session | undefined {
    return editor ? this.manager.sessionForDocument(editor.document) : undefined;
  }

  updateContextKeys(): void {
    const editor = vscode.window.activeTextEditor;
    const s = this.sessionFor(editor);
    setContext('autoLogEnabled', !!s?.autoLog);
    setContext('showValueOnSelectionEnabled', !!s?.showValueOnSelection);
    setContext('showSingleInlineValueEnabled', !!s?.showSingleInlineValue);
    if (!s || !editor || editor.document !== s.document) {
      setContext('lineHasRemovableInlineValues', false);
      setContext('fileHasRemovableInlineValues', false);
      return;
    }
    const line = editor.selection.active.line + 1;
    setContext('lineHasRemovableInlineValues', s.markers.onLine(line).length > 0);
    setContext('fileHasRemovableInlineValues', s.markers.visible().length > 0);
  }

  /* ---------- commands ---------- */

  showValue(): void {
    const editor = vscode.window.activeTextEditor;
    const s = this.sessionFor(editor);
    if (!editor || !s) return;
    const exp = expressionAtCursor(editor);
    if (!exp) {
      void vscode.window.showInformationMessage('Pyokka: place the cursor on an expression or select one.');
      return;
    }
    s.addValueMarker(exp.range, 'showValue', { context: exp.text });
    this.decorator.refreshSession(s);
    this.updateContextKeys();
  }

  private lineTargets(editor: vscode.TextEditor, s: Session): { range: Range4; text: string }[] {
    const line = editor.selection.active.line + 1;
    const fileId = s.fileIdForDocument(editor.document);
    const statements = fileId === undefined ? [] : s.files.statementsOnLine(fileId, line);
    if (statements.length) return statements.map((st) => ({ range: st.range, text: editor.document.getText(new vscode.Range(st.range[0] - 1, st.range[1], st.range[2] - 1, st.range[3])) }));
    const l = editor.document.lineAt(line - 1);
    const text = l.text.trim();
    if (!text || text.startsWith('#')) return [];
    const end = l.text.replace(/\s*#.*$/, '').trimEnd().length;
    return [{ range: [line, l.firstNonWhitespaceCharacterIndex, line, end], text: l.text.slice(l.firstNonWhitespaceCharacterIndex, end) }];
  }

  showLineValues(): void {
    const editor = vscode.window.activeTextEditor;
    const s = this.sessionFor(editor);
    if (!editor || !s) return;
    for (const t of this.lineTargets(editor, s)) s.addValueMarker(t.range, 'lineValues', { context: t.text });
    this.decorator.refreshSession(s);
    this.updateContextKeys();
  }

  showLineTimings(): void {
    const editor = vscode.window.activeTextEditor;
    const s = this.sessionFor(editor);
    if (!editor || !s) return;
    for (const t of this.lineTargets(editor, s)) s.addValueMarker(t.range, 'lineTimings', { kind: 'time', context: t.text });
    this.decorator.refreshSession(s);
    this.updateContextKeys();
  }

  async copyValue(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const s = this.sessionFor(editor);
    if (!editor || !s) return;
    const exp = expressionAtCursor(editor);
    if (!exp) return;
    const logEv = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Pyokka: evaluating…' }, () => s.evaluateTransient(exp.range, { context: exp.text }));
    if (!logEv) {
      void vscode.window.showWarningMessage(`Pyokka: no value was produced for "${exp.text}" (did the line execute?).`);
      return;
    }
    await vscode.env.clipboard.writeText(entryText(logEv));
    vscode.window.setStatusBarMessage(`Pyokka: copied value of ${exp.text}`, 2500);
  }

  clearValue(): void {
    const editor = vscode.window.activeTextEditor;
    const s = this.sessionFor(editor);
    if (!editor || !s) return;
    const line = editor.selection.active.line + 1;
    const ids = s.markers.onLine(line).map((m) => m.id);
    if (ids.length) s.removeMarkers(ids);
    this.decorator.refreshSession(s);
    this.updateContextKeys();
  }

  clearFileValues(): void {
    const editor = vscode.window.activeTextEditor;
    const s = this.sessionFor(editor);
    if (!editor || !s) return;
    const ids = s.markers.visible().filter((m) => m.kind !== 'logpoint').map((m) => m.id);
    if (ids.length) s.removeMarkers(ids);
    this.decorator.refreshSession(s);
    this.updateContextKeys();
  }

  setShowValueOnSelection(on: boolean): void {
    const s = this.manager.active();
    if (!s) return;
    s.setShowValueOnSelection(on);
    this.updateContextKeys();
  }

  setShowSingleInlineValue(on: boolean): void {
    const s = this.manager.active();
    if (!s) return;
    s.setShowSingleInlineValue(on);
    this.decorator.refreshSession(s);
    this.updateContextKeys();
  }

  setAutoLog(on: boolean): void {
    const s = this.manager.active();
    if (!s) return;
    s.setAutoLog(on);
    this.updateContextKeys();
  }

  async copyExpressionPath(arg: unknown): Promise<void> {
    const text = pickString(arg, ['expressionPath', 'path']);
    if (text) await vscode.env.clipboard.writeText(text);
  }

  async copyExpressionData(arg: unknown): Promise<void> {
    if (typeof arg === 'string') return void (await vscode.env.clipboard.writeText(arg));
    const s = this.manager.active();
    const logId = pickString(arg, ['logId']);
    const e = logId && s ? s.state.entriesById.get(logId) : undefined;
    const text = e ? entryText(e) : pickString(arg, ['data', 'text']);
    if (text) await vscode.env.clipboard.writeText(text);
  }

  async hoverCopy(arg: unknown): Promise<void> {
    const ref = hoverRef(arg);
    const found = ref.logId || ref.exp ? await this.resolveHoverEntry(arg) : undefined;
    const text = found ? entryText(found.entry) : typeof arg === 'string' ? arg : pickString(arg, ['text']);
    if (text) {
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage('Pyokka: value copied', 2000);
    }
  }

  async exploreEntity(arg: unknown): Promise<void> {
    const ref = hoverRef(arg);
    if (ref.logId || ref.exp) {
      const found = await this.resolveHoverEntry(arg);
      if (found) this.panel.selectEntries(found.session, [found.entry.logId]);
      return;
    }
    // no explicit entry: explore the values on the current line
    const s = this.manager.active();
    const editor = vscode.window.activeTextEditor;
    if (!s || !editor) return;
    const fileId = s.fileIdForDocument(editor.document);
    const line = editor.selection.active.line + 1;
    const ids = s.visibleEntries().filter((e) => {
      const loc = s.locate(e.rid);
      return loc && loc.fileId === fileId && loc.range[0] <= line && loc.range[2] >= line;
    }).map((e) => e.logId);
    this.panel.selectEntries(s, ids);
  }

  /** "Show as diagram" on a hover: select the entry and open the Diagram view on it. */
  async showDiagramForEntry(arg: unknown): Promise<void> {
    const found = await this.resolveHoverEntry(arg);
    if (!found) return;
    this.panel.selectEntries(found.session, [found.entry.logId]);
    this.panel.showView('diagram');
  }

  /**
   * The entry a hover link (Explore value / Show as diagram / Copy) points at. Entry ids are per
   * run, and a value evaluated for the hover (`live-N`, `shadow-…`) is registered only in the run
   * that was current when the hover was computed, so when the file re-ran before the click (On
   * Save re-runs on every save) the id resolves to nothing. The link also carries the expression,
   * its range and the session (valuePeek.markdown), so the value is looked up or re-evaluated
   * against the current run the way the hover would have: a value the run shows at that range, a
   * transient run in Automatic mode, the finished child's answer otherwise. Never throws; when
   * nothing comes back the status bar says why.
   */
  async resolveHoverEntry(arg: unknown): Promise<{ session: Session; entry: LogEvent } | undefined> {
    const ref = hoverRef(arg);
    if (!ref.logId && !ref.exp) return undefined;
    // a link names its session; one that does not (the ≈ shadow hover) means the active one
    const session = ref.sessionKey ? this.manager.getByKey(ref.sessionKey) : this.manager.active();
    if (!session || session.isDisposed) {
      vscode.window.setStatusBarMessage('Pyokka: that value belongs to a session that has stopped', 5000);
      return undefined;
    }
    // while a run is in flight the table is still the old run's (until run.started) and runNow has emptied the pins
    const direct = ref.logId && !session.running ? session.state.entriesById.get(ref.logId) : undefined;
    if (direct) return { session, entry: direct };
    const entry = ref.exp && !session.running ? await this.reevaluate(session, ref.exp, ref.range) : undefined;
    if (entry) return { session, entry };
    vscode.window.setStatusBarMessage('Pyokka: that value belongs to an earlier run; hover again to refresh it', 5000);
    return undefined;
  }

  /** The hover expression's value in the current run, found or evaluated the way the hover would have. */
  private async reevaluate(session: Session, exp: string, range: Range4 | undefined): Promise<LogEvent | undefined> {
    // a value the run already shows at that range (a `# ?`, Auto Log, Show Value) costs nothing
    const fileId = session.mainFileId();
    const shown = range && fileId !== undefined ? existingValue(session, fileId, range, exp) : undefined;
    if (shown) return shown;
    // Automatic mode: a transient run of the expression at its range, as long as the text there
    // still reads the expression (an edit since the hover may have moved it). Otherwise, and in
    // On Save / On Demand, the finished child's final value, which never executes the file.
    if (session.implicitRunsAllowed && !session.debug.paused && range && textAt(session.document, range) === exp) return session.evaluateTransient(range, { context: exp });
    return session.evaluateLive(exp, range?.[0]);
  }

  /* ---------- selection ---------- */

  private onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent): void {
    this.updateContextKeys();
    const s = this.sessionFor(e.textEditor);
    if (!s || !s.showValueOnSelection || e.textEditor.document !== s.document) return;
    const sel = e.selections[0];
    if (!sel || sel.isEmpty) return;
    if (!sel.isSingleLine && !setting<boolean>('showValueOnMultilineSelection', false, s.document.uri)) return;
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor !== e.textEditor || editor.selection.isEmpty) return;
      const exp = expressionAtCursor(editor);
      if (!exp) return;
      s.addValueMarker(exp.range, 'selection', { context: exp.text });
      this.decorator.refreshSession(s);
      this.updateContextKeys();
    }, 350);
  }
}

/** What a hover link carries (valuePeek.markdown); older producers pass `logId` alone. */
interface HoverRef {
  logId?: string;
  exp?: string;
  range?: Range4;
  sessionKey?: string;
}

function hoverRef(arg: unknown): HoverRef {
  const r = arg && typeof arg === 'object' ? (arg as { range?: unknown }).range : undefined;
  const range = Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === 'number') ? (r as Range4) : undefined;
  return { logId: pickString(arg, ['logId']), exp: pickString(arg, ['exp']), range, sessionKey: pickString(arg, ['sessionKey']) };
}

/** The document's text at a 1-based-line range; undefined when the range does not fit the document. */
function textAt(doc: vscode.TextDocument, range: Range4): string | undefined {
  try {
    return doc.getText(new vscode.Range(range[0] - 1, range[1], range[2] - 1, range[3]));
  } catch {
    return undefined;
  }
}

function pickString(arg: unknown, keys: string[]): string | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const o = arg as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return JSON.stringify(v, null, 2);
  }
  return undefined;
}
