import { describe, expect, it } from 'vitest';
import { scopeTop, storyBlockLines } from '../../src/session/storyLines';

/** `{line: step}` for the lines a block ran. */
const ran = (m: Record<number, number>): Map<number, number> => new Map(Object.entries(m).map(([l, s]) => [Number(l), s]));
/** `line` per entry, a gap as `…`, and a `*` on the lines the block ran. */
const shape = (entries: ReturnType<typeof storyBlockLines>): string =>
  entries.map((e) => (e.kind === 'gap' ? '…' : e.step === undefined ? String(e.line) : `${e.line}*`)).join(' ');
/** `n` lines of code, any line named in `blanks` empty. */
const file = (n: number, blanks: number[] = []): string[] => Array.from({ length: n }, (_, i) => (blanks.includes(i + 1) ? '' : `line ${i + 1}`));

// the probe of docs/design/code-story.md, in Python
const PROBE = [
  '# story probe', //             1
  'def pad(s, n):', //            2
  '    r = str(s)', //            3
  '', //                          4
  '    while len(r) < n:', //     5
  "        r = '0' + r", //       6
  '', //                          7
  '    return r', //              8
  '', //                          9
  'def twice(x):', //            10
  '    a = pad(x, 3)', //        11
  '    b = pad(x, 4)', //        12
  '    return a + b', //         13
  '', //                         14
  'items = [7, 42]', //          15
  '', //                         16
  'for it in items:', //         17
  '    out = twice(it)', //      18
  '    print(out)', //           19
];

describe('story block lines', () => {
  it('a pass through a function keeps two lines either side, inside the function', () => {
    // pad's first pass: `r = str(s)`, the `while` header and its body
    expect(shape(storyBlockLines(PROBE, ran({ 3: 2, 5: 3, 6: 4 }), { span: [1, 8] }))).toBe('1 2 3* 4 5* 6* 7 8');
  });

  it('a later turn of the loop lists no header: the def is simply out of the window (L5)', () => {
    expect(shape(storyBlockLines(PROBE, ran({ 5: 9, 6: 10 }), { span: [1, 8] }))).toBe('3 4 5* 6* 7 8');
  });

  it('context stops at the end of the scope', () => {
    expect(shape(storyBlockLines(file(40), ran({ 5: 1, 6: 2 }), { span: [4, 7] }))).toBe('4 5* 6* 7');
  });

  it("the span reaches the comment above the def, so a pass near the top lists it", () => {
    expect(shape(storyBlockLines(PROBE, ran({ 3: 2 }), { span: [1, 8] }))).toBe('1 2 3* 4 5');
    // without the comment the same pass starts at the def
    expect(shape(storyBlockLines(PROBE, ran({ 3: 2 }), { span: [2, 8] }))).toBe('2 3* 4 5');
  });

  it('a module block is clamped to the file', () => {
    expect(shape(storyBlockLines(PROBE, ran({ 19: 30 })))).toBe('17 18 19*');
    expect(shape(storyBlockLines(file(3), ran({ 1: 0, 3: 1 })))).toBe('1* 2 3*');
  });

  it('blank lines at the edges of the window go, blank lines between two listed lines stay (L3)', () => {
    const src = file(7, [2, 4, 5, 7]);
    // window 1-5: line 1 holds, lines 5 and 4 are blank edges and go; line 2 is interior and stays
    expect(shape(storyBlockLines(src, ran({ 3: 0 })))).toBe('1 2 3*');
    // window 4-7 is blank at both edges
    expect(shape(storyBlockLines(src, ran({ 6: 0 })))).toBe('6*');
  });

  it('the continuation lines of a multi-line statement are listed but not executed (L1)', () => {
    const src = ['x = foo(', '    1,', '    2,', ')', 'y = 2'];
    expect(shape(storyBlockLines(src, ran({ 1: 0, 5: 1 })))).toBe('1* 2 3 4 5*');
  });

  it('a short run of lines the block did not run is filled in as context', () => {
    expect(shape(storyBlockLines(file(12), ran({ 2: 0, 6: 1 })))).toBe('1 2* 3 4 5 6* 7 8');
  });

  it('a long run of them folds away', () => {
    expect(shape(storyBlockLines(file(30), ran({ 2: 0, 20: 1 })))).toBe('1 2* … 20* 21 22');
  });

  it('a block that ran nothing in this file has no lines', () => {
    expect(storyBlockLines(file(20), ran({}))).toEqual([]);
    expect(storyBlockLines([], ran({ 1: 0 }))).toEqual([]);
  });
});

describe('scope top', () => {
  it('walks up over the comments and decorators written directly above the def', () => {
    expect(scopeTop(PROBE, 2)).toBe(1);
    expect(scopeTop(PROBE, 10)).toBe(10);
    expect(scopeTop(['# a', '# b', '@cache', '@wraps(f)', 'def f():', '    pass'], 5)).toBe(1);
    // a blank line breaks the run
    expect(scopeTop(['# far above', '', '@cache', 'def f():', '    pass'], 4)).toBe(3);
  });
});
