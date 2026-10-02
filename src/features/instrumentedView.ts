import * as vscode from 'vscode';
import type { SessionManager } from '../session/sessionManager';

/**
 * `pyokka.showInstrumentedFile`: the runtime's instrumented source in an untitled editor.
 * The active editor's file when the last run instrumented it (a project or library module),
 * otherwise the session's main file. Library files are fetched from the runner on demand.
 */
export async function showInstrumentedFile(manager: SessionManager): Promise<void> {
  const s = manager.active();
  if (!s) return;
  const editor = vscode.window.activeTextEditor;
  const fileId = (editor ? s.fileIdForDocument(editor.document) : undefined) ?? s.mainFileId();
  let src: string | undefined;
  try {
    src = fileId === undefined ? undefined : await s.instrumentedSource(fileId);
  } catch (err) {
    void vscode.window.showErrorMessage(`Pyokka: could not get the instrumented source: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!src) {
    void vscode.window.showInformationMessage('Pyokka: no instrumented source is available yet (run the file first).');
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'python', content: src });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}
