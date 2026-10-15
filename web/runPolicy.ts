/**
 * Runs the bridge starts by itself, because the file changed on disk or the page changed a
 * setting. Nobody asked for them by name, so they wait while the live debugger has a run: one
 * would execute the program a second time, side effects included, beside the paused one. The
 * extension holds back the same kind of run (`IMPLICIT_RUN_REASONS`, src/session/debugState.ts).
 */
export const IMPLICIT_BRIDGE_RUNS: ReadonlySet<string> = new Set(['disk', 'settings']);

/** True when a run for `reason` must not start because a debug run is paused or running. */
export function blocksBridgeRun(debugging: boolean, reason: string): boolean {
  return debugging && IMPLICIT_BRIDGE_RUNS.has(reason);
}
