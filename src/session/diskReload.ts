/**
 * Edits made on disk outside VS Code (another editor, an agent, `git checkout`) and On Save sessions.
 *
 * VS Code reloads a clean document that changed on disk as a content change, with no
 * `onDidSaveTextDocument`, so an On Save session never saw it. `isDiskReload` tells that reload
 * from typing: the document is clean and its text is what the file holds. An imported file that
 * is not open has no document at all; `SessionManager` watches it and reruns the sessions that
 * imported it (`isProjectFile` says which files are worth a watch).
 */
import { readFileSync } from 'node:fs';

/** The part of a `vscode.TextDocument` the rule reads (structural, so tests need no vscode). */
export interface DocumentLike {
  uri: { scheme: string; fsPath: string };
  isDirty: boolean;
  getText(): string;
}

/** A disk reload: clean, a file, and the text matches disk. An edit can arrive before VS Code marks the document dirty. */
export function isDiskReload(doc: DocumentLike, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): boolean {
  if (doc.uri.scheme !== 'file' || doc.isDirty) return false;
  try {
    // VS Code drops the UTF-8 BOM when it opens a document
    return read(doc.uri.fsPath).replace(/^﻿/, '') === doc.getText();
  } catch {
    return false;
  }
}

/** A recorded file the user owns: not a library under site-packages, not a frozen or stdlib module. */
export function isProjectFile(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? !/[\\/](site|dist)-packages[\\/]/.test(p) && !/[\\/]lib[\\/]python3\.\d+[\\/]/.test(p) : false;
}

/** After a watch starts, the file is read again this long after: a directory watch on macOS can miss a write made while it starts. */
export const SETTLE_READS_MS = [250, 1000] as const;
