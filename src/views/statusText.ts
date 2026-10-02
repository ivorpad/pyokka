/**
 * The status bar's HTTP text (docs/PROTOCOL.md, "HTTP record and replay", Hosts): while the mode
 * is on it names the mode and what the last run did with it; while it is off it keeps the last
 * run's outcome. Pure; statusBar.ts appends both strings to every state's text and tooltip.
 */
import type { HttpMode, RunFinishedEvent } from '../shared/protocol';
import { exceptionText, type DebugState, type PausedInfo } from '../session/debugState';
import { basename } from '../session/httpTable';

type Finished = RunFinishedEvent['http'] | null | undefined;

/** The mode the last run had, from its tally or the older `replayed` flag. */
function lastMode(finished: Finished, replayed: boolean | undefined): HttpMode | undefined {
  return finished?.mode ?? (replayed ? 'replay' : undefined);
}

/**
 * ` · HTTP record[, N recorded]` / ` · HTTP replay[, N missing]` while the mode is on (` · last run
 * replayed` / ` · last run recorded N` when the last run had the other on-mode), ` · replayed[, N
 * missing]` / ` · recorded N` while it is off; '' when there is nothing to say. Never "replayed" next
 * to "HTTP replay".
 */
export function httpSegment(mode: HttpMode, finished: Finished, replayed: boolean | undefined): string {
  const last = lastMode(finished, replayed);
  const misses = finished?.misses ?? 0;
  const recorded = finished?.recorded ?? 0;
  if (mode === 'record') {
    if (last === 'record') return ` · HTTP record, ${recorded} recorded`;
    if (last === 'replay') return ' · HTTP record · last run replayed';
    return ' · HTTP record';
  }
  if (mode === 'replay') {
    if (last === 'replay') return misses > 0 ? ` · HTTP replay, ${misses} missing` : ' · HTTP replay';
    if (last === 'record') return ` · HTTP replay · last run recorded ${recorded}`;
    return ' · HTTP replay';
  }
  if (last === 'replay') return misses > 0 ? ` · replayed, ${misses} missing` : ' · replayed';
  if (last === 'record') return ` · recorded ${recorded}`;
  return '';
}

/** What the segment means, appended to the tooltip. */
export function httpTooltip(mode: HttpMode, finished: Finished, replayed: boolean | undefined): string {
  const last = lastMode(finished, replayed);
  const file = finished?.file ? basename(finished.file) : mode === 'record' || last === 'record' ? '.pyokka/replay/' : 'the recording';
  const misses = finished?.misses ?? 0;
  const recorded = finished?.recorded ?? 0;
  const missing = misses > 0 ? `; ${misses} ${misses === 1 ? 'request' : 'requests'} had no recorded response (run once with HTTP Record)` : '';
  if (mode === 'record') {
    const lastRun = last === 'record' ? `; the last run recorded ${recorded}` : last === 'replay' ? '; the last run replayed from it' : '';
    return ` · HTTP Record: the next run writes every HTTP exchange to ${file}${lastRun}`;
  }
  if (mode === 'replay') {
    const lastRun = last === 'replay' ? missing : last === 'record' ? `; the last run recorded ${recorded}` : '';
    return ` · HTTP Replay: the next run answers every request from ${file}; nothing reaches the network${lastRun}`;
  }
  if (last === 'replay') return ` · HTTP responses replayed from ${file}; no request reached the network${missing}`;
  if (last === 'record') return ` · HTTP exchanges recorded to ${file}; switch HTTP to Replay in Settings to re-run without the network`;
  return '';
}

/**
 * The debugger's segment: ` · Debug: paused at demo.py:42 (breakpoint)` while a debug run is paused,
 * ` · Debug: running` while one is in flight, '' otherwise (debug mode with no run says nothing).
 * An exception pause names it: ` · Debug: paused at demo.py:6 (uncaught ValueError: too big: 3)`.
 */
export function debugSegment(debug: DebugState, displayName: string, running: boolean): string {
  if (!debug.active) return '';
  const p = debug.paused;
  if (p) return ` · Debug: paused at ${displayName}${p.line !== null ? `:${p.line}` : ''} (${pauseReason(p)})`;
  return running ? ' · Debug: running' : '';
}

function pauseReason(p: PausedInfo): string {
  return p.exception ? exceptionText(p.exception) : p.reason;
}

/**
 * The Debugger's own status bar item (docs/design/debugger-product.md, 3.11):
 * `Debugger: paused at app.py:42 (breakpoint)`, `Debugger: paused at app.py:6 (uncaught
 * ValueError: too big: 3)`, `Debugger: running`. '' when there is no debug session, and the item
 * is then hidden. `debugSegment` above keeps serving the run-all item for a recording run.
 */
export function debuggerStatusText(debug: DebugState, displayName: string, running: boolean): string {
  const p = debug.paused;
  if (p) return `Debugger: paused at ${displayName}${p.line !== null ? `:${p.line}` : ''} (${pauseReason(p)})`;
  return running ? 'Debugger: running' : '';
}
