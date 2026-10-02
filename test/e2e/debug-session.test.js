// End-to-end: the Debugger as its own product (docs/design/debugger-product.md, 3.3 to 3.6). F5 on
// a file with no Pyokka session creates a `record: false` debug session and no run-all session:
// nothing is recorded, there is no Time Machine, the panel's Debugger view has the stack and the
// locals, the run timeout never fires, an edit while paused is not applied, Stop leaves nothing
// behind, and a module launch runs as __main__ with its arguments.
// Target: test/e2e/fixtures/debug_target.py and fixtures/debug_pkg/, copied into the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const PKG = path.resolve(__dirname, 'fixtures', 'debug_pkg');
const NAME = '_debug_session_e2e.py';
const PKG_NAME = '_debug_pkg_e2e';
const LINE = { payload: 9, loop: 11, call: 12, add: 13, append: 14, print: 15 };
const PKG_LINE = { label: 15 };
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

describe('Pyokka Debugger: a debug session of its own', function () {
  this.timeout(180_000);
  let api, doc, file, root, pkgDir;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    pkgDir = path.join(root, PKG_NAME);
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const name of ['__init__.py', 'server.py']) fs.writeFileSync(path.join(pkgDir, name), fs.readFileSync(path.join(PKG, name), 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  after(async () => {
    for (const ds of api.debugSessions()) ds.dispose();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('runTimeout', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    try {
      fs.unlinkSync(file);
      fs.rmSync(pkgDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  });

  /** Stop every debug session and wait until the registry is empty. */
  async function stopAll() {
    for (const ds of api.debugSessions()) ds.stopDebug();
    await waitFor(() => api.debugSessions().length === 0, 'the debug sessions to end', 30_000);
    await waitFor(() => !vscode.debug.activeDebugSession, 'the VS Code debug session to end');
  }

  it('F5 on a fresh file creates a debug session and no run-all session', async () => {
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(LINE.add - 1, 0)), true)]);
    await sleep(300);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.debug.start');
    const ds = await waitFor(() => api.debugSessions()[0], 'the debug session');
    assert.equal(api.debugSessions().length, 1);
    assert.equal(vscode.debug.activeDebugSession?.type, 'pyokka');
    assert.equal(api.manager.get(doc), undefined, 'no run-all session was created');
    const paused = ds.debug.paused ?? (await ds.waitForPause(60_000));
    assert.notEqual(paused, 'finished', 'the program paused');
    assert.equal(paused.reason, 'breakpoint');
    assert.equal(paused.line, LINE.add);
    assert.equal(paused.stack[0].line, LINE.add, 'the frame chain carries the paused line');
    assert.equal(paused.thread?.name, 'MainThread');
    assert.equal(ds.record, false);
    assert.equal(ds.launch.program, file);
  });

  it('starting the session brings the panel to the Debugger view', async () => {
    // the reveal hangs off the registry's `sessionStarted`, under `pyokka.showOutputOnStart`
    const view = await waitFor(() => (api.panel.activeView === 'debug' ? api.panel.activeView : undefined), 'the panel to show the Debugger view', 30_000);
    assert.equal(view, 'debug');
    // and the editor kept the caret: the panel was shown with focus preserved
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, file);
  });

  it('the Debugger view has the frame and there is no Time Machine', async () => {
    const panel = await waitFor(() => {
      const p = api.debugPanelState();
      return p && p.paused && p.locals.length ? p : undefined;
    }, 'the Debugger view state with locals', 30_000);
    assert.equal(panel.paused, true);
    assert.equal(panel.record, false);
    assert.equal(panel.displayName, NAME);
    assert.equal(panel.location, `${NAME}:${LINE.add}`);
    assert.match(panel.reasonText, /^breakpoint/);
    assert.ok(panel.stack.length >= 1, `the stack: ${JSON.stringify(panel.stack)}`);
    assert.equal(panel.stack[0].line, LINE.add);
    assert.equal(panel.selectedFrame, 0);
    const names = new Set(panel.locals.map((v) => v.name));
    for (const n of ['payload', 'total', 'i', 'd']) assert.ok(names.has(n), `local ${n}`);
    assert.ok(panel.breakpoints.some((b) => b.line === LINE.add), 'the gutter breakpoint is listed');
    assert.equal(panel.exceptions, 'uncaught');
    assert.equal(panel.modified, false);
    // nothing is recorded: no run-all session exists to hold a trace or a timeline
    assert.equal(api.manager.get(doc), undefined);
    assert.equal(api.manager.all().length, 0, 'no run-all session anywhere');
  });

  it('no timeout while paused', async () => {
    await config().update('runTimeout', 800, vscode.ConfigurationTarget.Global);
    const ds = api.debugSessions()[0];
    assert.ok(ds, 'still paused from the case above');
    await sleep(2000);
    assert.ok(ds.debug.paused, 'a paused program is off the clock');
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    const finished = new Promise((r) => ds.once('finished', r));
    await ds.debugContinue();
    const fin = await Promise.race([finished, sleep(30_000).then(() => undefined)]);
    assert.ok(fin, 'the run finished after the continue');
    assert.equal(fin.exitCode, 0);
    assert.equal(fin.timedOut, false);
    await config().update('runTimeout', undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.debugSessions().length === 0, 'the session to be disposed when the program exits');
  });

  it('an edit while paused is allowed and not applied', async () => {
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(LINE.add - 1, 0)), true)]);
    await sleep(300);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.debug.start');
    const ds = await waitFor(() => api.debugSessions()[0], 'the debug session');
    const paused = ds.debug.paused ?? (await ds.waitForPause(60_000));
    assert.notEqual(paused, 'finished');
    const runId = ds.runId;
    const before = await ds.debugLocals();
    assert.ok(!before.some((v) => v.name === 'MARKER'), 'the marker is not in the running program');
    // an edit above the breakpoint: the buffer takes it, the paused program does not
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(LINE.payload - 1, 0), 'MARKER = 7\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'the edit was applied to the buffer');
    await sleep(600);
    assert.equal(ds.runId, runId, 'no new run started');
    assert.equal(ds.debug.paused?.step, paused.step, 'the pause did not move');
    const still = await ds.debugLocals();
    assert.ok(!still.some((v) => v.name === 'MARKER'), 'the edit is not applied to the program that is paused');
    // the next start runs what is on disk: save it, restart, and the marker is a local
    await doc.save();
    const restarted = ds.waitForPause(60_000);
    await ds.restart({ stopOnEntry: false });
    const again = await restarted;
    assert.notEqual(again, 'finished', 'the restarted run reached the breakpoint');
    const after = await ds.debugLocals();
    assert.ok(after.some((v) => v.name === 'MARKER'), `the restarted run sees the edit: ${JSON.stringify(after.map((v) => v.name))}`);
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await stopAll();
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    const reopened = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(reopened);
  });

  it('Stop ends the session and removes it from the registry', async () => {
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    try {
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(LINE.add - 1, 0)), true)]);
      await sleep(300);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.debug.start');
      const ds = await waitFor(() => api.debugSessions()[0], 'the debug session');
      assert.notEqual(ds.debug.paused ?? (await ds.waitForPause(60_000)), 'finished');
      const descriptor = await waitFor(() => api.agentBridge.debugDescriptorFor(ds), 'the debug descriptor');
      assert.ok(fs.existsSync(descriptor), 'the descriptor is on disk while the session lives');
      const doc2 = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      assert.equal(doc2.kind, 'debug');
      assert.equal(doc2.launch.program, file);
      assert.equal(doc2.launch.record, false);
      await vscode.commands.executeCommand('workbench.action.debug.stop');
      await waitFor(() => api.debugSessions().length === 0, 'the registry to empty', 30_000);
      await waitFor(() => !fs.existsSync(descriptor), 'the descriptor to go');
      assert.equal(api.debugPanelState(), null, 'the Debugger view has nothing to show');
    } finally {
      await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      await stopAll();
    }
  });

  it('a module launch runs and pauses', async () => {
    const serverFile = path.join(pkgDir, 'server.py');
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(serverFile), new vscode.Position(PKG_LINE.label - 1, 0)), true)]);
    await sleep(300);
    try {
      assert.ok(
        await vscode.debug.startDebugging(undefined, {
          type: 'pyokka',
          request: 'launch',
          name: 'module',
          module: `${PKG_NAME}.server`,
          args: ['--port', '8123'],
          cwd: root,
          internalConsoleOptions: 'neverOpen',
        }),
        'the module launch was accepted',
      );
      const ds = await waitFor(() => api.debugSessions()[0], 'the debug session');
      assert.equal(ds.displayName, `-m ${PKG_NAME}.server`);
      assert.equal(ds.launch.module, `${PKG_NAME}.server`);
      assert.equal(ds.launch.program, undefined);
      assert.deepEqual(ds.launch.args, ['--port', '8123']);
      const paused = ds.debug.paused ?? (await ds.waitForPause(60_000));
      assert.notEqual(paused, 'finished', 'the module paused at the breakpoint');
      assert.equal(paused.line, PKG_LINE.label);
      const locals = await ds.debugLocals();
      assert.equal(locals.find((v) => v.name === 'port')?.text, '8123', `sys.argv reached the module: ${JSON.stringify(locals)}`);
      // the first instrumented file of a dotted launch is the package's __init__.py, not the module
      assert.ok(ds.mainFile && ds.mainFile.startsWith(pkgDir), `the main file is in the package: ${ds.mainFile}`);
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      const finished = new Promise((r) => ds.once('finished', r));
      await ds.debugContinue();
      const fin = await Promise.race([finished, sleep(30_000).then(() => undefined)]);
      assert.ok(fin, 'the module ran to the end');
      assert.equal(fin.exitCode, 0);
    } finally {
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      await stopAll();
    }
  });

  it('a module launch with record: true is refused and names record: false', async () => {
    const ok = await vscode.debug.startDebugging(undefined, { type: 'pyokka', request: 'launch', name: 'module record', module: `${PKG_NAME}.server`, cwd: root, record: true, internalConsoleOptions: 'neverOpen' });
    assert.equal(ok, false, 'the launch was refused');
    assert.equal(api.debugSessions().length, 0, 'nothing was started');
  });
});
