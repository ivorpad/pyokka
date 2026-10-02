/**
 * A run cut at the step cap (`maxTraceSteps`), said in words: the Time Machine's banner and the
 * bridge's `state.recording` use these, and `pyokka_runtime/agent/recording.py` says the same for
 * a saved run. Pure, so the webview can import it.
 */
import type { TraceCap, TraceSpent } from './protocol';

/** Workspace-relative, or from `site-packages/` on, or the path itself (as `display_path` in source.py). */
export function displayPath(p: string, workspaceRoot: string): string {
  for (const marker of ['site-packages/', 'dist-packages/', 'site-packages\\', 'dist-packages\\']) {
    const i = p.lastIndexOf(marker);
    if (i >= 0) return p.slice(i + marker.length);
  }
  const root = workspaceRoot.replace(/[\\/]+$/, '');
  if (root && (p.startsWith(root + '/') || p.startsWith(root + '\\'))) return p.slice(root.length + 1);
  return p;
}

/** What to exclude to leave a file out: its dotted module for a library file, its relative path otherwise. */
export function excludeFor(p: string, workspaceRoot: string): string {
  const shown = displayPath(p, workspaceRoot).replace(/\\/g, '/');
  const library = /[\\/](site|dist)-packages[\\/]/.test(p);
  if (library && shown.endsWith('.py')) {
    const parts = shown.slice(0, -3).split('/');
    if (parts[parts.length - 1] === '__init__') parts.pop();
    if (parts.length && parts.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) return parts.join('.');
  }
  return shown;
}

/** The cap with paths as the user reads them, and the exclude for the busiest file that is not the program. */
export function displayCap(cap: TraceCap, workspaceRoot: string, mainFile: string): TraceCap {
  const top = cap.spentBy.find((e) => e.path !== mainFile);
  const spentBy: TraceSpent[] = cap.spentBy.slice(0, 3).map((e) => ({ path: displayPath(e.path, workspaceRoot), steps: e.steps }));
  return { cap: cap.cap, ...(cap.stepsRun !== undefined ? { stepsRun: cap.stepsRun } : {}), spentBy, ...(top ? { exclude: excludeFor(top.path, workspaceRoot) } : {}) };
}

const n = (v: number): string => v.toLocaleString('en-US');

/** One sentence for the Time Machine: where it stopped, of how many, who spent the steps, what to do. */
export function capSentence(cap: TraceCap, kept: number): string {
  const total = cap.stepsRun !== undefined ? n(cap.stepsRun) : 'more';
  let s = `Recording stopped at step ${n(Math.max(0, kept - 1))}: the program ran ${total} steps and only the first ${n(kept)} are recorded (pyokka.maxTraceSteps is ${n(cap.cap)}).`;
  if (cap.spentBy.length) s += ` Most steps: ${cap.spentBy.map((e) => `${e.path} ${n(e.steps)}`).join(' · ')}.`;
  s += cap.exclude ? ` Add "${cap.exclude}" to pyokka.timeMachine.exclude to leave it out, or raise pyokka.maxTraceSteps.` : ' Raise pyokka.maxTraceSteps to record more.';
  return s;
}
