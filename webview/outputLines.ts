/**
 * The Debugger view's output pane, as data: the host's tagged chunks turned into the rows the pane
 * paints (docs/design/debugger-product.md, 5.6). Pure, so vitest covers it
 * (test/unit/webview/outputLines.test.ts).
 *
 * Three things the old `output.split('\n').slice(-500)` could not do. A row knows which stream it
 * came from, so stderr is not mixed in with the program's answer. A row knows when it arrived, so
 * the pane can print a clock and mark a gap. And the last row can be *open* — a line the program is
 * still writing, which is what `print(delta, end="")` produces and what the line-counted tail
 * defeated entirely, because a token stream is one line however long it runs.
 */
import { decodeAnsi, PLAIN, type Span, type SgrStyle } from './ansi';
import type { DebugOutputChunk } from './src-shared';

/** How many rows the pane keeps. The 64 KB cap is the host's; this is a render guard. */
export const MAX_ROWS = 2000;

/** A gap longer than this gets a marker between the rows either side of it. */
export const GAP_MS = 3000;

export interface OutputRow {
  /** stable across repaints so the list diffs instead of rebuilding */
  key: number;
  stream: 'stdout' | 'stderr';
  /** ms since the run started, when this row's first byte arrived */
  t: number;
  spans: Span[];
  /** the program has not ended this line yet */
  open: boolean;
  /** ms of silence before this row, when it is worth saying */
  gap?: number;
  /**
   * The clock to print beside this row, or null to leave the gutter empty. A `print()` of ten lines
   * arrives as one chunk and every row carries the same `t`, so stamping all ten repeats one value
   * down the column and reads as noise: the clock is shown when it changes, which is also what makes
   * it useful — it marks where a burst began.
   */
  clock: string | null;
}

/**
 * Build the pane's rows. `chunks` is the committed window and `open` the line still being written;
 * the host sends the open line whole every time, so it is simply the last row.
 */
export function buildRows(chunks: readonly DebugOutputChunk[], open: DebugOutputChunk | null, limit = MAX_ROWS): OutputRow[] {
  const rows: OutputRow[] = [];
  let style: SgrStyle = PLAIN;
  let key = 0;

  // every committed chunk ends on a newline (OutputLog.append), so a chunk is always whole lines
  // and a row never has to be joined across two of them
  const push = (stream: 'stdout' | 'stderr', text: string, t: number, isOpen: boolean): void => {
    const { spans, end } = decodeAnsi(text, style);
    style = end;
    rows.push({ key: key++, stream, t, spans, open: isOpen, clock: null });
  };

  for (const c of chunks) {
    // a committed chunk ends on a newline, but may hold many lines
    const parts = c.text.split('\n');
    const trailing = parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
    for (let i = 0; i < trailing; i++) push(c.stream, repaint(parts[i]!), c.t, false);
  }
  if (open) push(open.stream, repaint(open.text), open.t, true);

  markGaps(rows);
  const kept = rows.length > limit ? rows.slice(rows.length - limit) : rows;
  markClocks(kept);
  return kept;
}

/** Stamp the clock only where it changes, so a burst of lines is marked once rather than ten times. */
function markClocks(rows: OutputRow[]): void {
  let last: string | null = null;
  for (const row of rows) {
    const now = duration(row.t);
    row.clock = now === last ? null : now;
    last = now;
  }
}

/**
 * A carriage return means the program repainted the line: keep only what follows the last one, the
 * way a terminal shows a progress bar rather than every frame of it.
 */
function repaint(line: string): string {
  const at = line.lastIndexOf('\r');
  return at === -1 ? line : line.slice(at + 1);
}

/** Stamp each row with the silence before it, when it is long enough to be worth a marker. */
function markGaps(rows: OutputRow[]): void {
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i]!.t - rows[i - 1]!.t;
    if (gap >= GAP_MS) rows[i]!.gap = gap;
  }
}

/** The rows the pane shows: stderr can be filtered out without rebuilding them. */
export function visibleRows(rows: readonly OutputRow[], showStderr: boolean): readonly OutputRow[] {
  return showStderr ? rows : rows.filter((r) => r.stream === 'stdout');
}

/** Every row's text, for Copy. */
export function rowsText(rows: readonly OutputRow[]): string {
  return rows.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
}

/**
 * Characters per bucket over the last `buckets * bucketMs`, for the activity trace: the cheapest
 * honest answer to "is it alive, or is it stuck?" during a long await.
 */
export function activity(chunks: readonly DebugOutputChunk[], open: DebugOutputChunk | null, now: number, buckets = 40, bucketMs = 500): number[] {
  const out = new Array<number>(buckets).fill(0);
  const from = now - buckets * bucketMs;
  const add = (t: number, n: number): void => {
    if (t < from) return;
    const i = Math.min(buckets - 1, Math.floor((t - from) / bucketMs));
    out[i] = (out[i] ?? 0) + n;
  };
  for (const c of chunks) add(c.t, c.text.length);
  if (open) add(open.t, open.text.length);
  return out;
}

/** `0.0s`, `12.4s`, `3m 05s`: how long the program has been quiet, or how long it has run. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** `812 B`, `1.5 kB`, `2.3 MB`. */
export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
