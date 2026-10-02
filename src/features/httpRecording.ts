/**
 * "Pyokka: Open HTTP Recording": the JSONL the last run wrote or read, beside the editor, with a
 * row's line selected when one is named (the header is line 1, row n is line n + 1).
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { Session } from '../session/session';

/** A command argument naming a row: a number or `{n}`; undefined for anything else. */
export function pickN(arg: unknown): number | undefined {
  const n = typeof arg === 'number' ? arg : arg && typeof arg === 'object' ? (arg as { n?: unknown }).n : undefined;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The `recorded` timestamp of a recording's header line; undefined when the line is not one. */
export function headerRecorded(line: string): string | undefined {
  try {
    const h = JSON.parse(line) as { pyokka?: unknown; recorded?: unknown };
    return h.pyokka === 'http' && typeof h.recorded === 'string' ? h.recorded : undefined;
  } catch {
    return undefined;
  }
}

export async function openHttpRecording(session: Session | undefined, n?: number): Promise<void> {
  const finished = session?.state.finished ?? session?.previous?.finished;
  const http = finished?.http;
  if (!session || !http?.file || !fs.existsSync(http.file)) {
    void vscode.window.showInformationMessage(session ? `Pyokka: no HTTP recording for ${session.displayName} yet (run once with HTTP Record)` : 'Pyokka: no HTTP recording yet (start a session and run once with HTTP Record)');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(http.file));
  const line = n === undefined ? 0 : Math.min(n, doc.lineCount - 1);
  const selection = new vscode.Range(line, 0, line, n === undefined ? 0 : doc.lineAt(line).text.length);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection });
  const recorded = headerRecorded(doc.lineAt(0).text);
  if (recorded && http.recordedAt && recorded !== http.recordedAt) vscode.window.setStatusBarMessage('Pyokka: the recording was rewritten by a later run', 8000);
}
