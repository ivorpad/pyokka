// End-to-end: the execution graph on examples/demo.py, live and saved: `pyokka graph --live`
// has the node and edge sets of `pyokka graph` on a saved run of the same file, the host's
// builder (the API) has the demo's node set, "Pyokka: Show Execution Diagram" switches the
// panel view, and a package node unrolls when Step Into Library Code is on.
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

describe('Pyokka execution diagram on demo.py', function () {
  let api, session, doc, file, python, tmp;
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
  /** What must match between two runs of demo.py: the node labels with their call counts, the edges by label. */
  const nodeSet = (g) => g.nodes.filter((n) => n.kind !== 'decision' && n.kind !== 'statement').map((n) => `${n.label} ×${n.calls}`).sort();
  const statementSet = (g) => g.nodes.filter((n) => n.kind === 'statement').map((n) => `${n.label} ×${n.hits}`).sort();
  const decisionSet = (g) => g.nodes.filter((n) => n.kind === 'decision').map((n) => `${n.label} → ${n.taken ?? ''} ×${n.hits} notRun ${JSON.stringify(n.notRun)}`).sort();
  const edgeSet = (g, keep = () => true) => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    return g.edges
      .map((e) => ({ e, from: byId.get(e.from), to: byId.get(e.to) }))
      .filter(keep)
      .map(({ e, from, to }) => `${from.label} ${e.kind} ${to.label}${e.kind === 'data' ? ` ${e.label}` : ` ×${e.count}`}`)
      .sort();
  };
  /** a live session records no locals, so the data edges from a function's parameters (`in` rows) to its statements exist only in the saved run */
  const withoutParamEdges = ({ e, from }) => !(e.kind === 'data' && from.kind !== 'statement' && from.kind !== 'decision');
  const byLabel = (g, label) => g.nodes.find((n) => n.label === label);

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    api.manager.stopAll();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-graph-'));
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
  });

  it('has the same nodes and edges live (the bridge) and saved (the CLI), and the host builder agrees', async () => {
    const saved = path.join(tmp, 'demo-run.json');
    const run = await cli('run', file, '--save', saved);
    assert.equal(run.status, 1, run.stderr); // demo.py raises on purpose
    const fromFile = await cliJson('graph', saved);
    const live = await cliJson('graph', '--live', '--session', api.agentBridge.descriptorFor(session));
    assert.deepEqual(nodeSet(live), nodeSet(fromFile));
    assert.deepEqual(decisionSet(live), decisionSet(fromFile));
    assert.deepEqual(statementSet(live), statementSet(fromFile));
    assert.deepEqual(edgeSet(live, withoutParamEdges), edgeSet(fromFile, withoutParamEdges));
    assert.ok(edgeSet(fromFile).includes('Point.__init__ data self.x = x x'), 'a parameter feeds the statement that reads it (saved run)');
    assert.ok(edgeSet(fromFile).includes('Point.distance data dx = self.x - other.x other'));
    assert.equal(live.count, session.trace.count);
    assert.equal(fromFile.capped, false);
    // the node set of the demo
    const nodes = nodeSet(fromFile);
    for (const want of ['<module> ×1', 'Point.__init__ ×4', 'generate_random_point ×1', 'Rectangle.__init__ ×2', 'rectangles_overlap ×1', 'Rectangle.contains ×1', 'Point.distance ×1']) assert.ok(nodes.includes(want), `${want} in ${nodes}`);
    const ifFalse = byLabel(fromFile, 'if False');
    assert.ok(ifFalse, 'the if False decision');
    assert.equal(ifFalse.parent, byLabel(fromFile, '<module>').id);
    assert.equal(ifFalse.taken, 'False');
    assert.deepEqual(ifFalse.notRun, [32]);
    // call edges leave from the statement that made the call; without statement nodes they fold back onto the scopes
    const edges = edgeSet(fromFile);
    assert.ok(edges.includes('point_a = Point(5, 10) call Point.__init__ ×1'), `edges: ${edges}`);
    assert.ok(edges.includes('rect1 = Rectangle(50, 20, Point(10, 10)) call Point.__init__ ×1'), `edges: ${edges}`);
    assert.ok(edges.includes('rect1 = Rectangle(50, 20, Point(10, 10)) call Rectangle.__init__ ×1'), `edges: ${edges}`);
    assert.ok(edges.includes('return Point(x, y) call Point.__init__ ×1'), `edges: ${edges}`);
    const folded = await cliJson('graph', saved, '--no-statements');
    assert.ok(!folded.nodes.some((n) => n.kind === 'statement'), 'no statements with --no-statements');
    const foldedEdges = edgeSet(folded);
    assert.ok(foldedEdges.includes('<module> call Point.__init__ ×3'), `edges: ${foldedEdges}`);
    assert.ok(foldedEdges.includes('generate_random_point call Point.__init__ ×1'), `edges: ${foldedEdges}`);
    // the statements of the script, with what they read
    const statements = statementSet(fromFile);
    for (const want of ['point_a = Point(5, 10) ×1', 'rect1 = Rectangle(50, 20, Point(10, 10)) ×1', 'print(pyokka) ×1', 'raise ValueError("Kaboom! This is just a test error.") ×1']) assert.ok(statements.includes(want), `${want} in ${statements}`);
    const contains = fromFile.nodes.find((n) => n.kind === 'statement' && n.text.includes('rect1.contains(point_a)'));
    assert.ok(contains, 'the print statement that reads point_a');
    assert.deepEqual(contains.reads.filter((r) => r === 'rect1' || r === 'point_a'), ['rect1', 'point_a']);
    assert.ok(edges.includes('point_a = Point(5, 10) data ' + contains.label + ' point_a'), `data edge: ${edges.filter((e) => e.includes('data'))}`);
    assert.ok(edges.includes('rect1 = Rectangle(50, 20, Point(10, 10)) data ' + contains.label + ' rect1'), `data edge: ${edges.filter((e) => e.includes('data'))}`);
    // rows: the saved run records locals, so the first call's arguments are there; the raised row sits on the module
    const init = byLabel(fromFile, 'Point.__init__');
    assert.deepEqual(init.rows.map((r) => `${r.kind} ${r.name} = ${r.text}`), ['in x = 5', 'in y = 10']);
    const mod = byLabel(fromFile, '<module>');
    assert.deepEqual(mod.spans, [[0, fromFile.count - 1]]);
    // the raised row sits on the statement that raised, and the print statement carries what it printed
    const raiseStmt = fromFile.nodes.find((n) => n.kind === 'statement' && n.label.startsWith('raise ValueError'));
    assert.ok(raiseStmt.rows.some((r) => r.kind === 'raised' && r.name === 'ValueError'), `raise rows: ${JSON.stringify(raiseStmt.rows)}`);
    assert.ok(!mod.rows.some((r) => r.kind === 'raised'), 'the module no longer carries the raised row');
    const printStmt = fromFile.nodes.find((n) => n.kind === 'statement' && n.label === 'print(pyokka)');
    assert.ok(printStmt.rows.some((r) => r.kind === 'print' && r.name === 'stdout' && r.text.startsWith("{'is_awesome': True")), `print rows: ${JSON.stringify(printStmt.rows)}`);
    assert.equal(printStmt.parent, mod.id);
    // every moment of the walkthrough with a node maps to one; every scope maps to a node
    const w = await cliJson('walkthrough', saved);
    const ids = new Set(w.moments.map((m) => m.id));
    assert.ok(fromFile.moments.every((m) => ids.has(m.id)), 'moment ids come from the walkthrough');
    assert.ok(fromFile.moments.every((m) => fromFile.nodes.some((n) => n.id === m.nodeId)), 'moment nodes exist');
    assert.equal(Object.keys(fromFile.scopes).length, session.trace.scopes.length);
    // the host builder (what the panel shows)
    const host = api.graph(session);
    assert.ok(host, 'the API builds the graph');
    assert.deepEqual(nodeSet(host), nodeSet(live));
    assert.deepEqual(edgeSet(host), edgeSet(live));
    // the text form
    const text = await cli('graph', saved);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^\d+ nodes, \d+ edges over \d+ steps\n/);
    assert.match(text.stdout, /\nn\d+ Point\.__init__ demo\.py:\d+  ×4  in x = 5 · in y = 10\n/);
    assert.match(text.stdout, /\n   n\d+ if False took False/);
    assert.match(text.stdout, /\n   n\d+ point_a = Point\(5, 10\)  ×1\n/);
    assert.match(text.stdout, /\n   n\d+ print\(pyokka\)  ×1  print stdout = \{'is_awesome': True/);
    assert.ok(text.stdout.split('\n').every((l) => l.length <= 100), 'lines fit');
    const dot = await cli('graph', saved, '--dot');
    assert.equal(dot.status, 0, dot.stderr);
    assert.match(dot.stdout, /^digraph/);
    assert.ok(dot.stdout.includes('diamond'), 'decisions are diamonds');
  });

  it('opens the Execution Diagram view from the command and moves the Time Machine with the graph', async () => {
    const posted = [];
    const original = api.panel.post.bind(api.panel);
    api.panel.post = (a, b) => {
      const msg = b ?? a;
      if (msg && typeof msg === 'object' && 'type' in msg) posted.push(msg);
      return original(a, b);
    };
    try {
      await vscode.commands.executeCommand('pyokka.showExecutionDiagram');
      await waitFor(() => posted.some((m) => m.type === 'showView' && m.view === 'run-diagram'), 'the run-diagram view');
      const graphMsg = posted.filter((m) => m.type === 'executionGraph').at(-1);
      assert.ok(graphMsg && graphMsg.graph, 'the graph reached the panel');
      assert.equal(graphMsg.graph.runId, session.state.runId);
      assert.ok(graphMsg.graph.nodes.every((n) => n.file === undefined || !path.isAbsolute(n.file)), 'display paths in the panel');
      assert.deepEqual(graphMsg.graph.stack, [], 'no stack while the Time Machine is inactive');
      // clicking a node jumps to its first call: the panel posts debugger.goto, the host moves and the stack follows
      const host = api.graph(session);
      const dist = byLabel(host, 'Point.distance');
      await vscode.commands.executeCommand('pyokka.revealTraceStep', dist.spans[0][0]);
      await api.waitForNextRun(session, 20_000).catch(() => undefined); // Auto Log switches on: a re-run in Automatic mode
      await api.waitForIdle(session, 60_000);
      assert.equal(session.nav.active, true);
      const stackMsg = await waitFor(() => posted.filter((m) => m.type === 'executionGraph.stack' && m.stack.length > 0).at(-1), 'a stack message');
      const after = api.graph(session);
      const labelsOf = (ids) => ids.map((id) => after.nodes.find((n) => n.id === id).label);
      // at the entry step the Time Machine sits on the `def` line (no statement); the outer frame's running statement is the call site
      const labels = labelsOf(stackMsg.stack);
      assert.equal(labels[0], 'Point.distance');
      assert.match(labels[1], /^print\(\{"msg": f"Distance between A and B/);
      assert.equal(labels[2], '<module>');
      assert.deepEqual(api.graphProvider.stack(session), stackMsg.stack);
      // one step in: the running statement of the function leads
      await vscode.commands.executeCommand('pyokka.playTraceNextStep');
      const inside = labelsOf(api.graphProvider.stack(session));
      assert.equal(inside[0], 'dx = self.x - other.x');
      assert.equal(inside[1], 'Point.distance');
      await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    } finally {
      api.panel.post = original;
    }
  });

  it('unrolls a package node when Step Into Library Code is on', async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const lib = path.resolve(root, '..', 'test', 'e2e', 'fixtures', 'pylib');
    const libFile = path.join(root, '_graph_e2e.py');
    fs.writeFileSync(libFile, ['import sys', `sys.path.insert(0, ${JSON.stringify(lib)})`, 'import libdemo', 'r = libdemo.describe(21)', 'print(r)', ''].join('\n'));
    let libDoc;
    try {
      libDoc = await vscode.workspace.openTextDocument(libFile);
      await vscode.window.showTextDocument(libDoc);
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      const s = api.manager.get(libDoc);
      await api.waitForIdle(s, 60_000);
      const opaque = api.graph(s);
      assert.ok(!opaque.nodes.some((n) => n.kind === 'package'), `library opaque by default: ${nodeSet(opaque)}`);
      const next = api.waitForNextRun(s, 60_000);
      s.setLibraryCode(true);
      await next;
      const folded = api.graph(s);
      const pkg = byLabel(folded, 'libdemo');
      assert.ok(pkg && pkg.kind === 'package', `package node: ${nodeSet(folded)}`);
      assert.equal(pkg.calls, 1);
      assert.equal(pkg.nested, 1, 'describe calls twice inside the package');
      assert.ok(edgeSet(folded).includes('r = libdemo.describe(21) call libdemo ×1'), `edges: ${edgeSet(folded)}`);
      // unrolled: the package's functions side by side, the edge between them inside the package
      api.graphProvider.setExpanded(s, ['libdemo']);
      const unrolled = api.graph(s, { expand: ['libdemo'] });
      assert.ok(!unrolled.nodes.some((n) => n.kind === 'package'), 'no package node once unrolled');
      assert.equal(byLabel(unrolled, 'describe').package, 'libdemo');
      assert.equal(byLabel(unrolled, 'twice').package, 'libdemo');
      assert.ok(edgeSet(unrolled).includes('describe call twice ×1'), `edges: ${edgeSet(unrolled)}`);
      assert.deepEqual(api.graphProvider.expanded(s), ['libdemo']);
      // the bridge serves the same with expand, and --all through the CLI
      await waitFor(() => api.agentBridge.descriptorFor(s), 'bridge descriptor');
      const live = await cliJson('graph', '--live', '--session', api.agentBridge.descriptorFor(s), '--expand', 'libdemo');
      assert.deepEqual(nodeSet(live), nodeSet(unrolled));
      const all = await cliJson('graph', '--live', '--session', api.agentBridge.descriptorFor(s), '--all');
      assert.deepEqual(nodeSet(all), nodeSet(unrolled));
      api.manager.stop(libDoc);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      fs.rmSync(libFile, { force: true });
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === libFile).map((e) => e.id));
    }
  });
});
