// End-to-end: `pyokka diff before.json --live` against this extension host's bridge.
// Target: test/e2e/fixtures/diff_target.py, copied into the workspace under its own name.
// 1. A saved run and the live session of the same file, the session with its default of no
//    recorded locals: the diff leaves values and call arguments out, says so, and is otherwise empty.
// 2. The same with Record Variable Changes on: empty, so any line it prints is a place where the
//    bridge's walkthrough or var (TypeScript) and the saved run's (Python) disagree.
// 3. The edit: `total = qty * unit` gets `+ 50` and is saved, the session re-runs, and the diff
//    against the run from before shows the new value and the flipped branch.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'diff_target.py');
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const NAME = '_diff_live_e2e.py';
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

describe('Pyokka CLI diff --live', function () {
  let api, session, doc, file, python, tmp;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  /** Asynchronous: the bridge answers from this extension host's event loop. */
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
        reject(new Error(`pyokka ${args.join(' ')} took over 30 s; stdout=${stdout} stderr=${stderr}`));
      }, 30_000);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }
  async function diffLive(before) {
    const r = await cli('diff', before, '--live', '--session', NAME, '--json');
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout} ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, NAME);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'bridge descriptor');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-diff-'));
  });

  after(async () => {
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    fs.rmSync(file, { force: true });
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function sameFile(name) {
    const before = path.join(tmp, name);
    const saved = await cli('run', file, '--save', before);
    assert.match(saved.stdout, new RegExp(`saved .*${name.replace('.', '\\.')}`), saved.stderr);
    const d = await diffLive(before);
    assert.equal(d.b.run, '--live');
    assert.equal(d.a.count, d.b.count, 'both sides ran the same number of steps');
    assert.deepEqual([d.matching.edited, d.matching.added, d.matching.removed], [0, 0, 0]);
    assert.deepEqual(d.statements, [], `the saved run and the live session disagree: ${JSON.stringify(d.statements, null, 1)}`);
    return d;
  }

  it('without recorded locals in the session, a saved run of the same file differs in nothing both sides have', async () => {
    assert.equal(session.recordLocals, false, 'off by default');
    const d = await sameFile('same-nolocals.json');
    assert.equal(d.notes.length, 1);
    assert.match(d.notes[0], /^b recorded no locals .*recordLocals/);
  });

  it('with Record Variable Changes on, a saved run of the same file has no difference at all', async () => {
    const next = api.waitForNextRun(session, 60_000);
    session.setRecordLocals(true);
    await vscode.commands.executeCommand('pyokka.reexecute');
    await next;
    await api.waitForIdle(session, 60_000);
    assert.ok(session.state.locals.length > 0, 'locals recorded');
    const d = await sameFile('same.json');
    assert.deepEqual(d.notes, []);
  });

  it('after an edit, the diff shows the new value and the flipped branch', async () => {
    const before = path.join(tmp, 'before.json');
    await cli('run', file, '--save', before);
    const runId = session.state.runId;
    const line = doc.lineAt(4); // `    total = qty * unit`
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, line.range.end, ' + 50');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await doc.save();
    await waitFor(() => session.state.runId !== runId, 'the re-run after save');
    await api.waitForIdle(session, 60_000);
    const d = await diffLive(before);
    assert.equal(d.matching.edited, 1);
    const edited = d.statements.find((e) => e.status === 'edited');
    assert.equal(edited.textB, 'total = qty * unit + 50');
    assert.deepEqual(edited.facts.slice(0, 2).map((f) => [f.a.text, f.b.text]), [['60', '110'], ['50', '100']]);
    const branch = d.statements.find((e) => (e.textB || '').startsWith('if total > LIMIT'));
    assert.deepEqual(branch.facts.map((f) => [f.kind, f.a.text, f.b.text]), [['branch', 'False', 'True']]);
  });
});
