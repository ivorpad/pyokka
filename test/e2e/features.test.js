// End-to-end: watches, edit-and-continue, logpoints, snaps and profile mode on examples/demo.py.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until it returns a truthy value. */
async function waitFor(pred, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Pyokka features on demo.py', function () {
  let api, session, doc, editor;
  const lineOf = () => {
    const loc = session.trace.location(session.nav.currentStep);
    return loc ? loc.range[0] : -1;
  };

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    session = api.manager.sessionForDocument(doc);
    if (!session) {
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      session = api.manager.sessionForDocument(doc);
    }
    assert.ok(session, 'session created');
    await api.waitForIdle(session, 60_000);
  });

  after(async () => {
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    api.manager.stopAll();
  });

  it('evaluates a watch expression at the current step and the prefetched ones', async () => {
    // start on `rect1 = Rectangle(50, 20, Point(10, 10))` (line 85)
    editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(84, 0, 84, 0);
    await vscode.commands.executeCommand('pyokka.debug');
    assert.equal(session.nav.active, true);
    assert.equal(lineOf(), 85);
    const step = session.nav.currentStep;

    api.timeMachine.addWatch(session, 'point_a.x');
    const watch = session.watches.find((w) => w.exp === 'point_a.x');
    assert.ok(watch, 'watch registered');
    await waitFor(() => watch.values.get(step), 'watch value at the current step');
    const v = watch.values.get(step);
    assert.equal(v.error, undefined, `watch error: ${v.error}`);
    assert.equal(v.valueBag.data.value, '5');

    // stepping within the prefetch window needs no new run
    await vscode.commands.executeCommand('pyokka.playTraceNextStepOver');
    assert.equal(lineOf(), 86);
    await waitFor(() => watch.values.get(session.nav.currentStep), 'watch value after step over');
    assert.equal(watch.values.get(session.nav.currentStep).valueBag.data.value, '5');

    // the debugger state resolves the value for the panel
    const dbg = api.timeMachine.debuggerState(session);
    assert.equal(dbg.watches.length, 1);
    assert.equal(dbg.watches[0].valueBag.data.value, '5');

    api.timeMachine.removeWatch(session, watch.id);
    assert.equal(session.watches.length, 0);
  });

  it('re-anchors the current step after an edit (edit-and-continue)', async () => {
    assert.equal(session.nav.active, true);
    assert.equal(lineOf(), 86);
    editor = await vscode.window.showTextDocument(doc);

    let next = api.waitForNextRun(session, 60_000);
    await editor.edit((b) => b.insert(new vscode.Position(4, 0), '# edited while navigating\n'));
    await next;
    assert.equal(session.nav.active, true, 'navigation survived the edit');
    assert.equal(lineOf(), 87, 'the current step followed its statement down one line');

    next = api.waitForNextRun(session, 60_000);
    await editor.edit((b) => b.delete(new vscode.Range(4, 0, 5, 0)));
    await next;
    assert.equal(session.nav.active, true);
    assert.equal(lineOf(), 86, 'and back up again');
    assert.equal(doc.getText(), fs.readFileSync(doc.uri.fsPath, 'utf8'), 'document restored');

    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    assert.equal(session.nav.active, false);
  });

  it('logs a VS Code logpoint with {expr} interpolation', async () => {
    // `return Point(x, y)` inside generate_random_point (line 73)
    const bp = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(72, 0)), true, undefined, undefined, 'x={x} y={y}');
    const next = api.waitForNextRun(session, 60_000);
    vscode.debug.addBreakpoints([bp]);
    await next;
    const hit = session.state.entries.find((e) => e.kind === 'logpoint');
    assert.ok(hit, `logpoint entry present; kinds: ${JSON.stringify(session.state.entries.map((e) => e.kind))}`);
    assert.match(hit.text, /x=\d+ y=\d+/);

    const gone = api.waitForNextRun(session, 60_000);
    vscode.debug.removeBreakpoints([bp]);
    await gone;
    assert.ok(!session.state.entries.some((e) => e.kind === 'logpoint'), 'logpoint entry removed with the breakpoint');
  });

  it('lists a variable history: assignment sites, then recorded values once the session records locals', async () => {
    await api.waitForIdle(session, 60_000);
    assert.equal(session.recordLocals, false, 'off by default');
    let h = await api.variableHistory(session, 'working_dir');
    assert.ok(h, 'history computed');
    // `working_dir = os.getcwd()` (line 18) is known from the AST even with nothing recorded
    const site = h.changes.find((c) => c.line === 18);
    assert.ok(site, `the assignment on line 18 is listed: ${JSON.stringify(h.changes)}`);
    assert.equal(site.function, '<module>');
    assert.equal(typeof site.step, 'number');
    // the session toggle records locals on the next run (Automatic mode re-runs)
    let next = api.waitForNextRun(session, 60_000);
    session.setRecordLocals(true);
    await next;
    assert.ok(session.state.locals.length > 0, 'locals recorded');
    h = await api.variableHistory(session, 'working_dir');
    const recorded = h.changes.find((c) => c.line === 18 && c.source === 'locals');
    assert.ok(recorded, `recorded value on line 18: ${JSON.stringify(h.changes)}`);
    assert.match(recorded.text, /examples/);
    // what the assignment read: `point_b = generate_random_point(100, 100)` names its callee
    const pb = await api.variableHistory(session, 'point_b');
    const assign = pb.changes.find((c) => c.line === 83);
    assert.ok(assign && assign.reads && assign.reads.some((r) => r.name === 'generate_random_point'), `reads of line 83: ${JSON.stringify(pb.changes)}`);
    next = api.waitForNextRun(session, 60_000);
    session.setRecordLocals(false);
    await next;
  });

  it('never executes implicitly in On Demand mode', async () => {
    await api.waitForIdle(session, 60_000);
    const runId = session.state.runId;
    session.setRunMode('onDemand');
    try {
      // hover-style evaluation: no run, marked pending
      const v = await session.evaluateTransient([18, 0, 18, 11], { context: 'working_dir' });
      assert.equal(v, undefined);
      assert.equal(session.pendingRun, true);
      // ...but the finished child answers side-effect-free expressions without a run
      // editing a line hides its stale inline value until the next run, other lines keep theirs
      const nextEdit = new Promise((r) => { const h = () => { session.off('stateChanged', h); r(); }; session.on('stateChanged', h); });
      await editor.edit((b) => b.insert(new vscode.Position(19, 15), '  # edited'));  // line 20: os.cpu_count()  # ?
      await nextEdit;
      assert.ok(session.dirtyLines.has(20), `line 20 dirty: ${[...session.dirtyLines]}`);
      assert.ok(!session.dirtyLines.has(23));
      await editor.edit((b) => b.delete(new vscode.Range(19, 15, 19, 25)));
      assert.equal(doc.getText(), fs.readFileSync(doc.uri.fsPath, 'utf8'), 'document restored');
      // shadow value: edit `pyokka` (line 14) into `pyokka["python"]` -> shown from captured data, no run
      await editor.edit((b) => b.insert(new vscode.Position(13, 6), '["python"]'));
      await waitFor(() => session.shadowValues.get(14), 'shadow value for line 14', 15_000);
      const shadow = session.shadowValues.get(14);
      assert.match(shadow.text, /^'3\.\d+/);
      assert.equal(shadow.context, "pyokka['python']"); // ast.unparse normalises quotes
      assert.equal(session.state.runId, runId, 'shadow evaluation did not run');
      // explore pins the synthetic entry so the panel can show it
      api.panel.selectEntries(session, [shadow.logId]);
      assert.ok(session.pinnedEntries.includes(shadow));
      await editor.edit((b) => b.delete(new vscode.Range(13, 6, 13, 16)));
      assert.equal(doc.getText(), fs.readFileSync(doc.uri.fsPath, 'utf8'), 'document restored again');
      const live = await session.evaluateLive('rect1.width * 2');
      assert.ok(live, 'live value');
      assert.equal(live.text, '100');
      assert.equal(session.state.entriesById.get(live.logId), live);
      assert.equal(await session.evaluateLive('rect1.area()'), undefined, 'calls are refused');
      assert.equal(session.state.runId, runId, 'no run happened');
      // starting the Time Machine and adding a watch: no run either
      editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(84, 0, 84, 0);
      await vscode.commands.executeCommand('pyokka.debug');
      assert.equal(session.nav.active, true);
      api.timeMachine.addWatch(session, 'point_a.x');
      await sleep(600);
      assert.equal(session.state.runId, runId, 'no run happened');
      assert.equal(session.running, false);
      const w = session.watches[0];
      // nothing recorded `point_a.x` at this step: the row says so and offers one run, but never runs by itself
      assert.equal(w.values.get(session.nav.currentStep).error, 'not recorded at this step');
      assert.equal(w.values.get(session.nav.currentStep).needsRun, true);
      await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
      assert.equal(session.state.runId, runId, 'stopping did not run either');
      api.timeMachine.removeWatch(session, w.id);
      // an explicit re-execute runs and clears the pending state
      const next = api.waitForNextRun(session, 60_000);
      await vscode.commands.executeCommand('pyokka.reexecute');
      await next;
      assert.notEqual(session.state.runId, runId);
      assert.equal(session.pendingRun, false);
    } finally {
      session.setRunMode('auto');
    }
  });

  it('hovers a parameter without a run: a hidden marker records it on the next run, then recorded locals answer at every step', async () => {
    // demo.py line 71: `    x = random.randrange(max_x)`; `max_x` is a parameter, so no statement assigns it and nothing records it
    const hoverTexts = async (line, col) => {
      const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(line - 1, col))) || [];
      return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)));
    };
    editor = await vscode.window.showTextDocument(doc);
    await api.waitForIdle(session, 60_000);
    session.setRunMode('onSave');
    try {
      let texts = await hoverTexts(71, 27);
      assert.ok(texts.some((t) => /a local of `generate_random_point`/.test(t) && /recorded on the next run/.test(t) && /recordVariablesAndRerun/.test(t)), `pending hover: ${JSON.stringify(texts)}`);
      assert.equal(session.pendingRun, true, 'the hover queued a run');
      let next = api.waitForNextRun(session, 60_000);
      await vscode.commands.executeCommand('pyokka.reexecute');
      await next;
      texts = await hoverTexts(71, 27);
      assert.ok(texts.some((t) => /```python\n100\n```/.test(t)), `value from the hidden marker after the run: ${JSON.stringify(texts)}`);
      assert.ok(!api.inlineValues(editor).some((v) => v.line === 71), 'a hover marker never paints inline');
      // recorded locals answer every parameter at every step, no marker needed
      session.setRecordLocals(true);
      next = api.waitForNextRun(session, 60_000);
      await vscode.commands.executeCommand('pyokka.reexecute');
      await next;
      editor.selection = new vscode.Selection(71, 0, 71, 0); // line 72: `y = random.randrange(max_y)`
      await vscode.commands.executeCommand('pyokka.debug');
      assert.equal(session.nav.active, true);
      texts = await hoverTexts(72, 27);
      assert.ok(texts.some((t) => /```python\n100\n```/.test(t) && /as of step \d+ · recorded in generate_random_point/.test(t)), `recorded local at the step: ${JSON.stringify(texts)}`);
    } finally {
      if (session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
      session.markers.removeWhere((m) => m.transient);
      session.setRecordLocals(false);
      session.setRunMode('auto');
      if (session.runScheduled) await api.waitForNextRun(session, 60_000);
      await api.waitForIdle(session, 60_000);
    }
  });

  it('steps into library code only when the option is on', async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const lib = path.resolve(root, '..', 'test', 'e2e', 'fixtures', 'pylib');
    const file = path.join(root, '_lib_e2e.py');
    fs.writeFileSync(file, ['import sys', `sys.path.insert(0, ${JSON.stringify(lib)})`, 'import libdemo', 'r = libdemo.twice(21)', 'print(r)', ''].join('\n'));
    let libDoc;
    try {
      libDoc = await vscode.workspace.openTextDocument(file);
      const ed = await vscode.window.showTextDocument(libDoc);
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      const s = api.manager.get(libDoc);
      await api.waitForIdle(s, 60_000);
      assert.equal(s.libraryCode, false, 'off by default');
      const names = () => s.trace.toTimelineModel().scopes.map((sc) => sc.name);
      assert.ok(!names().includes('twice'), `library opaque by default: ${names()}`);
      assert.equal(s.files.all().length, 1);
      // switch it on for the session (auto mode: re-runs)
      const next = api.waitForNextRun(s, 60_000);
      s.setLibraryCode(true);
      await next;
      assert.ok(names().includes('twice'), `library instrumented: ${names()}`);
      const libFile = s.files.all().find((f) => f.path.includes('libdemo'));
      assert.ok(libFile, 'libdemo file registered');
      // Step Into from the call lands inside the library, Step Out returns
      ed.selection = new vscode.Selection(3, 0, 3, 0); // r = libdemo.twice(21)
      await vscode.commands.executeCommand('pyokka.debug');
      assert.equal(s.nav.active, true);
      await vscode.commands.executeCommand('pyokka.playTraceNextStep');
      let loc = s.trace.location(s.nav.currentStep);
      assert.equal(loc.fileId, libFile.fileId, 'stepped into libdemo');
      await vscode.commands.executeCommand('pyokka.playTraceNextStepOut');
      loc = s.trace.location(s.nav.currentStep);
      assert.equal(loc.fileId, s.mainFileId(), 'step out returned to the caller');
      await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
      api.manager.stop(libDoc);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      fs.rmSync(file, { force: true });
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === file).map((e) => e.id));
    }
  });

  it('steps over an awaited gather without entering the gathered tasks', async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(root, '_aio_e2e.py');
    fs.writeFileSync(
      file,
      [
        'import asyncio',
        'async def fetch(n):',
        '    await asyncio.sleep(0)',
        '    return n',
        'async def turn(i):',
        '    a = await fetch(i)',
        '    return a',
        'async def main():',
        '    one = await turn(1)',
        '    both = await asyncio.gather(turn(2), turn(3))',
        '    print(one, both)',
        'asyncio.run(main())',
        '',
      ].join('\n'),
    );
    let aioDoc;
    try {
      aioDoc = await vscode.workspace.openTextDocument(file);
      const ed = await vscode.window.showTextDocument(aioDoc);
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      const s = api.manager.get(aioDoc);
      await api.waitForIdle(s, 60_000);
      const scopes = s.trace.toTimelineModel().scopes;
      const turns = scopes.filter((sc) => sc.name === 'turn');
      assert.deepEqual(
        turns.map((sc) => sc.depth),
        [2, 1, 1],
        'turn(1) is awaited by main; the gathered turns are tasks resumed by the loop, under the module',
      );
      assert.ok(Math.max(...scopes.map((sc) => sc.depth)) <= 3, 'no scope nests under another task');
      ed.selection = new vscode.Selection(9, 0, 9, 0); // both = await asyncio.gather(...)
      await vscode.commands.executeCommand('pyokka.debug');
      assert.equal(s.nav.active, true);
      const line = () => s.trace.location(s.nav.currentStep).range[0];
      assert.equal(line(), 10);
      await vscode.commands.executeCommand('pyokka.playTraceNextStepOver');
      assert.equal(line(), 11, 'step over the gather lands on print(one, both)');
      assert.deepEqual(
        s.trace.callStack(s.nav.currentStep).map((f) => f.function),
        ['main', '<module>'],
      );
      await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
      api.manager.stop(aioDoc);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      fs.rmSync(file, { force: true });
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === file).map((e) => e.id));
    }
  });

  it('masks secrets in the run process: env values by name, literals under secret names, reveal per session', async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const envFile = path.join(root, '.env');
    const file = path.join(root, '_secrets_e2e.py');
    const key = 'e2e-key-' + Date.now().toString(36) + '-0123456789abcdef';
    assert.ok(!fs.existsSync(envFile), 'the example workspace has no .env of its own');
    fs.writeFileSync(envFile, `E2E_API_KEY=${key}\n`);
    fs.writeFileSync(file, ['import os', 'from_env = os.environ["E2E_API_KEY"]', 'client = {"api_key": "hardcoded-literal", "model": "gpt"}', 'print("Bearer " + from_env)', 'print(client)', ''].join('\n'));
    let sdoc;
    try {
      sdoc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(sdoc);
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      const s = api.manager.get(sdoc);
      await api.waitForIdle(s, 60_000);
      assert.equal(s.maskSecrets, true, 'on by default');
      const all = () => JSON.stringify(s.state.entries);
      const texts = () => s.state.entries.map((e) => e.text);
      assert.ok(!all().includes(key), `the env value never reaches the host: ${texts()}`);
      assert.ok(!all().includes('hardcoded-literal'), `the value under api_key is masked: ${texts()}`);
      assert.ok(texts().includes('Bearer \u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'), `print masked: ${texts()}`);
      assert.ok(texts().includes("{'api_key': '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022', 'model': 'gpt'}"), `dict masked by key, the rest untouched: ${texts()}`);
      // the session toggle reveals on the next run (auto mode re-runs)
      const next = api.waitForNextRun(s, 60_000);
      s.setMaskSecrets(false);
      await next;
      assert.ok(all().includes(key) && all().includes('hardcoded-literal'), `revealed: ${texts()}`);
      api.manager.stop(sdoc);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(envFile, { force: true });
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === file).map((e) => e.id));
    }
  });

  it('profiles the file into a .cpuprofile', async () => {
    const finished = await session.runNow('profile', { mode: 'profile' });
    assert.ok(finished.profile && finished.profile.path, `profile path in run.finished: ${JSON.stringify(finished)}`);
    assert.ok(fs.existsSync(finished.profile.path), 'cpuprofile written');
    const prof = JSON.parse(fs.readFileSync(finished.profile.path, 'utf8'));
    assert.ok(Array.isArray(prof.nodes) && prof.nodes.length > 1, 'profile has nodes');
    assert.equal(session.mode, 'normal', 'session mode unchanged by a one-off profile run');
  });

  it('runs snaps fenced in a file', async () => {
    const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '_snaps_e2e.py');
    fs.writeFileSync(file, ['x = 40', '"""{{', 'x + 2', '}}"""', 'y = x + 1', ''].join('\n'));
    let snapDoc;
    try {
      snapDoc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(snapDoc);
      await vscode.commands.executeCommand('pyokka.allowFileSnapsExecution');
      const s = await waitFor(() => api.manager.get(snapDoc), 'snaps session');
      await waitFor(() => s.mode === 'snaps' && !s.running && s.state.finished && s.state.mode === 'snaps', 'snaps run');
      const value = s.state.entries.find((e) => e.kind === 'value' && e.text === '42');
      assert.ok(value, `snap value logged; entries: ${JSON.stringify(s.state.entries.map((e) => [e.kind, e.text]))}`);
      api.manager.stop(snapDoc);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      fs.rmSync(file, { force: true });
      // the recent-files store is the one under PYOKKA_HOME (the e2e config points it at a temp dir)
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === file).map((e) => e.id));
    }
  });

  it('resolves a hover link whose entry id belongs to a replaced run', async () => {
    // a hover link carries { logId, exp, range, sessionKey }; the id is per run, and a value evaluated for the hover (`live-N`) lives only in the run current at hover time
    editor = await vscode.window.showTextDocument(doc);
    await api.waitForIdle(session, 60_000);
    let next = api.waitForNextRun(session, 60_000);
    await vscode.commands.executeCommand('pyokka.reexecute'); // a plain run to start from (the profile test ran a profile one)
    await next;
    const live = await session.evaluateLive('point_a.x');
    assert.ok(live, 'hover-style live value');
    assert.equal(live.text, '5');
    const staleId = live.logId;
    const staleRun = session.state.runId;
    assert.equal(session.state.entriesById.get(staleId), live);
    session.setRunMode('onSave');
    try {
      // the file re-runs before the click, as every save does in On Save mode
      next = api.waitForNextRun(session, 60_000);
      await vscode.commands.executeCommand('pyokka.reexecute');
      await next;
      const runId = session.state.runId;
      assert.notEqual(runId, staleRun);
      assert.equal(session.state.entriesById.get(staleId), undefined, 'the stale id resolves to nothing');
      // `point_a.x` is written nowhere in demo.py, so the range names `point_a` on line 82 and stands for the hovered text; outside Automatic mode only its line is used
      await vscode.commands.executeCommand('pyokka.exploreEntity', { logId: staleId, exp: 'point_a.x', range: [82, 0, 82, 7], sessionKey: session.key });
      const pinned = session.pinnedEntries.find((e) => e.context === 'point_a.x');
      assert.ok(pinned, `re-evaluated against the current run and pinned: ${JSON.stringify(session.pinnedEntries.map((e) => [e.logId, e.context]))}`);
      assert.equal(pinned.text, '5');
      assert.equal(pinned.runId, runId);
      assert.notEqual(pinned.logId, staleId);
      assert.equal(session.state.runId, runId, 'On Save: the click did not run the file');
      // an id alone from a run that is gone: nothing to re-evaluate, no error, nothing pinned
      const count = session.pinnedEntries.length;
      await vscode.commands.executeCommand('pyokka.exploreEntity', { logId: 'live-999999' });
      assert.equal(session.pinnedEntries.length, count);
      assert.equal(session.state.runId, runId);
    } finally {
      session.setRunMode('auto');
    }
    // Automatic mode: the text at the range still reads the expression, so the click re-runs the file with a transient marker there, as the hover would have
    // (a Show Value marker left on that range by an earlier suite would answer the click without a run: drop the sticky markers first)
    session.removeMarkers(session.markers.visible().filter((m) => m.kind !== 'logpoint').map((m) => m.id));
    if (session.runScheduled) await api.waitForNextRun(session, 60_000); // back in Automatic mode, a dirty document or the marker change schedules a run
    await api.waitForIdle(session, 60_000);
    const before = session.state.runId;
    await vscode.commands.executeCommand('pyokka.exploreEntity', { logId: staleId, exp: 'working_dir', range: [18, 0, 18, 11], sessionKey: session.key });
    assert.notEqual(session.state.runId, before, 'Automatic: the click re-ran the file');
    const fresh = session.state.entries.find((e) => e.context === 'working_dir' && e.runId === session.state.runId);
    assert.ok(fresh, `transient value in the new run: ${JSON.stringify(session.state.entries.map((e) => [e.kind, e.context]))}`);
    assert.match(fresh.text, /examples/);
    // its marker was transient, so the run's list hides it: the click pinned it for the panel
    assert.ok(session.pinnedEntries.includes(fresh) || session.visibleEntries().includes(fresh), `the panel lists it: ${JSON.stringify(session.pinnedEntries.map((e) => e.logId))}`);
  });
});
