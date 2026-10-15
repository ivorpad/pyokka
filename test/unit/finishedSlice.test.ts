import { describe, expect, it } from 'vitest';
import { finishedSlice, uncaughtError } from '../../src/debug/debugSessionState';

// A debug run that ends says why
describe('finishedSlice', () => {
  const fin = { exitCode: 1, durationMs: 5, stepCount: 7 };
  it('names the uncaught error that ended the run, from its innermost frame', () => {
    const caught = { type: 'error', fileId: 1, rid: 3, step: 2, message: 'later', errorType: 'KeyError', stack: [], handled: true } as any;
    const uncaught = { type: 'error', fileId: 1, rid: 9, step: 6, message: 'too big: 3', errorType: 'ValueError', handled: false, stack: [{ fileId: 1, line: 4, col: 0, function: 'f', path: '/ws/raise.py' }, { fileId: 1, line: 9, col: 0, function: '<module>', path: '/ws/raise.py' }] } as any;
    expect(finishedSlice(fin, [caught, uncaught])).toEqual({ finished: { ...fin, error: { type: 'ValueError', message: 'too big: 3', file: '/ws/raise.py', line: 4 } } });
  });
  it('is the exit alone when nothing was uncaught', () => {
    expect(finishedSlice(fin, [])).toEqual({ finished: fin });
    expect(finishedSlice(undefined)).toEqual({ finished: { exitCode: null, durationMs: 0, stepCount: 0 } });
  });
  it('keeps type and message when the error has no frame', () => {
    expect(uncaughtError([{ type: 'error', fileId: 1, rid: 0, step: 0, message: 'boom', errorType: 'RuntimeError', handled: false, stack: [] } as any])).toEqual({ type: 'RuntimeError', message: 'boom' });
  });
});
