/**
 * "Pyokka: Clear Library Cache": empty the runtime's cache of instrumented library files.
 *
 * Mirrors `python/pyokka_runtime/cache.py` (`pyokka cache --clear`): the directory is
 * `PYOKKA_CACHE_DIR` when the run child would see it set (empty = the cache is off), else
 * `~/.pyokka/cache`; the entries are the `*.bin` files at its top level, the runtime's `.tmp-*.bin`
 * leftovers included. Nothing else is touched, so a `PYOKKA_CACHE_DIR` that points at a shared
 * folder loses only cache entries, and the directory itself stays. The next run with library code
 * on rewrites what it needs; a session running while the cache is cleared gets one slow run at most.
 *
 * Plain file operations under the user's home: no interpreter, no shell, no privileges, so it works
 * on a locked-down machine where the runtime cannot be reached or is the thing being suspected.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSessionConfig } from '../config/settings';
import type { SessionManager } from '../session/sessionManager';
import { formatBytes } from '../session/httpTable';
import { pyokkaHome } from '../util/paths';
import { log } from '../util/log';

export interface ClearResult {
  removed: number;
  bytes: number;
  /** entries that stayed: in use (Windows) or read-only */
  failed: number;
}

/** The directory the runtime caches into under `env`, or undefined when the cache is off. */
export function libraryCacheDir(env: Record<string, string | undefined>): string | undefined {
  const set = env['PYOKKA_CACHE_DIR'];
  if (set !== undefined) return set || undefined;
  return path.join(pyokkaHome(env), 'cache');
}

/** Remove the entries of `dir`; a missing directory is empty. Throws when the directory cannot be listed. */
export function clearLibraryCache(dir: string): ClearResult {
  const out: ClearResult = { removed: 0, bytes: 0, failed: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw new Error(`could not read the library cache at ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
    const file = path.join(dir, entry.name);
    try {
      const size = fs.statSync(file).size;
      fs.unlinkSync(file);
      out.removed++;
      out.bytes += size;
    } catch {
      out.failed++;
    }
  }
  return out;
}

/** The sentence the command shows for `result` (undefined when the cache is off). */
export function describeClear(dir: string | undefined, result: ClearResult | undefined): string {
  if (!dir || !result) return 'the library cache is off (PYOKKA_CACHE_DIR is empty); nothing to clear.';
  const files = (n: number): string => (n === 1 ? '1 cached library file' : `${n} cached library files`);
  if (!result.removed && !result.failed) return `the library cache at ${dir} is already empty.`;
  if (!result.removed) return `none of the ${files(result.failed)} at ${dir} could be removed (in use or read-only).`;
  const kept = result.failed ? ` ${result.failed} could not be removed (in use or read-only).` : '';
  return `removed ${files(result.removed)} (${formatBytes(result.bytes)}) from ${dir}; the next run with Step Into Library Code on rewrites what it needs.${kept}`;
}

/**
 * The environment the run child sees: the active session's when there is one, else the settings and
 * config files resolved for the active document (or the first workspace folder) over the host's own.
 */
function runtimeEnv(mgr: SessionManager): Record<string, string | undefined> {
  const session = mgr.active();
  if (session) return { ...process.env, ...session.config.env };
  const doc = vscode.window.activeTextEditor?.document;
  const root = doc ? mgr.workspaceRootFor(doc) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const fileDir = doc?.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : undefined;
  return { ...process.env, ...resolveSessionConfig(doc?.uri, root || undefined, fileDir).env };
}

export function clearLibraryCacheCommand(mgr: SessionManager): void {
  const dir = libraryCacheDir(runtimeEnv(mgr));
  const message = describeClear(dir, dir ? clearLibraryCache(dir) : undefined);
  log.info(`clear library cache: ${message}`);
  void vscode.window.showInformationMessage(`Pyokka: ${message}`);
}
