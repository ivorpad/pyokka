import { describe, expect, it } from 'vitest';
import { isDiskReload, isProjectFile } from '../../src/session/diskReload';

// Which document changes count as a save from disk.
// The rule decides whether an On Save session runs the user's code, so a false positive runs it on
// every keystroke and a false negative leaves the outside edit unrun.
const doc = (text: string, dirty = false, scheme = 'file') => ({ uri: { scheme, fsPath: '/ws/app.py' }, isDirty: dirty, getText: () => text });

describe('isDiskReload', () => {
  it('a clean document whose text is the file is a reload', () => {
    expect(isDiskReload(doc('x = 2\n'), () => 'x = 2\n')).toBe(true);
    expect(isDiskReload(doc('x = 2\n'), () => '﻿x = 2\n')).toBe(true);
  });
  it('typing is not: dirty, or the text differs from disk', () => {
    expect(isDiskReload(doc('x = 2\n', true), () => 'x = 2\n')).toBe(false);
    expect(isDiskReload(doc('x = 23\n'), () => 'x = 2\n')).toBe(false);
  });
  it('a document that is not a file, or a file that cannot be read, is not', () => {
    expect(isDiskReload(doc('x', false, 'untitled'), () => 'x')).toBe(false);
    expect(isDiskReload(doc('x'), () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('isProjectFile', () => {
  it('watches the project, not libraries or the stdlib', () => {
    expect(isProjectFile('/ws/pkg/mod.py')).toBe(true);
    expect(isProjectFile('/ws/.venv/lib/python3.14/site-packages/requests/api.py')).toBe(false);
    expect(isProjectFile('/opt/homebrew/lib/python3.14/json/__init__.py')).toBe(false);
    expect(isProjectFile('<frozen importlib._bootstrap>')).toBe(false);
  });
});
