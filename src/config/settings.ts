import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunConfig } from '../shared/protocol';
import { pyokkaHome, readJsonFile } from '../util/paths';
import { mergeConfigSources, readPyokkaTableFromToml, toRunConfig, parseEnvParams, splitArgs, type ConfigObject } from './merge';
import { readEnvFile } from './dotenv';
import { looksLikeProject } from './project';

export type RunModeSetting = 'auto' | 'onSave' | 'onDemand';

export function pyokkaConfig(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('pyokka', resource);
}

export function setting<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  return pyokkaConfig(resource).get<T>(key, fallback);
}

/** The runner-facing subset of the VS Code settings (before config files are merged in). */
function settingsAsConfig(resource?: vscode.Uri): ConfigObject {
  const c = pyokkaConfig(resource);
  const pick = (keys: string[]): ConfigObject => {
    const out: ConfigObject = {};
    for (const k of keys) {
      const insp = c.inspect(k);
      // only carry explicit user values so that config files can override the defaults
      const v = insp?.workspaceFolderValue ?? insp?.workspaceValue ?? insp?.globalValue;
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  // `httpObserve` is a flat key on purpose: VS Code stores settings as a tree, so `pyokka.http.observe` could not coexist with the string `pyokka.http`
  const flat = pick(['logLimit', 'maxConsoleMessages', 'resolveGetters', 'autoLog', 'maxTraceSteps', 'maxValueChars', 'runTimeout', 'http', 'httpObserve', 'installPackageCommand', 'plugins', 'runMode', 'delay', 'showValueOnSelection', 'showSingleInlineValue', 'smartStart']);
  const tm: ConfigObject = {};
  for (const k of ['recordLocals', 'libraryCode', 'libraryPackages', 'exclude']) {
    const insp = c.inspect(`timeMachine.${k}`);
    const v = insp?.workspaceFolderValue ?? insp?.workspaceValue ?? insp?.globalValue;
    if (v !== undefined) tm[k] = v;
  }
  if (Object.keys(tm).length) flat['timeMachine'] = tm;
  const sec: ConfigObject = {};
  for (const k of ['mask', 'names']) {
    const insp = c.inspect(`secrets.${k}`);
    const v = insp?.workspaceFolderValue ?? insp?.workspaceValue ?? insp?.globalValue;
    if (v !== undefined) sec[k] = v;
  }
  if (Object.keys(sec).length) flat['secrets'] = sec;
  const env = c.get<Record<string, string>>('env', {});
  if (Object.keys(env).length) flat['env'] = env;
  const args = c.get<string[]>('args', []);
  if (args.length) flat['args'] = args;
  return flat;
}

export interface ResolvedSessionConfig {
  run: RunConfig;
  runMode: RunModeSetting;
  delay: number;
  showValueOnSelection: boolean;
  showSingleInlineValue: boolean;
  installPackageCommand: string;
  env: Record<string, string>;
  argv: string[];
  smartStart: unknown;
  /** raw merged object for diagnostics */
  merged: ConfigObject;
}

/**
 * Settings -> ~/.pyokka/config.json -> pyproject.toml [tool.pyokka] -> .pyokka, later wins.
 * `workspaceRoot` is searched for pyproject.toml / .pyokka (also the file's own directory).
 */
export function resolveSessionConfig(resource: vscode.Uri | undefined, workspaceRoot: string | undefined, fileDir?: string): ResolvedSessionConfig {
  const home = readJsonFile<ConfigObject>(path.join(pyokkaHome(), 'config.json'), {});
  const dirs = [workspaceRoot, fileDir].filter((d): d is string => !!d);
  let pyproject: ConfigObject | undefined;
  let dotfile: ConfigObject | undefined;
  for (const dir of dirs) {
    const pp = path.join(dir, 'pyproject.toml');
    if (!pyproject && fs.existsSync(pp)) {
      try {
        pyproject = readPyokkaTableFromToml(fs.readFileSync(pp, 'utf8'));
      } catch {
        pyproject = undefined;
      }
    }
    const df = path.join(dir, '.pyokka');
    if (!dotfile && fs.existsSync(df)) dotfile = readJsonFile<ConfigObject>(df, {});
  }
  const merged = mergeConfigSources(settingsAsConfig(resource), home, pyproject, dotfile);
  const run = toRunConfig(merged);
  const envObj = (merged['env'] ?? {}) as ConfigObject;
  const params = (envObj['params'] ?? {}) as ConfigObject;
  // `python.envFile` (the Python extension's setting, default `${workspaceFolder}/.env`) is loaded
  // first so that explicit `env` entries win over it
  const envFileSetting = vscode.workspace.getConfiguration('python', resource).get<string>('envFile', '${workspaceFolder}/.env');
  const env: Record<string, string> = readEnvFile(envFileSetting, workspaceRoot || fileDir);
  for (const [k, v] of Object.entries(envObj)) if (k !== 'params' && (typeof v === 'string' || typeof v === 'number')) env[k] = String(v);
  Object.assign(env, parseEnvParams(typeof params['env'] === 'string' ? params['env'] : undefined));
  const argv = Array.isArray(merged['args']) ? (merged['args'] as unknown[]).map(String) : splitArgs(typeof params['args'] === 'string' ? params['args'] : undefined);
  const runMode = merged['runMode'];
  // 'smart': scratch files run automatically, project files run on save; the default is 'onSave'
  const smart = fileDir && looksLikeProject([fileDir, workspaceRoot]) ? 'onSave' : 'auto';
  return {
    run,
    runMode: runMode === 'onSave' || runMode === 'onDemand' || runMode === 'auto' ? runMode : runMode === 'smart' ? smart : 'onSave',
    delay: typeof merged['delay'] === 'number' ? (merged['delay'] as number) : 0,
    showValueOnSelection: !!merged['showValueOnSelection'],
    showSingleInlineValue: merged['showSingleInlineValue'] === undefined ? setting('showSingleInlineValue', true, resource) : !!merged['showSingleInlineValue'],
    installPackageCommand: typeof merged['installPackageCommand'] === 'string' ? (merged['installPackageCommand'] as string) : '',
    env,
    argv,
    smartStart: merged['smartStart'],
    merged,
  };
}
