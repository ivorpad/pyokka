const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(read, what) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${what}`);
}
function get(port, auth = 'test-session') {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', headers: { 'X-Test-Auth': auth } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
  });
}

describe('debugpy attach', function () {
  this.timeout(120_000);
  let scratch, local, remote, child, endpoint, tracker;
  const messages = [];
  const sent = [];
  let stderr = '';
  const stopped = (since) => waitFor(() => messages.slice(since).find((m) => m.type === 'event' && m.event === 'stopped'), 'debugpy stop');

  before(async () => {
    await vscode.extensions.getExtension('ivor.pyokka').activate();
    await vscode.debug.stopDebugging();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-attach-'));
    local = path.join(scratch, 'local');
    remote = path.join(scratch, 'container');
    fs.mkdirSync(local);
    fs.mkdirSync(remote);
    const source = fs.readFileSync(path.join(__dirname, 'fixtures/attach_server.py'), 'utf8');
    for (const directory of [local, remote]) fs.writeFileSync(path.join(directory, 'server.py'), source);
    const line = source.split('\n').findIndex((s) => s.includes('# attach breakpoint'));
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(path.join(local, 'server.py')), new vscode.Position(line, 0)))]);
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('pyokka', {
      createDebugAdapterTracker: () => ({
        onDidSendMessage: (message) => messages.push(message),
        onWillReceiveMessage: (message) => sent.push(message),
      }),
    });
    const python = path.resolve(__dirname, '../../python/.venv/bin/python');
    child = spawn(python, ['-u', path.join(remote, 'server.py')], { cwd: remote, env: { ...process.env, TEST_AUTH: 'test-session' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('\n')) endpoint = JSON.parse(stdout.split('\n')[0]);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
      return endpoint;
    }, 'running server');
  });

  after(async () => {
    await vscode.debug.stopDebugging();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    tracker?.dispose();
    if (child?.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function attach() {
    assert.equal(await vscode.debug.startDebugging(undefined, {
      type: 'pyokka', request: 'attach', name: 'Existing server',
      connect: { host: '127.0.0.1', port: endpoint.debugPort },
      pathMappings: [{ localRoot: local, remoteRoot: remote }], justMyCode: true,
    }), true, stderr);
    return vscode.debug.activeDebugSession;
  }

  it('maps breakpoints and stack paths, reads locals, steps and detaches without restarting the server', async () => {
    assert.equal((await get(endpoint.httpPort)).body.pid, endpoint.pid);
    assert.equal((await get(endpoint.httpPort, 'wrong')).status, 401);
    const session = await attach();
    let from = messages.length;
    const response = get(endpoint.httpPort);
    const stop = await stopped(from);
    const threadId = stop.body.threadId;
    const stack = await session.customRequest('stackTrace', { threadId });
    assert.equal(stack.stackFrames[0].source.path, path.join(local, 'server.py'));
    const scopes = await session.customRequest('scopes', { frameId: stack.stackFrames[0].id });
    const locals = await session.customRequest('variables', { variablesReference: scopes.scopes[0].variablesReference });
    assert.equal(locals.variables.find((v) => v.name === 'route').value, "'/health'");
    from = messages.length;
    await session.customRequest('next', { threadId });
    await stopped(from);
    await vscode.debug.stopDebugging(session);
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal(result.body.pid, endpoint.pid);
    assert.equal(child.exitCode, null);
    assert.equal((await get(endpoint.httpPort)).body.pid, endpoint.pid);
    assert.ok(sent.some((m) => m.command === 'disconnect' && m.arguments?.terminateDebuggee !== true));
  });

  it('reattaches to the same server and preserves its authentication', async () => {
    const session = await attach();
    const from = messages.length;
    const response = get(endpoint.httpPort);
    await stopped(from);
    await vscode.debug.stopDebugging(session);
    assert.equal((await response).body.pid, endpoint.pid);
    assert.equal((await get(endpoint.httpPort, 'wrong')).status, 401);
    assert.equal(child.exitCode, null);
  });
});
