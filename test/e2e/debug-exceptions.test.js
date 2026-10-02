// End-to-end: pausing on an exception in a `record: false` debug session, on a copy of
// test/e2e/fixtures/debug_raise.py. The default mode stops where the exception nobody caught was
// raised, with that frame live (locals, eval, and the CLI's stop slice with the output so far);
// Continue from there ends the program with exit 1. `raised` stops at every raise in the program's
// code, the one the `try` swallows included; `off` never stops and the program ends by itself.
// A run-all session on the file stays open throughout, untouched, so the bridge has both sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_raise.py');
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const NAME = '_debug_exceptions_e2e.py';
const LINE = { raise: 6, parse: 12, start: 17, print: 18, loop: 20, call: 21 };
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

describe('Pyokka debugger: pausing on exceptions', function () {
  this.timeout(180_000);
  let api, doc, file, session, python;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  function cli(args, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args, '--session', NAME], { cwd: PY_DIR });
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

  /**
   * Start a `record: false` debug session of the file with `mode` for exceptions and answer its
   * first stop. The mode is a launch attribute, because each start is a session of its own: a
   * finished debug session is gone, so nothing carries the mode over from the last one.
   */
  async function startDebug(mode = 'uncaught') {
    await vscode.window.showTextDocument(doc);
    assert.ok(
      await vscode.debug.startDebugging(undefined, { type: 'pyokka', request: 'launch', name: 'exceptions', program: file, breakOnException: mode, internalConsoleOptions: 'neverOpen' }),
      'the launch was accepted',
    );
    const vs = await waitFor(() => vscode.debug.activeDebugSession, 'the VS Code debug session');
    assert.equal(vs.type, 'pyokka');
    const debug = await waitFor(() => api.debugSessions()[0], 'the debug session');
    assert.equal(debug.debug.exceptions, mode);
    return { ds: vs, debug, stop: debug.debug.paused ?? (await debug.waitForPause(60_000)) };
  }

  /** Continue `debug` and answer the next stop. */
  async function resumeOn(debug) {
    const next = debug.waitForPause(60_000);
    await debug.debugContinue();
    const stop = await next;
    assert.notEqual(stop, 'finished', 'the program paused again');
    return stop;
  }

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
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'bridge descriptor');
  });

  after(async () => {
    for (const ds of api.debugSessions()) ds.dispose();
    if (session && !session.isDisposed) {
      session.stopDebug();
      await session.stopRun().catch(() => undefined);
    }
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  });

  it('pauses where the uncaught exception was raised, with the frame live, and Continue ends the run with exit 1', async () => {
    const { ds, debug, stop } = await startDebug();
    assert.notEqual(stop, 'finished', 'the program paused');
    assert.equal(stop.reason, 'exception');
    assert.equal(stop.exception.uncaught, true);
    assert.equal(stop.exception.type, 'ValueError');
    assert.match(stop.exception.message, /too big: 3/);
    assert.equal(stop.line, LINE.raise);
    assert.deepEqual(stop.stack.map((f) => f.name), ['check', '<module>']);
    assert.equal(api.debug(session).active, false, 'the run-all session was not touched');

    const locals = await debug.debugLocals();
    assert.equal(locals.find((v) => v.name === 'n')?.text, '3', `the raising frame: ${JSON.stringify(locals)}`);
    assert.equal((await debug.evaluate('n * 2'))?.text, '6');

    // the same stop over the bridge: the exception, the frame and what the program printed
    const ctx = await json('context', '--live');
    assert.equal(ctx.paused.exception.type, 'ValueError');
    assert.equal(ctx.paused.exception.uncaught, true);
    assert.ok(ctx.locals.some((v) => v.name === 'n'), 'the frame comes with the slice');
    assert.match(ctx.output.text, /start/, 'the output so far');
    assert.match(ctx.output.text, /-1/, 'the handled ValueError turned into -1 before the raise');
    const text = await cli(['context', '--live']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.raise} \\(uncaught ValueError: too big: 3\\)\\n`));
    assert.match(text.stdout, /\noutput \(last \d+ lines?\):\n  start\n/);

    const ended = new Promise((r) => {
      const d = vscode.debug.onDidTerminateDebugSession((s) => {
        if (s.id === ds.id) {
          d.dispose();
          r();
        }
      });
    });
    const next = debug.waitForPause(60_000);
    await debug.debugContinue();
    assert.equal(await next, 'finished', 'continuing an uncaught exception ends the program');
    assert.equal(debug.lastFinished?.exitCode, 1);
    await Promise.race([ended, sleep(10_000).then(() => assert.fail('the VS Code debug session did not end within 10 s'))]);
    await waitFor(() => !vscode.debug.activeDebugSession, 'the debug session to go');
    await waitFor(() => api.debugSessions().length === 0, 'the registry to empty');
  });

  it('raised stops at every raise in the program: the one the try swallows, then the one nobody catches', async () => {
    const { debug, stop } = await startDebug('raised');
    assert.notEqual(stop, 'finished', 'the program paused');
    assert.equal(stop.reason, 'exception');
    assert.equal(stop.line, LINE.parse, 'int("x") raises inside the try');
    assert.equal(stop.exception.uncaught, false);
    assert.equal(stop.exception.type, 'ValueError');

    const second = await resumeOn(debug);
    assert.equal(second.reason, 'exception');
    assert.equal(second.line, LINE.raise);
    assert.equal(second.exception.uncaught, false, 'first sighting: the frame is still live');
    assert.match(second.exception.message, /too big: 3/);

    const top = await resumeOn(debug);
    assert.equal(top.reason, 'exception');
    assert.equal(top.line, LINE.raise);
    assert.equal(top.exception.uncaught, true, 'nobody caught it: the top pause');

    const next = debug.waitForPause(60_000);
    await debug.debugContinue();
    assert.equal(await next, 'finished');
    assert.equal(debug.lastFinished?.exitCode, 1);
    await waitFor(() => !vscode.debug.activeDebugSession, 'the debug session to end with the program');
  });

  it('off never pauses: the program ends by itself and the debug session with it', async () => {
    await vscode.window.showTextDocument(doc);
    assert.ok(
      await vscode.debug.startDebugging(undefined, { type: 'pyokka', request: 'launch', name: 'off', program: file, breakOnException: 'off', internalConsoleOptions: 'neverOpen' }),
      'the launch was accepted',
    );
    const debug = await waitFor(() => api.debugSessions()[0], 'the debug session');
    assert.equal(debug.debug.exceptions, 'off');
    const finished = new Promise((r) => debug.once('finished', r));
    const fin = await Promise.race([finished, sleep(60_000).then(() => undefined)]);
    assert.ok(fin, 'no pause with exceptions off');
    assert.equal(fin.exitCode, 1);
    await waitFor(() => !vscode.debug.activeDebugSession, 'the debug session to end with the program');
    await waitFor(() => api.debugSessions().length === 0, 'the registry to empty');
    assert.equal(api.debug(session).active, false, 'the run-all session stayed out of it');
  });
});
