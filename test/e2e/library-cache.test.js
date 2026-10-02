// "Pyokka: Clear Library Cache" inside a real extension host: the command empties the directory the
// run child would cache into (PYOKKA_CACHE_DIR here, set on the host's own environment, which is
// what the child inherits) and touches nothing else. The command reports through a notification,
// so the directory is the assertion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

describe('Clear Library Cache', function () {
  this.timeout(60_000);

  it('removes the .bin entries of the cache directory and leaves everything else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-e2e-cache-'));
    const previous = process.env.PYOKKA_CACHE_DIR;
    try {
      fs.writeFileSync(path.join(dir, 'a'.repeat(40) + '.bin'), Buffer.alloc(2048));
      fs.writeFileSync(path.join(dir, '.tmp-left.bin'), Buffer.alloc(16));
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
      process.env.PYOKKA_CACHE_DIR = dir;
      await vscode.commands.executeCommand('pyokka.clearLibraryCache');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['keep.txt']);
      // an empty directory and a missing one are both fine
      await vscode.commands.executeCommand('pyokka.clearLibraryCache');
      process.env.PYOKKA_CACHE_DIR = path.join(dir, 'missing');
      await vscode.commands.executeCommand('pyokka.clearLibraryCache');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['keep.txt']);
    } finally {
      if (previous === undefined) delete process.env.PYOKKA_CACHE_DIR;
      else process.env.PYOKKA_CACHE_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a registered command', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('pyokka.clearLibraryCache'));
  });
});
