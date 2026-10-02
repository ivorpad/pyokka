import { describe, expect, it, vi } from 'vitest';
import { enclosingStart, namesOnLines } from '../../src/debug/debugInlineValues';

// the module registers a provider with vscode; the helpers under test never touch it
vi.mock('vscode', () => ({}));
vi.mock('../../src/debug/dapAdapter', () => ({ DEBUG_TYPE: 'pyokka' }));

const SRC = [
  'import os',                                  // 0
  'LIMIT = 3',                                  // 1
  '',                                           // 2
  'class Ranker:',                              // 3
  '    def rank(self, docs, k=60):',            // 4
  '        scores = {}  # name in a comment',   // 5
  '        for rank, doc in enumerate(docs):',  // 6
  '            if doc.id not in scores:',       // 7
  "                scores[doc.id] = 1 / (k + rank)",  // 8
  "        print('total', total, sep=',')",     // 9
];

describe('enclosingStart', () => {
  it('finds the def of a method, whatever blocks sit between', () => {
    expect(enclosingStart(SRC, 8)).toBe(4);
    expect(enclosingStart(SRC, 5)).toBe(4);
  });
  it('gives a window above a module-level stop', () => {
    expect(enclosingStart(SRC, 1)).toBe(0);
    expect(enclosingStart(['for i in range(3):', '    x = i'], 1)).toBe(0);
  });
});

describe('namesOnLines', () => {
  const names = (first: number, last: number) => namesOnLines(SRC, first, last).map((n) => `${n.line}:${n.name}`);
  it('names variables and skips keywords, attributes, comments, strings, keyword arguments and the defined name', () => {
    expect(names(4, 9)).toEqual([
      '4:docs', '4:k',
      '5:scores',
      '6:rank', '6:doc', '6:docs',
      '7:doc', '7:scores',
      '8:scores', '8:doc', '8:k', '8:rank',
      '9:total',
    ]);
  });
  it('keeps the columns of the name as written', () => {
    const [scores] = namesOnLines(SRC, 5, 5);
    expect(SRC[5]?.slice(scores?.start, scores?.end)).toBe('scores');
  });
});
