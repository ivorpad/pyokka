/**
 * Pyokka snippets (~/.pyokka/pyokka.code-snippets), New File picker, New Python File.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionManager } from '../session/sessionManager';
import type { RecentFilesView } from './recentFiles';
import { ensureDir, pyokkaHome, readJsonFile, writeJsonFile } from '../util/paths';

export interface PyokkaSnippet {
  name: string;
  prefix: string[];
  body: string[];
  description?: string;
}

const STARTER = `// Pyokka snippets: pick one with "Pyokka: New File" (Cmd/Ctrl+K L).
// Same format as VS Code snippets; $TM_SELECTED_TEXT and $0 are supported.
{
  "Scratch with dataclass": {
    "prefix": "pyokka-dataclass",
    "body": [
      "from dataclasses import dataclass",
      "",
      "@dataclass",
      "class Point:",
      "    x: float",
      "    y: float",
      "",
      "p = Point(1, 2)",
      "p  # ?",
      "$0"
    ],
    "description": "Dataclass playground"
  },
  "Snap": {
    "prefix": "pyokka-snap",
    "body": ["\\"\\"\\"{{", "$0", "}}\\"\\"\\""],
    "description": "A Pyokka snap fence"
  }
}
`;

export const NEW_FILE_STARTER = `# 🐍 Pyokka is running this file. Values appear next to your code as you type.
# Try:  x = 42  then type  x  on its own line, or add  # ?  after any expression.

`;

export function snippetsFile(): string {
  return path.join(pyokkaHome(), 'pyokka.code-snippets');
}

export function loadSnippets(): PyokkaSnippet[] {
  const raw = readJsonFile<Record<string, { prefix?: string | string[]; body?: string | string[]; description?: string }>>(snippetsFile(), {});
  return Object.entries(raw).map(([name, s]) => ({
    name,
    prefix: Array.isArray(s.prefix) ? s.prefix : s.prefix ? [s.prefix] : [],
    body: Array.isArray(s.body) ? s.body : s.body ? [s.body] : [],
    description: s.description,
  }));
}

/** Strip snippet tab stops / placeholders so the body can be inserted as plain text. */
export function snippetBodyToText(body: string[]): string {
  return body
    .join('\n')
    .replace(/\$\{TM_SELECTED_TEXT[^}]*\}|\$TM_SELECTED_TEXT/g, '')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\|([^|]*)\|\}/g, (_m, choices: string) => choices.split(',')[0] ?? '')
    .replace(/\$\{\d+\}|\$\d+/g, '')
    .replace(/\\\$/g, '$');
}

export class SnippetsFeature {
  constructor(
    private readonly manager: SessionManager,
    private readonly recent: RecentFilesView,
  ) {}

  async editSnippets(): Promise<void> {
    const file = snippetsFile();
    if (!fs.existsSync(file)) {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, STARTER, 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.languages.setTextDocumentLanguage(doc, 'jsonc');
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async createSnippetFromSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Pyokka: select the code to turn into a snippet first.');
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Snippet name', ignoreFocusOut: true });
    if (!name) return;
    const prefix = await vscode.window.showInputBox({ prompt: 'Snippet prefix (typed to trigger it)', value: name.toLowerCase().replace(/\s+/g, '-'), ignoreFocusOut: true });
    if (prefix === undefined) return;
    const file = snippetsFile();
    const raw = readJsonFile<Record<string, unknown>>(file, {});
    const body = editor.document.getText(editor.selection).replace(/\$/g, '\\$').split(/\r?\n/);
    raw[name] = { prefix: prefix || name, body, description: `Created from ${path.basename(editor.document.fileName)}` };
    writeJsonFile(file, raw);
    const pick = await vscode.window.showInformationMessage(`Pyokka snippet "${name}" saved.`, 'Open snippets file');
    if (pick) await this.editSnippets();
  }

  async newPythonFile(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'python', content: NEW_FILE_STARTER });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const last = doc.lineCount - 1;
    editor.selection = new vscode.Selection(last, 0, last, 0);
    await this.manager.start(doc);
  }

  /** Cmd+K L: Pyokka snippets + recent files + an empty file. Snippets enable auto log. */
  async createFile(): Promise<void> {
    type Item = vscode.QuickPickItem & { action: () => Promise<void> };
    const items: Item[] = [];
    items.push({ label: '$(new-file) Empty Python file', description: 'Untitled, Pyokka started', action: () => this.newPythonFile() });
    const snippets = loadSnippets();
    if (snippets.length) items.push({ label: 'Pyokka snippets', kind: vscode.QuickPickItemKind.Separator, action: async () => undefined });
    for (const s of snippets) {
      items.push({
        label: `$(symbol-snippet) ${s.name}`,
        description: s.prefix.join(', '),
        detail: s.description,
        action: async () => {
          const doc = await vscode.workspace.openTextDocument({ language: 'python', content: snippetBodyToText(s.body) });
          await vscode.window.showTextDocument(doc, { preview: false });
          await this.manager.start(doc, { autoLog: true });
        },
      });
    }
    const recent = this.manager.recentFiles.list().slice(0, 15);
    if (recent.length) items.push({ label: 'Recent files', kind: vscode.QuickPickItemKind.Separator, action: async () => undefined });
    for (const r of recent) {
      items.push({
        label: `$(history) ${r.name}`,
        description: new Date(r.timestamp).toLocaleString(),
        detail: r.path ?? '(untitled)',
        action: () => this.recent.run({ id: r.id }),
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => undefined });
    items.push({ label: '$(edit) Edit Pyokka snippets…', action: () => this.editSnippets() });
    items.push({ label: '$(list-unordered) View all recent files…', action: () => this.recent.show() });
    const pick = await vscode.window.showQuickPick(items, { title: 'Pyokka: New File', placeHolder: 'Pick a snippet or a recent file', matchOnDescription: true, matchOnDetail: true });
    if (pick) await pick.action();
  }
}
