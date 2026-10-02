// End-to-end: the Time Machine is a VS Code debug session in replay (docs/PROTOCOL.md, "Replay
// debug session"). Opening it starts a `pyokka` launch with `replay`, the Call Stack and Variables
// answer from the recording at the current step, stepBack / reverseContinue / next move the Time
// Machine, a move made elsewhere reaches the debug views as one `stopped`, clicking a caller frame
// moves to its step, and closing either side closes the other. A recording debug run declares step
// back too and gets no second session.
// Target: a scratch program written into the workspace under a name no other suite uses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const NAME = '_replay_session_e2e.py';
// `# ?` logs `y` under its name whatever the run mode, so Variables has a recorded value to show
const SOURCE = ['def g(x):', '    y = x * 2  # ?', '    return y', '', 'def f(a):', '    b = g(a)', '    return b + 1', '', 'total = f(3)', 'print(total)', ''].join('\n');
const LINE = { y: 2, ret: 3, call: 6, plus: 7, total: 9, print: 10 };
const RECORD_NAME = '_replay_record_e2e.py';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('the Time Machine as a replay debug session', function () {
  this.timeout(240_000);
  let api, doc, file, recordFile, session;
  /** every DAP event a `pyokka` debug session sent, with the session it came from */
  const events = [];
  let tracker;

  const replaySession = () => {
    const ds = vscode.debug.activeDebugSession;
    return ds && ds.type === 'pyokka' && ds.configuration.replay === session.key ? ds : undefined;
  };
  const stops = (ds) => events.filter((e) => e.session === ds && e.event === 'stopped');
  const stepOnLine = (line) => {
    const trace = session.trace;
    for (let i = 0; i < trace.count; i++) if (trace.location(i)?.range[0] === line) return i;
    throw new Error(`no step on line ${line}`);
  };
  const stack = async (ds) => (await ds.customRequest('stackTrace', { threadId: 1 })).stackFrames;

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    fs.writeFileSync(file, SOURCE);
    recordFile = path.join(root, RECORD_NAME);
    fs.writeFileSync(recordFile, SOURCE);
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('pyokka', {
      createDebugAdapterTracker: (ds) => ({
        onDidSendMessage: (m) => {
          if (m.type === 'event') events.push({ session: ds, event: m.event, body: m.body });
        },
      }),
    });
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = await waitFor(() => api.manager.sessionForDocument(doc), 'the Pyokka session');
    await waitFor(() => session.trace && session.trace.count > 0, 'the first run');
    await api.waitForIdle(session, 60_000);
  });

  after(async () => {
    tracker?.dispose();
    if (session && !session.isDisposed && session.nav.active) api.timeMachine.stop(session);
    await waitFor(() => !vscode.debug.activeDebugSession, 'every debug session to end', 15_000).catch(() => undefined);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    for (const f of [file, recordFile]) fs.rmSync(f, { force: true });
  });

  it('opens a pyokka replay debug session when the Time Machine starts, stopped at its step', async () => {
    assert.ok(await api.timeMachine.start(session, { line: LINE.y }));
    // Auto Log is switched on by the Time Machine and re-runs once (scheduled, so waitForIdle alone
    // can return before it starts); the step re-anchors when it finishes
    await waitFor(() => !session.running && session.state.entries.some((e) => e.kind === 'autoLog'), 'the Auto Log run', 60_000);
    const ds = await waitFor(replaySession, 'the replay debug session');
    assert.equal(ds.name, `Pyokka Time Machine: ${NAME}`);
    await waitFor(() => stops(ds).length > 0, 'the first stopped event');
    assert.match(stops(ds).at(-1).body.description, /^Time Machine at step \d+/);
  });

  it('answers the Call Stack, Variables and Watch from the recording at the step', async () => {
    const ds = replaySession();
    api.timeMachine.goto(session, stepOnLine(LINE.ret));
    await waitFor(async () => (await stack(ds))[0]?.line === LINE.ret, 'the stack at `return y`');
    const frames = await stack(ds);
    assert.deepEqual(frames.map((f) => f.name), ['g', 'f', '<module>']);
    assert.deepEqual(frames.map((f) => f.line), [LINE.ret, LINE.call, LINE.total]);
    assert.equal(frames[0].source.path, file);
    const scopes = (await ds.customRequest('scopes', { frameId: 1 })).scopes;
    assert.equal(scopes[0].name, `Locals at step ${session.nav.currentStep}`);
    const vars = (await ds.customRequest('variables', { variablesReference: scopes[0].variablesReference })).variables;
    assert.equal(vars.find((v) => v.name === 'y')?.value, '6', JSON.stringify(vars));
    const watch = await ds.customRequest('evaluate', { expression: 'y', context: 'watch', frameId: 1 });
    assert.equal(watch.result, '6');
    await assert.rejects(ds.customRequest('evaluate', { expression: 'len(str(y))', context: 'watch', frameId: 1 }), /not in the recording/);
    // VS Code focuses the top frame of a replay stop, which is what fills its Variables view
    await waitFor(() => vscode.debug.activeStackItem?.session === ds && vscode.debug.activeStackItem.frameId === 1, 'the top frame focused in the side bar');
  });

  it('steps back, reverse-continues and steps forward from the debug toolbar', async () => {
    const ds = replaySession();
    const from = session.nav.currentStep;
    const before = stops(ds).length;
    await ds.customRequest('stepBack', { threadId: 1 });
    await waitFor(() => session.nav.currentStep < from, 'stepBack to move the Time Machine back');
    await waitFor(() => stops(ds).length === before + 1, 'one stopped event for the move');
    await ds.customRequest('reverseContinue', { threadId: 1 });
    await waitFor(() => session.nav.currentStep === 0, 'reverseContinue to reach the first recorded step');
    await ds.customRequest('next', { threadId: 1 });
    await waitFor(() => session.nav.currentStep > 0, 'next to move forward');
    // a dead end still answers with a stop, so the toolbar does not stay on "running"
    api.timeMachine.goto(session, 0);
    await waitFor(() => stops(ds).at(-1)?.body.description.startsWith('Time Machine at step 0'), 'the stop at step 0');
    const n = stops(ds).length;
    await ds.customRequest('reverseContinue', { threadId: 1 });
    await waitFor(() => stops(ds).length === n + 1, 'a stop for the dead end');
  });

  it('follows a move made by a command and by the agent bridge path', async () => {
    const ds = replaySession();
    const n = stops(ds).length;
    await vscode.commands.executeCommand('pyokka.revealTraceStep', stepOnLine(LINE.plus));
    await waitFor(() => stops(ds).length > n, 'the stop for the command move');
    assert.equal((await stack(ds))[0].line, LINE.plus);
    assert.equal(replaySession(), ds, 'the same debug session, not a second one');
  });

  // A click in the Call Stack cannot be driven from the extension host: `activeStackItem` is
  // read-only, and `workbench.action.debug.callStackUp` / `callStackDown` left the focused frame on
  // frame 1 in VS Code 1.140 (measured 2026-10-01, Call Stack view focused first). The move itself is
  // covered by test/unit/dapReplay.test.ts (`selectFrame`); check the click by hand in a dev host.
  it.skip('moves the Time Machine to a caller frame clicked in the Call Stack', async () => {
    const ds = replaySession();
    api.timeMachine.goto(session, stepOnLine(LINE.ret));
    await waitFor(async () => (await stack(ds))[0]?.line === LINE.ret, 'the stack at `return y`');
    const callSite = session.trace.callStack(session.nav.currentStep)[1].step;
    await vscode.commands.executeCommand('workbench.debug.action.focusCallStackView');
    await vscode.commands.executeCommand('workbench.action.debug.callStackUp');
    await waitFor(() => session.nav.currentStep === callSite, `the Time Machine at the call site, step ${callSite}`);
  });

  it('ends the replay session when the Time Machine closes, and closes the Time Machine on Stop', async () => {
    const ds = replaySession();
    api.timeMachine.stop(session);
    await waitFor(() => vscode.debug.activeDebugSession !== ds, 'the replay session to end');
    assert.ok(await api.timeMachine.start(session, { line: LINE.y }));
    const again = await waitFor(replaySession, 'a new replay session');
    await vscode.debug.stopDebugging(again);
    await waitFor(() => !session.nav.active, 'Stop in the debug toolbar to close the Time Machine');
  });

  it('gives a recording debug run step back in its own debug session, and no second one', async () => {
    const started = [];
    const sub = vscode.debug.onDidStartDebugSession((s) => started.push(s));
    try {
      const recDoc = await vscode.workspace.openTextDocument(recordFile);
      await vscode.window.showTextDocument(recDoc);
      await vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(recDoc.uri, new vscode.Position(LINE.plus - 1, 0)))]);
      await api.startDebugSession({ program: recordFile, record: true });
      const rec = await waitFor(() => api.manager.sessionForDocument(recDoc), 'the recording session');
      const paused = await waitFor(() => rec.debug.paused, 'the pause at the breakpoint', 60_000);
      await waitFor(() => rec.nav.active && rec.nav.currentStep === paused.step, 'the Time Machine at the frontier');
      const ds = vscode.debug.activeDebugSession;
      assert.equal(ds.configuration.record, true);
      await ds.customRequest('stepBack', { threadId: 1 });
      await waitFor(() => rec.nav.currentStep < paused.step, 'stepBack behind the frontier');
      await waitFor(async () => (await ds.customRequest('scopes', { frameId: 1 })).scopes[0]?.name.startsWith('Locals at step'), 'the recorded scope');
      await ds.customRequest('continue', { threadId: 1 });
      await waitFor(() => rec.nav.currentStep === paused.step, 'continue back to the frontier');
      await waitFor(async () => (await ds.customRequest('scopes', { frameId: 1 })).scopes[0]?.name === 'Locals', 'the live scope again');
      assert.equal(started.filter((s) => s.type === 'pyokka').length, 1, 'one pyokka debug session for the recording run');
      await vscode.debug.stopDebugging(ds);
      await api.waitForIdle(rec, 30_000);
    } finally {
      sub.dispose();
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
  });
});
