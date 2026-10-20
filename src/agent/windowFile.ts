/**
 * Which VS Code window an agent was started from, for `pyokka debug FILE` and `pyokka review` (route (c) of
 * `python/pyokka_runtime/agent/debug_start.py`).
 *
 * `code --open-url` hands a URI to the focused window, which is not the one the agent runs in once the person
 * has clicked into another window. VS Code routes a URI whose query carries `windowId=N` to window N instead,
 * and only the window knows its own N: `asExternalUri` on the app's own scheme appends it on desktop.
 *
 * So each window writes `$PYOKKA_HOME/windows/<extension host pid>.json` with that id and its folders, and
 * puts `PYOKKA_VSCODE_PID` in the env of its terminals. The CLI finds its window by that variable, else by
 * an ancestor process (an agent the extension host spawned), else by the folder holding the file.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, pyokkaHome } from '../util/paths';
import { log } from '../util/log';

/** The variable a window's terminals carry: the pid of the extension host that wrote the window file. */
export const WINDOW_PID_ENV = 'PYOKKA_VSCODE_PID';

export function windowsDir(env: Record<string, string | undefined> = process.env): string {
  return env['PYOKKA_WINDOWS_DIR'] || path.join(pyokkaHome(env), 'windows');
}

/** The `windowId` VS Code put in the query of an external URI, or undefined when it put none (web, remote, older builds). */
export function windowIdOf(query: string): string | undefined {
  const match = /(?:^|&)windowId=(\d+)(?:&|$)/i.exec(query);
  return match?.[1];
}

export interface WindowRecord {
  pid: number;
  windowId?: string;
  folders: string[];
}

export function writeWindowFile(dir: string, record: WindowRecord): string {
  const file = path.join(ensureDir(dir), `${record.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** Write this window's file now and whenever its folders change; remove it when the extension stops. */
export function registerWindowFile(context: vscode.ExtensionContext): vscode.Disposable {
  if (vscode.env.uiKind !== vscode.UIKind.Desktop) return new vscode.Disposable(() => {});
  const dir = windowsDir();
  const file = path.join(dir, `${process.pid}.json`);
  let windowId: string | undefined;
  const write = (): void => {
    try {
      writeWindowFile(dir, { pid: process.pid, windowId, folders: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath) });
    } catch (err) {
      log.warn(`window file: could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  context.environmentVariableCollection.replace(WINDOW_PID_ENV, String(process.pid));
  void vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://ivor.pyokka/debug`)).then(
    (uri) => {
      windowId = windowIdOf(uri.query);
      if (!windowId) log.info('window file: VS Code gave no windowId, so a debug URI goes to the focused window');
      write();
    },
    () => write(),
  );
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(write);
  return new vscode.Disposable(() => {
    folders.dispose();
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  });
}
