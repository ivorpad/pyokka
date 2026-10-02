/** Thin wrapper around the VS Code webview API: postMessage + persisted UI state. */
import type { WebviewToHost } from '../src/shared/webviewProtocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
  interface Window {
    __pyokka?: { workerUri?: string; codiconsUri?: string };
  }
}

let api: VsCodeApi | null = null;
function vscode(): VsCodeApi {
  if (!api) {
    if (typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
    else {
      let mem: unknown = undefined;
      api = { postMessage: () => {}, getState: () => mem, setState: (s) => (mem = s) };
    }
  }
  return api;
}

export function post(message: WebviewToHost): void {
  vscode().postMessage(message);
}

let nextRequestId = 1;
export function requestId(): number {
  return nextRequestId++;
}

export interface UiPrefs {
  view: 'output' | 'settings' | 'diagram';
  entriesMode: 'list' | 'tree';
  showKindIcon: boolean;
  showFileName: boolean;
  showContext: boolean;
  lineNumbers: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  folding: boolean;
  splitPx: number;
  /** the WALKTHROUGH section of the Output view is expanded */
  walkthroughOpen: boolean;
  /** the TOUR section of the Output view is expanded (the host computes the tour only while it is) */
  tourOpen: boolean;
  /** the EXCEPTIONS section of the Output view is expanded */
  exceptionsOpen: boolean;
}

export const DEFAULT_PREFS: UiPrefs = {
  view: 'output',
  entriesMode: 'list',
  showKindIcon: false,
  showFileName: false,
  showContext: true,
  lineNumbers: false,
  minimap: false,
  stickyScroll: true,
  folding: true,
  splitPx: 0,
  walkthroughOpen: true,
  tourOpen: false,
  exceptionsOpen: true,
};

export function loadPrefs(): UiPrefs {
  const raw = vscode().getState();
  if (raw && typeof raw === 'object') return { ...DEFAULT_PREFS, ...(raw as Partial<UiPrefs>) };
  return { ...DEFAULT_PREFS };
}

export function savePrefs(prefs: UiPrefs): void {
  vscode().setState(prefs);
}

export function copyText(text: string): void {
  post({ type: 'copy', text });
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* host handles the copy */
  }
}
