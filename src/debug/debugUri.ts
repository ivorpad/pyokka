/**
 * `vscode://ivor.pyokka/debug?…` (docs/design/debugger-product.md, 3.9): how `pyokka debug FILE`
 * reaches a window that has no socket for the file yet. The CLI builds the URI, `code --open-url`
 * hands it to the focused window, and this handler starts the debug session the CLI then connects
 * to over the descriptor.
 *
 * The handler obeys `pyokka.agentAccess`. The setting is what makes the window answer an agent at
 * all, and a debug session serves code execution in the user's own process, so a URI that arrives
 * while the setting is off starts nothing: a stopped program nobody can continue is worse than a
 * refusal.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { setting } from '../config/settings';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import { entryPause, functionBreakpoint, mergeBreakpoints, type BreakpointSpec } from '../session/debugState';
import { AT_UNREADABLE, parseAt, parseDebugUri, type LaunchConfig } from './debugSessionState';
import { startDebugSession } from './dapAdapter';
import { AGENT_ACCESS_SETTING } from '../agent/bridge';
import { log } from '../util/log';

/** The path of the one URI Pyokka answers. */
export const DEBUG_URI_PATH = '/debug';

/** Handle one `vscode://ivor.pyokka/debug` URI; resolves once the debug session has been asked for. */
export async function handleDebugUri(uri: vscode.Uri): Promise<void> {
  log.info(`URI handler: ${uri.path}${uri.query ? `?${uri.query}` : ''}`);
  if (uri.path !== DEBUG_URI_PATH) {
    log.warn(`URI handler: ${uri.path} is not a Pyokka URI (only ${DEBUG_URI_PATH})`);
    return;
  }
  let launch: LaunchConfig;
  let ats: string[];
  try {
    const parsed = parseDebugUri(uri.query);
    launch = parsed.launch;
    ats = [...(parsed.at ? [parsed.at] : []), ...(parsed.also ?? [])];
    // `--record-from X` pauses at X too: the recording starts at that pause, so it must be one
    if (launch.recordFrom && !ats.includes(launch.recordFrom)) ats.push(launch.recordFrom);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`URI handler: ${message}`);
    void vscode.window.showErrorMessage(`Pyokka: an agent asked to debug, but the request could not be read: ${message}`);
    return;
  }
  const resource = vscode.Uri.file(launch.program ?? launch.cwd);
  if (!setting<boolean>(AGENT_ACCESS_SETTING, false, resource)) {
    const name = launch.module ? `-m ${launch.module}` : path.basename(launch.program ?? '');
    log.warn(`URI handler: a debug start of ${name} arrived with pyokka.agentAccess off; asking`);
    // not awaited: the handler returns at once, and a click (the CLI may still be polling, or a
    // later `state --live` finds it) starts the very launch that was asked for
    void vscode.window
      .showWarningMessage(
        `Pyokka: an agent asked to debug ${name}. Allow local agents (the pyokka CLI) to start and drive debug sessions and read runs in VS Code? This turns on "pyokka.agentAccess" for every workspace.`,
        'Allow',
        'Open Settings',
      )
      .then(async (pick) => {
        if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'pyokka.agentAccess');
        if (pick !== 'Allow') {
          log.warn(`URI handler: refused a debug start of ${name}; pyokka.agentAccess is off`);
          return;
        }
        await vscode.workspace.getConfiguration('pyokka').update(AGENT_ACCESS_SETTING, true, vscode.ConfigurationTarget.Global);
        log.info(`URI handler: agent access allowed from the prompt; starting ${name}`);
        await handleDebugUri(uri);
      });
    return;
  }
  const extra: BreakpointSpec[] = [];
  for (const at of ats) {
    const spec = parseAt(at);
    if (!spec) {
      log.warn(`URI handler: ${AT_UNREADABLE}, got ${JSON.stringify(at)}`);
      void vscode.window.showErrorMessage(`Pyokka: ${AT_UNREADABLE}, got ${JSON.stringify(at)}`);
      return;
    }
    // the human sees each `--at` breakpoint in the Breakpoints view, and all are set before the run starts
    if ('function' in spec) {
      extra.push(functionBreakpoint(spec.function));
      vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(spec.function, true)]);
    } else {
      const file = path.isAbsolute(spec.file) ? spec.file : path.resolve(launch.cwd, spec.file);
      extra.push({ path: file, line: spec.line });
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(spec.line - 1, 0)), true)]);
    }
  }
  // an agent that starts cold with nothing set is guaranteed a stop rather than a finished program
  const stopOnEntry = entryPause({ stopOnEntry: launch.stopOnEntry }, mergeBreakpoints(currentSourceBreakpoints(), currentFunctionBreakpoints(), extra), [], { anyFile: true });
  await startDebugSession(launch, { stopOnEntry });
}

/** The window's URI handler; every window with the extension active registers the same one. */
export function registerDebugUriHandler(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri: (uri) => handleDebugUri(uri).catch((err) => log.error('URI handler failed', err)),
  });
}
