import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { windowIdOf, windowsDir, writeWindowFile } from '../../src/agent/windowFile';

// the module imports vscode for activation; the helpers under test never touch it
vi.mock('vscode', () => ({}));

describe('the window file', () => {
  it('reads the windowId VS Code appends to an external URI, and nothing else', () => {
    expect(windowIdOf('windowId=3')).toBe('3');
    expect(windowIdOf('a=1&windowid=12&b=2')).toBe('12');
    expect(windowIdOf('a=1')).toBeUndefined();
    expect(windowIdOf('notwindowId=3')).toBeUndefined();
  });
  it('lives under $PYOKKA_HOME/windows, named by the extension host pid, readable by its owner only', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-windows-'));
    const dir = windowsDir({ PYOKKA_HOME: home });
    expect(dir).toBe(path.join(home, 'windows'));
    const file = writeWindowFile(dir, { pid: 4242, windowId: '3', folders: ['/ws'] });
    expect(file).toBe(path.join(dir, '4242.json'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: 4242, windowId: '3', folders: ['/ws'] });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
