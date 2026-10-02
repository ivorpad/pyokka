/**
 * `pyokka.output` WebviewViewProvider: HTML shell, state forwarding per webviewProtocol.ts,
 * and handling of every WebviewToHost message.
 */
import * as vscode from 'vscode';
import type { ExceptionsPanel, HostToWebview, PanelEntry, PanelMoment, PanelSettings, ViewId, WalkthroughPanel, WebviewToHost } from '../shared/webviewProtocol';
import type { LogEvent } from '../shared/protocol';
import type { Session, SessionEvents } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import type { TimeMachine, TimeMachineSink } from '../timeMachine/navigator';
import type { Narrator } from '../features/narrator';
import type { TourHost } from './tourPane';
import { applySettingsPatch, currentTheme, debuggerAction, defaultSettings, diagramSettings, entryText, entryTitle, openLocation, panelHtml } from './panelSupport';
import { VariablePaneHost } from './variablePane';
import { HttpPaneHost } from './httpPane';
import { WhyPaneHost } from './whyPane';
import { DebugPanelHost } from './debugPanel';
import { DebuggerViewHost } from './debuggerView';
import { GraphPaneHost } from './graphPane';
import type { GraphProvider } from '../features/executionGraph';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { setContext } from '../util/context';
import { buildExceptionReport, type ExceptionSite } from '../session/exceptionReport';
import { walkthroughInputs } from '../agent/bridgeSupport';
import { setting } from '../config/settings';
import { log } from '../util/log';

export const OUTPUT_VIEW_ID = 'pyokka.output';

export class OutputPanel implements vscode.WebviewViewProvider, TimeMachineSink, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private queue: HostToWebview[] = [];
  private bound: Session | undefined;
  private boundDisposers: (() => void)[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private pendingShowOnStart = false;
  /** the view the webview last reported showing (`pyokka.panelView`); the e2e suite reads it */
  activeView: ViewId | undefined;
  private entriesTimer: NodeJS.Timeout | undefined;
  private narrator: Narrator | undefined;
  /** the TOUR section: `pyokka tour` of the bound session's run, computed while the section is open */
  private tour: TourHost | undefined;
  /** the Variable pane's query for the bound session, recomputed after every run */
  private readonly variable = new VariablePaneHost((s, msg) => this.post(s, msg));
  /** the HTTP view's table for the bound session, rebuilt as rows arrive */
  private readonly http = new HttpPaneHost((s, msg) => this.post(s, msg));
  /** the Details pane's "why" tree for the bound session, recomputed after every run until the pane closes it */
  private readonly why = new WhyPaneHost((s, msg) => this.post(s, msg));
  private readonly debug = new DebugPanelHost((s, msg) => this.post(s, msg), (s) => this.pushDebugger(s));
  /** the Debugger view: one live `record: false` session, independent of the bound run-all session */
  private debugView: DebuggerViewHost | undefined;
  /** observers of everything posted, for the e2e suite; empty in a real window */
  private readonly taps = new Set<(msg: HostToWebview) => void>();
  /** the Execution Diagram view: its graph (built when `pyokka.diagram.build` says), the story phases, the call stack, unrolling, hits */
  private readonly graph = new GraphPaneHost((s, msg) => this.post(s, msg));

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SessionManager,
    private readonly timeMachine: TimeMachine,
  ) {
    timeMachine.setSink(this);
    manager.on('activeChanged', (s) => this.bind(s));
    manager.on('sessionStarted', (s) => {
      if (setting<boolean>('showOutputOnStart', true, s.document.uri)) this.show(true);
      this.bind(s);
    });
    manager.on('sessionStopped', () => this.bind(manager.active()));
    this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => this.post({ type: 'theme', theme: currentTheme() })));
    // the diagram settings are user settings with no session value: a change re-sends them and the graph they shape
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('pyokka.diagram')) return;
        this.post({ type: 'settings', settings: this.bound ? this.settings(this.bound) : defaultSettings() });
        if (this.bound) this.graph.afterRun(this.bound);
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.debugView?.dispose();
    this.unbind();
  }

  /** The Debugger's registry: its view is bound to the window, not to a run-all session. */
  setDebugSessions(manager: DebugSessionManager): void {
    this.debugView = new DebuggerViewHost(manager, (msg) => this.post(msg));
  }

  /** The last `debug.session` state the panel pushed (the e2e suite cannot see inside the webview). */
  debugPanelState(): import('../shared/webviewProtocol').DebugSessionPanel | null {
    return this.debugView?.state() ?? null;
  }

  /**
   * Every message the panel posts, for the e2e suite. `debugPanelState()` shows the state a spec
   * could ask for at any time; the output deltas are only observable as they go past, and whether
   * they chain is the whole contract (docs/design/debugger-product.md, 5.6).
   */
  onPost(fn: (msg: HostToWebview) => void): vscode.Disposable {
    this.taps.add(fn);
    return new vscode.Disposable(() => this.taps.delete(fn));
  }

  /** The narrator builds the WALKTHROUGH section and answers its Narrate button. */
  setNarrator(narrator: Narrator): void {
    this.narrator = narrator;
    narrator.onChange((s) => this.pushWalkthrough(s));
  }

  /** The tour host computes the TOUR section and answers its clicks and Narrate Tour. */
  setTour(tour: TourHost): void {
    this.tour = tour;
    this.manager.on('sessionStopped', (s) => tour.forget(s));
  }

  /** The graph provider builds the Execution Diagram view's graph and follows the Time Machine for its call stack. */
  setGraphProvider(provider: GraphProvider): void {
    this.graph.setProvider(provider);
    provider.onChange((s) => this.graph.push(s));
    provider.onStack((s) => this.graph.stack(s));
  }

  /* ---------- view lifecycle ---------- */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webview.html = panelHtml(this.context, webview);
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
    webview.onDidReceiveMessage((msg: WebviewToHost) => void this.onMessage(msg).catch((err) => log.error(`panel message ${msg?.type} failed`, err)));
  }

  /* ---------- outbound ---------- */

  post(_session: Session | undefined, msg?: HostToWebview): void;
  post(msg: HostToWebview): void;
  post(a: Session | HostToWebview | undefined, b?: HostToWebview): void {
    const msg = b ?? (a as HostToWebview | undefined);
    if (!msg) return;
    if (b && a && a !== this.bound) return; // message for a session that is not displayed
    for (const tap of this.taps) tap(msg);
    if (this.view && this.ready) void this.view.webview.postMessage(msg);
    else {
      this.queue.push(msg);
      if (this.queue.length > 5000) this.queue.splice(0, this.queue.length - 5000);
    }
  }

  show(preserveFocus: boolean): void {
    if (!this.view) this.pendingShowOnStart = true;
    void vscode.commands.executeCommand(`${OUTPUT_VIEW_ID}.focus`, { preserveFocus }).then(undefined, () => undefined);
    if (this.view && preserveFocus) this.view.show(true);
  }

  showView(view: ViewId, preserveFocus = true): void {
    this.show(preserveFocus);
    this.post({ type: 'showView', view });
  }

  /* ---------- session binding ---------- */

  private unbind(): void {
    for (const d of this.boundDisposers) d();
    this.boundDisposers = [];
    this.bound = undefined;
    this.variable.reset();
    this.http.reset();
    this.why.reset();
  }

  bind(session: Session | undefined): void {
    if (session === this.bound && session) return;
    this.unbind();
    this.bound = session;
    if (!session) {
      this.post({ type: 'init', theme: currentTheme(), settings: defaultSettings(), sessionName: null });
      this.post({ type: 'entries.reset' });
      this.post({ type: 'timeline', model: null });
      this.post({ type: 'walkthrough', walkthrough: null });
      this.post({ type: 'tour', tour: null });
      this.post({ type: 'exceptions', report: null });
      this.post({ type: 'executionGraph', graph: null });
      this.post({ type: 'http', panel: null });
      return;
    }
    const on = <K extends keyof SessionEvents>(ev: K, fn: (...args: SessionEvents[K]) => void): void => {
      session.on(ev, fn as never);
      this.boundDisposers.push(() => session.off(ev, fn as never));
    };
    on('runStarted', () => {
      this.post({ type: 'entries.reset' });
      this.post({ type: 'errors', errors: [] });
      this.postSession();
    });
    on('log', (ev) => this.queueEntry(session, ev));
    on('error', () => this.postErrors());
    on('output', (ev) => this.post({ type: 'output', stream: ev.stream, text: ev.text }));
    on('statusChanged', () => this.postSession());
    on('runFinished', () => {
      this.flushEntries();
      this.postSession();
      this.postErrors();
      this.pushWalkthrough(session);
      this.tour?.afterRun(session);
      this.pushExceptions(session);
      void this.variable.refresh(session);
      void this.why.refresh(session);
      this.graph.afterRun(session);
      this.http.push(session);
    });
    on('runStarted', () => {
      this.post({ type: 'walkthrough', walkthrough: null });
      this.tour?.runStarted(session);
      this.post({ type: 'exceptions', report: null });
      this.post({ type: 'executionGraph', graph: null });
      this.http.push(session); // the new run's rows start empty
    });
    on('http', () => this.http.schedule(session));
    on('settingsChanged', () => {
      this.post({ type: 'settings', settings: this.settings(session) });
      this.http.push(session);
    });
    on('stateChanged', () => this.scheduleEntries(session));
    on('trace', () => this.pushTimeline(session));
    this.debug.bind(session, on);
    this.resync();
  }

  private resync(): void {
    const s = this.bound;
    this.post({ type: 'init', theme: currentTheme(), settings: s ? this.settings(s) : defaultSettings(), sessionName: s?.displayName ?? null });
    this.debugView?.push();
    if (!s) return;
    this.postSession();
    this.pushEntries(s);
    this.postErrors();
    this.pushTimeline(s);
    this.pushDebugger(s);
    this.pushWalkthrough(s);
    this.tour?.afterRun(s);
    this.pushExceptions(s);
    void this.variable.refresh(s);
    void this.why.refresh(s);
    this.graph.afterRun(s);
    this.http.push(s);
  }

  private settings(s: Session): PanelSettings {
    return { ...diagramSettings(), autoLog: s.autoLog, valuePeek: s.valuePeek, showValueOnSelection: s.showValueOnSelection, showSingleInlineValue: s.showSingleInlineValue, runMode: s.runMode, libraryCode: s.libraryCode, maskSecrets: s.maskSecrets, runTimeoutMs: s.runTimeoutMs, recordLocals: s.recordLocals, http: s.http };
  }

  /** Show the Variable pane for `name` (the Show Variable History command); the pane keeps following the session's runs. */
  async showVariable(session: Session, name: string): Promise<void> {
    this.bind(session);
    this.showView('variable');
    await this.variable.query(session, name);
  }

  /** Show the Output view with the TOUR section open (the Show Tour command); the section computes the tour. */
  showTour(session: Session): void {
    this.bind(session);
    this.showView('output');
    this.post({ type: 'tour.reveal' });
    this.tour?.setOpen(session, true);
  }

  /** Show the HTTP view (the Show HTTP Requests command); it keeps following the session's runs. */
  showHttp(session: Session): void {
    this.bind(session);
    this.showView('http');
    this.http.push(session);
  }

  /** Show the "why" tree of the value `name` had after `step` (the Why This Value command; an empty name explains the statement). */
  async showWhy(session: Session, step: number, name: string): Promise<void> {
    this.bind(session);
    this.showView('output');
    await this.why.query(session, step, name);
  }

  private postSession(): void {
    const s = this.bound;
    if (!s) return;
    const finished = s.state.finished;
    this.post({ type: 'session', name: s.displayName, running: s.running, durationMs: finished?.durationMs, runMode: s.runMode, timedOutMs: finished?.timedOut ? finished.durationMs : undefined, replayed: finished?.replayed });
  }

  private postErrors(): void {
    const s = this.bound;
    if (!s) return;
    const errors = s.state.errors.map((e) => {
      const loc = s.locate(e.rid);
      return { ...e, file: s.displayPath(e.fileId), line: loc?.range[0] ?? e.stack[0]?.line ?? 0, col: loc?.range[1] ?? 0 };
    });
    this.post({ type: 'errors', errors });
  }

  private pendingEntries: LogEvent[] = [];

  private queueEntry(session: Session, ev: LogEvent): void {
    if (session.nav.active && ev.step > session.nav.currentStep) return;
    if (!session.isEntryVisible(ev)) return;
    this.pendingEntries.push(ev);
    if (this.pendingEntries.length >= 200) this.flushEntries();
    else if (!this.entriesTimer) this.entriesTimer = setTimeout(() => this.flushEntries(), 30);
  }

  private flushEntries(): void {
    if (this.entriesTimer) clearTimeout(this.entriesTimer);
    this.entriesTimer = undefined;
    const s = this.bound;
    if (!s || !this.pendingEntries.length) {
      this.pendingEntries = [];
      return;
    }
    const batch = this.pendingEntries;
    this.pendingEntries = [];
    this.post({ type: 'entries.append', entries: batch.map((e) => this.toPanelEntry(s, e)) });
  }

  private entriesResyncTimer: NodeJS.Timeout | undefined;
  private scheduleEntries(session: Session): void {
    // marker edits can hide entries; resync lazily
    if (this.entriesResyncTimer) return;
    this.entriesResyncTimer = setTimeout(() => {
      this.entriesResyncTimer = undefined;
      if (this.bound === session && !session.running) this.pushEntries(session);
    }, 250);
  }

  toPanelEntry(s: Session, e: LogEvent): PanelEntry {
    const loc = s.locate(e.rid);
    return {
      logId: e.logId,
      kind: e.kind,
      fileId: e.fileId,
      file: s.displayPath(e.fileId),
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

  /* ---------- TimeMachineSink ---------- */

  pushEntries(session: Session): void {
    if (session !== this.bound) return;
    this.pendingEntries = [];
    let entries = session.visibleEntries();
    if (session.nav.active) entries = entries.filter((e) => e.step <= session.nav.currentStep);
    entries = entries.concat(session.pinnedEntries);
    this.post({ type: 'entries.reset' });
    for (let i = 0; i < entries.length; i += 500) this.post({ type: 'entries.append', entries: entries.slice(i, i + 500).map((e) => this.toPanelEntry(session, e)) });
  }

  pushTimeline(session: Session): void {
    if (session !== this.bound) return;
    this.post({ type: 'timeline', model: session.trace ? session.trace.toTimelineModel() : null });
  }

  pushDebugger(session: Session): void {
    if (session !== this.bound) return;
    this.post({ type: 'debugger', state: { ...this.timeMachine.debuggerState(session), debug: this.debug.fields(session) } });
  }

  /** The WALKTHROUGH section: the moments of the last run with any cached glosses. */
  pushWalkthrough(session: Session): void {
    if (session !== this.bound || !this.narrator) return;
    if (session.running || !session.state.finished) return; // `runStarted` cleared it; the next `runFinished` fills it
    const w = this.narrator.walkthrough(session);
    if (!w) {
      this.post({ type: 'walkthrough', walkthrough: null });
      return;
    }
    const moments: PanelMoment[] = w.moments.map((m) => ({ id: m.id, kind: m.kind, step: m.step, fileId: m.location.fileId, file: session.displayPath(m.location.fileId), line: m.location.line, function: m.location.function, text: m.text, values: m.values, gloss: m.gloss, more: m.more, entryStep: m.entryStep, endStep: m.endStep }));
    const panel: WalkthroughPanel = { runId: session.state.runId, count: w.count, total: w.total, shown: w.shown, truncated: w.truncated, moments, narrating: this.narrator.isNarrating(session), narrationError: this.narrator.lastError(session), canNarrate: this.narrator.canNarrate() };
    this.post({ type: 'walkthrough', walkthrough: panel });
  }

  /** The EXCEPTIONS section: every exception of the last run with display paths; null while a run is in flight. */
  pushExceptions(session: Session): void {
    if (session !== this.bound) return;
    const inputs = session.running || !session.state.finished ? undefined : walkthroughInputs(session);
    if (!inputs) {
      this.post({ type: 'exceptions', report: null });
      return;
    }
    const report = buildExceptionReport(inputs);
    const shown = <T extends ExceptionSite>(site: T): T => ({ ...site, file: session.displayPath(site.fileId) });
    const rows = report.rows.map((r) => ({ ...r, raisedAt: shown(r.raisedAt), handledAt: r.handledAt ? shown(r.handledAt) : null }));
    const panel: ExceptionsPanel = { ...report, file: report.file ? session.displayName : null, rows, runId: session.state.runId };
    this.post({ type: 'exceptions', report: panel });
  }

  /** The Execution Diagram view: build the graph of the last run and send it (the Show Execution Diagram command; the view otherwise asks for it, `pyokka.diagram.build`). */
  pushExecutionGraph(session: Session): void {
    this.graph.push(session);
  }

  /** Open the Compare (diff) view for two entries of `session`. */
  compareEntries(session: Session, leftLogId: string, rightLogId: string): boolean {
    const left = session.state.entriesById.get(leftLogId);
    const right = session.state.entriesById.get(rightLogId);
    if (!left || !right) return false;
    this.post({ type: 'diff', left: { title: entryTitle(session, left), text: entryText(left) }, right: { title: entryTitle(session, right), text: entryText(right) } });
    this.post({ type: 'showView', view: 'diff' });
    return true;
  }

  selectEntries(session: Session, logIds: string[]): void {
    this.bind(session);
    this.showView('output');
    // an entry pushEntries does not list (live / shadow, or a transient marker's): pin it so the webview has it
    let pinned = false;
    for (const id of logIds) {
      const e = session.state.entriesById.get(id);
      if (e && !session.pinnedEntries.includes(e) && !(session.state.entries.includes(e) && session.isEntryVisible(e))) {
        session.pinEntry(e);
        pinned = true;
      }
    }
    if (pinned) this.pushEntries(session);
    this.post({ type: 'entries.select', logIds });
  }

  /* ---------- inbound ---------- */

  /** Move the Time Machine to `step`, starting it first (a walkthrough moment, a tour stop, a scrubber). */
  private async gotoStep(s: Session, step: number): Promise<void> {
    if (!s.nav.active) await this.timeMachine.start(s);
    this.timeMachine.goto(s, step);
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    const s = this.bound;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.resync();
        for (const m of this.queue.splice(0)) void this.view?.webview.postMessage(m);
        if (this.pendingShowOnStart) {
          this.pendingShowOnStart = false;
        }
        return;
      case 'viewChanged':
        this.activeView = msg.view;
        setContext('panelView', msg.view);
        return;
      case 'debug.selectFrame':
      case 'debug.watch.add':
      case 'debug.watch.edit':
      case 'debug.watch.remove':
      case 'debug.breakpoint.remove':
      case 'debug.exceptions':
      case 'debug.control':
        await this.debugView?.handle(msg);
        return;
      case 'openLocation':
        await openLocation(s, msg);
        return;
      case 'expand': {
        if (!s) return;
        try {
          const node = await s.runner.expand(s.state.runId, msg.valueId, msg.queryPath);
          this.post({ type: 'value', requestId: msg.requestId, node });
        } catch (err) {
          this.post({ type: 'value', requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        return;
      case 'command':
        await vscode.commands.executeCommand(msg.command, ...(msg.args ?? []));
        return;
      case 'settings.update':
        await applySettingsPatch(s, msg);
        if (s) this.post({ type: 'settings', settings: this.settings(s) });
        return;
      case 'variable.query':
        if (s) await this.variable.query(s, msg.name);
        return;
      case 'why.query':
        if (s) await this.why.query(s, msg.step, msg.name, msg.logId);
        return;
      case 'why.close':
        this.why.close();
        return;
      case 'debugger.goto':
        if (s) await this.gotoStep(s, msg.step);
        return;
      case 'tour.open':
        this.tour?.setOpen(s, msg.open);
        return;
      case 'tour.goto':
        if (s) {
          // remember first: starting the Time Machine can schedule a re-run, after which this run's ids are gone
          await this.tour?.remember(s, msg.stopId);
          await this.gotoStep(s, msg.step);
        }
        return;
      case 'tour.recordLocals':
        if (s) await this.tour?.recordLocalsAndRun(s);
        return;
      case 'tour.narrate':
        if (s) await this.tour?.narrate(s);
        return;
      case 'debugger.action':
        if (s) await debuggerAction(this.timeMachine, s, msg.action);
        return;
      case 'debugger.previewRequest': {
        if (!s) return;
        const preview = this.timeMachine.codePreview(s, msg.step);
        if (preview) this.post(preview);
        return;
      }
      case 'debugger.selectFrame':
        if (s) this.timeMachine.selectFrame(s, msg.index);
        return;
      case 'debugContinue':
      case 'debugPause':
      case 'debugStep':
      case 'debugStop':
        if (s) await this.debug.handle(s, msg);
        return;
      case 'watch.remove':
        if (s) this.timeMachine.removeWatch(s, msg.id);
        return;
      case 'watch.refresh':
        if (s) this.timeMachine.refreshWatch(s, msg.id);
        return;
      case 'watch.add':
        if (s) this.timeMachine.addWatch(s, msg.exp);
        return;
      case 'watch.edit':
        if (s) this.timeMachine.editWatch(s, msg.id, msg.exp);
        return;
      case 'watch.evaluate':
        if (s) this.timeMachine.evaluateWatchNow(s, msg.id);
        return;
      case 'watch.complete': {
        const c = s ? await s.completeExpression(msg.text) : { prefix: '', items: [] };
        this.post({ type: 'watch.completions', requestId: msg.requestId, prefix: c.prefix, items: c.items });
        return;
      }
      case 'compare':
        if (s) this.compareEntries(s, msg.leftLogId, msg.rightLogId);
        return;
      case 'diagram':
        this.post({ type: 'showView', view: 'diagram' });
        return;
      case 'narrate':
        if (s && this.narrator) await this.narrator.narrate(s);
        return;
      case 'executionGraph.expand':
        if (s) this.graph.expand(s, msg.nodeId, msg.collapse);
        return;
      case 'executionGraph.request':
        if (s) this.graph.request(s);
        return;
      case 'executionGraph.hits':
        if (s) this.graph.hits(s, msg.nodeId);
        return;
      case 'log':
        if (msg.level === 'error') log.error(`webview: ${msg.message}`);
        else log.info(`webview: ${msg.message}`);
        return;
      default:
        return;
    }
  }

}

export { currentTheme, entryText } from './panelSupport';
