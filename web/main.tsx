/**
 * Pyokka, the panel in a browser: the code pane (Monaco) beside the unchanged panel (webview/App.tsx), both
 * fed by the bridge (web/server.ts) over a WebSocket. `?layout=panel` shows the panel alone, for a
 * VS Code Simple Browser tab next to the real editor; `?layout=code` the code pane alone.
 * The page sets `window.__pyokka` (worker and codicons) before this script; see web/index.html.
 */
import { render } from 'preact';
import { App } from '../webview/App';
import { bootMonaco } from '../webview/monaco';
import '../webview/styles.css';
import '../webview/http.css';
import '../webview/exec-story.css';
import '../webview/debug.css';
import './theme.css';
import './web.css';
import type { HostToWebview, WebviewToHost } from '../src/shared/webviewProtocol';
import type { BridgeToPage } from './bridgeProtocol';
import { BridgeLink } from './link';
import { PageHost, runtimeLabelText } from './pageHost';
import { CodePane } from './codePane';
import { registerWebMcp, runAgentCommand } from './agent';
import { DebugPane } from './debugPane';
import { staleBuild } from './pageBuild';
import { openDefinitionTab } from './definitions';
import { Scratchpad } from './scratchpad';

const params = new URLSearchParams(location.search);
const layout = params.get('layout') === 'panel' ? 'panel' : params.get('layout') === 'code' ? 'code' : 'split';
const theme = params.get('theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
if (theme === 'light') document.body.classList.add('light');
document.body.dataset.layout = layout;

function injectCodicons(): void {
  const uri = window.__pyokka?.codiconsUri;
  if (!uri) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = uri;
  document.head.appendChild(link);
}
injectCodicons();
bootMonaco();

const $ = (id: string) => document.getElementById(id)!;
const fileLabel = $('pkw-file');
const runtimeLabel = $('pkw-runtime');
const statusDot = $('pkw-status');

// the panel's VS Code API, answered by the page host instead of an extension
let host: PageHost;
const PREFS_KEY = 'pyokka.web.panelState';
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebviewToHost) => queueMicrotask(() => host.onPanel(m)),
  getState: () => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  },
  setState: (s: unknown) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(s));
    } catch {
      /* private window: preferences last for the visit */
    }
  },
});
const toPanel = (m: HostToWebview) => window.postMessage(m, location.origin);

let editTimer: ReturnType<typeof setTimeout> | undefined;
const code = new CodePane(
  $('pkw-code'),
  (content) => {
    // Quokka-style: an edit runs the buffer as it stands, without saving it (Run Automatically only)
    if (editTimer) clearTimeout(editTimer);
    if (host.settings.runMode === 'auto') editTimer = setTimeout(() => host.rerun(content), 350);
    updateTitle();
  },
  (content) => {
    link.send({ type: 'save', content });
    // Run on Save runs what was saved; Run Automatically already ran it as it was typed
    if (host.settings.runMode === 'onSave') host.rerun();
    updateTitle();
  },
);

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const link = new BridgeLink(wsUrl, (msg) => onBridge(msg), (connected) => {
  host.connected = connected;
  statusDot.className = connected ? 'pkw-dot ok' : 'pkw-dot off';
  statusDot.title = connected ? 'Connected to the Pyokka bridge' : 'Bridge not reachable: is pyokka-web still running?';
});
host = new PageHost(link, code, toPanel);
host.theme = theme === 'light' ? 'light' : 'dark';
// for an agent driving the page with browser tools, and for debugging: the same calls the WebMCP tools make
(window as unknown as { pyokka: PageHost }).pyokka = host;

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
host.notice = (text, level) => {
  const el = $('pkw-notice');
  el.textContent = text;
  el.className = `pkw-notice ${level}`;
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.hidden = true), level === 'error' ? 12000 : 4000);
};

// the live debugger: breakpoints in the gutter (or F9), its controls under the code
code.onGutterClick = (path, line) => host.debug.setBreakpoint(path, line);
code.onDefinitionNavigate = (path, line, column) => openDefinitionTab(path, line, column);
// Show Variable History from the code pane (its context menu, a hover's link): the right panel's VARIABLE view
code.onShowHistory = (name) => host.showVariableHistory(name);
// the Code Story and the profile: a row picked goes to its step, Ctrl/Cmd+click opens its source
code.onLinePick = (path, line, how) => host.linePick(path, line, how);

// View Recent Files: the files this bridge ran, a click makes one the main file
host.onRecent = (files) => {
  const box = $('pkw-recent');
  render(
    <div class="pkw-recent-list" role="menu">
      <div class="pkw-recent-head">Recent files</div>
      {files.length ? (
        files.map((f) => (
          <button
            type="button"
            class={`pkw-recent-item${f.path === host.main?.path ? ' current' : ''}`}
            title={f.path}
            onClick={() => {
              box.hidden = true;
              if (f.path !== host.main?.path) host.openFile(f.path);
            }}
          >
            <span class="pkw-recent-name">{f.displayName}</span>
            <span class="pkw-recent-path">{f.path}</span>
          </button>
        ))
      ) : (
        <div class="pkw-recent-path">none yet</div>
      )}
    </div>,
    box,
  );
  box.hidden = false;
};
document.addEventListener('pointerdown', (e) => {
  const box = $('pkw-recent');
  if (!box.hidden && !box.contains(e.target as Node)) box.hidden = true;
});
const debugPane = $('pkw-debugpane');
const showDebuggerView = () => toPanel({ type: 'showView', view: 'debug' });
function renderDebug(): void {
  render(<DebugPane debug={host.debug} onShowView={showDebuggerView} onLayout={() => code.layout()} />, debugPane);
  $('pkw-debug').classList.toggle('active', host.debug.active);
  // the Time Machine's Step (one recorded event) and Step back, shown while it is on
  const trace = host.trace;
  const on = host.nav.active && !!trace && !host.debug.active;
  const stepBtn = $('pkw-step') as HTMLButtonElement;
  const backBtn = $('pkw-step-back') as HTMLButtonElement;
  stepBtn.hidden = backBtn.hidden = !on;
  stepBtn.disabled = !on || !trace!.valid(host.nav.step + 1);
  backBtn.disabled = !on || !trace!.canStep(host.nav.step).back;
}
document.addEventListener('keydown', (e) => {
  if (!host.debug.run?.running) return;
  const key = e.key === 'F5' ? (e.shiftKey ? 'stop' : 'continue') : e.key === 'F10' ? 'stepOver' : e.key === 'F11' ? (e.shiftKey ? 'stepOut' : 'stepInto') : null;
  if (!key) return;
  e.preventDefault();
  void host.debug.control(key);
});

let stateTimer: ReturnType<typeof setTimeout> | undefined;
host.onChange = () => {
  updateTitle();
  renderDebug();
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    link.send({ type: 'state', state: host.state() });
  }, 150);
};

/** the bridge build this tab's code came from, set by the first hello */
let pageBuild: string | undefined;

function onBridge(msg: BridgeToPage): void {
  if (msg.type === 'hello' && msg.build) {
    // a bridge restarted on a new build serves page code this tab does not have
    if (staleBuild(pageBuild, msg.build, code.dirty)) {
      location.reload();
      return;
    }
    pageBuild ??= msg.build;
  }
  if (msg.type === 'agent') {
    runAgentCommand(host, link, msg.command).then(
      (result) => link.send({ type: 'agent.result', id: msg.id, result }),
      (err) => link.send({ type: 'agent.result', id: msg.id, result: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  host.onBridge(msg);
  if (msg.type === 'hello' || msg.type === 'runtime') {
    const r = msg.runtime;
    runtimeLabel.textContent = runtimeLabelText(r.ready);
    runtimeLabel.title = r.command;
  }
}

function updateTitle(): void {
  const name = host.main?.displayName ?? '';
  const dirty = code.isMainShown() && code.dirty;
  const shown = code.shownPath();
  const other = shown && host.main && shown !== host.main.path ? ` › ${code.shownName() ?? shown.split(/[\\/]/).pop()}` : '';
  fileLabel.textContent = `${name}${dirty ? ' ●' : ''}${other}`;
  fileLabel.title = host.main?.path ?? '';
  document.title = `${name ? `${name} · ` : ''}Pyokka`;
  $('pkw-back').hidden = !other;
}

$('pkw-run').addEventListener('click', () => host.rerun(code.dirty ? code.mainContent() : undefined));
$('pkw-back').addEventListener('click', () => {
  host.showMain();
  updateTitle();
});
$('pkw-tm').addEventListener('click', () => (host.nav.active ? host.stop() : host.start({ line: code.cursorLine() })));
$('pkw-step').addEventListener('click', () => host.next());
$('pkw-step-back').addEventListener('click', () => host.move('back'));
$('pkw-debug').addEventListener('click', () => (host.debug.active ? showDebuggerView() : host.debug.start(code.dirtyContent())));
$('pkw-layout').addEventListener('click', () => {
  const next = document.body.dataset.layout === 'split' ? 'panel' : document.body.dataset.layout === 'panel' ? 'code' : 'split';
  document.body.dataset.layout = next;
  const u = new URL(location.href);
  if (next === 'split') u.searchParams.delete('layout');
  else u.searchParams.set('layout', next);
  history.replaceState(null, '', u);
  code.layout();
});

// splitter between the code pane and the panel
const split = $('pkw-split');
split.addEventListener('pointerdown', (e) => {
  split.setPointerCapture(e.pointerId);
  const main = $('pkw-main');
  const move = (ev: PointerEvent) => {
    const rect = main.getBoundingClientRect();
    const frac = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
    main.style.setProperty('--pkw-code', `${frac * 100}%`);
  };
  const up = () => {
    split.removeEventListener('pointermove', move);
    split.removeEventListener('pointerup', up);
  };
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', up);
});

// the Scratchpad: experiments seeded from the live pause, run in a separate python -I
const scratchpad = new Scratchpad($('pkw-scratchpad'), host, link, code);
host.onScratchpad = (command) => scratchpad.control(command);
(window as unknown as { pyokkaScratchpad: Scratchpad }).pyokkaScratchpad = scratchpad;
$('pkw-scratch-toggle').addEventListener('click', () => void scratchpad.toggle().catch((e) => host.notice(e instanceof Error ? e.message : String(e), 'error')));

// a tool the browser refused later (a duplicate name) shows on the chip, not only in the console
const refused: string[] = [];
const webMcp = registerWebMcp(host, link, (name, err) => {
  refused.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  const chip = $('pkw-webmcp');
  chip.classList.add('pkw-chip-warn');
  chip.textContent = `WebMCP (${refused.length} not registered)`;
  chip.title = `The browser did not register these tools:\n${refused.join('\n')}`;
});
$('pkw-webmcp').hidden = !webMcp;

render(<App />, $('root'));
