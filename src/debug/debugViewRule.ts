/**
 * Which panel view a debug session opens on (docs/HANDOFF-debugger.md, 2026-10-16): wherever the
 * values are. A plain session (`record: false`) has them in the Debugger view's Frame section; a
 * session that records (`record`, or `recordFrom`, which implies it) has them in the Time Machine,
 * whose Details pane opens on the current step. `pyokka.showOutputOnStart` stays the switch that
 * says whether the panel is brought up at all; this only says where.
 *
 * Pure, so vitest covers it (test/unit/debugViewRule.test.ts). The two routes that apply it:
 * extension.ts on the registry's `sessionStarted` (plain sessions, the only kind the registry
 * holds), and views/debugPanel.ts on the first pause of a recording run, which is a run-all
 * `Session` in debug mode and never enters the registry.
 */
import type { ViewId } from '../shared/webviewProtocol';

/** `debug` is the Debugger view, `debugger` the Time Machine view (the panel's ids). */
export function initialDebugView(launch: { record: boolean; recordFrom?: string }): Extract<ViewId, 'debug' | 'debugger'> {
  return launch.record || !!launch.recordFrom ? 'debugger' : 'debug';
}

/**
 * The entries the Details pane opens on at a recording's pause: the ones stamped with `step`,
 * else the latest recorded ones before it (the frontier statement has not run, so a pause at a
 * function's entry has none of its own). `logId`s in recording order; none before the first
 * recorded step (`recordFrom`, before its first statement).
 */
export function currentStepEntries(entries: readonly { logId: string; step: number }[], step: number): string[] {
  let best = -1;
  for (const e of entries) if (e.step <= step && e.step > best) best = e.step;
  if (best < 0) return [];
  return entries.filter((e) => e.step === best).map((e) => e.logId);
}
