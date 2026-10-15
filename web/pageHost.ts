/**
 * The browser page's stand-in for the extension host: it reads the runtime's events relayed by the
 * bridge, keeps the run (files, values, errors, coverage, the recorded trace) and the Time Machine
 * position, and feeds the unchanged panel (webview/App.tsx) the same `HostToWebview` messages the
 * extension sends, while drawing the code pane. The other views are panes.ts's, the live debugger
 * debugHost.ts's. Only vscode-free modules of the extension are reused, so nothing here knows the
 * runtime's language.
 */
import type { TraceModel } from '../src/timeMachine/traceModel';
import { buildWalkthrough } from '../src/session/walkthrough';
import { buildExceptionReport } from '../src/session/exceptionReport';
import type { WalkthroughInputs } from '../src/session/walkthroughShared';
import type { ExceptionSite } from '../src/session/exceptionReportTypes';
import type { LogEvent, RunEvent } from '../src/shared/protocol';
import type { DebuggerState, ExceptionsPanel, HostToWebview, PanelEntry, PanelMoment, PanelSettings, StoryPanel, WalkthroughPanel, WebviewToHost } from '../src/shared/webviewProtocol';
import type { BridgeFile, BridgeProfile, BridgeToPage, ConfigPatch, PageState, PageToBridge, RecentFile, RequestBody, RuntimeInfo } from './bridgeProtocol';
import { renderProfile } from './profileSummary';
import type { RunnerMessage } from '../src/shared/protocol';
import { applyEvent, emptyRun, runInputs, type RunData } from './runState';
import { Panes } from './panes';
import { DebugHost } from './debugHost';
import { pausedOccurrences, pausedHover, type PausedValues } from './pausedValues';
import { inlineHistory, pauseHistory } from './codeHistory';
import { definitionTabUrl, fetchDefinitions } from './definitionTab';
import { lineStarts } from './pausedValues';
import type { SourceIdentifiers, VariableHistory } from '../src/shared/protocol';
import { buildStory, paintStory, storyRowOf, storyTarget, STORY_PATH, type StoryModel } from './story';

/** What the page needs from its bridge connection (web/link.ts). */
export interface Link {
  send(msg: PageToBridge): void;
  request(body: RequestBody): Promise<RunnerMessage>;
  /** a request for the live debugger's run */
  debugRequest(body: RequestBody): Promise<RunnerMessage>;
}

export interface CodeDecorations {
  /** line -> the value text shown after it */
  inline: Map<number, string>;
  /** line -> coverage state (docs/PROTOCOL.md `coverage`: 0 not run, 1 covered, 2 partial, 3 error source, 4 error path) */
  coverage: Map<number, number>;
  /** the Time Machine's line, and whether the step entered a function */
  current: { line: number; col: number } | null;
  /** lines of the frames that called the current one */
  callers: number[];
  /** line -> exception text */
  errors: Map<number, string>;
  /** line -> breakpoint of the live debugger (`condition` when it has one) */
  breakpoints: Map<number, { condition?: string }>;
  /** the line the live debugger is paused at, in this file */
  paused: number | null;
  /** the selected frame's values at the pause, when the shown file is its file and the source is unchanged */
  liveValues?: PausedValues;
  /** while the live debugger runs: this file's earlier pauses (oldest first), for the code history beside declarations */
  history?: PausedValues[];
  /** the Code Story only: the current step's columns on its line, and the columns to render dim */
  box?: { line: number; start: number; end: number } | null;
  dim?: { line: number; start: number; end: number }[];
}

/** What the page needs from the code pane (web/codePane.ts). */
export interface CodeView {
  showFile(file: BridgeFile, opts?: { keepDirty?: boolean }): void;
  shownPath(): string | undefined;
  render(d: CodeDecorations): void;
  reveal(line: number): void;
  setNarration(n: { text: string; line: number } | null): void;
  cursorLine(): number | undefined;
  /** the main file's edited text when it differs from the disk */
  dirtyContent?(): string | undefined;
  /** the bridge switched to another main file (Open Recent) */
  setMain?(file: BridgeFile): void;
  /** the name or attribute path under the cursor (the selection when there is one) */
  expressionAtCursor?(): string | undefined;
}

/** Paths of the read-only documents the page makes up (never files on disk). */
export const PROFILE_PATH = 'pyokka://profile';
export const LOG_PATH = 'pyokka://logs';

export type { RunData } from './runState';

export type MoveKind = 'into' | 'over' | 'out' | 'back' | 'backOver' | 'backOut';

interface Nav {
  active: boolean;
  step: number;
  showCallStack: boolean;
  selectedFrame: number;
  codePreview: boolean;
  echo: boolean;
  autoPlaying: boolean;
}

export const BROWSER_SETTINGS: PanelSettings = {
  autoLog: false,
  valuePeek: true,
  showValueOnSelection: false,
  showSingleInlineValue: true,
  runMode: 'auto',
  libraryCode: false,
  maskSecrets: true,
  runTimeoutMs: 30000,
  recordLocals: true,
  http: 'off',
  diagramDetail: 'scopes',
  diagramDataEdges: true,
};

export class PageHost {
  main: BridgeFile | null = null;
  runtime: RuntimeInfo | null = null;
  connected = false;
  run: RunData | null = null;
  /** a run that began but has sent nothing yet: the previous run stays on screen until it does */
  private incoming: RunData | null = null;
  readonly nav: Nav = { active: false, step: -1, showCallStack: false, selectedFrame: 0, codePreview: true, echo: true, autoPlaying: false };
  settings: PanelSettings = { ...BROWSER_SETTINGS };
  theme: 'dark' | 'light' = 'dark';
  narration: { text: string; line: number; path: string } | null = null;
  /** sources of files other than the main one, fetched on demand */
  private readonly sources = new Map<string, string>();
  /** lexical identities per source text (the runtime's `bindings` with `identifiers`), fetched on demand */
  private readonly identityCache = new Map<string, Promise<SourceIdentifiers | null>>();
  private readonly identityKnown = new Map<string, SourceIdentifiers | null>();
  /** the live debug run's pauses (the selected frame's variables at each), by path then run:step:frame */
  private pauseHistory: { runId: string; byPath: Map<string, Map<string, Omit<PausedValues, 'identifiers'>>> } | null = null;
  private panelReady = false;
  private pendingEntries: LogEvent[] = [];
  private entriesTimer: ReturnType<typeof setTimeout> | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private autoPlayTimer: ReturnType<typeof setInterval> | undefined;
  /** the Time Machine was asked for before the trace arrived: start it when it does */
  private startWhenTraced: { step?: number; line?: number } | null = null;
  private readonly finishWaiters: (() => void)[] = [];
  /** called on every change an agent could ask about */
  onChange: () => void = () => {};
  /** a message for the person: a runtime error, an action the browser cannot do yet */
  notice: (text: string, level: 'info' | 'error') => void = (text) => console.warn(`[pyokka] ${text}`);
  /** the views beyond Output and the Time Machine (panes.ts) */
  readonly panes: Panes;
  /** the live debugger (debugHost.ts) */
  readonly debug: DebugHost;
  /** `fetchSource` callers waiting for the bridge's `file` answer, by path */
  private readonly sourceWaiters = new Map<string, ((content: string | undefined) => void)[]>();

  constructor(
    private readonly link: Link,
    private readonly code: CodeView,
    private readonly toPanel: (m: HostToWebview) => void,
  ) {
    const host = this;
    this.panes = new Panes({
      get run() {
        return host.run;
      },
      get main() {
        return host.main;
      },
      get nav() {
        return host.nav;
      },
      busy: () => !!this.incoming || !!this.run?.running,
      recordLocals: () => this.settings.recordLocals,
      post: (m) => this.post(m),
      send: (m) => this.link.send(m),
      request: (body) => this.link.request(body),
      displayPath: (fileId) => this.displayPath(fileId),
      sourceLines: (fileId) => this.sourceOf(fileId)?.split(/\r?\n/),
      fetchSource: (fileId) => this.fetchSource(fileId),
      mainFileId: () => this.mainFileId(),
      inputs: () => this.inputs(),
      gotoStep: (step) => (this.nav.active ? this.goto(step) : void this.start({ step })),
      rerunForWatches: () => this.rerun(this.code.dirtyContent?.()),
      pushDebugger: () => this.pushDebugger(),
      pushWalkthrough: () => this.pushWalkthrough(),
      updateSettings: (patch) => this.updateSettings(patch),
      pauseHistory: (name) => this.pauseVariableHistory(name),
    });
    this.debug = new DebugHost(
      { send: (m) => this.link.send(m), debugRequest: (body) => this.link.debugRequest(body) },
      (m) => this.post(m),
      () => this.main,
      (path, line) => this.revealPath(path, line),
      (text, level) => this.notice(text, level),
      () => this.run?.files.all().map((f) => f.path) ?? [],
    );
    let debugging = false;
    this.debug.onChange = () => {
      this.recordPause();
      // the Variable view showed the pauses: once the session ends it shows the recording again
      if (debugging && !this.debug.active) this.panes.refreshVariable(true);
      debugging = this.debug.active;
      this.scheduleRender();
      this.onChange();
    };
  }

  /** Every message to the panel goes through here: none before it said it is ready. */
  private post(m: HostToWebview): void {
    if (this.panelReady) this.toPanel(m);
  }

  /* ---------- bridge ---------- */

  onBridge(msg: BridgeToPage): void {
    switch (msg.type) {
      case 'hello':
        if (this.main && this.main.path !== msg.file.path) {
          // Open Recent: another file is the main one now
          this.stop();
          this.debug.stop();
          this.sources.clear();
          this.code.setMain?.(msg.file);
        }
        this.main = msg.file;
        this.runtime = msg.runtime;
        this.panes.canNarrate = msg.canNarrate;
        this.code.showFile(msg.file);
        // a tab that reconnects to a restarted bridge gives it the breakpoints it kept
        this.debug.offerBreakpoints();
        this.pushSession();
        break;
      case 'runtime':
        this.runtime = msg.runtime;
        break;
      case 'file':
        if (this.main && msg.file.path === this.main.path) {
          this.main = msg.file;
          if (this.code.shownPath() === msg.file.path) this.code.showFile(msg.file);
        } else {
          this.sources.set(msg.file.path, msg.file.content);
          for (const w of this.sourceWaiters.get(msg.file.path)?.splice(0) ?? []) w(msg.file.content);
          // a shown import saved on disk: the new text, with the run's decorations on it (nothing moves or runs)
          if (this.code.shownPath() === msg.file.path && this.wantPath !== msg.file.path) {
            this.code.showFile(msg.file);
            this.scheduleRender(true);
          }
          if (this.wantPath === msg.file.path) {
            this.wantPath = undefined;
            this.code.showFile(msg.file);
            this.scheduleRender(true);
            if (this.wantLine) this.code.reveal(this.wantLine);
            this.wantLine = undefined;
          }
        }
        break;
      case 'run.begin':
        this.incoming = emptyRun(msg.runId, msg.content);
        this.pushSession(true);
        break;
      case 'event':
        this.onEvent(msg.event);
        break;
      case 'runner.error':
        (this.incoming ?? this.run)?.runnerErrors.push(msg.message);
        this.notice(msg.message, 'error');
        break;
      case 'narration':
        this.panes.onNarration(msg.narration);
        break;
      case 'tour':
        this.panes.onTour(msg.tour);
        break;
      case 'debug.breakpoints':
        this.debug.onBreakpoints(msg.set);
        break;
      case 'debug.begin':
        this.debug.onBegin(msg.runId, msg.content);
        break;
      case 'debug.event':
        this.debug.onEvent(msg.event);
        break;
      case 'debug.end':
        this.debug.onEnd(msg.runId, msg.message);
        break;
      case 'profile':
        this.onProfile(msg.profile);
        break;
      case 'recent':
        this.onRecent(msg.files);
        break;
      case 'saved':
      case 'agent':
        break;
    }
    this.onChange();
  }

  private onEvent(ev: RunEvent): void {
    if (this.incoming && ev.runId === this.incoming.runId) this.adoptIncoming();
    const run = this.run;
    if (!run || !applyEvent(run, ev)) return;
    switch (ev.type) {
      case 'log':
        if (!this.nav.active || ev.step <= this.nav.step) this.queueEntry(ev);
        this.scheduleRender();
        break;
      case 'output':
        this.post({ type: 'output', stream: ev.stream, text: ev.text });
        break;
      case 'error':
        this.pushErrors();
        this.scheduleRender();
        break;
      case 'coverage':
        this.scheduleRender();
        break;
      case 'trace':
        if (run.trace && run.traceEvent === ev) this.post({ type: 'timeline', model: run.trace.toTimelineModel() });
        break;
      case 'http.exchange':
        this.panes.scheduleHttp();
        break;
      case 'watch':
        this.panes.onWatchEvent(ev);
        break;
      case 'run.finished':
        this.flushEntries();
        this.pushSession();
        this.pushWalkthrough();
        this.pushExceptions();
        this.panes.runFinished();
        this.afterFinish();
        break;
      default:
        break;
    }
  }

  /** The new run's first event: it replaces the one on screen. */
  private adoptIncoming(): void {
    const prevStep = this.nav.active ? this.nav.step : null;
    this.run = this.incoming;
    this.incoming = null;
    this.pendingEntries = [];
    this.toPanel({ type: 'entries.reset' });
    this.toPanel({ type: 'errors', errors: [] });
    this.toPanel({ type: 'timeline', model: null });
    this.toPanel({ type: 'walkthrough', walkthrough: null });
    this.toPanel({ type: 'exceptions', report: null });
    if (this.run) this.panes.runAdopted(this.run);
    if (prevStep !== null) {
      // keep the Time Machine where it was across a re-run (an edit, a save): restored on the new trace
      this.stopAutoPlay();
      this.nav.active = false;
      this.startWhenTraced = { step: prevStep };
      this.pushDebugger();
    }
    this.pushSession();
  }

  private afterFinish(): void {
    const want = this.startWhenTraced;
    this.startWhenTraced = null;
    if (want && this.run?.trace) this.start(want);
    else this.scheduleRender(true);
    for (const w of this.finishWaiters.splice(0)) w();
  }

  /** Resolves once no run is in flight (at once when none is). */
  idle(timeoutMs = 30_000): Promise<void> {
    if (!this.incoming && !this.run?.running) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.finishWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /* ---------- panel ---------- */

  onPanel(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.panelReady = true;
        this.toPanel({ type: 'init', theme: this.theme, settings: this.settings, sessionName: this.main?.displayName ?? null });
        this.pushSession();
        this.pushAll();
        return;
      case 'expand':
        void this.expand(msg.requestId, msg.valueId, msg.queryPath);
        return;
      case 'openLocation':
        this.openLocation(msg.fileId, msg.line, msg.file);
        return;
      case 'copy':
        void navigator.clipboard?.writeText(msg.text).catch(() => undefined);
        return;
      case 'settings.update':
        this.updateSettings(msg.patch);
        return;
      case 'debugger.goto':
        if (!this.nav.active) this.start({ step: msg.step });
        else this.goto(msg.step);
        return;
      case 'debugger.action':
        this.debuggerAction(msg.action);
        return;
      case 'debugger.previewRequest':
        this.pushPreview(msg.step);
        return;
      case 'debugger.selectFrame':
        this.selectFrame(msg.index);
        return;
      case 'command':
        this.command(msg.command, msg.args);
        return;
      case 'variable.query':
        void this.panes.queryVariable(msg.name);
        return;
      case 'story.pick':
        this.storyPick(msg.line, msg.open === true);
        return;
      case 'viewChanged':
        // the rail moved the panel off the story (or back to it): only a story on show follows the step
        this.storyOpen = msg.view === 'story' && this.story !== null;
        if (this.storyOpen) this.pushStory();
        return;
      case 'why.query':
        void this.panes.queryWhy(msg.step, msg.name, msg.logId);
        return;
      case 'why.close':
        this.panes.closeWhy();
        return;
      case 'executionGraph.request':
        this.panes.pushGraph();
        return;
      case 'executionGraph.expand':
        this.panes.expandGraph(msg.nodeId, msg.collapse);
        return;
      case 'executionGraph.hits':
        this.panes.graphHits(msg.nodeId);
        return;
      case 'narrate':
        this.panes.narrate();
        return;
      case 'tour.open':
        this.panes.setTourOpen(msg.open);
        return;
      case 'tour.goto':
        this.panes.tourGoto(msg.step, msg.stopId);
        return;
      case 'tour.narrate':
        this.panes.narrateTour();
        return;
      case 'tour.recordLocals':
        this.panes.recordLocalsAndRun();
        return;
      case 'compare':
        this.panes.compare(msg.leftLogId, msg.rightLogId);
        return;
      case 'diagram':
        this.post({ type: 'showView', view: 'diagram' });
        return;
      case 'watch.add':
        if (!this.nav.active) this.start({ line: this.code.cursorLine() });
        this.panes.addWatch(msg.exp);
        return;
      case 'watch.remove':
        this.panes.removeWatch(msg.id);
        return;
      case 'watch.edit':
        this.panes.editWatch(msg.id, msg.exp);
        return;
      case 'watch.refresh':
        this.panes.refreshWatch(msg.id);
        return;
      case 'watch.evaluate':
        this.panes.evaluateWatch(msg.id);
        return;
      case 'watch.complete':
        void this.panes.complete(msg.requestId, msg.text);
        return;
      case 'debug.selectFrame':
      case 'debug.watch.add':
      case 'debug.watch.edit':
      case 'debug.watch.remove':
      case 'debug.breakpoint.remove':
      case 'debug.exceptions':
      case 'debug.control':
      case 'debug.output.resync':
        void this.debug.handle(msg);
        return;
      case 'debugContinue':
        void this.debug.control('continue');
        return;
      case 'debugPause':
        void this.debug.control('pause');
        return;
      case 'debugStep':
        void this.debug.control(msg.kind === 'over' ? 'stepOver' : msg.kind === 'out' ? 'stepOut' : 'stepInto');
        return;
      case 'debugStop':
        this.debug.stop();
        return;
      default:
        return;
    }
  }

  private command(command: string, args?: unknown[]): void {
    switch (command) {
      case 'pyokka.showVariableHistory': {
        const arg = args?.[0];
        const given = typeof arg === 'string' ? arg : arg && typeof arg === 'object' ? (arg as { name?: unknown }).name : undefined;
        this.showVariableHistory(typeof given === 'string' ? given : undefined);
        return;
      }
      case 'pyokka.reexecute':
        this.rerun();
        return;
      case 'pyokka.debug':
      case 'pyokka.startOnCurrentFile':
        this.start({ line: this.code.cursorLine() });
        return;
      case 'pyokka.stopTraceNavigation':
        this.stop();
        return;
      case 'pyokka.showOutput':
        return;
      case 'pyokka.debugCurrentFile':
        this.debug.start(this.code.dirtyContent?.());
        return;
      case 'pyokka.explain':
        this.panes.narrate();
        return;
      case 'pyokka.viewCodeStory':
        void this.openStory();
        return;
      case 'pyokka.profile':
        this.profile();
        return;
      case 'pyokka.showInstrumentedFile':
        void this.showInstrumented();
        return;
      case 'pyokka.showLogs':
        // always the bridge's latest lines
        this.sources.delete(LOG_PATH);
        this.revealPath(LOG_PATH, 1);
        return;
      case 'pyokka.editSessionSettings':
        this.post({ type: 'showView', view: 'settings' });
        return;
      case 'pyokka.viewRecentFiles':
        this.link.send({ type: 'recent' });
        return;
      case 'pyokka.openHttpRecording': {
        const file = this.run?.finished?.http?.file;
        if (!file) this.notice('no HTTP recording yet: run once with HTTP Record', 'info');
        else this.revealPath(file, 1);
        return;
      }
      default:
        this.notice(`${command.replace(/^pyokka\./, '')} is not available in the browser yet`, 'info');
    }
  }

  /**
   * Show the Variable History view for `name` (else the name under the code pane's cursor; with
   * neither, the view's input box asks), as the extension's Show Variable History command does.
   */
  showVariableHistory(name?: string): void {
    const query = name?.trim() || this.code.expressionAtCursor?.();
    this.post({ type: 'showView', view: 'variable' });
    if (query) void this.panes.queryVariable(query);
  }

  updateSettings(patch: Partial<PanelSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.toPanel({ type: 'settings', settings: this.settings });
    const config: ConfigPatch = {};
    if (patch.autoLog !== undefined) config.autoLog = patch.autoLog;
    if (patch.libraryCode !== undefined) config.libraryCode = patch.libraryCode;
    if (patch.recordLocals !== undefined) config.recordLocals = patch.recordLocals;
    if (patch.maskSecrets !== undefined) config.maskSecrets = patch.maskSecrets;
    if (patch.runTimeoutMs !== undefined) config.timeoutMs = patch.runTimeoutMs;
    if (patch.http !== undefined) config.http = patch.http;
    if (Object.keys(config).length) this.link.send({ type: 'config', patch: config });
    if (patch.runMode !== undefined) this.link.send({ type: 'runMode', mode: patch.runMode });
    this.pushSession();
  }

  private async expand(requestId: number, valueId: string, queryPath: string[]): Promise<void> {
    const runId = this.run?.runId;
    if (!runId) return;
    const reply = await this.link.request({ type: 'expand', runId, valueId, queryPath });
    if (reply.type === 'value') this.toPanel({ type: 'value', requestId, node: reply.node });
    else this.toPanel({ type: 'value', requestId, error: reply.type === 'error' ? reply.message : `unexpected reply ${reply.type}` });
  }

  /** Run the file again (the buffer when `content` is given), with the watches around the Time Machine's step. */
  rerun(content?: string): void {
    const watch = this.panes.watchRequests();
    const traceContext = this.nav.active && watch.length ? { step: this.nav.step, prefetch: 10 } : null;
    this.link.send({ type: 'run', ...(content === undefined ? {} : { content }), watch, traceContext });
  }

  /* ---------- pushing state to the panel ---------- */

  private pushAll(): void {
    const run = this.run;
    if (!run) return;
    this.toPanel({ type: 'entries.reset' });
    this.pushEntries();
    this.pushErrors();
    this.toPanel({ type: 'timeline', model: run.trace ? run.trace.toTimelineModel() : null });
    this.pushDebugger();
    this.pushWalkthrough();
    this.pushExceptions();
    this.panes.resync();
    this.debug.push();
  }

  /** The inputs of the walkthrough and exceptions builders, once the run finished with a trace. */
  inputs(): WalkthroughInputs | undefined {
    if (!this.main) return undefined;
    return runInputs(this.run, this.main.path, (fileId) => this.sourceOf(fileId)?.split(/\r?\n/), this.panes.glosses());
  }

  /** The WALKTHROUGH section: the run's moments (no narration backend in the browser). */
  pushWalkthrough(): void {
    const inputs = this.inputs();
    if (!inputs || !this.panelReady) return;
    const w = buildWalkthrough(inputs);
    const moments: PanelMoment[] = w.moments.map((m) => ({ id: m.id, kind: m.kind, step: m.step, fileId: m.location.fileId, file: this.displayPath(m.location.fileId), line: m.location.line, function: m.location.function, text: m.text, values: m.values, gloss: m.gloss, more: m.more, entryStep: m.entryStep, endStep: m.endStep }));
    const panel: WalkthroughPanel = { runId: this.run!.runId, count: w.count, total: w.total, shown: w.shown, truncated: w.truncated, moments, narrating: this.panes.narrating(), canNarrate: this.panes.canNarrate, ...(this.panes.narrationError() ? { narrationError: this.panes.narrationError() } : {}) };
    this.toPanel({ type: 'walkthrough', walkthrough: panel });
  }

  /** The EXCEPTIONS section: every exception of the last run, with display paths. */
  private pushExceptions(): void {
    const inputs = this.inputs();
    if (!inputs || !this.panelReady) return;
    const report = buildExceptionReport(inputs);
    const shown = <T extends ExceptionSite>(site: T): T => ({ ...site, file: this.displayPath(site.fileId) });
    const rows = report.rows.map((r) => ({ ...r, raisedAt: shown(r.raisedAt), handledAt: r.handledAt ? shown(r.handledAt) : null }));
    const panel: ExceptionsPanel = { ...report, file: report.file ? (this.main?.displayName ?? null) : null, rows, runId: this.run!.runId };
    this.toPanel({ type: 'exceptions', report: panel });
  }

  private pushSession(running?: boolean): void {
    if (!this.panelReady) return;
    const run = this.run;
    const busy = running ?? (!!this.incoming || !!run?.running);
    this.toPanel({
      type: 'session',
      name: this.main?.displayName ?? null,
      running: busy,
      durationMs: run?.finished?.durationMs,
      runMode: 'auto',
      settings: this.settings,
      ...(run?.finished?.timedOut ? { timedOutMs: this.settings.runTimeoutMs } : {}),
    });
  }

  private queueEntry(ev: LogEvent): void {
    this.pendingEntries.push(ev);
    if (this.pendingEntries.length >= 200) this.flushEntries();
    else if (!this.entriesTimer) this.entriesTimer = setTimeout(() => this.flushEntries(), 30);
  }

  private flushEntries(): void {
    if (this.entriesTimer) clearTimeout(this.entriesTimer);
    this.entriesTimer = undefined;
    const batch = this.pendingEntries;
    this.pendingEntries = [];
    if (batch.length && this.panelReady) this.toPanel({ type: 'entries.append', entries: batch.map((e) => this.toPanelEntry(e)) });
  }

  private visibleLogs(): LogEvent[] {
    const run = this.run;
    if (!run) return [];
    return this.nav.active ? run.logs.filter((e) => e.step <= this.nav.step) : run.logs;
  }

  private pushEntries(): void {
    if (!this.panelReady) return;
    this.pendingEntries = [];
    const logs = this.visibleLogs();
    this.toPanel({ type: 'entries.reset' });
    for (let i = 0; i < logs.length; i += 500) this.toPanel({ type: 'entries.append', entries: logs.slice(i, i + 500).map((e) => this.toPanelEntry(e)) });
  }

  private pushErrors(): void {
    const run = this.run;
    if (!run || !this.panelReady) return;
    const errors = run.errors.map((e) => {
      const loc = run.files.locate(e.rid);
      return { ...e, file: this.displayPath(e.fileId), line: loc?.range[0] ?? e.stack[0]?.line ?? 0, col: loc?.range[1] ?? 0 };
    });
    this.toPanel({ type: 'errors', errors });
  }

  toPanelEntry(e: LogEvent): PanelEntry {
    const loc = this.run?.files.locate(e.rid);
    return {
      logId: e.logId,
      kind: e.kind,
      fileId: e.fileId,
      file: this.displayPath(e.fileId),
      line: e.liveLine ?? loc?.range[0] ?? 0,
      col: loc?.range[1] ?? 0,
      rid: e.rid,
      hit: e.hit,
      step: e.step,
      context: e.context,
      text: e.text,
      runtimeKey: e.runtimeKey,
      valueBag: e.valueBag,
      isError: e.kind === 'error',
      time: e.time,
    };
  }

  /** A path relative to the main file's directory, else as the runtime reported it. */
  displayPath(fileId: number): string {
    const p = this.run?.files.get(fileId)?.path;
    if (!p) return '';
    const dir = this.main ? this.main.path.slice(0, this.main.path.length - this.main.displayName.length) : '';
    return dir && p.startsWith(dir) ? p.slice(dir.length) : p;
  }

  private debuggerState(): DebuggerState {
    const trace = this.run?.trace;
    const nav = this.nav;
    const step = nav.step;
    const valid = !!trace && nav.active && trace.valid(step);
    const canStep = valid ? trace!.canStep(step) : { into: false, back: false, over: false, backOver: false, out: false, backOut: false };
    const callStack = nav.showCallStack && valid
      ? { frames: trace!.callStack(step).map((f) => ({ fileId: f.fileId, line: f.line, col: f.col, rid: f.rid, function: f.function, step: f.step, scopeId: f.scopeId })), selected: nav.selectedFrame }
      : undefined;
    const locals = this.run?.locals.find((l) => l.step === step)?.changes;
    return {
      active: nav.active,
      autoPlaying: nav.autoPlaying,
      currentStep: step,
      canStep,
      echoSteps: nav.echo && valid ? trace!.echoSteps(step) : [],
      callStack,
      showCallStack: nav.showCallStack,
      codePreview: nav.codePreview,
      echo: nav.echo,
      watches: this.panes.watchRows(step),
      locals,
    };
  }

  pushDebugger(): void {
    if (this.panelReady) this.toPanel({ type: 'debugger', state: this.debuggerState() });
  }

  private pushPreview(step: number): void {
    const run = this.run;
    const trace = run?.trace;
    const loc = trace?.location(step);
    if (!run || !trace || !loc) return;
    const lines = (this.sourceOf(loc.fileId) ?? '').split(/\r?\n/);
    const line = loc.range[0];
    const start = Math.max(1, line - 3);
    const end = Math.min(lines.length, start + 6);
    const [frame, callSite] = trace.callStack(step);
    const caller = callSite ? { step: callSite.step, function: callSite.function, file: this.displayPath(callSite.fileId), line: callSite.line } : undefined;
    this.toPanel({ type: 'codePreview', step, file: this.displayPath(loc.fileId), startLine: start, lines: lines.slice(start - 1, end), highlightLine: line, function: frame?.function ?? '<module>', caller });
  }

  /* ---------- Time Machine ---------- */

  get trace(): TraceModel | null {
    return this.run?.trace ?? null;
  }

  mainFileId(): number | undefined {
    if (!this.run || !this.main) return undefined;
    return this.run.files.byPath(this.main.path)?.fileId;
  }

  /** Turn the Time Machine on at `step`, or at the first step on `line` of the shown file, else step 0. */
  start(opts: { step?: number; line?: number } = {}): boolean {
    const trace = this.trace;
    if (!trace || this.incoming || this.run?.running) {
      this.startWhenTraced = opts;
      if (!this.run && !this.incoming) this.rerun();
      return false;
    }
    if (trace.count === 0) return false;
    let step = opts.step;
    if (step === undefined && opts.line !== undefined) {
      const fileId = this.shownFileId() ?? this.mainFileId();
      if (fileId !== undefined) step = trace.startStep(fileId, opts.line);
    }
    this.nav.active = true;
    this.nav.selectedFrame = 0;
    this.goto(step ?? 0);
    return true;
  }

  stop(): void {
    this.stopAutoPlay();
    if (!this.nav.active) return;
    this.nav.active = false;
    this.nav.step = -1;
    this.nav.showCallStack = false;
    // D2: the story exists only while the Time Machine is on
    if (this.storyOpen) this.closeStory();
    this.pushDebugger();
    this.pushEntries();
    this.scheduleRender(true);
    this.panes.navChanged();
    this.onChange();
  }

  goto(step: number): void {
    const trace = this.trace;
    if (!trace || !this.nav.active) return;
    const clamped = trace.clamp(step);
    if (clamped < 0) return;
    this.nav.step = clamped;
    this.nav.selectedFrame = 0;
    this.pushDebugger();
    this.pushEntries();
    this.showStep(clamped);
    this.panes.navChanged();
    this.onChange();
  }

  /** One recorded event forward (the Step button, `ctl step next`); false at the last one. */
  next(): boolean {
    const trace = this.trace;
    if (!trace || !this.nav.active || !trace.valid(this.nav.step + 1)) return false;
    this.goto(this.nav.step + 1);
    return true;
  }

  /** Move like the toolbar; false when there is nowhere to go. */
  move(kind: MoveKind): boolean {
    const trace = this.trace;
    if (!trace || !this.nav.active) return false;
    const i = this.nav.step;
    const next = kind === 'into' ? trace.stepInto(i)
      : kind === 'back' ? trace.stepBackInto(i)
      : kind === 'over' ? trace.stepOver(i)
      : kind === 'backOver' ? trace.stepBackOver(i)
      : kind === 'out' ? trace.stepOut(i)
      : trace.stepBackOut(i);
    if (next < 0) return false;
    this.goto(next);
    return true;
  }

  private debuggerAction(action: Extract<WebviewToHost, { type: 'debugger.action' }>['action']): void {
    switch (action) {
      case 'start':
        this.start({ line: this.code.cursorLine() });
        return;
      case 'stop':
        this.stop();
        return;
      case 'stepInto':
        this.move('into');
        return;
      case 'stepBackInto':
        this.move('back');
        return;
      case 'stepOver':
        this.move('over');
        return;
      case 'stepBackOver':
        this.move('backOver');
        return;
      case 'stepOut':
        this.move('out');
        return;
      case 'stepBackOut':
        this.move('backOut');
        return;
      case 'runToLine':
      case 'runBackToLine': {
        const trace = this.trace;
        const line = this.code.cursorLine();
        const fileId = this.shownFileId();
        if (!trace || line === undefined || fileId === undefined) return;
        const next = action === 'runToLine' ? trace.runToLine(this.nav.step, fileId, line) : trace.runBackToLine(this.nav.step, fileId, line);
        if (next >= 0) this.goto(next);
        return;
      }
      case 'autoPlay':
        this.autoPlay();
        return;
      case 'pause':
        this.stopAutoPlay();
        this.pushDebugger();
        return;
      case 'toggleCallStack':
        this.nav.showCallStack = !this.nav.showCallStack;
        this.pushDebugger();
        return;
      case 'toggleEcho':
        this.nav.echo = !this.nav.echo;
        this.pushDebugger();
        return;
      case 'toggleCodePreview':
        this.nav.codePreview = !this.nav.codePreview;
        this.pushDebugger();
        return;
    }
  }

  private autoPlay(): void {
    if (!this.nav.active && !this.start()) return;
    this.stopAutoPlay();
    this.nav.autoPlaying = true;
    this.autoPlayTimer = setInterval(() => {
      if (!this.move('into')) {
        this.stopAutoPlay();
        this.pushDebugger();
      }
    }, 350);
    this.pushDebugger();
  }

  private stopAutoPlay(): void {
    if (this.autoPlayTimer) clearInterval(this.autoPlayTimer);
    this.autoPlayTimer = undefined;
    this.nav.autoPlaying = false;
  }

  private selectFrame(index: number): void {
    const trace = this.trace;
    if (!trace || !this.nav.active) return;
    const frame = trace.callStack(this.nav.step)[index];
    if (!frame) return;
    this.nav.selectedFrame = index;
    this.pushDebugger();
    this.ensureFileShown(frame.fileId);
    this.code.reveal(frame.line);
  }

  /** Show the step's file in the code pane, scroll to it and redraw. */
  private showStep(step: number): void {
    const loc = this.trace?.location(step);
    if (!loc) return;
    this.ensureFileShown(loc.fileId);
    this.scheduleRender(true);
    this.code.reveal(loc.range[0]);
  }

  /* ---------- the code pane ---------- */

  private wantPath: string | undefined;

  private sourceOf(fileId: number): string | undefined {
    const path = this.run?.files.get(fileId)?.path;
    if (!path) return undefined;
    if (this.main && path === this.main.path) return this.run!.content;
    return this.sources.get(path);
  }

  shownFileId(): number | undefined {
    const shown = this.code.shownPath();
    return shown ? this.run?.files.byPath(shown)?.fileId : undefined;
  }

  /** Switch the code pane to `fileId`'s source, asking the bridge for it the first time. */
  private ensureFileShown(fileId: number): void {
    const path = this.run?.files.get(fileId)?.path;
    if (!path || this.code.shownPath() === path) return;
    if (this.main && path === this.main.path) {
      this.code.showFile(this.main, { keepDirty: true });
      return;
    }
    const content = this.sources.get(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    if (content !== undefined) this.code.showFile({ path, displayName: name, language: this.main?.language ?? 'plaintext', content });
    else {
      this.wantPath = path;
      this.link.send({ type: 'file.read', path });
    }
  }

  openLocation(fileId: number, line: number, file?: string): void {
    if (fileId < 0 && file) {
      // the Debugger view names files by display path: it has no run table of its own here
      const dir = this.main ? this.main.path.slice(0, this.main.path.length - this.main.displayName.length) : '';
      this.revealPath(file.startsWith('/') ? file : dir + file, line);
      return;
    }
    this.ensureFileShown(fileId);
    this.code.reveal(line);
  }

  /** Show `path` (the main file, a file of a run, the HTTP recording) and scroll to `line`. */
  revealPath(path: string, line: number): void {
    if (this.main && path === this.main.path) {
      if (this.code.shownPath() !== path) this.code.showFile(this.main, { keepDirty: true });
    } else if (this.code.shownPath() !== path) {
      const content = this.sources.get(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      if (content !== undefined) this.code.showFile({ path, displayName: name, language: languageOf(path, this.main?.language), content });
      else {
        this.wantPath = path;
        this.wantLine = line;
        this.link.send({ type: 'file.read', path });
        return;
      }
    }
    this.scheduleRender(true);
    this.code.reveal(line);
  }

  private wantLine: number | undefined;

  /** The lines of a file of the run, asking the bridge for them the first time (undefined after 5 s). */
  fetchSource(fileId: number): Promise<string[] | undefined> {
    const have = this.sourceOf(fileId);
    if (have !== undefined) return Promise.resolve(have.split(/\r?\n/));
    const path = this.run?.files.get(fileId)?.path;
    if (!path) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const list = this.sourceWaiters.get(path) ?? [];
      const t = setTimeout(() => resolve(undefined), 5000);
      list.push((content) => {
        clearTimeout(t);
        resolve(content?.split(/\r?\n/));
      });
      this.sourceWaiters.set(path, list);
      this.link.send({ type: 'file.read', path });
    });
  }

  showMain(): void {
    if (this.main) this.code.showFile(this.main, { keepDirty: true });
    this.scheduleRender(true);
  }

  scheduleRender(now = false): void {
    if (now) {
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.render();
      return;
    }
    if (!this.renderTimer) this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 50);
  }

  /** The decorations of the file the code pane shows, as of the Time Machine step when it is on. */
  decorations(): CodeDecorations {
    const out: CodeDecorations = { inline: new Map(), coverage: new Map(), current: null, callers: [], errors: new Map(), breakpoints: new Map(), paused: null };
    const shown = this.code.shownPath();
    if (shown) {
      out.breakpoints = this.debug.breakpointsOf(shown);
      const p = this.debug.paused;
      if (p && p.line && this.debug.pathOf(p.fileId) === shown) out.paused = p.line;
      const values = this.pausedValues(shown);
      if (values) out.liveValues = values;
      const history = this.debug.active ? this.historyOf(shown) : [];
      if (history.length) out.history = history;
    }
    const run = this.run;
    const fileId = this.shownFileId();
    if (!run || fileId === undefined) return out;
    const file = run.files.get(fileId);
    const cov = run.coverage.get(fileId);
    if (file && cov) {
      for (const local of file.statements) {
        const r = file.ranges[local];
        const s = cov.states[local];
        if (!r || s === undefined || s === 5) continue;
        const prev = out.coverage.get(r[0]);
        if (prev === undefined || rank(s) > rank(prev)) out.coverage.set(r[0], s);
      }
    }
    for (const e of this.visibleLogs()) {
      if (e.fileId !== fileId) continue;
      const line = e.liveLine ?? run.files.locate(e.rid)?.range[0];
      if (!line) continue;
      out.inline.set(line, e.context && e.kind === 'value' ? `${e.context} = ${e.text}` : e.text);
    }
    for (const e of run.errors) {
      if (e.handled || (this.nav.active && e.step > this.nav.step)) continue;
      const loc = run.files.locate(e.rid);
      if (loc && loc.fileId === fileId) out.errors.set(loc.range[0], `${e.errorType}: ${e.message}`);
    }
    const trace = run.trace;
    // a live debug run owns the current line while it runs: the Time Machine's would read as a second one
    if (this.nav.active && trace && trace.valid(this.nav.step) && !this.debug.active) {
      const loc = trace.location(this.nav.step);
      if (loc && loc.fileId === fileId) out.current = { line: loc.range[0], col: loc.range[1] };
      // the variables recorded at this step were changed by the statement before it: show them there
      const changes = run.locals.find((l) => l.step === this.nav.step)?.changes;
      const prev = trace.location(this.nav.step - 1) ?? loc;
      if (changes?.length && prev && prev.fileId === fileId) out.inline.set(prev.range[0], changes.map((c) => `${c.name} = ${c.text}`).join(', '));
      for (const f of trace.callStack(this.nav.step).slice(1)) if (f.fileId === fileId) out.callers.push(f.line);
    }
    return out;
  }

  /* ---------- the Code Story ---------- */

  /** the story the panel shows (rebuilt when the run changes) */
  private story: StoryModel | null = null;
  /** the panel shows the CODE STORY view: it follows the Time Machine step */
  private storyOpen = false;
  /** the last story sent to the panel, so an unchanged one is not sent again */
  private storySent = '';

  storyShown(): boolean {
    return this.storyOpen;
  }

  /** Show the Code Story in the right panel, starting the Time Machine at the cursor first (D2); the code pane keeps its file. */
  async openStory(): Promise<boolean> {
    if (!this.nav.active && !this.start({ line: this.code.cursorLine() })) {
      if (!this.trace) this.notice('the Code Story needs a recorded run: run the file first', 'info');
      return false;
    }
    const run = this.run;
    if (!run?.trace) return false;
    // every file the trace ran in, so blocks of other modules list their source too
    const ids = new Set<number>();
    for (let i = 0; i < run.trace.count; i++) {
      const id = run.trace.location(i)?.fileId;
      if (id !== undefined) ids.add(id);
      if (ids.size > 50) break;
    }
    await Promise.all([...ids].map((id) => this.fetchSource(id)));
    if (this.run !== run) return false;
    this.showStory();
    return true;
  }

  private showStory(): void {
    const run = this.run;
    if (!run) return;
    if (!this.story || this.story.runId !== run.runId) this.story = buildStory(run, (id) => this.sourceOf(id)?.split(/\r?\n/) ?? []);
    this.storyOpen = true;
    this.storySent = '';
    this.pushStory();
    this.post({ type: 'showView', view: 'story' });
    this.onChange();
  }

  /** D2: the Time Machine stopped, so the story leaves the panel (the view goes back to OUTPUT). */
  private closeStory(): void {
    this.storyOpen = false;
    this.storySent = '';
    this.post({ type: 'story', story: null });
  }

  /** Send the panel the story as of the Time Machine step: the rows, the step's box, dim columns, values. */
  private pushStory(): void {
    const run = this.run;
    if (!run || !this.story) return;
    // a new run: rebuild the story in place once it finished (its sources are the ones already fetched)
    if (this.story.runId !== run.runId) {
      if (!run.trace || run.running) return;
      this.story = buildStory(run, (id) => this.sourceOf(id)?.split(/\r?\n/) ?? []);
    }
    const m = this.story;
    const rows = m.text.split('\n');
    if (rows.length > m.lines.length && rows[rows.length - 1] === '') rows.pop();
    const paint = paintStory(m, run, rows, this.nav.active ? this.nav.step : undefined);
    const picks: number[] = [];
    m.lines.forEach((l, i) => {
      if (storyTarget(m, i + 1)) picks.push(i + 1);
    });
    const story: StoryPanel = { runId: m.runId, rows, picks, current: paint.current, dim: paint.dim, values: [...paint.values].map(([line, v]) => ({ line, text: v.text, error: v.error })) };
    const sent = JSON.stringify(story);
    if (sent === this.storySent) return;
    this.storySent = sent;
    this.post({ type: 'story', story });
  }

  /** The story as an agent reads it: the text (up to 400 rows) and the Time Machine step's row. */
  storyText(): { text: string; rows: number; step: number | null; row: number | null } {
    const m = this.story;
    if (!m || !this.run) return { text: '', rows: 0, step: null, row: null };
    const lines = m.text.split('\n');
    const cur = this.nav.active ? storyRowOf(m, this.run, this.nav.step) : undefined;
    return { text: lines.slice(0, 400).join('\n'), rows: lines.length - 1, step: this.nav.active ? this.nav.step : null, row: cur ? cur.row + 1 : null };
  }

  /** A story row was picked (a click in the panel): go to the step that ran it; `open` shows the source in the code pane. */
  storyPick(line: number, open = false): void {
    const t = this.story ? storyTarget(this.story, line) : undefined;
    if (!t) return;
    if (open) {
      this.openLocation(t.fileId, t.line);
      return;
    }
    if (t.step !== undefined && this.nav.active && t.step !== this.nav.step) this.goto(t.step);
  }

  /* ---------- profile, instrumented source, recent files ---------- */

  /** Run once under the runtime's profiler; the bridge answers with `profile`, shown as a table. */
  profile(): void {
    const content = this.code.dirtyContent?.();
    this.link.send({ type: 'profile', ...(content === undefined ? {} : { content }) });
    this.notice(`profiling ${this.main?.displayName ?? 'the file'}…`, 'info');
  }

  /** the last profile, as the bridge summarized it */
  lastProfile: BridgeProfile | null = null;
  /** rows of a made-up document that open a source line (Ctrl/Cmd+click): path -> line -> where */
  private readonly lineTargets = new Map<string, Map<number, { path: string; line: number }>>();

  private readonly profileWaiters: ((p: BridgeProfile) => void)[] = [];

  /** Profile, resolved with the bridge's answer. */
  profileRun(): Promise<BridgeProfile> {
    return new Promise((resolve) => {
      this.profileWaiters.push(resolve);
      this.profile();
    });
  }

  private onProfile(p: BridgeProfile): void {
    this.lastProfile = p;
    for (const w of this.profileWaiters.splice(0)) w(p);
    if (p.error || !p.summary) {
      this.notice(`Profile: ${p.error ?? 'no profile'}`, 'error');
      return;
    }
    const dir = this.main ? this.main.path.slice(0, this.main.path.length - this.main.displayName.length) : '';
    const shortPath = (f: string) => (dir && f.startsWith(dir) ? f.slice(dir.length) : f);
    const targets = new Map<number, { path: string; line: number }>();
    p.summary.rows.forEach((r, i) => {
      if (r.file) targets.set(i + 3, { path: r.file, line: r.line });
    });
    this.lineTargets.set(PROFILE_PATH, targets);
    this.code.showFile({ path: PROFILE_PATH, displayName: 'Profile', language: 'plaintext', content: renderProfile(p.summary, this.main?.displayName ?? 'the file', shortPath) + (p.path ? `# the .cpuprofile (Chrome DevTools, VS Code): /api/profile\n` : '') });
    this.scheduleRender(true);
  }

  /** a row of a made-up document was picked: the story moves the Time Machine, the profile opens the source */
  linePick(path: string, line: number, how: 'select' | 'open'): void {
    if (path === STORY_PATH) {
      this.storyPick(line, how === 'open');
      return;
    }
    const t = this.lineTargets.get(path)?.get(line);
    if (t && how === 'open') this.revealPath(t.path, t.line);
  }

  /** the bridge's answer to View Recent Files (main.tsx shows the list) */
  /** the Scratchpad (web/scratchpad.ts), set by main.tsx; the agent's `scratchpad` commands go here */
  onScratchpad?: (command: import('./scratchpadProtocol').ScratchCommand) => Promise<import('./scratchpadProtocol').ScratchState>;
  onRecent: (files: RecentFile[]) => void = (files) => this.notice(files.map((f) => f.path).join('\n') || 'no recent files', 'info');

  /** Make a recent file the main one: the bridge switches, says hello again, and runs it. */
  openFile(path: string): void {
    this.link.send({ type: 'open', path });
  }

  /** The runtime's instrumented source of the shown file (the main one otherwise), read-only in the code pane. */
  async showInstrumented(): Promise<void> {
    const run = this.run;
    const fileId = this.shownFileId() ?? this.mainFileId();
    if (!run || fileId === undefined) {
      this.notice('no instrumented source yet: run the file first', 'info');
      return;
    }
    // library files come without it: the runtime serves those on demand
    let src = run.files.get(fileId)?.instrumentedSource;
    if (!src) {
      const reply = await this.link.request({ type: 'source', runId: run.runId, fileId });
      src = reply.type === 'source' ? (reply.instrumentedSource ?? undefined) : undefined;
      if (!src) {
        this.notice(reply.type === 'error' ? `could not get the instrumented source: ${reply.message}` : 'the runtime has no instrumented source for this file', 'error');
        return;
      }
    }
    const name = (run.files.get(fileId)?.path ?? 'file').split(/[\\/]/).pop();
    const path = `pyokka://instrumented/${name}`;
    this.code.showFile({ path, displayName: `${name} (instrumented)`, language: this.main?.language ?? 'plaintext', content: src });
    this.scheduleRender(true);
    this.onChange();
  }

  /** The source's lexical identities, from the runtime; null when it does not parse. Re-renders once they arrive. */
  identities(content: string): Promise<SourceIdentifiers | null> {
    let pending = this.identityCache.get(content);
    if (!pending) {
      if (this.identityCache.size > 20) {
        this.identityCache.clear();
        this.identityKnown.clear();
      }
      pending = this.link.request({ type: 'bindings', source: content, identifiers: true }).then(
        (reply) => (reply.type === 'bindings' && reply.identifiers ? reply.identifiers : null),
        () => null,
      );
      this.identityCache.set(content, pending);
      void pending.then((ids) => {
        this.identityKnown.set(content, ids);
        this.scheduleRender();
      });
    }
    return pending;
  }

  /** The selected frame's values for the source of `path`, when the debugger is paused in it and its identities are known. */
  private pausedValues(path: string, identifiers?: SourceIdentifiers | null): PausedValues | undefined {
    const p = this.debug.paused;
    const run = this.debug.run;
    if (!p || !run) return undefined;
    const frame = p.stack[this.debug.selectedFrame];
    const line = frame?.line ?? p.line;
    if (!line || this.debug.pathOf(frame?.fileId ?? p.fileId) !== path) return undefined;
    const cached = this.debug.locals;
    if (!cached || cached.step !== p.step || cached.frameId !== this.debug.selectedFrame) return undefined;
    const content = path === this.main?.path ? run.content : this.sources.get(path);
    if (content === undefined) return undefined;
    const ids = identifiers !== undefined ? identifiers : this.identityKnown.get(content);
    if (ids === undefined) void this.identities(content);
    if (!ids) return undefined;
    return { line, content, identifiers: ids, locals: cached.locals, frameName: frame?.name ?? '<module>', snapshot: `${run.runId}:${p.step}:${this.debug.selectedFrame}` };
  }

  /** Keep the selected frame's variables of each pause of the live run, once they arrived, for the code history. */
  private recordPause(): void {
    const p = this.debug.paused;
    const run = this.debug.run;
    const cached = this.debug.locals;
    if (!p || !run || !cached || cached.step !== p.step || cached.frameId !== this.debug.selectedFrame) return;
    const frame = p.stack[this.debug.selectedFrame];
    const line = frame?.line ?? p.line;
    const path = this.debug.pathOf(frame?.fileId ?? p.fileId);
    if (!line || !path) return;
    const content = path === this.main?.path ? run.content : this.sources.get(path);
    if (content === undefined) return;
    if (this.pauseHistory?.runId !== run.runId) this.pauseHistory = { runId: run.runId, byPath: new Map() };
    const seen = this.pauseHistory.byPath.get(path) ?? new Map<string, Omit<PausedValues, 'identifiers'>>();
    const snapshot = `${run.runId}:${p.step}:${this.debug.selectedFrame}`;
    const fresh = !seen.has(snapshot);
    if (fresh) seen.set(snapshot, { line, content, locals: cached.locals, frameName: frame?.name ?? '<module>', snapshot });
    this.pauseHistory.byPath.set(path, seen);
    if (fresh) this.panes.refreshVariable();
    if (!this.identityKnown.has(content)) void this.identities(content);
  }

  /** The live run's pauses in `path`, oldest first, with their source's identities (those not known yet are left out). */
  private historyOf(path: string): PausedValues[] {
    if (!this.pauseHistory || this.pauseHistory.runId !== this.debug.run?.runId) return [];
    const out: PausedValues[] = [];
    for (const s of this.pauseHistory.byPath.get(path)?.values() ?? []) {
      const identifiers = this.identityKnown.get(s.content);
      if (identifiers) out.push({ ...s, identifiers });
    }
    return out;
  }

  /** `name` at each pause of the live run, every file's pauses in the order they happened; undefined when none had it or no debug session runs. */
  private pauseVariableHistory(name: string): VariableHistory | undefined {
    if (!this.debug.active || !this.pauseHistory || this.pauseHistory.runId !== this.debug.run?.runId) return undefined;
    const dir = this.main ? this.main.path.slice(0, this.main.path.length - this.main.displayName.length) : '';
    const pauses = [...this.pauseHistory.byPath].flatMap(([path, seen]) => [...seen.values()].map((pause) => ({ file: dir && path.startsWith(dir) ? path.slice(dir.length) : path, pause })));
    // snapshot is run:step:frame
    const stepOf = (snapshot: string) => Number(snapshot.split(':').at(-2));
    pauses.sort((a, b) => stepOf(a.pause.snapshot) - stepOf(b.pause.snapshot));
    return pauseHistory(name.trim(), pauses);
  }

  /** What the code pane shows of the pause: each shadow beside a declaration and each hover, as an agent reads it. */
  async liveValues(): Promise<{ file: string; line: number; frame: string; shadows: { line: number; text: string; hover: string }[]; hovers: { line: number; column: number; name: string; declaration: boolean; text: string }[] }> {
    const p = this.debug.paused;
    if (!p) throw new Error('values needs a live debugger pause (debug start)');
    const frame = p.stack[this.debug.selectedFrame];
    const path = this.debug.pathOf(frame?.fileId ?? p.fileId);
    if (!path) throw new Error('the selected frame has no source file');
    if (!this.debug.locals || this.debug.locals.step !== p.step) await new Promise((r) => setTimeout(r, 300));
    const content = path === this.main?.path ? this.debug.run?.content : this.sources.get(path);
    const values = content === undefined ? undefined : this.pausedValues(path, await this.identities(content));
    if (!values) throw new Error('no values for this pause yet (the frame\'s variables or the source\'s identities are missing)');
    const occurrences = pausedOccurrences(values);
    return {
      file: path,
      line: values.line,
      frame: values.frameName,
      shadows: [...inlineHistory(values.content, this.historyOf(path))].map(([line, row]) => ({ line, text: row.preview, hover: row.hover })),
      hovers: occurrences.map((o) => ({ line: o.line, column: o.start + 1, name: o.local.name, declaration: o.declaration, text: pausedHover(o.local) })),
    };
  }

  /** Where the name at line:column (1-based, UTF-16) of the main file is defined, as Cmd/Ctrl-click resolves it, and the tab it opens. */
  async definition(line: number, column: number): Promise<{ at: string; targets: { path: string; line: number; column: number; tab: string | null }[] }> {
    if (!this.main) throw new Error('no file open');
    const content = this.code.dirtyContent?.() ?? this.main.content;
    const start = lineStarts(content)[line - 1];
    if (start === undefined) throw new Error(`line ${line} is outside ${this.main.displayName}`);
    const targets = await fetchDefinitions(this.main.path, content, start + column - 1);
    return {
      at: content.slice(start, start + column - 1) + '‸' + content.slice(start + column - 1).split(/\r?\n/)[0],
      // a definition in the same file moves the cursor; any other opens in a tab
      targets: targets.map((t) => ({ path: t.path, line: t.line, column: t.column, tab: t.path === this.main!.path ? null : definitionTabUrl(t.path, t.line, t.column) })),
    };
  }

  render(): void {
    this.code.render(this.decorations());
    if (this.storyOpen) this.pushStory();
    if (this.narration && this.narration.path === this.code.shownPath()) this.code.setNarration({ text: this.narration.text, line: this.narration.line });
    else this.code.setNarration(null);
  }

  /** Show an explanation bubble under `line` of the shown file (null clears it). */
  say(text: string | null, line?: number): void {
    if (text === null) this.narration = null;
    else {
      const at = line ?? this.state().location?.line ?? 1;
      this.narration = { text, line: at, path: this.code.shownPath() ?? '' };
    }
    this.render();
    this.onChange();
  }

  /* ---------- what an agent reads ---------- */

  /** Variables of the current scope as of the step: the latest recorded change of each name. */
  localsAt(step: number): { name: string; text: string }[] {
    const run = this.run;
    const trace = run?.trace;
    if (!run || !trace || !trace.valid(step)) return [];
    const scopeId = trace.scopeId(step);
    const latest = new Map<string, string>();
    for (const l of run.locals) {
      if (l.step > step || l.scopeId !== scopeId) continue;
      for (const c of l.changes) latest.set(c.name, c.text);
    }
    return [...latest].map(([name, text]) => ({ name, text }));
  }

  state(): PageState {
    const run = this.run;
    const trace = run?.trace ?? null;
    const step = this.nav.active ? this.nav.step : null;
    let location: PageState['location'] = null;
    let code: string | null = null;
    let stack: PageState['stack'] = [];
    if (trace && step !== null && trace.valid(step)) {
      const loc = trace.location(step);
      const frames = trace.callStack(step);
      if (loc) {
        location = { file: this.displayPath(loc.fileId), line: loc.range[0], function: frames[0]?.function ?? '<module>' };
        code = (this.sourceOf(loc.fileId) ?? '').split(/\r?\n/)[loc.range[0] - 1] ?? null;
      }
      stack = frames.map((f) => ({ function: f.function, line: f.line, step: f.step }));
    }
    const d = this.debug;
    const pause = d.paused;
    const frame = pause?.stack[d.selectedFrame];
    const recordedLoc = trace && step !== null && trace.valid(step) ? trace.location(step) : undefined;
    const context: PageState['context'] = d.active
      ? {
          source: 'live',
          runId: d.run!.runId,
          running: true,
          paused: !!pause,
          step: pause?.step ?? null,
          frame: d.selectedFrame,
          file: d.pathOf(frame?.fileId ?? pause?.fileId) ?? null,
          line: frame?.line ?? pause?.line ?? null,
          localsReady: !!pause && d.locals?.step === pause.step && d.locals.frameId === d.selectedFrame,
          locals: d.state()?.locals.map((v) => ({ name: v.name, text: v.text })) ?? [],
        }
      : {
          source: 'recording',
          runId: run?.runId ?? null,
          running: !!this.incoming || !!run?.running,
          paused: this.nav.active,
          step,
          frame: 0,
          file: recordedLoc ? (run?.files.get(recordedLoc.fileId)?.path ?? null) : (this.main?.path ?? null),
          line: recordedLoc?.range[0] ?? null,
          localsReady: step !== null,
          locals: step === null ? [] : this.localsAt(step),
        };
    return {
      context,
      shownFile: this.code.shownPath() ?? null,
      runId: run?.runId ?? null,
      running: !!this.incoming || !!run?.running,
      file: this.main?.path ?? '',
      steps: trace?.count ?? 0,
      timeMachine: this.nav.active,
      step,
      location,
      code,
      locals: step === null ? [] : this.localsAt(step),
      stack,
      values: this.visibleLogs().slice(-200).map((e) => ({ line: e.liveLine ?? run?.files.locate(e.rid)?.range[0] ?? 0, ...(e.context ? { context: e.context } : {}), text: e.text, step: e.step })),
      output: (run?.output ?? '').slice(-4000),
      errors: (run?.errors ?? []).filter((e) => !e.handled).map((e) => ({ type: e.errorType, message: e.message, line: run?.files.locate(e.rid)?.range[0] ?? 0 })),
      narration: this.narration ? { text: this.narration.text, line: this.narration.line } : null,
    };
  }
}

const LANGUAGE_BY_EXT: Record<string, string> = { py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', json: 'json', jsonl: 'json' };

/** The Monaco language of a file the page opens: by extension, else the main file's. */
function languageOf(path: string, fallback = 'plaintext'): string {
  return LANGUAGE_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? fallback;
}

/** Coverage states ranked so the worst one on a line wins. */
function rank(state: number): number {
  return state === 3 ? 4 : state === 4 ? 3 : state === 2 ? 2 : state === 1 ? 1 : 0;
}

/** `Python 3.13.1`, from the runtime's `ready`. */
export function runtimeLabelText(ready: RuntimeInfo['ready']): string {
  if (!ready) return 'starting…';
  if (ready.pythonVersion) return `Python ${ready.pythonVersion.split(' ')[0]}`;
  return ready.runtimeVersion ?? '';
}
