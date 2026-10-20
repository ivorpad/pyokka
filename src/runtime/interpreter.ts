import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { log } from '../util/log';
import { setting } from '../config/settings';
import { installedInterpreters, interpreterKey, isApplePlaceholder, isVenvExecutable, whichSync, workspaceVenvs } from './pythonDiscovery';

export { isVenvExecutable } from './pythonDiscovery';

export interface Interpreter {
  path: string;
  version: [number, number, number];
  source: 'setting' | 'python-extension' | 'venv' | 'defaultInterpreterPath' | 'PATH' | 'user' | 'transport';
  /** true when the executable lives inside a virtual environment (pyvenv.cfg next to bin/) */
  isVenv: boolean;
}

export const MIN_PYTHON: [number, number] = [3, 12];

const versionCache = new Map<string, Promise<[number, number, number] | undefined>>();

export function probeVersion(exe: string): Promise<[number, number, number] | undefined> {
  let p = versionCache.get(exe);
  if (!p) {
    // Apple's placeholder answers by opening the "install developer tools" dialog: never run it
    if (isApplePlaceholder(exe)) {
      log.info(`${exe} is Apple's placeholder without the Command Line Tools; not running it`);
      return Promise.resolve(undefined);
    }
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


type PythonApi = {
  environments: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { id: string; path: string };
    resolveEnvironment(env: unknown): Promise<{ executable: { uri?: vscode.Uri }; version?: { major: number; minor: number; micro: number } | undefined } | undefined>;
    /** every environment the extension found, as its own interpreter picker lists them (empty until a discovery ran) */
    readonly known?: readonly { path: string; executable?: { uri?: vscode.Uri }; environment?: { type?: string; name?: string }; tools?: readonly string[] }[];
    refreshEnvironments?(options?: { forceRefresh?: boolean }): Promise<void>;
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

/** The workspace folder of `resource` first, then the others. */
function folderPaths(resource?: vscode.Uri): string[] {
  const own = resource ? vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath : undefined;
  const all = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return own ? [own, ...all.filter((f) => f !== own)] : all;
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
    // the project's own .venv (or venv), found without the Python extension
    async () => {
      const exe = workspaceVenvs(folderPaths(resource))[0];
      return exe ? { exe, source: 'venv' } : undefined;
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
  /** `reason`: the short form the interpreter picker shows as its title */
  constructor(message: string, readonly actions: { title: string; command: string }[] = [], readonly reason?: string) {
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
    throw new InterpreterError(`Pyokka needs Python ${MIN_PYTHON.join('.')} or newer; ${tooOld.exe} is ${tooOld.version.join('.')}. Pick another interpreter with "Pyokka: Select Python Interpreter".`, actions, `${tooOld.exe} is Python ${tooOld.version.join('.')}; pick a ${MIN_PYTHON.join('.')}+ interpreter`);
  }
  log.warn(`No usable Python found. Tried: ${tried.join(', ') || 'nothing'}`);
  throw new InterpreterError(`Pyokka could not find a Python ${MIN_PYTHON.join('.')}+ interpreter. Install one or set "pyokka.python.interpreter".`, actions, `no Python ${MIN_PYTHON.join('.')}+ found; pick an interpreter`);
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

/** The Python extension's known environments, after one discovery when it has found none yet (a few seconds at most). */
async function knownEnvironments(): Promise<{ exe: string; label: string }[]> {
  const api = await pythonApi();
  const envs = api?.environments;
  if (!envs) return [];
  try {
    if (!envs.known?.length && envs.refreshEnvironments) await Promise.race([envs.refreshEnvironments(), new Promise((r) => setTimeout(r, 4000))]);
    return (envs.known ?? []).flatMap((e) => {
      const exe = e.executable?.uri?.fsPath ?? e.path;
      const kind = [e.environment?.type, e.environment?.name].filter(Boolean).join(' ') || e.tools?.join(', ') || '';
      return exe ? [{ exe, label: kind ? `Python extension: ${kind}` : 'Python extension' }] : [];
    });
  } catch (err) {
    log.warn(`known environments unavailable: ${String(err)}`);
    return [];
  }
}

/**
 * Every interpreter worth offering, labelled by where it was found: the current choice, the Python
 * extension's selection and its known environments, the workspace venv, `python.defaultInterpreterPath`,
 * the names on PATH, and the usual install places. One entry per interpreter; Apple's placeholder is left out.
 */
export async function discoverInterpreters(resource?: vscode.Uri): Promise<{ exe: string; label: string }[]> {
  const out = new Map<string, { exe: string; label: string }>();
  const add = (exe: string | undefined, label: string): void => {
    if (!exe || isApplePlaceholder(exe)) return;
    const full = whichSync(exe);
    if (!full || !fs.existsSync(full)) return;
    const key = interpreterKey(full);
    if (!out.has(key)) out.set(key, { exe: full, label });
  };
  const current = setting<string>('python.interpreter', '', resource).trim();
  if (current) add(resolveSettingPath(current, resource), 'current setting');
  add(await fromPythonExtension(resource), 'selected in the Python extension');
  for (const e of await knownEnvironments()) add(e.exe, e.label);
  for (const exe of workspaceVenvs(folderPaths(resource))) add(exe, 'workspace venv');
  add(vscode.workspace.getConfiguration('python', resource).get<string>('defaultInterpreterPath', '').trim() || undefined, 'python.defaultInterpreterPath');
  for (const name of ['python3', 'python3.14', 'python3.13', 'python3.12', 'python']) add(name, `${name} on PATH`);
  for (const exe of installedInterpreters()) add(exe, installLabel(exe));
  return [...out.values()];
}

function installLabel(exe: string): string {
  if (exe.includes('/.pyenv/')) return 'pyenv';
  if (exe.includes('/uv/python/') || exe.includes('/.local/bin/')) return 'uv';
  if (exe.startsWith('/opt/homebrew/') || exe.includes('/Cellar/')) return 'Homebrew';
  if (exe.includes('/Python.framework/')) return 'python.org';
  if (/\/(mini|ana)conda3|miniforge3|mambaforge|\.conda\//.test(exe)) return 'conda';
  return 'installed';
}

/** Probe at most `limit` interpreters at a time. */
async function probeAll(exes: string[], limit = 12): Promise<([number, number, number] | undefined)[]> {
  const out: ([number, number, number] | undefined)[] = new Array(exes.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, exes.length) }, async () => {
      while (next < exes.length) {
        const i = next++;
        invalidateVersionCache(exes[i]);
        out[i] = await probeVersion(exes[i]!);
      }
    }),
  );
  return out;
}

const GET_PYTHON_URL = 'https://github.com/ivorpad/pyokka#requirements';

/**
 * Quick pick of the interpreters on this machine (or a file dialog), like VS Code's own; writes
 * `pyokka.python.interpreter` for the workspace. `reason` titles the picker when a start found none.
 */
export async function selectInterpreterCommand(reason?: string): Promise<string | undefined> {
  const found = await discoverInterpreters();
  const versions = await probeAll(found.map((f) => f.exe));
  const current = setting<string>('python.interpreter', '').trim();
  const currentKey = current ? interpreterKey(whichSync(resolveSettingPath(current)) ?? current) : undefined;
  const ok = (v: [number, number, number]) => v[0] > MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] >= MIN_PYTHON[1]);
  const rows = found.flatMap((f, i) => (versions[i] ? [{ ...f, version: versions[i]! }] : []));
  rows.sort((a, b) => Number(ok(b.version)) - Number(ok(a.version)) || b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  const items: (vscode.QuickPickItem & { exe?: string; action?: string })[] = rows.map((r) => ({
    label: `${ok(r.version) ? '$(check)' : '$(warning)'} Python ${r.version.join('.')}`,
    description: r.exe,
    detail: `${r.label}${interpreterKey(r.exe) === currentKey ? ' · current' : ''}${ok(r.version) ? '' : ` · too old, Pyokka needs ${MIN_PYTHON.join('.')}+`}`,
    exe: r.exe,
  }));
  const BROWSE = 'browse';
  const TYPE = 'type';
  items.push({ label: '$(folder-opened) Browse for a python executable…', detail: 'Opens a file dialog in the current folder (e.g. .venv/bin/python)', action: BROWSE });
  items.push({ label: '$(edit) Type a path…', detail: 'Absolute, or relative to the workspace folder', action: TYPE });
  const GET = 'get';
  if (!rows.some((r) => ok(r.version))) items.push({ label: `$(link-external) Get Python ${MIN_PYTHON.join('.')}+…`, detail: 'python.org, Homebrew, uv or pyenv: how to install one, in the README', action: GET });
  const pick = await vscode.window.showQuickPick(items, { title: reason ? `Pyokka: ${reason}` : 'Pyokka: Python interpreter', placeHolder: `Interpreter used to run Pyokka files (Python ${MIN_PYTHON.join('.')}+), as VS Code's debugger uses the one you select`, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: !!reason });
  if (!pick) return undefined;
  if (pick.action === GET) {
    void vscode.env.openExternal(vscode.Uri.parse(GET_PYTHON_URL));
    return undefined;
  }
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
