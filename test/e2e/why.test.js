// End-to-end: the provenance tree ("why is this value here") on examples/demo.py, live and
// saved: the bridge's `why`, `pyokka why --live`, `pyokka why` on a saved run of the same file
// and the API the panel's query goes through agree on the tree; Record Variable Changes fills
// the arguments of the call the statement made.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');

async function waitFor(pred, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** A tiny NDJSON client for the bridge: request/reply by id. */
class Client {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (!msg.event && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    socket.on('error', () => undefined);
  }
  static connect(descriptor) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(descriptor.socket, () => {
        socket.write(JSON.stringify({ token: descriptor.token }) + '\n');
        resolve(new Client(socket));
      });
      socket.on('error', reject);
    });
  }
  request(type, fields = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.socket.write(JSON.stringify({ id, type, ...fields }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`no reply to ${type} #${id}`));
      }, 30_000);
    });
  }
  async ok(type, fields) {
    const r = await this.request(type, fields);
    assert.equal(r.ok, true, `${type} failed: ${r.error} (${r.hint})`);
    return r;
  }
  close() {
    this.socket.destroy();
  }
}

describe('Pyokka why on demo.py', function () {
  let api, session, doc, file, python, tmp, descriptorPath, client;
  const config = () => vscode.workspace.getConfiguration('pyokka');
  // `point_b = generate_random_point(100, 100)`, and the `def` it calls
  const CALL_LINE = 83;
  const DEF_LINE = 70;

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
  /** What two runs of demo.py must agree on: the statement, its reads, the call it made; values (random points, addresses) may differ. */
  const shape = (p) => ({ line: p.root.line, fn: p.root.function, statement: p.root.statement, reads: p.root.reads.map((n) => n.name), calls: p.root.calls.map((c) => [c.name, c.line, c.inputs]), opaque: p.root.opaque });
  const stepOnCallLine = async () => (await client.ok('context', { file: 'demo.py', line: CALL_LINE })).step;

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    api.manager.stopAll();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-why-'));
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    python = session.interpreter.path;
    await api.waitForIdle(session, 60_000);
    descriptorPath = await waitFor(() => api.agentBridge.descriptorFor(session), 'bridge descriptor');
    client = await Client.connect(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')));
  });

  after(async () => {
    if (client) client.close();
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('explains an assignment: the statement, what it read, the call whose body was stepped', async () => {
    const step = await stepOnCallLine();
    const r = await client.ok('why', { step, name: 'point_b' });
    assert.equal(r.name, 'point_b');
    assert.equal(r.step, step);
    assert.equal(r.depth, 5);
    assert.equal(typeof r.nodes, 'number');
    assert.equal(r.root.name, 'point_b');
    assert.equal(r.root.step, step);
    assert.equal(r.root.file, file);
    assert.equal(r.root.line, CALL_LINE);
    assert.equal(r.root.function, '<module>');
    assert.equal(r.root.statement, 'point_b = generate_random_point(100, 100)');
    assert.ok(r.root.reads.some((n) => n.name === 'generate_random_point'), `reads: ${JSON.stringify(r.root.reads)}`);
    const call = r.root.calls.find((c) => c.name === 'generate_random_point');
    assert.ok(call, `calls: ${JSON.stringify(r.root.calls)}`);
    assert.equal(call.file, file);
    assert.equal(call.line, DEF_LINE);
    assert.ok(call.entryStep > step && call.returnStep >= call.entryStep, `entry ${call.entryStep} return ${call.returnStep}`);
    assert.deepEqual(r.root.opaque, [], 'the stepped call claimed its text');
    // without a name the statement itself is the root
    const stmt = await client.ok('why', { step });
    assert.equal(stmt.name, '');
    assert.equal(stmt.root.name, '');
    assert.equal(stmt.root.step, step);
    assert.equal(stmt.root.statement, r.root.statement);
    // a name nothing recorded is a bare leaf; a depth of one cuts the children
    const leaf = await client.ok('why', { step, name: 'no_such_name_here' });
    assert.deepEqual(leaf.root, { name: 'no_such_name_here' });
    const shallow = await client.ok('why', { step, name: 'point_b', depth: 1 });
    assert.equal(shallow.depth, 1);
    assert.ok(shallow.root.reads.every((n) => n.step === undefined || n.cut === true), `depth 1 leaves the reads unexpanded: ${JSON.stringify(shallow.root.reads)}`);
    // errors say what is missing
    const missing = await client.request('why', {});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /step/);
    const past = await client.request('why', { step: 10_000_000, name: 'x' });
    assert.equal(past.ok, false);
  });

  it('carries the arguments once the session records locals; the CLI, the saved run and the API agree', async () => {
    let next = api.waitForNextRun(session, 60_000);
    session.setRecordLocals(true);
    await next;
    const step = await stepOnCallLine();
    const r = await client.ok('why', { step, name: 'point_b' });
    assert.equal(r.recordedLocals, true);
    assert.equal(r.root.source, 'locals');
    assert.match(r.root.text, /Point/);
    const call = r.root.calls.find((c) => c.name === 'generate_random_point');
    assert.deepEqual(call.inputs, [{ name: 'max_x', text: '100' }, { name: 'max_y', text: '100' }]);
    // the panel's query goes through the same builder
    const viaApi = await api.provenance(session, step, 'point_b');
    assert.equal(viaApi.root.step, r.root.step);
    assert.deepEqual(shape(viaApi), shape(r));
    // the text form, live: the header, the node line, the call line with its arguments
    const text = await cli('why', '--live', '--session', descriptorPath, String(step), 'point_b');
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^why point_b at #${step}\\n`));
    assert.match(text.stdout, new RegExp(`\\npoint_b = .*   #${step} demo\\.py:${CALL_LINE} <module>   point_b = generate_random_point\\(100, 100\\)\\n`));
    assert.match(text.stdout, new RegExp(`\\n  ↳ generate_random_point #\\d+–#\\d+ demo\\.py:${DEF_LINE}   in max_x = 100, max_y = 100`));
    assert.doesNotMatch(text.stdout, /rangeBase|valueBag|scopeId/);
    // a saved run of the same file gives the same tree shape
    const saved = path.join(tmp, 'demo-run.json');
    const run = await cli('run', file, '--save', saved);
    assert.equal(run.status, 1, run.stderr); // demo.py raises on purpose
    const fromFile = await cliJson('why', saved, String(step), 'point_b');
    assert.deepEqual(shape(fromFile), shape(r));
    assert.equal(fromFile.root.text.length > 0, true);
    next = api.waitForNextRun(session, 60_000);
    session.setRecordLocals(false);
    await next;
  });
});
