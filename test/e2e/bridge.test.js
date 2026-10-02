// End-to-end: the agent bridge (pyokka.agentAccess) on examples/demo.py: descriptor, token,
// state, step, context, values, eval, select, watch, and the setting gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSIONS_DIR = path.join(process.env.PYOKKA_HOME || path.join(os.homedir(), '.pyokka'), 'sessions');

async function waitFor(pred, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Descriptors of this extension host for `file`. */
function descriptorsFor(file) {
  let names = [];
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
      if (d.pid === process.pid && d.file === file) out.push({ ...d, descriptorPath: path.join(SESSIONS_DIR, name) });
    } catch {
      /* partial write */
    }
  }
  return out;
}

/** A tiny NDJSON client: request/reply by id, events pushed to `events`. */
class Client {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.closed = new Promise((r) => socket.on('close', () => r()));
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
        if (msg.event) this.events.push(msg);
        else if (this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    socket.on('error', () => undefined);
  }
  static connect(descriptor, token = descriptor.token) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(descriptor.socket, () => {
        socket.write(JSON.stringify({ token }) + '\n');
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

describe('Pyokka agent bridge on demo.py', function () {
  let api, session, doc, editor, file, descriptor, client;
  const config = () => vscode.workspace.getConfiguration('pyokka');

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await config().update('agentAccess', false, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    await api.waitForIdle(session, 60_000);
  });

  after(async () => {
    if (client) client.close();
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await config().update('agentAccess', undefined, vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
  });

  it('publishes no descriptor while the setting is off', async () => {
    await sleep(200);
    assert.equal(descriptorsFor(file).length, 0, 'no descriptor');
    assert.equal(api.agentBridge.descriptorFor(session), undefined);
  });

  it('listens and writes the descriptor once the setting turns on', async () => {
    await config().update('agentAccess', true, vscode.ConfigurationTarget.Global);
    descriptor = await waitFor(() => descriptorsFor(file)[0], 'descriptor for demo.py');
    assert.match(descriptor.token, /^[0-9a-f]{32}$/);
    assert.equal(descriptor.displayName, 'demo.py');
    assert.equal(descriptor.workspace, session.workspaceRoot);
    assert.ok(descriptor.socket.endsWith('.sock') && fs.existsSync(descriptor.socket), 'socket file exists');
    assert.ok(descriptor.started && !Number.isNaN(Date.parse(descriptor.started)), 'started is a date');
    assert.equal(typeof descriptor.runtimeVersion, 'string');
  });

  it('closes the connection on a bad token', async () => {
    const bad = await Client.connect(descriptor, 'not-the-token');
    bad.socket.write(JSON.stringify({ id: 1, type: 'state' }) + '\n');
    await Promise.race([bad.closed, sleep(5000).then(() => Promise.reject(new Error('connection stayed open')))]);
  });

  it('reports the state with the Time Machine inactive', async () => {
    client = await Client.connect(descriptor);
    const st = await client.ok('state');
    assert.equal(st.nav.active, false);
    assert.equal(st.nav.step, null);
    assert.ok(st.nav.count > 50, `count ${st.nav.count}`);
    assert.equal(st.running, false);
    assert.equal(st.finished, true);
    assert.equal(st.stale, false);
    assert.equal(st.file, file);
    assert.equal(st.displayName, 'demo.py');
    assert.equal(st.runId, session.state.runId);
  });

  it('steps into: starts the Time Machine, replies a context slice and moves the editor', async () => {
    editor = await vscode.window.showTextDocument(doc);
    const r = await client.ok('step', { kind: 'into' });
    assert.equal(session.nav.active, true, 'Time Machine started');
    assert.equal(r.step, session.nav.currentStep);
    assert.equal(r.location.file, file);
    assert.equal(r.location.fileId, session.mainFileId());
    assert.ok(r.location.line > 0);
    assert.ok(Array.isArray(r.block.lines) && r.block.lines.length > 0, 'block lines');
    assert.ok(r.block.lines.some((l) => l.current && l.line === r.location.line), 'current line marked');
    assert.ok(Array.isArray(r.stack) && r.stack[0].step === r.step, 'stack innermost first');
    assert.equal(typeof r.moves.into, 'number');
    assert.equal(r.moves.back, r.step - 1);
    assert.equal(r.count, session.trace.count);
    assert.ok(Array.isArray(r.errors) && r.errors.some((e) => /Kaboom/.test(e.message)), 'run errors listed');
    await waitFor(() => vscode.window.activeTextEditor && vscode.window.activeTextEditor.selection.active.line + 1 === r.location.line, `editor selection on line ${r.location.line}`);
    const st = await client.ok('state');
    assert.equal(st.nav.active, true);
    assert.equal(st.nav.step, r.step);
    assert.equal(st.location.line, r.location.line);
  });

  it('moves to a step number and refuses out-of-range ones', async () => {
    const r = await client.ok('step', { to: 5 });
    assert.equal(r.step, 5);
    assert.equal(session.nav.currentStep, 5);
    const bad = await client.request('step', { to: 10_000_000 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /out of range/);
    assert.ok(bad.hint, 'hint present');
  });

  it('gives the context of file:line with the values of the block', async () => {
    // `print(pyokka)` (line 11) logs the dict
    const r = await client.ok('context', { file: 'demo.py', line: 11 });
    assert.equal(r.location.line, 11);
    assert.equal(r.block.function, '<module>');
    assert.ok(r.block.lines.some((l) => l.line === 11 && l.current && /print\(pyokka\)/.test(l.text)), 'line 11 is the current block line');
    assert.ok(r.values.some((v) => v.line === 11 && /'is_awesome': True/.test(v.text)), `dict text in values: ${JSON.stringify(r.values.map((v) => [v.line, v.text]))}`);
    assert.ok(r.values.every((v) => v.valueBag === undefined), 'text only by default');
    assert.ok(r.block.lines.length <= 60);
    assert.ok(r.coverage && Array.isArray(r.coverage.notRun), 'coverage known for the main file');
    // scope lifts the caps; the module block spans the whole file, so the never-run line 32 shows up
    const full = await client.ok('context', { file: file, line: 11, scope: true });
    assert.ok(full.block.lines.length >= r.block.lines.length);
    assert.ok(full.coverage.notRun.includes(32), `line 32 never ran: ${full.coverage.notRun}`);
  });

  it('lists the values of a line', async () => {
    const r = await client.ok('values', { file: 'demo.py', line: 11 });
    assert.ok(r.values.length >= 1);
    assert.ok(r.values.some((v) => /'is_awesome': True/.test(v.text)));
    for (const v of r.values) {
      assert.equal(v.line, 11);
      assert.equal(typeof v.step, 'number');
      assert.equal(typeof v.hit, 'number');
    }
    const none = await client.request('values', { file: 'demo.py', line: 32 });
    assert.equal(none.ok, true);
    assert.equal(none.values.length, 0);
    const unknown = await client.request('values', { file: 'nope.py', line: 1 });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /not part of the run/);
  });

  it('lists the history of a variable', async () => {
    const r = await client.ok('var', { name: 'pyokka' });
    assert.equal(r.name, 'pyokka');
    assert.ok(Array.isArray(r.changes) && r.total >= 2, `changes: ${JSON.stringify(r.changes)}`);
    // `pyokka` (line 14) logs the dict under its own name; the assignment on line 9 is listed with its step
    assert.ok(r.changes.some((c) => c.line === 14 && /'is_awesome': True/.test(c.text || '')), `line 14 value: ${JSON.stringify(r.changes)}`);
    assert.ok(r.changes.some((c) => c.line === 9), 'the assignment on line 9 is listed');
    for (const c of r.changes) {
      assert.equal(typeof c.step, 'number');
      assert.equal(c.file, file);
      assert.equal(c.function, '<module>');
      assert.ok(['locals', 'value', 'assign'].includes(c.source));
    }
    const narrowed = await client.ok('var', { name: 'pyokka', file: 'demo.py', scope: '<module>', limit: 1 });
    assert.equal(narrowed.changes.length, 1);
    assert.equal(narrowed.truncated, true);
    const none = await client.ok('var', { name: 'no_such_name_here' });
    assert.equal(none.total, 0);
    const bad = await client.request('var', {});
    assert.equal(bad.ok, false);
    assert.match(bad.error, /needs name/);
  });

  it('evaluates an expression without re-running', async () => {
    await api.waitForIdle(session, 60_000);
    const runId = session.state.runId;
    const r = await client.ok('eval', { expression: "pyokka['is_awesome']" });
    assert.equal(r.text, 'True');
    assert.ok(r.valueBag && r.valueBag.data, 'valueBag included');
    assert.equal(session.state.runId, runId, 'no run happened');
    const refused = await client.request('eval', { expression: 'rect1.area()' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not evaluable/);
    assert.match(refused.hint, /calls/);
    // expand walks a value from eval
    const dict = await client.ok('eval', { expression: 'pyokka' });
    const ex = await client.ok('expand', { valueId: dict.valueBag.data.id, queryPath: [] });
    assert.ok(ex.node && ex.node.type === 'dict', `expanded node: ${JSON.stringify(ex.node).slice(0, 200)}`);
  });

  it('selects a range in the editor', async () => {
    await client.ok('select', { file: 'demo.py', line: 40, endLine: 43 });
    const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    assert.ok(ed, 'demo.py visible');
    assert.equal(ed.selection.start.line, 39);
    assert.equal(ed.selection.end.line, 42);
  });

  it('streams step events while watching, then stops', async () => {
    await client.ok('watch');
    const before = client.events.length;
    editor = await vscode.window.showTextDocument(doc);
    const stepBefore = session.nav.currentStep;
    await vscode.commands.executeCommand('pyokka.playTraceNextStep');
    const ev = await waitFor(() => client.events.slice(before).find((e) => e.event === 'step'), 'a step event');
    assert.equal(ev.step, stepBefore + 1);
    assert.equal(ev.location.line, session.trace.location(ev.step).range[0]);
    assert.ok(Array.isArray(ev.values));
    await client.ok('unwatch');
    const after = client.events.length;
    await vscode.commands.executeCommand('pyokka.playTraceNextStep');
    await sleep(300);
    assert.equal(client.events.length, after, 'no events after unwatch');
  });

  it('answers unknown requests with an error and a hint', async () => {
    const r = await client.request('bogus');
    assert.equal(r.ok, false);
    assert.match(r.hint, /state, step, context/);
  });

  it('removes the socket and the descriptor when the setting turns off', async () => {
    await config().update('agentAccess', false, vscode.ConfigurationTarget.Global);
    await waitFor(() => descriptorsFor(file).length === 0, 'descriptor removed');
    assert.equal(fs.existsSync(descriptor.socket), false, 'socket removed');
    await Promise.race([client.closed, sleep(5000).then(() => Promise.reject(new Error('client not disconnected')))]);
    client = undefined;
  });
});
