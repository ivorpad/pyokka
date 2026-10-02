/**
 * The Debugger's registry (docs/design/debugger-product.md, 3.4): one `DebugSession` per launch
 * key. Its own object, not part of `SessionManager`: a debug session is not keyed by a document
 * (a module launch has none), may exist without one, and has no auto-start, trust or recent-file
 * rules. `SessionManager` stays about run-all documents.
 *
 * A second start on the same key restarts it in place; a second start while another VS Code debug
 * session holds it is refused. A different `args`, `cwd` or `module` is a different key and runs
 * side by side.
 */
import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import { DebugSession } from './debugSession';
import { launchKey, type LaunchConfig } from './debugSessionState';
import { updateDebugContext } from './debugContext';
import { wrapDebugSession, type DebugTarget } from './debugTarget';
import { setContext } from '../util/context';
import { log } from '../util/log';

export interface DebugSessionManagerEvents {
  sessionStarted: [DebugSession];
  sessionEnded: [DebugSession];
  /** any session's state changed (the status bar and the panel follow it) */
  changed: [];
}

export class DebugSessionManager extends EventEmitter<DebugSessionManagerEvents> implements vscode.Disposable {
  private readonly sessions = new Map<string, DebugSession>();
  private counter = 0;

  constructor(private readonly runtimeDir: string) {
    super();
    this.setMaxListeners(32);
  }

  dispose(): void {
    for (const ds of [...this.sessions.values()]) ds.dispose();
    this.sessions.clear();
    this.removeAllListeners();
  }

  all(): DebugSession[] {
    return [...this.sessions.values()];
  }

  get(key: string): DebugSession | undefined {
    return this.sessions.get(key);
  }

  byKey(launch: LaunchConfig): DebugSession | undefined {
    return this.sessions.get(launchKey(launch));
  }

  byId(id: string): DebugSession | undefined {
    return this.all().find((ds) => ds.id === id);
  }

  /** The debug session whose program is `fsPath`, by its launch or its main file. */
  byPath(fsPath: string): DebugSession | undefined {
    return this.all().find((ds) => ds.launch.program === fsPath || ds.mainFile === fsPath);
  }

  /**
   * Start a `record: false` debug session, or restart the one that already holds the launch key.
   * Resolves once the run is in flight; the pause follows as an event.
   */
  async start(launch: LaunchConfig, opts: { stopOnEntry?: boolean } = {}): Promise<DebugSession> {
    const key = launchKey(launch);
    const existing = this.sessions.get(key);
    if (existing) {
      await existing.restart(opts);
      this.report();
      return existing;
    }
    const workspaceRoot = folderFor(launch) ?? '';
    const ds = new DebugSession({ id: `debug-${++this.counter}`, launch, runtimeDir: this.runtimeDir, workspaceRoot });
    this.sessions.set(key, ds);
    ds.on('changed', () => this.report());
    ds.on('paused', () => this.report());
    ds.on('resumed', () => this.report());
    ds.once('ended', () => {
      if (this.sessions.get(key) === ds) this.sessions.delete(key);
      log.info(`debug session ${ds.id} (${ds.displayName}) ended`);
      this.report();
      this.emit('sessionEnded', ds);
    });
    // the context keys go out before the event, so a listener that shows the panel sees them set
    this.report();
    this.emit('sessionStarted', ds);
    try {
      await ds.start(opts);
    } catch (err) {
      ds.dispose();
      throw err;
    }
    this.report();
    return ds;
  }

  /** Stop and forget a session (the toolbar's Stop, `stop --live`, deactivation). */
  stop(ds: DebugSession): void {
    ds.stopDebug();
  }

  /**
   * The target the seven control commands act on: the debug session when one exists (the only one,
   * else the one whose program is the active editor's file, else the most recently started).
   */
  active(): DebugSession | undefined {
    const all = this.all();
    if (all.length <= 1) return all[0];
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    const onFile = file ? all.filter((ds) => ds.launch.program === file || ds.mainFile === file) : [];
    if (onFile.length === 1) return onFile[0];
    return [...all].sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  /** `wrapDebugSession(active())`, for the commands that dispatch through the facade. */
  activeTarget(): DebugTarget | undefined {
    const ds = this.active();
    return ds ? wrapDebugSession(ds) : undefined;
  }

  /** The Debugger's half of the context keys, plus `pyokka.debugSessionActive`. */
  private report(): void {
    const all = this.all();
    setContext('debugSessionActive', all.length > 0);
    updateDebugContext({ session: { active: all.length > 0, paused: all.some((ds) => !!ds.debug.paused) } });
    this.emit('changed');
  }
}

/** The workspace folder a launch belongs to: the program's, else the one holding `cwd`. */
function folderFor(launch: LaunchConfig): string | undefined {
  if (launch.program) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(launch.program));
    if (folder) return folder.uri.fsPath;
  }
  const byCwd = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(launch.cwd));
  if (byCwd) return byCwd.uri.fsPath;
  return (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath;
}
