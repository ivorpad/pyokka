/**
 * Helpers of the output panel that need no view: the text and title of an entry (shared with
 * Copy Value and Value Peek), the colour theme, the settings shown when no session is bound, the
 * HTML shell, and the Time Machine toolbar's actions.
 */
import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { LogEvent } from '../shared/protocol';
import type { PanelSettings, WebviewToHost } from '../shared/webviewProtocol';
import type { Session } from '../session/session';
import type { TimeMachine } from '../timeMachine/navigator';
import { setting } from '../config/settings';
import { renderValueNode } from './valueText';

export function entryText(e: LogEvent): string {
  return e.valueBag ? renderValueNode(e.valueBag.data) : e.text;
}

export function entryTitle(s: Session, e: LogEvent): string {
  const loc = s.locate(e.rid);
  return `${s.displayPath(e.fileId)}:${loc?.range[0] ?? '?'}${e.context ? ` ${e.context}` : ''}`;
}

export function currentTheme(): 'dark' | 'light' | 'hc' {
  const k = vscode.window.activeColorTheme.kind;
  if (k === vscode.ColorThemeKind.HighContrast || k === vscode.ColorThemeKind.HighContrastLight) return 'hc';
  return k === vscode.ColorThemeKind.Light ? 'light' : 'dark';
}

/** The Execution Diagram's settings the panel draws by (`pyokka.diagram.detail`, `pyokka.diagram.dataEdges`); user settings, no session value. */
export function diagramSettings(): Pick<PanelSettings, 'diagramDetail' | 'diagramDataEdges'> {
  return { diagramDetail: setting<string>('diagram.detail', 'scopes') === 'statements' ? 'statements' : 'scopes', diagramDataEdges: setting<boolean>('diagram.dataEdges', false) };
}

/** The panel's settings while no session is bound: the user settings' defaults. */
export function defaultSettings(): PanelSettings {
  const http = setting<string>('http', 'off');
  return {
    ...diagramSettings(),
    libraryCode: setting('timeMachine.libraryCode', false),
    maskSecrets: setting('secrets.mask', true),
    runTimeoutMs: setting('runTimeout', 30000),
    recordLocals: setting('timeMachine.recordLocals', false),
    autoLog: setting('autoLog', false),
    valuePeek: setting('valuePeek', true),
    showValueOnSelection: setting('showValueOnSelection', false),
    showSingleInlineValue: setting('showSingleInlineValue', true),
    runMode: setting<'auto' | 'onSave' | 'onDemand'>('runMode', 'auto'),
    http: http === 'record' || http === 'replay' ? http : 'off',
  };
}

/** The webview's HTML shell: the bundled panel, its worker and the codicons under a nonce CSP. */
export function panelHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const dist = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const panelJs = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'panel.js'));
  const panelCss = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'panel.css'));
  const workerJs = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'editor.worker.js'));
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'codicons', 'codicon.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');
  const boot = JSON.stringify({ workerUri: workerJs.toString(), codiconsUri: codicons.toString(), fontSize: setting<number>('fontSize', 13) });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${panelCss}">
<link rel="stylesheet" href="${codicons}">
<title>Pyokka</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.__pyokka = ${boot};</script>
<script type="module" nonce="${nonce}" src="${panelJs}"></script>
</body>
</html>`;
}

export type DebuggerAction = Extract<WebviewToHost, { type: 'debugger.action' }>['action'];

/** One Time Machine toolbar action of the panel on the bound session. */
export async function debuggerAction(tm: TimeMachine, s: Session, action: DebuggerAction): Promise<void> {
  switch (action) {
    case 'start': {
      const editor = vscode.window.activeTextEditor;
      const line = editor && editor.document === s.document ? editor.selection.active.line + 1 : undefined;
      await tm.start(s, { line });
      return;
    }
    case 'stop':
      tm.stop(s);
      return;
    case 'stepInto':
      tm.move(s, 'into');
      return;
    case 'stepBackInto':
      tm.move(s, 'back');
      return;
    case 'stepOver':
      tm.move(s, 'over');
      return;
    case 'stepBackOver':
      tm.move(s, 'backOver');
      return;
    case 'stepOut':
      tm.move(s, 'out');
      return;
    case 'stepBackOut':
      tm.move(s, 'backOut');
      return;
    case 'runToLine':
      tm.runToLine(s, false);
      return;
    case 'runBackToLine':
      tm.runToLine(s, true);
      return;
    case 'autoPlay':
      if (!s.nav.active) await tm.start(s, { autoPlay: true });
      else tm.autoPlay(s);
      return;
    case 'pause':
      tm.pause(s);
      return;
    case 'toggleCallStack':
      tm.setCallStackVisible(s, !s.nav.showCallStack);
      return;
    case 'toggleEcho':
      tm.toggleEcho(s);
      return;
    case 'toggleCodePreview':
      tm.toggleCodePreview(s);
      return;
    default:
      return;
  }
}

/** The panel's `openLocation`: a run's file by id, or (the Debugger view, the tour) a path relative to the workspace. */
export async function openLocation(s: Session | undefined, msg: Extract<WebviewToHost, { type: 'openLocation' }>): Promise<void> {
  const uri = msg.file ? vscode.Uri.file(path.isAbsolute(msg.file) ? msg.file : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', msg.file)) : s?.uriForFileId(msg.fileId);
  if (!uri) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  const pos = new vscode.Position(Math.max(0, msg.line - 1), Math.max(0, msg.col));
  const existing = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
  await vscode.window.showTextDocument(doc, { viewColumn: msg.sideView ? vscode.ViewColumn.Beside : (existing?.viewColumn ?? vscode.ViewColumn.One), selection: new vscode.Range(pos, pos), preserveFocus: false, preview: !msg.sideView });
}

/** The panel's `settings.update`: user settings for `global`, then the bound session's own values. */
export async function applySettingsPatch(s: Session | undefined, msg: Extract<WebviewToHost, { type: 'settings.update' }>): Promise<void> {
  const p = msg.patch;
  if (msg.scope === 'global') {
    const cfg = vscode.workspace.getConfiguration('pyokka');
    const settingKey: Record<string, string> = { libraryCode: 'timeMachine.libraryCode', maskSecrets: 'secrets.mask', runTimeoutMs: 'runTimeout', recordLocals: 'timeMachine.recordLocals', http: 'http' };
    for (const [k, v] of Object.entries(p)) {
      // never write the run mode globally from the panel: a global "auto" makes every project
      // file re-run on hover, which is a paid run for a file that calls an API
      if (k === 'runMode') continue;
      await cfg.update(settingKey[k] ?? k, v, vscode.ConfigurationTarget.Global);
    }
  }
  if (!s) return;
  if (p.autoLog !== undefined) s.setAutoLog(p.autoLog);
  if (p.showValueOnSelection !== undefined) s.setShowValueOnSelection(p.showValueOnSelection);
  if (p.showSingleInlineValue !== undefined) s.setShowSingleInlineValue(p.showSingleInlineValue);
  if (p.valuePeek !== undefined) s.setValuePeek(p.valuePeek);
  if (p.runMode !== undefined) s.setRunMode(p.runMode);
  if (p.libraryCode !== undefined) s.setLibraryCode(p.libraryCode);
  if (p.maskSecrets !== undefined) s.setMaskSecrets(p.maskSecrets);
  if (p.runTimeoutMs !== undefined) s.setRunTimeout(p.runTimeoutMs);
  if (p.recordLocals !== undefined) s.setRecordLocals(p.recordLocals);
  if (p.http !== undefined) s.setHttp(p.http);
}
