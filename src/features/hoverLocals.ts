/**
 * A hover on a bare name that no entry at that spot answers: the value the run recorded for the
 * name, from the variable history (recorded locals, or a value logged under the name elsewhere).
 * Pure; the provider (valuePeek.ts) fetches the history and knows the Time Machine's step.
 */
import type { VariableChange } from '../shared/protocol';

export interface LocalAt {
  /** the Time Machine's step: only changes at or before it count */
  step: number;
  /** the scopes whose changes are in view at that step: the current call and the module (globals) */
  scopes: ReadonlySet<number>;
}

/**
 * The latest change of `name` that carries a value: at or before `at.step` and inside one of
 * `at.scopes` while navigating (a local of another call of the same function is not this call's
 * value), the run's last change otherwise. Rows without a recorded value (`assign`: the statement
 * ran, nothing recorded what it bound) and rows for paths under the name never answer.
 */
export function pickLocal(name: string, changes: readonly VariableChange[], at?: LocalAt): VariableChange | undefined {
  let best: VariableChange | undefined;
  for (const c of changes) {
    if (c.name !== name || c.text === undefined) continue;
    if (at && (c.step > at.step || !at.scopes.has(c.scopeId))) continue;
    if (!best || c.step >= best.step) best = c;
  }
  return best;
}

/** `*as of step 41 · recorded in reciprocal_rank, line 25*`, or `*last change at step 41 · …*` off the Time Machine. */
export function localFooter(change: VariableChange, navigating: boolean): string {
  const where = `${change.source === 'locals' ? 'recorded' : 'logged'} in ${change.function}, line ${change.line}`;
  return navigating ? `*as of step ${change.step} · ${where}*` : `*last change at step ${change.step} · ${where}*`;
}

/** The function a name belongs to, when the history knows it as something other than a module-level name. */
export function localOwner(name: string, changes: readonly VariableChange[]): string | undefined {
  return changes.find((c) => c.name === name && c.function !== '<module>')?.function;
}
