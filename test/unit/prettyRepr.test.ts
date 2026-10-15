/** The paused-value hover lays a long repr out the way pprint does. */
import { describe, expect, it } from 'vitest';
import { prettyRepr } from '../../web/pausedValues';

describe('prettyRepr', () => {
  it('keeps a short value on one line', () => {
    expect(prettyRepr("[('C', 0.03), ('A', 0.02)]")).toBe("[('C', 0.03), ('A', 0.02)]");
  });

  it('puts one tuple per line when the list is too wide, aligned after the bracket', () => {
    const text = '[' + ['C', 'A', 'B', 'D'].map((k, i) => `('${k}', 0.0325918273645${i})`).join(', ') + ']';
    expect(prettyRepr(text)).toBe(
      "[('C', 0.03259182736450),\n ('A', 0.03259182736451),\n ('B', 0.03259182736452),\n ('D', 0.03259182736453)]",
    );
  });

  it('indents a nested dict under its key and leaves commas and brackets inside strings alone', () => {
    const text = "{'name': 'a, [b]', 'scores': {'math': [90, 85, 77], 'art': [60, 70, 80]}, 'tags': ['x', 'y', 'z', 'w']}";
    expect(prettyRepr(text, 40)).toBe(
      "{'name': 'a, [b]',\n 'scores': {'math': [90, 85, 77],\n            'art': [60, 70, 80]},\n 'tags': ['x', 'y', 'z', 'w']}",
    );
  });

  it('returns a cut repr unchanged', () => {
    const cut = '[' + '1, '.repeat(40) + '...';
    expect(prettyRepr(cut)).toBe(cut);
  });
});
