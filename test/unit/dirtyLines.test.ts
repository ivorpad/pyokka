import { describe, expect, it } from 'vitest';
import { applyEditToDirtyLines } from '../../src/session/dirtyLines';

const d = (startLine: number, endLine: number, text: string) => ({ startLine, startCol: 0, endLine, endCol: 0, text });

describe('applyEditToDirtyLines', () => {
  it('marks the edited line and keeps others', () => {
    expect([...applyEditToDirtyLines(new Set(), d(5, 5, 'x'))]).toEqual([5]);
    expect([...applyEditToDirtyLines(new Set([2, 9]), d(5, 5, 'x'))].sort()).toEqual([2, 5, 9]);
  });
  it('shifts later lines on inserted and removed newlines', () => {
    expect([...applyEditToDirtyLines(new Set([2, 9]), d(5, 5, 'a\nb\n'))].sort((a, b) => a - b)).toEqual([2, 5, 6, 7, 11]);
    expect([...applyEditToDirtyLines(new Set([2, 9]), d(4, 6, ''))].sort((a, b) => a - b)).toEqual([2, 4, 7]);
  });
  it('re-marks lines inside a replaced span', () => {
    expect([...applyEditToDirtyLines(new Set([5, 6]), d(5, 6, 'one'))]).toEqual([5]);
  });
});
