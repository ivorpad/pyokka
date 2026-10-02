// End-to-end: drive Pyokka on examples/demo.py inside a real VS Code instance.
// Set PYOKKA_E2E_PAUSE=<ms> to pause at each checkpoint (for screenshots).
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const PAUSE = Number(process.env.PYOKKA_E2E_PAUSE || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checkpoint = async (name) => {
  console.log(`[pyokka-e2e] checkpoint: ${name}`);
  if (PAUSE) await sleep(PAUSE);
};

describe('Pyokka on demo.py', function () {
  let api, session, doc, editor;

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    assert.ok(api && api.manager, 'activate returned the API');
    const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    // start from a clean slate whatever ran before this file
    api.manager.stopAll();
  });

  it('starts a session and produces logs, coverage and an error', async () => {
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    await api.waitForIdle(session, 60_000);
    const st = session.state;
    assert.ok(st.entries.length >= 8, `entries: ${st.entries.length}`);
    assert.ok(st.errors.length >= 1, 'an error was reported');
    assert.match(st.errors[0].message, /Kaboom/);
    const fileId = session.mainFileId();
    const cov = st.coverage.get(fileId);
    assert.ok(cov, 'coverage received');
    assert.ok(cov.states.includes(2), 'a partially covered range exists');
    assert.ok(st.trace && st.trace.count > 50, `trace steps: ${st.trace && st.trace.count}`);
    await vscode.commands.executeCommand('pyokka.showOutput');
    await checkpoint('running');
  });

  it('navigates the trace forwards and backwards', async () => {
    const lineOf = () => {
      const loc = session.trace.location(session.nav.currentStep);
      return loc ? loc.range[0] : -1;
    };
    // cursor on `os.cpu_count()  # ?` (line 20)
    editor.selection = new vscode.Selection(19, 0, 19, 0);
    await vscode.commands.executeCommand('pyokka.debug');
    assert.equal(session.nav.active, true, 'time machine active');
    assert.equal(lineOf(), 20);
    await checkpoint('tm-start');

    await vscode.commands.executeCommand('pyokka.playTraceNextStepOver');
    assert.equal(lineOf(), 23);
    await vscode.commands.executeCommand('pyokka.playTraceNextStepOver');
    assert.equal(lineOf(), 29);
    await checkpoint('step-over-x2');

    await vscode.commands.executeCommand('pyokka.playTracePrevStepOver');
    assert.equal(lineOf(), 23);
    await checkpoint('step-back-over');

    // run to line 83 (`point_b = generate_random_point(...)`) then step into it
    editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(82, 0, 82, 0);
    await vscode.commands.executeCommand('pyokka.playTraceForwardToSelection');
    assert.equal(lineOf(), 83);
    const before = session.nav.currentStep;
    await vscode.commands.executeCommand('pyokka.playTraceNextStep');
    assert.ok(session.nav.currentStep > before);
    const loc = session.trace.location(session.nav.currentStep);
    assert.ok(loc.range[0] >= 70 && loc.range[0] <= 74, `stepped into generate_random_point, line ${loc.range[0]}`);
    await checkpoint('step-into');

    await vscode.commands.executeCommand('pyokka.playTraceNextStepOut');
    assert.ok(lineOf() >= 83, `step out returns to the caller, line ${lineOf()}`);
    await vscode.commands.executeCommand('pyokka.playTracePrevStepOut');
    await checkpoint('step-back-out');

    await vscode.commands.executeCommand('pyokka.viewCallStack');
    await checkpoint('call-stack');
  });

  it('opens the Code Story', async () => {
    await vscode.commands.executeCommand('pyokka.viewCodeStory');
    await sleep(1000);
    const story = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'pyokka-code-timeline');
    assert.ok(story, 'code story editor visible');
    assert.ok(story.document.getText().length > 100);
    await checkpoint('code-story');
    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    assert.equal(session.nav.active, false);
  });

  it('shows a value on selection via a marker', async () => {
    await vscode.window.showTextDocument(doc);
    // select `working_dir` on line 18
    editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(17, 0, 17, 11);
    const next = api.waitForNextRun(session, 60_000);
    await vscode.commands.executeCommand('pyokka.showValue');
    await next;
    const entries = session.state.entries;
    const hit = entries.find((e) => (e.context || '').includes('working_dir') || (e.text || '').includes('/examples'));
    assert.ok(hit, `value entry for working_dir present; entries: ${JSON.stringify(entries.map((e) => [e.kind, e.context, e.text]))}`);
    await checkpoint('show-value');
  });
});
