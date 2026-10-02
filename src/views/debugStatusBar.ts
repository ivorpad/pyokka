/**
 * The Debugger's status bar item (docs/design/debugger-product.md, 3.11), just right of the
 * session item: `Debugger: paused at app.py:42 (breakpoint)` while a debug session is paused,
 * `Debugger: running` while one runs, hidden when none exists. A recording debug run keeps using
 * the run-all item's `debugSegment` instead; this item belongs to `record: false` sessions.
 *
 * The text is built by the pure `debuggerStatusText` in statusText.ts.
 */
import * as vscode from 'vscode';
import type { DebugSession } from '../debug/debugSession';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { launchLine } from '../debug/debugSessionState';
import { debuggerStatusText } from './statusText';

export class DebugStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: DebugSessionManager) {
    this.item = vscode.window.createStatusBarItem('pyokka.debugStatus', vscode.StatusBarAlignment.Left, 49);
    this.item.name = 'Pyokka Debugger';
    this.item.command = 'pyokka.showDebugger';
    manager.on('changed', () => this.render());
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.render()));
    this.render();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.item.dispose();
  }

  private render(): void {
    const ds = this.manager.active();
    if (!ds) {
      this.item.hide();
      return;
    }
    const text = debuggerStatusText(ds.debug, ds.displayName, ds.running);
    if (!text) {
      this.item.hide();
      return;
    }
    this.item.text = `${ds.debug.paused ? '$(debug-pause)' : '$(debug-alt-small)'} ${text}`;
    this.item.tooltip = tooltip(ds);
    this.item.show();
  }
}

function tooltip(ds: DebugSession): string {
  const lines = [`${launchLine(ds.resolvedLaunch)}  ·  ${ds.launch.cwd}`];
  if (ds.modified) lines.push('modified: values were changed from the console');
  // the run timeout is not applied to a debug session: a paused server must outlive any clock
  lines.push('pyokka.runTimeout does not apply while the Debugger is attached');
  return lines.join('\n');
}
