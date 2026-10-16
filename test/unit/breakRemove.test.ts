import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { removalMatches, removesLines, type BreakItem } from '../../src/agent/bridgeDebug';

// the module imports vscode for the gutter; the matching under test never touches it
vi.mock('vscode', () => ({}));

const pricing = path.resolve('/ws/shopkit/pricing.py');
const discounts = path.resolve('/ws/shopkit/discounts.py');
// `break pricing.py:13` lands on an `except` line: the gutter keeps 13, the runtime pauses at 15 and the listing says so
const gutter = { path: pricing, line: 13 };
const echo = [
  { path: pricing, line: 13, rid: 88, fileId: 2, resolvedLine: 15 },
  { path: discounts, line: 16, rid: 90, fileId: 3, resolvedLine: 16 },
];
const item = (line: number, p = pricing): BreakItem => ({ path: p, line });

describe('removalMatches', () => {
  it('removes a gutter breakpoint by the line asked for and by the line the runtime resolved it to', () => {
    expect(removalMatches(gutter, item(13), echo)).toBe(true);
    // the smoke run's case: `--remove pricing.py:15` after the listing showed `pricing.py:13  -> resolved line 15`
    expect(removalMatches(gutter, item(15), echo)).toBe(true);
    expect(removalMatches(gutter, item(14), echo)).toBe(false);
    expect(removalMatches(gutter, item(15, discounts), echo)).toBe(false);
    // another file's breakpoint does not go with it
    expect(removalMatches({ path: discounts, line: 16 }, item(15), echo)).toBe(false);
  });

  it('falls back to the gutter line when no run is in flight to say where a breakpoint landed', () => {
    expect(removalMatches(gutter, item(13), undefined)).toBe(true);
    expect(removalMatches(gutter, item(15), undefined)).toBe(false);
    expect(removalMatches(gutter, item(15), [])).toBe(false);
  });

  it('pairs line breakpoints only: a function breakpoint that resolved to the line is not this one', () => {
    expect(removalMatches(gutter, item(15), [{ function: 'subtotal', path: pricing, line: 13, resolvedLine: 15 }])).toBe(false);
  });
});

describe('removesLines', () => {
  it('is true only for remove items that carry a line', () => {
    expect(removesLines([{ file: 'pricing.py', line: 15 }])).toBe(true);
    expect(removesLines([{ function: 'subtotal' }, { file: 'pricing.py', line: '15' }])).toBe(true);
    expect(removesLines([{ function: 'subtotal' }])).toBe(false);
    expect(removesLines(undefined)).toBe(false);
    expect(removesLines('pricing.py:15')).toBe(false);
  });
});
