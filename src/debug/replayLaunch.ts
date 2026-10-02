/**
 * When the Time Machine's replay debug session opens and closes (docs/PROTOCOL.md, "Replay debug
 * session"): it follows every session's `navChanged`, whoever moved the Time Machine, starts a
 * `replay` launch the first time the Time Machine navigates a recording no debug session shows,
 * and ends it when the Time Machine closes. The adapter (dapAdapter.ts) registers itself here as
 * soon as VS Code creates it, before `launch`, so a burst of moves starts one session.
 */
import * as vscode from 'vscode';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { DEBUG_TYPE } from './dapShared';
import { log } from '../util/log';

/** the VS Code debug session replaying each Pyokka session's recording, while the Time Machine is open on a finished run */
export const replaying = new Map<Session, vscode.DebugSession>();
/** a replay launch was asked for and its adapter does not exist yet */
export const replayStarting = new Set<Session>();
/** replays being ended to make way for a recording debug run: the Time Machine stays open */
export const replayGivingWay = new Set<Session>();

/** Open and close the replay debug session with the Time Machine of every session, whoever moved it. */
export function followTimeMachine(mgr: SessionManager, shownElsewhere: (s: Session) => boolean): void {
  const follow = (s: Session): void => {
    s.on('navChanged', () => syncReplay(s, shownElsewhere));
    s.once('disposed', () => void stopReplay(s));
  };
  mgr.on('sessionStarted', follow);
  for (const s of mgr.all()) follow(s);
}

/**
 * The Time Machine opened or moved: start the replay debug session when no debug session shows
 * this recording yet. A recording debug run in flight (`debug.active`) or shown in a debug session
 * of its own already replays behind its frontier. The Time Machine closed: end the replay.
 */
function syncReplay(session: Session, shownElsewhere: (s: Session) => boolean): void {
  if (!session.nav.active || session.isDisposed) {
    void stopReplay(session);
    return;
  }
  if (replaying.has(session) || replayStarting.has(session) || shownElsewhere(session) || session.debug.active) return;
  replayStarting.add(session);
  void startReplay(session)
    .then(() => {
      // the Time Machine closed, or a debug session took the file, while the launch was on its way
      if (!session.nav.active || session.isDisposed) void stopReplay(session);
      else if (shownElsewhere(session) || session.debug.active) void stopReplay(session, { keepTimeMachine: true });
    })
    .catch((err) => log.warn(`[${session.displayName}] the replay debug session did not start: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => replayStarting.delete(session));
}

async function startReplay(session: Session): Promise<void> {
  const uri = session.document.uri;
  const config: vscode.DebugConfiguration = {
    type: DEBUG_TYPE,
    request: 'launch',
    name: `Pyokka Time Machine: ${session.displayName}`,
    program: uri.scheme === 'file' ? uri.fsPath : session.displayName,
    replay: session.key,
    internalConsoleOptions: 'neverOpen',
  };
  // no save before start: saving would re-run the file under On Save and move the step being shown
  const ok = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), config, { suppressSaveBeforeStart: true });
  if (!ok) throw new Error('VS Code refused the replay launch');
}

/** End the replay debug session of this session, if there is one; `keepTimeMachine` leaves the Time Machine open. */
export async function stopReplay(session: Session, opts: { keepTimeMachine?: boolean } = {}): Promise<void> {
  const shown = replaying.get(session);
  if (!shown) return;
  replaying.delete(session);
  if (!opts.keepTimeMachine) {
    await vscode.debug.stopDebugging(shown);
    return;
  }
  replayGivingWay.add(session);
  const ended = new Promise<void>((resolve) => {
    const sub = vscode.debug.onDidTerminateDebugSession((ds) => {
      if (ds !== shown) return;
      sub.dispose();
      resolve();
    });
  });
  try {
    await vscode.debug.stopDebugging(shown);
    // the disconnect reaches the adapter after stopDebugging resolves; the flag must outlive it
    await Promise.race([ended, new Promise((r) => setTimeout(r, 5000))]);
  } finally {
    replayGivingWay.delete(session);
  }
}
