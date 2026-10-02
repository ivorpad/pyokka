/**
 * VS Code's breakpoints reach debug runs. The enabled file breakpoints that are not logpoints go
 * into every run request while debug mode is on (the controller merges them with the session's
 * own list), and a change in the gutter while a debug run is in flight is pushed to it at once
 * (`debug breakpoints`), so a breakpoint set on a module before its import is honoured too.
 * Logpoints stay markers (logpoints.ts).
 *
 * The class also keeps `pyokka.activeFileHasBreakpoints`, the key that gives `F5` back to Start
 * Debugging when the active file has a breakpoint that can pause.
 *
 * Both products share the gutter and nothing else, so a change is pushed to every run-all session
 * in debug mode and to every `DebugSession` in the Debugger's registry.
 */
import * as vscode from 'vscode';
import type { SessionManager } from '../session/sessionManager';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { fileHasBreakpoints, functionBreakpoint, mapSourceBreakpoints, type BreakpointSpec, type SourceBreakpointLike } from '../session/debugState';
import { setContext } from '../util/context';
import { log } from '../util/log';

/** VS Code's source breakpoints in the structural shape debugState.ts reads. */
function sourceBreakpointsLike(): SourceBreakpointLike[] {
  return vscode.debug.breakpoints
    .filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint)
    .map((b) => ({ enabled: b.enabled, condition: b.condition, logMessage: b.logMessage, location: { uri: { scheme: b.location.uri.scheme, fsPath: b.location.uri.fsPath }, range: { start: { line: b.location.range.start.line } } } }));
}

/** The gutter's breakpoints as a run wants them: enabled, in files, not logpoints, 1-based lines. */
export function currentSourceBreakpoints(): BreakpointSpec[] {
  return mapSourceBreakpoints(sourceBreakpointsLike());
}

/**
 * The Breakpoints view's function breakpoints ("Add Function Breakpoint", and `--at NAME`) as
 * `{function}` specs. The runtime resolves the name from its rid-to-name table, so a module
 * imported later gets its breakpoint when it loads.
 */
export function currentFunctionBreakpoints(): BreakpointSpec[] {
  return vscode.debug.breakpoints
    .filter((b): b is vscode.FunctionBreakpoint => b instanceof vscode.FunctionBreakpoint)
    .filter((b) => b.enabled && b.functionName.trim())
    .map((b) => functionBreakpoint(b.functionName, b.condition));
}

export class DebugBreakpoints implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: SessionManager,
    /** the Debugger's registry: a gutter change reaches both products */
    private readonly debugSessions: DebugSessionManager,
  ) {
    this.disposables.push(
      vscode.debug.onDidChangeBreakpoints(() => {
        this.pushAll();
        this.updateContext();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
    );
    this.updateContext();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** `pyokka.activeFileHasBreakpoints`: false without an editor, and for anything but a file. */
  private updateContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    setContext('activeFileHasBreakpoints', !!uri && uri.scheme === 'file' && fileHasBreakpoints(sourceBreakpointsLike(), uri.fsPath));
  }

  private pushAll(): void {
    for (const s of this.manager.all()) {
      if (!s.debug.active) continue;
      void s.debugCtl.syncVsCodeBreakpoints()?.catch((err) => log.warn(`breakpoints not pushed to ${s.displayName}: ${err instanceof Error ? err.message : String(err)}`));
    }
    for (const ds of this.debugSessions.all()) {
      void ds.syncVsCodeBreakpoints()?.catch((err) => log.warn(`breakpoints not pushed to ${ds.displayName}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
