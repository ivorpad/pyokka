/**
 * Pure helpers of the Debugger view (docs/design/debugger-product.md, 5.1): the header sentence,
 * the frame labels, the breakpoint rows and the output tail. No DOM, so vitest covers them
 * (test/unit/webview/debuggerView.test.tsx).
 */
import type { DebugSessionBreakpoint, DebugSessionFrame, DebugSessionPanel, DebugSessionWatch } from './src-shared';

/** `Paused at app.py:42 · breakpoint`, `Running…`, `The program ended.` */
export function debugHeaderLine(state: DebugSessionPanel): string {
  if (state.paused) return `Paused at ${state.location} · ${state.reasonText}`;
  if (state.running) return 'Running… the program stops at a breakpoint, an exception, or a pause';
  return 'The program ended.';
}

/** The codicon of the status row: why the program is where it is, at a glance. */
export function reasonIcon(state: DebugSessionPanel): string {
  if (!state.paused) return state.running ? 'loading' : 'circle-slash';
  switch (state.reason) {
    case 'exception':
      return 'error';
    case 'pause':
      return 'debug-pause';
    case 'step':
      return state.reasonText.includes('into') ? 'debug-step-into' : state.reasonText.includes('out') ? 'debug-step-out' : 'debug-step-over';
    case 'start':
      return 'debug-start';
    case 'watch':
      return 'eye';
    default:
      return 'debug-breakpoint';
  }
}

/** A break-when watch's badge, `undefined` for a displayed one. */
export function watchBadge(w: DebugSessionWatch): string | undefined {
  if (w.kind !== 'breakWhen') return undefined;
  return w.breakWhen === 'true' ? 'break when true' : 'break on change';
}

/**
 * The value half of a watch row: its text, its error, or a dim note that it has none. While the
 * program runs there is no stop to read it at, and `no value at this stop` said the wrong thing for
 * the whole length of the run — the expression is fine, there has simply not been a pause yet.
 */
export function watchValue(w: DebugSessionWatch, running = false): { text: string; dim: boolean } {
  if (w.error) return { text: w.error, dim: true };
  if (w.kind === 'breakWhen') return { text: '', dim: true };
  if (w.text !== undefined) return { text: w.text, dim: false };
  return { text: running ? 'at the next pause' : 'no value at this stop', dim: true };
}

/**
 * `.venv/bin/python -m api.main  ·  cwd .`. Every path is the display path the host sent, which is
 * workspace-relative inside the workspace, so the line fits the panel instead of carrying two
 * absolute paths; the full command is in the row's `title`. The interpreter is shown only when the
 * host knows it (it fills it in from the session once it resolved one): printing `python3` for a
 * session that runs a venv would be a guess the reader cannot tell from a fact.
 */
export function launchSummary(launch: DebugSessionPanel['launch']): string {
  const target = launch.module ? `-m ${launch.module}` : (launch.program ?? '');
  const head = launch.python ? `${launch.python} ${target}` : target;
  const command = [head, ...launch.args].join(' ');
  return launch.cwd ? `${command}  ·  cwd ${launch.cwd}` : command;
}

/** `do_GET  app.py:42`; a library frame is marked so the list reads as one. */
export function frameLabel(frame: DebugSessionFrame): string {
  return `${frame.name}  ${frame.file}:${frame.line}`;
}

/** `app.py:42  if i == 3  -> resolved line 42`, `rrf  demo.py:41`. */
export function breakpointLabel(bp: DebugSessionBreakpoint): string {
  const where = bp.function ? `${bp.function}  ${bp.file}${bp.line ? `:${bp.line}` : ''}` : `${bp.file}:${bp.line ?? '?'}`;
  const parts = [where];
  if (bp.condition) parts.push(`if ${bp.condition}`);
  if (bp.error) parts.push(`(${bp.error})`);
  else if (bp.resolvedLine !== undefined && bp.resolvedLine !== bp.line) parts.push(`-> resolved line ${bp.resolvedLine}`);
  return parts.join('  ');
}

/** `rank = 2`, `rank == 3  break when true`, `payload  (NameError)`. */
export function watchLabel(w: DebugSessionWatch): string {
  if (w.error) return `${w.exp}  (${w.error})`;
  if (w.kind === 'breakWhen') return `${w.exp}  break when ${w.breakWhen === 'true' ? 'true' : 'it changes'}`;
  return w.text === undefined ? `${w.exp}  (no value at this stop)` : `${w.exp} = ${w.text}`;
}

/** How many unresolvable breakpoints in one file collapse into a single line. */
export const COLLAPSE_FROM = 2;

/** One row of the breakpoint list: a breakpoint, or the line a file's worth of stale ones collapses into. */
export interface BreakpointRow {
  key: string;
  label: string;
  /** the run cannot pause here: an unresolved breakpoint, or a file that is not in this run */
  muted: boolean;
  /** the breakpoint the row opens and removes; absent on a collapsed row */
  bp?: DebugSessionBreakpoint;
  /** a collapsed row: the file and how many breakpoints it holds */
  group?: { file: string; count: number };
}

/**
 * The breakpoint list as the view shows it (docs/design/debugger-product.md, 5.1): the ones the run
 * resolved first, then the ones it has not, muted and marked `not resolved yet` (the wording the
 * CLI's `break` uses). Breakpoints in a file this run never instrumented can never pause it, so
 * once the run has reported at least one file they collapse into one muted line per file: a session
 * debugging `-m api.main` should not show four breakpoints from another program with equal weight.
 *
 * `files` is the run's instrumented files as display paths. While it is empty (before the first
 * `file.instrumented`) nothing is collapsed: every unresolved breakpoint may still resolve.
 */
export function breakpointRows(list: readonly DebugSessionBreakpoint[], files: readonly string[] = []): BreakpointRow[] {
  const inRun = new Set(files);
  // two signals that the run can pause here: the runtime resolved the spec (`rid` / `resolvedLine`
  // on the echo), or the breakpoint's file is one the run instrumented
  const settled = (bp: DebugSessionBreakpoint): boolean => bp.rid !== undefined || bp.resolvedLine !== undefined || inRun.has(bp.file);
  const stale = new Set<string>();
  if (files.length) {
    const pending = new Map<string, number>();
    for (const bp of list) {
      if (!bp.file || settled(bp)) continue;
      // a function breakpoint names no file until it resolves: it is pending, not stale
      if (bp.function !== undefined && !bp.line) continue;
      pending.set(bp.file, (pending.get(bp.file) ?? 0) + 1);
    }
    for (const [file, count] of pending) {
      // one breakpoint is not clutter and may still resolve when a module loads; several in a file
      // the run never touched are another program's, and they crowded out the ones that can pause
      if (count >= COLLAPSE_FROM && !list.some((bp) => bp.file === file && settled(bp))) stale.add(file);
    }
  }
  const rows: BreakpointRow[] = [];
  const later: BreakpointRow[] = [];
  const collapsed = new Map<string, number>();
  for (const bp of list) {
    const key = `${bp.file}:${bp.line ?? bp.function ?? ''}`;
    if (stale.has(bp.file)) {
      collapsed.set(bp.file, (collapsed.get(bp.file) ?? 0) + 1);
      continue;
    }
    if (settled(bp)) rows.push({ key, label: breakpointLabel(bp), muted: false, bp });
    else later.push({ key, label: `${breakpointLabel(bp)}  (not resolved yet)`, muted: true, bp });
  }
  for (const [file, count] of collapsed) {
    later.push({ key: `group:${file}`, label: `${count} in ${file}, not in this run`, muted: true, group: { file, count } });
  }
  return [...rows, ...later];
}

/** What the add form makes: a value shown at every stop, or a watch that pauses the run. */
export type WatchMode = 'display' | 'true' | 'change';

/**
 * The `breakWhen` argument for a chosen mode. `display` is the absence of one, which is the
 * distinction the add form used to lose: it always called `onWatchAdd(exp)` and dropped the second
 * argument, so `+` could only ever make a displayed watch however the user meant it.
 */
export function watchArg(mode: WatchMode): 'change' | 'true' | undefined {
  return mode === 'display' ? undefined : mode;
}
