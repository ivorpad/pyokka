import { describe, expect, it } from 'vitest';
import { formatRepr } from '../../src/shared/reprFormat';

describe('formatRepr', () => {
  it('keeps a value that fits on one line', () => {
    expect(formatRepr("[Line(sku='KB-01', qty=2)]", 80)).toBe("[Line(sku='KB-01', qty=2)]");
  });

  it('opens a group that does not fit, one item per line, and keeps inner groups that fit', () => {
    const text = "[Line(sku='MON-27', qty=1, unit_price='1,249.00'), Line(sku='CBL-02', qty=3, unit_price=7.5)]";
    expect(formatRepr(text, 60)).toBe(["[", "    Line(sku='MON-27', qty=1, unit_price='1,249.00'),", "    Line(sku='CBL-02', qty=3, unit_price=7.5)", ']'].join('\n'));
  });

  it('measures each group at its own indent', () => {
    const text = "Order(customer='Ben', lines=[Line(sku='MON-27', qty=1), Line(sku='CBL-02', qty=3)])";
    expect(formatRepr(text, 40)).toBe(
      ['Order(', "    customer='Ben',", '    lines=[', "        Line(sku='MON-27', qty=1),", "        Line(sku='CBL-02', qty=3)", '    ]', ')'].join('\n'),
    );
  });

  it('reads brackets, commas and escaped quotes inside a string as text', () => {
    const text = "Note(text='a, (b] \\'c', other=\"x, y\", n=1)";
    expect(formatRepr(text, 20)).toBe(['Note(', "    text='a, (b] \\'c',", '    other="x, y",', '    n=1', ')'].join('\n'));
  });

  it('keeps the comma of a one-item tuple and a dict as written', () => {
    expect(formatRepr('(1,)')).toBe('(1,)');
    expect(formatRepr("{'gold': 0.15, 'silver': 0.1}")).toBe("{'gold': 0.15, 'silver': 0.1}");
    expect(formatRepr('[]')).toBe('[]');
  });

  it('puts a cut tail after the last line and leaves the group the cut opened without a closer', () => {
    const text = "Order(customer='Ben', tier='silver', lines=[Line(sku='MON-27', qty=1), Line(sku='CBL-02', qty=3,…(+18 chars)";
    expect(formatRepr(text, 40)).toBe(
      ['Order(', "    customer='Ben',", "    tier='silver',", '    lines=[', "        Line(sku='MON-27', qty=1),", "        Line(sku='CBL-02', qty=3,…(+18 chars)"].join('\n'),
    );
    expect(formatRepr("'abc…'…(cut)")).toBe("'abc…'…(cut)");
  });
});
