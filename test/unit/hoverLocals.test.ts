import { describe, expect, it } from 'vitest';
import { localFooter, localOwner, pickLocal } from '../../src/features/hoverLocals';
import type { VariableChange } from '../../src/shared/protocol';

const row = (o: Partial<VariableChange>): VariableChange => ({ step: 0, file: '/f.py', fileId: 1, line: 1, function: 'f', scopeId: 1, name: 'x', source: 'locals', ...o });

describe('pickLocal', () => {
  const changes = [
    row({ step: 2, text: '1', line: 3 }),
    row({ step: 5, text: '2', line: 4 }),
    row({ step: 7, source: 'assign', line: 5 }), // the statement ran, nothing recorded the value
    row({ step: 9, text: '9', scopeId: 2 }), // a later call of the same function
    row({ step: 3, text: 'g', scopeId: 0, function: '<module>', name: 'x' }), // a module-level x
    row({ step: 4, text: 'p', name: 'x.y' }), // a path under the name
  ];

  it('takes the last change that carries a value off the Time Machine', () => {
    expect(pickLocal('x', changes)?.text).toBe('9');
  });

  it('while navigating: at or before the step, inside the current call or the module', () => {
    expect(pickLocal('x', changes, { step: 4, scopes: new Set([1, 0]) })?.text).toBe('g'); // the module x at 3 is later than the local at 2
    expect(pickLocal('x', changes, { step: 2, scopes: new Set([1, 0]) })?.text).toBe('1');
    expect(pickLocal('x', changes, { step: 6, scopes: new Set([1, 0]) })?.text).toBe('2');
    expect(pickLocal('x', changes, { step: 9, scopes: new Set([2, 0]) })?.text).toBe('9');
    expect(pickLocal('x', changes, { step: 1, scopes: new Set([1, 0]) })).toBeUndefined();
    expect(pickLocal('x', changes, { step: 9, scopes: new Set([3]) })).toBeUndefined(); // another call: not this one's value
  });

  it('ignores other names and rows without a value', () => {
    expect(pickLocal('y', changes)).toBeUndefined();
    expect(pickLocal('x', [row({ step: 7, source: 'assign' })])).toBeUndefined();
  });
});

describe('localFooter and localOwner', () => {
  it('names the step, the function and the line, recorded or logged', () => {
    expect(localFooter(row({ step: 41, function: 'reciprocal_rank', line: 25 }), true)).toBe('*as of step 41 · recorded in reciprocal_rank, line 25*');
    expect(localFooter(row({ step: 41, function: 'reciprocal_rank', line: 25, source: 'value' }), false)).toBe('*last change at step 41 · logged in reciprocal_rank, line 25*');
  });

  it('knows which function a name belongs to', () => {
    expect(localOwner('x', [row({ function: '<module>' }), row({ function: 'f', source: 'assign' })])).toBe('f');
    expect(localOwner('x', [row({ function: '<module>' })])).toBeUndefined();
  });
});
