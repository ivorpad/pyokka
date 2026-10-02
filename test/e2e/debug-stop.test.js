// End-to-end: F5 on a file without a Pyokka session makes a `record: false` debug session that
// pauses at the gutter breakpoint, and VS Code's own Stop (the toolbar button, Shift+F5) ends both
// the program and the debug session through the DAP adapter. Then the panel's two buttons,
// "Pyokka: Debug Current File" and "Pyokka: Stop Debugging", on a paused program, and a start
// without a breakpoint, which runs to the end like any debugger and leaves nothing behind.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const LINE = { add: 13 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Pyokka debugger: F5 on a fresh file, then Stop', function () {
  this.timeout(120_000);
  let api, doc, file;
  /** the `record: false` debug session the start makes; there is no run-all session here */
  const debugSession = () => api.debugSessions()[0];

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, '_stop_scratch_e2e.py');
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  after(async () => {
    for (const ds of api.debugSessions()) ds.dispose();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    api.manager.stopAll();
    try {
      fs.unlinkSync(file);
    } catch {
      /* gone */
    }
  });

  it('pauses at the breakpoint, then workbench.action.debug.stop ends the run and the debug session', async () => {
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(LINE.add - 1, 0)), true)]);
    await sleep(300);
    const started = new Promise((r) => {
      const d = vscode.debug.onDidStartDebugSession((s) => {
        d.dispose();
        r(s);
      });
    });
    await vscode.commands.executeCommand('workbench.action.debug.start');
    const ds = await started;
    assert.equal(ds.type, 'pyokka');
    const debug = await waitFor(() => debugSession(), 'the debug session', 30_000);
    assert.equal(api.manager.get(doc), undefined, 'no run-all session is created');
    const paused = await waitFor(() => debug.debug.paused, 'the pause', 30_000);
    assert.equal(paused.reason, 'breakpoint');
    assert.equal(paused.line, LINE.add);

    const ended = new Promise((r) => {
      const d = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.id === ds.id) {
          d.dispose();
          r();
        }
      });
    });
    await vscode.commands.executeCommand('workbench.action.debug.stop');
    let sessionEnded = true;
    await Promise.race([ended, sleep(10_000).then(() => (sessionEnded = false))]);
    assert.ok(sessionEnded, 'the VS Code debug session ended');
    await waitFor(() => api.debugSessions().length === 0, 'the debug session to be gone', 20_000);
    assert.ok(debug.isDisposed, 'the program is gone and so is the session');
  });

  it('the Debug command pauses at the breakpoint, and Stop Debugging ends run and debug session', async () => {
    // the panel's Debug and Stop buttons run these two commands
    await vscode.window.showTextDocument(doc);
    const started = new Promise((r) => {
      const d = vscode.debug.onDidStartDebugSession((s) => {
        d.dispose();
        r(s);
      });
    });
    await vscode.commands.executeCommand('pyokka.debugCurrentFile');
    const ds = await started;
    assert.equal(ds.type, 'pyokka');
    const debug = await waitFor(() => debugSession(), 'the debug session', 30_000);
    const paused = debug.debug.paused ?? (await debug.waitForPause(30_000));
    assert.notEqual(paused, 'finished', 'the program paused');
    assert.equal(paused.reason, 'breakpoint');
    assert.equal(paused.line, LINE.add);
    const ended = new Promise((r) => {
      const d = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.id === ds.id) {
          d.dispose();
          r();
        }
      });
    });
    await vscode.commands.executeCommand('pyokka.debugStop');
    await Promise.race([ended, sleep(10_000).then(() => assert.fail('the VS Code debug session did not end within 10 s'))]);
    await waitFor(() => api.debugSessions().length === 0, 'the debug session to be gone', 20_000);
    assert.equal(debug.lastFinished?.stopped, true);
  });

  it('the Debug command with no breakpoint runs to the end, as any debugger does, and leaves nothing behind', async () => {
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.debugCurrentFile');
    const debug = await waitFor(() => debugSession(), 'the debug session', 30_000);
    const finished = new Promise((r) => debug.once('finished', r));
    const fin = await Promise.race([finished, sleep(60_000).then(() => undefined)]);
    assert.ok(fin, 'no pause without a breakpoint: the program ran to the end');
    assert.equal(fin.exitCode, 0);
    await waitFor(() => !vscode.debug.activeDebugSession, 'the debug session to end with the program');
    await waitFor(() => api.debugSessions().length === 0, 'the registry to empty');
    assert.equal(api.manager.get(doc), undefined, 'and no run-all session was ever created');
  });
});
