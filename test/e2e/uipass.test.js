// UI pass: put the window in full screen, drive each surface through the API and
// capture the screen. Only runs with PYOKKA_UI_PASS=1 (it takes over the display).
// Screenshots go to PYOKKA_SHOTS or docs/reference/pyokka-live/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

const ENABLED = process.env.PYOKKA_UI_PASS === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

(ENABLED ? describe : describe.skip)('Pyokka UI pass', function () {
  let api, session, doc, editor, shots, theme;
  const cfg = () => vscode.workspace.getConfiguration();
  const shot = async (name, settle = 1200) => {
    await sleep(settle);
    const file = path.join(shots, `${name}.png`);
    execFileSync('screencapture', ['-x', file]);
    console.log(`[pyokka-ui] ${file}`);
  };
  const startTm = async (line) => {
    editor = await vscode.window.showTextDocument(doc);
    await api.waitForIdle(session, 60_000);
    editor.selection = new vscode.Selection(line - 1, 0, line - 1, 0);
    await vscode.commands.executeCommand('pyokka.debug');
    assert.equal(session.nav.active, true);
  };

  before(async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    shots = process.env.PYOKKA_SHOTS || path.join(root, '..', 'docs', 'reference', 'pyokka-live');
    fs.mkdirSync(shots, { recursive: true });
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    api = await ext.activate();
    theme = cfg().get('workbench.colorTheme');
    await cfg().update('workbench.colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
    api.manager.stopAll();
    doc = await vscode.workspace.openTextDocument(path.join(root, 'demo.py'));
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await sleep(1500);
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    await api.waitForIdle(session, 60_000);
    await vscode.commands.executeCommand('pyokka.showOutput');
  });

  after(async () => {
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    await cfg().update('workbench.colorTheme', theme, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
    api.manager.stopAll();
  });

  it('dark: values, coverage, output panel', async () => {
    editor = await vscode.window.showTextDocument(doc);
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    await shot('u01-dark-values');
  });

  it('dark: time machine with dimmed values from other steps, then a watch', async () => {
    await startTm(85);
    api.panel.showView('debugger');
    await shot('u02-tm-dim-others');
    api.timeMachine.addWatch(session, 'point_a.x');
    const w = session.watches[0];
    await waitFor(() => w.values.get(session.nav.currentStep), 'watch value');
    await vscode.commands.executeCommand('pyokka.playTraceNextStep');
    await shot('u03-tm-watch');
    await vscode.commands.executeCommand('pyokka.viewCallStack');
    await shot('u04-tm-callstack');
    api.timeMachine.removeWatch(session, w.id);
    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
  });

  it('dark: paused on a return inside a function', async () => {
    await startTm(83); // point_b = generate_random_point(100, 100)
    await vscode.commands.executeCommand('pyokka.playTraceNextStep'); // def line
    await vscode.commands.executeCommand('pyokka.playTraceNextStepOver'); // x =
    await vscode.commands.executeCommand('pyokka.playTraceNextStepOver'); // y =
    await vscode.commands.executeCommand('pyokka.playTraceNextStepOver'); // return Point(x, y)
    const loc = session.trace.location(session.nav.currentStep);
    assert.equal(loc.range[0], 73, `paused on the return, line ${loc.range[0]}`);
    api.panel.showView('debugger');
    await shot('u15-tm-return-in-function', 2500);
    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
  });

  it('dark: value peek hover', async () => {
    editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(13, 2, 13, 2); // `pyokka` on line 14
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    await vscode.commands.executeCommand('editor.action.showHover');
    await shot('u05-value-peek', 3000);
    await vscode.commands.executeCommand('cursorDown');
  });

  it('dark: diagram, compare, settings', async () => {
    const prints = session.state.entries.filter((e) => e.kind === 'log' && /rect1/.test(e.text || ''));
    assert.ok(prints.length >= 2, `rect prints: ${prints.length}`);
    await vscode.commands.executeCommand('pyokka.showDiagramForEntry', { logId: prints[0].logId });
    await shot('u06-diagram', 2000);
    assert.ok(api.panel.compareEntries(session, prints[0].logId, prints[1].logId));
    await shot('u07-compare', 2000);
    api.panel.showView('settings');
    await shot('u08-settings');
    api.panel.showView('output');
  });

  it('dark: recent files and profiler', async () => {
    await vscode.commands.executeCommand('pyokka.viewRecentFiles');
    await shot('u09-recent-files');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('pyokka.profile');
    await shot('u10-profile', 2500);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('dark: quick package install hover', async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(root, '_pkg_e2e.py');
    fs.writeFileSync(file, 'import not_a_real_package_xyz\n\nprint(not_a_real_package_xyz)\n');
    try {
      const d = await vscode.workspace.openTextDocument(file);
      const e = await vscode.window.showTextDocument(d);
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      const s = api.manager.sessionForDocument(d);
      await api.waitForIdle(s, 60_000);
      e.selection = new vscode.Selection(0, 8, 0, 8);
      await vscode.commands.executeCommand('editor.action.showHover');
      await shot('u11-package-install', 2000);
      await vscode.commands.executeCommand('cursorDown');
      api.manager.stop(d);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      fs.rmSync(file, { force: true });
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === file).map((e) => e.id));
    }
  });

  it('light: values, time machine, code story', async () => {
    await cfg().update('workbench.colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
    editor = await vscode.window.showTextDocument(doc);
    await sleep(1500);
    await api.waitForIdle(session, 60_000);
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    await shot('u12-light-values', 2000);
    await startTm(85);
    api.panel.showView('debugger');
    await shot('u13-light-tm');
    await vscode.commands.executeCommand('pyokka.viewCodeStory');
    await shot('u14-light-code-story', 2000);
    await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
  });
});
