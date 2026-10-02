import { describe, expect, it } from 'vitest';
import { lineMapping, reanchorStep, type AnchorTrace } from '../../src/timeMachine/reanchor';

function trace(lines: string[], executedLines: number[]): AnchorTrace {
  return { count: executedLines.length, textAt: (i) => lines[executedLines[i]! - 1], lineAt: (i) => executedLines[i]! };
}

describe('reanchorStep', () => {
  const oldSrc = ['a = 1', 'b = 2', 'for i in range(2):', '    b += i', 'print(b)'];
  const oldExec = [1, 2, 3, 4, 3, 4, 3, 5];

  it('keeps the same statement after a line is inserted above', () => {
    const newSrc = ['# comment', ...oldSrc];
    const newExec = [2, 3, 4, 5, 4, 5, 4, 6];
    const step = reanchorStep(trace(oldSrc, oldExec), trace(newSrc, newExec), 5, oldSrc.join('\n'), newSrc.join('\n'));
    expect(step).toBe(5); // second execution of `b += i`
    expect(newExec[step]).toBe(5);
  });

  it('keeps the occurrence index inside loops', () => {
    const newSrc = ['a = 1', 'b = 2', 'for i in range(3):', '    b += i', 'print(b)'];
    const newExec = [1, 2, 3, 4, 3, 4, 3, 4, 3, 5];
    expect(reanchorStep(trace(oldSrc, oldExec), trace(newSrc, newExec), 3, oldSrc.join('\n'), newSrc.join('\n'))).toBe(3);
    expect(reanchorStep(trace(oldSrc, oldExec), trace(newSrc, newExec), 5, oldSrc.join('\n'), newSrc.join('\n'))).toBe(5);
  });

  it('falls back to the line diff when the statement text changed', () => {
    const newSrc = ['a = 1', 'b = 20', 'for i in range(2):', '    b += i', 'print(b)'];
    const newExec = [1, 2, 3, 4, 3, 4, 3, 5];
    // step 1 is `b = 2`, now `b = 20`: same line -> same step
    expect(reanchorStep(trace(oldSrc, oldExec), trace(newSrc, newExec), 1, oldSrc.join('\n'), newSrc.join('\n'))).toBe(1);
  });

  it('clamps when the statement disappeared', () => {
    const newSrc = ['a = 1', 'b = 2'];
    const newExec = [1, 2];
    expect(reanchorStep(trace(oldSrc, oldExec), trace(newSrc, newExec), 7, oldSrc.join('\n'), newSrc.join('\n'))).toBe(1);
    expect(reanchorStep(trace(oldSrc, oldExec), trace([], []), 3, oldSrc.join('\n'), '')).toBe(-1);
  });
});

describe('lineMapping', () => {
  it('maps unchanged lines across insertions and deletions', () => {
    const map = lineMapping('a\nb\nc\nd\n', 'a\nX\nb\nd\n');
    expect(map(1)).toBe(1);
    expect(map(2)).toBe(3);
    expect(map(3)).toBe(-1);
    expect(map(4)).toBe(4);
  });
});
