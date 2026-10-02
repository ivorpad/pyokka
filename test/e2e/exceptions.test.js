// End-to-end: the exceptions report on the fixture program with a bare `except:`
// (test/unit/fixtures/exceptions, copied into the workspace), live and saved: the host's builder (the
// API), `pyokka exceptions --live` (the bridge) and `pyokka exceptions run.json` (the CLI over a saved
// run) list the same rows, the broad handlers are flagged, the text form reads as documented; and
// demo.py, which catches nothing, reports only its uncaught ValueError.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');
const FIXTURE = path.resolve(__dirname, '..', 'unit', 'fixtures', 'exceptions');

async function waitFor(pred, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Pyokka exceptions report', function () {
  let api, session, doc, dir, file, source, python, tmp;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  function cli(...args) {
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
        reject(new Error(`pyokka ${args.join(' ')} took over 60 s; stdout=${stdout} stderr=${stderr}`));
      }, 60_000);
      child.on('error', reject);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }
  async function cliJson(...args) {
    const r = await cli(...args, '--json');
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stdout} ${r.stderr}`);
    return JSON.parse(r.stdout);
  }
  /** 1-based line of the first source line containing `text` */
  const lineOf = (text) => {
    const i = source.split('\n').findIndex((l) => l.includes(text));
    assert.ok(i >= 0, `fixture has a line with ${text}`);
    return i + 1;
  };
  const row = (report, errorType) => {
    const r = report.rows.find((x) => x.errorType === errorType);
    assert.ok(r, `${errorType} row in ${report.rows.map((x) => x.errorType)}`);
    return r;
  };

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    dir = path.join(root, '_exceptions_e2e');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(FIXTURE, dir, { recursive: true });
    file = path.join(dir, 'main.py');
    source = fs.readFileSync(file, 'utf8');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    api.manager.stopAll();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-exc-'));
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
    await waitFor(() => api.agentBridge.descriptorFor(session), 'bridge descriptor');
  });

  after(async () => {
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
    api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => (e.path ?? '').startsWith(dir)).map((e) => e.id));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists every caught exception with its handler line, broad handlers flagged, the uncaught one first', async () => {
    const report = api.exceptions(session);
    assert.ok(report, 'the host builds a report');
    assert.equal(report.count, session.trace.count);
    assert.equal(report.exitCode, 1);
    assert.deepEqual(
      { total: report.total, raises: report.raises, uncaught: report.uncaught, caught: report.caught, broad: report.broad },
      { total: 8, raises: 11, uncaught: 1, caught: 7, broad: 2 },
    );
    assert.deepEqual(report.rows.map((r) => r.id), report.rows.map((_, i) => `x${i}`));
    assert.equal(report.rows[0].kind, 'uncaught');
    assert.equal(report.rows[0].errorType, 'ZeroDivisionError');
    assert.equal(report.rows[0].raisedAt.line, lineOf('print(total / (total - total))'));
    assert.equal(report.rows[0].handledAt, null);
    assert.ok(report.rows.slice(1).every((r) => r.kind === 'caught'), 'caught rows after the uncaught one');
    const steps = report.rows.slice(1).map((r) => r.step);
    assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'caught rows in step order');
    // the loop: three KeyErrors from lookup into the bare except
    const key = row(report, 'KeyError');
    assert.equal(key.count, 3);
    assert.ok(key.lastStep > key.step);
    assert.equal(key.raisedAt.line, lineOf('return table[key]'));
    assert.equal(key.raisedAt.function, 'lookup');
    assert.equal(key.handledAt.line, lineOf('except:  # noqa: E722'));
    assert.equal(key.handledAt.function, '<module>');
    assert.equal(key.handledAt.broad, true);
    assert.equal(key.handledAt.file, file);
    // a specific handler in a function
    const value = row(report, 'ValueError');
    assert.equal(value.count, 1);
    assert.equal(value.handledAt.line, lineOf('except ValueError as exc:'));
    assert.equal(value.handledAt.function, 'parse_amount');
    assert.equal(value.handledAt.broad, false);
    // through a with and a finally to the outer except Exception
    const os_ = row(report, 'OSError');
    assert.equal(os_.raisedAt.line, lineOf('raise OSError('));
    assert.equal(os_.handledAt.line, lineOf('except Exception:'));
    assert.equal(os_.handledAt.broad, true);
    // the inner handler re-raised: the outer one caught it
    const rt = row(report, 'RuntimeError');
    assert.equal(rt.handledAt.line, lineOf('except RuntimeError as err:'));
    assert.equal(rt.handledAt.function, '<module>');
    assert.equal(rt.handledAt.broad, false);
    // contextlib.suppress swallows at the with line
    const idx = row(report, 'IndexError');
    assert.equal(idx.handledAt.line, lineOf('with contextlib.suppress(IndexError):'));
    assert.equal(idx.handledAt.function, 'third');
    assert.equal(idx.handledAt.broad, false);
    // the library raised into user code (library stepping off: attributed to the calling statement); its internal catch is not listed
    const type = row(report, 'TypeError');
    assert.equal(type.count, 1);
    assert.equal(type.raisedAt.line, lineOf('libx.unwrap(None)'));
    assert.equal(type.handledAt.line, lineOf('except TypeError:'));
    // caught by C code: getattr with a default
    const attr = row(report, 'AttributeError');
    assert.equal(attr.count, 2);
    assert.equal(attr.handledAt, null);
    assert.equal(attr.raisedAt.function, '__getattr__');
  });

  it('gives the same rows through the bridge and over a saved run, and the text form reads as documented', async () => {
    const report = api.exceptions(session);
    const live = await cliJson('exceptions', '--live', '--session', api.agentBridge.descriptorFor(session));
    assert.deepEqual(live.rows, JSON.parse(JSON.stringify(report.rows)));
    assert.equal(live.count, report.count);
    const saved = path.join(tmp, 'exceptions-run.json');
    const run = await cli('run', file, '--save', saved);
    assert.equal(run.status, 1, run.stderr); // the fixture ends with an uncaught ZeroDivisionError
    const fromFile = await cliJson('exceptions', saved);
    assert.deepEqual(fromFile.rows, live.rows);
    const text = await cli('exceptions', saved);
    assert.equal(text.status, 0, text.stderr);
    const lines = text.stdout.split('\n');
    assert.match(lines[0], /^8 exceptions over \d+ steps: 1 uncaught, 7 caught \(10 raises\), 2 by a broad handler$/);
    assert.ok(lines.some((l) => /^#\d+\s+uncaught ZeroDivisionError: division by zero/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('×3 KeyError')), 'the repeated KeyError row');
    assert.ok(lines.some((l) => l.includes('broad handler')), 'the broad handler flag');
    assert.ok(lines.some((l) => l.includes('caught outside stepped code')), 'the C-caught AttributeError');
    assert.ok(lines.every((l) => l.length <= 100), 'lines are bounded');
  });

  it('reports only the uncaught ValueError for demo.py', async () => {
    const demo = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    const demoDoc = await vscode.workspace.openTextDocument(demo);
    await vscode.window.showTextDocument(demoDoc);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    const demoSession = api.manager.sessionForDocument(demoDoc);
    assert.ok(demoSession, 'demo session');
    await api.waitForIdle(demoSession, 60_000);
    const report = api.exceptions(demoSession);
    assert.ok(report, 'a report for demo.py');
    assert.equal(report.total, 1);
    assert.equal(report.uncaught, 1);
    assert.equal(report.caught, 0);
    assert.equal(report.broad, 0);
    assert.equal(report.rows[0].errorType, 'ValueError');
    assert.match(report.rows[0].message, /^Kaboom!/);
    api.manager.stop(demoDoc);
  });
});
