// End-to-end: the pyokka CLI with --live, as a child process, against this extension host's
// bridge on examples/demo.py: state, step --into (editor follows), context --line, watch.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');

async function waitFor(pred, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Pyokka CLI --live on demo.py', function () {
  let api, session, doc, editor, file, python;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  /**
   * `python -m pyokka_runtime <args>` from python/ (the package imports from the cwd; no PYTHONPATH).
   * Asynchronous on purpose: the bridge answers from this extension host's event loop, which a
   * spawnSync would block until the CLI gave up.
   */
  function cli(...args) {
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
        reject(new Error(`pyokka ${args.join(' ')} took over 10 s; stdout=${stdout} stderr=${stderr}`));
      }, 10_000);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }
  async function cliJson(...args) {
    const r = await cli(...args, '--json');
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout} ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    api.manager.stopAll(); // one live session on demo.py, so `--session demo.py` is unambiguous
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'bridge descriptor');
  });

  after(async () => {
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
  });

  it('state --live --session demo.py --json reports this session', async () => {
    const st = await cliJson('state', '--live', '--session', 'demo.py');
    assert.equal(st.file, file);
    assert.equal(st.displayName, 'demo.py');
    assert.equal(st.runId, session.state.runId);
    assert.equal(st.finished, true);
    assert.equal(st.nav.active, false);
    assert.equal(st.nav.count, session.trace.count);
    assert.equal(st.live.pid, process.pid);
    assert.equal(st.live.descriptor, api.agentBridge.descriptorFor(session));
    const text = await cli('state', '--live', '--session', 'demo.py');
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^demo\\.py: ${session.trace.count} steps, live in VS Code \\(pid ${process.pid}\\)\\nTime Machine inactive`));
  });

  it('step --live --into starts the Time Machine and the editor follows', async () => {
    editor = await vscode.window.showTextDocument(doc);
    const r = await cliJson('step', '--live', '--session', 'demo.py', '--into');
    // starting the Time Machine turns Auto Log on, which re-runs demo.py in Automatic mode and
    // re-anchors the current step; let that settle before reading the session's state
    await api.waitForIdle(session, 60_000);
    assert.equal(session.nav.active, true, 'Time Machine started');
    assert.equal(r.step, session.nav.currentStep);
    assert.equal(r.location.file, file);
    assert.ok(r.location.line > 0);
    assert.ok(r.block.lines.some((l) => l.current && l.line === r.location.line), 'current line marked');
    assert.equal(typeof r.moves.into, 'number');
    await waitFor(() => vscode.window.activeTextEditor && vscode.window.activeTextEditor.selection.active.line + 1 === r.location.line, `editor selection on line ${r.location.line}`);
    // the second move continues from the current step; the text form lists the moves
    const t = await cli('step', '--live', '--session', 'demo.py', '--over');
    assert.equal(t.status, 0, t.stderr);
    assert.equal(session.nav.currentStep, r.moves.over);
    assert.match(t.stdout, new RegExp(`^step ${r.moves.over}/${session.trace.count}  demo\\.py:\\d+  `));
    assert.match(t.stdout, /\nmoves: into \d+ · over \d+ · out /);
  });

  it('context --live --line demo.py:11 shows the dict the line printed', async () => {
    const r = await cli('context', '--live', '--session', 'demo.py', '--line', 'demo.py:11');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^step \d+\/\d+  demo\.py:11  <module>\n/);
    assert.match(r.stdout, />11  print\(pyokka\)/);
    assert.match(r.stdout, /'is_awesome': True/);
    assert.doesNotMatch(r.stdout, /rangeBase|valueBag/);
    // the session is picked from the file the command names, without --session
    const j = await cliJson('values', '--live', '--line', 'demo.py:11');
    assert.ok(j.values.some((v) => v.line === 11 && /'is_awesome': True/.test(v.text)));
    // what the bridge cannot serve says which saved-run command to use
    const s = await cli('story', '--live', '--session', 'demo.py');
    assert.equal(s.status, 2);
    assert.match(s.stderr, /story needs the whole trace/);
    assert.match(s.stderr, /pyokka run demo\.py --save run\.json/);
  });

  it('var --live lists where a name changed, with steps', async () => {
    const r = await cli('var', '--live', '--session', 'demo.py', 'pyokka');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\d+ changes? of pyokka\n/);
    assert.match(r.stdout, /\n  #\d+ demo\.py:14  <module>  pyokka = \{'is_awesome': True/);
    assert.doesNotMatch(r.stdout, /rangeBase|valueBag|scopeId/);
    const j = await cliJson('var', '--live', '--session', 'demo.py', 'working_dir');
    assert.ok(j.changes.some((c) => c.line === 18 && c.file === file), `working_dir assigned on line 18: ${JSON.stringify(j.changes)}`);
  });

  it('watch --live echoes a step taken in the editor', async () => {
    editor = await vscode.window.showTextDocument(doc);
    const child = spawn(python, ['-m', 'pyokka_runtime', 'watch', '--live', '--session', 'demo.py'], { cwd: PY_DIR });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    try {
      // the watch request has no visible acknowledgement; step until a line arrives
      const deadline = Date.now() + 10_000;
      while (!/^step \d+  demo\.py:\d+  /m.test(out)) {
        if (child.exitCode !== null) throw new Error(`watch exited ${child.exitCode}: ${err}`);
        if (Date.now() > deadline) throw new Error(`no watch line; stdout=${JSON.stringify(out)} stderr=${err}`);
        await vscode.commands.executeCommand('pyokka.playTraceNextStep');
        await sleep(300);
      }
      const line = out.split('\n').find((l) => l.startsWith('step '));
      assert.match(line, new RegExp(`^step ${session.nav.currentStep}  demo\\.py:${session.trace.location(session.nav.currentStep).range[0]}  `));
      await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
      await waitFor(() => /^stopped$/m.test(out), 'the stopped line');
    } finally {
      child.kill('SIGINT');
      await new Promise((r) => child.on('exit', r));
    }
  });
});
