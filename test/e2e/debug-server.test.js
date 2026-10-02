// End-to-end: the Debugger on a server (docs/design/debugger-product.md, 2.11, 4.4). A
// ThreadingHTTPServer on port 0 runs until a request arrives; the breakpoint in the handler pauses
// that request's thread, `continue --live --no-wait` resumes it without waiting for the next stop,
// two requests in flight pause one after the other, and Stop kills the server.
// Target: test/e2e/fixtures/debug_server.py, copied into the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_server.py');
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const NAME = '_debug_server_e2e.py';
const LINE = { total: 14, body: 15 };
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

/** One GET, resolved with the body; never awaited before the request is meant to pause. */
function get(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url, timeout: 60_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

/** True when nothing is listening on the port any more. */
function closed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(true));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/** Poll until the port stops accepting, or fail. */
async function waitClosed(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await closed(port)) return;
    await sleep(200);
  }
  throw new Error(`the server on port ${port} still accepts connections`);
}

describe('Pyokka Debugger on a server', function () {
  this.timeout(240_000);
  let api, doc, file, python, port;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  function cli(args, timeoutMs = 60_000) {
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

  const debugSession = () => api.debugSessions()[0];

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(LINE.total - 1, 0)), true)]);
    await sleep(300);
    await vscode.commands.executeCommand('workbench.action.debug.start');
    const ds = await waitFor(() => debugSession(), 'the debug session');
    // the interpreter the host resolved for the debug session is the one the CLI runs from
    python = ds.interpreter;
    await waitFor(() => api.agentBridge.debugDescriptorFor(ds), 'the debug descriptor');
    const line = await waitFor(() => /listening on (\d+)/.exec(ds.output), 'the port the server printed', 60_000);
    port = Number(line[1]);
    assert.ok(port > 0, `the server printed its port: ${ds.output}`);
    assert.ok(!ds.debug.paused, 'nothing pauses until a request arrives');
  });

  after(async () => {
    for (const ds of api.debugSessions()) ds.dispose();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  });

  it('a breakpoint in a handler pauses when a request arrives', async () => {
    const ds = debugSession();
    const request = get(port, '/health').catch(() => undefined);
    const paused = await ds.waitForPause(60_000);
    assert.notEqual(paused, 'finished', 'the handler paused');
    assert.equal(paused.reason, 'breakpoint');
    assert.equal(paused.line, LINE.total);
    assert.ok(paused.thread, 'the pause names its thread');
    assert.notEqual(paused.thread.name, 'MainThread', `a request runs in a worker thread: ${paused.thread.name}`);
    const locals = await ds.debugLocals();
    assert.equal(locals.find((v) => v.name === 'path')?.text, "'/health'", `the handler's frame: ${JSON.stringify(locals)}`);
    // the same stop over the bridge, with the server's output so far
    const stop = await json('context', '--live');
    assert.equal(stop.paused.line, LINE.total);
    assert.match(stop.output.text, /listening on \d+/);
    // the chain from the module to the handler runs through http.server and socketserver. Those
    // frames have no instrumented source to show, so the slice folds each run of them into one
    // marker: dropping them left `do_GET <- <module>`, a call the program never made
    assert.equal(stop.stack[0].function, 'do_GET');
    const folded = stop.stack.filter((f) => f.elided);
    assert.ok(folded.length >= 1, `the library frames are folded, not dropped: ${JSON.stringify(stop.stack)}`);
    assert.ok(
      folded.some((f) => (f.in || []).some((where) => /server\.py$/.test(where))),
      `the fold names the files it went through: ${JSON.stringify(folded)}`,
    );
    assert.ok(folded.every((f) => f.elided > 0 && f.where === 'library'), JSON.stringify(folded));
    assert.equal(stop.values.length, 0, 'nothing is recorded');
    assert.equal(stop.count, undefined, 'there is no trace to count');
    assert.equal(stop.moves, undefined);
    const resumed = await json('continue', '--live', '--no-wait');
    assert.equal(resumed.resumed, true, 'the resume did not wait for the next stop');
    const answer = await request;
    assert.ok(answer, 'the pending request was answered');
    assert.equal(answer.status, 200);
    assert.equal(answer.body, 'ok 7');
  });

  it('continue --no-wait resumes without waiting for the next pause', async () => {
    const ds = debugSession();
    const first = get(port, '/a').catch(() => undefined);
    const paused = await ds.waitForPause(60_000);
    assert.notEqual(paused, 'finished');
    const started = Date.now();
    const r = await json('continue', '--live', '--no-wait');
    assert.equal(r.resumed, true);
    assert.ok(Date.now() - started < 20_000, 'the reply came without a second request arriving');
    assert.ok(await first, 'the request was answered');
    // a second request pauses again: the breakpoint is still armed
    const second = get(port, '/b').catch(() => undefined);
    const again = await ds.waitForPause(60_000);
    assert.notEqual(again, 'finished');
    assert.equal(again.line, LINE.total);
    await json('continue', '--live', '--no-wait');
    assert.ok(await second, 'the second request was answered');
  });

  it('two requests queue: they pause one after the other and both are answered', async () => {
    const ds = debugSession();
    const a = get(port, '/one').catch(() => undefined);
    const b = get(port, '/two2').catch(() => undefined);
    const paths = [];
    for (let i = 0; i < 2; i++) {
      // the second thread is already blocked on the pause lock, so it can pause the instant the
      // first resumes: read the pause the session holds before waiting for a new one
      const paused = ds.debug.paused ?? (await ds.waitForPause(60_000));
      assert.notEqual(paused, 'finished', `pause ${i + 1}`);
      assert.equal(paused.line, LINE.total);
      const locals = await ds.debugLocals();
      paths.push(locals.find((v) => v.name === 'path')?.text);
      // exactly one thread is served at a time: the second waits for this resume
      await json('continue', '--live', '--no-wait');
      if (i === 0) await waitFor(() => ds.debug.paused || undefined, 'the second handler to pause', 60_000);
    }
    assert.deepEqual([...paths].sort(), ["'/one'", "'/two2'"], `both handlers paused: ${JSON.stringify(paths)}`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra?.status, 200);
    assert.equal(rb?.status, 200);
  });

  it('pause --no-wait asks for a pause the server reaches at its next request', async () => {
    const ds = debugSession();
    await waitFor(() => !ds.debug.paused || undefined, 'the server to be running again');
    const r = await json('pause', '--live', '--no-wait');
    assert.equal(r.requested, true);
    assert.equal(r.paused, false, 'a server blocked in accept() has not reached a statement yet');
    let answered = false;
    const request = get(port, '/c').then(
      (x) => ((answered = true), x),
      () => ((answered = true), undefined),
    );
    // the requested pause lands at the handler's first statement, and the breakpoint pauses it
    // again a line later: keep resuming until the request is answered
    let stops = 0;
    while (!answered && stops < 6) {
      const paused = ds.debug.paused ?? (await ds.waitForPause(60_000));
      if (paused === 'finished') break;
      stops += 1;
      await json('continue', '--live', '--no-wait');
      await sleep(200);
    }
    assert.ok(stops >= 1, 'the request brought the program to a statement');
    assert.ok(await request, 'the request was answered');
  });

  it('Stop kills the server', async () => {
    const ds = debugSession();
    const ended = new Promise((r) => ds.once('ended', r));
    await vscode.commands.executeCommand('workbench.action.debug.stop');
    await Promise.race([ended, sleep(30_000).then(() => assert.fail('the debug session did not end within 30 s'))]);
    await waitFor(() => api.debugSessions().length === 0, 'the registry to empty');
    await waitClosed(port);
  });
});
