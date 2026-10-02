/**
 * The Debugger view's output rows: what `output.split('\n').slice(-500)` could not express
 * (docs/design/debugger-product.md, 5.6).
 */
import { describe, expect, it } from 'vitest';
import { activity, buildRows, duration, GAP_MS, rowsText, size, visibleRows } from '../../../webview/outputLines';
import type { DebugOutputChunk } from '../../../webview/src-shared';

const out = (text: string, t = 0): DebugOutputChunk => ({ stream: 'stdout', text, t });
const err = (text: string, t = 0): DebugOutputChunk => ({ stream: 'stderr', text, t });
const plain = (rows: { spans: { text: string }[] }[]): string[] => rows.map((r) => r.spans.map((s) => s.text).join(''));

describe('buildRows', () => {
  it('makes one row per line and keeps the stream each came from', () => {
    const rows = buildRows([out('one\ntwo\n', 10), err('boom\n', 20)], null);
    expect(plain(rows)).toEqual(['one', 'two', 'boom']);
    expect(rows.map((r) => r.stream)).toEqual(['stdout', 'stdout', 'stderr']);
  });

  it('marks the trailing line open, which is what a token stream is', () => {
    const rows = buildRows([out('Turn 3: done\n', 10)], out('Turn 4: Noted — a window', 900));
    expect(plain(rows)).toEqual(['Turn 3: done', 'Turn 4: Noted — a window']);
    expect(rows.map((r) => r.open)).toEqual([false, true]);
  });

  it('has no open row when the last byte was a newline', () => {
    const rows = buildRows([out('done\n', 10)], null);
    expect(rows.every((r) => !r.open)).toBe(true);
  });

  it('stamps a row with when its first byte arrived', () => {
    const rows = buildRows([out('a\n', 100), out('b\n', 2_000)], null);
    expect(rows.map((r) => r.t)).toEqual([100, 2_000]);
  });

  it('prints the clock only where it changes, so one print() is marked once not ten times', () => {
    // a print() of ten lines is one chunk: every row carries the same t, and stamping all ten
    // repeated one value down the gutter and read as noise
    const rows = buildRows([out('one\ntwo\nthree\n', 67_000), out('later\n', 71_000)], null);
    expect(rows.map((r) => r.clock)).toEqual(['1m 07s', null, null, '1m 11s']);
  });

  it('leaves the gutter empty on the open line while it grows under one clock', () => {
    const rows = buildRows([out('done\n', 5_000)], out('streaming', 5_000));
    expect(rows.map((r) => r.clock)).toEqual(['5.0s', null]);
  });

  it('marks a silence between the rows either side of it', () => {
    const rows = buildRows([out('before\n', 0), out('after\n', GAP_MS + 500)], null);
    expect(rows[0]!.gap).toBeUndefined();
    expect(rows[1]!.gap).toBe(GAP_MS + 500);
  });

  it('shows the last repaint of a line, not every frame of a progress bar', () => {
    const rows = buildRows([out('10%\r55%\r100%\n', 0)], null);
    expect(plain(rows)).toEqual(['100%']);
  });

  it('decodes colour instead of printing the escape', () => {
    const rows = buildRows([out('\x1b[31mfail\x1b[0m ok\n', 0)], null);
    expect(plain(rows)).toEqual(['fail ok']);
    expect(rows[0]!.spans[0]!.style.fg).toBe('var(--vscode-terminal-ansiRed)');
  });

  it('carries a colour opened on one line into the next', () => {
    const rows = buildRows([out('\x1b[33mfirst\nsecond\x1b[0m\n', 0)], null);
    expect(rows[1]!.spans[0]!.style.fg).toBe('var(--vscode-terminal-ansiYellow)');
  });

  it('keeps only the last rows, however many lines the run printed', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const rows = buildRows([out(`${many}\n`, 0)], null, 10);
    expect(rows).toHaveLength(10);
    expect(plain(rows)[0]).toBe('line 40');
  });
});

describe('visibleRows', () => {
  it('hides stderr without rebuilding the rows', () => {
    const rows = buildRows([out('answer\n', 0), err('INFO:httpx:POST /v1/responses\n', 10)], null);
    expect(plain([...visibleRows(rows, true)])).toHaveLength(2);
    expect(plain([...visibleRows(rows, false)])).toEqual(['answer']);
  });
});

describe('rowsText', () => {
  it('gives Copy the text without the clocks or the styling', () => {
    const rows = buildRows([out('\x1b[32mone\x1b[0m\ntwo\n', 0)], null);
    expect(rowsText(rows)).toBe('one\ntwo');
  });
});

describe('activity', () => {
  it('buckets what arrived, and reports nothing for a run that has gone quiet', () => {
    const chunks = [out('12345', 9_600), out('123', 9_900)];
    const trace = activity(chunks, null, 10_000, 4, 500);
    expect(trace).toHaveLength(4);
    expect(trace.reduce((a, b) => a + b, 0)).toBe(8);

    const quiet = activity(chunks, null, 40_000, 4, 500);
    expect(quiet.every((v) => v === 0)).toBe(true);
  });

  it('counts the open line, which during a token stream is all there is', () => {
    expect(activity([], out('streaming', 900), 1_000, 4, 500).reduce((a, b) => a + b, 0)).toBe(9);
  });
});

describe('the readings beside the trace', () => {
  it('says a duration the way a reader watching a run would', () => {
    expect(duration(0)).toBe('0.0s');
    expect(duration(430)).toBe('0.4s');
    expect(duration(12_400)).toBe('12.4s');
    expect(duration(185_000)).toBe('3m 05s');
  });

  it('says a size', () => {
    expect(size(812)).toBe('812 B');
    expect(size(1536)).toBe('1.5 kB');
    expect(size(2.3 * 1024 * 1024)).toBe('2.3 MB');
  });
});
