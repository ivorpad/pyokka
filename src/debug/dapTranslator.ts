/**
 * The Debug Adapter Protocol face of Pyokka's debugger, as a pure translator: DAP requests
 * become calls on a `DebugSessionLike`, and the session's pause, resume and finish become DAP
 * events. No vscode import, so vitest covers it (test/unit/dapTranslator.test.ts); the glue that
 * hands a real Session in and posts the messages is dapAdapter.ts.
 *
 * One thread. `launch` opens the program's session and starts a debug run, which pauses at its
 * first statement (`stopped`, reason `entry`) or at the first breakpoint. `restart` stops that run
 * and starts a fresh one inside the same debug session, so the Restart button keeps the views and
 * their state. Continue, next, stepIn, stepOut and pause answer
 * before the pause arrives, as the protocol wants; the next `stopped` event carries it. The
 * stack comes from the pause's scope chain: the top frame is exact (the paused line); a caller
 * frame shows the first line of its scope's range, the `def` header, not the call site, because
 * the pause event does not carry caller lines (approximation, noted in the handoff). Variables
 * are the paused frame's locals with their value bags; nested nodes get references of their own,
 * and a load-action node ("more elements not loaded") expands through the session's expand path.
 *
 * A target with a `replay` source is a recording the Time Machine navigates: see dapReplay.ts.
 */
import type { ValueNode } from '../shared/protocol';
import { functionBreakpoint, replaceFunctionBreakpoints, type ExceptionMode, type LocalVar, type PausedInfo } from '../session/debugState';
import { assignment, consoleText } from './debugExec';
import { parseLaunch, type LaunchConfig } from './debugSessionState';
import type { DebugTarget, ReplayOutcome, ReplaySource } from './debugTarget';
import type { ReplayVar } from '../session/replayFrames';
import type { DapBreakpoint, DapCompletionItem, DapEvent, DapExceptionInfoBody, DapMessage, DapRequest, DapResponse, DapScope, DapStackFrame, DapVariable } from './dapTypes';
import { basename, CAPABILITIES, DAP_COMPLETION_TYPES, DEFAULT_EXCEPTION_MODE, frameIndex, hasChildren, pausedBody, REPLAY_CAPABILITIES, replayStoppedBody, source, summary, THREAD_ID } from './dapShared';
import { pageFrames, recordedCompletions, recordedValue, ReplayStops, replayStack } from './dapReplay';

export { CAPABILITIES, DAP_COMPLETION_TYPES, DEFAULT_EXCEPTION_MODE, describe, REPLAY_CAPABILITIES, THREAD_ID } from './dapShared';

/**
 * What the translator drives: one shape for both products (debugTarget.ts). dapAdapter.ts builds it
 * over a run-all `Session` (`wrapSession`) or over a `DebugSession` (`wrapDebugSession`).
 */
export type DebugSessionLike = DebugTarget;

type VarRef = { kind: 'locals'; frameId: number } | { kind: 'recorded'; frame: number } | { kind: 'node'; node: ValueNode } | { kind: 'load'; node: ValueNode };

export class DapTranslator {
  private seq = 1;
  private session: DebugSessionLike | undefined;
  private paused: PausedInfo | undefined;
  private refs = new Map<number, VarRef>();
  private nextRef = 1;
  /** the locals of each frame of the current pause, fetched on first ask */
  private locals = new Map<number, LocalVar[]>();
  private unsubscribe: (() => void)[] = [];
  private terminated = false;
  /** what `launch` asked for, so `restart` without a configuration repeats it */
  private stopOnEntry = false;
  /** the mode the Breakpoints view asked for, when it asked for one (see setExceptions) */
  private exceptions: ExceptionMode | undefined;
  /** configuration is over: a later filter change is the user clicking, not the client's stored list */
  private configured = false;
  private linesStartAt1 = true;
  private columnsStartAt1 = true;
  /** which step the views show, live or recorded, and when a replay `stopped` is owed */
  private readonly stops: ReplayStops;

  constructor(
    private readonly resolve: (launch: LaunchConfig, opts: { stopOnEntry: boolean }) => Promise<DebugSessionLike>,
    private readonly post: (msg: DapMessage) => void,
    /** `stepBack`: the session can replay, so `initialize` declares Step Back and Reverse Continue */
    private readonly opts: { stepBack?: boolean } = {},
  ) {
    this.stops = new ReplayStops(
      () => ({ replay: this.terminated ? undefined : this.session?.replay, paused: this.paused }),
      { live: (info) => this.onPaused(info), step: (step) => this.onReplayStep(step) },
    );
  }

  /** the recorded step the views show; undefined while they show the live pause, or nothing */
  private get shown(): number | undefined {
    return this.stops.shown;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.stops.dispose();
  }

  /* ---------- requests ---------- */

  async handle(req: DapRequest): Promise<void> {
    try {
      const body = await this.dispatch(req);
      this.respond(req, true, body);
    } catch (err) {
      this.respond(req, false, undefined, err instanceof Error ? err.message : String(err));
    }
  }

  private async dispatch(req: DapRequest): Promise<unknown> {
    const args = req.arguments ?? {};
    switch (req.command) {
      case 'initialize':
        this.linesStartAt1 = args['linesStartAt1'] !== false;
        this.columnsStartAt1 = args['columnsStartAt1'] !== false;
        // the client may set breakpoints as soon as it hears this; they live in VS Code's list and the host core pushes them
        queueMicrotask(() => this.event('initialized'));
        return this.opts.stepBack ? REPLAY_CAPABILITIES : CAPABILITIES;
      case 'launch': {
        // every launch attribute of the manifest goes through one parser (debugSessionState.ts)
        const launch = parseLaunch(args);
        // like VS Code's other debuggers the run goes to the first breakpoint; `stopOnEntry` pauses before the first statement
        const stopOnEntry = launch.stopOnEntry;
        this.stopOnEntry = stopOnEntry;
        const session = await this.resolve(launch, { stopOnEntry });
        this.attach(session);
        if (session.replayOnly) {
          // a finished run: the Time Machine is the only thing to show
          this.stops.schedule(true);
          return {};
        }
        await session.startDebug({ stopOnEntry });
        // a fresh session's first run is the debug run and may have paused before we subscribed
        if (session.debug.paused && !this.paused) this.onPaused(session.debug.paused);
        return {};
      }
      case 'attach':
        throw new Error('Pyokka debugs programs it runs; use a launch configuration with "program" or "module"');
      case 'configurationDone':
        this.configured = true;
        return {};
      case 'setExceptionBreakpoints': {
        const filters = Array.isArray(args['filters']) ? (args['filters'] as unknown[]).map(String) : [];
        await this.setExceptions(filters.includes('raised') ? 'raised' : filters.includes('uncaught') ? 'uncaught' : 'off', filters.length > 0);
        return {};
      }
      case 'exceptionInfo':
        return this.exceptionInfo();
      case 'setBreakpoints': {
        const bps = (args['breakpoints'] as { line: number }[] | undefined) ?? [];
        const echo = this.session?.debug.breakpoints ?? [];
        const out: DapBreakpoint[] = bps.map((b) => ({ verified: true, line: echo.find((e) => e.line === b.line)?.line ?? b.line }));
        return { breakpoints: out };
      }
      case 'threads':
        return { threads: [{ id: THREAD_ID, name: this.session?.displayName ?? 'main' }] };
      case 'stackTrace':
        return pageFrames(this.stackTrace(), args['startFrame'], args['levels']);
      case 'scopes':
        return this.scopes(Number(args['frameId'] ?? 1));
      case 'variables':
        return { variables: await this.variables(Number(args['variablesReference'] ?? 0)) };
      case 'evaluate':
        return this.evaluate(String(args['expression'] ?? ''), frameIndex(args['frameId']), String(args['context'] ?? ''));
      case 'setVariable':
        return this.setVariable(Number(args['variablesReference'] ?? 0), String(args['name'] ?? ''), String(args['value'] ?? ''));
      case 'setFunctionBreakpoints': {
        const asked = (args['breakpoints'] as { name?: unknown; condition?: unknown }[] | undefined) ?? [];
        const specs = asked.filter((b) => typeof b.name === 'string' && b.name.trim()).map((b) => functionBreakpoint(String(b.name), typeof b.condition === 'string' ? b.condition : undefined));
        const session = this.session;
        // the runtime resolves the names, so the echo is optimistic: the Breakpoints view shows them at once
        if (session) await session.setDebugBreakpoints(replaceFunctionBreakpoints(session.debug.breakpoints, specs));
        return { breakpoints: specs.map(() => ({ verified: true })) };
      }
      case 'completions':
        return { targets: await this.completions(String(args['text'] ?? ''), Number(args['column'] ?? (this.columnsStartAt1 ? 1 : 0)), typeof args['line'] === 'number' ? args['line'] : undefined) };
      case 'continue': {
        const replay = this.replaying();
        if (replay) this.replayed(replay.toBreakpoint(false));
        else await this.need().debugContinue();
        return { allThreadsContinued: true };
      }
      case 'next':
      case 'stepIn':
      case 'stepOut': {
        const kind = req.command === 'next' ? 'over' : req.command === 'stepIn' ? 'into' : 'out';
        const replay = this.replaying();
        if (replay) this.replayed(replay.move(kind));
        else await this.need().debugStep(kind);
        return {};
      }
      case 'stepBack':
        this.replayed(this.needReplay().move('backOver'));
        return {};
      case 'reverseContinue':
        this.replayed(this.needReplay().toBreakpoint(true));
        return {};
      case 'pause':
        if (this.need().replayOnly) this.replayed('none');
        else await this.need().debugPause();
        return {};
      case 'restart': {
        if (this.need().replayOnly) {
          // nothing to re-run: back to the first recorded step
          this.needReplay().goto(0);
          this.replayed('none');
          return {};
        }
        // the Restart button sends the launch configuration back under `arguments`; the debug session stays open
        const config = args['arguments'] as Record<string, unknown> | undefined;
        await this.need().restart({ stopOnEntry: config?.['stopOnEntry'] === true || this.stopOnEntry });
        return {};
      }
      case 'terminate':
      case 'disconnect':
        this.terminate();
        return {};
      default:
        throw new Error(`unsupported request ${req.command}`);
    }
  }

  /* ---------- the stack and the variables ---------- */

  private stackTrace(): { stackFrames: DapStackFrame[]; totalFrames: number } {
    const session = this.need();
    if (this.shown !== undefined && session.replay?.active) return replayStack(session.replay.frames(), (id) => session.pathForFileId(id));
    const info = this.paused;
    if (!info) return { stackFrames: [], totalFrames: 0 };
    const top = session.pathForFileId(info.fileId);
    const frames: DapStackFrame[] = info.stack.map((frame, i) => {
      const id = (frame.frameId ?? i) + 1;
      const hint = i === 0 ? {} : { presentationHint: 'subtle' as const };
      // the frame chain carries its own file and line (`record: false`); prefer it
      if (frame.line !== undefined) {
        const path = frame.fileId === undefined || frame.fileId === 0 ? undefined : session.pathForFileId(frame.fileId);
        return { id, name: frame.name, source: source(path), line: frame.line, column: 1, ...hint };
      }
      if (i === 0) return { id, name: frame.name, source: source(top), line: info.line ?? 1, column: 1 };
      // a caller frame of a recording run: the first line of its scope's range (the def header)
      const loc = frame.rid === undefined ? undefined : session.locate(frame.rid);
      return { id, name: frame.name, source: source(loc?.path), line: loc?.line ?? 1, column: 1, ...hint };
    });
    if (!frames.length) frames.push({ id: 1, name: '<module>', source: source(top), line: info.line ?? 1, column: 1 });
    return { stackFrames: frames, totalFrames: frames.length };
  }

  /** One Locals scope per frame: `debugLocals({frameId})` answers for any frame of the pause. */
  private scopes(frameId: number): { scopes: DapScope[] } {
    if (this.shown !== undefined) {
      return { scopes: [{ name: `Locals at step ${this.shown}`, presentationHint: 'locals', variablesReference: this.ref({ kind: 'recorded', frame: frameIndex(frameId) }), expensive: false }] };
    }
    if (!this.paused) return { scopes: [] };
    return { scopes: [{ name: 'Locals', presentationHint: 'locals', variablesReference: this.ref({ kind: 'locals', frameId: frameIndex(frameId) }), expensive: false }] };
  }

  private async variables(reference: number): Promise<DapVariable[]> {
    const ref = this.refs.get(reference);
    if (!ref) return [];
    if (ref.kind === 'recorded') return this.recorded(ref.frame).map((v) => this.variable(v.name, v.text, v.node, v.name));
    if (ref.kind === 'locals') {
      let vars = this.locals.get(ref.frameId);
      if (!vars) {
        vars = await this.need().debugLocals({ frameId: ref.frameId });
        this.locals.set(ref.frameId, vars);
      }
      return vars.map((v) => this.variable(v.name, v.text, v.valueBag?.data, v.name));
    }
    let node = ref.node;
    if (ref.kind === 'load') {
      const loaded = await this.need().expand(node.id, node.queryPath);
      if (!loaded) return [{ name: '…', value: 'more elements not loaded', variablesReference: 0 }];
      node = loaded;
    }
    return (node.props ?? []).map((p) => this.variable(p.name, p.value ?? summary(p), p, p.expressionPath));
  }

  private variable(name: string, text: string, node: ValueNode | undefined, evaluateName?: string): DapVariable {
    const out: DapVariable = { name, value: node?.loadActionNode ? 'more elements not loaded' : text, type: node?.type, variablesReference: 0 };
    if (node?.loadActionNode) {
      out.name = '…';
      out.variablesReference = this.ref({ kind: 'load', node });
    } else if (node && hasChildren(node)) {
      out.variablesReference = this.ref({ kind: 'node', node });
      if (node.length !== undefined) {
        if (node.type === 'list' || node.type === 'tuple' || node.type === 'set') out.indexedVariables = node.length;
        else out.namedVariables = node.length;
      }
    }
    if (evaluateName) out.evaluateName = evaluateName;
    return out;
  }

  /** The banner over the paused frame: the exception the run stopped on. */
  private exceptionInfo(): DapExceptionInfoBody {
    const e = this.shown === undefined ? this.paused?.exception : undefined;
    if (!e) throw new Error('not paused on an exception');
    return { exceptionId: e.type, description: e.message, breakMode: e.uncaught ? 'unhandled' : 'always', details: { message: e.message, typeName: e.type } };
  }

  /**
   * `setExceptionBreakpoints`: once before `launch` resolves, then on every click in the
   * Breakpoints view. The first one reports the client's list, which VS Code sends empty for a
   * debug type it has not shown yet even though `uncaught` is declared on (measured: `filters: []`
   * right after `initialize`), so before `configurationDone` only a list that asks for something
   * other than the declared default is taken; otherwise the session's own mode stands, which is
   * its default, the panel's, or the one an agent set with `--on-exception`. Every change after
   * configuration is a click and applies, an empty list included. A mode that arrives before the
   * session exists is remembered and `attach` applies it.
   */
  private async setExceptions(mode: ExceptionMode, chosen: boolean): Promise<void> {
    if (!this.configured && (!chosen || mode === DEFAULT_EXCEPTION_MODE)) return;
    this.exceptions = mode;
    if (this.session) await this.session.setDebugExceptions(mode);
  }

  /**
   * `context: "repl"` is the Debug Console and runs `exec`: statements, assignments, imports and
   * calls all go. Every other context (`hover`, `watch`, the Watch pane, the clipboard) runs
   * `evaluate`, which is pure and cannot write, because a hover must never change the program.
   */
  private async evaluate(expression: string, frameId: number, context: string): Promise<{ result: string; type?: string; variablesReference: number }> {
    // an empty Watch row or a bare Enter in the Debug Console: nothing to run, and the runtime would answer SyntaxError
    if (!expression.trim()) return { result: '', variablesReference: 0 };
    const session = this.need();
    if (this.shown !== undefined) {
      const found = recordedValue(this.recorded(frameId), expression, this.shown);
      return { result: found.text, type: found.node?.type, variablesReference: found.node && hasChildren(found.node) ? this.ref({ kind: 'node', node: found.node }) : 0 };
    }
    if (!this.paused) throw new Error('not paused: values are live only at the frontier');
    if (context === 'repl') {
      const r = await session.exec(expression, { frameId });
      // the frame may have been written: the Variables view must re-read, not show what it cached
      this.locals.clear();
      const node = r.valueBag?.data;
      return { result: consoleText(r), type: node?.type, variablesReference: node && hasChildren(node) ? this.ref({ kind: 'node', node }) : 0 };
    }
    const r = await session.evaluate(expression, { frameId });
    if (!r) throw new Error(`cannot evaluate ${expression} here`);
    const node = r.valueBag?.data;
    return { result: r.text, type: node?.type, variablesReference: node && hasChildren(node) ? this.ref({ kind: 'node', node }) : 0 };
  }

  /**
   * The Variables view's edit: `exec` of `<name> = <value>` for a Locals scope, of
   * `<evaluateName> = <value>` for a nested node, then `evaluate` of the same path so the row shows
   * what the program now holds rather than what was typed. Sets `modified`, like every `exec`.
   */
  private async setVariable(reference: number, name: string, value: string): Promise<{ value: string; type?: string; variablesReference: number }> {
    const session = this.need();
    if (this.shown !== undefined) throw new Error(`step ${this.shown} is a recording: a value can be written only at a live pause`);
    const ref = this.refs.get(reference);
    if (!ref) throw new Error(`nothing to write to: variable reference ${reference} is gone`);
    if (ref.kind === 'recorded') throw new Error('a recorded value cannot be written');
    const frameId = ref.kind === 'locals' ? ref.frameId : 0;
    const target = ref.kind === 'locals' ? name : (ref.node.props ?? []).find((p) => p.name === name)?.expressionPath;
    if (!target) throw new Error(`cannot write ${name}: it has no expression path`);
    const r = await session.exec(assignment(target, value), { frameId });
    if (r.exception) throw new Error(`${r.exception.type}: ${r.exception.message}`);
    this.locals.clear();
    const after = await session.evaluate(target, { frameId });
    const node = after?.valueBag?.data;
    return { value: after?.text ?? value, type: node?.type, variablesReference: node && hasChildren(node) ? this.ref({ kind: 'node', node }) : 0 };
  }

  /**
   * The Watch pane's and the Debug Console's completions: the text before the caret goes to the
   * runtime; each target replaces the typed prefix (`start`, `length` in the client's column base).
   */
  private async completions(text: string, column: number, line: number | undefined): Promise<DapCompletionItem[]> {
    const session = this.need();
    const lines = text.split('\n');
    const row = lines[line === undefined ? lines.length - 1 : Math.max(0, line - (this.linesStartAt1 ? 1 : 0))] ?? '';
    const caret = Math.max(0, Math.min(row.length, column - (this.columnsStartAt1 ? 1 : 0)));
    if (this.shown !== undefined) {
      // the recorded names of the innermost frame; there is no program to ask
      return recordedCompletions(this.recorded(0), row.slice(0, caret), column);
    }
    const c = await session.complete(row.slice(0, caret));
    const start = column - c.prefix.length;
    return c.items.map((item) => {
      const out: DapCompletionItem = { label: item.label, type: DAP_COMPLETION_TYPES[item.kind] ?? 'text', start, length: c.prefix.length };
      if (item.type) out.detail = item.type;
      return out;
    });
  }

  /* ---------- session events ---------- */

  private attach(session: DebugSessionLike): void {
    this.dispose();
    this.session = session;
    // a mode the Breakpoints view asked for before this session existed: the run must start with it
    if (this.exceptions) void session.setDebugExceptions(this.exceptions);
    this.unsubscribe.push(
      session.onPaused((info) => this.onPaused(info)),
      session.onResumed(() => this.onResumed()),
      session.onFinished((code) => this.onFinished(code)),
    );
    if (session.replay) this.unsubscribe.push(session.replay.onChanged(() => this.stops.schedule()));
  }

  /** Replay: the Time Machine source while it navigates; undefined sends the request to the live run. */
  private replaying(): ReplaySource | undefined {
    return this.session?.replay?.active ? this.session.replay : undefined;
  }

  private needReplay(): ReplaySource {
    const replay = this.replaying();
    if (!replay) throw new Error('stepping back needs a recording: start the Time Machine, or debug with "record": true');
    return replay;
  }

  /**
   * After a move a request asked for. One that executed waits for the run's own pause; any other
   * answers with a `stopped`, a dead end included, or the toolbar would stay on "running".
   */
  private replayed(outcome: ReplayOutcome): void {
    if (outcome !== 'executed') this.stops.schedule(true);
  }

  /** A recorded step to show: the caches go, and one `stopped` says where the Time Machine is. */
  private onReplayStep(step: number): void {
    this.forget();
    const top = this.session?.replay?.frames()[0];
    this.event('stopped', replayStoppedBody(step, top ? this.where(top.fileId, top.line) : (this.session?.displayName ?? '')));
  }

  /** The recorded variables of frame `index` at the step shown. */
  private recorded(index: number): ReplayVar[] {
    return this.replaying()?.variables(index) ?? [];
  }

  /**
   * A frame clicked in the Call Stack (dapAdapter.ts listens to `onDidChangeActiveStackItem`): the
   * Time Machine moves to that frame's step, its call site, and the views follow the new stop.
   */
  selectFrame(frameId: number): void {
    const replay = this.replaying();
    if (!replay || frameId <= 1) return;
    const frame = replay.frames()[frameId - 1];
    if (frame && frame.step !== replay.step) replay.goto(frame.step);
  }

  private onPaused(info: PausedInfo): void {
    this.paused = info;
    this.stops.livePaused(info.step);
    this.forget();
    this.event('stopped', pausedBody(info, this.where(info.fileId, info.line ?? '?')));
  }

  /** a new stop: the variable references and the fetched locals of the previous one go */
  private forget(): void {
    this.refs.clear();
    this.nextRef = 1;
    this.locals.clear();
  }

  private where(fileId: number, line: number | string): string {
    return `${basename(this.session?.pathForFileId(fileId)) ?? this.session?.displayName ?? ''}:${line}`;
  }

  private onResumed(): void {
    this.paused = undefined;
    this.event('continued', { threadId: THREAD_ID, allThreadsContinued: true });
  }

  private onFinished(exitCode: number | null): void {
    this.paused = undefined;
    if (this.terminated) return;
    this.terminated = true;
    this.event('exited', { exitCode: exitCode ?? 1 });
    this.event('terminated');
  }

  private terminate(): void {
    const session = this.session;
    if (session) {
      session.stopDebug();
      session.terminate();
    }
    if (!this.terminated) {
      this.terminated = true;
      this.event('terminated');
    }
    this.dispose();
  }

  /* ---------- helpers ---------- */

  private need(): DebugSessionLike {
    if (!this.session) throw new Error('no debug session: launch first');
    return this.session;
  }

  private ref(v: VarRef): number {
    const id = this.nextRef++;
    this.refs.set(id, v);
    return id;
  }

  private respond(req: DapRequest, success: boolean, body?: unknown, message?: string): void {
    const res: DapResponse = { seq: this.seq++, type: 'response', request_seq: req.seq, success, command: req.command };
    if (body !== undefined) res.body = body;
    if (message) res.message = message;
    this.post(res);
  }

  private event(event: string, body?: unknown): void {
    const ev: DapEvent = { seq: this.seq++, type: 'event', event };
    if (body !== undefined) ev.body = body;
    this.post(ev);
  }
}
