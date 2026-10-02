// Diagnostic: a library-code run against a venv that has openai and pydantic installed.
// Set PYOKKA_LIBDIAG_PYTHON to that venv's python; without it the case skips.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const PY = process.env.PYOKKA_LIBDIAG_PYTHON || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('library run diagnostics', function () {
  it('runs openai with library code, then Time Machine, Code Story and Step Into', async function () {
    if (!PY || !fs.existsSync(PY)) this.skip();
    const ext = vscode.extensions.getExtension('ivor.pyokka');
    const api = await ext.activate();
    const cfg = vscode.workspace.getConfiguration('pyokka');
    await cfg.update('python.interpreter', PY, vscode.ConfigurationTarget.Global);
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(root, '_lib_openai.py');
    fs.writeFileSync(file, 'import openai\nclient = openai.OpenAI(api_key="x")\nn = 1\nprint(n)\n');
    let maxLag = 0;
    let last = Date.now();
    const lagTimer = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 50);
      last = now;
    }, 50);
    const mark = (label, t0) => {
      console.log(`[libdiag] ${label}: ${Date.now() - t0} ms (max event-loop lag ${maxLag} ms)`);
      maxLag = 0;
    };
    let doc;
    try {
      doc = await vscode.workspace.openTextDocument(file);
      const ed = await vscode.window.showTextDocument(doc);
      let t0 = Date.now();
      await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
      const s = api.manager.get(doc);
      await api.waitForIdle(s, 120_000);
      mark('first run, library off', t0);
      try { await vscode.commands.executeCommand('pyokka.showOutput'); } catch (e) { console.log('[libdiag] showOutput failed', e.message); }
      t0 = Date.now();
      const next = api.waitForNextRun(s, 120_000);
      s.setLibraryCode(true);
      await next;
      mark('library run, cold cache', t0);
      console.log('[libdiag] files', s.files.all().length, 'steps', s.trace.count, 'scopes', s.trace.scopes.length, 'entries', s.state.entries.length);
      t0 = Date.now();
      await s.runNow('manual');
      await api.waitForIdle(s, 120_000);
      mark('library run, warm cache', t0);
      ed.selection = new vscode.Selection(1, 0, 1, 0);
      t0 = Date.now();
      await vscode.commands.executeCommand('pyokka.debug');
      mark('time machine start', t0);
      assert.equal(s.nav.active, true);
      t0 = Date.now();
      await vscode.commands.executeCommand('pyokka.viewCodeStory');
      mark('code story open', t0);
      for (let i = 0; i < 6; i++) {
        t0 = Date.now();
        await vscode.commands.executeCommand('pyokka.playTraceNextStep');
        const loc = s.trace.location(s.nav.currentStep);
        mark(`step into -> ${loc ? path.basename(s.files.get(loc.fileId).path) + ':' + loc.range[0] : '?'}`, t0);
      }
      t0 = Date.now();
      await sleep(3000);
      mark('idle 3 s', t0);
      console.log('[libdiag] visible editors', vscode.window.visibleTextEditors.map((e) => path.basename(e.document.uri.fsPath)).join(', '));
      await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
      api.manager.stop(doc);
    } finally {
      clearInterval(lagTimer);
      fs.rmSync(file, { force: true });
      await cfg.update('python.interpreter', undefined, vscode.ConfigurationTarget.Global);
      api.manager.recentFiles.remove(api.manager.recentFiles.list().filter((e) => e.path === file).map((e) => e.id));
    }
  });
});
