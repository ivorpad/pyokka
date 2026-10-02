/**
 * The two quick picks: `pyokka.selectAction` (the status bar's menu of what to do next) and
 * `pyokka.editSessionSettings` (run mode, value toggles and session actions of the active session).
 */
import * as vscode from 'vscode';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import type { OutputPanel } from '../views/outputPanel';
import type { LiveValues } from './liveValues';
import type { RecentFilesView } from './recentFiles';
import type { StartView } from './startView';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { log } from '../util/log';

export interface QuickPickDeps {
  mgr: SessionManager;
  panel: OutputPanel;
  startView: StartView;
  liveValues: LiveValues;
  recent: RecentFilesView;
  /** the Debugger's registry: its own sessions get their own entries */
  debugSessions: DebugSessionManager;
  /** the active session, or a notice on how to start one */
  requireSession: () => Session | undefined;
}

type Item = vscode.QuickPickItem & { run: () => unknown };

export async function selectAction({ mgr, panel, startView, liveValues, recent, debugSessions }: QuickPickDeps): Promise<void> {
  const s = mgr.active();
  const items: Item[] = [
    { label: '$(home) Open start view', run: () => startView.show() },
    { label: '$(output) Show output pane', run: () => panel.show(false) },
  ];
  // the Debugger runs next to the run-all session and has its own view and its own Stop
  const ds = debugSessions.active();
  if (ds) {
    items.push(
      { label: `$(debug-alt) Show the Debugger on ${ds.displayName}`, description: ds.debug.paused ? 'paused' : 'running', run: () => vscode.commands.executeCommand('pyokka.showDebugger') },
      { label: `$(debug-stop) Stop the Debugger on ${ds.displayName}`, description: 'end the program; nothing is left to read', run: () => ds.stopDebug() },
    );
  }
  if (s) {
    items.push(
      s.debug.active
        ? { label: '$(debug-stop) Stop debugging', description: 'end the debug run, keep the session and its recording', run: () => vscode.commands.executeCommand('pyokka.debugStop') }
        : { label: `$(debug-alt) Debug ${s.displayName}`, description: 'pause at the first breakpoint, or before the first statement', run: () => vscode.commands.executeCommand('pyokka.debugCurrentFile') },
      { label: `$(debug-stop) Stop ${s.displayName}`, run: () => mgr.stopSession(s, true) },
      { label: `$(list-flat) ${s.autoLog ? 'Disable' : 'Enable'} Auto Log`, description: 'show a value for every line', run: () => liveValues.setAutoLog(!s.autoLog) },
      { label: `$(eye) ${s.showValueOnSelection ? 'Disable' : 'Enable'} Show Value On Selection`, run: () => liveValues.setShowValueOnSelection(!s.showValueOnSelection) },
      { label: s.showSingleInlineValue ? '$(list-selection) Show All Displayed Values' : '$(list-selection) Show Last Displayed Value Only', run: () => liveValues.setShowSingleInlineValue(!s.showSingleInlineValue) },
    );
  }
  items.push({ label: '$(history) View Recent Files', run: () => recent.show() });
  if (s) items.push({ label: '$(settings-gear) Edit session settings', run: () => vscode.commands.executeCommand('pyokka.editSessionSettings') });
  items.push({ label: '$(python) Select Python interpreter', run: () => vscode.commands.executeCommand('pyokka.selectInterpreter') });
  items.push({ label: '$(list-ordered) Show logs', run: () => log.show() });
  const pick = await vscode.window.showQuickPick(items, { title: s ? `Pyokka · ${s.displayName} (${s.status}, ${s.runMode})` : 'Pyokka', placeHolder: 'Pyokka actions' });
  if (pick) await pick.run();
}

export async function editSessionSettings({ mgr, liveValues, requireSession }: QuickPickDeps): Promise<void> {
  const s = requireSession();
  if (!s) return;
  const check = (on: boolean): string => (on ? '$(check) ' : '$(circle-large-outline) ');
  const items: Item[] = [
    { label: 'Run mode', kind: vscode.QuickPickItemKind.Separator, run: () => undefined },
    { label: `${check(s.runMode === 'auto')}Automatic`, description: 'run on every edit', run: () => s.setRunMode('auto') },
    { label: `${check(s.runMode === 'onSave')}On save`, run: () => s.setRunMode('onSave') },
    { label: `${check(s.runMode === 'onDemand')}On demand`, description: 'F5 re-executes', run: () => s.setRunMode('onDemand') },
    { label: 'Values', kind: vscode.QuickPickItemKind.Separator, run: () => undefined },
    { label: `${check(s.autoLog)}Auto Log`, description: 'show a value for every line', run: () => liveValues.setAutoLog(!s.autoLog) },
    { label: `${check(s.valuePeek)}Value Peek`, description: 'evaluate on hover', run: () => s.setValuePeek(!s.valuePeek) },
    { label: `${check(s.showValueOnSelection)}Show Value On Selection`, run: () => liveValues.setShowValueOnSelection(!s.showValueOnSelection) },
    { label: `${check(s.showSingleInlineValue)}Show Last Displayed Value Only`, run: () => liveValues.setShowSingleInlineValue(!s.showSingleInlineValue) },
    { label: 'Session', kind: vscode.QuickPickItemKind.Separator, run: () => undefined },
    { label: '$(refresh) Re-execute', run: () => s.runNow('manual') },
    { label: '$(debug-stop) Stop session', run: () => mgr.stopSession(s, true) },
    { label: '$(settings) Open Pyokka settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'pyokka') },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: `Pyokka session settings · ${s.displayName}`, placeHolder: `Interpreter: ${s.interpreter.path} (Python ${s.interpreter.version.join('.')})` });
  if (pick) await pick.run();
}
