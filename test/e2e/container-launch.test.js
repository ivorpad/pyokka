// A container has only Python and the project. The wrapper owns its environment.
// Set PYOKKA_TEST_CONTAINER=docker or podman for a real container; otherwise test the same
// stdio transport against a second source directory through a local wrapper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

const NAME = '_container_launch_e2e.py';
const HELPER = '_container_helper_e2e.py';
const WRAPPER = '_container_wrapper_e2e.sh';
const PROGRAM = [
  'import os, sys',
  'from _container_helper_e2e import combine',
  'auth_ok = os.environ.get("WRAPPER_SESSION") == "ready"',
  'flag = os.environ.get("LAUNCH_VALUE")',
  'cwd = os.getcwd()',
  'argv = sys.argv[1:]',
  'total = combine(4, 5)',
  'print(auth_ok, flag, cwd, argv, total)',
].join('\n') + '\n';
const HELPER_SOURCE = 'def combine(left, right):\n    total = left + right\n    return total\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(read, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${what}`);
}

describe('container launch with recording', function () {
  this.timeout(120_000);
  let api, root, file, helper, doc, scratch, remote, python, transport, container;
  const engine = process.env.PYOKKA_TEST_CONTAINER;

  before(async () => {
    api = await vscode.extensions.getExtension('ivor.pyokka').activate();
    api.manager.stopAll();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    helper = path.join(root, HELPER);
    fs.writeFileSync(file, PROGRAM);
    fs.writeFileSync(helper, HELPER_SOURCE);
    fs.writeFileSync(path.join(root, WRAPPER), '#!/bin/sh\nexport WRAPPER_SESSION=ready\nexec "$@"\n');
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-container-'));
    if (engine) {
      remote = '/var/task';
      python = '/usr/local/bin/python';
      container = execFileSync(engine, ['run', '-d', '--rm', '-v', `${root}:${remote}:ro`, '-w', remote, 'python:3.12-slim', 'sleep', '600'], { encoding: 'utf8' }).trim();
      transport = { command: engine, args: ['exec', '-i', '--workdir', remote, container, '/bin/sh', `${remote}/${WRAPPER}`] };
    } else {
      remote = path.join(scratch, 'remote');
      fs.mkdirSync(remote);
      for (const name of [NAME, HELPER, WRAPPER]) fs.copyFileSync(path.join(root, name), path.join(remote, name));
      python = path.resolve(__dirname, '../../python/.venv/bin/python');
      transport = { command: '/bin/sh', args: [path.join(remote, WRAPPER)] };
    }
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.workspace.getConfiguration('pyokka').update('agentAccess', true, vscode.ConfigurationTarget.Global);
  });

  after(async () => {
    await vscode.debug.stopDebugging();
    api?.manager.stopAll();
    for (const ds of api?.debugSessions() ?? []) ds.dispose();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.workspace.getConfiguration('pyokka').update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    if (container) execFileSync(engine, ['rm', '-f', container], { stdio: 'ignore' });
    for (const name of [NAME, HELPER, WRAPPER]) if (root) fs.rmSync(path.join(root, name), { force: true });
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  function configuration(record) {
    return { name: 'Container test', type: 'pyokka', request: 'launch', program: file,
      cwd: remote, python, transport, pathMappings: [{ localRoot: root, remoteRoot: remote }],
      args: ['--check'], env: { LAUNCH_VALUE: 'explicit' }, record };
  }

  it('records through the wrapper, pauses in a mapped import, steps and exports local source paths', async () => {
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(helper), new vscode.Position(1, 0)))]);
    assert.equal(await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], configuration(true)), true);
    const s = await waitFor(() => api.manager.sessionForDocument(doc), 'recording session');
    await waitFor(() => s.debug.paused || s.lastError, 'mapped breakpoint');
    assert.equal(s.lastError, undefined);
    assert.equal(s.uriForFileId(s.debug.paused.fileId).fsPath, helper);
    assert.equal(s.debug.paused.line, 2);
    assert.match((await s.evaluateLive('left + right')).text, /9/);
    assert.ok(s.trace?.count > 0, 'the container pause has recorded history');
    const dap = vscode.debug.activeDebugSession;
    const stack = await dap.customRequest('stackTrace', { threadId: 1 });
    assert.equal(stack.stackFrames[0].source.path, helper);
    await dap.customRequest('next', { threadId: 1 });
    await waitFor(() => s.debug.paused?.line === 3, 'step in container');
    assert.equal((await s.evaluateLive('total')).text, '9');
    await dap.customRequest('continue', { threadId: 1 });
    await api.waitForIdle(s, 30_000);
    assert.equal(s.state.finished.exitCode, 0);
    assert.match(s.state.output, /True explicit/);
    assert.match(s.state.output, /--check/);
    assert.ok(s.files.all().every((f) => f.path.startsWith(root)), 'the recording stores local source paths');
    assert.ok(s.files.byPath(file) && s.files.byPath(helper));
    // The regular bridge exporter reads this file table; the Time Machine must find its ranges.
    assert.ok(s.trace.count > 5);
    await vscode.debug.stopDebugging();
    api.manager.stopAll();
  });

  it('also launches without recording and keeps remote interpreter selection off the host', async () => {
    assert.equal(await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], configuration(false)), true);
    const ds = await waitFor(() => api.debugSessions()[0], 'debug session');
    await waitFor(() => ds.debug.paused || ds.lastError, 'debugger pause');
    assert.equal(ds.lastError, undefined);
    assert.equal(ds.pathForFileId(ds.debug.paused.fileId), helper);
    assert.equal(ds.debug.paused.line, 2);
    assert.equal(ds.interpreter, python);
    await vscode.debug.stopDebugging();
    await waitFor(() => api.debugSessions().length === 0, 'debugger stop');
  });
});
