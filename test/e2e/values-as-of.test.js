// End-to-end: with the Time Machine on, inline values and Value Peek hovers show the value
// as of the current step (the "VALUES AS OF THIS STEP" section of examples/demo.py).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Pyokka values as of this step on demo.py', function () {
  let api, session, doc, editor;
  // 1-based lines found by text, so the demo can grow above the section
  let zeroLine, forLine, plusLine, raiseLine, printLine, beforeLoopLine, totalCol;

  const lineOf = () => {
    const loc = session.trace.location(session.nav.currentStep);
    return loc ? loc.range[0] : -1;
  };
  const run = (command) => vscode.commands.executeCommand(command);
  const cursorTo = async (line) => {
    editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(line - 1, 0, line - 1, 0);
  };
  /** What the editor paints right now; the Time Machine reveals the document, so the editor is looked up each time. */
  const values = () => {
    const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    assert.ok(ed, 'demo.py is visible');
    return api.inlineValues(ed);
  };
  const at = (line) => values().find((v) => v.line === line);
  const expectItem = (line, want, what) => {
    const all = values();
    const item = all.find((v) => v.line === line);
    const dump = `inline values: ${JSON.stringify(all)}`;
    assert.ok(item, `${what}: an item on line ${line}; ${dump}`);
    assert.equal(item.text, want.text, `${what}: text on line ${line}; ${dump}`);
    assert.equal(item.dim, want.dim, `${what}: dim on line ${line}; ${dump}`);
    return item;
  };
  const expectNone = (line, what) => {
    const all = values();
    assert.equal(all.find((v) => v.line === line), undefined, `${what}: no item on line ${line}; inline values: ${JSON.stringify(all)}`);
  };
  /** The Value Peek hover at (line, col): the markdown that carries the as-of footer, polled briefly. */
  const hoverAsOf = async (line, col) => {
    const pos = new vscode.Position(line - 1, col);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos)) || [];
      const texts = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)));
      const hit = texts.find((t) => /as of step/.test(t));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no Pyokka hover with an as-of footer at ${line}:${col}; hovers: ${JSON.stringify(texts)}`);
      await sleep(250);
    }
  };

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    assert.equal(typeof api.inlineValues, 'function', 'api.inlineValues is exported');
    const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');

    const lines = doc.getText().split('\n');
    const lineWith = (text) => {
      const i = lines.findIndex((l) => l.includes(text));
      assert.ok(i >= 0, `demo.py has a line with ${JSON.stringify(text)}`);
      return i + 1;
    };
    zeroLine = lineWith('total = 0');
    forLine = lineWith('for n in range');
    plusLine = lineWith('total += n');
    raiseLine = lineWith('raise ValueError');
    printLine = lineWith('print(pyokka)');
    beforeLoopLine = lineWith('working_dir = os.getcwd()');
    totalCol = lines[plusLine - 1].indexOf('total') + 2; // inside `total`

    session = api.manager.sessionForDocument(doc);
    if (!session) {
      await run('pyokka.startOnCurrentFile');
      session = api.manager.sessionForDocument(doc);
    }
    assert.ok(session, 'session created');
    if (session.nav.active) await run('pyokka.stopTraceNavigation');
    await api.waitForIdle(session, 60_000);
  });

  after(async () => {
    if (session && session.nav.active) await run('pyokka.stopTraceNavigation');
    if (session) await api.waitForIdle(session, 60_000);
    assert.equal(doc.getText(), fs.readFileSync(doc.uri.fsPath, 'utf8'), 'demo.py was not modified');
  });

  it('starts on `total += n`: the first iteration in full, earlier values dimmed, later ones hidden', async () => {
    await cursorTo(plusLine);
    // starting switches Auto Log on, which re-runs the file in Automatic mode
    const rerun = session.autoLog ? undefined : api.waitForNextRun(session, 60_000);
    await run('pyokka.debug');
    assert.equal(session.nav.active, true, 'time machine active');
    if (rerun) await rerun;
    await api.waitForIdle(session, 60_000);
    assert.equal(session.nav.active, true, 'navigation survived the Auto Log re-run');
    assert.equal(lineOf(), plusLine);

    const all = values();
    assert.deepEqual(all.map((v) => v.line), [...all.map((v) => v.line)].sort((a, b) => a - b), `sorted by line: ${JSON.stringify(all)}`);
    const now = expectItem(plusLine, { text: '1', dim: false }, 'the current step');
    assert.equal(now.kind, 'log', JSON.stringify(now));
    expectItem(zeroLine, { text: '0', dim: true }, 'an earlier statement');
    const printed = at(printLine);
    assert.ok(printed && printed.dim === true, `print(pyokka), an earlier step, is dimmed; inline values: ${JSON.stringify(all)}`);
    expectNone(raiseLine, 'the error has not happened yet');
  });

  it('hovers `total` with the value as of the step and the final value', async () => {
    const md = await hoverAsOf(plusLine, totalCol);
    assert.match(md, /```python\n1\n```/, `hover: ${md}`);
    assert.match(md, /as of step \d+; final:\* `6`/, `hover: ${md}`);
  });

  it('steps through the loop: ×2 3, ×3 6, and back', async () => {
    await run('pyokka.playTraceNextStepOver');
    assert.equal(lineOf(), forLine, 'the loop header');
    expectItem(plusLine, { text: '1', dim: true }, 'between iterations the last hit stays, dimmed');
    await run('pyokka.playTraceNextStepOver');
    assert.equal(lineOf(), plusLine);
    expectItem(plusLine, { text: '×2 3', dim: false }, 'the second iteration');
    let md = await hoverAsOf(plusLine, totalCol);
    assert.match(md, /```python\n3\n```/, `hover: ${md}`);
    assert.match(md, /final:\* `6`/, `hover: ${md}`);

    await run('pyokka.playTraceNextStepOver');
    await run('pyokka.playTraceNextStepOver');
    assert.equal(lineOf(), plusLine);
    expectItem(plusLine, { text: '×3 6', dim: false }, 'the third iteration');
    md = await hoverAsOf(plusLine, totalCol);
    assert.match(md, /```python\n6\n```/, `hover: ${md}`);
    assert.match(md, /as of step \d+\*/, `hover: ${md}`);
    assert.doesNotMatch(md, /final:/, `the final value equals the value as of the step; hover: ${md}`);

    await run('pyokka.playTracePrevStepOver');
    await run('pyokka.playTracePrevStepOver');
    assert.equal(lineOf(), plusLine);
    expectItem(plusLine, { text: '×2 3', dim: false }, 'back to the second iteration');
  });

  it('before the loop nothing is painted and the hover says not run yet', async () => {
    await cursorTo(beforeLoopLine);
    await run('pyokka.playTraceBackwardToSelection');
    assert.equal(lineOf(), beforeLoopLine);
    expectNone(plusLine, 'the loop body has not run yet');
    expectNone(zeroLine, '`total = 0` has not run yet');
    const md = await hoverAsOf(plusLine, totalCol);
    assert.match(md, /not run yet as of step \d+; final:\* `6`/, `hover: ${md}`);
    assert.doesNotMatch(md, /```/, `no value block before the first hit; hover: ${md}`);
  });

  it('stopping the Time Machine restores the final values, undimmed', async () => {
    // when the Time Machine switched Auto Log on, stopping switches it off again, which re-runs:
    // read the values before that run starts (a run start swaps in an empty state)
    const rerun = session.nav.autoLogByTimeMachine ? api.waitForNextRun(session, 60_000) : undefined;
    await run('pyokka.stopTraceNavigation');
    assert.equal(session.nav.active, false);
    expectItem(plusLine, { text: '×3 6', dim: false }, "the run's final value");
    if (rerun) await rerun;
  });
});
