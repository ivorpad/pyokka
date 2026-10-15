// End-to-end: Investigate a Value, Learn from This Run, Pin Run as Baseline and Verify Fix on
// examples/demo.py. Each command takes its inputs as an argument,
// so no prompt opens; `api.lastInvestigation()` is the text the command showed.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('investigation commands on demo.py', function () {
  this.timeout(180_000);
  let api, session;

  before(async () => {
    api = await vscode.extensions.getExtension('ivor.pyokka').activate();
    const doc = await vscode.workspace.openTextDocument(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py'));
    await vscode.window.showTextDocument(doc);
    session = api.manager.sessionForDocument(doc);
    if (!session) {
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      session = api.manager.sessionForDocument(doc);
    }
    await api.waitForIdle(session, 60_000);
  });

  after(() => api.manager.stopAll());

  const run = async (command, arg) => {
    const before = api.lastInvestigation();
    await vscode.commands.executeCommand(command, arg);
    for (let i = 0; i < 100 && api.lastInvestigation() === before; i++) await sleep(100);
    return api.lastInvestigation() ?? '';
  };

  it('Investigate a Value names the step that made it', async () => {
    const text = await run('pyokka.investigateValue', { name: 'total' });
    assert.match(text, /selected: #\d+ demo\.py:\d+/);
  });

  it('Learn from This Run hides nothing once revealed and compares the prediction', async () => {
    const print = session.state.entries.find((e) => e.kind === 'print' || e.kind === 'log');
    assert.ok(print, 'a printed value to predict');
    const text = await run('pyokka.learnRun', { step: print.step, prediction: 'nothing' });
    assert.match(text, /match/i);
  });

  it('Pin Run as Baseline, then Verify Fix against it', async () => {
    assert.match(await run('pyokka.pinRun'), /pinned/);
    const text = await run('pyokka.verifyFix', { expect: 'total=-1' });
    assert.match(text, /FAIL total = /, 'a wrong expectation fails with the recorded value');
  });
});
