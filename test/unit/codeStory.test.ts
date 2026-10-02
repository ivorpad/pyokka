/**
 * The Code Story document, without vscode: the text `CodeStory` hands the content provider and the
 * dim/bright columns it paints. Rule ids are docs/design/code-story.md.
 */
import { describe, expect, it } from 'vitest';
import { renderStoryDocument, storyRowIndex, storyValueRow, storyValueWanted, type Span, type StoryBlockInput } from '../../src/session/storyLines';

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

const block = (over: Partial<StoryBlockInput> & Pick<StoryBlockInput, 'firstStepOfLine'>): StoryBlockInput => ({ fileId: 1, src: PROBE, ...over });
const ran = (m: Record<number, number>): Map<number, number> => new Map(Object.entries(m).map(([l, s]) => [Number(l), s]));
const bright = (m: Record<number, Span[]>): Map<number, Span[]> => new Map(Object.entries(m).map(([l, s]) => [Number(l), s]));

/** the module block that runs `items = [7, 42]`, then pad's first pass */
const TWO_BLOCKS: StoryBlockInput[] = [
  block({ firstStepOfLine: ran({ 15: 0 }), bright: bright({ 15: [[0, 15]] }) }),
  block({ firstStepOfLine: ran({ 3: 2, 5: 3, 6: 4 }), bright: bright({ 3: [[4, 14]], 5: [[4, 21]], 6: [[8, 20]] }), span: [1, 8] }),
];

describe('the story document', () => {
  it('opens with an empty row and puts one fold row between the blocks (D3, D4)', () => {
    expect(renderStoryDocument(TWO_BLOCKS).text).toBe(
      [
        '',
        '13      return a + b',
        '14',
        '15  items = [7, 42]',
        '16',
        '17  for it in items:',
        '    …',
        ' 1  # story probe',
        ' 2  def pad(s, n):',
        ' 3      r = str(s)',
        ' 4',
        ' 5      while len(r) < n:',
        " 6          r = '0' + r",
        ' 7',
        ' 8      return r',
        '',
      ].join('\n'),
    );
  });

  it('has no fold row before the first block or after the last, and no blank row between blocks (D3)', () => {
    const rows = renderStoryDocument(TWO_BLOCKS).text.split('\n');
    expect(rows.filter((r) => r.trim() === '…')).toHaveLength(1);
    expect(rows[0]).toBe('');
    // the only other empty row is the one the trailing newline leaves
    expect(rows.slice(1, -1).filter((r) => r === '')).toHaveLength(0);
  });

  it('numbers every listed row, right-aligned to the file, and leaves a blank source line bare (D4)', () => {
    const doc = renderStoryDocument([TWO_BLOCKS[1]!]);
    expect(doc.text.split('\n')[4]).toBe(' 4');
    expect(doc.lines[1]).toMatchObject({ kind: 'code', fileId: 1, sourceLine: 1, block: 0, prefixLength: 4, context: true });
    expect(doc.lines[3]).toMatchObject({ kind: 'code', sourceLine: 3, step: 2 });
  });

  it('dims every column outside the block’s step ranges (L6)', () => {
    const doc = renderStoryDocument([TWO_BLOCKS[1]!]);
    const dim = (row: number): Span[] | undefined => doc.lines[row]?.dim;
    // ' 3      r = str(s)': bright from the range's start column to its end column
    expect(dim(3)).toEqual([[0, 8]]);
    // the whole of a context row, the line number included
    expect(dim(2)).toEqual([[0, 18]]);
    // a blank row is its number and nothing else
    expect(dim(4)).toEqual([[0, 2]]);
    // the `while` header is bright from the keyword to the colon, so only the number stays dim
    expect(dim(5)).toEqual([[0, 8]]);
  });

  it('lights a multi-line statement to the end of its first line only', () => {
    const src = ['x = foo(', '    1,', ')', 'y = 2'];
    const doc = renderStoryDocument([{ fileId: 1, src, firstStepOfLine: ran({ 1: 0 }), bright: bright({ 1: [[0, 8]] }) }]);
    expect(doc.text).toBe(['', '1  x = foo(', '2      1,', '3  )', ''].join('\n'));
    expect(doc.lines[1]?.dim).toEqual([[0, 3]]);
    // the continuation lines carry no step and are dim end to end
    expect(doc.lines[2]).toMatchObject({ sourceLine: 2, context: true, dim: [[0, 9]] });
  });

  it('merges the ranges of several steps that start on one line', () => {
    const src = ['f(g(x), h)'];
    const doc = renderStoryDocument([{ fileId: 1, src, firstStepOfLine: ran({ 1: 0 }), bright: bright({ 1: [[0, 10], [2, 6]] }) }]);
    expect(doc.lines[1]?.dim).toEqual([[0, 3]]);
  });

  it('puts the walkthrough first, with a fold row under it', () => {
    const doc = renderStoryDocument([TWO_BLOCKS[0]!], { walkthrough: ['# Walkthrough: 2 moments over 9 steps', '#0  ran `items = [7, 42]`'] });
    expect(doc.text.split('\n').slice(0, 4)).toEqual(['', '# Walkthrough: 2 moments over 9 steps', '#0  ran `items = [7, 42]`', '    …']);
    expect(doc.lines[1]).toEqual({ kind: 'note' });
  });

  it('keeps a block whose source is missing as a note, and drops one with nothing to show', () => {
    const missing: StoryBlockInput = { fileId: 7, src: [], firstStepOfLine: ran({ 4: 1 }), note: 'lib.py (no source available)' };
    expect(renderStoryDocument([missing]).text).toBe(['', '# lib.py (no source available)', ''].join('\n'));
    expect(renderStoryDocument([{ fileId: 7, src: [], firstStepOfLine: ran({}) }]).text).toBe('\n');
  });

  it('marks the fold rows so the view can dim them', () => {
    const doc = renderStoryDocument(TWO_BLOCKS);
    const fold = doc.lines.find((l) => l.kind === 'gap');
    expect(fold).toEqual({ kind: 'gap', block: 1, prefixLength: 4, dim: [[0, 5]] });
  });
});

describe('story values (pyokka.story.values)', () => {
  const block = { firstStep: 10, lastStep: 20 };

  it("'all', the default, paints every entry the block's steps produced, whatever the current step", () => {
    expect(storyValueWanted('all', 12, block, 3)).toBe(true);
    expect(storyValueWanted('all', 12, block, undefined)).toBe(true);
    expect(storyValueWanted('all', 12, block, 99)).toBe(true);
    // never an entry from another block's steps
    expect(storyValueWanted('all', 9, block, 12)).toBe(false);
    expect(storyValueWanted('all', 21, block, 12)).toBe(false);
  });

  it("'asOf' hides what the run has not reached yet", () => {
    expect(storyValueWanted('asOf', 12, block, 12)).toBe(true);
    expect(storyValueWanted('asOf', 12, block, 15)).toBe(true);
    expect(storyValueWanted('asOf', 15, block, 12)).toBe(false);
    expect(storyValueWanted('asOf', 15, block, undefined)).toBe(true);
  });

  it("'step' is Quokka's rule: the current step only", () => {
    expect(storyValueWanted('step', 12, block, 12)).toBe(true);
    expect(storyValueWanted('step', 12, block, 13)).toBe(false);
    expect(storyValueWanted('step', 12, block, undefined)).toBe(false);
  });

  // a block whose statement on 5-8 was folded after line 6, and a second block listing 5 to 7 only
  const lines = [
    { kind: 'blank' as const },
    { kind: 'code' as const, block: 0, fileId: 1, sourceLine: 4, step: 10 },
    { kind: 'code' as const, block: 0, fileId: 1, sourceLine: 5, step: 11 },
    { kind: 'code' as const, block: 0, fileId: 1, sourceLine: 6, context: true },
    { kind: 'gap' as const, block: 0 },
    { kind: 'code' as const, block: 0, fileId: 1, sourceLine: 12, step: 12 },
    { kind: 'gap' as const, block: 1 },
    { kind: 'code' as const, block: 1, fileId: 1, sourceLine: 5, step: 30 },
    { kind: 'code' as const, block: 1, fileId: 1, sourceLine: 6, context: true },
    { kind: 'code' as const, block: 1, fileId: 1, sourceLine: 7, context: true },
  ];
  const rows = storyRowIndex(lines);

  it('sits at the end of its statement when the block lists that line', () => {
    expect(storyValueRow(lines, rows, 0, 1, [4, 0, 4, 9])).toBe(1);
    expect(storyValueRow(lines, rows, 0, 1, [12, 0, 12, 9])).toBe(5);
  });

  it('hangs off the fold row when the block folded the tail of the statement away', () => {
    expect(storyValueRow(lines, rows, 0, 1, [5, 0, 8, 1])).toBe(4);
  });

  it("sits on the statement's last listed row when the window cut the tail", () => {
    expect(storyValueRow(lines, rows, 1, 1, [5, 0, 8, 1])).toBe(9);
  });

  it('is placed in its own block, never in another block listing the same line', () => {
    expect(storyValueRow(lines, rows, 1, 1, [4, 0, 4, 9])).toBeUndefined();
    expect(storyValueRow(lines, rows, 1, 1, [5, 0, 5, 9])).toBe(7);
  });
});
