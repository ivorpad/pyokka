import { describe, expect, it } from 'vitest';
import { BLOCK_LINES, isElided, readOutput, stopOutput, stopSlice, type OutputCursor, type OutputRead, type StopSliceInputs } from '../../src/debug/debugSessionState';
import { OutputLog } from '../../src/session/outputBuffer';
import type { PausedInfo } from '../../src/session/debugState';

const APP = '/ws/app.py';
const LIB = '/ws/lib/rank.py';

/** `def do_GET` at 40, its body to 46, then module level again */
const SOURCE = [
  'import json', // 1
  '',
  'class Handler:', // 3
  '    def do_GET(self):',
  '        payload = parse(self.path)',
  '        total = 0',
  '        return total',
  '',
  'serve()', // 9
];

const PAUSE: PausedInfo = {
  step: 1403,
  rid: 88,
  fileId: 2,
  line: 6,
  scopeId: 7,
  depth: 2,
  reason: 'breakpoint',
  breakpoint: { path: APP, line: 6, rid: 88, fileId: 2, resolvedLine: 6 },
  thread: { name: 'Thread-3', ident: 6108209152 },
  stack: [
    { frameId: 0, name: 'do_GET', fileId: 2, line: 6 },
    { frameId: 1, name: 'handle_one_request', fileId: 0, line: 427 },
    { frameId: 2, name: '<module>', fileId: 2, line: 9 },
  ],
};

/** An output read as `stopReply` builds it: the whole window, nothing before it. */
function read(text: string, over: Partial<OutputRead> = {}): OutputRead {
  return { text, since: 'start', earlier: 0, seq: text.length, ...over };
}

function inputs(over: Partial<StopSliceInputs> = {}): StopSliceInputs {
  return {
    paused: PAUSE,
    pathForFileId: (fileId) => (fileId === 2 ? APP : fileId === 3 ? LIB : undefined),
    readSource: (fileId) => (fileId === 2 ? SOURCE : undefined),
    functionAt: (fileId, line) => (fileId === 2 && line >= 4 && line <= 7 ? { name: 'do_GET', bodyRange: [4, 0, 7, 0] } : undefined),
    output: read('listening on 8000\n'),
    modified: false,
    staleReason: null,
    errors: [],
    ...over,
  };
}

describe('stopSlice', () => {
  it('carries the pause, the location and no recording fields', () => {
    const s = stopSlice(inputs()) as unknown as Record<string, unknown>;
    expect(s['step']).toBe(1403);
    expect(s['location']).toEqual({ file: APP, line: 6, col: 0, function: 'do_GET', fileId: 2 });
    expect(s['values']).toEqual([]);
    expect(s['thread']).toEqual({ name: 'Thread-3', ident: 6108209152 });
    expect(s['modified']).toBe(false);
    // there is no trace: nothing to count, nothing to move to, no coverage
    expect('count' in s).toBe(false);
    expect('moves' in s).toBe(false);
    expect('coverage' in s).toBe(false);
  });

  it('builds the stack from the frame chain and folds the uninstrumented frames where they stand', () => {
    // dropping them silently made `do_GET \u2190 <module>` read as a call the program never made
    const s = stopSlice(inputs());
    expect(s.stack).toEqual([
      { file: APP, line: 6, function: 'do_GET', frameId: 0 },
      { elided: 1, where: 'library' },
      { file: APP, line: 9, function: '<module>', frameId: 2 },
    ]);
    expect(s.stack.filter(isElided)).toHaveLength(1);
  });

  it('counts a run of library frames as one marker and names the files it can', () => {
    const deep = stopSlice(
      inputs({
        paused: {
          ...PAUSE,
          stack: [
            { frameId: 0, name: 'do_GET', fileId: 2, line: 6 },
            { frameId: 1, name: 'send', fileId: 0, line: 91, path: '/ws/.venv/lib/python3.12/site-packages/httpx/_client.py' },
            { frameId: 2, name: 'request', fileId: 0, line: 12, path: '/ws/.venv/lib/python3.12/site-packages/httpx/_client.py' },
            { frameId: 3, name: 'create', fileId: 0, line: 44, path: '/ws/.venv/lib/python3.12/site-packages/openai/_base_client.py' },
            { frameId: 4, name: '<module>', fileId: 2, line: 9 },
          ],
        },
      }),
    );
    expect(deep.stack[1]).toEqual({ elided: 3, where: 'library', in: ['httpx/_client.py', 'openai/_base_client.py'] });
    // the stdlib is named by its module, not by the interpreter's layout around it
    const stdlib = stopSlice(
      inputs({ paused: { ...PAUSE, stack: [{ frameId: 0, name: 'do_GET', fileId: 2, line: 6 }, { frameId: 1, name: 'handle', fileId: 0, line: 427, path: '/opt/python/lib/python3.14/socketserver.py' }] } }),
    );
    expect(stdlib.stack[1]).toEqual({ elided: 1, where: 'library', in: ['socketserver.py'] });
    // a runtime that sends no path still counts them
    const bare = stopSlice(inputs({ paused: { ...PAUSE, stack: [{ frameId: 0, name: 'do_GET', fileId: 2, line: 6 }, { frameId: 1, name: 'send', fileId: 0, line: 91 }] } }));
    expect(bare.stack[1]).toEqual({ elided: 1, where: 'library' });
  });

  it("shows the enclosing function's source with `current` on the paused line", () => {
    const s = stopSlice(inputs());
    expect(s.block.function).toBe('do_GET');
    expect(s.block.file).toBe(APP);
    expect(s.block.lines.map((l) => l.line)).toEqual([4, 5, 6, 7]);
    expect(s.block.lines.find((l) => l.current)?.line).toBe(6);
    expect(s.block.capped).toBeUndefined();
    // no step on any line, and no firstStep: nothing was recorded
    expect(s.block.lines.every((l) => l.step === undefined)).toBe(true);
  });

  it('cuts a long function on its structure: the signature, then the suite the pause is in', () => {
    // 400 lines, a `for` at 301 whose body holds the pause: the window is that loop, not 30 lines
    // above and 30 below with half a statement at each end
    const long: string[] = Array.from({ length: 400 }, (_, i) => (i + 1 <= 300 ? '    filler = 1' : '        step = r'));
    long[0] = 'def big(rows):';
    long[300] = '    for r in rows:';
    for (let i = 340; i < 400; i++) long[i] = '    tail = 2';
    const opts = { paused: { ...PAUSE, line: 320 }, readSource: () => long, functionAt: () => ({ name: 'big', bodyRange: [1, 0, 400, 0] as [number, number, number, number] }) };
    const s = stopSlice(inputs(opts));
    const shown = s.block.lines.map((l) => l.line);
    expect(s.block.capped).toBe(true);
    expect(s.block.totalLines).toBe(400);
    expect(shown).toHaveLength(BLOCK_LINES);
    expect(shown[0]).toBe(1); // the signature stays however far down the pause is
    expect(shown).toContain(301); // the `for` header
    expect(shown).toContain(340); // the last line of its body
    expect(shown[shown.length - 1]).toBe(400); // and what the function answers with
    expect(s.block.lines.find((l) => l.current)?.line).toBe(320);
    // `--scope` lifts the cap
    const all = stopSlice(inputs(opts), { scope: true });
    expect(all.block.lines).toHaveLength(400);
    expect(all.block.capped).toBeUndefined();
  });

  it('keeps the suite header when the suite itself is over budget', () => {
    const long = Array.from({ length: 400 }, () => '        step = r');
    long[0] = 'def big(rows):';
    long[1] = '    for r in rows:';
    const s = stopSlice(
      inputs({ paused: { ...PAUSE, line: 320 }, readSource: () => long, functionAt: () => ({ name: 'big', bodyRange: [1, 0, 400, 0] }) }),
    );
    const shown = s.block.lines.map((l) => l.line);
    expect(shown[0]).toBe(1);
    expect(shown[1]).toBe(2); // `for r in rows:`, kept even though the body had to be cut
    expect(shown).toHaveLength(BLOCK_LINES);
    expect(shown).toContain(320);
    // the pause sits inside the window, not on its edge
    expect(shown[2]).toBeLessThan(320);
    expect(shown[shown.length - 1]).toBeGreaterThan(320);
  });

  it('centres a long module on the pause: a file has no signature to keep', () => {
    const long: string[] = Array.from({ length: 400 }, (_, i) => `value_${i} = ${i}`);
    const s = stopSlice(inputs({ paused: { ...PAUSE, line: 300, stack: [{ frameId: 0, name: '<module>', fileId: 2, line: 300 }] }, readSource: () => long, functionAt: () => undefined }));
    const shown = s.block.lines.map((l) => l.line);
    expect(s.block.function).toBe('<module>');
    expect(shown).toHaveLength(BLOCK_LINES);
    expect(s.block.totalLines).toBe(400);
    expect(shown[0]).toBeGreaterThan(260);
    expect(shown[0]).toBeLessThan(300);
    expect(shown[shown.length - 1]).toBeGreaterThan(300);
  });

  it('falls back to the file when no function encloses the line, and to nothing without source', () => {
    const top = stopSlice(inputs({ paused: { ...PAUSE, line: 9, stack: [{ frameId: 0, name: '<module>', fileId: 2, line: 9 }] }, functionAt: () => undefined }));
    expect(top.block.function).toBe('<module>');
    expect(top.block.lines).toHaveLength(SOURCE.length);
    const none = stopSlice(inputs({ readSource: () => undefined }));
    expect(none.block.lines).toEqual([]);
  });

  it('carries what the program printed since the previous stop, cut on a line boundary', () => {
    const first = stopSlice(inputs()).output;
    expect(first).toEqual({ text: 'listening on 8000\n', since: 'start', lines: 1, earlier: 0, truncated: false, seq: 18 });
    // a delta: only the new lines, and how many are behind them
    const next = stopSlice(inputs({ output: read('served /\n', { since: 'stop', earlier: 412, seq: 9_000 }) })).output;
    expect(next).toEqual({ text: 'served /\n', since: 'stop', lines: 1, earlier: 412, truncated: false, seq: 9_000 });
    // over the budget the cut lands on a line boundary and the cut lines are counted, not lost
    const many = Array.from({ length: 900 }, (_, i) => `row ${i}`).join('\n') + '\n';
    const cut = stopOutput(read(many, { since: 'stop' }), 100);
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith('row ')).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(100);
    expect(cut.lines + cut.earlier).toBe(900);
    // a single line longer than the budget has nowhere else to cut
    const one = stopOutput(read('x'.repeat(5_000)), 100);
    expect(one.text).toHaveLength(100);
    expect(one.truncated).toBe(true);
  });

  it('reports staleness, why, and the uncaught error the run ended with', () => {
    // the two reasons are separate warnings: `unsaved` means the block is the editor's buffer and
    // has never run, `disk` means the file moved under the run (bridgeDebugReply.ts `staleness`)
    expect(stopSlice(inputs()).stale).toBe(false);
    expect(stopSlice(inputs()).staleReason).toBeUndefined();
    expect(stopSlice(inputs({ staleReason: 'unsaved' })).stale).toBe(true);
    expect(stopSlice(inputs({ staleReason: 'unsaved' })).staleReason).toBe('unsaved');
    expect(stopSlice(inputs({ staleReason: 'disk' })).staleReason).toBe('disk');
    const s = stopSlice(inputs({ errors: [{ file: APP, line: 6, type: 'ValueError', message: 'too big: 3', step: 1403 }] }));
    expect(s.errors).toEqual([{ file: APP, line: 6, type: 'ValueError', message: 'too big: 3', step: 1403 }]);
  });
});

describe('readOutput', () => {
  const NONE: OutputCursor = { step: -1, from: 0, seq: 0 };

  function log(...lines: string[]): OutputLog {
    const l = new OutputLog();
    for (const line of lines) l.append('stdout', line, 0);
    return l;
  }

  it('gives the whole window at the first stop and the delta at every one after it', () => {
    // the first stop is the one no cursor has answered yet (`step: -1`), not the one at offset 0:
    // a stop after a stop that sat at 0 has a delta like any other
    const quietStart = readOutput(new OutputLog(), NONE, 99, false);
    expect(quietStart.read.since).toBe('start');
    const l = log('listening on 8000\n', 'served /\n');
    expect(readOutput(l, quietStart.cursor, 100, false).read).toEqual({ text: 'listening on 8000\nserved /\n', since: 'stop', earlier: 0, seq: 27 });

    const first = readOutput(l, NONE, 100, false);
    expect(first.read).toEqual({ text: 'listening on 8000\nserved /\n', since: 'start', earlier: 0, seq: 27, cut: false });

    l.append('stdout', 'served /x\n', 0);
    const second = readOutput(l, first.cursor, 101, false);
    expect(second.read.since).toBe('stop');
    expect(second.read.text).toBe('served /x\n');
    expect(second.read.earlier).toBe(2);

    // the same stop read twice answers the same delta: re-reading a pause must not eat it
    expect(readOutput(l, second.cursor, 101, false).read).toEqual(second.read);
    // including the first stop of a run, whose read was the window and stays the window: what a
    // thread printed since is in it too, which is why it is not the identical string
    const firstAgain = readOutput(l, first.cursor, 100, false).read;
    expect(firstAgain.since).toBe('start');
    expect(firstAgain.text.startsWith(first.read.text)).toBe(true);
    // and a step that printed nothing says so, rather than repeating the tail
    const quiet = readOutput(l, second.cursor, 102, false);
    expect(quiet.read).toEqual({ text: '', since: 'stop', earlier: 3, seq: l.seq });
  });

  it('answers the window for `scope`, and for a delta the log can no longer reach back to', () => {
    const l = log('a\n', 'b\n');
    const one = readOutput(l, NONE, 100, false);
    l.append('stdout', 'c\n', 0);
    expect(readOutput(l, one.cursor, 101, true).read).toEqual({ text: 'a\nb\nc\n', since: 'start', earlier: 0, seq: 6, cut: false });
    // a cursor the log has passed (a fresh run reset it) falls back to the window
    const ahead: OutputCursor = { step: 99, from: 0, seq: 9_000 };
    expect(readOutput(l, ahead, 101, false).read.since).toBe('start');
  });

  it('carries the line still being written, without counting it as committed', () => {
    const l = log('done\n');
    l.append('stdout', 'progress: 40%', 0); // no newline yet
    const read = readOutput(l, NONE, 100, false).read;
    expect(read.text).toBe('done\nprogress: 40%');
    expect(read.seq).toBe(5); // only `done\n` is committed; the open line is sent again when it ends
  });
});
