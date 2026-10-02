/**
 * `OutputLog`: the Debugger view's output window kept as tagged, redacted chunks so the view can be
 * sent what is new instead of the whole 64 KB ten times a second
 * (docs/design/debugger-product.md, 5.6).
 */
import { describe, expect, it } from 'vitest';
import { OUTPUT_KEPT, OutputLog } from '../../src/session/outputBuffer';

const text = (log: OutputLog): string => log.all().map((c) => c.text).join('');

describe('OutputLog', () => {
  it('commits whole lines and keeps the rest as the open line', () => {
    const log = new OutputLog();
    log.append('stdout', 'one\ntw', 10);
    expect(text(log)).toBe('one\n');
    expect(log.openLine()).toEqual({ stream: 'stdout', text: 'tw', t: 10 });

    log.append('stdout', 'o\n', 20);
    expect(text(log)).toBe('one\ntwo\n');
    expect(log.openLine()).toBeNull();
  });

  it('stamps the open line with when it started, not when it last grew', () => {
    const log = new OutputLog();
    log.append('stdout', 'Turn 4: ', 1000);
    log.append('stdout', 'Noted', 1400);
    log.append('stdout', ' — window seat', 1900);
    // a token stream is one line: it began at 1000 and the pane places it there
    expect(log.openLine()).toEqual({ stream: 'stdout', text: 'Turn 4: Noted — window seat', t: 1000 });
    expect(log.lastOutputAt).toBe(1900);
  });

  it('coalesces writes to one stream inside the window and splits them across streams', () => {
    const log = new OutputLog();
    log.append('stdout', 'a\n', 0);
    log.append('stdout', 'b\n', 40);
    expect(log.all()).toHaveLength(1);

    log.append('stderr', 'warning\n', 60);
    expect(log.all()).toHaveLength(2);
    expect(log.all()[1]!.stream).toBe('stderr');
  });

  it('ends an open line when the other stream writes, so the two are never one row', () => {
    const log = new OutputLog();
    log.append('stdout', 'no newline here', 0);
    log.append('stderr', 'Traceback\n', 10);
    // every committed chunk ends on a newline, which is what lets a reader treat one as whole lines
    for (const c of log.all()) expect(c.text.endsWith('\n')).toBe(true);
    expect(text(log)).toBe('no newline here\nTraceback\n');
  });

  describe('deltas', () => {
    it('hands back only what a holder of `seq` has not seen', () => {
      const log = new OutputLog();
      log.append('stdout', 'first\n', 0);
      const seq = log.seq;
      log.append('stdout', 'second\n', 500);

      expect(log.since(log.seq)).toEqual([]);
      expect(log.since(seq)!.map((c) => c.text).join('')).toBe('second\n');
      expect(log.since(0)!.map((c) => c.text).join('')).toBe('first\nsecond\n');
    });

    it('asks for a resync when the caller is ahead, or when what it missed was cut', () => {
      const log = new OutputLog(64);
      log.append('stdout', 'x'.repeat(200) + '\n', 0);
      expect(log.since(0)).toBeNull(); // the head is long gone

      const fresh = new OutputLog();
      fresh.append('stdout', 'a\n', 0);
      const ahead = fresh.seq;
      fresh.reset();
      expect(fresh.since(ahead)).toBeNull(); // a run the caller did not see start
    });

    it('never sends the open line as a delta: it is whole every time', () => {
      const log = new OutputLog();
      log.append('stdout', 'tok', 0);
      const seq = log.seq;
      log.append('stdout', 'en', 200);
      expect(log.since(seq)).toEqual([]); // nothing committed
      expect(log.openLine()!.text).toBe('token');
    });
  });

  describe('the kept window', () => {
    it('cuts the head to the limit and counts what it dropped', () => {
      const log = new OutputLog(64);
      log.append('stdout', `${'a'.repeat(100)}\n`, 0);
      expect(text(log)).toHaveLength(64);
      expect(log.dropped).toBe(37);
      expect(log.bytes).toBe(101); // what the program printed, cut or not
    });

    it('defaults to the 64 KB both products keep', () => {
      const log = new OutputLog();
      log.append('stdout', `${'x'.repeat(OUTPUT_KEPT * 2)}\n`, 0);
      expect(text(log)).toHaveLength(OUTPUT_KEPT);
    });

    it('stays linear on one very long line, which is what a token stream is', () => {
      // redact() backtracks quadratically in the length of its input: 64 KB on one line took 2.4 s
      // before it was sliced, on every flush, for as long as the program kept printing
      const log = new OutputLog();
      const started = Date.now();
      for (let i = 0; i < 400; i++) {
        log.append('stdout', 'token delta ', i * 10);
        log.openLine(); // what a flush costs
      }
      expect(Date.now() - started).toBeLessThan(1000);
      expect(log.openLine()!.text).toHaveLength(400 * 12);
    });
  });

  describe('redaction', () => {
    it('redacts a committed line', () => {
      const log = new OutputLog();
      log.append('stdout', 'key=sk-abcdefghijklmnopqrstuvwx\n', 0);
      expect(text(log)).not.toContain('sk-abcdefghij');
      expect(text(log)).toContain('«redacted»');
    });

    it('redacts the open line too, so a token stream never shows a secret mid-write', () => {
      const log = new OutputLog();
      log.append('stdout', 'token: hunter2secret', 0);
      expect(log.openLine()!.text).not.toContain('hunter2secret');
    });

    it('sees the previous line as context, which is how `key:` on one line reaches its value on the next', () => {
      const log = new OutputLog();
      log.append('stdout', 'password:\n', 0);
      log.append('stdout', 'hunter2secret\n', 10);
      // the whole-buffer rescan used to catch this for free; the lookback is what replaces it
      expect(text(log)).not.toContain('hunter2secret');
    });

    it('does not let the context leak into what it hands out', () => {
      const log = new OutputLog();
      log.append('stdout', 'alpha\n', 0);
      log.append('stdout', 'beta\n', 10);
      expect(text(log)).toBe('alpha\nbeta\n');
    });
  });

  it('forgets everything on a fresh run', () => {
    const log = new OutputLog();
    log.append('stdout', 'old\n', 0);
    log.append('stdout', 'open', 10);
    log.reset();
    expect(log.all()).toEqual([]);
    expect(log.openLine()).toBeNull();
    expect(log.seq).toBe(0);
    expect(log.bytes).toBe(0);
    expect(log.dropped).toBe(0);
    expect(log.lastOutputAt).toBeNull();
  });
});
