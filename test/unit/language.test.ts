import { describe, expect, it } from 'vitest';
import { isKeyword, isRunnable, runtimeLanguage } from '../../src/runtime/language';

describe('runtime language', () => {
  it('runs Python files and nothing else', () => {
    expect(runtimeLanguage({ languageId: 'python', fileName: '/a/x.py' })).toBe('python');
    expect(runtimeLanguage({ languageId: 'plaintext', fileName: '/a/x.py' })).toBe('python');
    expect(runtimeLanguage({ languageId: 'javascript', fileName: '/a/x.js' })).toBeUndefined();
    expect(runtimeLanguage({ languageId: 'typescript', fileName: '/a/x.ts' })).toBeUndefined();
    expect(isRunnable({ languageId: 'python', fileName: 'Untitled-1' })).toBe(true);
    expect(isRunnable({ languageId: 'markdown', fileName: '/a/x.md' })).toBe(false);
  });

  it('knows the Python words a hover never evaluates', () => {
    expect(isKeyword('lambda')).toBe(true);
    expect(isKeyword('None')).toBe(true);
    expect(isKeyword('total')).toBe(false);
  });
});
