// End-to-end: the recording debugger pauses a run at its frontier (start, breakpoint, step), the
// frame is live there (evaluate, locals), the Time Machine replays behind it, and the run finishes
// normally. `api.startDebug(session)` is that path: a run-all session in debug mode.
// The last two cases are the other product: the Debug command and Start Debugging now make a
// `record: false` debug session of their own, next to the run-all session, which they never touch.
// Target: test/e2e/fixtures/debug_target.py copied into the workspace for the duration of the spec.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const LINE = { payload: 9, total: 10, loop: 11, call: 12, add: 13, append: 14, print: 15 };

/** which VS Code debug session is still active, for the timeout message */
function activeName() {
  const ds = vscode.debug.activeDebugSession;
  return ds ? `${ds.name} ${JSON.stringify({ replay: ds.configuration.replay, record: ds.configuration.record })}` : 'none';
}

async function waitFor(pred, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Pyokka debugger on debug_target.py', function () {
  this.timeout(180_000);
  let api, session, doc, file;

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, '_debug_target_e2e.py');
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    session = api.manager.sessionForDocument(doc);
    if (!session) {
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      session = api.manager.sessionForDocument(doc);
    }
    assert.ok(session, 'session created');
    await api.waitForIdle(session, 60_000);
  });

  after(async () => {
    for (const ds of api.debugSessions()) ds.dispose();
    if (session && !session.isDisposed) {
      session.stopDebug();
      await session.stopRun().catch(() => undefined);
    }
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    api.manager.stopAll();
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  });

  /**
   * Close the Time Machine a recording debug run left open. It is a replay debug session of its
   * own once the run is over (docs/PROTOCOL.md, "Replay debug session"), and the cases below count
   * and wait on VS Code debug sessions.
   */
  async function closeTimeMachine() {
    await api.waitForIdle(session, 30_000);
    if (session.nav.active) api.timeMachine.stop(session);
    // a replay launch the run's last re-anchor asked for may still be on its way; it ends itself
    // once it finds the Time Machine closed, so wait for a quiet second rather than one empty instant
    let quietSince = Date.now();
    await waitFor(() => {
      if (vscode.debug.activeDebugSession) quietSince = Date.now();
      return Date.now() - quietSince > 1500;
    }, () => `no debug session left (active: ${activeName()})`);
  }

  /** Send `action` and resolve with the pause (or 'finished') it leads to. */
  async function pauseAfter(action) {
    const next = api.waitForPause(session, 60_000);
    await action();
    return next;
  }

  it('pauses at the start, at a breakpoint with the frame live, steps, replays behind the frontier and finishes', async () => {
    const echo = await api.setDebugBreakpoints(session, [{ path: file, line: LINE.add }]);
    assert.equal(echo.length, 1, 'no run in flight: the spec is echoed as is');

    const start = await pauseAfter(() => api.startDebug(session));
    assert.notEqual(start, 'finished');
    assert.equal(start.reason, 'start');
    assert.equal(start.line, LINE.payload, 'the first statement');
    assert.equal(start.step, 0);
    assert.ok(session.running, 'the paused run is still in flight');
    const st = api.debug(session);
    assert.equal(st.active, true);
    assert.equal(st.frontier, 0);
    assert.ok(session.nav.active, 'the Time Machine attached at the pause');
    assert.equal(session.nav.currentStep, 0);
    assert.ok(session.trace && session.trace.count === 1, 'the recording so far is one step');

    const hit = await pauseAfter(() => api.debugContinue(session));
    assert.equal(hit.reason, 'breakpoint');
    assert.equal(hit.line, LINE.add);
    assert.equal(hit.breakpoint.resolvedLine, LINE.add);
    assert.equal(hit.fileId, 1);
    assert.equal(session.nav.currentStep, hit.step, 'the Time Machine follows the frontier');
    assert.equal(api.debug(session).frontier, hit.step);

    // the frame is live at the frontier: `total += d` has not run, bump(payload, 0) returned 0
    const live = await session.evaluateLive('(i, d, total, payload["x"])');
    assert.ok(live, 'evaluate answered in the paused frame');
    assert.equal(live.text, '(0, 0, 0, 0)');
    const locals = await api.debugLocals(session);
    const names = new Set(locals.map((l) => l.name));
    for (const n of ['payload', 'total', 'i', 'd']) assert.ok(names.has(n), `local ${n}`);
    assert.ok(!names.has('bump'), 'module-level functions are not variables');
    assert.equal(locals.find((l) => l.name === 'd').text, '0');
    assert.ok(locals.find((l) => l.name === 'payload').valueBag, 'a value bag to expand');

    // completions for a watch expression, from the paused frame: names in scope, attributes after a dot
    const byName = await api.complete(session, 'pay');
    assert.equal(byName.prefix, 'pay');
    assert.deepEqual(byName.items.map((c) => [c.label, c.kind, c.type]), [['payload', 'variable', 'dict']]);
    const attrs = await api.complete(session, 'payload.');
    const attrLabels = new Set(attrs.items.map((c) => c.label));
    for (const n of ['items', 'keys', 'get']) assert.ok(attrLabels.has(n), `dict attribute ${n}`);
    assert.equal(attrs.items.find((c) => c.label === 'items').kind, 'method');
    assert.ok(!attrLabels.has('__len__'), 'dunders stay hidden until an underscore is typed');
    const broken = await api.complete(session, 'bump().');
    assert.deepEqual(broken.items, []);
    assert.match(broken.error, /cannot call `bump` here/);
    assert.match(broken.error, /pure calls/);

    // behind the frontier moves replay; a forward move comes back to it; no new pause happens
    const frontier = hit.step;
    assert.ok(api.timeMachine.move(session, 'back'));
    assert.equal(session.nav.currentStep, frontier - 1);
    assert.equal(api.debug(session).paused.step, frontier, 'still the same pause');
    assert.ok(api.timeMachine.move(session, 'into'));
    assert.equal(session.nav.currentStep, frontier);

    // at the frontier a forward move is the program's own step
    const over = await pauseAfter(() => {
      assert.ok(api.timeMachine.move(session, 'over'));
    });
    assert.equal(over.reason, 'step');
    assert.equal(over.kind, 'over');
    assert.equal(over.line, LINE.append);
    assert.equal(session.nav.currentStep, over.step);
    const stepped = await pauseAfter(() => api.debugStep(session, 'into'));
    assert.equal(stepped.line, LINE.loop, 'the loop header steps once per pass');

    // the second pass reaches the breakpoint again with i == 1
    const second = await pauseAfter(() => api.debugContinue(session));
    assert.equal(second.reason, 'breakpoint');
    assert.equal(second.line, LINE.add);
    assert.equal((await session.evaluateLive('i')).text, '1');
    assert.equal((await session.evaluateLive('payload["items"]')).text, '[0]');

    // without breakpoints the run continues to its end and becomes a normal finished run
    await api.setDebugBreakpoints(session, []);
    const fin = await pauseAfter(() => api.debugContinue(session));
    assert.equal(fin, 'finished');
    await api.waitForIdle(session, 30_000);
    assert.equal(api.debug(session).paused, undefined);
    assert.equal(api.debug(session).active, true, 'debug mode stays on until stopDebug');
    assert.equal(session.state.finished.exitCode, 0);
    assert.ok(session.trace && session.trace.count > 20, 'the complete trace');
    assert.ok(session.nav.active, 'the Time Machine stays attached');
    assert.equal(session.nav.currentStep, second.step, 'and keeps its position in the completed recording');
    const logs = session.state.entries.filter((e) => e.kind === 'log').map((e) => e.text);
    assert.deepEqual(logs, ['12']);
    session.stopDebug();
    assert.equal(api.debug(session).active, false);
    await closeTimeMachine();
  });

  it('holds implicit runs while paused and takes a VS Code breakpoint set during the pause', async () => {
    await api.setDebugBreakpoints(session, []);
    const start = await pauseAfter(() => api.startDebug(session));
    assert.equal(start.reason, 'start');
    const runId = session.state.runId;
    // an edit in Automatic mode would re-run and kill the paused run: it must not
    session.setRunMode('auto');
    session.scheduleRun('edit', 0);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(session.state.runId, runId, 'no new run started');
    assert.equal(api.debug(session).paused.step, 0, 'still paused at the start');
    // a gutter breakpoint added now reaches the run in flight
    const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(LINE.print - 1, 0)));
    const hit = await pauseAfter(async () => {
      vscode.debug.addBreakpoints([bp]);
      await new Promise((r) => setTimeout(r, 300));
      await api.debugContinue(session);
    });
    assert.equal(hit.reason, 'breakpoint');
    assert.equal(hit.line, LINE.print);
    assert.equal((await session.evaluateLive('total')).text, '12');
    vscode.debug.removeBreakpoints([bp]);
    const fin = await pauseAfter(() => api.debugContinue(session));
    assert.equal(fin, 'finished');
    session.setRunMode('onSave');
    session.stopDebug();
    await closeTimeMachine();
  });

  it('watches on a finished run in On Save mode answer without a run: the finished program at the last step, recorded variables behind it', async () => {
    session.setRunMode('onSave');
    await api.setDebugBreakpoints(session, []);
    const start = await pauseAfter(() => api.startDebug(session));
    assert.equal(start.reason, 'start');
    const fin = await pauseAfter(() => api.debugContinue(session));
    assert.equal(fin, 'finished');
    await api.waitForIdle(session, 30_000);
    assert.ok(session.nav.active, 'the Time Machine stays attached');
    const runId = session.state.runId;
    const last = session.trace.count - 1;
    api.timeMachine.goto(session, last);
    api.timeMachine.addWatch(session, 'total * 2');
    api.timeMachine.addWatch(session, 'total');
    const doubled = session.watches.find((w) => w.exp === 'total * 2');
    const total = session.watches.find((w) => w.exp === 'total');
    await waitFor(() => doubled.values.get(last) && total.values.get(last), 'watch values at the last step');
    assert.equal(doubled.values.get(last).error, undefined);
    assert.equal(doubled.values.get(last).text, '24', 'the finished program evaluated the expression');
    assert.equal(total.values.get(last).text, '12');
    assert.equal(session.state.runId, runId, 'no run happened for the watches');
    // behind the last step a bare name comes from the recorded variables as of the step; an expression waits for a run, and says so
    const before = last - 1;
    api.timeMachine.goto(session, before);
    await waitFor(() => doubled.values.get(before) && total.values.get(before), 'watch values behind the last step');
    assert.equal(total.values.get(before).text, '12');
    assert.match(total.values.get(before).note, new RegExp(`^as of step \\d+, recorded in <module>, line ${LINE.add}$`));
    assert.equal(doubled.values.get(before).error, 'not recorded at this step');
    assert.equal(doubled.values.get(before).needsRun, true, 'the row offers one run of the file');
    assert.equal(session.state.runId, runId, 'still no run');
    const panel = api.timeMachine.debuggerState(session);
    assert.equal(panel.watches.find((w) => w.id === total.id).text, '12', 'the panel gets the recorded text');
    assert.equal(panel.watches.find((w) => w.id === doubled.id).needsRun, true);
    // the Evaluate action: exactly one run, which records the expression at this step and the next ones
    api.timeMachine.evaluateWatchNow(session, doubled.id);
    await api.waitForNextRun(session, 60_000);
    await waitFor(() => {
      const v = doubled.values.get(session.nav.currentStep);
      return v && !v.error ? v : undefined;
    }, 'the watch value recorded by the run');
    assert.notEqual(session.state.runId, runId, 'one run happened');
    assert.equal(doubled.values.get(session.nav.currentStep).valueBag.data.value, '24');
    for (const w of [doubled, total]) api.timeMachine.removeWatch(session, w.id);
    session.stopDebug();
    await closeTimeMachine();
  });

  it('the Debug command on a fresh file makes a debug session and no run-all session, and a second start restarts it in place', async () => {
    const freshFile = path.join(path.dirname(file), '_debug_fresh_e2e.py');
    fs.writeFileSync(freshFile, fs.readFileSync(FIXTURE, 'utf8'));
    const freshDoc = await vscode.workspace.openTextDocument(freshFile);
    await vscode.window.showTextDocument(freshDoc);
    const bp = new vscode.SourceBreakpoint(new vscode.Location(freshDoc.uri, new vscode.Position(LINE.add - 1, 0)));
    try {
      vscode.debug.addBreakpoints([bp]);
      await vscode.commands.executeCommand('pyokka.debugCurrentFile');
      const debug = await waitFor(() => api.debugSessions()[0], 'the debug session');
      assert.equal(api.debugSessions().length, 1);
      assert.equal(api.manager.get(freshDoc), undefined, 'no run-all session is created');
      assert.equal(vscode.debug.activeDebugSession?.type, 'pyokka', 'the command opens a VS Code debug session (the standard views)');
      const vsId = vscode.debug.activeDebugSession.id;
      const paused = debug.debug.paused ?? (await debug.waitForPause(60_000));
      assert.notEqual(paused, 'finished');
      assert.equal(paused.reason, 'breakpoint', 'no stop at the entry: the run went to the first breakpoint');
      assert.equal(paused.line, LINE.add);
      assert.equal(debug.record, false, 'nothing is recorded');
      // a second start on the same program restarts the session in place: one session, one toolbar
      const entry = debug.waitForPause(60_000);
      await vscode.debug.startDebugging(undefined, { type: 'pyokka', request: 'launch', name: 'entry', program: freshFile, stopOnEntry: true });
      const atStart = await entry;
      assert.notEqual(atStart, 'finished', `the restart replaced the child inside the session; sessions=${api.debugSessions().length} status=${debug.status}`);
      assert.equal(atStart.reason, 'start');
      assert.equal(atStart.step, 0);
      assert.equal(api.debugSessions().length, 1, 'still one debug session');
      assert.equal(api.debugSessions()[0].id, debug.id, 'the same one');
      assert.equal(vscode.debug.activeDebugSession?.id, vsId, 'inside the same VS Code debug session');
      vscode.debug.removeBreakpoints([bp]);
      const finished = new Promise((r) => debug.once('finished', r));
      await debug.debugContinue();
      assert.ok(await Promise.race([finished, new Promise((r) => setTimeout(() => r(undefined), 60_000))]), 'the program ran to the end');
      await waitFor(() => !vscode.debug.activeDebugSession, () => `the debug session to end with the program (active: ${activeName()})`);
      await waitFor(() => api.debugSessions().length === 0, 'the registry to empty');
    } finally {
      for (const ds of api.debugSessions()) ds.dispose();
      vscode.debug.removeBreakpoints([bp]);
      try {
        fs.unlinkSync(freshFile);
      } catch {
        /* gone */
      }
      await vscode.window.showTextDocument(doc);
    }
  });

  // With a breakpoint in the active file F5 no longer runs Pyokka's own Re-execute or Run to
  // Active Line: the keybinding's `!pyokka.activeFileHasBreakpoints` guard (pinned by
  // test/unit/manifest.test.ts) hands the key to Start Debugging. This case asserts where that
  // falls through to: with no launch.json VS Code gives the empty configuration to the `pyokka`
  // provider, which runs this file under the debugger and stops at the breakpoint.
  it('runs Start Debugging into a debug session beside the untouched run-all session', async () => {
    const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(LINE.add - 1, 0)));
    vscode.debug.addBreakpoints([bp]);
    await vscode.window.showTextDocument(doc);
    const runId = session.state.runId;
    await vscode.commands.executeCommand('workbench.action.debug.start');
    const debug = await waitFor(() => api.debugSessions()[0], 'the debug session');
    assert.equal(api.debugSessions().length, 1);
    const hit = debug.debug.paused ?? (await debug.waitForPause(60_000));
    assert.notEqual(hit, 'finished');
    assert.equal(hit.reason, 'breakpoint');
    assert.equal(hit.line, LINE.add);
    assert.equal(vscode.debug.activeDebugSession?.type, 'pyokka', 'the empty configuration went to the Pyokka provider');
    // the run-all session on the same file is left alone: no debug run, no new run of its own
    assert.equal(api.debug(session).active, false);
    assert.equal(session.state.runId, runId);
    assert.ok(!session.running);

    debug.stopDebug();
    await waitFor(() => api.debugSessions().length === 0, 'the debug session to be gone', 30_000);
    await waitFor(() => vscode.debug.activeDebugSession === undefined, () => `the debug session to end (active: ${activeName()})`);
    vscode.debug.removeBreakpoints([bp]);
  });
});
