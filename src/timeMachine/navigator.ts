/**
 * Time Machine controller: navigation commands, auto play, call stack, watches,
 * edit-and-continue, code preview. Pushes `timeline` / `debugger` state through the sink.
 * The watch expressions live in watches.ts; the methods here forward to it.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { Range4, RunFinishedEvent } from '../shared/protocol';
import type { DebuggerState, HostToWebview } from '../shared/webviewProtocol';
import type { Session, RunState } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import type { Decorator } from '../decorations/decorator';
import { toVsRange } from '../decorations/decorator';
import { TraceModel } from './traceModel';
import { reanchorStep, type AnchorTrace } from './reanchor';
import { Watches } from './watches';
import { setting } from '../config/settings';
import { setContext } from '../util/context';
import { log } from '../util/log';
import { atFrontier, decideMove, type PausedInfo, type StepKind } from '../session/debugState';

export interface TimeMachineSink {
  pushDebugger(session: Session): void;
  pushTimeline(session: Session): void;
  pushEntries(session: Session): void;
  post(session: Session, msg: HostToWebview): void;
}

export type MoveKind = 'into' | 'back' | 'over' | 'backOver' | 'out' | 'backOut';

export type StoryResolver = (doc: vscode.TextDocument, line: number) => { session: Session; fileId: number; line: number; step?: number } | undefined;

interface Anchor {
  trace: TraceModel;
  content: string;
  files: RunState['files'];
  /** the trace is a debug run's recording so far: the final trace extends it, so the step needs no re-anchoring */
  prefix?: boolean;
}

export class TimeMachine implements vscode.Disposable {
  private sink: TimeMachineSink | undefined;
  private storyResolver: StoryResolver | undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly anchors = new Map<string, Anchor>();
  private readonly disposables: vscode.Disposable[] = [];
  /** the watch expressions and their values, behind this class's own watch methods (watches.ts) */
  private readonly watches: Watches;

  constructor(
    private readonly manager: SessionManager,
    private readonly decorator: Decorator,
  ) {
    this.watches = new Watches(decorator);
    manager.on('sessionStarted', (s) => this.attach(s));
    manager.on('sessionStopped', (s) => this.detach(s));
    manager.on('activeChanged', () => this.updateContext());
    for (const s of manager.all()) this.attach(s);
  }

  setSink(sink: TimeMachineSink): void {
    this.sink = sink;
    this.watches.setSink(sink);
  }

  setStoryResolver(resolver: StoryResolver): void {
    this.storyResolver = resolver;
  }

  dispose(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.watches.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private attach(session: Session): void {
    session.on('runFinished', (ev, state) => this.onRunFinished(session, ev, state));
    session.on('trace', () => this.sink?.pushTimeline(session));
    session.on('debugPaused', (info) => this.onDebugPaused(session, info));
    session.on('debugResumed', () => this.sink?.pushDebugger(session));
  }

  /* ---------- the debugger's frontier ---------- */

  /**
   * A debug run paused: attach the Time Machine at the frontier without a run (the recording so
   * far is already `session.trace`), or move an attached one there. Behind the frontier every move
   * replays; at it the forward moves execute (see `move`).
   */
  private onDebugPaused(session: Session, info: PausedInfo): void {
    const trace = session.trace;
    if (!trace || trace.count === 0) return;
    const nav = session.nav;
    if (!nav.active) {
      nav.active = true;
      nav.autoPlaying = false;
      nav.deadEnd = false;
      nav.selectedFrame = 0;
      nav.showCallStack = false;
    }
    this.anchors.set(session.key, { trace, content: session.state.content, files: session.files, prefix: true });
    this.goto(session, info.step);
    this.updateContext();
    this.sink?.pushTimeline(session);
  }

  private detach(session: Session): void {
    const t = this.timers.get(session.key);
    if (t) clearInterval(t);
    this.timers.delete(session.key);
    this.anchors.delete(session.key);
    this.updateContext();
  }

  /* ---------- context ---------- */

  updateContext(): void {
    const s = this.manager.active();
    setContext('traceBeingNavigated', !!s && s.nav.active);
    setContext('traceBeingAutoPlayed', !!s && s.nav.active && s.nav.autoPlaying);
    setContext('isAllowedDebuggerEditAndContinue', true);
  }

  /** The session a navigation command should act on (active editor, story doc or last used). */
  target(): Session | undefined {
    return this.manager.active();
  }

  /* ---------- start / stop ---------- */

  async start(session: Session, opts: { line?: number; fileId?: number; autoPlay?: boolean } = {}): Promise<boolean> {
    let trace = session.trace;
    if (!trace && !session.running && !session.implicitRunsAllowed) {
      void vscode.window.showWarningMessage(`Pyokka: no execution trace yet and the run mode is ${session.runMode === 'onSave' ? 'on save' : 'on demand'}. Re-execute the file first.`);
      return false;
    }
    if (!trace || session.running) {
      trace = await this.waitForTrace(session);
      if (!trace) {
        void vscode.window.showWarningMessage('Pyokka: no execution trace is available yet for this file.');
        return false;
      }
    }
    if (trace.count === 0) {
      void vscode.window.showInformationMessage(`Pyokka: ${session.displayName} ran no statement (only comments, definitions or an empty file), so there is nothing to step through. Add some code, then start the Time Machine.`);
      return false;
    }
    const nav = session.nav;
    const fileId = opts.fileId ?? session.mainFileId() ?? -1;
    const line = opts.line ?? 1;
    nav.active = true;
    nav.autoPlaying = false;
    nav.deadEnd = false;
    nav.selectedFrame = 0;
    nav.showCallStack = false;
    this.anchors.set(session.key, { trace, content: session.state.content, files: session.files });
    this.goto(session, trace.startStep(fileId, line));
    if (!session.autoLog && vscode.workspace.getConfiguration('pyokka').get<boolean>('timeMachine.autoLog', true)) {
      // show the value of every step while navigating; the re-run re-anchors the current step
      nav.autoLogByTimeMachine = true;
      session.setAutoLog(true);
    }
    this.updateContext();
    this.sink?.pushTimeline(session);
    if (opts.autoPlay) this.autoPlay(session);
    return true;
  }

  private waitForTrace(session: Session): Promise<TraceModel | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.off('runFinished', handler);
        resolve(session.trace);
      }, 15_000);
      const handler = (): void => {
        clearTimeout(timer);
        session.off('runFinished', handler);
        resolve(session.trace);
      };
      session.on('runFinished', handler);
      if (!session.running) void session.runNow('time-machine');
    });
  }

  stop(session: Session): void {
    if (session.nav.autoLogByTimeMachine) {
      session.nav.autoLogByTimeMachine = false;
      session.setAutoLog(false);
    }
    const nav = session.nav;
    if (!nav.active) return;
    this.pause(session);
    nav.active = false;
    nav.currentStep = -1;
    nav.deadEnd = false;
    nav.showCallStack = false;
    nav.echoSteps = [];
    session.setTraceContext(undefined);
    this.anchors.delete(session.key);
    this.updateContext();
    this.decorator.refreshSession(session);
    session.emit('navChanged');
    this.sink?.pushDebugger(session);
    this.sink?.pushEntries(session);
  }

  toggle(session: Session, line?: number, fileId?: number): Promise<boolean> {
    if (session.nav.active) {
      this.stop(session);
      return Promise.resolve(false);
    }
    return this.start(session, { line, fileId });
  }

  /* ---------- movement ---------- */

  goto(session: Session, step: number, opts: { reveal?: boolean } = {}): void {
    const trace = session.trace;
    const nav = session.nav;
    if (!trace || !nav.active) return;
    const clamped = trace.clamp(step);
    if (clamped < 0) return;
    nav.currentStep = clamped;
    nav.deadEnd = false;
    nav.selectedFrame = 0;
    nav.echoSteps = nav.echo ? trace.echoSteps(clamped) : [];
    this.decorator.refreshSession(session);
    if (opts.reveal !== false) void this.reveal(session, clamped);
    session.emit('navChanged');
    this.sink?.pushDebugger(session);
    this.sink?.pushEntries(session);
    this.watches.scheduleWatchWindow(session);
  }

  move(session: Session, kind: MoveKind): boolean {
    const trace = session.trace;
    const nav = session.nav;
    if (!trace || !nav.active) return false;
    if (decideMove(session.debug, nav, kind) === 'execute') {
      // at the frontier of a paused debug run the program itself takes the step
      void session.debugStep(kind as StepKind).catch((err) => log.warn(`debug step ${kind} failed: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    }
    const i = nav.currentStep;
    const next =
      kind === 'into' ? trace.stepInto(i)
      : kind === 'back' ? trace.stepBackInto(i)
      : kind === 'over' ? trace.stepOver(i)
      : kind === 'backOver' ? trace.stepBackOver(i)
      : kind === 'out' ? trace.stepOut(i)
      : trace.stepBackOut(i);
    if (next < 0) {
      this.decorator.flashDeadEnd(session);
      return false;
    }
    this.goto(session, next);
    return true;
  }

  /** Cursor location in protocol coordinates for the active editor (source or Code Story). */
  private cursorLocation(session: Session): { fileId: number; line: number } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    if (editor.document.uri.scheme === 'pyokka-code-timeline' && this.storyResolver) {
      const r = this.storyResolver(editor.document, editor.selection.active.line);
      return r ? { fileId: r.fileId, line: r.line } : undefined;
    }
    const fileId = session.fileIdForDocument(editor.document);
    if (fileId === undefined) return undefined;
    return { fileId, line: editor.selection.active.line + 1 };
  }

  runToLine(session: Session, backward: boolean): boolean {
    const trace = session.trace;
    const loc = this.cursorLocation(session);
    if (!trace || !loc || !session.nav.active) return false;
    if (!backward && atFrontier(session.debug, session.nav)) {
      const uri = session.uriForFileId(loc.fileId);
      if (!uri || uri.scheme !== 'file') return false;
      void session.debugCtl.runToLine(uri.fsPath, loc.line).catch((err) => log.warn(`run to line failed: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    }
    const next = backward ? trace.runBackToLine(session.nav.currentStep, loc.fileId, loc.line) : trace.runToLine(session.nav.currentStep, loc.fileId, loc.line);
    if (next < 0) {
      this.decorator.flashDeadEnd(session);
      return false;
    }
    this.goto(session, next);
    return true;
  }

  breakpointTargets(session: Session): Set<string> {
    const out = new Set<string>();
    for (const bp of vscode.debug.breakpoints) {
      if (!(bp instanceof vscode.SourceBreakpoint) || !bp.enabled) continue;
      const uri = bp.location.uri;
      const fileId = uri.toString() === session.key ? session.mainFileId() : uri.scheme === 'file' ? session.files.byPath(uri.fsPath)?.fileId : undefined;
      if (fileId !== undefined) out.add(`${fileId}:${bp.location.range.start.line + 1}`);
    }
    return out;
  }

  runToBreakpoint(session: Session, backward: boolean): boolean {
    const trace = session.trace;
    if (!trace || !session.nav.active) return false;
    if (!backward && atFrontier(session.debug, session.nav)) {
      void session.debugContinue().catch((err) => log.warn(`continue failed: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    }
    const targets = this.breakpointTargets(session);
    const next = backward ? trace.runBackToBreakpoint(session.nav.currentStep, targets) : trace.runToBreakpoint(session.nav.currentStep, targets);
    if (next < 0) {
      this.decorator.flashDeadEnd(session);
      return false;
    }
    this.goto(session, next);
    return true;
  }

  /* ---------- auto play ---------- */

  autoPlay(session: Session): void {
    if (!session.nav.active) return;
    this.pause(session);
    session.nav.autoPlaying = true;
    const delay = Math.max(50, setting<number>('codeAutoPlayDelay', 1000, session.document.uri));
    const timer = setInterval(() => {
      if (session.isDisposed || !session.nav.active) return this.pause(session);
      if (!this.move(session, 'into')) this.pause(session);
    }, delay);
    this.timers.set(session.key, timer);
    this.updateContext();
    this.sink?.pushDebugger(session);
  }

  pause(session: Session): void {
    const t = this.timers.get(session.key);
    if (t) clearInterval(t);
    this.timers.delete(session.key);
    if (session.nav.autoPlaying) {
      session.nav.autoPlaying = false;
      this.updateContext();
      this.sink?.pushDebugger(session);
    }
  }

  /* ---------- call stack ---------- */

  setCallStackVisible(session: Session, visible: boolean): void {
    session.nav.showCallStack = visible;
    session.nav.selectedFrame = 0;
    this.decorator.refreshSession(session);
    this.sink?.pushDebugger(session);
  }

  selectFrame(session: Session, index: number): void {
    const trace = session.trace;
    if (!trace || !session.nav.active) return;
    const stack = trace.callStack(session.nav.currentStep);
    const frame = stack[index];
    if (!frame) return;
    session.nav.showCallStack = true;
    session.nav.selectedFrame = index;
    this.decorator.refreshSession(session);
    void this.revealLocation(session, frame.fileId, frame.line, frame.col);
    this.sink?.pushDebugger(session);
  }

  /* ---------- toggles ---------- */

  toggleEcho(session: Session): void {
    session.nav.echo = !session.nav.echo;
    session.nav.echoSteps = session.nav.echo && session.trace ? session.trace.echoSteps(session.nav.currentStep) : [];
    this.decorator.refreshSession(session);
    this.sink?.pushDebugger(session);
  }

  toggleCodePreview(session: Session): void {
    session.nav.codePreview = !session.nav.codePreview;
    this.sink?.pushDebugger(session);
  }

  /* ---------- watches (watches.ts) ---------- */

  addWatch(session: Session, exp: string, range?: Range4, fileId?: number): void {
    this.watches.addWatch(session, exp, range, fileId);
  }

  removeWatch(session: Session, id: string): void {
    this.watches.removeWatch(session, id);
  }

  refreshWatch(session: Session, id: string): void {
    this.watches.refreshWatch(session, id);
  }

  editWatch(session: Session, id: string, exp: string): void {
    this.watches.editWatch(session, id, exp);
  }

  evaluateWatchNow(session: Session, id: string): void {
    this.watches.evaluateWatchNow(session, id);
  }

  /* ---------- edit and continue ---------- */

  private onRunFinished(session: Session, ev: RunFinishedEvent, state: RunState): void {
    const nav = session.nav;
    if (!nav.active || ev.stopped) return;
    const trace = state.trace;
    if (!trace) return;
    const prev = this.anchors.get(session.key);
    const next: Anchor = { trace, content: state.content, files: state.files };
    this.anchors.set(session.key, next);
    let step = nav.currentStep;
    if (prev?.prefix && prev.content === next.content) {
      // a debug run finished: its final trace extends the recording the Time Machine sat in
    } else if (prev && (prev.content !== next.content || prev.trace !== trace)) {
      if (prev.content !== next.content || prev.trace.count !== trace.count) {
        step = reanchorStep(anchorTrace(prev, session.mainFileId()), anchorTrace(next, session.mainFileId()), nav.currentStep, prev.content, next.content);
      }
    }
    if (step < 0) {
      this.stop(session);
      return;
    }
    nav.currentStep = trace.clamp(step);
    nav.echoSteps = nav.echo ? trace.echoSteps(nav.currentStep) : [];
    this.decorator.refreshSession(session);
    session.emit('navChanged');
    this.sink?.pushTimeline(session);
    this.sink?.pushDebugger(session);
    this.sink?.pushEntries(session);
  }

  /* ---------- reveal ---------- */

  private async reveal(session: Session, step: number): Promise<void> {
    const loc = session.trace?.location(step);
    if (!loc) return;
    await this.revealLocation(session, loc.fileId, loc.range[0], loc.range[1], loc.range);
  }

  async revealLocation(session: Session, fileId: number, line: number, col: number, range?: Range4): Promise<void> {
    const uri = session.uriForFileId(fileId);
    if (!uri || line <= 0) return;
    try {
      let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
      if (!editor) {
        const doc = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true, viewColumn: vscode.ViewColumn.One });
      }
      const target = range ? toVsRange(range) : new vscode.Range(line - 1, col, line - 1, col);
      const active = vscode.window.activeTextEditor;
      if (active === editor || (active && active.document.uri.scheme !== 'pyokka-code-timeline')) {
        editor.selection = new vscode.Selection(target.start, target.start);
      }
      editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
      log.warn(`reveal failed: ${String(err)}`);
    }
  }

  /* ---------- state for the panel ---------- */

  debuggerState(session: Session): DebuggerState {
    const nav = session.nav;
    const trace = session.trace;
    const step = nav.currentStep;
    const canStep = trace && nav.active && trace.valid(step) ? trace.canStep(step) : { into: false, back: false, over: false, backOver: false, out: false, backOut: false };
    const callStack = nav.showCallStack && trace && trace.valid(step)
      ? {
          frames: trace.callStack(step).map((f) => ({ fileId: f.fileId, line: f.line, col: f.col, rid: f.rid, function: f.function, step: f.step, scopeId: f.scopeId })),
          selected: nav.selectedFrame,
        }
      : undefined;
    const watches = this.watches.panelRows(session, step);
    const locals = session.state.locals.find((l) => l.step === step)?.changes;
    return {
      active: nav.active,
      autoPlaying: nav.autoPlaying,
      currentStep: step,
      canStep,
      echoSteps: nav.echo ? nav.echoSteps : [],
      callStack,
      showCallStack: nav.showCallStack,
      codePreview: nav.codePreview,
      echo: nav.echo,
      watches,
      locals,
    };
  }

  /** 7 lines of context around a step for the Steps strip hover, with the function and its call site. */
  codePreview(session: Session, step: number): Extract<HostToWebview, { type: 'codePreview' }> | undefined {
    const trace = session.trace;
    const loc = trace?.location(step);
    if (!trace || !loc) return undefined;
    const uri = session.uriForFileId(loc.fileId);
    let lines: string[] | undefined;
    if (uri) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc) lines = doc.getText().split(/\r?\n/);
      else if (uri.scheme === 'file') {
        try {
          lines = fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
        } catch {
          lines = undefined;
        }
      }
    }
    if (!lines) lines = session.state.content.split(/\r?\n/);
    const line = loc.range[0];
    const start = Math.max(1, line - 3);
    const end = Math.min(lines.length, start + 6);
    const [frame, callSite] = trace.callStack(step);
    const caller = callSite ? { step: callSite.step, function: callSite.function, file: session.displayPath(callSite.fileId), line: callSite.line } : undefined;
    return { type: 'codePreview', step, file: session.displayPath(loc.fileId), startLine: start, lines: lines.slice(start - 1, end), highlightLine: line, function: frame?.function ?? '<module>', caller };
  }
}

function anchorTrace(a: Anchor, mainFileId: number | undefined): AnchorTrace {
  const lines = a.content.split(/\r?\n/);
  const cache = new Map<number, string | undefined>();
  return {
    count: a.trace.count,
    textAt(i) {
      const rid = a.trace.rid(i);
      if (cache.has(rid)) return cache.get(rid);
      const loc = a.files.locate(rid);
      let text: string | undefined;
      if (loc && loc.fileId === mainFileId) text = rangeText(lines, loc.range);
      cache.set(rid, text);
      return text;
    },
    lineAt(i) {
      const loc = a.files.locate(a.trace.rid(i));
      return loc && loc.fileId === mainFileId ? loc.range[0] : -1;
    },
  };
}

export function rangeText(lines: string[], r: Range4): string {
  const [sl, sc, el, ec] = r;
  if (sl === el) return (lines[sl - 1] ?? '').slice(sc, ec);
  const out = [(lines[sl - 1] ?? '').slice(sc)];
  for (let l = sl + 1; l < el; l++) out.push(lines[l - 1] ?? '');
  out.push((lines[el - 1] ?? '').slice(0, ec));
  return out.join('\n');
}
