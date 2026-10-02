// End-to-end: the pyokka CLI drives the Debugger through this host's bridge on a copy of
// test/e2e/fixtures/debug_target.py. `debug --live` arrives on the run-all session's socket and the
// host starts a `record: false` debug session of its own (route (b) of 3.10): the pause belongs to
// that session, the run-all session is left alone, and the verbs that need a recording are refused.
// Then: break, continue to the breakpoint, locals and eval in the live frame, step --over, a
// break-when watch, state listing both sockets, the watch stream and the finish. Then, on a fresh
// start: debug with a breakpoint set stops there, restart replaces the child inside the same VS
// Code debug session, and stop ends it. Last, `shell --live` starts and drives a debug session over
// one connection, one command per stdin line.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const NAME = '_debug_live_e2e.py';
const LINE = { payload: 9, loop: 11, call: 12, add: 13, append: 14, print: 15 };

async function waitFor(pred, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Pyokka CLI --live drives the debugger', function () {
  this.timeout(180_000);
  let api, session, doc, file, python;
  let debugSessionId; // the VS Code debug session of the second start: a restart must keep it
  /** the `record: false` debug session the CLI's `debug` made; the pause lives there, not on `session` */
  const debugSession = () => api.debugSessions()[0];
  const config = () => vscode.workspace.getConfiguration('pyokka');

  function cli(args, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args, '--session', NAME], { cwd: PY_DIR });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`pyokka ${args.join(' ')} took over ${timeoutMs} ms; stdout=${stdout} stderr=${stderr}`));
      }, timeoutMs);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }
  async function json(...args) {
    const r = await cli([...args, '--json']);
    assert.equal(r.status, 0, `exit ${r.status} for ${args.join(' ')}: ${r.stdout} ${r.stderr}`);
    return JSON.parse(r.stdout);
  }
  /** The same, on one named socket: `cli` narrows by file name, which matches both kinds. */
  function cliOn(descriptor, args, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args, '--session', descriptor], { cwd: PY_DIR });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`pyokka ${args.join(' ')} took over ${timeoutMs} ms; stdout=${stdout} stderr=${stderr}`));
      }, timeoutMs);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'bridge descriptor');
  });

  after(async () => {
    for (const ds of api.debugSessions()) ds.dispose();
    if (session && !session.isDisposed) {
      session.stopDebug();
      await session.stopRun().catch(() => undefined);
    }
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  });

  it('debug --live starts a debug session of its own, paused at its first statement', async () => {
    const runId = session.state.runId;
    const r = await json('debug', '--live');
    assert.equal(r.paused.reason, 'start');
    assert.equal(r.paused.step, 0);
    assert.equal(r.paused.line, LINE.payload);
    assert.equal(r.paused.file, file, 'paused.file is absolute');
    assert.equal(r.step, 0);
    assert.equal(r.location.line, LINE.payload);
    assert.ok(Array.isArray(r.block.lines), 'the slice is there');
    assert.deepEqual(r.paused.stack.map((f) => f.name), ['<module>']);
    assert.equal(r.count, undefined, 'there is no trace to count');
    assert.equal(r.moves, undefined, 'and nothing to move through');
    assert.deepEqual(r.values, [], 'nothing is recorded');
    const ds = await waitFor(() => debugSession(), 'the debug session');
    assert.equal(api.debugSessions().length, 1);
    assert.equal(ds.debug.paused.step, 0);
    assert.equal(vscode.debug.activeDebugSession?.type, 'pyokka', 'the agent’s program shows in a VS Code debug session too');
    // the run-all session is untouched: no debug run, no Time Machine, its own run left alone
    assert.equal(api.debug(session).active, false, 'the run-all session has no debug run');
    assert.equal(session.nav.active, false, 'no Time Machine: nothing was recorded');
    assert.equal(session.state.runId, runId, 'and no new run of its own');
    // asking again while paused answers the same pause without starting anything
    const again = await json('debug', '--live');
    assert.equal(again.paused.step, 0);
    assert.equal(api.debugSessions().length, 1);
    const st = await json('state', '--live');
    assert.equal(st.kind, 'debug', 'state prefers the debug socket');
    assert.equal(st.debug.active, true);
    assert.equal(st.debug.paused.reason, 'start');
    assert.equal(st.debug.frontier, null, 'nothing to navigate');
    assert.equal(st.record, false);
  });

  it('break --live adds a breakpoint the gutter shows and the run resolves', async () => {
    const r = await json('break', '--live', `${NAME}:${LINE.add}`);
    assert.equal(r.breakpoints.length, 1);
    const bp = r.breakpoints[0];
    assert.equal(bp.file, NAME, 'workspace-relative');
    assert.equal(bp.line, LINE.add);
    assert.equal(bp.resolvedLine, LINE.add);
    assert.equal(bp.fileId, 1);
    assert.ok(vscode.debug.breakpoints.some((b) => b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath === file && b.location.range.start.line === LINE.add - 1), 'mirrored into VS Code');
    const listed = await json('break', '--live');
    assert.deepEqual(listed.breakpoints.map((b) => [b.file, b.line]), [[NAME, LINE.add]]);
    const text = await cli(['break', '--live']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^1 breakpoint\\n  ${NAME.replace('.', '\\.')}:${LINE.add}  -> resolved line ${LINE.add}\\n`));
  });

  it('continue --live stops at the breakpoint with the frame live: locals, eval, context', async () => {
    const r = await json('continue', '--live');
    assert.equal(r.paused.reason, 'breakpoint');
    assert.equal(r.paused.line, LINE.add);
    assert.equal(r.paused.breakpoint.file, NAME);
    assert.equal(r.location.line, LINE.add);
    assert.equal(r.block.function, '<module>', 'the enclosing block, with no step numbers');
    assert.ok(r.block.lines.some((l) => l.current && l.line === LINE.add), 'the paused line is marked');
    // the stop itself carries the frame and the output so far: no second call for either
    const stopNames = Object.fromEntries(r.locals.map((v) => [v.name, v.text]));
    assert.equal(stopNames.i, '0');
    assert.equal(stopNames.total, '0');
    assert.equal(typeof r.output.text, 'string');
    assert.equal(r.output.text, '', 'debug_target.py prints only at the end');
    assert.equal(r.output.truncated, false);
    const locals = await json('locals', '--live');
    const names = Object.fromEntries(locals.locals.map((v) => [v.name, v.text]));
    assert.equal(names.i, '0');
    assert.equal(names.total, '0');
    assert.equal(names.d, '0');
    assert.ok('payload' in names);
    assert.ok(locals.locals.find((v) => v.name === 'payload').valueBag, 'the JSON form asks for value bags');
    const text = await cli(['locals', '--live']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^(.+ = .+\n)+$/, 'one name = value per line');
    assert.match(text.stdout, /^i = 0$/m);
    const ev = await json('eval', '--live', '(i, total, payload["x"])');
    assert.equal(ev.text, '(0, 0, 0)');
    const ctx = await cli(['context', '--live']);
    assert.equal(ctx.status, 0, ctx.stderr);
    assert.match(ctx.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.add} \\(breakpoint\\)\\n`));
    assert.match(ctx.stdout, /\nlocals:\n(  .+\n)*  i = 0\n/);
    const ctxJson = await json('context', '--live');
    assert.equal(ctxJson.paused.reason, 'breakpoint');
    assert.ok(ctxJson.locals.some((v) => v.name === 'total'));
    // a displayed watch expression: the panel's, evaluated in the paused frame, its value in the reply
    const shown = await json('watches', '--live', '--add', 'total * 2');
    const dw = shown.watches.find((w) => w.exp === 'total * 2');
    assert.equal(dw.kind, 'display');
    assert.equal(dw.text, '0');
    assert.ok(debugSession().displayWatches.some((w) => w.exp === 'total * 2'), 'the Debugger view has the watch');
    const gone = await json('watches', '--live', '--remove', dw.id);
    assert.ok(!gone.watches.some((w) => w.exp === 'total * 2'));
    assert.ok(!debugSession().displayWatches.some((w) => w.exp === 'total * 2'));
  });

  it('step --live --over executes the program; the backward moves are refused without a recording', async () => {
    const before = debugSession().debug.paused.step;
    const r = await json('step', '--live', '--over');
    assert.equal(r.paused.reason, 'step');
    assert.equal(r.paused.kind, 'over');
    assert.equal(r.paused.line, LINE.append);
    assert.ok(r.paused.step > before);
    const into = await json('step', '--live', '--into');
    assert.equal(into.paused.line, LINE.loop, 'the loop header steps once per pass');
    // nothing was recorded, so there is nothing behind the pause to replay
    const descriptor = api.agentBridge.debugDescriptorFor(debugSession());
    assert.ok(descriptor, 'the debug descriptor is there');
    for (const flag of ['--back', '--back-over', '--back-out']) {
      const back = await cliOn(descriptor, ['step', '--live', flag]);
      assert.equal(back.status, 2, `${flag}: ${back.stdout} ${back.stderr}`);
      assert.match(back.stderr, /records nothing, so there is nothing behind the pause to replay/);
      assert.match(back.stderr, /into, over and out execute/);
    }
    const past = await cliOn(descriptor, ['step', '--live', '--to', String(into.paused.step + 50)]);
    assert.equal(past.status, 2);
    assert.match(past.stderr, /records nothing, so there is nothing behind the pause to replay/);
  });

  it('a break-when watch stops the run where the expression turns true', async () => {
    // `why` behind the pause needs a recording: debug-recording.test.js covers it
    const removed = await json('break', '--live', '--remove', `${NAME}:${LINE.add}`);
    assert.deepEqual(removed.breakpoints, []);
    const w = await json('watches', '--live', '--add', 'total > 2', '--break-when', 'true');
    assert.deepEqual(w.watches, [{ id: 'w1', exp: 'total > 2', breakWhen: 'true' }]);
    const listed = await json('watches', '--live');
    assert.equal(listed.watches.length, 1);
    const r = await json('continue', '--live');
    assert.equal(r.paused.reason, 'watch');
    assert.deepEqual(r.paused.watch, { id: 'w1', exp: 'total > 2', text: 'True' });
    assert.equal(r.paused.line, LINE.append, 'the statement after total += d on the pass where it passed 2');
    assert.equal((await json('eval', '--live', 'i')).text, '2');
    const st = await json('state', '--live');
    assert.equal(st.kind, 'debug');
    assert.equal(st.debug.paused.reason, 'watch');
    assert.equal(st.debug.frontier, null);
    assert.ok(st.others.some((o) => o.kind === 'run'), `the run-all session is listed: ${JSON.stringify(st.others)}`);
    const text = await cli(['state', '--live']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout.split('\n')[0], /^debug /, 'the debug session is listed first, and marked');
    assert.match(text.stdout.split('\n')[0], /\[this\]$/);
    assert.match(text.stdout, new RegExp(`paused at ${NAME.replace('.', '\\.')}:${LINE.append} \\(watch total > 2: True\\)`));
    assert.match(text.stdout, /^ {2}record: off$/m);
  });

  it('the watch stream reports the finish, and continue --live ends the run', async () => {
    const stream = spawn(python, ['-m', 'pyokka_runtime', 'watch', '--live', '--session', NAME], { cwd: PY_DIR });
    let out = '';
    let err = '';
    stream.stdout.setEncoding('utf8');
    stream.stderr.setEncoding('utf8');
    stream.stdout.on('data', (c) => (out += c));
    stream.stderr.on('data', (c) => (err += c));
    try {
      await sleep(500); // the watch request has no visible acknowledgement
      const removedWatch = await json('watches', '--live', '--remove', 'w1');
      assert.deepEqual(removedWatch.watches, []);
      const fin = await json('continue', '--live');
      assert.equal(fin.finished.exitCode, 0);
      assert.ok(fin.finished.stepCount > 20, `a complete run: ${fin.finished.stepCount} steps`);
      await waitFor(() => /^finished: exit 0$/m.test(out), `the finished line; stdout=${JSON.stringify(out)} stderr=${err}`);
      assert.match(out, /^resumed$/m);
      assert.match(out, /^output: 12$/m, 'the program printed 12 and the stream reported it');
      await waitFor(() => !vscode.debug.activeDebugSession, 'the VS Code debug session to end with the program');
      await waitFor(() => api.debugSessions().length === 0, 'the debug session to be gone when the program exits');
      // the debug descriptor is gone, so `state --live` falls back to the run-all socket
      const st = await json('state', '--live');
      assert.equal(st.kind, 'run');
      assert.equal(st.debug, null, 'the run-all session never had a debug run');
      assert.equal(st.finished, true);
      const text = await cli(['continue', '--live']);
      assert.equal(text.status, 2, 'nothing to continue once the program ended');
      assert.match(text.stderr, /no debug run is paused|not paused/);
    } finally {
      // the debug socket closes with the session, so the stream may already have ended by itself
      if (stream.exitCode === null) {
        stream.kill('SIGINT');
        await Promise.race([new Promise((r) => stream.on('exit', r)), sleep(5000)]);
      }
    }
  });

  it('debug --live with a breakpoint set runs to it instead of pausing at the first statement', async () => {
    const bp = await json('break', '--live', `${NAME}:${LINE.add}`);
    assert.deepEqual(bp.breakpoints.map((b) => [b.file, b.line]), [[NAME, LINE.add]]);
    const r = await json('debug', '--live');
    assert.equal(r.paused.reason, 'breakpoint');
    assert.equal(r.paused.line, LINE.add);
    assert.equal(r.paused.breakpoint.file, NAME);
    assert.equal(vscode.debug.activeDebugSession?.type, 'pyokka');
    debugSessionId = vscode.debug.activeDebugSession.id;
    assert.ok(debugSessionId, 'the debug session has an id');
    assert.equal(api.debugSessions().length, 1);
  });

  it('restart --live --stop-on-entry runs the file again from the first statement, in the same debug session', async () => {
    const id = debugSession().id;
    const r = await json('restart', '--live', '--stop-on-entry');
    assert.equal(r.paused.reason, 'start');
    assert.equal(r.paused.step, 0);
    assert.equal(r.paused.line, LINE.payload);
    assert.equal(vscode.debug.activeDebugSession?.type, 'pyokka');
    assert.equal(vscode.debug.activeDebugSession.id, debugSessionId, 'the child was replaced inside the debug session, not relaunched');
    assert.equal(debugSession().id, id, 'and inside the same Pyokka debug session');
  });

  it('a stop carries what the program printed since the previous stop, not the tail of the run', async () => {
    // the frame is live, so the cheapest program that prints on demand is the one we are paused in
    await json('exec', '--live', 'print("from the frame")');
    const printed = await json('step', '--live', '--over');
    assert.equal(printed.output.since, 'stop');
    assert.equal(printed.output.text, 'from the frame\n');
    assert.equal(printed.output.lines, 1);
    assert.equal(printed.output.truncated, false);
    // re-reading the same stop answers the same delta rather than eating it
    const reread = await json('debug', '--live');
    assert.equal(reread.output.text, 'from the frame\n', 'a second read of one stop shows it again');
    // the next step printed nothing, and the reply says so instead of repeating the line
    const quiet = await json('step', '--live', '--over');
    assert.equal(quiet.output.text, '');
    assert.equal(quiet.output.since, 'stop');
    assert.equal(quiet.output.earlier, 1, `the line is behind the delta, counted: ${JSON.stringify(quiet.output)}`);
    const text = await cli(['step', '--live', '--over']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^output: nothing new since the last stop \(1 line earlier; --scope for the window\)$/m);
    // --scope asks for the window instead of the delta
    const whole = await json('step', '--live', '--over', '--scope');
    assert.equal(whole.output.since, 'start');
    assert.equal(whole.output.text, 'from the frame\n');
  });

  it('restart --live without the flag stops at the breakpoint again', async () => {
    const r = await json('restart', '--live');
    assert.equal(r.paused.reason, 'breakpoint');
    assert.equal(r.paused.line, LINE.add);
    assert.equal(vscode.debug.activeDebugSession.id, debugSessionId);
  });

  it('stop --live ends the debug run and leaves the session with what it recorded', async () => {
    const r = await json('stop', '--live');
    assert.equal(r.stopped, true);
    assert.equal(typeof r.runId, 'string');
    assert.ok(r.finished.stepCount > 0, `the steps that ran before the stop: ${r.finished.stepCount}`);
    await waitFor(() => api.debugSessions().length === 0, 'the debug session to be gone');
    // with no debug descriptor left, `state --live` falls back to the run-all socket
    const st = await json('state', '--live');
    assert.equal(st.kind, 'run');
    assert.equal(st.debug, null, 'the run-all session never had a debug run');
    assert.equal(st.finished, true, 'its own run is there to read');
    await waitFor(() => !vscode.debug.activeDebugSession, 'the VS Code debug session to end with the program');
    const again = await json('stop', '--live');
    assert.equal(again.stopped, false);
    assert.ok(again.hint, 'it says what starts one');
    const nothing = await cli(['stop', '--live']);
    assert.equal(nothing.status, 0, 'nothing to stop is a reply, not an error');
    assert.match(nothing.stdout, /^nothing to stop: /m);
    // the text form of a real stop
    await json('debug', '--live', '--stop-on-entry');
    const text = await cli(['stop', '--live']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^stopped: exit .*, \d+ steps$/m);
  });

  it('restart --live with nothing in flight starts the run like debug', async () => {
    const r = await json('restart', '--live');
    assert.equal(r.paused.reason, 'breakpoint', 'the breakpoint is still set, so the fresh run goes to it');
    assert.equal(r.paused.line, LINE.add);
    assert.equal(vscode.debug.activeDebugSession?.type, 'pyokka');
    const stopped = await json('stop', '--live');
    assert.equal(stopped.stopped, true);
    const removed = await json('break', '--live', '--remove', `${NAME}:${LINE.add}`);
    assert.deepEqual(removed.breakpoints, []);
  });

  it('shell --live answers one command per stdin line over one connection', async () => {
    // the run is finished, debug mode is off and no breakpoint is left: the case above saw to that
    const child = spawn(python, ['-m', 'pyokka_runtime', 'shell', '--live', '--session', NAME, '--json'], { cwd: PY_DIR });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    let err = '';
    let rest = '';
    const ready = [];
    let waiting = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (err += c));
    child.stdout.on('data', (c) => {
      rest += c;
      for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
        const line = rest.slice(0, i).trim();
        rest = rest.slice(i + 1);
        if (!line) continue;
        if (waiting) {
          const take = waiting;
          waiting = null;
          take(line);
        } else ready.push(line);
      }
    });
    const nextLine = (timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        if (ready.length) return resolve(ready.shift());
        const timer = setTimeout(() => {
          waiting = null;
          reject(new Error(`the shell sent no reply line in ${timeoutMs} ms; stderr=${err}`));
        }, timeoutMs);
        waiting = (line) => {
          clearTimeout(timer);
          resolve(line);
        };
      });
    // one line at a time, the next only once the reply to this one is in
    const send = async (line) => {
      const started = performance.now();
      child.stdin.write(`${line}\n`);
      const reply = await nextLine();
      return { ms: performance.now() - started, doc: JSON.parse(reply) };
    };
    try {
      // one one-shot command for the comparison; it also gives the shell time to connect
      const started = performance.now();
      await json('state', '--live');
      const oneShotMs = performance.now() - started;

      const st = await send('state');
      assert.equal(st.doc.finished, true, 'the run of the case above is there to read');
      assert.ok('debug' in st.doc, 'the state shape the one-shot prints');
      const dbg = await send('debug --stop-on-entry');
      assert.equal(dbg.doc.paused.reason, 'start');
      assert.equal(dbg.doc.paused.step, 0);
      assert.equal(api.debugSessions().length, 1, 'the shell started a debug session over its connection');
      // the pause verbs on the same connection address that session, not the run-all one
      const loc = await send('locals');
      assert.ok(Array.isArray(loc.doc.locals), `the paused frame: ${JSON.stringify(loc.doc)}`);
      const stopped = await send('stop');
      assert.equal(stopped.doc.stopped, true);
      await waitFor(() => api.debugSessions().length === 0, 'the debug session to end with the stop');
      console.log(`      one-shot state --live ${oneShotMs.toFixed(1)} ms · shell state ${st.ms.toFixed(1)} ms · shell locals ${loc.ms.toFixed(1)} ms`);
      assert.ok(st.ms < 1000, `state over the shell took ${st.ms.toFixed(1)} ms`);
      assert.ok(loc.ms < 1000, `locals over the shell took ${loc.ms.toFixed(1)} ms`);
      child.stdin.write('exit\n');
      assert.equal(await exited, 0, `the shell ended on exit; stderr=${err}`);
    } finally {
      child.kill();
    }
  });
});
