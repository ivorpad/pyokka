/** The run's phase and the line the Variable and Why panes show beside their title (webview/inspection.ts). */
import { describe, expect, it } from 'vitest';
import { emptyEntriesText, inspectionLine, runPhase } from '../../../webview/inspection';
import type { DebuggerState } from '../../../src/shared/webviewProtocol';

const tm = (over: Partial<DebuggerState> = {}): DebuggerState => ({
  active: true,
  autoPlaying: false,
  currentStep: 59,
  canStep: { into: true, back: true, over: true, backOver: true, out: true, backOut: true },
  echoSteps: [],
  showCallStack: false,
  codePreview: false,
  echo: false,
  showGuide: false,
  watches: [],
  ...over,
});
const paused = (frontier: number, step: number): DebuggerState => tm({ currentStep: step, debug: { active: true, paused: true, frontier } });

describe('runPhase', () => {
  it('says paused for a run in flight whose program is paused, and never RUNNING over it', () => {
    expect(runPhase(true, paused(59, 59))).toBe('paused');
    expect(runPhase(true, tm({ debug: { active: true, paused: false } }))).toBe('running');
    expect(runPhase(true, null)).toBe('running');
    expect(runPhase(false, null)).toBe('idle');
    expect(emptyEntriesText('paused')).toBe('PAUSED');
    expect(emptyEntriesText('running')).toBe('RUNNING…');
    expect(emptyEntriesText('idle')).toBeUndefined();
  });
});

describe('inspectionLine', () => {
  it('puts the pause and the inspected step side by side', () => {
    expect(inspectionLine(paused(59, 59), true, 60)).toBe('Paused · inspecting step 59');
    expect(inspectionLine(paused(59, 12), true, 60)).toBe('Paused at step 59 · inspecting step 12');
    // a why tree inspects the step it explains, wherever the Time Machine is
    expect(inspectionLine(paused(59, 59), true, 60, 1)).toBe('Paused at step 59 · inspecting step 1');
    expect(inspectionLine(tm({ currentStep: 12 }), false, 81)).toBe('Replaying · step 12 of 81');
    expect(inspectionLine(tm({ currentStep: 12 }), false)).toBe('Replaying · step 12');
    expect(inspectionLine(tm({ currentStep: 12, debug: { active: true, paused: false } }), true, 81)).toBe('Running · inspecting step 12');
  });

  it('says nothing while no Time Machine is on: every view shows the last values then', () => {
    expect(inspectionLine(null, true)).toBeUndefined();
    expect(inspectionLine(tm({ active: false }), false, 81)).toBeUndefined();
  });
});
