// End-to-end: the Code Story document (docs/design/code-story.md) inside a real VS Code.
// Its shape (D3, D4), the window a block lists (L2, L5), the cursor following the step (T2)
// and the story closing with the Time Machine (D2).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const STORY_SCHEME = 'pyokka-code-timeline';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a row holding only the fold marker */
const GAP = /^\s*…\s*$/;
/** `<line number right-aligned>  <source line>`; a blank source line is the number alone */
const NUMBERED = /^ *(\d+)(?: |$)/;
const lineOf = (row) => {
  const m = NUMBERED.exec(row);
  return m ? Number(m[1]) : undefined;
};

const storyEditor = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === STORY_SCHEME);
const storyTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input && t.input.uri && t.input.uri.scheme === STORY_SCHEME);

/** the document's rows, without the empty row a trailing newline leaves behind */
function rowsOf(doc) {
  const rows = doc.getText().split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** runs of consecutive numbered rows: the blocks, and the pieces an interior fold splits (L4) */
function groupsOf(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    const line = lineOf(row);
    if (line === undefined) {
      current = null;
      continue;
    }
    if (!current) groups.push((current = []));
    current.push(line);
  }
  return groups;
}

async function openStory() {
  await vscode.commands.executeCommand('pyokka.viewCodeStory');
  for (let i = 0; i < 20 && !storyEditor(); i++) await sleep(100);
  const story = storyEditor();
  assert.ok(story, 'code story editor visible');
  return story;
}

describe('Code Story', function () {
  let api, doc, session;

  before(async () => {
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    assert.ok(api && api.manager, 'activate returned the API');
    api.manager.stopAll();
    const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    assert.ok(session, 'session created');
    await api.waitForIdle(session, 60_000);
    assert.ok(session.trace && session.trace.count > 50, `trace steps: ${session.trace && session.trace.count}`);
  });

  after(async () => {
    api.manager.stopAll();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('opens as an empty first row and blocks separated by one … row', async () => {
    const story = await openStory();
    assert.equal(story.document.languageId, 'pyokka-story');
    const rows = rowsOf(story.document);
    assert.ok(rows.length > 10, `story rows: ${rows.length}`);

    assert.equal(rows[0], '', 'row 1 is empty');
    assert.ok(!story.document.getText().includes('​'), 'no zero-width fences in the text');

    const rest = rows.slice(1);
    for (let i = 0; i < rest.length; i++) {
      assert.notEqual(rest[i].trim(), '', `row ${i + 2} is not blank: ${JSON.stringify(rest[i])}`);
      assert.ok(GAP.test(rest[i]) || lineOf(rest[i]) !== undefined, `row ${i + 2} is a fold marker or a numbered line: ${JSON.stringify(rest[i])}`);
    }
    assert.ok(!GAP.test(rest[0]), 'no … before the first block');
    assert.ok(!GAP.test(rest[rest.length - 1]), 'no … after the last block');
    for (let i = 0; i < rest.length - 1; i++) {
      if (GAP.test(rest[i])) assert.ok(lineOf(rest[i + 1]) !== undefined, `the … on row ${i + 2} is followed by a numbered row`);
    }
    // inside one block the numbers ascend, so a descent only happens across a … row
    for (const group of groupsOf(rest)) {
      for (let i = 1; i < group.length; i++) assert.ok(group[i] > group[i - 1], `block lines ascend: ${group}`);
    }
  });

  it('puts its cursor on the row of the current step', async () => {
    await vscode.window.showTextDocument(doc, { preserveFocus: false });
    await vscode.commands.executeCommand('pyokka.playTraceNextStepOver');
    await sleep(500);
    const step = session.nav.currentStep;
    const at = session.trace.location(step);
    assert.ok(at, `step ${step} has a location`);
    const story = storyEditor();
    assert.ok(story, 'the story is still open');
    const row = rowsOf(story.document)[story.selection.active.line];
    assert.equal(lineOf(row), at.range[0], `the story's cursor row is the current step's line: ${JSON.stringify(row)}`);
  });

  it('paints every pass its own values by default, and only the current step under story.values = step', async () => {
    const cfg = vscode.workspace.getConfiguration('pyokka');
    assert.equal(cfg.get('story.values'), 'all', 'the default paints every block (the values are what the story is for)');
    const story = storyEditor();
    assert.ok(story, 'the story is open');
    let values = [];
    for (let i = 0; i < 30; i++) {
      values = api.storyValues(story);
      if (values.length >= 2) break;
      await sleep(100);
    }
    assert.ok(values.length >= 2, `values painted on the story: ${values.length}`);
    // one source line painted in two different blocks: a loop's turns each carry their own value
    const blocksByLine = new Map();
    for (const v of values) blocksByLine.set(v.sourceLine, new Set([...(blocksByLine.get(v.sourceLine) ?? []), v.block]));
    assert.ok([...blocksByLine.values()].some((set) => set.size >= 2), `a line carries a value in more than one block: ${JSON.stringify(values.slice(0, 12))}`);
    for (const v of values) assert.ok(v.text.length > 0 && v.text.length <= 120, `value text is cut at 120: ${v.text.length}`);

    try {
      await cfg.update('story.values', 'step', vscode.ConfigurationTarget.Global);
      let stepValues = values;
      for (let i = 0; i < 30 && stepValues.length > 1; i++) {
        await sleep(100);
        stepValues = api.storyValues(story);
      }
      assert.ok(stepValues.length <= 1, `under 'step' at most the current step carries a value: ${stepValues.length}`);
    } finally {
      await cfg.update('story.values', undefined, vscode.ConfigurationTarget.Global);
    }
    for (let i = 0; i < 30 && api.storyValues(story).length < 2; i++) await sleep(100);
    assert.ok(api.storyValues(story).length >= 2, 'back to the default, every block carries its values again');
  });

  it('closes when the Time Machine stops', async () => {
    assert.equal(session.nav.active, true, 'navigating before the stop');
    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    for (let i = 0; i < 20 && storyTabs().length; i++) await sleep(100);
    assert.equal(session.nav.active, false, 'the Time Machine stopped');
    assert.deepEqual(storyTabs().map((t) => t.label), [], 'no story tab is left');
    assert.equal(storyEditor(), undefined, 'no story editor is left');
  });

  it('lists a later turn of a loop without the def line above it', async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(root, '_story_e2e.py');
    // the loop body sits more than two lines below the `def`, so only the first pass through
    // the function can reach the header inside its window (L2, L5)
    fs.writeFileSync(
      file,
      [
        'def grow(n):', //                 1
        '    total = 0', //                2
        '    values = []', //              3
        '    # padding, never executed', // 4
        '    # padding, never executed', // 5
        '    for i in range(n):', //       6
        '        total += i', //           7
        '        values.append(total)', // 8
        '    return total', //             9
        '', //                            10
        '', //                            11
        'result = grow(4)', //            12
        'print(result)', //               13
        '',
      ].join('\n'),
    );
    let fixture;
    try {
      fixture = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(fixture);
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      const s = api.manager.get(fixture);
      assert.ok(s, 'fixture session created');
      await api.waitForIdle(s, 60_000);

      const story = await openStory();
      const rows = rowsOf(story.document);
      const groups = groupsOf(rows.slice(1)).filter((g) => g.includes(7));
      assert.ok(groups.length >= 2, `the loop body is listed once per turn: ${JSON.stringify(groups)}`);
      assert.ok(groups[0].includes(1), `the first pass lists the def line: ${groups[0]}`);
      for (const group of groups.slice(1)) {
        assert.ok(!group.includes(1), `a later turn does not list the def line: ${group}`);
        for (const line of group) assert.ok(line >= 4 && line <= 9, `a later turn lists the executed lines and two either side, clamped to the function: ${group}`);
      }
      await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
      api.manager.stop(fixture);
    } finally {
      fs.rmSync(file, { force: true });
      api.manager.recentFiles.remove(
        api.manager.recentFiles
          .list()
          .filter((e) => e.path === file)
          .map((e) => e.id),
      );
    }
  });
});
