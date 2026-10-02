// End-to-end: the TOUR section on examples/tour_small.py. Show Tour computes the tour of the
// session's run with the Python `pyokka tour` (the same statements a saved run's tour lists, with
// variable changes recorded or not alike), the no-locals notice turns them on and runs again, a
// click on a stop (the panel's `tour.goto` message) moves the Time Machine to its step and is
// remembered for the file, and Narrate Tour with pyokka.explain.command pointing at a fake script
// merges the answer through `pyokka tour --prose` (5.2; no live model).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');

async function waitFor(pred, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Pyokka tour on tour_small.py', function () {
  let api, session, doc, file, python, tmp;
  const config = () => vscode.workspace.getConfiguration('pyokka');
  const posted = [];
  let tap;

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
        reject(new Error(`pyokka ${args.join(' ')} took over 60 s`));
      }, 60_000);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }

  const rows = (t) => t.candidates.map((c) => [c.step, c.line, c.statement]);
  /** `pyokka run --save` then `pyokka tour --json` on the same file, as an agent would */
  async function savedTour(name, ...runFlags) {
    const saved = path.join(tmp, name);
    const run = await cli('run', file, '--save', saved, ...runFlags);
    assert.equal(run.status, 0, run.stderr);
    const out = await cli('tour', saved, '--json');
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    tap = api.onPanelMessage((m) => m.type === 'tour' && posted.push(m.tour));
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'tour_small.py');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-tour-'));
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
  });

  after(async () => {
    tap?.dispose();
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await config().update('explain.command', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
  });

  it('Show Tour computes the tour with the Python command: the same statements as the saved run\'s tour', async () => {
    await vscode.commands.executeCommand('pyokka.showTour');
    const tour = await waitFor(() => api.tour.tour(session), 'the tour of the run');
    const panel = await waitFor(() => posted.find((p) => p && p.status === 'ready' && p.runId === session.state.runId), 'a ready tour posted to the panel');
    assert.equal(tour.small, true, 'a 75-step run is a small one');
    assert.equal(tour.chapters.length, 1);
    assert.equal(tour.goal.kind, 'output');
    assert.equal(tour.goal.text, 'best: alpha');
    assert.ok(tour.candidates.some((c) => c.statement.startsWith('fused = fuse(')), 'the fuse call');
    assert.equal(panel.stops.length, tour.candidates.length);
    assert.ok(panel.stops.every((s) => s.fileId >= 0 && s.file === 'tour_small.py'), 'display paths resolve to the run\'s file');
    // like with like: the session records no variable changes by default, so its saved twin is `--no-locals`
    assert.equal(session.recordLocals, false, 'Record Variable Changes is off by default');
    assert.equal(panel.noLocals, true, 'the section says the run recorded no variable changes');
    assert.deepEqual(rows(tour), rows(await savedTour('small-nolocals.json', '--no-locals')));
  });

  it('the no-locals notice records variable changes and runs again: then the tour matches a default saved run', async () => {
    const before = api.tour.tour(session);
    // the webview posts exactly this from the notice's link
    await api.panel.onMessage({ type: 'tour.recordLocals' });
    await api.waitForIdle(session, 60_000);
    assert.equal(session.recordLocals, true);
    const tour = await waitFor(() => api.tour.ensure(session), 'the tour of the run with variable changes');
    assert.equal(api.tour.panel(session).noLocals, false);
    // with arguments known, each pass of `rows.append(parse(line))` with new arguments is a stop of its own
    assert.ok(tour.candidates.length > before.candidates.length, `${tour.candidates.length} candidates with locals, ${before.candidates.length} without`);
    assert.ok(tour.candidates.filter((c) => c.statement === 'rows.append(parse(line))').length > 1, 'repeated calls with new arguments');
    assert.deepEqual(rows(tour), rows(await savedTour('small-run.json')));
  });

  it('a click on a stop moves the Time Machine there and is remembered for the file', async () => {
    const panel = api.tour.panel(session);
    const stop = panel.stops.find((s) => s.statement.startsWith('fused = fuse('));
    assert.ok(stop, 'the fuse stop');
    // the webview posts exactly this on a click (webview/tourView.ts tourGotoMessage)
    await api.panel.onMessage({ type: 'tour.goto', step: stop.step, stopId: stop.id });
    await api.waitForNextRun(session, 20_000).catch(() => undefined); // starting the Time Machine turns Auto Log on
    await api.waitForIdle(session, 60_000);
    assert.equal(session.nav.active, true);
    assert.equal(session.nav.currentStep, stop.step);
    const after = await waitFor(() => api.tour.ensure(session).then(() => api.tour.panel(session)), 'the tour after the Time Machine re-run');
    const same = after.stops.find((s) => s.key === stop.key);
    assert.equal(after.resumeStopId, same.id, 'the remembered stop, found by key in this run');
    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
  });

  it('Narrate Tour runs pyokka.explain.command once and merges the answer through `tour --prose`', async () => {
    await api.waitForNextRun(session, 5_000).catch(() => undefined);
    await api.waitForIdle(session, 60_000);
    const tour = await api.tour.ensure(session);
    assert.ok(tour, 'tour of the finished run');
    const pick = tour.candidates.find((c) => c.statement.startsWith('fused = fuse('));
    const promptCopy = path.join(tmp, 'tour-prompt.txt');
    const answer = JSON.stringify({ intro: 'Two rankings are fused into one.', chapters: { c1: { title: 'The whole run', text: 'It loads, fuses and prints.' } }, pick: [pick.id], stops: { [pick.id]: { title: 'The fused ranking', text: 'The `fuse` call combines both lists.' } } });
    const script = path.join(tmp, 'fake-model.sh');
    fs.writeFileSync(script, `#!/bin/sh\ncat > "${promptCopy}"\nprintf '%s' '${answer}'\n`, { mode: 0o755 });
    await config().update('explain.command', script, vscode.ConfigurationTarget.Global);
    const merged = await api.tour.narrate(session);
    assert.ok(merged, `narration merged: ${api.tour.lastError(session)}`);
    assert.deepEqual(merged.pick, [pick.id]);
    const prompt = fs.readFileSync(promptCopy, 'utf8');
    assert.ok(prompt.includes('"tour":1') && prompt.includes(pick.id), 'the prompt carries the compact tour');
    const panel = api.tour.panel(session);
    assert.equal(panel.narrated, true);
    assert.equal(panel.stops.find((s) => s.id === pick.id).title, 'The fused ranking');
    // cached for the run: no second model call
    fs.unlinkSync(promptCopy);
    await api.tour.narrate(session);
    assert.equal(fs.existsSync(promptCopy), false);
  });
});
