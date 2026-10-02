import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearLibraryCache, describeClear, libraryCacheDir } from '../../src/features/libraryCache';

// the module imports vscode for the command; the helpers under test never touch it
vi.mock('vscode', () => ({}));

describe('libraryCacheDir', () => {
  it('follows PYOKKA_CACHE_DIR like the runtime: set moves it, empty turns the cache off, unset is ~/.pyokka/cache', () => {
    expect(libraryCacheDir({ PYOKKA_CACHE_DIR: '/tmp/pk' })).toBe('/tmp/pk');
    expect(libraryCacheDir({ PYOKKA_CACHE_DIR: '' })).toBeUndefined();
    expect(libraryCacheDir({})).toBe(path.join(os.homedir(), '.pyokka', 'cache'));
  });
});

describe('clearLibraryCache', () => {
  it('removes the .bin entries and temp files at the top level, nothing else, and sums their size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-cache-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'a'.repeat(40) + '.bin'), Buffer.alloc(1200));
      fs.writeFileSync(path.join(dir, 'b'.repeat(40) + '.bin'), Buffer.alloc(300));
      fs.writeFileSync(path.join(dir, '.tmp-xyz.bin'), Buffer.alloc(10));
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
      fs.mkdirSync(path.join(dir, 'sub.bin'));
      fs.writeFileSync(path.join(dir, 'sub.bin', 'inner.bin'), Buffer.alloc(5));
      expect(clearLibraryCache(dir)).toEqual({ removed: 3, bytes: 1510, failed: 0 });
      expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'sub.bin']);
      expect(fs.existsSync(path.join(dir, 'sub.bin', 'inner.bin'))).toBe(true);
      // a second pass finds nothing
      expect(clearLibraryCache(dir)).toEqual({ removed: 0, bytes: 0, failed: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('treats a missing directory as empty', () => {
    expect(clearLibraryCache(path.join(os.tmpdir(), 'pyokka-cache-test-missing-' + process.pid))).toEqual({ removed: 0, bytes: 0, failed: 0 });
  });
});

describe('describeClear', () => {
  it('says what happened in one sentence', () => {
    expect(describeClear(undefined, undefined)).toContain('PYOKKA_CACHE_DIR is empty');
    expect(describeClear('/c', { removed: 0, bytes: 0, failed: 0 })).toBe('the library cache at /c is already empty.');
    expect(describeClear('/c', { removed: 1, bytes: 512, failed: 0 })).toBe('removed 1 cached library file (512 B) from /c; the next run with Step Into Library Code on rewrites what it needs.');
    expect(describeClear('/c', { removed: 2454, bytes: 31_200_000, failed: 3 })).toBe('removed 2454 cached library files (31 MB) from /c; the next run with Step Into Library Code on rewrites what it needs. 3 could not be removed (in use or read-only).');
    expect(describeClear('/c', { removed: 0, bytes: 0, failed: 2 })).toBe('none of the 2 cached library files at /c could be removed (in use or read-only).');
  });
});
