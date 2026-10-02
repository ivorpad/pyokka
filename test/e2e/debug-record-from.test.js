// End-to-end: `pyokka debug FILE --record-from NAME` and `pyokka record --live`, cold from a
// terminal. The program runs with the debugger's hooks up to the pause at NAME and records from
// that pause on: step 0 is the pause, `why` chains end there, and `record --live` at an earlier
// pause starts the recording sooner. The URI goes through a `code` stub as in
// debug-cli-cold.test.js. Target: test/e2e/fixtures/debug_target.py, copied under two names (one
// per case: a path rewritten under an open editor closes the document and its session).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const LINE = { bump: 4, store: 5, payload: 9, loop: 11 };
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

describe('pyokka debug FILE --record-from', function () {
  this.timeout(240_000);
  let api, root, python, stubDir, stub, uriFile;
  const files = [];
  const config = () => vscode.workspace.getConfiguration('pyokka');

  function cli(args, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args], { cwd: PY_DIR, env: { ...process.env, PYOKKA_CODE: stub, PYOKKA_NO_FOCUS: '1' } });
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

  function forwardUri() {
    let stopped = false;
    const done = (async () => {
      for (let i = 0; i < 600 && !stopped; i++) {
        if (fs.existsSync(uriFile)) {
          const uri = fs.readFileSync(uriFile, 'utf8').trim();
          fs.rmSync(uriFile, { force: true });
          if (uri) {
            await api.handleDebugUri(vscode.Uri.parse(uri));
            return uri;
          }
        }
        await sleep(50);
      }
      return undefined;
    })();
    return { uri: done, stop: () => void (stopped = true) };
  }

  async function stopAll() {
    for (const ds of api.debugSessions()) ds.stopDebug();
    await waitFor(() => api.debugSessions().length === 0, 'the debug sessions to end');
    api.manager.stopAll();
  }

  function target(name) {
    const file = path.join(root, name);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    files.push(file);
    return file;
  }

  const first = (r) => r.stdout.split('\n')[0];

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    // a session for a moment, only to learn the interpreter the CLI should run from
    const probeFile = target('_record_from_probe_e2e.py');
    const doc = await vscode.workspace.openTextDocument(probeFile);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const probe = api.manager.sessionForDocument(doc);
    assert.ok(probe, 'session created');
    python = probe.interpreter.path;
    await api.waitForIdle(probe, 60_000);
    api.manager.stopAll();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-code-'));
    uriFile = path.join(stubDir, 'uri.txt');
    stub = path.join(stubDir, 'code-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$2" > ${JSON.stringify(uriFile)}\n`);
    fs.chmodSync(stub, 0o755);
  });

  after(async () => {
    await stopAll();
    const memory = path.join(process.env.PYOKKA_HOME || path.join(os.homedir(), '.pyokka'), 'last-debug.json');
    try {
      const data = JSON.parse(fs.readFileSync(memory, 'utf8'));
      delete data[fs.realpathSync(PY_DIR)];
      fs.writeFileSync(memory, JSON.stringify(data, null, 2));
    } catch {
      /* nothing remembered */
    }
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    for (const f of files) fs.rmSync(f, { force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('records from the first call of NAME: step 0, why ends there, back stops there, history keeps the chain', async () => {
    const name = '_record_from_a_e2e.py';
    const file = target(name);
    const re = (s) => s.replace('.', '\\.');
    fs.rmSync(uriFile, { force: true });
    const forward = forwardUri();
    try {
    let r = await cli(['debug', file, '--record-from', 'bump']);
    const uri = await forward.uri;
    forward.stop();
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(uri, /recordFrom=bump/);
    assert.match(uri, /record=1/);
    assert.match(uri, /at=bump/, 'the record-from point is a pause too');
    assert.match(first(r), new RegExp(`^paused at ${re(name)}:${LINE.bump} \\(breakpoint; recording starts here, step 0\\)`));
    assert.equal(api.debugSessions().length, 0, 'a recording session, not a record: false one');
    assert.equal(api.manager.all().length, 1);

    r = await cli(['state', '--live', '--session', name, '--json']);
    const st = JSON.parse(r.stdout);
    assert.equal(st.debug.recording, true, r.stdout);
    assert.deepEqual(st.debug.recordFrom, { function: 'bump' });

    r = await cli(['why', '--live', '--session', name, '0', 'payload']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /payload = \? {3}made before #0, where the recording started/, r.stdout);

    r = await cli(['step', '--live', '--session', name, '--over']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`${re(name)}:${LINE.store}`), r.stdout);
    r = await cli(['step', '--live', '--session', name, '--back']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /^step 0\//m, r.stdout);
    assert.match(r.stdout, /recording started here: what ran before step 0 was not recorded/, r.stdout);

    r = await cli(['var', '--live', '--session', name, 'store']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);

    const out = path.join(stubDir, 'h.json');
    r = await cli(['history', '--live', '--session', name, '--why', '0', 'payload', '--out', out]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(fs.readFileSync(out, 'utf8'), /made before #0, where the recording started/);

    r = await cli(['continue', '--live', '--session', name]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(first(r), new RegExp(`^paused at ${re(name)}:${LINE.bump} \\(breakpoint\\)$`), 'the second call pauses as a plain breakpoint');

    r = await cli(['record', '--live', '--session', name]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(first(r), /^already recording/);
    } finally {
      forward.stop();
      await stopAll();
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
  });

  it('record --live at an earlier pause starts the recording there', async () => {
    const name = '_record_from_b_e2e.py';
    const file = target(name);
    const re = (s) => s.replace('.', '\\.');
    fs.rmSync(uriFile, { force: true });
    const forward = forwardUri();
    try {
    let r = await cli(['debug', file, '--at', `${file}:${LINE.payload}`, '--record-from', 'bump']);
    forward.stop();
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(first(r), new RegExp(`^paused at ${re(name)}:${LINE.payload} \\(breakpoint\\)$`));
    assert.match(r.stdout, /not recording yet/, r.stdout);

    r = await cli(['why', '--live', '--session', name, '0', 'payload']);
    assert.equal(r.status, 2, 'nothing recorded yet');

    r = await cli(['record', '--live', '--session', name]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(first(r), new RegExp(`^paused at ${re(name)}:${LINE.payload} \\(breakpoint; recording starts here, step 0\\)`));

    r = await cli(['continue', '--live', '--session', name]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(first(r), new RegExp(`^paused at ${re(name)}:${LINE.bump} \\(breakpoint\\)$`), 'bump is an ordinary pause once the run records');
    assert.doesNotMatch(r.stdout, /^step 0\//m);

    r = await cli(['why', '--live', '--session', name, '1', 'payload']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /made before #0/, 'payload was assigned at step 0, inside the recording');
    } finally {
      forward.stop();
      await stopAll();
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
  });
});
