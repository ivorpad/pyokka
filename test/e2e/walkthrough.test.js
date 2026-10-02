// End-to-end: the walkthrough on examples/demo.py, live and saved: `pyokka walkthrough --live`
// matches the saved run's list, the bridge serves it, a moment's step moves the Time Machine
// (the panel's click path), and Narrate with pyokka.explain.command pointing at a fake script
// fills the glosses (no live model).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

describe('Pyokka walkthrough on demo.py', function () {
  let api, session, doc, file, python, tmp;
  const config = () => vscode.workspace.getConfiguration('pyokka');

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
        reject(new Error(`pyokka ${args.join(' ')} took over 60 s; stdout=${stdout} stderr=${stderr}`));
      }, 60_000);
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
  /** What must match between two runs of demo.py: random points and object addresses differ, the structure does not. */
  const shape = (w) => w.moments.map((m) => [m.kind, m.step, m.location.line, m.kind === 'print' || m.kind === 'value' ? '' : m.text.replace(/0x[0-9a-f]+/g, '0x0').replace(/ after .*$/, '')]);

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    api.manager.stopAll();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-walk-'));
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
    await config().update('explain.command', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
  });

  it('lists the prints, the if False decision, the calls with their arguments and the end, live and saved alike', async () => {
    const saved = path.join(tmp, 'demo-run.json');
    const run = await cli('run', file, '--save', saved);
    assert.equal(run.status, 1, run.stderr); // demo.py raises on purpose
    const fromFile = await cliJson('walkthrough', saved);
    const live = await cliJson('walkthrough', '--live', '--session', 'demo.py');
    const texts = fromFile.moments.map((m) => m.text);
    assert.equal(texts[0], 'module demo.py starts');
    assert.ok(texts.some((t) => t.startsWith("prints {'is_awesome': True")), 'the first print');
    assert.ok(texts.includes('prints partial False'), 'the partial print');
    assert.ok(texts.includes('if False took False'), 'the decision');
    const init = fromFile.moments.find((m) => m.text === 'call to Point.__init__ from <module>');
    assert.deepEqual(init.values, [{ role: 'in', name: 'x', text: '5' }, { role: 'in', name: 'y', text: '10' }]);
    assert.ok(texts.some((t) => t.startsWith('call to Rectangle.__init__ from <module>')), 'Rectangle call');
    assert.ok(texts.some((t) => t.startsWith('raised ValueError: Kaboom!') && t.endsWith(' uncaught')), 'the uncaught error');
    assert.match(texts.at(-1), /^run ends with exit code 1 after /);
    assert.equal(fromFile.count, session.trace.count);
    assert.deepEqual(shape(live), shape(fromFile));
    assert.equal(live.count, fromFile.count);
    assert.ok(live.moments.every((m) => m.gloss === null && m.durationMs === null));
    // the text form (the saved run records locals by default, so the calls carry their arguments; a live session
    // needs pyokka.timeMachine.recordLocals for that)
    const text = await cli('walkthrough', saved);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^\d+ moments over \d+ steps\n#0  module demo\.py starts\n/);
    assert.match(text.stdout, /\n      in x = 5\n      in y = 10\n/);
    const liveText = await cli('walkthrough', '--live', '--session', 'demo.py');
    assert.equal(liveText.status, 0, liveText.stderr);
    assert.match(liveText.stdout, /\n#\d+  call to Point\.__init__ from <module>\n/);
    // the panel and the Code Story get the same list
    const w = api.narrator.walkthrough(session);
    assert.deepEqual(w.moments.map((m) => m.text), live.moments.map((m) => m.text));
  });

  it('moves the Time Machine to a moment (the panel click path) and the CLI reports the step', async () => {
    const live = await cliJson('walkthrough', '--live', '--session', 'demo.py', '--scope', 'generate_random_point');
    const call = live.moments.find((m) => m.kind === 'call' && m.text === 'call to generate_random_point from <module>');
    assert.ok(call, 'the call moment');
    await vscode.commands.executeCommand('pyokka.revealTraceStep', call.step);
    // starting the Time Machine turns Auto Log on, which schedules a re-run (Automatic mode here); let it land and re-anchor
    await api.waitForNextRun(session, 20_000).catch(() => undefined);
    await api.waitForIdle(session, 60_000);
    assert.equal(session.nav.active, true);
    assert.equal(session.nav.currentStep, call.step);
    const st = await cliJson('state', '--live', '--session', 'demo.py');
    assert.equal(st.nav.step, call.step);
    assert.equal(st.location.line, call.location.line);
    // a window without the cap
    const win = await cliJson('walkthrough', '--live', '--session', 'demo.py', '--from', String(call.step), '--to', String(call.endStep));
    assert.equal(win.moments[0].text, 'call to generate_random_point from <module>');
    assert.ok(win.shown < live.count);
    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
  });

  it('narrates with pyokka.explain.command pointing at a fake script: glosses fill the panel, the story and the bridge', async () => {
    if (session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await api.waitForNextRun(session, 5_000).catch(() => undefined); // stopping switches Auto Log off: one more run in Automatic mode
    await api.waitForIdle(session, 60_000);
    const before = api.narrator.walkthrough(session);
    assert.ok(before, 'walkthrough of the finished run');
    const ids = before.moments.map((m) => m.id);
    const script = path.join(tmp, 'fake-model.sh');
    const promptCopy = path.join(tmp, 'prompt.txt');
    const answer = JSON.stringify(Object.fromEntries(ids.map((id) => [id, `gloss for ${id}`])));
    fs.writeFileSync(script, `#!/bin/sh\ncat > "${promptCopy}"\nprintf '%s' '${answer}'\n`, { mode: 0o755 });
    await config().update('explain.command', script, vscode.ConfigurationTarget.Global);
    assert.equal(api.narrator.glosses(session), undefined);
    const glosses = await api.narrator.narrate(session);
    assert.ok(glosses, 'narration succeeded');
    assert.equal(Object.keys(glosses).length, ids.length);
    assert.equal(glosses.m0, 'gloss for m0');
    const prompt = fs.readFileSync(promptCopy, 'utf8');
    assert.match(prompt, /^You are annotating/);
    assert.ok(prompt.includes('"id": "m0"') && prompt.includes('def generate_random_point'), 'prompt carries the moments and the source');
    // cached per run: a second call does not run the script again
    fs.unlinkSync(promptCopy);
    assert.deepEqual(await api.narrator.narrate(session), glosses);
    assert.equal(fs.existsSync(promptCopy), false);
    const after = api.narrator.walkthrough(session);
    assert.equal(after.moments[0].gloss, 'gloss for m0');
    const live = await cliJson('walkthrough', '--live', '--session', 'demo.py');
    assert.equal(live.moments[0].gloss, 'gloss for m0');
    const text = await cli('walkthrough', '--live', '--session', 'demo.py');
    assert.match(text.stdout, /#0  module demo\.py starts\n      gloss for m0\n/);
    // a failing script reports once and keeps the glosses of the last good run
    fs.writeFileSync(script, '#!/bin/sh\necho nope\n', { mode: 0o755 });
    await session.runNow('manual');
    await api.waitForIdle(session, 60_000);
    assert.equal(api.narrator.glosses(session), undefined, 'a new run has no glosses');
    assert.equal(await api.narrator.narrate(session), undefined);
    assert.match(api.narrator.lastError(session), /did not answer with a JSON object/);
    assert.ok(api.narrator.walkthrough(session).moments.every((m) => m.gloss === null));
  });
});
