/**
 * Host side of the Debugger view (docs/design/debugger-product.md, 5.2 to 5.4): the
 * `debug.session` state built from the active `DebugSession`, and the view's messages. Kept out of
 * outputPanel.ts so the panel stays a message router; debugPanel.ts is the same pattern for the
 * Time Machine's recording half.
 *
 * `output` is streamed as deltas: an `output` event sends `debug.output.append` with the bytes the
 * view has not seen, throttled to 100 ms, instead of the whole 64 KB window (which cost O(buffer)
 * per tick and re-`redact()`ed text the view already had). The full `debug.session` stays the
 * initial sync and the recovery path: the view asks for one with `debug.output.resync` whenever a
 * delta does not start at the offset it holds. A frame click scopes locals and eval to that frame:
 * the host reveals it, re-reads `debugLocals({frameId})` and resends the state. A member of a
 * local the runtime has not sent (`debug.expand`) is loaded here and spliced into the cached
 * locals, so every later state carries it and the view's open rows survive the next push.
 *
 * Displayed watches are evaluated at the pause they are read at, whoever added them: the view's
 * `+`, or the bridge's `watches --add` on the session itself, which used to show `no value at this
 * stop` until the next pause because only the view's own add evaluated.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { DebugSession } from '../debug/debugSession';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { launchLine } from '../debug/debugSessionState';
import { exceptionText, type ExceptionMode, type LocalVar } from '../session/debugState';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import { spliceNode } from '../shared/valueNodes';
import type { DebugSessionBreakpoint, DebugSessionFrame, DebugSessionPanel, DebugSessionWatch, HostToWebview, WebviewToHost } from '../shared/webviewProtocol';
import { redact } from '../util/redact';
import { log } from '../util/log';

export type DebugViewMessage = Extract<WebviewToHost, { type: 'debug.selectFrame' | 'debug.watch.add' | 'debug.watch.edit' | 'debug.watch.remove' | 'debug.breakpoint.remove' | 'debug.exceptions' | 'debug.control' | 'debug.output.resync' | 'debug.expand' }>;

/** The output pane is resent at most this often while the program prints. */
const OUTPUT_THROTTLE_MS = 100;

/** A displayed watch's value at the current pause: the expression it was read for, and its text when it had one. */
interface WatchValue {
  exp: string;
  text?: string;
}

/** Per-watch entries that belong to one pause step in one frame; another step or frame starts a new bucket. */
interface Bucket<T> {
  step: number;
  frameId: number;
  byId: Map<string, T>;
}

/** The bucket for this step and frame, started fresh when the stored one is another's. */
function bucket<T>(store: Map<string, Bucket<T>>, id: string, step: number, frameId: number): Map<string, T> {
  const cur = store.get(id);
  if (cur && cur.step === step && cur.frameId === frameId) return cur.byId;
  const byId = new Map<string, T>();
  store.set(id, { step, frameId, byId });
  return byId;
}

/** The bucket for this step and frame when there is one; nothing is started. */
function current<T>(store: Map<string, Bucket<T>>, id: string, step: number, frameId: number): Map<string, T> | undefined {
  const cur = store.get(id);
  return cur && cur.step === step && cur.frameId === frameId ? cur.byId : undefined;
}

export class DebuggerViewHost {
  /** the frame the view is scoped to, per session, for one pause step: a new stop reads the top frame, as the Call Stack view does */
  private readonly selected = new Map<string, { step: number; frameId: number }>();
  /** the locals of the selected frame, per session, valid for the pause step they were read at */
  private readonly locals = new Map<string, { step: number; frameId: number; locals: LocalVar[] }>();
  /** the value of each displayed watch, per session, read at one pause step in one frame (the list is the session's) */
  private readonly values = new Map<string, Bucket<WatchValue>>();
  /** the evaluations in flight, same key, so three `changed` events (or `changed` right before `paused`) do not ask twice */
  private readonly pending = new Map<string, Bucket<Promise<void>>>();
  private readonly detach: (() => void)[] = [];
  private throttle: NodeJS.Timeout | undefined;
  private counter = 0;
  /** the output offset the view holds, per session; absent until a full state has been sent */
  private readonly sentSeq = new Map<string, number>();
  /** the open line the view is showing, per session, so an unchanged one is not resent */
  private readonly sentOpen = new Map<string, string>();

  constructor(
    private readonly manager: DebugSessionManager,
    private readonly post: (msg: HostToWebview) => void,
  ) {
    const started = (ds: DebugSession): void => this.bind(ds);
    const changed = (): void => this.push();
    manager.on('sessionStarted', started);
    manager.on('changed', changed);
    manager.on('sessionEnded', changed);
    this.detach.push(() => {
      manager.off('sessionStarted', started);
      manager.off('changed', changed);
      manager.off('sessionEnded', changed);
    });
    for (const ds of manager.all()) this.bind(ds);
  }

  dispose(): void {
    if (this.throttle) clearTimeout(this.throttle);
    for (const d of this.detach) d();
  }

  private bind(ds: DebugSession): void {
    ds.on('output', () => this.scheduleOutput());
    ds.on('paused', (info) => void this.fetchLocals(ds, info.step));
    ds.on('resumed', () => {
      // the values belonged to that stop; while the program runs the rows say `at the next pause`
      this.locals.delete(ds.id);
      this.values.delete(ds.id);
      this.pending.delete(ds.id);
      this.push();
    });
    // a displayed watch added on the session itself (the bridge's `watches --add`): its value at this pause
    ds.on('changed', () => void this.refreshMissing(ds));
    ds.once('ended', () => {
      this.selected.delete(ds.id);
      this.locals.delete(ds.id);
      this.values.delete(ds.id);
      this.pending.delete(ds.id);
      this.sentSeq.delete(ds.id);
      this.sentOpen.delete(ds.id);
    });
  }

  /** The frame the view is scoped to at the current pause: the one clicked at this stop, else the top one. */
  private frameOf(ds: DebugSession): number {
    const s = this.selected.get(ds.id);
    const p = ds.debug.paused;
    return s && p && s.step === p.step ? s.frameId : 0;
  }

  /** Send the view's state (null when no debug session exists). */
  push(): void {
    const state = this.state();
    if (state) {
      this.sentSeq.set(state.id, state.outputSeq);
      this.sentOpen.set(state.id, state.outputOpen?.text ?? '');
    }
    this.post({ type: 'debug.session', state });
  }

  private scheduleOutput(): void {
    if (this.throttle) return;
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      this.flushOutput();
    }, OUTPUT_THROTTLE_MS);
  }

  /**
   * Send the bytes the view has not seen. The whole state goes only when there is nothing to send a
   * delta against: no full state yet, or a gap the log can no longer cover (the missed bytes were
   * cut from the head, or a restart reset the offset under us).
   */
  private flushOutput(): void {
    const ds = this.manager.active();
    if (!ds || ds.isDisposed) return this.push();
    const from = this.sentSeq.get(ds.id);
    if (from === undefined) return this.push();
    const chunks = ds.outputLog.since(from);
    if (!chunks) return this.push();
    const open = ds.outputLog.openLine();
    // the event may have been another session's: say nothing when this one has not moved
    if (!chunks.length && (this.sentOpen.get(ds.id) ?? '') === (open?.text ?? '')) return;
    this.sentSeq.set(ds.id, ds.outputLog.seq);
    this.sentOpen.set(ds.id, open?.text ?? '');
    this.post({ type: 'debug.output.append', id: ds.id, from, seq: ds.outputLog.seq, dropped: ds.outputLog.dropped, chunks, open });
  }

  /** The state of the active debug session; null when none exists. */
  state(): DebugSessionPanel | null {
    const ds = this.manager.active();
    if (!ds || ds.isDisposed) return null;
    const d = ds.debug;
    const p = d.paused;
    const root = ds.workspaceRoot;
    const selectedFrame = this.frameOf(ds);
    const cached = this.locals.get(ds.id);
    const localsRead = !!cached && !!p && cached.step === p.step && cached.frameId === selectedFrame;
    return {
      id: ds.id,
      displayName: ds.displayName,
      launch: { program: ds.launch.program ? display(ds.launch.program, root) : null, module: ds.launch.module ?? null, args: [...ds.launch.args], cwd: cwdLabel(ds.launch.cwd, root), python: ds.resolvedLaunch.python ? display(ds.resolvedLaunch.python, root) : null, record: ds.launch.record },
      launchTitle: `${launchLine(ds.resolvedLaunch)}  ·  cwd ${ds.launch.cwd}`,
      running: ds.running,
      paused: !!p,
      record: ds.launch.record,
      modified: ds.modified,
      ...(p ? { reason: p.reason } : {}),
      reasonText: p ? reasonText(ds, selectedFrame) : ds.running ? 'running' : 'ended',
      location: p ? `${display(ds.pathForFileId(p.fileId) ?? ds.filePath, root)}:${p.line ?? '?'}` : '',
      ...(p?.thread ? { thread: p.thread } : {}),
      stack: p ? frames(ds, root) : [],
      selectedFrame,
      locals: localsRead ? cached.locals.map((v) => ({ name: v.name, text: redact(v.text), ...(v.valueBag ? { valueBag: v.valueBag } : {}) })) : [],
      ...(p && !localsRead ? { localsPending: true } : {}),
      watches: watches(ds, p ? current(this.values, ds.id, p.step, selectedFrame) : undefined),
      output: ds.outputLog.all(),
      outputOpen: ds.outputLog.openLine(),
      outputSeq: ds.outputLog.seq,
      outputDropped: ds.outputLog.dropped,
      elapsed: Date.now() - ds.runStartedAt,
      lastOutputAt: ds.outputLog.lastOutputAt,
      breakpoints: breakpoints(ds, root),
      files: ds.files.all().map((f) => display(f.path, root)),
      exceptions: d.exceptions,
      exception: p?.exception ? { ...p.exception } : null,
    };
  }

  /** One message from the view; errors reach the user like a failed command does. */
  async handle(msg: DebugViewMessage): Promise<void> {
    const ds = this.manager.active();
    if (!ds) return;
    try {
      switch (msg.type) {
        case 'debug.selectFrame': {
          const p = ds.debug.paused;
          if (!p) return;
          this.selected.set(ds.id, { step: p.step, frameId: msg.index });
          // the locals and the watches of that frame follow; until then the state says they are being read
          this.push();
          const frame = p.stack[msg.index];
          const file = frame?.fileId !== undefined ? ds.pathForFileId(frame.fileId) : undefined;
          if (file && frame?.line) await reveal(file, frame.line);
          await this.fetchLocals(ds, ds.debug.paused?.step ?? -1);
          return;
        }
        case 'debug.expand':
          await this.expandLocal(ds, msg.name, msg.valueId, msg.queryPath);
          return;
        case 'debug.watch.add': {
          if (msg.breakWhen) await ds.setDebugWatches([...ds.debug.watches, { id: `w${++this.counter}`, exp: msg.exp, breakWhen: msg.breakWhen }]);
          else {
            ds.addDisplayWatch(msg.exp);
            await this.refreshDisplayed(ds);
          }
          this.push();
          return;
        }
        case 'debug.watch.edit': {
          const row = ds.displayWatches.find((w) => w.id === msg.id);
          if (row) {
            // the value kept is the old expression's, so the refresh reads this one
            row.exp = msg.exp;
            await this.refreshDisplayed(ds);
          } else {
            await ds.setDebugWatches(ds.debug.watches.map((w) => (w.id === msg.id ? { ...w, exp: msg.exp } : w)));
          }
          this.push();
          return;
        }
        case 'debug.watch.remove': {
          ds.removeDisplayWatch(msg.id);
          this.values.get(ds.id)?.byId.delete(msg.id);
          if (ds.debug.watches.some((w) => w.id === msg.id)) await ds.setDebugWatches(ds.debug.watches.filter((w) => w.id !== msg.id));
          this.push();
          return;
        }
        case 'debug.breakpoint.remove': {
          const abs = path.isAbsolute(msg.file) ? msg.file : path.resolve(ds.workspaceRoot || ds.launch.cwd, msg.file);
          const gutter = vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath === abs && (msg.line === undefined || b.location.range.start.line === msg.line - 1));
          if (gutter.length) vscode.debug.removeBreakpoints(gutter);
          const own = ds.debug.breakpoints.filter((bp) => bp.path !== abs || (msg.line !== undefined && bp.line !== msg.line));
          if (own.length !== ds.debug.breakpoints.length) await ds.setDebugBreakpoints(own);
          this.push();
          return;
        }
        case 'debug.output.resync':
          this.push();
          return;
        case 'debug.exceptions':
          await ds.setDebugExceptions(msg.mode as ExceptionMode);
          this.push();
          return;
        case 'debug.control':
          await this.control(ds, msg.action);
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Debugger view ${msg.type} failed (${ds.displayName})`, err);
      void vscode.window.showErrorMessage(`Pyokka: ${message}`);
    }
  }

  private async control(ds: DebugSession, action: 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop'): Promise<void> {
    switch (action) {
      case 'continue':
        return ds.debugContinue();
      case 'pause':
        return ds.debugPause();
      case 'stepOver':
        return ds.debugStep('over');
      case 'stepInto':
        return ds.debugStep('into');
      case 'stepOut':
        return ds.debugStep('out');
      case 'restart':
        return ds.restart({});
      case 'stop':
        ds.stopDebug();
        return;
    }
  }

  private async fetchLocals(ds: DebugSession, step: number): Promise<void> {
    const frameId = this.frameOf(ds);
    if (step < 0) return;
    try {
      const locals = await ds.debugLocals({ frameId });
      if (ds.debug.paused?.step !== step || this.frameOf(ds) !== frameId) return; // the program or the reader moved on meanwhile
      // a copy: `debug.expand` writes loaded members into this list
      this.locals.set(ds.id, { step, frameId, locals: [...locals] });
      await this.refreshDisplayed(ds);
      this.push();
    } catch (err) {
      log.warn(`locals at the pause unavailable (${ds.displayName}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A member of the local `name` that the runtime has not sent: `expand` it in the paused run and
   * keep it in the cached locals, so the state sent from now on carries it (the view's open rows
   * survive the next push). The state is resent whatever happened, which also ends the view's
   * loading twist when nothing came back.
   */
  private async expandLocal(ds: DebugSession, name: string, valueId: string, queryPath: string[]): Promise<void> {
    const cached = this.locals.get(ds.id);
    const p = ds.debug.paused;
    const i = cached?.locals.findIndex((l) => l.name === name) ?? -1;
    const local = cached?.locals[i];
    if (!cached || !p || cached.step !== p.step || !local?.valueBag) return;
    try {
      const node = await ds.expand(valueId, queryPath);
      if (node && ds.debug.paused?.step === p.step && this.locals.get(ds.id) === cached) {
        cached.locals[i] = { ...local, valueBag: { ...local.valueBag, data: spliceNode(local.valueBag.data, node) } };
      }
    } finally {
      this.push();
    }
  }

  /**
   * The displayed watches that have no value for this pause (or were read for another expression:
   * the bridge's `--set` reuses ids): evaluate them and resend the state. A no-op when every row
   * has its value, which is what every other `changed` event finds.
   */
  private async refreshMissing(ds: DebugSession): Promise<void> {
    const p = ds.debug.paused;
    if (!p) return;
    const frameId = this.frameOf(ds);
    const values = current(this.values, ds.id, p.step, frameId);
    const pending = current(this.pending, ds.id, p.step, frameId);
    if (!ds.displayWatches.some((w) => values?.get(w.id)?.exp !== w.exp && !pending?.has(w.id))) return;
    await this.refreshDisplayed(ds);
    this.push();
  }

  /**
   * Evaluate every displayed watch that has no value yet, in the selected frame, and wait for the
   * ones already being evaluated; the values are keyed by watch id. A watch with no value at this
   * pause (a name not bound yet, a call the pure rule refuses) keeps none, and the row says `no
   * value at this stop`, which is the truth, rather than an error text the runtime never sent.
   * A value is dropped when the program or the selected frame moved on while it was being read.
   */
  private refreshDisplayed(ds: DebugSession): Promise<void> {
    const p = ds.debug.paused;
    if (!ds.displayWatches.length || !p) return Promise.resolve();
    const step = p.step;
    const frameId = this.frameOf(ds);
    const values = bucket(this.values, ds.id, step, frameId);
    const pending = bucket(this.pending, ds.id, step, frameId);
    const waits: Promise<void>[] = [];
    for (const w of ds.displayWatches) {
      if (values.get(w.id)?.exp === w.exp) continue;
      let job = pending.get(w.id);
      if (!job) {
        const run = ds
          .evaluate(w.exp, { frameId })
          .then((r) => {
            if (ds.debug.paused?.step !== step || this.frameOf(ds) !== frameId) return;
            values.set(w.id, r ? { exp: w.exp, text: r.text } : { exp: w.exp });
          })
          .finally(() => {
            if (pending.get(w.id) === run) pending.delete(w.id);
          });
        pending.set(w.id, run);
        job = run;
      }
      waits.push(job);
    }
    return Promise.all(waits).then(() => undefined);
  }
}

/* ---------- shaping ---------- */

function display(abs: string, root: string): string {
  if (!root) return abs;
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

/**
 * The working directory as the launch row shows it: `.` when it is the workspace folder itself
 * (`path.relative` answers '' there, and the absolute path is what filled the row with noise),
 * else the display path.
 */
function cwdLabel(cwd: string, root: string): string {
  if (!cwd) return '';
  if (root && path.resolve(cwd) === path.resolve(root)) return '.';
  return display(cwd, root);
}

function reasonText(ds: DebugSession, _frame: number): string {
  const p = ds.debug.paused;
  if (!p) return '';
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
      if (p.watch?.error) return `watch ${p.watch.exp} failed: ${redact(p.watch.error)}`;
      return p.watch ? `watch ${p.watch.exp} → ${redact(p.watch.text)}` : 'watch';
    case 'pause':
      return 'paused on request';
    case 'exception':
      return p.exception ? exceptionText(p.exception) : 'exception';
    default:
      return p.reason;
  }
}

function frames(ds: DebugSession, root: string): DebugSessionFrame[] {
  const p = ds.debug.paused;
  if (!p) return [];
  return p.stack.map((f, i) => {
    const fileId = f.fileId ?? p.fileId;
    const abs = f.fileId === 0 ? undefined : ds.pathForFileId(fileId);
    const out: DebugSessionFrame = { frameId: f.frameId ?? i, name: f.name, file: abs ? display(abs, root) : '<not instrumented>', line: f.line ?? p.line ?? 0 };
    if (!abs) out.library = true;
    return out;
  });
}

function watches(ds: DebugSession, values: Map<string, WatchValue> | undefined): DebugSessionWatch[] {
  const out: DebugSessionWatch[] = ds.displayWatches.map((w) => {
    const v = values?.get(w.id);
    return { id: w.id, exp: w.exp, kind: 'display' as const, ...(v?.exp === w.exp && v.text !== undefined ? { text: redact(v.text) } : {}) };
  });
  for (const w of ds.debug.watches) out.push({ id: w.id, exp: w.exp, kind: 'breakWhen', breakWhen: w.breakWhen });
  return out;
}

function breakpoints(ds: DebugSession, root: string): DebugSessionBreakpoint[] {
  const p = ds.debug.paused;
  const echo = p?.breakpoint;
  const out: DebugSessionBreakpoint[] = [];
  const seen = new Set<string>();
  for (const bp of [...currentSourceBreakpoints(), ...currentFunctionBreakpoints(), ...ds.debug.breakpoints]) {
    const key = `${bp.function ?? ''}\n${bp.path ?? ''}\n${bp.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // a function breakpoint learns its file and line from the echo: the runtime resolves the name
    const hit = echo && (bp.function !== undefined ? echo.function === bp.function : echo.path === bp.path && echo.line === bp.line);
    // an unresolved function spec is echoed as `{path: "", line: 0}`: neither is a location yet
    const file = bp.path ?? (hit ? (echo?.path || undefined) ?? (echo?.fileId ? ds.pathForFileId(echo.fileId) : undefined) : undefined);
    const row: DebugSessionBreakpoint = { file: file ? display(file, root) : '' };
    if (bp.function !== undefined) row.function = bp.function;
    const line = bp.line ?? (hit ? echo?.resolvedLine || echo?.line || undefined : undefined);
    if (line) row.line = line;
    if (bp.condition) row.condition = bp.condition;
    if (hit && echo) {
      if (echo.resolvedLine !== undefined) row.resolvedLine = echo.resolvedLine;
      if (echo.rid !== undefined) row.rid = echo.rid;
      if (echo.error) row.error = echo.error;
    }
    out.push(row);
  }
  return out;
}

async function reveal(file: string, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  const existing = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file);
  await vscode.window.showTextDocument(doc, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One, selection: new vscode.Range(pos, pos), preserveFocus: true, preview: true });
}
