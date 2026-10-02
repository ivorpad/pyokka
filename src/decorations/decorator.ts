/**
 * Renders a session's state into editors: coverage gutter, inline values, errors and the
 * Time Machine highlights.
 */
import * as vscode from 'vscode';
import type { LogEvent, Range4 } from '../shared/protocol';
import { CoverageState } from '../shared/protocol';
import type { DecorationTypes, InlineKind } from './styles';
import type { Session, RunState } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { asOfFooter, entriesAsOf, finalEntry, inlineTextFor } from '../session/valuesAsOf';
import { truncateOneLine } from '../util/text';

const STATE_PRIORITY: Record<number, number> = { [CoverageState.NotRun]: 0, [CoverageState.Covered]: 1, [CoverageState.Partial]: 2, [CoverageState.ErrorPath]: 3, [CoverageState.ErrorSource]: 4 };
const ALL_STATES = [CoverageState.NotRun, CoverageState.Covered, CoverageState.Partial, CoverageState.ErrorSource, CoverageState.ErrorPath];

/** `pyokka.timeMachine.inlineValues` */
type NavInlineMode = 'dimOthers' | 'currentStep' | 'all';

function navInlineMode(): NavInlineMode {
  const v = vscode.workspace.getConfiguration('pyokka').get<string>('timeMachine.inlineValues', 'dimOthers');
  return v === 'currentStep' || v === 'all' ? v : 'dimOthers';
}

interface InlineItem {
  line: number; // 0-based
  col: number;
  text: string;
  kind: InlineKind;
  hover?: vscode.MarkdownString;
}

/**
 * Which of a range's entries `inlineItems` keeps: the ones produced exactly at `exactStep`, the
 * ones produced at or before `asOfStep` (the value as of that step), or all of them when neither
 * is set. `exactStep` wins when both are set.
 */
interface StepFilter {
  exactStep?: number;
  asOfStep?: number;
}

/** An inline value as the editor shows it; what `Decorator.inlineValues` reports to the e2e suite. */
export interface InlineValue {
  line: number; // 1-based
  text: string;
  kind: InlineKind;
  /** a value from an earlier Time Machine step, painted dimmed */
  dim: boolean;
}

export function toVsRange(r: Range4): vscode.Range {
  return new vscode.Range(Math.max(0, r[0] - 1), Math.max(0, r[1]), Math.max(0, r[2] - 1), Math.max(0, r[3]));
}

export class Decorator {
  private deadEndTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly types: DecorationTypes,
    private readonly manager: SessionManager,
  ) {}

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refreshEditor(editor);
  }

  refreshSession(session: Session): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.manager.sessionForDocument(editor.document) === session) this.refreshEditor(editor);
    }
  }

  clear(editor: vscode.TextEditor): void {
    for (const s of ALL_STATES) {
      editor.setDecorations(this.types.coverage[s], []);
      editor.setDecorations(this.types.coverageStale[s], []);
    }
    for (const k of ['log', 'system', 'error'] as InlineKind[]) {
      editor.setDecorations(this.types.inline[k], []);
      editor.setDecorations(this.types.inlineDim[k], []);
    }
    editor.setDecorations(this.types.currentStep, []);
    editor.setDecorations(this.types.deadEnd, []);
    editor.setDecorations(this.types.callStackFrame, []);
    editor.setDecorations(this.types.scopeLine, []);
    editor.setDecorations(this.types.echo, []);
    editor.setDecorations(this.types.watch, []);
  }

  refreshEditor(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme === 'pyokka-code-timeline' || editor.document.uri.scheme === 'pyokka-recent') return;
    const session = this.manager.sessionForDocument(editor.document);
    if (!session || session.isDisposed) {
      this.clear(editor);
      return;
    }
    const fileId = session.fileIdForDocument(editor.document);
    this.renderCoverage(editor, session, fileId);
    this.renderInline(editor, session, fileId);
    this.renderTimeMachine(editor, session, fileId);
  }

  /* ---------- coverage ---------- */

  private coverageLines(state: RunState, fileId: number, lineCount: number): Map<number, CoverageState> {
    const out = new Map<number, CoverageState>();
    const file = state.files.get(fileId);
    const cov = state.coverage.get(fileId);
    if (!file || !cov) return out;
    for (const local of file.statements) {
      const range = file.ranges[local];
      const st = (cov.states[local] ?? 0) as CoverageState;
      if (!range) continue;
      const line = range[0] - 1;
      if (line < 0 || line >= lineCount) continue;
      const prev = out.get(line);
      if (prev === undefined || (STATE_PRIORITY[st] ?? 0) > (STATE_PRIORITY[prev] ?? 0)) out.set(line, st);
    }
    return out;
  }

  private renderCoverage(editor: vscode.TextEditor, session: Session, fileId: number | undefined): void {
    const lineCount = editor.document.lineCount;
    const fresh = fileId === undefined ? new Map<number, CoverageState>() : this.coverageLines(session.state, fileId, lineCount);
    const staleSource = session.running && session.previous ? session.previous : undefined;
    const staleFileId = staleSource ? (editor.document === session.document ? staleSource.files.byPath(session.filePath)?.fileId : staleSource.files.byPath(editor.document.uri.fsPath)?.fileId) : undefined;
    const stale = staleSource && staleFileId !== undefined ? this.coverageLines(staleSource, staleFileId, lineCount) : new Map<number, CoverageState>();
    const useStale = fresh.size === 0 && stale.size > 0;
    for (const s of ALL_STATES) {
      const freshRanges: vscode.Range[] = [];
      const staleRanges: vscode.Range[] = [];
      for (const [line, st] of fresh) if (st === s) freshRanges.push(new vscode.Range(line, 0, line, 0));
      if (useStale) for (const [line, st] of stale) if (st === s) staleRanges.push(new vscode.Range(line, 0, line, 0));
      editor.setDecorations(this.types.coverage[s], freshRanges);
      editor.setDecorations(this.types.coverageStale[s], staleRanges);
    }
  }

  /* ---------- inline values ---------- */

  private inlineItems(session: Session, state: RunState, fileId: number, lineCount: number, filter: StepFilter): InlineItem[] {
    const items: InlineItem[] = [];
    const filtered = filter.exactStep !== undefined || filter.asOfStep !== undefined;
    // the hover footer names the step the values are filtered by; 'all' mode passes no filter and shows the run's last values, which need none
    const footerStep = filtered && session.nav.active ? session.nav.currentStep : undefined;
    for (const [rid, logs] of state.entriesByRid) {
      const loc = state.files.locate(rid);
      if (!loc || loc.fileId !== fileId) continue;
      const all = logs.filter((l) => session.isEntryVisible(l));
      const visible = filter.exactStep !== undefined ? all.filter((l) => l.step === filter.exactStep) : filter.asOfStep !== undefined ? entriesAsOf(all, filter.asOfStep) : all;
      if (!visible.length) continue; // with asOfStep: the statement has not run yet as of the step
      const line = loc.range[2] - 1;
      if (line < 0 || line >= lineCount) continue;
      if (session.dirtyLines.has(loc.range[0]) || session.dirtyLines.has(loc.range[2])) continue; // edited since the run: value is stale (a shadow value may replace it below)
      const { text, kind } = inlineTextFor(visible);
      const shown = visible[visible.length - 1]!;
      const hover = new vscode.MarkdownString();
      hover.appendCodeblock(shown.text, 'python');
      const footer = asOfFooter(shown, finalEntry(all), footerStep);
      if (footer) hover.appendMarkdown('\n\n' + footer);
      items.push({ line, col: loc.range[3], text, kind, hover });
    }
    // shadow values: edited lines re-evaluated against the finished run's state, marked ≈
    if (fileId === session.mainFileId() && !filtered) {
      for (const [line1, ev] of session.shadowValues) {
        const line = line1 - 1;
        if (line < 0 || line >= lineCount || !session.dirtyLines.has(line1)) continue;
        const hover = new vscode.MarkdownString(undefined, true);
        hover.isTrusted = true;
        const args = encodeURIComponent(JSON.stringify({ logId: ev.logId }));
        hover.appendMarkdown(`**≈ ${ev.context ?? ''}** · from the last run, not re-executed &nbsp; [$(search) Explore value](command:pyokka.exploreEntity?${args}) &nbsp;|&nbsp; [$(copy) Copy](command:pyokka.hoverCopy?${args})\n\n`);
        hover.appendCodeblock(truncateOneLine(ev.text, 400), 'python');
        items.push({ line, col: 0, text: `≈ ${truncateOneLine(ev.text)}`, kind: 'log', hover });
      }
    }
    for (const err of state.errors) {
      if (err.handled) continue;
      const loc = state.files.locate(err.rid);
      if (!loc || loc.fileId !== fileId) continue;
      if (filter.exactStep !== undefined ? err.step !== filter.exactStep : filter.asOfStep !== undefined && err.step > filter.asOfStep) continue;
      const line = loc.range[2] - 1;
      if (line < 0 || line >= lineCount) continue;
      if (session.dirtyLines.has(loc.range[0]) || session.dirtyLines.has(loc.range[2])) continue;
      const hover = new vscode.MarkdownString();
      hover.appendCodeblock(`${err.errorType}: ${err.message}`, 'text');
      items.push({ line, col: loc.range[3] + 1, text: truncateOneLine(err.message || err.errorType), kind: 'error', hover });
    }
    return items;
  }

  /**
   * The inline items an editor shows: `items` in full, `dimmed` for values as of the current
   * Time Machine step that an earlier step produced. `renderInline` paints exactly this and
   * `inlineValues` reports it, so the two cannot drift.
   */
  private computeInline(editor: vscode.TextEditor, session: Session, fileId: number | undefined): { items: InlineItem[]; dimmed: InlineItem[] } {
    const lineCount = editor.document.lineCount;
    // While navigating: 'currentStep' shows only the active step's values (Quokka), 'dimOthers' adds
    // the other lines' values as of the current step, dimmed (nothing for a statement that has not
    // run yet), 'all' changes nothing.
    const navMode = session.nav.active ? navInlineMode() : undefined;
    const step = session.nav.currentStep;
    let items: InlineItem[] = [];
    let dimmed: InlineItem[] = [];
    if (fileId !== undefined) {
      items = this.inlineItems(session, session.state, fileId, lineCount, navMode === 'currentStep' || navMode === 'dimOthers' ? { exactStep: step } : {});
      if (navMode === 'dimOthers') {
        const fullLines = new Set(items.map((i) => i.line));
        dimmed = this.inlineItems(session, session.state, fileId, lineCount, { asOfStep: step }).filter((i) => !fullLines.has(i.line));
      }
    }
    if (session.running && session.previous && navMode === undefined) {
      const prevFileId = editor.document === session.document ? session.previous.files.byPath(session.filePath)?.fileId : session.previous.files.byPath(editor.document.uri.fsPath)?.fileId;
      if (prevFileId !== undefined) {
        const usedLines = new Set(items.map((i) => i.line));
        const prev = this.inlineItems(session, session.previous, prevFileId, lineCount, {}).filter((i) => !usedLines.has(i.line));
        items = items.concat(prev);
      }
    }
    return { items, dimmed };
  }

  /** The inline values `editor` shows, 1-based lines, sorted by line then column; `dim` marks a value from an earlier Time Machine step. Empty without a session. */
  inlineValues(editor: vscode.TextEditor): InlineValue[] {
    if (editor.document.uri.scheme === 'pyokka-code-timeline' || editor.document.uri.scheme === 'pyokka-recent') return [];
    const session = this.manager.sessionForDocument(editor.document);
    if (!session || session.isDisposed) return [];
    const { items, dimmed } = this.computeInline(editor, session, session.fileIdForDocument(editor.document));
    const all = items.map((item) => ({ item, dim: false })).concat(dimmed.map((item) => ({ item, dim: true })));
    all.sort((a, b) => a.item.line - b.item.line || a.item.col - b.item.col);
    return all.map(({ item, dim }) => ({ line: item.line + 1, text: item.text, kind: item.kind, dim }));
  }

  private renderInline(editor: vscode.TextEditor, session: Session, fileId: number | undefined): void {
    const { items, dimmed } = this.computeInline(editor, session, fileId);
    const group = (list: InlineItem[]): Record<InlineKind, vscode.DecorationOptions[]> => {
      list.sort((a, b) => a.line - b.line || a.col - b.col);
      const byKind: Record<InlineKind, vscode.DecorationOptions[]> = { log: [], system: [], error: [] };
      for (const item of list) {
        const lineLen = editor.document.lineAt(item.line).text.length;
        const pos = new vscode.Position(item.line, lineLen);
        byKind[item.kind].push({ range: new vscode.Range(pos, pos), renderOptions: { after: { contentText: item.text } }, hoverMessage: item.hover });
      }
      return byKind;
    };
    const full = group(items);
    const dim = group(dimmed);
    for (const k of ['log', 'system', 'error'] as InlineKind[]) {
      editor.setDecorations(this.types.inline[k], full[k]);
      editor.setDecorations(this.types.inlineDim[k], dim[k]);
    }
  }

  /* ---------- time machine ---------- */

  private renderTimeMachine(editor: vscode.TextEditor, session: Session, fileId: number | undefined): void {
    const nav = session.nav;
    const trace = session.trace;
    const watchRanges: vscode.Range[] = [];
    for (const w of session.watches) if (w.range && (w.fileId === undefined || w.fileId === fileId)) watchRanges.push(toVsRange(w.range));
    if (!nav.active || !trace || fileId === undefined || !trace.valid(nav.currentStep)) {
      editor.setDecorations(this.types.currentStep, []);
      editor.setDecorations(this.types.deadEnd, []);
      editor.setDecorations(this.types.callStackFrame, []);
      editor.setDecorations(this.types.scopeLine, []);
      editor.setDecorations(this.types.echo, []);
      editor.setDecorations(this.types.watch, nav.active ? watchRanges : []);
      return;
    }
    const loc = trace.location(nav.currentStep);
    const current: vscode.Range[] = [];
    if (loc && loc.fileId === fileId) current.push(toVsRange(loc.range));
    editor.setDecorations(this.types.currentStep, nav.deadEnd ? [] : current);
    editor.setDecorations(this.types.deadEnd, nav.deadEnd ? current : []);

    // selected call-stack frame (only frames other than the innermost get the green highlight)
    const frames: vscode.Range[] = [];
    if (nav.showCallStack && nav.selectedFrame > 0) {
      const stack = trace.callStack(nav.currentStep);
      const frame = stack[nav.selectedFrame];
      if (frame && frame.fileId === fileId && frame.line > 0) frames.push(new vscode.Range(frame.line - 1, 0, frame.line - 1, 0));
    }
    editor.setDecorations(this.types.callStackFrame, frames);

    // def line of the current scope
    const scopeRanges: vscode.Range[] = [];
    const scope = trace.scope(trace.scopeId(nav.currentStep));
    if (scope) {
      const sloc = session.locate(scope.rid);
      if (sloc && sloc.fileId === fileId && sloc.range[0] > 0 && sloc.range[0] <= editor.document.lineCount) {
        const line = editor.document.lineAt(sloc.range[0] - 1);
        scopeRanges.push(new vscode.Range(line.lineNumber, line.firstNonWhitespaceCharacterIndex, line.lineNumber, line.text.length));
      }
    }
    editor.setDecorations(this.types.scopeLine, scopeRanges);

    // echo: other textual occurrences of the current expression (identifier-like statements only)
    const echo: vscode.Range[] = [];
    if (nav.echo && loc && loc.fileId === fileId && loc.range[0] === loc.range[2]) {
      const text = editor.document.getText(toVsRange(loc.range)).trim();
      if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(text) && text.length > 1) {
        const re = new RegExp(`(?<![A-Za-z0-9_.])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
        const source = editor.document.getText();
        let m: RegExpExecArray | null;
        let n = 0;
        while ((m = re.exec(source)) && n < 200) {
          const start = editor.document.positionAt(m.index);
          const r = new vscode.Range(start, editor.document.positionAt(m.index + m[0].length));
          if (!r.isEqual(current[0]!)) {
            echo.push(r);
            n++;
          }
        }
      }
    }
    editor.setDecorations(this.types.echo, echo);
    editor.setDecorations(this.types.watch, watchRanges);
  }

  /** Flash the current step red for `ms`, then restore. */
  flashDeadEnd(session: Session, ms = 450): void {
    session.nav.deadEnd = true;
    this.refreshSession(session);
    if (this.deadEndTimer) clearTimeout(this.deadEndTimer);
    this.deadEndTimer = setTimeout(() => {
      session.nav.deadEnd = false;
      if (!session.isDisposed) this.refreshSession(session);
    }, ms);
  }
}
