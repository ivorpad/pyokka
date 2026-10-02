/**
 * Snaps: `"""{{ … }}"""` fences discovered in Python files, per-file allow, output write-back.
 */
import * as vscode from 'vscode';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { setContext } from '../util/context';
import { setting } from '../config/settings';
import { inlineTextFor } from '../session/valuesAsOf';

import { findSnaps, fenceAt, OUTPUT_PREFIX, type SnapFence } from './snapFences';
export { findSnaps, fenceAt, OUTPUT_PREFIX, type SnapFence } from './snapFences';

const ALLOWED_KEY = 'pyokka.snapsAllowed';
const DISCOVERY_OFF_KEY = 'pyokka.snapsDiscoveryOff';

export class Snaps implements vscode.HoverProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lastSpace = new Map<string, number>();
  private readonly fenceCounts = new Map<string, number>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SessionManager,
  ) {
    this.disposables.push(
      vscode.languages.registerHoverProvider({ language: 'python' }, this),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
    );
    manager.on('sessionStarted', (s) => void this.onSessionStarted(s));
    manager.on('activeChanged', () => this.updateContext());
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /* ---------- state ---------- */

  private allowedSet(): Set<string> {
    return new Set(this.context.workspaceState.get<string[]>(ALLOWED_KEY, []));
  }

  isAllowed(doc: vscode.TextDocument): boolean {
    return this.allowedSet().has(doc.uri.toString());
  }

  private async setAllowed(doc: vscode.TextDocument, allowed: boolean): Promise<void> {
    const set = this.allowedSet();
    if (allowed) set.add(doc.uri.toString());
    else set.delete(doc.uri.toString());
    await this.context.workspaceState.update(ALLOWED_KEY, [...set]);
    this.updateContext();
  }

  private discoveryEnabled(doc: vscode.TextDocument): boolean {
    if (!setting<boolean>('snapsAutoDiscovery', true, doc.uri)) return false;
    return !this.context.workspaceState.get<string[]>(DISCOVERY_OFF_KEY, []).includes(doc.uri.toString());
  }

  updateContext(): void {
    const editor = vscode.window.activeTextEditor;
    setContext('snapsExecutionAllowed', !!editor && this.isAllowed(editor.document));
  }

  /* ---------- discovery ---------- */

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!this.discoveryEnabled(document)) return undefined;
    const fences = findSnaps(document.getText());
    const f = fenceAt(fences, position.line);
    if (!f || position.line !== f.openLine) return undefined;
    if (this.isAllowed(document)) {
      const md = new vscode.MarkdownString('**Pyokka snap** (execution allowed) · [Insert output](command:pyokka.insertSnapOutput) · [Delete output](command:pyokka.deleteSnapOutput)');
      md.isTrusted = true;
      return new vscode.Hover(md, new vscode.Range(f.openLine, 0, f.openLine, document.lineAt(f.openLine).text.length));
    }
    const md = new vscode.MarkdownString('**Pyokka snaps detected.** Snaps run the fenced code in module scope. [Allow](command:pyokka.allowFileSnapsExecution "Allow snaps execution in this file") (or press Space twice inside the fence)');
    md.isTrusted = true;
    return new vscode.Hover(md, new vscode.Range(f.openLine, 0, f.openLine, document.lineAt(f.openLine).text.length));
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (doc.languageId !== 'python' || !this.discoveryEnabled(doc)) return;
    const fences = findSnaps(doc.getText());
    // double Space inside a fence allows execution
    const change = e.contentChanges[0];
    if (change && change.text === ' ' && e.contentChanges.length === 1 && !this.isAllowed(doc)) {
      const f = fenceAt(fences, change.range.start.line);
      if (f && change.range.start.line > f.openLine && change.range.start.line < f.closeLine) {
        const now = Date.now();
        const key = doc.uri.toString();
        const prev = this.lastSpace.get(key) ?? 0;
        this.lastSpace.set(key, now);
        if (now - prev < 500) {
          this.lastSpace.delete(key);
          void this.removeDoubleSpace(doc, change.range.start).then(() => this.allow(doc));
          return;
        }
      }
    }
    // newly added fences while allowed: optional confirmation
    const key = doc.uri.toString();
    const prevCount = this.fenceCounts.get(key) ?? fences.length;
    this.fenceCounts.set(key, fences.length);
    if (fences.length > prevCount && this.isAllowed(doc) && setting<boolean>('snapsAutoRunConfirmOnEdit', true, doc.uri)) {
      void vscode.window.showInformationMessage('Pyokka: a new snap was added. Run all snaps in this file?', 'Run', 'Stop running snaps').then(async (pick) => {
        if (pick === 'Stop running snaps') {
          await this.setAllowed(doc, false);
          const s = this.manager.get(doc);
          if (s) {
            s.mode = 'normal';
            s.scheduleRun('snaps', 0);
          }
        }
      });
    }
  }

  private async removeDoubleSpace(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
    if (!editor) return;
    const line = doc.lineAt(pos.line).text;
    const end = pos.character + 1;
    const start = Math.max(0, end - 2);
    if (line.slice(start, end) !== '  ') return;
    await editor.edit((b) => b.delete(new vscode.Range(pos.line, start, pos.line, end)), { undoStopBefore: false, undoStopAfter: false });
  }

  private async onSessionStarted(session: Session): Promise<void> {
    const doc = session.document;
    if (!this.isAllowed(doc) || !this.discoveryEnabled(doc)) return;
    const fences = findSnaps(doc.getText());
    this.fenceCounts.set(doc.uri.toString(), fences.length);
    if (!fences.length) return;
    if (setting<boolean>('snapsAutoRunConfirmOnOpen', true, doc.uri)) {
      const pick = await vscode.window.showInformationMessage(`Pyokka: ${doc.fileName.split(/[\\/]/).pop()} has ${fences.length} snap(s) allowed earlier. Run them?`, 'Run snaps', 'Not now');
      if (pick !== 'Run snaps') return;
    }
    session.mode = 'snaps';
    session.scheduleRun('snaps', 0);
  }

  /* ---------- commands ---------- */

  async allow(doc?: vscode.TextDocument): Promise<void> {
    const document = doc ?? vscode.window.activeTextEditor?.document;
    if (!document) return;
    await this.setAllowed(document, true);
    let s = this.manager.get(document);
    if (!s) s = await this.manager.start(document, { mode: 'snaps' });
    if (!s) return;
    s.mode = 'snaps';
    s.scheduleRun('snaps', 0);
  }

  async setDiscovery(on: boolean): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return;
    const set = new Set(this.context.workspaceState.get<string[]>(DISCOVERY_OFF_KEY, []));
    if (on) set.delete(doc.uri.toString());
    else set.add(doc.uri.toString());
    await this.context.workspaceState.update(DISCOVERY_OFF_KEY, [...set]);
    vscode.window.setStatusBarMessage(`Pyokka: snaps discovery ${on ? 'started' : 'stopped'} for this file`, 2500);
  }

  private outputBlock(doc: vscode.TextDocument, fence: SnapFence): vscode.Range {
    let end = fence.closeLine + 1;
    while (end < doc.lineCount && doc.lineAt(end).text.trimStart().startsWith(OUTPUT_PREFIX.trim())) end++;
    return new vscode.Range(fence.closeLine + 1, 0, end, 0);
  }

  async insertOutput(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const s = this.manager.get(editor.document);
    const fences = findSnaps(editor.document.getText());
    const fence = fenceAt(fences, editor.selection.active.line) ?? fences[0];
    if (!fence) {
      void vscode.window.showInformationMessage('Pyokka: no snap fence at the cursor.');
      return;
    }
    const lines: string[] = [];
    if (s) {
      const fileId = s.fileIdForDocument(editor.document);
      const byRid = new Map<number, typeof s.state.entries>();
      for (const e of s.visibleEntries()) {
        const loc = s.locate(e.rid);
        if (!loc || loc.fileId !== fileId) continue;
        const line0 = loc.range[0] - 1;
        if (line0 <= fence.openLine || line0 >= fence.closeLine) continue;
        const list = byRid.get(e.rid) ?? [];
        list.push(e);
        byRid.set(e.rid, list);
      }
      const ordered = [...byRid.entries()].sort((a, b) => (s.locate(a[0])?.range[0] ?? 0) - (s.locate(b[0])?.range[0] ?? 0));
      for (const [, logs] of ordered) lines.push(inlineTextFor(logs).text);
      for (const err of s.state.errors) {
        const loc = s.locate(err.rid);
        if (loc && loc.fileId === fileId && loc.range[0] - 1 > fence.openLine && loc.range[0] - 1 < fence.closeLine) lines.push(`${err.errorType}: ${err.message}`);
      }
    }
    if (!lines.length) lines.push('(no output)');
    const indent = /^\s*/.exec(editor.document.lineAt(fence.closeLine).text)?.[0] ?? '';
    const text = lines.map((l) => `${indent}${OUTPUT_PREFIX}${l}`).join('\n') + '\n';
    const block = this.outputBlock(editor.document, fence);
    await editor.edit((b) => b.replace(block, text));
  }

  async deleteOutput(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const fences = findSnaps(editor.document.getText());
    const fence = fenceAt(fences, editor.selection.active.line) ?? fences.find((f) => this.outputBlock(editor.document, f).end.line > f.closeLine + 1);
    if (!fence) return;
    const block = this.outputBlock(editor.document, fence);
    if (block.isEmpty) return;
    await editor.edit((b) => b.delete(block));
  }
}
