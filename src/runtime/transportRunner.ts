import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { LaunchConfig } from '../debug/debugSessionState';
import type { Interpreter } from './interpreter';
import type { RunnerClientOptions } from './runnerClient';
import { TransportPaths } from './transportPaths';

/** Send exactly the runtime bundled with this extension, without a remote install or shared host paths. */
export function transportRunnerOptions(launch: LaunchConfig, runtimeDir: string, localCwd: string): RunnerClientOptions {
  if (!launch.transport) throw new Error('No transport configured.');
  const files: [string, string][] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(runtimeDir, relative), { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files.push([name, readFileSync(path.join(runtimeDir, name)).toString('base64')]);
    }
  };
  visit('pyokka_runtime');
  const bootstrap = readFileSync(path.join(runtimeDir, 'pyokka_runtime', 'transport_bootstrap.py'), 'utf8');
  return {
    command: launch.transport.command,
    args: [...launch.transport.args, launch.python ?? 'python3', '-u', '-c', bootstrap],
    cwd: localCwd,
    initialInput: gzipSync(JSON.stringify(files)).toString('base64') + '\n',
    paths: new TransportPaths(launch.pathMappings),
    // The bootstrap is source, not a useful log line. Never log the runtime payload.
    commandLabel: `${launch.transport.command} (container Python runner)`,
  };
}

/** Probe through the same wrapper; a container interpreter must never be executed on the host. */
export async function probeTransportInterpreter(launch: LaunchConfig, localCwd: string): Promise<Interpreter> {
  if (!launch.transport) throw new Error('No transport configured.');
  const python = launch.python ?? 'python3';
  const probe = 'import json,sys;print(json.dumps({"version":list(sys.version_info[:3]),"venv":sys.prefix!=sys.base_prefix}))';
  const output = await new Promise<string>((resolve, reject) => {
    execFile(launch.transport!.command, [...launch.transport!.args, python, '-c', probe], { cwd: localCwd, timeout: 20_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`Pyokka transport could not run its Python interpreter (${err.code ?? 'failed'}). Check the container, transport command and wrapper.`));
      else resolve(stdout);
    });
  });
  let info: { version?: unknown; venv?: boolean };
  try { info = JSON.parse(output); }
  catch { throw new Error('Pyokka transport returned no Python version. The wrapper must preserve stdout for the runner and write its own messages to stderr.'); }
  if (!Array.isArray(info.version) || info.version.length !== 3 || info.version.some((v) => !Number.isInteger(v))) throw new Error('Invalid Python version from Pyokka transport.');
  const version = info.version as [number, number, number];
  if (version[0] < 3 || version[0] === 3 && version[1] < 12) throw new Error('Pyokka transport needs Python 3.12 or newer.');
  return { path: python, version, isVenv: info.venv === true, source: 'transport' };
}
