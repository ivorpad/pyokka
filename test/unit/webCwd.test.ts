import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BridgeServer, main, runDirs } from '../../web/server';

/**
 * `pyokka web FILE --cwd DIR`. The page ran every file with the file's own folder as the project
 * root, so a test in tests/ (or a launcher in /tmp) made the rest of the project library code, which
 * the debugger neither stopped nor stepped in.
 */

const fake = path.join(__dirname, 'fixtures', 'fakeRunner.cjs');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkw-cwd-')));

function project(): { proj: string; file: string } {
  const proj = tmp();
  fs.mkdirSync(path.join(proj, 'tests'));
  const file = path.join(proj, 'tests', 'test_routes.py');
  fs.writeFileSync(file, 'pass\n');
  return { proj, file };
}

describe('pyokka web --cwd', () => {
  it('makes DIR the root when it holds the file, and only the working directory when it does not', () => {
    const { proj, file } = project();
    const tests = path.join(proj, 'tests');
    expect(runDirs(file)).toEqual({ root: tests, cwd: tests });
    expect(runDirs(file, proj)).toEqual({ root: proj, cwd: proj });
    expect(runDirs(file, proj + '/')).toEqual({ root: proj, cwd: proj });
    const elsewhere = tmp();
    expect(runDirs(file, elsewhere)).toEqual({ root: tests, cwd: elsewhere });
  });

  it('sends that root and working directory with the run', async () => {
    const { proj, file } = project();
    const out = path.join(proj, 'dirs.json');
    process.env['PKW_FAKE_DIRS'] = out;
    const server = new BridgeServer({ file, port: 0, host: '127.0.0.1', runtime: `"${process.execPath}" "${fake}"`, python: 'python3', watch: false, open: false, distDir: proj, stateDir: proj, cwd: proj });
    try {
      await server.start();
      for (let i = 0; i < 150 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 20));
      expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({ workspaceRoot: proj, cwd: proj });
    } finally {
      delete process.env['PKW_FAKE_DIRS'];
      await server.close();
    }
  });

  it('refuses a --cwd that is not a directory, before it serves anything', async () => {
    const { proj, file } = project();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main([file, '--cwd', path.join(proj, 'nope')])).toBe(2);
      expect(String(err.mock.calls[0]?.[0])).toContain('--cwd needs a directory: no such directory');
      expect(await main([file, '--cwd'])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});
