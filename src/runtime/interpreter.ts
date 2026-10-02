import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { log } from '../util/log';
import { setting } from '../config/settings';

export interface Interpreter {
  path: string;
  version: [number, number, number];
  source: 'setting' | 'python-extension' | 'defaultInterpreterPath' | 'PATH' | 'user';
  /** true when the executable lives inside a virtual environment (pyvenv.cfg next to bin/) */
  isVenv: boolean;
}

export const MIN_PYTHON: [number, number] = [3, 12];

const versionCache = new Map<string, Promise<[number, number, number] | undefined>>();

export function probeVersion(exe: string): Promise<[number, number, number] | undefined> {
  let p = versionCache.get(exe);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(exe, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout));
        resolve(m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined);
      });
    });
    versionCache.set(exe, p);
  }
  return p;
}

export function invalidateVersionCache(exe?: string): void {
  if (exe) versionCache.delete(exe);
  else versionCache.clear();
}

export function isVenvExecutable(exe: string): boolean {
  const dir = path.dirname(exe);
  return fs.existsSync(path.join(dir, '..', 'pyvenv.cfg')) || fs.existsSync(path.join(dir, 'pyvenv.cfg')) || /[\\/](\.venv|venv|\.virtualenvs)[\\/]/.test(exe);
}

type PythonApi = {
  environments: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { id: string; path: string };
    resolveEnvironment(env: unknown): Promise<{ executable: { uri?: vscode.Uri }; version?: { major: number; minor: number; micro: number } | undefined } | undefined>;
    onDidChangeActiveEnvironmentPath: vscode.Event<{ resource?: vscode.WorkspaceFolder | undefined; path: string }>;
  };
};

let pythonApiPromise: Promise<PythonApi | undefined> | undefined;

async function pythonApi(): Promise<PythonApi | undefined> {
  if (!pythonApiPromise) {
    pythonApiPromise = (async () => {
      try {
        const ext = vscode.extensions.getExtension('ms-python.python');
        if (!ext) return undefined;
        const mod = await import('@vscode/python-extension');
        return (await mod.PythonExtension.api()) as unknown as PythonApi;
      } catch (err) {
        log.warn(`Python extension API unavailable: ${String(err)}`);
        return undefined;
      }
    })();
  }
  return pythonApiPromise;
}

async function fromPythonExtension(resource?: vscode.Uri): Promise<string | undefined> {
  const api = await pythonApi();
  if (!api) return undefined;
  try {
    const envPath = api.environments.getActiveEnvironmentPath(resource);
    const resolved = await api.environments.resolveEnvironment(envPath);
    const exe = resolved?.executable.uri?.fsPath;
    if (exe) return exe;
    if (envPath.path && fs.existsSync(envPath.path) && fs.statSync(envPath.path).isFile()) return envPath.path;
  } catch (err) {
    log.warn(`resolveEnvironment failed: ${String(err)}`);
  }
  return undefined;
}

export function onDidChangePythonEnvironment(listener: () => void): vscode.Disposable {
  let inner: vscode.Disposable | undefined;
  void pythonApi().then((api) => {
    if (api) inner = api.environments.onDidChangeActiveEnvironmentPath(() => listener());
  });
  return new vscode.Disposable(() => inner?.dispose());
}

function candidates(resource?: vscode.Uri): (() => Promise<{ exe: string; source: Interpreter['source'] } | undefined>)[] {
  return [
    async () => {
      const s = setting<string>('python.interpreter', '', resource).trim();
      return s ? { exe: resolveSettingPath(s, resource), source: 'setting' } : undefined;
    },
    async () => {
      const exe = await fromPythonExtension(resource);
      return exe ? { exe, source: 'python-extension' } : undefined;
    },
    async () => {
      const s = vscode.workspace.getConfiguration('python', resource).get<string>('defaultInterpreterPath', '').trim();
      return s && s !== 'python' ? { exe: s, source: 'defaultInterpreterPath' } : undefined;
    },
    async () => ({ exe: 'python3', source: 'PATH' as const }),
    async () => ({ exe: 'python', source: 'PATH' as const }),
  ];
}

export class InterpreterError extends Error {
  constructor(message: string, readonly actions: { title: string; command: string }[] = []) {
    super(message);
  }
}

/**
 * Resolution order: `pyokka.python.interpreter` -> Python extension active environment ->
 * `python.defaultInterpreterPath` -> `python3` / `python` on PATH. Requires >= 3.12.
 */
export async function resolveInterpreter(resource?: vscode.Uri): Promise<Interpreter> {
  const tried: string[] = [];
  let tooOld: { exe: string; version: [number, number, number] } | undefined;
  for (const candidate of candidates(resource)) {
    const c = await candidate();
    if (!c) continue;
    tried.push(`${c.exe} (${c.source})`);
    const version = await probeVersion(c.exe);
    if (!version) continue;
    if (version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1])) {
      return { path: c.exe, version, source: c.source, isVenv: isVenvExecutable(c.exe) };
    }
    tooOld ??= { exe: c.exe, version };
    // an explicit choice that is too old is an error, not something to silently skip
    if (c.source === 'setting' || c.source === 'python-extension') break;
  }
  const actions = [
    { title: 'Select Interpreter', command: 'pyokka.selectInterpreter' },
    { title: 'Show Logs', command: 'pyokka.showLogs' },
  ];
  if (tooOld) {
    throw new InterpreterError(`Pyokka needs Python ${MIN_PYTHON.join('.')} or newer; ${tooOld.exe} is ${tooOld.version.join('.')}. Pick another interpreter with "Pyokka: Select Python Interpreter".`, actions);
  }
  log.warn(`No usable Python found. Tried: ${tried.join(', ') || 'nothing'}`);
  throw new InterpreterError(`Pyokka could not find a Python ${MIN_PYTHON.join('.')}+ interpreter. Install one or set "pyokka.python.interpreter".`, actions);
}

/**
 * The interpreter a launch names outright (`"python"` in a launch configuration, `--python` on the
 * CLI). It skips the resolution order, because the caller already chose, and still requires 3.12+.
 */
export async function namedInterpreter(exe: string): Promise<Interpreter> {
  const version = await probeVersion(exe);
  const actions = [{ title: 'Show Logs', command: 'pyokka.showLogs' }];
  if (!version) throw new InterpreterError(`Pyokka cannot run ${exe}: it did not report a Python version.`, actions);
  if (version[0] < MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] < MIN_PYTHON[1])) {
    throw new InterpreterError(`Pyokka needs Python ${MIN_PYTHON.join('.')} or newer; ${exe} is ${version.join('.')}.`, actions);
  }
  return { path: exe, version, source: 'user', isVenv: isVenvExecutable(exe) };
}

export async function showInterpreterError(err: unknown): Promise<void> {
  const e = err instanceof InterpreterError ? err : new InterpreterError(String(err instanceof Error ? err.message : err));
  const picked = await vscode.window.showErrorMessage(e.message, ...e.actions.map((a) => a.title));
  const action = e.actions.find((a) => a.title === picked);
  if (action) void vscode.commands.executeCommand(action.command);
}

/** A relative `pyokka.python.interpreter` is taken from the workspace folder of `resource` (or the first one). */
export function resolveSettingPath(value: string, resource?: vscode.Uri): string {
  if (path.isAbsolute(value) || !value.includes('/') && !value.includes('\\')) return value; // absolute, or a bare command on PATH
  const folder = (resource && vscode.workspace.getWorkspaceFolder(resource)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, value) : value;
}

/** Where a file dialog should start: the active file's folder, else the workspace folder, else home. */
function browseStartUri(): vscode.Uri | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.scheme === 'file') return vscode.Uri.file(path.dirname(doc.uri.fsPath));
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) return folder.uri;
  return process.env['HOME'] ? vscode.Uri.file(process.env['HOME']) : undefined;
}

/** Quick pick of discovered interpreters (or a file dialog); writes `pyokka.python.interpreter` for the workspace. */
export async function selectInterpreterCommand(): Promise<string | undefined> {
  const found = new Map<string, string>();
  const add = (exe: string | undefined, label: string): void => {
    if (exe && !found.has(exe)) found.set(exe, label);
  };
  add(setting<string>('python.interpreter', '').trim() || undefined, 'current setting');
  add(await fromPythonExtension(), 'Python extension');
  add(vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath', '').trim() || undefined, 'python.defaultInterpreterPath');
  for (const name of ['python3', 'python3.14', 'python3.13', 'python3.12', 'python']) add(name, 'on PATH');
  const items: (vscode.QuickPickItem & { exe?: string; action?: string })[] = [];
  await Promise.all(
    [...found.entries()].map(async ([exe, label]) => {
      invalidateVersionCache(exe);
      const v = await probeVersion(exe);
      if (!v) return;
      const ok = v[0] > 3 || (v[0] === 3 && v[1] >= MIN_PYTHON[1]);
      items.push({ label: `${ok ? '$(check)' : '$(warning)'} ${exe}`, description: `Python ${v.join('.')}`, detail: ok ? label : `${label} (too old, needs ${MIN_PYTHON.join('.')}+)`, exe });
    }),
  );
  items.sort((a, b) => a.label.localeCompare(b.label));
  const BROWSE = 'browse';
  const TYPE = 'type';
  items.push({ label: '$(folder-opened) Browse for a python executable…', detail: 'Opens a file dialog in the current folder (e.g. .venv/bin/python)', action: BROWSE });
  items.push({ label: '$(edit) Type a path…', detail: 'Absolute, or relative to the workspace folder', action: TYPE });
  const pick = await vscode.window.showQuickPick(items, { title: 'Pyokka: Python interpreter', placeHolder: 'Interpreter used to run Pyokka files (Python 3.12+)' });
  if (!pick) return undefined;
  let exe = pick.exe;
  if (pick.action === BROWSE) {
    const chosen = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, defaultUri: browseStartUri(), openLabel: 'Use as interpreter', title: 'Pyokka: choose a Python 3.12+ executable' });
    exe = chosen?.[0]?.fsPath;
  } else if (pick.action === TYPE) {
    exe = await vscode.window.showInputBox({ prompt: 'Path to a Python 3.12+ executable (absolute, or relative to the workspace folder)', ignoreFocusOut: true });
  }
  if (!exe) return undefined;
  const version = await probeVersion(resolveSettingPath(exe));
  if (!version) {
    void vscode.window.showErrorMessage(`Pyokka: ${exe} does not run as a Python interpreter.`);
    return undefined;
  }
  if (version[0] < MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] < MIN_PYTHON[1])) {
    void vscode.window.showErrorMessage(`Pyokka needs Python ${MIN_PYTHON.join('.')} or newer; ${exe} is ${version.join('.')}.`);
    return undefined;
  }
  // per workspace when there is one (a project venv must not leak into other projects), stored
  // relative to the folder when it lives inside it so the setting can be committed
  const folder = vscode.workspace.workspaceFolders?.[0];
  let stored = exe;
  if (folder && path.isAbsolute(exe)) {
    const rel = path.relative(folder.uri.fsPath, exe);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) stored = rel;
  }
  await vscode.workspace.getConfiguration('pyokka').update('python.interpreter', stored, folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return resolveSettingPath(stored);
}
