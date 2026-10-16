/** Where a debug session opens the panel (src/debug/debugViewRule.ts), and which entries the Details pane opens on at a recording's pause. */
import { describe, expect, it } from 'vitest';
import { currentStepEntries, initialDebugView } from '../../src/debug/debugViewRule';

describe('initialDebugView', () => {
  it('opens a plain session on the Debugger view and a recording one on the Time Machine', () => {
    // wherever the values are: the frame section for a plain session, the recording for the others
    expect(initialDebugView({ record: false })).toBe('debug');
    expect(initialDebugView({ record: true })).toBe('debugger');
    // `recordFrom` implies a recording, whatever `record` says
    expect(initialDebugView({ record: false, recordFrom: 'rrf' })).toBe('debugger');
    expect(initialDebugView({ record: true, recordFrom: 'demo.py:41' })).toBe('debugger');
  });
});

describe('currentStepEntries', () => {
  const entries = [
    { logId: 'l1', step: 3 },
    { logId: 'l2', step: 7 },
    { logId: 'l3', step: 7 },
    { logId: 'l4', step: 9 },
  ];
  it('takes the entries stamped with the step, else the latest recorded ones before it', () => {
    expect(currentStepEntries(entries, 7)).toEqual(['l2', 'l3']);
    // a pause at a function's entry: the frontier statement has not run, the previous step's values are the current ones
    expect(currentStepEntries(entries, 8)).toEqual(['l2', 'l3']);
    expect(currentStepEntries(entries, 100)).toEqual(['l4']);
  });
  it('selects nothing before the first recorded step (`recordFrom`, before its first statement)', () => {
    expect(currentStepEntries(entries, 2)).toEqual([]);
    expect(currentStepEntries([], 5)).toEqual([]);
  });
});
