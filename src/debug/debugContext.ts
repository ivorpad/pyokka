/**
 * `pyokka.debugActive` and `pyokka.debugPaused` are the union of both products, and two writers to
 * one `setContext` key race: a debug session ending would clear the key while a recording run is
 * paused. So each half reports here (`DebugController` for run-all, `DebugSessionManager` for the
 * Debugger) and this module is the only writer.
 */
import { setContext } from '../util/context';

export interface DebugHalf {
  active: boolean;
  paused: boolean;
}

const state: { runAll: DebugHalf; session: DebugHalf } = {
  runAll: { active: false, paused: false },
  session: { active: false, paused: false },
};

/** Report one half; the keys become the union of both. */
export function updateDebugContext(patch: { runAll?: DebugHalf; session?: DebugHalf }): void {
  if (patch.runAll) state.runAll = patch.runAll;
  if (patch.session) state.session = patch.session;
  setContext('debugActive', state.runAll.active || state.session.active);
  setContext('debugPaused', state.runAll.paused || state.session.paused);
}

/** What the keys say now (tests, and the status bar's "which session" rule). */
export function debugContext(): { active: boolean; paused: boolean } {
  return { active: state.runAll.active || state.session.active, paused: state.runAll.paused || state.session.paused };
}

/** A fresh window (the e2e suite reactivates the extension in one process). */
export function resetDebugContext(): void {
  state.runAll = { active: false, paused: false };
  state.session = { active: false, paused: false };
}
