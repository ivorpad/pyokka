import { describe, expect, it } from 'vitest';
import { renderProfile, summarizeProfile } from '../../web/profileSummary';

const frame = (functionName: string, lineNumber = 0) => ({ functionName, url: functionName.startsWith('(') ? '' : 'file:///w/a.js', lineNumber });

describe('summarizeProfile', () => {
  it('folds a V8 call tree into self and total time per function, counting recursion once', () => {
    // (root) > main > fib > fib, main > (garbage collector); samples 1 ms apart
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)', -1), children: [2] },
        { id: 2, callFrame: frame('main', 0), children: [3, 5] },
        { id: 3, callFrame: frame('fib', 4), children: [4] },
        { id: 4, callFrame: frame('fib', 4), children: [] },
        { id: 5, callFrame: frame('(garbage collector)', -1), children: [] },
      ],
      startTime: 0,
      endTime: 5000,
      samples: [2, 3, 4, 4, 5],
      timeDeltas: [0, 1000, 1000, 1000, 1000],
    };
    const s = summarizeProfile(profile);
    expect(s.totalMs).toBe(5);
    expect(s.rows).toEqual([
      { name: 'fib', file: '/w/a.js', line: 5, selfMs: 3, totalMs: 3 },
      { name: 'main', file: '/w/a.js', line: 1, selfMs: 1, totalMs: 5 },
    ]);
    const text = renderProfile(s, 'a.js', (f) => f.replace('/w/', ''));
    expect(text.split('\n')[2]).toMatch(/^\s+3\.00\s+3\.00\s+fib {2}a\.js:5$/);
  });

  it('says so when nothing was sampled', () => {
    expect(renderProfile(summarizeProfile({ nodes: [{ id: 1, callFrame: frame('(root)', -1) }] }), 'x.py', (f) => f)).toMatch(/no samples/);
  });
});
