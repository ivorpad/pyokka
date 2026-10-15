import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installedInterpreters, interpreterKey, isApplePlaceholder, whichSync, workspaceVenvs } from '../../src/runtime/pythonDiscovery';

function tmp(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pk-disc-'));
}
function exe(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}

describe('finding Python without running it', () => {
  it('resolves a bare name through PATH as a shell does, skipping what is not executable', () => {
    const t = tmp();
    fs.mkdirSync(path.join(t, 'a'));
    fs.writeFileSync(path.join(t, 'a', 'python3'), 'not executable', { mode: 0o644 });
    const b = exe(path.join(t, 'b', 'python3'));
    expect(whichSync('python3', [path.join(t, 'a'), path.join(t, 'b')].join(path.delimiter))).toBe(b);
    expect(whichSync('python3', path.join(t, 'a'))).toBeUndefined();
    expect(whichSync('/abs/python3', '')).toBe('/abs/python3');
  });

  it("never runs Apple's /usr/bin/python3 while no Command Line Tools stand behind it", () => {
    const none = { platform: 'darwin' as const, exists: () => false, devDirs: ['/Library/Developer/CommandLineTools'] };
    expect(isApplePlaceholder('/usr/bin/python3', none)).toBe(true);
    expect(isApplePlaceholder('/usr/bin/python', none)).toBe(true);
    // with the tools installed it is a real Python 3.9
    expect(isApplePlaceholder('/usr/bin/python3', { ...none, exists: (f) => f === '/Library/Developer/CommandLineTools/usr/bin/python3' })).toBe(false);
    expect(isApplePlaceholder('/usr/bin/python3', { ...none, platform: 'linux' })).toBe(false);
    expect(isApplePlaceholder('/opt/homebrew/bin/python3', none)).toBe(false);
  });

  it("finds a folder's own venv, only with its pyvenv.cfg", () => {
    const t = tmp();
    const venv = exe(path.join(t, 'proj', '.venv', 'bin', 'python'));
    fs.writeFileSync(path.join(t, 'proj', '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    exe(path.join(t, 'other', 'venv', 'bin', 'python'));
    expect(workspaceVenvs([path.join(t, 'proj'), path.join(t, 'other')])).toEqual([venv]);
  });

  it('lists the usual install places one level deep, newest name first, versioned names only', () => {
    const home = tmp();
    const bin = path.join(home, 'brew-bin');
    const b13 = exe(path.join(bin, 'python3.13'));
    const b12 = exe(path.join(bin, 'python3.12'));
    exe(path.join(bin, 'python3'));
    const pyenv = exe(path.join(home, '.pyenv', 'versions', '3.13.1', 'bin', 'python3'));
    const uv = exe(path.join(home, '.local', 'share', 'uv', 'python', 'cpython-3.14.0-macos-aarch64-none', 'bin', 'python3'));
    const conda = exe(path.join(home, 'miniconda3', 'bin', 'python'));
    const env = exe(path.join(home, 'miniconda3', 'envs', 'ds', 'bin', 'python'));
    expect(installedInterpreters({ home, platform: 'linux', binDirs: [bin] })).toEqual([b13, b12, pyenv, uv, conda, env]);
  });

  it('keys a venv by its own path (it links to its base, but is another environment) and anything else by its real path', () => {
    const t = tmp();
    const base = exe(path.join(t, 'base', 'bin', 'python3.13'));
    fs.mkdirSync(path.join(t, 'proj', '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(t, 'proj', '.venv', 'pyvenv.cfg'), `home = ${path.dirname(base)}\n`);
    fs.symlinkSync(base, path.join(t, 'proj', '.venv', 'bin', 'python'));
    fs.mkdirSync(path.join(t, 'links'));
    fs.symlinkSync(base, path.join(t, 'links', 'python3'));
    expect(interpreterKey(path.join(t, 'proj', '.venv', 'bin', 'python'))).toBe(path.join(t, 'proj', '.venv', 'bin', 'python'));
    expect(interpreterKey(path.join(t, 'links', 'python3'))).toBe(base);
  });
});
