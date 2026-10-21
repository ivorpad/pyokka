/**
 * Why Show Variable History and Why This Value have nothing to answer from when no Pyokka session
 * holds a recording: the debug session in front of the person keeps none. A plain launch
 * (`record: false`) and a module launch run without one, and an attach to a debugpy server has no
 * Pyokka recording at all (docs/design/debugpy-attach.md). Said instead of "no active session",
 * which sends someone who is debugging to start a different product.
 */
import * as vscode from 'vscode';
import { DEBUG_TYPE } from '../debug/dapAdapter';
import type { DebugSessionManager } from '../debug/debugSessionManager';

export function historyGapMessage(debugSessions: DebugSessionManager): string | undefined {
  const vs = vscode.debug.activeDebugSession;
  if (vs?.type === DEBUG_TYPE && vs.configuration.request === 'attach') {
    return 'Pyokka: an attached session records no history, so there is no variable history or Why for it. Launch the file with Pyokka instead: Debug Current File (Recording), or `pyokka debug FILE --record`.';
  }
  const ds = debugSessions.active();
  if (!ds || ds.launch.record) return undefined;
  if (ds.launch.module) {
    return 'Pyokka: a module launch cannot record, because a recording runs on a file, so there is no variable history or Why for it. Debug the file itself with Debug Current File (Recording), or `pyokka debug FILE --record`.';
  }
  return 'Pyokka: this debug session records nothing, so there is no variable history or Why for it. Debug Current File (Recording), or `pyokka debug FILE --record`, gets them. `--record-from NAME` records only from that pause on.';
}
