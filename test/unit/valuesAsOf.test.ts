import { describe, expect, it } from 'vitest';
import type { LogEvent } from '../../src/shared/protocol';
import { asOfFooter, entriesAsOf, entryAsOf, finalEntry, inlineTextFor } from '../../src/session/valuesAsOf';

function entry(step: number, hit: number, text: string, extra: Partial<LogEvent> = {}): LogEvent {
  return { type: 'log', runId: 'r', seq: step, logId: `l${step}`, kind: 'autoLog', fileId: 1, rid: 7, hit, step, text, runtimeKey: '7', ...extra };
}

/**
 *  total = 0            step 10 → '0'
 *  for n in range(1, 4):
 *      total += n       steps 12, 27, 42 → '1', '3', '6'
 */
const loop = [entry(12, 1, '1'), entry(27, 2, '3'), entry(42, 3, '6')];

describe('entriesAsOf / entryAsOf', () => {
  it('keeps every entry, in step order, when the Time Machine is off', () => {
    expect(entriesAsOf([loop[2]!, loop[0]!, loop[1]!], undefined).map((e) => e.text)).toEqual(['1', '3', '6']);
    expect(finalEntry(loop)?.text).toBe('6');
  });

  it('stops at the current step', () => {
    expect(entriesAsOf(loop, 27).map((e) => e.text)).toEqual(['1', '3']);
    expect(entryAsOf(loop, 27)?.text).toBe('3');
  });

  it('carries the last value forward between hits', () => {
    expect(entryAsOf(loop, 30)?.text).toBe('3');
    expect(entryAsOf(loop, 12)?.text).toBe('1');
    expect(entryAsOf(loop, 99)?.text).toBe('6');
  });

  it('has nothing before the first hit', () => {
    expect(entriesAsOf(loop, 5)).toEqual([]);
    expect(entryAsOf(loop, 5)).toBeUndefined();
    expect(entryAsOf([], 5)).toBeUndefined();
  });

  it('breaks step ties by arrival', () => {
    const a = entry(20, 1, 'first', { seq: 1, logId: 'a' });
    const b = entry(20, 1, 'second', { seq: 2, logId: 'b' });
    expect(entryAsOf([b, a], 20)?.text).toBe('second');
  });
});

describe('inlineTextFor: the decoration text at each step of the loop', () => {
  it('shows the loop variable as of each step', () => {
    expect(inlineTextFor(entriesAsOf(loop, 12)).text).toBe('1');
    expect(inlineTextFor(entriesAsOf(loop, 27)).text).toBe('×2 3');
    expect(inlineTextFor(entriesAsOf(loop, 42)).text).toBe('×3 6');
    expect(inlineTextFor(entriesAsOf(loop, undefined))).toEqual({ text: '×3 6', kind: 'log' });
  });

  it('counts hits from the entry when the log limit dropped earlier ones', () => {
    expect(inlineTextFor([entry(42, 3, '6')]).text).toBe('×3 6');
  });

  it('renders error and system kinds, and timings without a hit count', () => {
    expect(inlineTextFor([entry(3, 1, 'boom', { kind: 'error' })])).toEqual({ text: 'boom', kind: 'error' });
    expect(inlineTextFor([entry(3, 2, 'log limit reached', { kind: 'system' })])).toEqual({ text: '×2 log limit reached', kind: 'system' });
    expect(inlineTextFor([entry(3, 1, '', { kind: 'time', time: { n: 1, total: 1.5, min: 1.5, max: 1.5 } })])).toEqual({ text: '1.500ms', kind: 'log' });
    expect(inlineTextFor([entry(3, 2, '', { kind: 'time', time: { n: 2, total: 3, min: 1, max: 2 } })]).text).toBe('Σ 3.000ms, μ 1.500ms, ⋀ 1.000ms, ⋁ 2.000ms, n 2');
  });

  it('collapses a multi-line value to one line', () => {
    expect(inlineTextFor([entry(3, 1, '[\n  1,\n  2\n]')]).text).toBe('[ 1, 2 ]');
  });
});

describe('asOfFooter', () => {
  const final = finalEntry(loop);

  it('says nothing when the Time Machine is off', () => {
    expect(asOfFooter(entryAsOf(loop, undefined), final, undefined)).toBeUndefined();
  });

  it('names the step and the final value when it differs', () => {
    expect(asOfFooter(entryAsOf(loop, 27), final, 27)).toBe('*as of step 27; final:* `6`');
    expect(asOfFooter(entryAsOf(loop, 30), final, 30)).toBe('*as of step 30; final:* `6`');
  });

  it('drops the final value once it is the current one', () => {
    expect(asOfFooter(entryAsOf(loop, 42), final, 42)).toBe('*as of step 42*');
    expect(asOfFooter(entryAsOf(loop, 50), final, 50)).toBe('*as of step 50*');
  });

  it('says the range has not run yet before the first hit', () => {
    expect(asOfFooter(entryAsOf(loop, 5), final, 5)).toBe('*not run yet as of step 5; final:* `6`');
    expect(asOfFooter(undefined, undefined, 5)).toBeUndefined();
  });

  it('keeps the final value on one line inside a code span that survives backticks', () => {
    const f = entry(9, 1, 'a `quoted`\nvalue');
    expect(asOfFooter(entry(2, 1, 'x'), f, 2)).toBe('*as of step 2; final:* ``a `quoted` value``');
    const edge = entry(9, 1, '`x`');
    expect(asOfFooter(entry(2, 1, 'x'), edge, 2)).toBe('*as of step 2; final:* `` `x` ``');
    const long = entry(9, 1, 'y'.repeat(300));
    expect(asOfFooter(entry(2, 1, 'x'), long, 2)).toBe(`*as of step 2; final:* \`${'y'.repeat(119)}…\``);
  });
});
