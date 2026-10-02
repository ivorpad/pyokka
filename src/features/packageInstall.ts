/**
 * Quick package install for `ModuleNotFoundError`: hover, code action and the two commands.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { ensureDir } from '../util/paths';
import { log } from '../util/log';

const PIP_NAMES: Record<string, string> = { cv2: 'opencv-python', PIL: 'pillow', yaml: 'pyyaml', sklearn: 'scikit-learn', bs4: 'beautifulsoup4', dotenv: 'python-dotenv', dateutil: 'python-dateutil', Crypto: 'pycryptodome', git: 'GitPython', jwt: 'PyJWT', attr: 'attrs', serial: 'pyserial', usb: 'pyusb', wx: 'wxPython', gi: 'PyGObject', docx: 'python-docx', pptx: 'python-pptx', magic: 'python-magic', ldap: 'python-ldap', Levenshtein: 'python-Levenshtein', OpenSSL: 'pyopenssl', psycopg2: 'psycopg2-binary', MySQLdb: 'mysqlclient', skimage: 'scikit-image', google: 'google-api-python-client', telegram: 'python-telegram-bot' };

export function pipNameFor(moduleName: string): string {
  const top = moduleName.split('.')[0]!;
  return PIP_NAMES[top] ?? top;
}

function uvOnPath(): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    for (const ext of exts) if (dir && fs.existsSync(path.join(dir, `uv${ext}`))) return true;
  }
  return false;
}

export function buildInstallCommand(opts: { template: string; python: string; isVenv: boolean; packageName: string; target?: string }): string {
  const q = (s: string): string => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  if (opts.template.trim()) return opts.template.replace(/\{packageName\}/g, opts.packageName).replace(/\{python\}/g, q(opts.python)).replace(/\{target\}/g, opts.target ? q(opts.target) : '');
  const targetArg = opts.target ? ` --target ${q(opts.target)}` : '';
  if (uvOnPath() && (opts.isVenv || opts.target)) return `uv pip install --python ${q(opts.python)}${targetArg} ${opts.packageName}`;
  return `${q(opts.python)} -m pip install${targetArg} ${opts.packageName}`;
}

export class PackageInstall implements vscode.HoverProvider, vscode.CodeActionProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: SessionManager) {
    const selector: vscode.DocumentSelector = [{ language: 'python' }];
    this.disposables.push(
      vscode.languages.registerHoverProvider(selector, this),
      vscode.languages.registerCodeActionsProvider(selector, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private missingAt(document: vscode.TextDocument, line: number): { session: Session; module: string } | undefined {
    const s = this.manager.sessionForDocument(document);
    if (!s || !s.missingModules.size) return undefined;
    const fileId = s.fileIdForDocument(document);
    for (const err of s.state.errors) {
      const m = /No module named '([A-Za-z0-9_.]+)'/.exec(err.message);
      if (!m) continue;
      const loc = s.locate(err.rid);
      const errLine = loc && loc.fileId === fileId ? loc.range[0] - 1 : err.stack.find((f) => f.fileId === fileId)?.line ?? -1;
      if (errLine === line || (loc && loc.fileId === fileId && line >= loc.range[0] - 1 && line <= loc.range[2] - 1)) return { session: s, module: m[1]!.split('.')[0]! };
    }
    return undefined;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const hit = this.missingAt(document, position.line);
    if (!hit) return undefined;
    const pkg = pipNameFor(hit.module);
    const args = encodeURIComponent(JSON.stringify({ package: pkg }));
    const md = new vscode.MarkdownString(`**Pyokka:** module \`${hit.module}\` is not installed.\n\n[$(package) Install ${pkg} into project](command:pyokka.installMissingPackageToProject?${args}) &nbsp;|&nbsp; [$(file) Install only for this Pyokka file](command:pyokka.installMissingPackageForFile?${args})`, true);
    md.isTrusted = true;
    return new vscode.Hover(md);
  }

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const hit = this.missingAt(document, range.start.line);
    if (!hit) return [];
    const pkg = pipNameFor(hit.module);
    const mk = (title: string, command: string): vscode.CodeAction => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.command = { title, command, arguments: [{ package: pkg }] };
      a.isPreferred = command === 'pyokka.installMissingPackageToProject';
      return a;
    };
    return [mk(`Pyokka: install ${pkg} into project`, 'pyokka.installMissingPackageToProject'), mk(`Pyokka: install ${pkg} only for this Pyokka file`, 'pyokka.installMissingPackageForFile')];
  }

  private async pickPackage(session: Session, arg: unknown): Promise<string | undefined> {
    const fromArg = arg && typeof arg === 'object' ? (arg as { package?: string }).package : typeof arg === 'string' ? arg : undefined;
    if (fromArg) return fromArg;
    const missing = [...session.missingModules].map(pipNameFor);
    if (missing.length === 1) return missing[0];
    if (missing.length > 1) {
      const pick = await vscode.window.showQuickPick(missing, { title: 'Pyokka: which package?' });
      return pick;
    }
    return vscode.window.showInputBox({ prompt: 'Package to install (pip name)', ignoreFocusOut: true });
  }

  async installToProject(arg?: unknown): Promise<void> {
    const s = this.manager.active();
    if (!s) return;
    const pkg = await this.pickPackage(s, arg);
    if (!pkg) return;
    const cmd = buildInstallCommand({ template: s.config.installPackageCommand, python: s.interpreter.path, isVenv: s.interpreter.isVenv, packageName: pkg });
    await this.runInTerminal(s, cmd, () => s.scheduleRun('install', 0));
  }

  async installForFile(arg?: unknown): Promise<void> {
    const s = this.manager.active();
    if (!s) return;
    const pkg = await this.pickPackage(s, arg);
    if (!pkg) return;
    const target = ensureDir(this.manager.forFileDataDir(s.document));
    const cmd = buildInstallCommand({ template: '', python: s.interpreter.path, isVenv: s.interpreter.isVenv, packageName: pkg, target });
    if (!s.extraPythonPath.includes(target)) s.extraPythonPath.push(target);
    await this.runInTerminal(s, cmd, () => s.scheduleRun('install', 0));
  }

  private async runInTerminal(session: Session, command: string, onDone: () => void): Promise<void> {
    log.info(`install: ${command}`);
    const terminal = vscode.window.createTerminal({ name: 'Pyokka install', cwd: session.workspaceRoot || undefined });
    terminal.show(true);
    // shell integration arrives shortly after creation; wait for it briefly
    const integration = await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
      if (terminal.shellIntegration) return resolve(terminal.shellIntegration);
      const t = setTimeout(() => {
        d.dispose();
        resolve(undefined);
      }, 3000);
      const d = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
          clearTimeout(t);
          d.dispose();
          resolve(e.shellIntegration);
        }
      });
    });
    if (integration) {
      const execution = integration.executeCommand(command);
      const d = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution !== execution) return;
        d.dispose();
        if (e.exitCode === 0) {
          session.missingModules.clear();
          onDone();
        } else void vscode.window.showWarningMessage(`Pyokka: install command exited with code ${e.exitCode ?? '?'}.`);
      });
    } else {
      terminal.sendText(command, true);
      const pick = await vscode.window.showInformationMessage('Pyokka: installing in the terminal. Re-execute the file when it finishes.', 'Re-execute now');
      if (pick) {
        session.missingModules.clear();
        onDone();
      }
    }
  }
}
