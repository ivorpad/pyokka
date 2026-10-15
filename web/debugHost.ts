/**
 * The live debugger in the browser (the panel's Debugger view, docs/design/debugger-product.md):
 * one `record: false` run on a runtime of its own (the bridge starts it), which pauses at
 * breakpoints and steps, with nothing recorded. This is the page's DebugSession and
 * DebuggerViewHost in one: it keeps the pause, the frame's variables, the watches, the breakpoints
 * set in the code pane's gutter and the program's output, and pushes `debug.session` to the panel.
 * VS Code shows the call stack, the variables and the step buttons in its own side bar; here the
 * page draws them under the code pane (`DebugPane`, main.tsx).
 */
import { entryPause } from '../src/session/debugState';
import { FileTable } from '../src/session/fileTable';
import { OutputLog } from '../src/session/outputBuffer';
import type { DebugBreakpointSpec, DebugExceptionMode, DebugPausedEvent, RunEvent, RunnerMessage, ValueBag, ValueNode } from '../src/shared/protocol';
import type { DebugSessionBreakpoint, DebugSessionFrame, DebugSessionPanel, DebugSessionWatch, HostToWebview, WebviewToHost } from '../src/shared/webviewProtocol';
import type { BridgeFile, PageToBridge, RequestBody } from './bridgeProtocol';

export interface DebugLink {
  send(msg: PageToBridge): void;
  /** a request for the debug run's runtime */
  debugRequest(body: RequestBody): Promise<RunnerMessage>;
}

export interface LocalVar {
  name: string;
  text: string;
  valueBag?: ValueBag;
}

interface DebugRun {
  runId: string;
  content: string;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  paused: DebugPausedEvent | null;
  files: FileTable;
  output: OutputLog;
  modified: boolean;
  /** why it ended early: a runner error */
  message?: string;
  /** the program's exit code, once `run.finished` came */
  exitCode: number | null;
  /** uncaught exceptions, at their innermost frame (a module that did not compile has no step before it) */
  errors: { type: string; message: string; file?: string; line: number }[];
}

type BreakpointEcho = DebugBreakpointSpec & { rid?: number; fileId?: number; resolvedLine?: number; error?: string };

type Control = Extract<WebviewToHost, { type: 'debug.control' }>['action'];

export class DebugHost {
  run: DebugRun | null = null;
  /** breakpoints by absolute path, then line; they outlive the runs */
  readonly breakpoints = new Map<string, Map<number, { condition?: string }>>();
  /** what the runtime answered for each breakpoint (resolved line, error) */
  private echoes: BreakpointEcho[] = [];
  exceptions: DebugExceptionMode = 'uncaught';
  private displayWatches: { id: string; exp: string }[] = [];
  private breakWatches: { id: string; exp: string; breakWhen: 'change' | 'true' }[] = [];
  private readonly values = new Map<string, { text?: string; error?: string }>();
  selectedFrame = 0;
  locals: { step: number; frameId: number; locals: LocalVar[] } | null = null;
  private counter = 0;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pauseWaiters: (() => void)[] = [];
  /** pauses seen so far, every run: the cursor `waitPause` compares against */
  pauseCount = 0;
  /** called after every change the code pane or an agent could show */
  onChange: () => void = () => {};

  constructor(
    private readonly link: DebugLink,
    private readonly post: (m: HostToWebview) => void,
    private readonly mainFile: () => BridgeFile | null,
    private readonly reveal: (path: string, line: number) => void,
    private readonly notice: (text: string, level: 'info' | 'error') => void,
    /** the files the page's recorded run instrumented, for `entryPause` */
    private readonly knownFiles: () => string[] = () => [],
  ) {}

  get active(): boolean {
    return !!this.run?.running;
  }

  get paused(): DebugPausedEvent | null {
    return this.run?.paused ?? null;
  }

  /* ---------- breakpoints ---------- */

  specs(): DebugBreakpointSpec[] {
    const out: DebugBreakpointSpec[] = [];
    for (const [path, lines] of this.breakpoints) for (const [line, bp] of lines) out.push({ path, line, ...(bp.condition ? { condition: bp.condition } : {}) });
    return out;
  }

  /** Set (`on` true), clear (false) or toggle a breakpoint; a running debug run gets the new set. */
  setBreakpoint(path: string, line: number, on?: boolean, condition?: string): boolean {
    const lines = this.breakpoints.get(path) ?? new Map<number, { condition?: string }>();
    const has = lines.has(line);
    const want = on ?? !has;
    if (want) lines.set(line, condition ? { condition } : {});
    else lines.delete(line);
    if (lines.size) this.breakpoints.set(path, lines);
    else this.breakpoints.delete(path);
    void this.syncBreakpoints();
    this.changed();
    return want;
  }

  /** The bridge's set, on connect or from another tab: shown, not sent back. */
  onBreakpoints(set: DebugBreakpointSpec[]): void {
    this.breakpoints.clear();
    for (const b of set) {
      if (b.path === undefined || b.line === undefined) continue;
      const lines = this.breakpoints.get(b.path) ?? new Map<number, { condition?: string }>();
      lines.set(b.line, b.condition ? { condition: b.condition } : {});
      this.breakpoints.set(b.path, lines);
    }
    this.changed();
  }

  /** Send the tab's breakpoints to the bridge, when it has any. */
  offerBreakpoints(): void {
    if (this.breakpoints.size) this.link.send({ type: 'debug.breakpoints', set: this.specs() });
  }

  private async syncBreakpoints(): Promise<void> {
    this.link.send({ type: 'debug.breakpoints', set: this.specs() });
    const run = this.run;
    if (!run?.running) return;
    const reply = await this.request({ action: 'breakpoints', set: this.specs() }).catch(() => undefined);
    const echo = reply?.['breakpoints'];
    if (Array.isArray(echo)) this.echoes = echo as BreakpointEcho[];
    this.changed();
  }

  /** The breakpoints of a file for the code pane's gutter: line -> condition. */
  breakpointsOf(path: string): Map<number, { condition?: string }> {
    return this.breakpoints.get(path) ?? new Map();
  }

  /* ---------- the run ---------- */

  /**
   * Start a debug run. It goes to the first breakpoint, and pauses at the first statement only when
   * asked or when no breakpoint can hit: VS Code's rule (`entryPause`), over the main file and the
   * files of the recorded run and of the last debug run.
   */
  start(content?: string, stopOnEntry?: boolean): void {
    const main = this.mainFile();
    const files = [...(main ? [main.path] : []), ...this.knownFiles(), ...(this.run?.files.all().map((f) => f.path) ?? [])];
    const breakpoints = this.specs();
    this.link.send({ type: 'debug.start', breakpoints, exceptions: this.exceptions, ...(content === undefined ? {} : { content }), stopOnEntry: entryPause({ stopOnEntry }, breakpoints, files) });
  }

  stop(): void {
    this.link.send({ type: 'debug.stop' });
  }

  onBegin(runId: string, content: string): void {
    this.run = { runId, content, startedAt: Date.now(), endedAt: null, running: true, paused: null, files: new FileTable(), output: new OutputLog(), modified: false, exitCode: null, errors: [] };
    this.selectedFrame = 0;
    this.locals = null;
    this.values.clear();
    this.echoes = [];
    // watches that pause the run take effect from its first statement
    if (this.breakWatches.length) void this.request({ action: 'watches', set: this.breakWatches }).catch(() => undefined);
    this.push();
  }

  onEvent(ev: RunEvent): void {
    const run = this.run;
    if (!run || ev.runId !== run.runId) return;
    switch (ev.type) {
      case 'file.instrumented':
        run.files.add(ev);
        break;
      case 'output':
        run.output.append(ev.stream, ev.text, Date.now() - run.startedAt);
        this.schedulePush();
        return;
      case 'debug.paused':
        this.pauseCount++;
        run.paused = ev;
        if (ev.modified) run.modified = true;
        if (ev.breakpoint) this.echoes = [...this.echoes.filter((e) => !(e.path === ev.breakpoint!.path && e.line === ev.breakpoint!.line)), ev.breakpoint];
        this.selectedFrame = 0;
        this.locals = null;
        this.values.clear();
        void this.fetchLocals();
        this.revealPause();
        for (const w of this.pauseWaiters.splice(0)) w();
        break;
      case 'debug.resumed':
        run.paused = null;
        this.locals = null;
        break;
      case 'error':
        if (!ev.handled) {
          const top = ev.stack?.[0];
          run.errors.push({ type: ev.errorType, message: ev.message, ...(top?.path ? { file: top.path } : {}), line: top?.line ?? 0 });
        }
        return;
      case 'run.finished':
        run.running = false;
        run.paused = null;
        run.endedAt = Date.now();
        run.exitCode = ev.exitCode ?? null;
        for (const w of this.pauseWaiters.splice(0)) w();
        break;
      default:
        return;
    }
    this.changed();
  }

  onEnd(runId: string, message?: string): void {
    const run = this.run;
    if (!run || run.runId !== runId) return;
    run.running = false;
    run.paused = null;
    run.endedAt ??= Date.now();
    if (message) {
      run.message = message;
      this.notice(`Debugger: ${message}`, 'error');
    }
    for (const w of this.pauseWaiters.splice(0)) w();
    this.changed();
  }

  /**
   * An agent's `waitPause`: the pause cursor now (`after` omitted), or a wait until a pause past
   * `after` arrives, the run ends, or `timeoutMs` (at most 25 s) runs out. A person stepping in the
   * page is what it waits for, so it never moves the program itself.
   */
  async waitForPause(after?: number, timeoutMs = 25_000): Promise<{ cursor: number; changed: boolean; ended?: boolean; timedOut?: boolean }> {
    if (after === undefined) return { cursor: this.pauseCount, changed: false };
    const deadline = Date.now() + Math.min(Math.max(0, timeoutMs), 25_000);
    while (this.pauseCount <= after && this.run?.running && Date.now() < deadline) await this.nextStop(deadline - Date.now());
    if (this.pauseCount > after) return { cursor: this.pauseCount, changed: true };
    return this.run?.running ? { cursor: this.pauseCount, changed: false, timedOut: true } : { cursor: this.pauseCount, changed: false, ended: true };
  }

  /** Resolves at the next pause or the end of the run (at once when neither can come). */
  nextStop(timeoutMs = 10_000): Promise<void> {
    if (!this.run?.running) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        resolve();
      };
      // a waiter that timed out leaves the list, so the next pause does not call it
      const t = setTimeout(() => {
        const i = this.pauseWaiters.indexOf(done);
        if (i >= 0) this.pauseWaiters.splice(i, 1);
        resolve();
      }, timeoutMs);
      this.pauseWaiters.push(done);
    });
  }

  private request(body: { action: 'continue' | 'step' | 'pause' | 'breakpoints' | 'watches' | 'locals' | 'exceptions'; kind?: 'into' | 'over' | 'out'; set?: unknown[]; mode?: DebugExceptionMode; frameId?: number }): Promise<Record<string, unknown>> {
    const run = this.run;
    if (!run?.running) return Promise.reject(new Error('no debug run'));
    return this.link.debugRequest({ type: 'debug', runId: run.runId, ...body } as RequestBody).then((reply) => {
      if (reply.type === 'error') throw new Error(reply.message);
      return reply as unknown as Record<string, unknown>;
    });
  }

  /** `strict`: a refusal from the runtime is thrown to the caller (an agent) as well as shown. */
  async control(action: Control, strict = false): Promise<void> {
    const run = this.run;
    try {
      switch (action) {
        case 'continue':
          if (run?.paused) await this.request({ action: 'continue' });
          return;
        case 'pause':
          if (run?.running && !run.paused) await this.request({ action: 'pause' });
          return;
        case 'stepOver':
        case 'stepInto':
        case 'stepOut':
          if (run?.paused) await this.request({ action: 'step', kind: action === 'stepOver' ? 'over' : action === 'stepInto' ? 'into' : 'out' });
          return;
        case 'restart':
          this.start(run?.content);
          return;
        case 'stop':
          this.stop();
          return;
      }
    } catch (err) {
      this.notice(`Debugger: ${err instanceof Error ? err.message : String(err)}`, 'error');
      if (strict) throw err;
    }
  }

  async selectFrame(index: number): Promise<void> {
    const p = this.run?.paused;
    if (!p || !p.stack[index]) return;
    this.selectedFrame = index;
    const f = p.stack[index]!;
    const path = this.pathOf(f.fileId ?? p.fileId);
    if (path && f.line) this.reveal(path, f.line);
    await this.fetchLocals();
  }

  private async fetchLocals(): Promise<void> {
    const p = this.run?.paused;
    if (!p) return;
    const frameId = this.selectedFrame;
    try {
      const reply = await this.request({ action: 'locals', ...(frameId ? { frameId } : {}) });
      if (this.run?.paused !== p) return;
      if (reply['modified'] === true && this.run) this.run.modified = true;
      this.locals = { step: p.step, frameId, locals: (reply['locals'] as LocalVar[] | undefined) ?? [] };
      await this.refreshWatches();
    } catch {
      /* the program moved on */
    }
    this.changed();
  }

  private async refreshWatches(): Promise<void> {
    const run = this.run;
    if (!run?.paused || !this.displayWatches.length) return;
    for (const w of this.displayWatches) {
      const r = await this.evaluate(w.exp);
      this.values.set(w.id, r ? { text: r.text } : { error: 'not evaluable here' });
    }
  }

  /** One more level of a captured value of the selected frame, from the runtime's store (no
   * expression runs). Null when the node has no more, or the pause or frame changed meanwhile. */
  async expandNode(node: ValueNode): Promise<ValueNode | null> {
    const run = this.run;
    const pause = run?.paused;
    const frame = this.selectedFrame;
    if (!run || !pause || !node.id || !node.expandable) return null;
    const reply = await this.link.debugRequest({ type: 'expand', runId: run.runId, valueId: node.id, queryPath: node.queryPath });
    if (this.run !== run || run.paused !== pause || frame !== this.selectedFrame) return null;
    if (reply.type === 'error') throw new Error(reply.message);
    return reply.type === 'value' ? reply.node : null;
  }

  /** Evaluate in the selected frame of the pause; undefined when it cannot. */
  async evaluate(expression: string): Promise<{ text: string; valueBag?: ValueBag } | undefined> {
    if (!this.run?.paused || !expression.trim()) return undefined;
    return this.evaluateAtPause(expression).catch(() => undefined);
  }

  /** Evaluate in the selected frame of the pause, or throw the runtime's error (an agent's `eval`). */
  async evaluateAtPause(expression: string): Promise<{ text: string; valueBag?: ValueBag }> {
    const run = this.run;
    if (!run?.paused) throw new Error('the debugger is not paused');
    const reply = await this.link.debugRequest({ type: 'evaluate', runId: run.runId, expression, ...(this.selectedFrame ? { frameId: this.selectedFrame } : {}) });
    if (reply.type === 'evaluated') return { text: reply.text, valueBag: reply.valueBag };
    throw new Error(reply.type === 'error' ? reply.message : `unexpected reply ${reply.type}`);
  }

  /* ---------- the panel's Debugger view ---------- */

  async handle(msg: Extract<WebviewToHost, { type: `debug.${string}` }>): Promise<void> {
    switch (msg.type) {
      case 'debug.selectFrame':
        return this.selectFrame(msg.index);
      case 'debug.watch.add':
        if (msg.breakWhen) {
          this.breakWatches.push({ id: `w${++this.counter}`, exp: msg.exp, breakWhen: msg.breakWhen });
          if (this.run?.running) await this.request({ action: 'watches', set: this.breakWatches }).catch(() => undefined);
        } else {
          this.displayWatches.push({ id: `w${++this.counter}`, exp: msg.exp });
          await this.refreshWatches();
        }
        break;
      case 'debug.watch.edit': {
        const row = this.displayWatches.find((w) => w.id === msg.id);
        if (row) {
          row.exp = msg.exp;
          this.values.delete(msg.id);
          await this.refreshWatches();
        } else {
          this.breakWatches = this.breakWatches.map((w) => (w.id === msg.id ? { ...w, exp: msg.exp } : w));
          if (this.run?.running) await this.request({ action: 'watches', set: this.breakWatches }).catch(() => undefined);
        }
        break;
      }
      case 'debug.watch.remove':
        this.displayWatches = this.displayWatches.filter((w) => w.id !== msg.id);
        this.values.delete(msg.id);
        if (this.breakWatches.some((w) => w.id === msg.id)) {
          this.breakWatches = this.breakWatches.filter((w) => w.id !== msg.id);
          if (this.run?.running) await this.request({ action: 'watches', set: this.breakWatches }).catch(() => undefined);
        }
        break;
      case 'debug.breakpoint.remove': {
        const main = this.mainFile();
        const abs = msg.file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(msg.file) ? msg.file : main ? `${main.path.slice(0, main.path.length - main.displayName.length)}${msg.file}` : msg.file;
        const lines = this.breakpoints.get(abs);
        if (lines) {
          if (msg.line === undefined) this.breakpoints.delete(abs);
          else lines.delete(msg.line);
          if (lines.size === 0) this.breakpoints.delete(abs);
        }
        await this.syncBreakpoints();
        break;
      }
      case 'debug.exceptions':
        this.exceptions = msg.mode;
        if (this.run?.running) await this.request({ action: 'exceptions', mode: msg.mode }).catch(() => undefined);
        break;
      case 'debug.control':
        return this.control(msg.action);
      case 'debug.output.resync':
        break;
    }
    this.changed();
  }

  private changed(): void {
    this.push();
    this.onChange();
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.push();
      this.onChange();
    }, 100);
  }

  push(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
    this.post({ type: 'debug.session', state: this.state() });
  }

  /** The file a pause's `fileId` names, as an absolute path. */
  pathOf(fileId: number | undefined): string | undefined {
    if (fileId === undefined || fileId === 0) return undefined;
    return this.run?.files.get(fileId)?.path;
  }

  private display(abs: string): string {
    const main = this.mainFile();
    const dir = main ? main.path.slice(0, main.path.length - main.displayName.length) : '';
    return dir && abs.startsWith(dir) ? abs.slice(dir.length) : abs;
  }

  /** Show the paused line in the code pane. */
  private revealPause(): void {
    const p = this.run?.paused;
    const path = p ? this.pathOf(p.fileId) : undefined;
    if (p && path && p.line) this.reveal(path, p.line);
  }

  frames(): DebugSessionFrame[] {
    const p = this.run?.paused;
    if (!p) return [];
    return p.stack.map((f, i) => {
      const abs = f.fileId === 0 ? undefined : this.pathOf(f.fileId ?? p.fileId);
      const out: DebugSessionFrame = { frameId: f.frameId ?? i, name: f.name, file: abs ? this.display(abs) : '<not instrumented>', line: f.line ?? p.line ?? 0 };
      if (!abs) out.library = true;
      return out;
    });
  }

  state(): DebugSessionPanel | null {
    const run = this.run;
    const main = this.mainFile();
    if (!run || !main) return null;
    const p = run.paused;
    const cached = this.locals;
    const now = run.endedAt ?? Date.now();
    return {
      id: run.runId,
      displayName: main.displayName,
      launch: { program: main.displayName, module: null, args: [], cwd: '.', python: null, record: false },
      launchTitle: `${main.path}  ·  no recording`,
      running: run.running,
      paused: !!p,
      record: false,
      modified: run.modified,
      ...(p ? { reason: p.reason } : {}),
      reasonText: p ? reasonText(p) : run.running ? 'running' : run.message ? `ended: ${run.message}` : 'ended',
      location: p ? `${this.display(this.pathOf(p.fileId) ?? main.path)}:${p.line ?? '?'}` : '',
      ...(p?.thread ? { thread: p.thread } : {}),
      stack: this.frames(),
      selectedFrame: this.selectedFrame,
      locals: cached && p && cached.step === p.step && cached.frameId === this.selectedFrame ? cached.locals.map((v) => ({ name: v.name, text: v.text, ...(v.valueBag ? { valueBag: v.valueBag } : {}) })) : [],
      watches: this.watchRows(),
      output: run.output.all(),
      outputOpen: run.output.openLine(),
      outputSeq: run.output.seq,
      outputDropped: run.output.dropped,
      elapsed: now - run.startedAt,
      lastOutputAt: run.output.lastOutputAt,
      breakpoints: this.breakpointRows(),
      files: run.files.all().map((f) => this.display(f.path)),
      exceptions: this.exceptions,
      exception: p?.exception ? { ...p.exception } : null,
    };
  }

  private watchRows(): DebugSessionWatch[] {
    const out: DebugSessionWatch[] = this.displayWatches.map((w) => {
      const v = this.values.get(w.id);
      return { id: w.id, exp: w.exp, kind: 'display' as const, ...(v?.error ? { error: v.error } : v?.text !== undefined ? { text: v.text } : {}) };
    });
    for (const w of this.breakWatches) out.push({ id: w.id, exp: w.exp, kind: 'breakWhen', breakWhen: w.breakWhen });
    return out;
  }

  private breakpointRows(): DebugSessionBreakpoint[] {
    return this.specs().map((bp) => {
      const echo = this.echoes.find((e) => e.path === bp.path && e.line === bp.line);
      const row: DebugSessionBreakpoint = { file: this.display(bp.path ?? ''), ...(bp.line ? { line: bp.line } : {}) };
      if (bp.condition) row.condition = bp.condition;
      if (echo?.resolvedLine !== undefined) row.resolvedLine = echo.resolvedLine;
      if (echo?.rid !== undefined) row.rid = echo.rid;
      if (echo?.error) row.error = echo.error;
      return row;
    });
  }
}

function reasonText(p: DebugPausedEvent): string {
  switch (p.reason) {
    case 'start':
      return 'start of the run';
    case 'step':
      return `step ${p.kind ?? 'into'}`;
    case 'breakpoint': {
      let s = 'breakpoint';
      if (p.breakpoint?.condition) s += ` if ${p.breakpoint.condition}`;
      if (p.conditionError) s += ` · condition failed: ${p.conditionError}`;
      return s;
    }
    case 'watch':
      return p.watch ? `watch ${p.watch.exp} → ${p.watch.text}` : 'watch';
    case 'pause':
      return 'paused on request';
    case 'exception':
      return p.exception ? `${p.exception.uncaught ? 'uncaught' : 'raised'} ${p.exception.type}: ${p.exception.message}` : 'exception';
    default:
      return p.reason;
  }
}
