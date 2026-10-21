/**
 * What the panel says about the run and the step a pane shows. A recording debug run that is
 * paused is still a run in flight (`session.running`), but nothing executes until it resumes, so
 * no view may say RUNNING over a pause. And a person who moved the Time Machine behind the pause
 * is looking at another step than the one the program stopped at, which the Variable and Why
 * panes say in one line: "Paused at step 59 · inspecting step 12".
 */
import type { DebuggerState } from './src-shared';

export type RunPhase = 'running' | 'paused' | 'idle';

/** Paused wins over running: the run is in flight, the program is not. */
export function runPhase(running: boolean, dbg: DebuggerState | null | undefined): RunPhase {
  if (dbg?.debug?.paused) return 'paused';
  return running ? 'running' : 'idle';
}

/** The empty Entries list's word: RUNNING… while a run executes, PAUSED at a pause, the list's own text otherwise. */
export function emptyEntriesText(phase: RunPhase): string | undefined {
  return phase === 'running' ? 'RUNNING…' : phase === 'paused' ? 'PAUSED' : undefined;
}

/**
 * The inspection line: the run's phase and the step a pane shows. `step` is that step (the Time
 * Machine's by default; a why tree passes the step it explains), `stepCount` the recording's
 * length. Undefined while no Time Machine is on: every view then shows the run's last values.
 */
export function inspectionLine(dbg: DebuggerState | null | undefined, running: boolean, stepCount?: number, step?: number): string | undefined {
  if (!dbg?.active) return undefined;
  const at = step ?? dbg.currentStep;
  if (dbg.debug?.paused) {
    const frontier = dbg.debug.frontier;
    return frontier === undefined || frontier === at ? `Paused · inspecting step ${at}` : `Paused at step ${frontier} · inspecting step ${at}`;
  }
  if (running) return `Running · inspecting step ${at}`;
  return stepCount ? `Replaying · step ${at} of ${stepCount}` : `Replaying · step ${at}`;
}
