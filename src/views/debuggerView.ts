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
 * the host reveals it, re-reads `debugLocals({frameId})` and resends the state.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { DebugSession } from '../debug/debugSession';
import type { DebugSessionManager } from '../debug/debugSessionManager';
import { launchLine } from '../debug/debugSessionState';
import { exceptionText, type ExceptionMode, type LocalVar } from '../session/debugState';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import type { DebugSessionBreakpoint, DebugSessionFrame, DebugSessionPanel, DebugSessionWatch, HostToWebview, WebviewToHost } from '../shared/webviewProtocol';
import { redact } from '../util/redact';
import { log } from '../util/log';

export type DebugViewMessage = Extract<WebviewToHost, { type: 'debug.selectFrame' | 'debug.watch.add' | 'debug.watch.edit' | 'debug.watch.remove' | 'debug.breakpoint.remove' | 'debug.exceptions' | 'debug.control' | 'debug.output.resync' }>;

/** The output pane is resent at most this often while the program prints. */
const OUTPUT_THROTTLE_MS = 100;

export class DebuggerViewHost {
  /** the frame the view is scoped to, per session */
  private readonly selected = new Map<string, number>();
  /** the locals of the selected frame, per session, valid for the pause step they were read at */
  private readonly locals = new Map<string, { step: number; frameId: number; locals: LocalVar[] }>();
  /** the value of each displayed watch at the current pause, per session (the list is the session's) */
  private readonly values = new Map<string, Map<string, { text?: string; error?: string }>>();
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
      this.locals.delete(ds.id);
      this.push();
    });
    ds.once('ended', () => {
      this.selected.delete(ds.id);
      this.locals.delete(ds.id);
      this.values.delete(ds.id);
      this.sentSeq.delete(ds.id);
      this.sentOpen.delete(ds.id);
    });
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
    const selectedFrame = this.selected.get(ds.id) ?? 0;
    const cached = this.locals.get(ds.id);
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
      locals: cached && p && cached.step === p.step && cached.frameId === selectedFrame ? cached.locals.map((v) => ({ name: v.name, text: redact(v.text), ...(v.valueBag ? { valueBag: v.valueBag } : {}) })) : [],
      watches: watches(ds, this.values.get(ds.id)),
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
          this.selected.set(ds.id, msg.index);
          const frame = ds.debug.paused?.stack[msg.index];
          const file = frame?.fileId !== undefined ? ds.pathForFileId(frame.fileId) : undefined;
          if (file && frame?.line) await reveal(file, frame.line);
          await this.fetchLocals(ds, ds.debug.paused?.step ?? -1);
          return;
        }
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
            row.exp = msg.exp;
            this.values.get(ds.id)?.delete(msg.id);
            await this.refreshDisplayed(ds);
          } else {
            await ds.setDebugWatches(ds.debug.watches.map((w) => (w.id === msg.id ? { ...w, exp: msg.exp } : w)));
          }
          this.push();
          return;
        }
        case 'debug.watch.remove': {
          ds.removeDisplayWatch(msg.id);
          this.values.get(ds.id)?.delete(msg.id);
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
    const frameId = this.selected.get(ds.id) ?? 0;
    if (step < 0) return;
    try {
      const locals = await ds.debugLocals({ frameId });
      if (ds.debug.paused?.step !== step) return; // the program moved on meanwhile
      this.locals.set(ds.id, { step, frameId, locals });
      await this.refreshDisplayed(ds);
      this.push();
    } catch (err) {
      log.warn(`locals at the pause unavailable (${ds.displayName}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Evaluate every displayed watch in the selected frame; the values are keyed by watch id. */
  private async refreshDisplayed(ds: DebugSession): Promise<void> {
    if (!ds.displayWatches.length || !ds.debug.paused) return;
    const frameId = this.selected.get(ds.id) ?? 0;
    const values = this.values.get(ds.id) ?? new Map<string, { text?: string; error?: string }>();
    this.values.set(ds.id, values);
    for (const w of ds.displayWatches) {
      const r = await ds.evaluate(w.exp, { frameId });
      values.set(w.id, r ? { text: r.text } : { error: 'not evaluable here' });
    }
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

function watches(ds: DebugSession, values: Map<string, { text?: string; error?: string }> | undefined): DebugSessionWatch[] {
  const out: DebugSessionWatch[] = ds.displayWatches.map((w) => {
    const v = values?.get(w.id);
    return { id: w.id, exp: w.exp, kind: 'display' as const, ...(v?.error ? { error: v.error } : v?.text !== undefined ? { text: redact(v.text) } : {}) };
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
