// End-to-end: `record: true`, the optional bridge between the two products
// (docs/design/debugger-product.md, 3.7, 8.3). A recording debug session is today's behaviour
// reached explicitly: a run-all session on the program's document in debug mode, with the Time
// Machine over its recording. It is presented in the Time Machine view and the run-all status
// item, never in the Debugger view, so `api.debugSessions()` stays empty throughout.
// Target: test/e2e/fixtures/debug_target.py copied into the workspace for the duration of the spec.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const RECORD_FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_record.py');
const RECORD_NAME = '_debug_record_e2e.py';
/** lines of debug_record.py */
const REC = { argv: 6, flag: 7, total: 8, loop: 9, add: 10, print: 11 };
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const NAME = '_debug_recording_e2e.py';
const LINE = { bump: 4, payload: 9, total: 10, loop: 11, call: 12, add: 13, append: 14, print: 15 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('recording debug sessions', function () {
  this.timeout(240_000);
  let api, doc, file, root, python, recordFile;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  function cli(args, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args], { cwd: PY_DIR });
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

  /** The session of the fixture's document, once the recording start created one. */
  const session = () => api.manager.sessionForDocument(doc);

  async function endEverything() {
    for (const ds of api.debugSessions()) ds.dispose();
    for (const s of api.manager.all()) {
      if (s.isDisposed) continue;
      s.stopDebug();
      await s.stopRun().catch(() => undefined);
      await api.waitForIdle(s, 30_000).catch(() => undefined);
    }
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    recordFile = path.join(root, RECORD_NAME);
    fs.writeFileSync(recordFile, fs.readFileSync(RECORD_FIXTURE, 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    // a session for a moment, only to learn the interpreter the CLI should run from
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const probe = session();
    assert.ok(probe, 'session created');
    python = probe.interpreter.path;
    await api.waitForIdle(probe, 60_000);
    api.manager.stopAll();
  });

  after(async () => {
    await endEverything();
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    try {
      fs.unlinkSync(file);
      fs.unlinkSync(recordFile);
    } catch {
      /* already gone */
    }
  });

  it('the recording command attaches the Time Machine, and why answers over the bridge', async () => {
    await endEverything();
    await vscode.window.showTextDocument(doc);
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(LINE.add - 1, 0)), true)]);
    await vscode.commands.executeCommand('pyokka.debugCurrentFileRecording');

    // the recording start makes a run-all session, not a Debugger session
    const s = await waitFor(() => session(), 'the recording session');
    assert.equal(api.debugSessions().length, 0, 'a recording session never appears in the Debugger registry');
    assert.equal(api.debugPanelState(), null, 'and never in the Debugger view');
    const hit = await waitFor(() => api.debug(s).paused, 'the pause at the breakpoint', 90_000);
    assert.equal(hit.reason, 'breakpoint');
    assert.equal(hit.line, LINE.add);

    // the Time Machine is over the recording: values as of the step, and Step Back replays
    assert.ok(s.nav.active, 'the Time Machine attached at the pause');
    assert.equal(s.nav.currentStep, hit.step);
    assert.ok(s.trace && s.trace.count > 0, `the recording so far: ${s.trace && s.trace.count}`);
    assert.ok(api.timeMachine.move(s, 'back'), 'Step Back replays behind the pause');
    assert.equal(s.nav.currentStep, hit.step - 1);
    assert.equal(api.debug(s).paused.step, hit.step, 'the pause did not move');
    assert.ok(api.timeMachine.move(s, 'into'), 'and a forward move comes back to the frontier');
    assert.equal(s.nav.currentStep, hit.step);

    // `why` needs a recording, and a recording session has one: it answers over the run socket
    await waitFor(() => api.agentBridge.descriptorFor(s), 'the run descriptor');
    const why = await cli(['why', '--live', String(hit.step), 'total', '--session', NAME]);
    assert.equal(why.status, 0, `${why.stdout} ${why.stderr}`);
    assert.match(why.stdout, /total/, `the provenance names the value: ${why.stdout}`);
    // the backward moves the debug socket refuses work here
    const back = await cli(['step', '--live', '--back', '--session', NAME, '--json']);
    assert.equal(back.status, 0, `${back.stdout} ${back.stderr}`);

    // and the state reply says it is a recording run
    const st = await cli(['state', '--live', '--session', NAME, '--json']);
    assert.equal(st.status, 0, st.stderr);
    const state = JSON.parse(st.stdout);
    assert.equal(state.kind, 'run');
    assert.ok(state.debug, 'the debug half of the state is there');
    assert.equal(state.debug.paused.line, LINE.add);
    await endEverything();
  });

  it('record: true through a launch configuration takes args, cwd and env', async () => {
    await endEverything();
    const doc2 = await vscode.workspace.openTextDocument(recordFile);
    await vscode.window.showTextDocument(doc2);
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(doc2.uri, new vscode.Position(REC.print - 1, 0)), true)]);
    await api.startDebugSession({ program: recordFile, args: ['--flag', 'on'], cwd: root, env: { PYOKKA_E2E_RECORDING: 'yes' }, record: true });
    const s = await waitFor(() => api.manager.sessionForDocument(doc2), 'the recording session');
    assert.equal(api.debugSessions().length, 0, 'still no Debugger session');
    const hit = await waitFor(() => api.debug(s).paused, 'the pause at the breakpoint', 90_000);
    assert.equal(hit.line, REC.print);
    assert.ok(s.nav.active, 'the Time Machine attached');
    // the three `??` overrides of 3.7 are set, and inert for every other run
    assert.deepEqual(s.argvOverride, ['--flag', 'on']);
    assert.equal(s.cwdOverride, root);
    assert.deepEqual(s.envOverride, { PYOKKA_E2E_RECORDING: 'yes' });
    // and they reached the child: the program read them before the pause
    const read = await s.evaluateLive('(argv, flag)');
    assert.ok(read, 'evaluate answered in the paused frame');
    assert.equal(read.text, "(['--flag', 'on'], 'yes')");
    s.stopDebug();
    await s.stopRun().catch(() => undefined);
    await endEverything();
  });

  it('module with record: true is refused with the message that names record: false', async () => {
    await endEverything();
    // an async wrapper so the synchronous throw of parseLaunch becomes the rejection to assert
    await assert.rejects(async () => api.startDebugSession({ module: 'app.server', args: [], cwd: root, record: true }), /record.*false/);
    assert.equal(api.debugSessions().length, 0, 'nothing was started');
    assert.equal(session(), undefined, 'and no run-all session either');
    // the CLI refuses the same combination before it reaches a window
    const r = await cli(['debug', '--module', 'app.server', '--record']);
    assert.equal(r.status, 2, `${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /--record/);
    assert.match(r.stderr, /module/);
  });
});
