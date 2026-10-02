/**
 * Owns all sessions: start/stop/toggle, document wiring, auto-start rules, trust policy.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Session } from './session';
import type { RunMode } from './types';
import type { RecordFromSpec, RunMode as ProtocolRunMode } from '../shared/protocol';
import { namedInterpreter, resolveInterpreter, showInterpreterError, type Interpreter } from '../runtime/interpreter';
import { RecentFilesStore } from './recentFilesStore';
import { setting } from '../config/settings';
import { setContext } from '../util/context';
import { log } from '../util/log';
import { existsSync, pyokkaHome, shortHash } from '../util/paths';

export interface StartOptions {
  runMode?: RunMode;
  autoLog?: boolean;
  mode?: ProtocolRunMode;
  projectRoot?: string;
  /** skip the "already running" toggle semantics and restart */
  restart?: boolean;
  /** debug mode from the first run: it is the debug run instead of a normal run of the file */
  debug?: boolean;
  /** with `debug`: pause before the first statement (default true); false runs to the first breakpoint */
  stopOnEntry?: boolean;
  /** with `debug`: record only from this pause on (`--record-from`) */
  recordFrom?: RecordFromSpec;
  /**
   * The interpreter a recording debug session's `python` attribute asks for
   * (docs/design/debugger-product.md, 3.7). A session already running on the document in another
   * interpreter is not switched under the user: the start is refused instead.
   */
  interpreter?: string;
}

/** What a recording debug start says when the document's session runs in another interpreter. */
export function interpreterRefusal(displayName: string): string {
  return `stop the Pyokka session on ${displayName} first: a recording debug session runs in its interpreter`;
}

export interface SessionManagerEvents {
  sessionsChanged: [];
  sessionStarted: [Session];
  sessionStopped: [Session];
  activeChanged: [Session | undefined];
}

const WAS_RUNNING_KEY = 'pyokka.wasRunning';

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  readonly sessions = new Map<string, Session>();
  readonly recentFiles = new RecentFilesStore();
  private lastActive: Session | undefined;
  private preferredFolder: string | undefined;
  private readonly editStarted = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private startedAtLeastOnce = false;
  private trustPromptAnswer: boolean | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly runtimeDir: string,
  ) {
    super();
    // every feature (panel, decorator, bridge, narrator, graph provider, ...) listens to sessionStarted; Node warns past 10
    this.setMaxListeners(32);
    this.preferredFolder = context.workspaceState.get<string>('pyokka.preferredFolder');
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onDocumentClosed(doc)),
      vscode.workspace.onDidOpenTextDocument((doc) => void this.maybeAutoStart(doc, 'open')),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateActive()),
    );
    for (const doc of vscode.workspace.textDocuments) void this.maybeAutoStart(doc, 'open');
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const s of [...this.sessions.values()]) this.stopSession(s, false);
  }

  /* ---------- queries ---------- */

  all(): Session[] {
    return [...this.sessions.values()];
  }

  get(doc: vscode.TextDocument): Session | undefined {
    return this.sessions.get(doc.uri.toString());
  }

  getByKey(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  getByPath(fsPath: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.document.uri.scheme === 'file' && s.document.uri.fsPath === fsPath) return s;
    return undefined;
  }

  /** Session that owns the document, or one that imported it (project file). */
  sessionForDocument(doc: vscode.TextDocument): Session | undefined {
    const own = this.get(doc);
    if (own) return own;
    const key = doc.uri.query ? new URLSearchParams(doc.uri.query).get('session') : null;
    if (key) return this.sessions.get(key);
    if (doc.uri.scheme === 'file') {
      const candidates = this.all().filter((s) => s.files.byPath(doc.uri.fsPath));
      if (candidates.length) return candidates.includes(this.lastActive!) ? this.lastActive : candidates[0];
    }
    return undefined;
  }

  /** The session the commands act on: active editor's, else the most recently used one. */
  active(): Session | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const s = this.sessionForDocument(editor.document);
      if (s) return s;
    }
    if (this.lastActive && !this.lastActive.isDisposed) return this.lastActive;
    return this.all()[0];
  }

  updateActive(): void {
    const s = this.active();
    if (s) this.lastActive = s;
    const editor = vscode.window.activeTextEditor;
    setContext('isActiveEditorRunningPyokka', !!editor && !!this.sessionForDocument(editor.document));
    this.emit('activeChanged', s);
  }

  /* ---------- lifecycle ---------- */

  workspaceRootFor(doc: vscode.TextDocument, override?: string): string {
    if (override) return override;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (folder) return folder.uri.fsPath;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (this.preferredFolder && folders.some((f) => f.uri.fsPath === this.preferredFolder)) return this.preferredFolder;
    if (folders.length === 1) return folders[0]!.uri.fsPath;
    if (doc.uri.scheme === 'file') return path.dirname(doc.uri.fsPath);
    return folders[0]?.uri.fsPath ?? '';
  }

  async selectWorkspaceFolder(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage('Pyokka: no workspace folder is open.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: f.uri.fsPath === this.preferredFolder })),
      { title: 'Pyokka: workspace folder for new sessions' },
    );
    if (!pick) return undefined;
    this.preferredFolder = pick.description;
    await this.context.workspaceState.update('pyokka.preferredFolder', this.preferredFolder);
    return this.preferredFolder;
  }

  private async trustAllowed(): Promise<boolean> {
    if (vscode.workspace.isTrusted) return true;
    const behavior = setting<string>('untrustedWorkspaceBehavior', 'Prompt to allow');
    log.info(`workspace is not trusted; untrustedWorkspaceBehavior = ${behavior}`);
    if (behavior === 'Always allow') return true;
    if (behavior === 'Never allow') {
      void vscode.window.showWarningMessage('Pyokka is disabled in untrusted workspaces (pyokka.untrustedWorkspaceBehavior).');
      return false;
    }
    if (this.trustPromptAnswer !== undefined) return this.trustPromptAnswer;
    const pick = await vscode.window.showWarningMessage('This workspace is not trusted. Pyokka executes the file with your Python interpreter. Run anyway?', { modal: true }, 'Run', 'Always run in untrusted workspaces');
    if (pick === 'Always run in untrusted workspaces') {
      await vscode.workspace.getConfiguration('pyokka').update('untrustedWorkspaceBehavior', 'Always allow', vscode.ConfigurationTarget.Global);
      return true;
    }
    this.trustPromptAnswer = pick === 'Run';
    return this.trustPromptAnswer;
  }

  async start(doc: vscode.TextDocument, opts: StartOptions = {}): Promise<Session | undefined> {
    if (doc.languageId !== 'python' && !doc.fileName.endsWith('.py')) {
      void vscode.window.showInformationMessage('Pyokka runs Python files. Open a .py file or create one with "Pyokka: New Python File".');
      return undefined;
    }
    const existing = this.get(doc);
    if (existing && opts.interpreter && existing.interpreter.path !== opts.interpreter) throw new Error(interpreterRefusal(existing.displayName));
    if (existing && !opts.restart) {
      if (opts.runMode) existing.setRunMode(opts.runMode);
      if (opts.autoLog !== undefined) existing.setAutoLog(opts.autoLog);
      existing.scheduleRun('restart', 0);
      this.lastActive = existing;
      this.updateActive();
      return existing;
    }
    if (existing) this.stopSession(existing, false);
    if (!(await this.trustAllowed())) return undefined;
    let interpreter: Interpreter;
    try {
      interpreter = opts.interpreter ? await namedInterpreter(opts.interpreter) : await resolveInterpreter(doc.uri);
    } catch (err) {
      void showInterpreterError(err);
      return undefined;
    }
    const workspaceRoot = this.workspaceRootFor(doc, opts.projectRoot);
    const extraPythonPath = this.forFileSitePackages(doc);
    const session = new Session({ document: doc, interpreter, runtimeDir: this.runtimeDir, workspaceRoot, runMode: opts.runMode, autoLog: opts.autoLog, mode: opts.mode, extraPythonPath });
    if (opts.debug) session.debugCtl.activate({ stopOnEntry: opts.stopOnEntry, ...(opts.recordFrom ? { recordFrom: opts.recordFrom } : {}) });
    this.sessions.set(session.key, session);
    this.lastActive = session;
    this.startedAtLeastOnce = true;
    setContext('hasActiveSession', true);
    setContext('startedAtLeastOnce', true);
    this.rememberRunning(doc, true);
    this.recentFiles.touch({
      name: session.displayName,
      path: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
      content: doc.uri.scheme === 'file' ? undefined : doc.getText(),
      projectRoot: workspaceRoot || undefined,
      id: doc.uri.scheme === 'file' ? undefined : `untitled-${shortHash(doc.getText())}`,
    });
    this.emit('sessionsChanged');
    this.emit('sessionStarted', session);
    this.updateActive();
    session.start().catch((err) => {
      log.error(`session start failed for ${session.displayName}`, err);
      session.status = 'failed';
      session.lastError = err instanceof Error ? err.message : String(err);
      session.emit('statusChanged');
      void vscode.window.showErrorMessage(`Pyokka could not start: ${session.lastError}`, 'Show Logs').then((p) => p && log.show());
    });
    return session;
  }

  /** `~/.pyokka/data/<id>/site-packages` for "install only for this Pyokka file". */
  forFileSitePackages(doc: vscode.TextDocument): string[] {
    const dir = this.forFileDataDir(doc);
    return existsSync(dir) ? [dir] : [];
  }

  forFileDataDir(doc: vscode.TextDocument): string {
    const id = shortHash(doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.uri.toString());
    return path.join(pyokkaHome(), 'data', id, 'site-packages');
  }

  async toggle(doc: vscode.TextDocument): Promise<void> {
    const s = this.get(doc);
    if (s) this.stopSession(s, true);
    else await this.start(doc);
  }

  stop(doc: vscode.TextDocument): boolean {
    const s = this.get(doc);
    if (!s) return false;
    this.stopSession(s, true);
    return true;
  }

  stopAll(): void {
    for (const s of this.all()) this.stopSession(s, true);
  }

  stopSession(session: Session, userInitiated: boolean): void {
    this.sessions.delete(session.key);
    if (userInitiated) this.rememberRunning(session.document, false);
    session.dispose();
    if (this.lastActive === session) this.lastActive = undefined;
    setContext('hasActiveSession', this.sessions.size > 0);
    this.emit('sessionsChanged');
    this.emit('sessionStopped', session);
    this.updateActive();
  }

  get hasStartedAtLeastOnce(): boolean {
    return this.startedAtLeastOnce;
  }

  /* ---------- document wiring ---------- */

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const own = this.get(e.document);
    if (own) own.onDocumentChanged(e);
    else if (e.document.languageId === 'python' && e.contentChanges.length) void this.maybeAutoStart(e.document, 'edit');
    if (e.document.uri.scheme !== 'file' || e.document.languageId !== 'python' || !e.contentChanges.length) return;
    // project-file dependency watch: a session that imported this file re-runs
    for (const s of this.sessions.values()) {
      if (s === own) continue;
      if (s.files.byPath(e.document.uri.fsPath) && s.runMode === 'auto') s.scheduleRun('dependency');
    }
  }

  private onDocumentSaved(doc: vscode.TextDocument): void {
    const own = this.get(doc);
    if (own) own.onDocumentSaved();
    if (doc.uri.scheme !== 'file') return;
    for (const s of this.sessions.values()) {
      if (s === own) continue;
      if (s.files.byPath(doc.uri.fsPath) && s.runMode === 'onSave') s.scheduleRun('dependency', 0);
    }
  }

  private onDocumentClosed(doc: vscode.TextDocument): void {
    const s = this.get(doc);
    if (!s) return;
    // keep the "was running" memory so automaticRestart can bring it back
    this.stopSession(s, false);
  }

  private rememberRunning(doc: vscode.TextDocument, running: boolean): void {
    if (doc.uri.scheme !== 'file') return;
    const set = new Set(this.context.workspaceState.get<string[]>(WAS_RUNNING_KEY, []));
    if (running) set.add(doc.uri.fsPath);
    else set.delete(doc.uri.fsPath);
    void this.context.workspaceState.update(WAS_RUNNING_KEY, [...set]);
  }

  /** `open`/`edit`/undefined per automaticRestart, automaticStartRegex and smartStart rules. */
  autoStartModeFor(doc: vscode.TextDocument): 'open' | 'edit' | undefined {
    if (doc.languageId !== 'python' || doc.uri.scheme !== 'file') return undefined;
    const rules = setting<{ pattern?: string; startMode?: string }[]>('smartStart', [], doc.uri);
    for (const rule of rules) {
      if (!rule || typeof rule.pattern !== 'string') continue;
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const pattern = folder && !path.isAbsolute(rule.pattern) ? new vscode.RelativePattern(folder, rule.pattern) : rule.pattern;
      if (vscode.languages.match({ pattern }, doc) > 0) {
        switch (rule.startMode) {
          case 'never':
            return undefined;
          case 'edit':
            return 'edit';
          case 'open':
          case 'always':
            return 'open';
          default:
            return undefined;
        }
      }
    }
    const regex = setting<string>('automaticStartRegex', '', doc.uri);
    if (regex) {
      try {
        if (new RegExp(regex).test(doc.uri.fsPath)) return 'open';
      } catch {
        log.warn(`invalid pyokka.automaticStartRegex: ${regex}`);
      }
    }
    if (setting<boolean>('automaticRestart', false, doc.uri) && this.context.workspaceState.get<string[]>(WAS_RUNNING_KEY, []).includes(doc.uri.fsPath)) return 'open';
    return undefined;
  }

  private async maybeAutoStart(doc: vscode.TextDocument, trigger: 'open' | 'edit'): Promise<void> {
    if (this.get(doc)) return;
    const mode = this.autoStartModeFor(doc);
    if (!mode) return;
    if (mode === 'open' && trigger === 'open') await this.start(doc);
    else if (mode === 'edit' && trigger === 'edit' && !this.editStarted.has(doc.uri.toString())) {
      this.editStarted.add(doc.uri.toString());
      await this.start(doc);
    }
  }
}
