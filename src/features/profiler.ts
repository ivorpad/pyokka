import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { SessionManager } from '../session/sessionManager';
import { log } from '../util/log';

/** `pyokka.profile`: run once under cProfile and open the resulting .cpuprofile. */
export async function profileCommand(manager: SessionManager): Promise<void> {
  const s = manager.active();
  if (!s) {
    void vscode.window.showInformationMessage('Pyokka: start a session first.');
    return;
  }
  const finished = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pyokka: profiling ${s.displayName}…` }, () => s.runNow('profile', { mode: 'profile' }));
  // the profile run is uninstrumented, so its (empty) state must not stay on screen
  s.scheduleRun('after-profile', 0);
  const profilePath = (finished as { profile?: { path?: string } }).profile?.path;
  if (!profilePath || !fs.existsSync(profilePath)) {
    log.warn(`profile run finished without a profile path: ${JSON.stringify(finished)}`);
    void vscode.window.showWarningMessage('Pyokka: the runtime did not produce a .cpuprofile file. Check the Pyokka output channel.');
    return;
  }
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(profilePath));
}
