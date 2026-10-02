import { describe, expect, it } from 'vitest';
import { memberChainAt, identifierAt } from '../../src/util/text';

describe('memberChainAt', () => {
  it('expands to the chain ending at the identifier under the cursor', () => {
    const line = 'total = a.b.c + 1';
    expect(memberChainAt(line, line.indexOf('b'))?.text).toBe('a.b');
    expect(memberChainAt(line, line.indexOf('c'))?.text).toBe('a.b.c');
    expect(memberChainAt(line, line.indexOf('a.'))?.text).toBe('a');
    expect(memberChainAt(line, 0)?.text).toBe('total');
  });

  it('keeps calls and subscripts that belong to the chain', () => {
    const line = 'x = obj.get(1)[0].name.upper()';
    // the identifier plus every directly attached call / subscript group
    expect(memberChainAt(line, line.indexOf('get'))?.text).toBe('obj.get(1)[0]');
    expect(memberChainAt(line, line.indexOf('name'))?.text).toBe('obj.get(1)[0].name');
    expect(memberChainAt(line, line.indexOf('upper'))?.text).toBe('obj.get(1)[0].name.upper()');
  });

  it('handles the cursor right after the identifier and returns undefined elsewhere', () => {
    expect(memberChainAt('foo.bar', 7)?.text).toBe('foo.bar');
    expect(memberChainAt('a = (1, 2)', 4)).toBeUndefined();
    expect(identifierAt('  ', 1)).toBeUndefined();
  });

  it('does not cross whitespace-separated tokens except around dots', () => {
    expect(memberChainAt('print(self.x)', 8)?.text).toBe('self');
    expect(memberChainAt('print(self.x)', 11)?.text).toBe('self.x');
    expect(memberChainAt('self . x', 7)?.text).toBe('self . x');
  });
});
