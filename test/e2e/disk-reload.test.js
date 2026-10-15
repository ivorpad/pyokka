// End-to-end: an On Save session reruns when a file it ran changes on disk outside VS Code.
// The writes come from a shell, as another editor or an agent would make them: an imported module
// that is not open, and an open file outside the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vscode = require('vscode');

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

/** Write `text` to `file` from a shell, outside VS Code. */
function shellWrite(file, text) {
  const r = spawnSync('/bin/sh', ['-c', 'printf "%s" "$1" > "$2"', 'sh', text, file]);
  assert.equal(r.status, 0, String(r.stderr));
}

const printed = (session) => session.state.entries.map((e) => e.text).join('\n');

describe('On Save reruns on an outside write', function () {
  this.timeout(120_000);
  let api, root, outsideDir;
  const made = [];

  async function start(file) {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    await api.waitForIdle(session, 60_000);
    session.setRunMode('onSave'); // this instance's default is Automatic; the rule under test is On Save's
    let runs = 0;
    session.on('runFinished', () => runs++);
    return { doc, session, runs: () => runs };
  }

  before(async () => {
    api = await vscode.extensions.getExtension('ivor.pyokka').activate();
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-disk-'));
  });

  after(async () => {
    api.manager.stopAll();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const f of made) fs.rmSync(f, { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('an imported module that is not open reruns the session that imported it', async () => {
    const main = path.join(root, '_disk_reload_main.py');
    const dep = path.join(root, '_disk_reload_dep.py');
    made.push(main, dep);
    fs.writeFileSync(dep, 'VALUE = 1\n');
    fs.writeFileSync(main, 'import _disk_reload_dep\n\nprint("dep", _disk_reload_dep.VALUE)\n');
    const { session, runs } = await start(main);
    assert.match(printed(session), /dep 1/);
    assert.ok(!vscode.workspace.textDocuments.some((d) => d.uri.fsPath === dep), 'the module is not open');
    const before = runs();
    shellWrite(dep, 'VALUE = 2\n');
    await waitFor(() => runs() > before && /dep 2/.test(printed(session)), 'a rerun that printed dep 2');
  });

  it('an open file outside the workspace reruns when it changes on disk', async () => {
    const file = path.join(outsideDir, 'outside.py');
    fs.writeFileSync(file, 'print("v", 1)\n');
    const { doc, session, runs } = await start(file);
    assert.match(printed(session), /v 1/);
    const before = runs();
    shellWrite(file, 'print("v", 2)\n');
    await waitFor(() => doc.getText().includes('"v", 2'), 'VS Code reloading the document');
    await waitFor(() => runs() > before && /v 2/.test(printed(session)), 'a rerun that printed v 2');
    assert.equal(doc.isDirty, false);
  });
});
