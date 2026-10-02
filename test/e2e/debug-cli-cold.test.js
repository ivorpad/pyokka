// End-to-end: `pyokka debug FILE` from a terminal, cold (docs/design/debugger-product.md, 3.9,
// 3.10). A spec cannot make VS Code open its own URI from outside, so `PYOKKA_CODE` is a stub
// script that writes the URI it was handed to a file; the spec polls that file and feeds the URI
// to this window through `api.handleDebugUri`, which src/api.ts exposes for exactly this. The real
// `code` on the PATH is never run.
// Target: test/e2e/fixtures/debug_target.py, copied into the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'debug_target.py');
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const NAME = '_debug_cold_e2e.py';
const LINE = { bump: 4, payload: 9, loop: 11, call: 12, add: 13, append: 14, print: 15 };
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

describe('pyokka debug FILE, cold', function () {
  this.timeout(240_000);
  let api, doc, file, root, python, stubDir, stub, uriFile;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  /** Run the CLI with the `code` stub in place; `--session` is never passed: the CLI must choose. */
  function cli(args, { code = stub, timeoutMs = 60_000, focus = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args], { cwd: PY_DIR, env: { ...process.env, PYOKKA_CODE: code, PYOKKA_NO_FOCUS: focus ? '' : '1' } });
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

  /** Watch the stub's file and hand the URI it recorded to this window, as `code --open-url` would. */
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
    return {
      uri: done,
      stop: () => {
        stopped = true;
      },
    };
  }

  async function stopAll() {
    for (const ds of api.debugSessions()) ds.stopDebug();
    await waitFor(() => api.debugSessions().length === 0, 'the debug sessions to end');
    api.manager.stopAll();
  }

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    file = path.join(root, NAME);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf8'));
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    // a session on the file for a moment, only to learn the interpreter the CLI should run from
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const probe = api.manager.sessionForDocument(doc);
    assert.ok(probe, 'session created');
    python = probe.interpreter.path;
    await api.waitForIdle(probe, 60_000);
    api.manager.stopAll();
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-code-'));
    uriFile = path.join(stubDir, 'uri.txt');
    stub = path.join(stubDir, 'code-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$2" > ${JSON.stringify(uriFile)}\n`);
    fs.chmodSync(stub, 0o755);
  });

  after(async () => {
    await stopAll();
    // the CLI ran from python/, so its remembered launch is keyed there; leave nothing behind
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
    try {
      fs.unlinkSync(file);
      fs.rmSync(stubDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  });

  it('pyokka debug FILE starts a debug session through the URI and prints the first stop', async () => {
    assert.equal(api.manager.all().length, 0, 'no run-all session: route (c) is the one taken');
    fs.rmSync(uriFile, { force: true });
    const forward = forwardUri();
    const run = cli(['debug', file, '--stop-on-entry']);
    const uri = await forward.uri;
    assert.ok(uri, 'the CLI handed a URI to the stub');
    assert.match(uri, /^vscode:\/\/ivor\.pyokka\/debug\?/);
    assert.match(uri, /stopOnEntry=1/);
    const r = await run;
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.payload} \\(start\\)`, 'm'));
    assert.equal(api.debugSessions().length, 1, 'the window started exactly one debug session');
    assert.equal(api.manager.all().length, 0, 'and no run-all session');
    forward.stop();
    await stopAll();
  });

  it('a cold start brings the window to the front at the first stop', async () => {
    fs.rmSync(uriFile, { force: true });
    const forward = forwardUri();
    const run = cli(['debug', file, '--stop-on-entry'], { focus: true });
    assert.ok(await forward.uri, 'the URI went out first');
    const r = await run;
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    forward.stop();
    // the stub keeps the second argument of its last call: `code --goto FILE:LINE` after `--open-url URI`
    const last = await waitFor(() => {
      const text = fs.existsSync(uriFile) ? fs.readFileSync(uriFile, 'utf8') : '';
      return text.startsWith('vscode://') ? undefined : text;
    }, 'the --goto call');
    assert.equal(last, `${file}:${LINE.payload}`);
    await stopAll();
  });

  it('with the file open in a session, pyokka debug FILE takes the run socket and never calls code', async () => {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'the run-all session is there');
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'the run descriptor');
    fs.rmSync(uriFile, { force: true });
    const r = await cli(['debug', file, '--stop-on-entry']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.payload} \\(start\\)`, 'm'));
    assert.equal(fs.existsSync(uriFile), false, 'the run socket answered, so `code` was never called');
    assert.equal(api.debugSessions().length, 1, 'the host created a record: false debug session');
    assert.equal(api.debug(session).active, false, 'the run-all session was not put into debug mode');
  });

  it('the descriptor lists kind debug and state --live prints both sessions', async () => {
    const session = api.manager.sessionForDocument(doc);
    const ds = api.debugSessions()[0];
    assert.ok(ds, 'still paused from the case above');
    const descriptor = await waitFor(() => api.agentBridge.debugDescriptorFor(ds), 'the debug descriptor');
    const doc2 = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    assert.equal(doc2.kind, 'debug');
    assert.equal(doc2.file, file);
    assert.equal(doc2.launch.program, file);
    const raw = await cli(['state', '--live', '--json']);
    assert.equal(raw.status, 0, raw.stderr);
    const st = JSON.parse(raw.stdout);
    assert.equal(st.kind, 'debug', 'state prefers the debug socket');
    assert.equal(st.paused, true);
    assert.equal(st.record, false);
    assert.equal(st.launch.program, file);
    assert.equal(st.debug.frontier, null, 'nothing to navigate');
    assert.equal(st.others.length, 1, `the run-all session is listed: ${JSON.stringify(st.others)}`);
    assert.equal(st.others[0].kind, 'run');
    assert.equal(st.others[0].descriptor, api.agentBridge.descriptorFor(session));
    const text = await cli(['state', '--live']);
    assert.equal(text.status, 0, text.stderr);
    const lines = text.stdout.split('\n');
    assert.match(lines[0], /^debug /, 'the debug session is listed first');
    assert.match(lines[0], /\[this\]$/);
    assert.match(lines[1], /^run /);
    assert.match(text.stdout, new RegExp(`paused at ${NAME.replace('.', '\\.')}:${LINE.payload} \\(start\\)`));
    assert.match(text.stdout, /^ {2}record: off$/m);
    assert.match(text.stdout, /^ {2}exceptions: uncaught$/m);
  });

  it('the recording verbs are refused with the record hint', async () => {
    // the verb preference sends these to the run socket, so the debug descriptor is named
    const descriptor = api.agentBridge.debugDescriptorFor(api.debugSessions()[0]);
    assert.ok(descriptor, 'the debug descriptor is there');
    const cases = {
      why: ['why', '0'],
      var: ['var', 'total'],
      values: ['values', '--line', `${NAME}:${LINE.add}`],
      walkthrough: ['walkthrough'],
      graph: ['graph'],
      exceptions: ['exceptions'],
      http: ['http'],
      story: ['story'],
      find: ['find', 'total'],
      steps: ['steps'],
    };
    for (const [verb, args] of Object.entries(cases)) {
      const r = await cli([...args, '--live', '--session', descriptor]);
      assert.equal(r.status, 2, `${verb} must be refused: ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${verb} needs a recording`), `${verb}: ${r.stderr}`);
      assert.match(r.stderr, /--record/, `${verb}: ${r.stderr}`);
    }
    // the backward moves have their own wording
    const back = await cli(['step', '--live', '--back', '--session', descriptor]);
    assert.equal(back.status, 2);
    assert.match(back.stderr, /records nothing, so there is nothing behind the pause to replay/);
    assert.match(back.stderr, /into, over and out execute/);
  });

  it('--at FILE:LINE pauses there, with no entry pause', async () => {
    await stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const session = api.manager.sessionForDocument(doc);
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'the run descriptor');
    const r = await cli(['debug', file, '--at', `${NAME}:${LINE.add}`]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.add} \\(breakpoint\\)`, 'm'));
    assert.ok(
      vscode.debug.breakpoints.some((b) => b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath === file && b.location.range.start.line === LINE.add - 1),
      'the --at breakpoint is in the gutter',
    );
    await stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  it('--at NAME pauses at the function\'s entry', async () => {
    await stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const session = api.manager.sessionForDocument(doc);
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'the run descriptor');
    const r = await cli(['debug', file, '--at', 'bump']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    // the runtime resolves the name to the `def` line, so the pause is the function's entry
    assert.match(r.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.bump} \\(breakpoint\\)`, 'm'));
    assert.ok(
      vscode.debug.breakpoints.some((b) => b instanceof vscode.FunctionBreakpoint && b.functionName === 'bump'),
      'the --at NAME breakpoint shows in the Breakpoints view',
    );
  });

  it('break --remove NAME takes the --at NAME breakpoint away, and --remove FILE:LINE a line one', async () => {
    // still paused at `bump` from the case above, with its function breakpoint set
    let r = await cli(['break', '--live', '--remove', 'bump']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /bump/, 'the list no longer has it');
    assert.ok(!vscode.debug.breakpoints.some((b) => b instanceof vscode.FunctionBreakpoint), 'and neither does the Breakpoints view');
    r = await cli(['break', '--live', `${file}:${LINE.add}`]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.ok(vscode.debug.breakpoints.some((b) => b instanceof vscode.SourceBreakpoint && b.location.range.start.line === LINE.add - 1));
    r = await cli(['break', '--live', '--remove', `${file}:${LINE.add}`]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.equal(vscode.debug.breakpoints.length, 0, 'nothing left in the Breakpoints view');
  });

  /** A cold start with no breakpoints: the run pauses before the first statement. */
  async function freshEntryPause() {
    await stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const session = api.manager.sessionForDocument(doc);
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'the run descriptor');
    const start = await cli(['debug', file, '--stop-on-entry']);
    assert.equal(start.status, 0, `${start.stdout} ${start.stderr}`);
    assert.match(start.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.payload} \\(start\\)`, 'm'));
  }

  /** The `paused at file:LINE` of a stop reply. */
  function pausedLine(stdout) {
    const m = new RegExp(`^paused at ${NAME.replace('.', '\\.')}:(\\d+) `, 'm').exec(stdout);
    assert.ok(m, `no pause line in ${stdout}`);
    return Number(m[1]);
  }

  it('--until runs to the first statement where the expression is true', async () => {
    await freshEntryPause();
    const r = await cli(['continue', '--live', '--until', 'total > 2']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /^paused at .*\(watch total > 2: True\)/m);
    // the watch lived for that one resume: it is not in the list afterwards
    const listed = await cli(['watches', '--live', '--json']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).watches, []);
  });

  it('--to runs to a line', async () => {
    const r = await cli(['continue', '--live', '--to', `${NAME}:${LINE.print}`]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.equal(pausedLine(r.stdout), LINE.print);
  });

  it('--count takes N stops in a row and prints the last', async () => {
    await freshEntryPause();
    const one = await cli(['step', '--live', '--over']);
    const two = await cli(['step', '--live', '--over']);
    const three = await cli(['step', '--live', '--over']);
    for (const r of [one, two, three]) assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    const singly = pausedLine(three.stdout);
    // the same three moves in one request land in the same place
    await freshEntryPause();
    const r = await cli(['step', '--live', '--over', '--count', '3']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /\(step over\)/);
    assert.equal(pausedLine(r.stdout), singly);
    assert.doesNotMatch(r.stdout, /stopped early/, 'nothing else stopped the program on the way');
  });

  it('--count says how many steps it took when the program ends mid-count', async () => {
    await freshEntryPause();
    // the program is far shorter than 100 statements, so the run ends inside the count
    const r = await cli(['step', '--live', '--over', '--count', '100']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /^finished: exit 0, \d+ steps$/m);
    assert.match(r.stdout, /^\d+ steps were taken before it ended$/m);
    // the early exit is what stopped it: the whole count never ran
    const taken = Number(/^(\d+) steps were taken/m.exec(r.stdout)[1]);
    assert.ok(taken > 0 && taken < 100, `${taken} steps of the 100 asked for`);
  });

  it('exec writes the paused frame and the program sees it', async () => {
    await freshEntryPause();
    // at the entry pause `total` is not bound yet: step onto the loop first
    await cli(['step', '--live', '--over', '--count', '2']);
    const r = await cli(['exec', '--live', 'total = 100']);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /^ok$/m);
    assert.match(r.stdout, /values modified from the console/);
    assert.equal((await cli(['eval', '--live', 'total'])).stdout.trim(), 'total = 100');
    // every stop from now on says the values are no longer the program's own
    const after = await cli(['step', '--live', '--over']);
    assert.equal(after.status, 0, `${after.stdout} ${after.stderr}`);
    assert.match(after.stdout, /^paused at .*\(values modified from the console\)$/m);
    // a statement that raised is still a served request: exit 0, the error on stderr, still paused
    const raised = await cli(['exec', '--live', '1/0']);
    assert.equal(raised.status, 0, `${raised.stdout} ${raised.stderr}`);
    assert.match(raised.stderr, /^ZeroDivisionError: division by zero$/m);
    assert.match(raised.stdout, /^still paused at /m);
    // the Debugger view and the status bar say so too
    assert.equal(api.debugPanelState().modified, true);
    // and the program ran on with the value the console wrote
    const done = await cli(['continue', '--live']);
    assert.equal(done.status, 0, `${done.stdout} ${done.stderr}`);
    assert.match(done.stdout, /finished: exit 0/);
    await stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  it('a timeout prints the hint that names the URI confirmation first, then pyokka.agentAccess', async () => {
    await stopAll();
    assert.equal(api.manager.all().length, 0, 'no run socket, so route (c) is the one taken');
    const r = await cli(['debug', file], { code: '/usr/bin/true', timeoutMs: 60_000 });
    assert.equal(r.status, 2, `${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`did not start a debug session for ${NAME.replace('.', '\\.')}`));
    assert.match(r.stderr, /^look at the VS Code window first/m);
    assert.match(r.stderr, /extensions\.confirmedUriHandlerExtensionIds/);
    assert.match(r.stderr, /check `pyokka\.agentAccess`/);
    assert.match(r.stderr, /focused window/);
  });

  it('continue with no session starts the last launch from this directory again', async () => {
    await stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    let forward = forwardUri();
    let r = await cli(['debug', file, '--at', `${file}:${LINE.call}`]);
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    forward.stop();
    await stopAll();
    // the program is gone; `continue` starts the same launch and stops at its `--at` again
    forward = forwardUri();
    r = await cli(['continue', '--live']);
    forward.stop();
    assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /^no debug session was running: started the last launch from this directory again, `pyokka debug .*_debug_cold_e2e\.py --at .*:12`/);
    assert.match(r.stdout, new RegExp(`^paused at ${NAME.replace('.', '\\.')}:${LINE.call}`, 'm'));
    assert.equal(api.debugSessions().length, 1);
    // `--no-start` refuses instead, and names what it would have run
    await stopAll();
    r = await cli(['continue', '--live', '--no-start']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the last launch here was `pyokka debug /);
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  for (const record of [false, true]) {
    it(`continue goes from breakpoint to breakpoint across files${record ? ', recording' : ''}`, async () => {
      await stopAll();
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      // one pair of files per mode: a path deleted and written again under an open editor is not
      // what a user does, and VS Code closes the old document under the new session
      const tag = record ? 'rec' : 'dbg';
      const stage = path.join(root, `_stage_${tag}_e2e.py`);
      const main = path.join(root, `_pipeline_${tag}_e2e.py`);
      fs.writeFileSync(stage, 'def clean(text):\n    words = text.split()\n    return [w.lower() for w in words]\n\n\ndef score(words):\n    total = len(words)\n    return total\n');
      fs.writeFileSync(main, `from _stage_${tag}_e2e import clean, score\nraw = "A b C"\nwords = clean(raw)\nn = score(words)\nprint(n)\n`);
      try {
        const forward = forwardUri();
        let r = await cli(['debug', main, '--at', `${main}:3`, ...(record ? ['--record'] : [])]);
        forward.stop();
        assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
        assert.match(r.stdout, new RegExp(`^paused at _pipeline_${tag}_e2e\\.py:3`, 'm'));
        r = await cli(['break', '--live', `${stage}:2`, `${stage}:7`, `${main}:5`]);
        assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
        for (const want of [`_stage_${tag}_e2e.py:2`, `_stage_${tag}_e2e.py:7`, `_pipeline_${tag}_e2e.py:5`]) {
          r = await cli(['continue', '--live']);
          assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
          assert.ok(r.stdout.split('\n')[0].includes(want), `${want} in ${r.stdout}`);
        }
        r = await cli(['continue', '--live']);
        assert.match(r.stdout, /finished/, r.stdout);
      } finally {
        await stopAll();
        await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        fs.rmSync(stage, { force: true });
        fs.rmSync(main, { force: true });
      }
    });
  }

  it('--at repeats: one stop per stage of a pipeline, across files', async () => {
    await stopAll();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    const stage = path.join(root, '_stage_at_e2e.py');
    const main = path.join(root, '_pipeline_at_e2e.py');
    fs.writeFileSync(stage, 'def clean(text):\n    words = text.split()\n    return [w.lower() for w in words]\n\n\ndef score(words):\n    total = len(words)\n    return total\n');
    fs.writeFileSync(main, 'from _stage_at_e2e import clean, score\nraw = "A b C"\nwords = clean(raw)\nn = score(words)\nprint(n)\n');
    try {
      const forward = forwardUri();
      let r = await cli(['debug', main, '--at', 'clean', '--at', 'score', '--at', `${main}:5`]);
      forward.stop();
      assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
      assert.match(r.stdout.split('\n')[0], /_stage_at_e2e\.py:1 /, r.stdout);
      for (const want of ['_stage_at_e2e.py:6', '_pipeline_at_e2e.py:5']) {
        r = await cli(['continue', '--live']);
        assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
        assert.ok(r.stdout.split('\n')[0].includes(want), `${want} in ${r.stdout}`);
      }
      r = await cli(['continue', '--live']);
      assert.match(r.stdout, /finished/, r.stdout);
    } finally {
      await stopAll();
      await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      fs.rmSync(stage, { force: true });
      fs.rmSync(main, { force: true });
    }
  });

  it('with agentAccess off the URI is refused and nothing starts', async () => {
    await stopAll();
    await config().update('agentAccess', false, vscode.ConfigurationTarget.Global);
    try {
      const before = fs.readdirSync(sessionsDir()).length;
      await api.handleDebugUri(vscode.Uri.parse(`vscode://ivor.pyokka/debug?program=${encodeURIComponent(file)}&cwd=${encodeURIComponent(root)}&stopOnEntry=1`));
      await sleep(1500);
      assert.equal(api.debugSessions().length, 0, 'the window started nothing');
      assert.equal(fs.readdirSync(sessionsDir()).length, before, 'and wrote no descriptor');
    } finally {
      await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    }
  });

  function sessionsDir() {
    const dir = path.join(process.env.PYOKKA_HOME || path.join(os.homedir(), '.pyokka'), 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
});
