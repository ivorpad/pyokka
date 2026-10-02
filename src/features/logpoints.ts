/**
 * VS Code breakpoints / logpoints for session files -> `logpoint` markers; keeps
 * `hasAnyEnabledBreakpointsInActiveEditor` current.
 */
import * as vscode from 'vscode';
import type { Range4 } from '../shared/protocol';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { setContext } from '../util/context';

export class Logpoints implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: SessionManager) {
    this.disposables.push(
      vscode.debug.onDidChangeBreakpoints(() => this.refreshAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
    );
    manager.on('sessionStarted', (s) => this.apply(s));
    this.refreshAll();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  refreshAll(): void {
    for (const s of this.manager.all()) this.apply(s);
    this.updateContext();
  }

  private breakpointsFor(session: Session): vscode.SourceBreakpoint[] {
    return vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint && bp.location.uri.toString() === session.key);
  }

  apply(session: Session): void {
    const points: { range: Range4; logMessage: string }[] = [];
    for (const bp of this.breakpointsFor(session)) {
      if (!bp.enabled || !bp.logMessage) continue;
      const line = bp.location.range.start.line;
      let range: Range4;
      if (line < session.document.lineCount) {
        const l = session.document.lineAt(line);
        range = [line + 1, l.firstNonWhitespaceCharacterIndex, line + 1, l.text.length];
      } else range = [line + 1, 0, line + 1, 0];
      points.push({ range, logMessage: bp.logMessage });
    }
    session.setLogpoints(points);
  }

  updateContext(): void {
    const editor = vscode.window.activeTextEditor;
    const has = !!editor && vscode.debug.breakpoints.some((bp) => bp instanceof vscode.SourceBreakpoint && bp.enabled && bp.location.uri.toString() === editor.document.uri.toString());
    setContext('hasAnyEnabledBreakpointsInActiveEditor', has);
  }
}
