// End-to-end: inline values at a Debugger pause. A `record: false` session recorded nothing, so the
// editor's `name = value` comes from the inline values provider (src/debug/debugInlineValues.ts),
// which names the variables on the paused function's lines and lets VS Code read them off the
// frame. Asked through `vscode.executeInlineValueProvider`, the way VS Code asks at a stop.
// Target: test/e2e/fixtures/debug_target.py, copied into the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const NAME = '_debug_inline_e2e.py';
const LINE = { store: 5, add: 13 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Pyokka Debugger: inline values at a pause', function () {
  this.timeout(180_000);
  let api, doc, file;

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
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
      /* already gone */
    }
  });

  async function pauseAt(line) {
    for (const ds of api.debugSessions()) ds.stopDebug();
    await waitFor(() => api.debugSessions().length === 0 && !vscode.debug.activeDebugSession, 'the previous session to end', 30_000);
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(line - 1, 0)), true)]);
    await sleep(300);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.debug.start');
    const ds = await waitFor(() => api.debugSessions()[0], 'the debug session');
    const paused = ds.debug.paused ?? (await ds.waitForPause(60_000));
    assert.notEqual(paused, 'finished', 'the program paused');
    assert.equal(paused.line, line);
    return paused;
  }

  async function lookups(line) {
    const stopped = new vscode.Range(line - 1, 0, line - 1, 0);
    const all = new vscode.Range(0, 0, doc.lineCount - 1, 0);
    const values = await vscode.commands.executeCommand('vscode.executeInlineValueProvider', doc.uri, all, { frameId: 0, stoppedLocation: stopped });
    return (values || []).map((v) => `${v.range.start.line + 1}:${v.variableName}`);
  }

  it('a module-level pause names the variables on every line above it', async () => {
    await pauseAt(LINE.add);
    const names = await lookups(LINE.add);
    for (const n of ['9:payload', '10:total', '11:i', '12:d', '13:total', '13:d']) assert.ok(names.includes(n), `${n} in ${JSON.stringify(names)}`);
    assert.ok(!names.some((n) => Number(n.split(':')[0]) > LINE.add), 'nothing below the stopped line');
  });

  it('a pause inside a function names only that function', async () => {
    await pauseAt(LINE.store);
    const names = await lookups(LINE.store);
    assert.deepEqual(names, ['4:store', '4:i', '5:store', '5:i']);
  });
});
