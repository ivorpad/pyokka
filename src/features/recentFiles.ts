/**
 * Recent Pyokka Files virtual document with per-entry code lenses.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionManager } from '../session/sessionManager';
import type { RecentFile } from '../session/recentFilesStore';

export const RECENT_SCHEME = 'pyokka-recent';
export const RECENT_URI = vscode.Uri.from({ scheme: RECENT_SCHEME, path: 'Recent Pyokka Files' });
const WJ = '⁠'; // word joiner fences around names
const FSP = ' '; // figure space fences around dates
const ZWSP = '​';

interface Rendered {
  text: string;
  headers: { line: number; entry: RecentFile }[];
}

export class RecentFilesView implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private rendered: Rendered | undefined;

  constructor(private readonly manager: SessionManager) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(RECENT_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: RECENT_SCHEME }, this),
      manager.recentFiles.onDidChange(() => {
        this.rendered = undefined;
        this.changeEmitter.fire(RECENT_URI);
        this.lensEmitter.fire();
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  async show(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(RECENT_URI);
    if (doc.languageId !== 'pyokka-recent') await vscode.languages.setTextDocumentLanguage(doc, 'pyokka-recent');
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  provideTextDocumentContent(): string {
    return this.render().text;
  }

  private render(): Rendered {
    if (this.rendered) return this.rendered;
    const entries = this.manager.recentFiles.list();
    const out: string[] = [];
    const headers: Rendered['headers'] = [];
    if (!entries.length) out.push('# No recent Pyokka files yet. Start Pyokka on a file (Cmd/Ctrl+K Q) and it appears here.');
    for (const e of entries) {
      headers.push({ line: out.length, entry: e });
      out.push(`${WJ}${e.name}${WJ}  ${FSP}${new Date(e.timestamp).toLocaleString()}${FSP}${e.projectRoot ? `  ${e.projectRoot}` : ''}`);
      out.push('');
      const preview = this.preview(e);
      if (preview.length) {
        out.push(ZWSP);
        for (const l of preview) out.push(`    ${l}`);
        out.push(ZWSP);
      }
      out.push('', '');
    }
    this.rendered = { text: out.join('\n') + '\n', headers };
    return this.rendered;
  }

  private preview(e: RecentFile): string[] {
    let text = e.content;
    if (text === undefined && e.path) {
      try {
        text = fs.readFileSync(e.path, 'utf8');
      } catch {
        return ['# (file not found)'];
      }
    }
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    return lines.length > 40 ? [...lines.slice(0, 40), '…'] : lines;
  }

  provideCodeLenses(): vscode.CodeLens[] {
    const r = this.render();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lenses: vscode.CodeLens[] = [];
    for (const { line, entry } of r.headers) {
      const range = new vscode.Range(line, 0, line, 0);
      const add = (title: string, command: string, args: unknown): void => {
        lenses.push(new vscode.CodeLens(range, { title, command, arguments: [args] }));
      };
      add('Run', 'pyokka.runRecentFile', { id: entry.id });
      add('Clone and Run', 'pyokka.runRecentFile', { id: entry.id, clone: true });
      for (const f of folders) {
        if (f.uri.fsPath === entry.projectRoot) continue;
        add(`Run in ${f.name}`, 'pyokka.runRecentFile', { id: entry.id, folder: f.uri.fsPath });
        add(`Clone and Run in ${f.name}`, 'pyokka.runRecentFile', { id: entry.id, clone: true, folder: f.uri.fsPath });
      }
      add('Remove from recent files', 'pyokka.removeRecentFiles', { ids: [entry.id] });
    }
    return lenses;
  }

  async run(arg: { id?: string; clone?: boolean; folder?: string } | undefined): Promise<void> {
    if (!arg?.id) return;
    const entry = this.manager.recentFiles.get(arg.id);
    if (!entry) return;
    let doc: vscode.TextDocument;
    if (entry.path && !arg.clone && fs.existsSync(entry.path)) {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.path));
    } else {
      let content = entry.content ?? '';
      if (!content && entry.path) {
        try {
          content = fs.readFileSync(entry.path, 'utf8');
        } catch {
          void vscode.window.showWarningMessage(`Pyokka: ${entry.path} no longer exists.`);
          return;
        }
      }
      doc = await vscode.workspace.openTextDocument({ language: 'python', content });
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    await this.manager.start(doc, { projectRoot: arg.folder ?? entry.projectRoot });
  }

  remove(arg: { ids?: string[] } | undefined): void {
    if (arg?.ids?.length) this.manager.recentFiles.remove(arg.ids);
  }

  displayName(entry: RecentFile): string {
    return entry.path ? path.basename(entry.path) : entry.name;
  }
}
