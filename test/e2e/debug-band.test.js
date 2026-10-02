// End-to-end: what the Claude Code band reads at a `record: false` pause
// (docs/design/live-pause-context.md). A run-all session on invoices.py stays open, so the bridge
// has both sockets, which is the case the band met: `context --live` on the run socket used to
// answer "the Time Machine is not active" while a plain debug pause sat on the same file.
// Now both sockets answer with the pause, marked `recording: false`, with the frame's variables
// and their shape. `stop` and then `debug --record-from FILE:LINE` is the band's "record from
// here". With PYOKKA_BAND_CAPTURE set to a file path, the replies are written there for
// scripts/band-fixtures.py --live.
// Targets: claude-plugin/pyokka-band/tests/programs/{invoices,crash}.py, copied into the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const PROGRAMS = path.resolve(__dirname, '..', '..', 'claude-plugin', 'pyokka-band', 'tests', 'programs');
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const DIR = '_band_e2e';
const LINE = { subtotal: 34 };
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

describe('the band at a plain debug pause', function () {
  this.timeout(240_000);
  let api, root, invoices, crash, session, python, runDescriptor;
  const captured = {};
  const config = () => vscode.workspace.getConfiguration('pyokka');

  function cli(args, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args], { cwd: PY_DIR, env: { ...process.env, PYOKKA_NO_FOCUS: '1' } });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`pyokka ${args.join(' ')} took over ${timeoutMs} ms; stdout=${stdout} stderr=${stderr}`));
      }, timeoutMs);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }
  async function json(...args) {
    const r = await cli([...args, '--json']);
    assert.equal(r.status, 0, `exit ${r.status} for ${args.join(' ')}: ${r.stdout} ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  /** A `record: false` debug session of `file`, and its first stop. */
  async function startDebug(file) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    assert.ok(await vscode.debug.startDebugging(undefined, { type: 'pyokka', request: 'launch', name: 'band', program: file, internalConsoleOptions: 'neverOpen' }), 'the launch was accepted');
    const debug = await waitFor(() => api.debugSessions().find((d) => d.filePath === file), 'the debug session');
    await waitFor(() => api.agentBridge.debugDescriptorFor(debug), 'the debug descriptor');
    return { debug, stop: debug.debug.paused ?? (await debug.waitForPause(60_000)) };
  }

  async function endDebug() {
    for (const ds of api.debugSessions()) ds.stopDebug();
    await waitFor(() => api.debugSessions().length === 0, 'the debug sessions to end');
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    api = await ext.activate();
    root = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, DIR);
    fs.mkdirSync(root, { recursive: true });
    invoices = path.join(root, 'invoices.py');
    crash = path.join(root, 'crash.py');
    fs.copyFileSync(path.join(PROGRAMS, 'invoices.py'), invoices);
    fs.copyFileSync(path.join(PROGRAMS, 'crash.py'), crash);
    const doc = await vscode.workspace.openTextDocument(invoices);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
    runDescriptor = await waitFor(() => api.agentBridge.descriptorFor(session), 'the run descriptor');
  });

  after(async () => {
    await endDebug().catch(() => undefined);
    if (session && !session.isDisposed) {
      session.stopDebug();
      await session.stopRun().catch(() => undefined);
    }
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    if (process.env.PYOKKA_BAND_CAPTURE) fs.writeFileSync(process.env.PYOKKA_BAND_CAPTURE, JSON.stringify({ dir: root, ...captured }, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('context on either socket answers the pause, unrecorded, with the frame and its shapes', async () => {
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(invoices), new vscode.Position(LINE.subtotal - 1, 0)), true)]);
    await waitFor(() => vscode.debug.breakpoints.length === 1, 'the breakpoint');
    await sleep(500);
    const { stop } = await startDebug(invoices);
    assert.notEqual(stop, 'finished', 'the program paused');
    assert.equal(stop.line, LINE.subtotal);
    assert.equal(session.nav.active, false, 'the run-all session has no Time Machine running');

    // the run socket, named by descriptor: the band's case
    const ctx = await json('context', '--live', '--session', runDescriptor);
    assert.equal(ctx.recording, false, `marked unrecorded: ${JSON.stringify(ctx).slice(0, 300)}`);
    assert.equal(ctx.count, undefined, 'no recording, no count');
    assert.equal(ctx.location.line, LINE.subtotal);
    assert.equal(ctx.location.function, 'subtotal');
    const names = ctx.stack.map((f) => f.function);
    assert.equal(names[0], 'subtotal');
    for (const caller of ['invoice_total', 'main', '<module>']) assert.ok(names.includes(caller), `the stack: ${names.join(' < ')}`);
    assert.ok(ctx.block.lines.some((l) => l.current && l.line === LINE.subtotal), 'the block marks the current line');
    const items = ctx.locals.find((v) => v.name === 'items');
    assert.ok(items, `the frame's variables: ${JSON.stringify(ctx.locals)}`);
    assert.equal(items.type, 'list');
    assert.equal(items.length, 2, "Ana's two lines");
    captured.PAUSED_SUBTOTAL = ctx;

    // the debug socket, by file name: the same pause
    const byName = await json('context', '--live', '--session', 'invoices.py');
    assert.equal(byName.recording, false);
    assert.equal(byName.location.line, LINE.subtotal);
    assert.deepEqual(byName.locals.map((v) => v.name), ctx.locals.map((v) => v.name));

    // `n` in the band: step --over through the run socket executes in the debug session
    const over = await json('step', '--live', '--over', '--session', runDescriptor);
    captured.PAUSED_OVER = over;
    assert.equal(over.recording, false, `the step answers unrecorded too: ${JSON.stringify(over).slice(0, 300)}`);
    assert.ok(over.step > ctx.step, `the program ran on: ${ctx.step} then ${over.step}`);
    assert.ok(over.paused.reason, JSON.stringify(over.paused));
  });

  it('record from here: stop the plain run, then debug --record-from FILE:LINE pauses there as step 0', async () => {
    const stopped = await json('stop', '--live', '--session', 'invoices.py');
    assert.equal(stopped.stopped, true);
    await waitFor(() => api.debugSessions().length === 0, 'the debug session to end');
    const started = await json('debug', invoices, '--record-from', `${invoices}:${LINE.subtotal}`, '--no-focus');
    assert.equal(started.location.line, LINE.subtotal, JSON.stringify(started).slice(0, 300));
    const ctx = await json('context', '--live', '--session', 'invoices.py');
    assert.equal(ctx.step, 0);
    assert.equal(ctx.recordingStart, true);
    assert.ok(ctx.count >= 1);
    assert.notEqual(ctx.recording, false);
    session.stopDebug();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  it('an uncaught exception pause carries its type and message', async () => {
    await endDebug();
    const { stop } = await startDebug(crash);
    assert.notEqual(stop, 'finished');
    assert.equal(stop.reason, 'exception');
    const ctx = await json('context', '--live', '--session', 'crash.py');
    assert.equal(ctx.recording, false);
    assert.equal(ctx.paused.exception.type, 'KeyError');
    assert.equal(ctx.paused.exception.uncaught, true);
    assert.equal(ctx.location.function, 'tier_of');
    captured.PAUSED_CRASH = ctx;
    await endDebug();
  });
});
