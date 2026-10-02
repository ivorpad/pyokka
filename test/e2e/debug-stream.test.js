// End-to-end: the Debugger view's output stream against a *running* child
// (docs/design/debugger-product.md, 5.6). Everything else that covers this is a unit test over
// fixtures or the headless preview harness; until this spec there was nothing that had watched
// `debug.output.append` come out of a real process, and the handoff that asked for it said so.
//
// The contract is the chain: every delta starts at the offset the view holds, so the view can
// append rather than re-render 64 KB ten times a second. A delta that does not start there is a
// gap, and the view answers it with `debug.output.resync`. Both halves are checked here — a
// program that prints steadily must produce no gap at all, and one that prints more than the
// window between two flushes must be recovered by a full resend rather than a silent hole.
//
// Everything is asserted while the program is still running, which is the point: a debug session
// is disposed the moment its child exits and takes the panel state with it. The fixture holds
// without printing so there is something to look at, and each case stops it when it is done.
//
// The spec replays the messages exactly as webview/model.ts reduces them, so what it asserts is
// what the panel would actually be showing.
// Target: test/e2e/fixtures/debug_stream.py, copied into the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_stream.py');
const NAME = '_debug_stream_e2e.py';
/** OUTPUT_KEPT in src/session/outputBuffer.ts: the window a delta can still cover */
const OUTPUT_KEPT = 64 * 1024;
/** long enough that no case races the child's exit, short enough that a leaked one dies on its own */
const HOLD_S = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * The view's side of 5.6, as webview/model.ts reduces it: `debug.session` replaces the window,
 * `debug.output.append` extends it when it starts where the view is, and anything else is a gap
 * the view can only answer by asking for the whole state again.
 */
function replay(messages) {
  let held = null;
  let gaps = 0;
  let resends = 0;
  for (const m of messages) {
    if (m.type === 'debug.session') {
      if (!m.state) {
        held = null;
        continue;
      }
      if (held) resends++;
      held = { id: m.state.id, chunks: [...m.state.output], open: m.state.outputOpen, seq: m.state.outputSeq, dropped: m.state.outputDropped };
      continue;
    }
    if (m.type !== 'debug.output.append') continue;
    if (!held || held.id !== m.id) continue;
    if (m.from !== held.seq) {
      gaps++; // the view posts `debug.output.resync` here and waits for a full state
      continue;
    }
    held.chunks.push(...m.chunks);
    held.open = m.open;
    held.seq = m.seq;
    held.dropped = m.dropped;
  }
  return { held, gaps, resends };
}

const text = (chunks) => chunks.map((c) => c.text).join('');
const shown = (state) => text(state.output) + (state.outputOpen?.text ?? '');

describe('the Debugger view streams a running program as deltas', function () {
  this.timeout(240_000);
  let api, root, file, tap, seen;

  const ds = () => api.debugSessions()[0];
  const config = () => vscode.workspace.getConfiguration('pyokka');
  const appends = () => seen.filter((m) => m.type === 'debug.output.append');

  /** Start the fixture, and wait until it has printed everything and is holding. */
  async function runAndHold(args) {
    seen = [];
    await api.startDebugSession({ program: file, args: [...args, String(HOLD_S)], cwd: root, stopOnEntry: false });
    const session = await waitFor(() => ds(), 'the debug session');
    await waitFor(() => api.debugPanelState() && shown(api.debugPanelState()).includes('done\n'), 'the program to print everything', 120_000);
    await sleep(300); // the last flush is throttled to 100 ms
    return session;
  }

  async function endAll() {
    for (const s of api.debugSessions()) s.stopDebug();
    await waitFor(() => api.debugSessions().length === 0, 'the debug sessions to end');
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    tap = api.onPanelMessage((m) => seen?.push(m));
  });

  after(async () => {
    tap?.dispose();
    await endAll().catch(() => undefined);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  });

  describe('a program that prints steadily', function () {
    let state;

    before(async () => {
      // 6 lines * 12 dots * 20 ms is well over a second of printing: many 100 ms flushes, and the
      // dots make an open line that grows for a while without ever committing
      await runAndHold(['6', '12', '0']);
      state = api.debugPanelState();
      assert.ok(state, 'the panel has the running session');
      assert.ok(!state.paused, 'and it is running, not paused: this is the case nothing had covered');
    });

    after(endAll);

    it('arrives as a chain of deltas, and never sends the whole window again', () => {
      const { held, gaps, resends } = replay(seen);
      assert.ok(held, 'the view holds a state');
      assert.equal(gaps, 0, `a steadily printing program must never make the view resync; ${gaps} of ${appends().length} deltas did not chain`);
      assert.ok(appends().length >= 3, `expected the output to arrive in several deltas, got ${appends().length}`);
      // the host does send full states while the session is starting — `run.started`,
      // `file.instrumented` and the rest each push one — but they land before the program has
      // printed anything, so the window they carry is empty. What 5.6 removed is resending a
      // *full* window, and once output exists nothing goes out but deltas.
      const first = seen.findIndex((m) => m.type === 'debug.output.append');
      const starting = seen.slice(0, first).filter((m) => m.type === 'debug.session' && m.state);
      assert.ok(
        starting.every((m) => m.state.output.length === 0),
        `a full state sent while starting must carry nothing, got ${starting.map((m) => text(m.state.output).length).join(',')}`,
      );
      const late = seen.slice(first).filter((m) => m.type === 'debug.session');
      assert.equal(late.length, 0, `once the program prints, only deltas go out; ${late.length} full states did not`);
      assert.ok(resends <= starting.length, 'and every full resend was one of those');
      assert.equal(held.dropped, 0, 'nothing was cut: well under the 64 KB window');
      assert.match(text(held.chunks), /^line 0\n/, 'the first committed line');
      assert.match(text(held.chunks), /\nline 5\n/, 'and the last');
    });

    it('leaves the view holding exactly what the host holds', () => {
      const { held } = replay(seen);
      assert.equal(text(held.chunks), text(state.output), 'replaying the deltas gives the same window');
      assert.equal(held.seq, state.outputSeq, 'and the same offset');
      assert.equal(held.dropped, state.outputDropped);
    });

    it('tags stdout and stderr as separate chunks, never merged into one row', () => {
      const { held } = replay(seen);
      assert.deepEqual([...new Set(held.chunks.map((c) => c.stream))].sort(), ['stderr', 'stdout'], 'both streams are in the log');
      const err = held.chunks.filter((c) => c.stream === 'stderr');
      assert.match(text(err), /^warn 0\n/, 'stderr carries only what was written to stderr');
      assert.ok(!text(err).includes('line '), 'no stdout leaked into an stderr chunk');
      for (const c of held.chunks) assert.ok(c.text.endsWith('\n'), `a committed chunk is whole lines, got ${JSON.stringify(c.text.slice(-20))}`);
    });

    it('grows the open line in place and commits it exactly once', () => {
      // a line with no newline yet is sent as `open`, not as a chunk: the view redraws one row
      // rather than adding one per flush, which is what makes a token stream readable
      const opens = appends()
        .map((m) => m.open)
        .filter((o) => o && /^\.+$/.test(o.text));
      assert.ok(opens.length >= 2, `expected the growing run of dots to be sent as an open line, saw ${opens.length}`);
      const lengths = opens.map((o) => o.text.length);
      assert.ok(Math.max(...lengths) > Math.min(...lengths), `the open line must grow between flushes, saw ${lengths.join(',')}`);
      assert.ok(
        lengths.some((n) => n > 0 && n < 12),
        `the open line must be seen part-grown, not only complete, saw ${lengths.join(',')}`,
      );

      const { held } = replay(seen);
      const rows = text(held.chunks).match(/^\.+$/gm) ?? [];
      assert.equal(rows.length, 6, 'each open line committed exactly once, as one row per loop');
      assert.ok(
        rows.every((r) => r.length === 12),
        `each committed row holds the whole open line, got ${rows.map((r) => r.length).join(',')}`,
      );
    });

    it('counts the bytes and the moment of the last one, for the activity row', () => {
      assert.ok(state.lastOutputAt !== null, 'the view can say when the last byte arrived');
      assert.ok(state.lastOutputAt <= state.elapsed, 'and it is within the run');
      assert.ok(shown(state).length > 100, 'there is a window to show');
    });
  });

  describe('a program that prints past the 64 KB window', function () {
    let state;

    before(async () => {
      // ~132 KB with no sleep at all: more than the window arrives inside one 100 ms flush, so
      // what the view missed is gone from the head and `since()` can no longer answer
      await runAndHold(['0', '0', '1000']);
      state = api.debugPanelState();
      assert.ok(state, 'the panel has the burst session');
    });

    after(endAll);

    it('cuts the head and says how much it cut', () => {
      assert.ok(state.outputDropped > 0, `the head must have been cut, dropped=${state.outputDropped}`);
      assert.ok(text(state.output).length <= OUTPUT_KEPT, `the window is still bounded, got ${text(state.output).length}`);
    });

    it('recovers the view by a full resend rather than a delta it cannot apply', () => {
      const { held, gaps } = replay(seen);
      assert.ok(held, 'the view holds a state after the burst');
      assert.equal(gaps, 0, `the host must resend rather than send a delta the view cannot apply; ${gaps} deltas did not chain`);
      assert.equal(text(held.chunks), text(state.output), 'the view ends holding exactly what the host holds');
      assert.equal(held.dropped, state.outputDropped, 'and knows how much was cut');
    });

    it('keeps the tail and drops the head, with nothing pretending otherwise', () => {
      const { held } = replay(seen);
      assert.match(text(held.chunks) + (held.open?.text ?? ''), /done\n$/, 'the last line the program printed is there');
      assert.ok(!text(held.chunks).includes('burst 0 '), 'the head of the burst was dropped, not silently kept');
      assert.ok(text(held.chunks).includes(`burst 999 `), 'the end of the burst survived');
    });
  });
});
