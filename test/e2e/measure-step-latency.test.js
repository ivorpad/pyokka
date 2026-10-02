// A measurement, not a test. Not in the `files` list of .vscode-test.mjs: run it on purpose with
//   ./node_modules/.bin/vscode-test --run test/e2e/measure-step-latency.test.js
// and read the table it prints. It asserts only the things that would make the numbers a lie
// (the session still alive, the loop not exhausted), because a benchmark that fails CI on a busy
// machine is worse than no benchmark.
//
// It answers the two questions left open in handoffs/2026-09-15-debugger-streaming-output.md,
// item 4. The CLI numbers there were: ~57 ms fixed per `pyokka` invocation, ~1.2 ms marginal per
// step, from a frame holding four small ints. Missing were
//   (a) whether a step costs more when the frame holds more, since every stop serialises locals,
//   (b) the panel / F10 path, which starts no process so the 57 ms cannot apply.
// Target: test/e2e/fixtures/step_bench.py, run from a temp directory (files outside the
// workspace folder debug fine, and this must not leave anything in examples/).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'step_bench.py');
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
/** the first line of the loop body, which is where every batch starts */
const BODY_LINE = 23;
/** big enough that stepping cannot reach the end of the loop: the mistake that spoiled the first run */
const ITERATIONS = 200_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
const ms = (n) => `${n.toFixed(1)} ms`;

describe('step latency', function () {
  this.timeout(900_000);
  let api, dir, python;
  const rows = [];

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-bench-'));
    fs.writeFileSync(path.join(dir, 'bench.py'), fs.readFileSync(FIXTURE, 'utf8'));
    await vscode.workspace.getConfiguration('pyokka').update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    // one run-all session, only to learn the interpreter the CLI should run from
    const probe = await vscode.workspace.openTextDocument(path.join(root, 'demo.py'));
    await vscode.window.showTextDocument(probe);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const s = await waitFor(() => api.manager.sessionForDocument(probe), 'the probe session');
    python = s.interpreter.resolved ?? s.interpreter.path;
    await api.waitForIdle(s, 60_000);
    api.manager.stopAll();
  });

  after(async () => {
    for (const s of api.debugSessions()) s.stopDebug();
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await vscode.workspace.getConfiguration('pyokka').update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(dir, { recursive: true, force: true });
    const w = Math.max(...rows.map((r) => r.what.length));
    console.log(`\nSTEP LATENCY (median of the batches; ${ITERATIONS} iterations, ${process.platform} ${process.arch})`);
    console.log(`${'what'.padEnd(w)}  n      median      per step`);
    for (const r of rows) console.log(`${r.what.padEnd(w)}  ${String(r.n).padEnd(5)}  ${ms(r.total).padStart(9)}  ${r.per === undefined ? '' : ms(r.per).padStart(8)}`);
    console.log('');
  });

  /** A fresh debug session paused on the first line of the loop body. */
  async function pausedSession(heavy) {
    for (const s of api.debugSessions()) s.stopDebug();
    await waitFor(() => api.debugSessions().length === 0, 'the previous session to end');
    const file = path.join(dir, 'bench.py');
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(BODY_LINE - 1, 0)), true)]);
    await api.startDebugSession({ program: file, args: [String(ITERATIONS), ...(heavy ? ['heavy'] : [])], cwd: dir, stopOnEntry: false });
    const ds = await waitFor(() => api.debugSessions()[0], 'the debug session');
    await waitFor(() => ds.debug.paused, 'the pause in the loop body', 120_000);
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    const locals = await ds.debugLocals();
    assert.ok(
      locals.some((l) => l.name === 'rows') === heavy,
      `the ${heavy ? 'heavy' : 'light'} frame must ${heavy ? 'hold' : 'not hold'} the 2000-row list, got ${locals.map((l) => l.name).join(',')}`,
    );
    return ds;
  }

  function cli(args, timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'pyokka_runtime', ...args], { cwd: PY_DIR });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`pyokka ${args.join(' ')} took over ${timeoutMs} ms`));
      }, timeoutMs);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }

  for (const heavy of [false, true]) {
    const label = heavy ? 'heavy frame (2000 rows + dict)' : 'light frame (4 small ints)';

    it(`CLI path, ${label}`, async () => {
      const ds = await pausedSession(heavy);
      const counts = [50, 200];
      const timings = {};
      for (const count of counts) {
        const samples = [];
        for (let i = 0; i < 3; i++) {
          const t = Date.now();
          // --session, because the machine may hold other live sessions the CLI would refuse to choose between
          const r = await cli(['step', '--live', '--session', 'bench.py', '--over', '--count', String(count)]);
          samples.push(Date.now() - t);
          assert.equal(r.status, 0, `step --count ${count} failed: ${r.stdout} ${r.stderr}`);
          // the loop must still be running: a finished program answers fast and means nothing
          assert.ok(!ds.lastFinished, 'the program ran to completion mid-measurement; raise ITERATIONS');
          assert.ok(ds.debug.paused, 'still paused after the batch');
        }
        timings[count] = median(samples);
        rows.push({ what: `cli  --count ${count}  ${label}`, n: count, total: timings[count], per: timings[count] / count });
      }
      // the slope removes the per-invocation cost, which is the same for both batches
      const marginal = (timings[200] - timings[50]) / 150;
      rows.push({ what: `cli  marginal per step  ${label}`, n: 150, total: timings[200] - timings[50], per: marginal });
      ds.stopDebug();
    });

    it(`panel path, ${label}`, async () => {
      const ds = await pausedSession(heavy);
      // no process start here: this is what F10 costs, and the CLI's fixed ~57 ms cannot apply
      const samples = [];
      for (let i = 0; i < 60; i++) {
        const t = Date.now();
        await ds.debugStep('over');
        await waitFor(() => ds.debug.paused, 'the next stop', 30_000);
        samples.push(Date.now() - t);
        assert.ok(!ds.lastFinished, 'the program ran to completion mid-measurement; raise ITERATIONS');
      }
      // the first few carry the cost of whatever the session had not done yet
      const steady = samples.slice(10);
      rows.push({ what: `panel  F10 step over  ${label}`, n: steady.length, total: median(steady), per: median(steady) });
      // the CLI batches showed the heavy frame costing *more* per step in the longer batch, which
      // would mean a session gets slower the longer it is stepped. The two halves say whether it does.
      const half = steady.length >> 1;
      rows.push({ what: `panel  first half           ${label}`, n: half, total: median(steady.slice(0, half)), per: median(steady.slice(0, half)) });
      rows.push({ what: `panel  second half          ${label}`, n: steady.length - half, total: median(steady.slice(half)), per: median(steady.slice(half)) });
      // where the cost sits: a stop serialises the frame's locals, and the Debugger view asks for
      // them again on every `paused`. Timing the read on its own separates it from the step.
      const reads = [];
      for (let i = 0; i < 20; i++) {
        const t = Date.now();
        await ds.debugLocals();
        reads.push(Date.now() - t);
      }
      rows.push({ what: `locals read alone          ${label}`, n: reads.length, total: median(reads), per: median(reads) });
      ds.stopDebug();
    });
  }
});
