/**
 * What a `record: false` debug session answers with (docs/design/debugger-product.md, 4.3, 4.5):
 * the stop reply, the `break` and `watches` replies, the source and staleness a stop slice needs.
 * Split out of bridgeDebugSocket.ts, which owns the socket and the dispatch, so both stay under
 * the 500-line rule. The run socket's route (b) reaches `stopReply` from here too.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { DebugSession } from '../debug/debugSession';
import { AT_UNREADABLE, finishedSlice, readOutput, stopSlice } from '../debug/debugSessionState';
import { execReply, type StopRunner } from '../debug/debugExec';
import { functionBreakpoint, mergeBreakpoints, type BreakpointSpec, type LocalVar, type PausedInfo } from '../session/debugState';
import { currentFunctionBreakpoints, currentSourceBreakpoints } from '../features/debugBreakpoints';
import { redact } from '../util/redact';
import { BridgeError, int, type Request } from './bridgeSupport';
import { applyWatchRequest, breakpointReply, displayWatchItems, exceptionMode, localsReply, parseAtItem, parseBreakItems, pausedReply, resolveFile, type BreakItem, type PathContext } from './bridgeDebugShapes';

/** A stop reply waits for the program: as long as it runs, within reason. */
export const STOP_TIMEOUT_MS = 600_000;

export function context(ds: DebugSession): PathContext {
  return { workspaceRoot: ds.workspaceRoot, filePath: ds.filePath, displayName: ds.displayName, runFiles: () => ds.files.all().map((f) => ({ fileId: f.fileId, path: f.path })) };
}

/** The stop reply of a `record: false` pause: the slice of 4.3 plus `paused` and the frame's `locals`. */
export async function stopReply(ds: DebugSession, info: PausedInfo, opts: { scope?: boolean; valueBag?: boolean }): Promise<Record<string, unknown>> {
  const output = readOutput(ds.outputLog, ds.agentOutput, info.step, !!opts.scope);
  ds.agentOutput = output.cursor;
  let locals: LocalVar[] = [];
  try {
    locals = await ds.debugLocals();
  } catch {
    locals = []; // the program resumed or ended between the pause and this request
  }
  const slice = stopSlice(
    {
      paused: info,
      pathForFileId: (fileId) => ds.pathForFileId(fileId),
      readSource: (fileId) => readSource(ds, fileId),
      functionAt: (fileId, line) => ds.functionAt(fileId, line),
      output: output.read,
      modified: ds.modified,
      staleReason: staleness(ds),
      errors: ds.errors.map((e) => ({ file: ds.pathForFileId(e.fileId) ?? ds.filePath, line: e.stack[0]?.line ?? 0, type: e.errorType, message: redact(e.message), step: e.step })),
    },
    opts,
  );
  // `recording: false`: nothing behind this pause was kept, so `step` is the runtime's statement
  // counter and no `--to`, `--back` or history verb can reach it (docs/design/live-pause-context.md)
  return { ...slice, recording: false, paused: pausedReply(context(ds), info), locals: localsReply(locals, !!opts.valueBag) };
}

/** The next stop of `ds`: its pause, or 'finished' when the program ended instead. */
export function waitForStop(ds: DebugSession, timeoutMs = STOP_TIMEOUT_MS): Promise<PausedInfo | 'finished'> {
  return ds.waitForPause(timeoutMs);
}

/** A stop as the reply carries it: the slice of 4.3, or `{finished}` when the program ended. */
export function stopOrFinished(ds: DebugSession, result: PausedInfo | 'finished', opts: { scope?: boolean; valueBag?: boolean }): Promise<Record<string, unknown>> {
  return result === 'finished' ? Promise.resolve(finishedSlice(ds.lastFinished)) : stopReply(ds, result, opts);
}

/**
 * The moves `--until`, `--to` and `--count` are built from (debugExec.ts), over a `record: false`
 * debug session. Whatever the host throws on the way to a stop becomes a `BridgeError`, and the
 * waiter is armed before the action so a stop that arrives at once is not missed.
 */
export function stopRunner(ds: DebugSession): StopRunner {
  return {
    watches: () => ds.debug.watches,
    setWatches: (specs) => ds.setDebugWatches(specs),
    resume: () => ds.debugContinue(),
    step: (kind) => ds.debugStep(kind),
    runTo: (file, line) => ds.runToLine(file, line),
    stop: async (action) => {
      const next = waitForStop(ds);
      try {
        await action();
      } catch (err) {
        next.catch(() => undefined);
        throw err instanceof BridgeError ? err : new BridgeError(err instanceof Error ? err.message : String(err), 'see the Pyokka output channel');
      }
      return next;
    },
  };
}

/** `exec`: run a statement in the paused frame and report what it answered (2.7). */
export async function execRequest(ds: DebugSession, req: Request): Promise<Record<string, unknown>> {
  const source = typeof req.source === 'string' ? req.source : typeof req.expression === 'string' ? req.expression : '';
  if (!source.trim()) throw new BridgeError('exec needs source', 'send {source: "x = 3"}; a statement, an assignment, an import or a call all run');
  requirePaused(ds, 'run a statement');
  return execReply(await ds.exec(source, { frameId: int(req.frameId) }), redact);
}

/** Source lines of a file of the run: the open document, else the file on disk. */
export function readSource(ds: DebugSession, fileId: number): string[] | undefined {
  const file = ds.pathForFileId(fileId);
  if (!file) return undefined;
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
  if (open) return open.getText().split(/\r?\n/);
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/**
 * Why the program's file is not the file that is running, or null when it is.
 *
 * The two reasons are worth telling apart because they are not the same warning. `unsaved` means
 * `readSource` above is handing back the editor's buffer, so the block a reader is shown is text
 * that has never run and whose line numbers can disagree with the ones in the stack. `disk` means
 * the file changed under the run, so the block is the new text against the old line numbers.
 * Reported as one undifferentiated "changed since the run", it reads as noise, and a reader who
 * has seen it on a run they just started learns to skip it — which is what happened
 * (handoffs/2026-09-15-debugger-streaming-output.md, item 6).
 */
export function staleness(ds: DebugSession): 'unsaved' | 'disk' | null {
  const file = ds.launch.program ?? ds.mainFile;
  if (!file) return null;
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
  if (open?.isDirty) return 'unsaved';
  try {
    return fs.statSync(file).mtimeMs > ds.startedAt ? 'disk' : null;
  } catch {
    return null;
  }
}

/** The program's file has unsaved changes, or changed on disk since the session started. */
export function isStale(ds: DebugSession): boolean {
  return staleness(ds) !== null;
}

export function requirePaused(ds: DebugSession, what: string): void {
  if (ds.debug.paused) return;
  if (ds.running) throw new BridgeError(`cannot ${what}: the program is running`, '`pause --live` stops it at its next statement');
  throw new BridgeError(`cannot ${what}: the debug session is not paused`, '`restart --live` starts it again from the top');
}

/**
 * `break` on a debug session: the change goes into VS Code's own breakpoint list, so the gutter
 * shows it and `debugBreakpoints.ts` pushes it to the program in flight like any other, exactly as
 * the run socket's `break` does.
 */
export async function breakpoints(ds: DebugSession, req: Request): Promise<Record<string, unknown>> {
  const ctx = context(ds);
  const mode = exceptionMode(req.exceptions);
  if (mode) await ds.setDebugExceptions(mode);
  await applyAt(ctx, req, ds.debug.breakpoints, (specs) => ds.setDebugBreakpoints(specs));
  await removeFunctionBreakpoints(req, ds.debug.breakpoints, (specs) => ds.setDebugBreakpoints(specs));
  await applyGutter(ctx, req);
  const echo = await ds.syncVsCodeBreakpoints()?.catch(() => undefined);
  return { breakpoints: breakpointReply(ctx, mergeBreakpoints(currentSourceBreakpoints(), currentFunctionBreakpoints(), ds.debug.breakpoints), echo ?? (ds.debug.paused?.breakpoint ? [ds.debug.paused.breakpoint] : undefined)), exceptions: ds.debug.exceptions };
}

/**
 * `--at`: a function name goes on the session's own list as a `{function}` spec and into the
 * Breakpoints view as a function breakpoint, so the runtime resolves it and a human sees it.
 * `--at FILE:LINE` is an ordinary breakpoint and goes through the gutter like any other.
 */
export async function applyAt(ctx: PathContext, req: Request, own: readonly BreakpointSpec[], setOwn: (specs: BreakpointSpec[]) => Promise<unknown>): Promise<void> {
  if (req.at === undefined) return;
  const item = parseAtItem(ctx, req.at);
  if (!item) throw new BridgeError(`${AT_UNREADABLE}, got ${JSON.stringify(req.at)}`, 'e.g. `--at rrf` for a function, `--at app.py:42` for a line');
  if (!('function' in item)) {
    // an ordinary breakpoint: applyGutter adds it with the rest
    req.add = [...(Array.isArray(req.add) ? req.add : []), { path: item.path, line: item.line }];
    return;
  }
  const spec = functionBreakpoint(item.function);
  if (!own.some((bp) => bp.function === spec.function)) await setOwn(mergeBreakpoints(own, [spec]));
  if (!vscode.debug.breakpoints.some((b) => b instanceof vscode.FunctionBreakpoint && b.functionName === spec.function)) {
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(spec.function!, true)]);
  }
}

/**
 * `remove` items that name a function (`break --remove NAME`): the breakpoint `--at NAME` made. It
 * lives in two places, the session's own list and the Breakpoints view, and both lose it; the
 * gutter's line breakpoints are `applyGutter`'s.
 */
export async function removeFunctionBreakpoints(req: Request, own: readonly BreakpointSpec[], setOwn: (specs: BreakpointSpec[]) => Promise<unknown>): Promise<void> {
  if (!Array.isArray(req.remove)) return;
  // `--at Ranker.rank` matches on the last segment, so `--remove rank` and `--remove Ranker.rank` both name it
  const last = (name: string): string => name.trim().split('.').pop() ?? '';
  const names = new Set(req.remove.map((it) => (it && typeof it === 'object' && typeof (it as Record<string, unknown>).function === 'string' ? last(String((it as Record<string, unknown>).function)) : '')).filter(Boolean));
  if (!names.size) return;
  const kept = own.filter((bp) => bp.function === undefined || !names.has(last(bp.function)));
  if (kept.length !== own.length) await setOwn(kept);
  const fns = (): vscode.FunctionBreakpoint[] => vscode.debug.breakpoints.filter((b): b is vscode.FunctionBreakpoint => b instanceof vscode.FunctionBreakpoint && names.has(last(b.functionName)));
  if (!fns().length) return;
  vscode.debug.removeBreakpoints(fns());
  const started = Date.now();
  while (fns().length && Date.now() - started < BREAKPOINT_SETTLE_MS) await new Promise((r) => setTimeout(r, 40));
}

/** VS Code confirms a breakpoint change asynchronously; the reply waits for the list to show it. */
const BREAKPOINT_SETTLE_MS = 1_500;

/** `set` / `add` / `remove` applied to VS Code's breakpoint list; shared by both sockets. */
export async function applyGutter(ctx: PathContext, req: Request): Promise<void> {
  const source = (): vscode.SourceBreakpoint[] => vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint);
  const matches = (b: vscode.SourceBreakpoint, it: BreakItem, withCondition: boolean): boolean =>
    b.location.uri.scheme === 'file' && b.location.uri.fsPath === it.path && b.location.range.start.line === it.line - 1 && (!withCondition || (b.condition ?? '') === (it.condition ?? ''));
  const toAdd: BreakItem[] = [];
  const toRemove: vscode.SourceBreakpoint[] = [];
  if (Array.isArray(req.set)) {
    toRemove.push(...source());
    toAdd.push(...parseBreakItems(ctx, req.set));
  }
  if (Array.isArray(req.add)) for (const it of parseBreakItems(ctx, req.add)) if (!source().some((b) => matches(b, it, true)) && !toAdd.some((a) => a.path === it.path && a.line === it.line && (a.condition ?? '') === (it.condition ?? ''))) toAdd.push(it);
  if (Array.isArray(req.remove)) {
    const items = parseBreakItems(ctx, req.remove);
    for (const b of source()) if (items.some((it) => matches(b, it, false)) && !toRemove.includes(b)) toRemove.push(b);
  }
  if (toRemove.length) vscode.debug.removeBreakpoints(toRemove);
  if (toAdd.length) vscode.debug.addBreakpoints(toAdd.map((it) => new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(it.path), new vscode.Position(it.line - 1, 0)), true, it.condition)));
  if (!toRemove.length && !toAdd.length) return;
  const settled = (): boolean => toAdd.every((it) => source().some((b) => matches(b, it, true))) && toRemove.every((b) => !source().includes(b));
  const started = Date.now();
  while (!settled() && Date.now() - started < BREAKPOINT_SETTLE_MS) await new Promise((r) => setTimeout(r, 40));
}

/**
 * `watches`: the break-when watches the runtime holds, plus the displayed ones the session keeps
 * and this reply evaluates at the pause. An item with `breakWhen` is the first kind, one without
 * it the second (the panel shows it at every stop).
 */
export async function watches(ds: DebugSession, req: Request): Promise<Record<string, unknown>> {
  const next = applyWatchRequest(ds.debug.watches, req);
  if (Array.isArray(req.set) || Array.isArray(req.add) || Array.isArray(req.remove)) await ds.setDebugWatches(next);
  if (Array.isArray(req.set)) for (const w of [...ds.displayWatches]) ds.removeDisplayWatch(w.id);
  for (const exp of [...displayWatchItems(req.set), ...displayWatchItems(req.add)]) ds.addDisplayWatch(exp);
  if (Array.isArray(req.remove)) for (const id of req.remove.map(String)) ds.removeDisplayWatch(id);
  const shown: Record<string, unknown>[] = [];
  for (const w of ds.displayWatches) {
    const row: Record<string, unknown> = { id: w.id, exp: w.exp, kind: 'display' };
    const r = ds.debug.paused ? await ds.evaluate(w.exp) : undefined;
    if (r) row.text = redact(r.text);
    else if (ds.debug.paused) row.error = 'not evaluable here';
    shown.push(row);
  }
  return { watches: [...next.map((w) => ({ id: w.id, exp: w.exp, breakWhen: w.breakWhen })), ...shown] };
}

/** `select`: reveal a range in the editor, as the run socket's `select` does. */
export async function select(ds: DebugSession, req: Request): Promise<void> {
  const line = int(req.line);
  if (line === undefined) throw new BridgeError('select needs line', 'send {file, line, endLine?}');
  const file = resolveFile(context(ds), req.file);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const last = Math.min(doc.lineCount, Math.max(line, int(req.endLine) ?? line));
  const existing = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: true, preview: true });
  const range = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, last - 1), doc.lineAt(Math.max(0, last - 1)).text.length);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
