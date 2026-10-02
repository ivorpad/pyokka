/**
 * Recording from a pause over the bridge (`pyokka debug FILE --record-from X`, `pyokka record --live`):
 * the stop reply of a pause that came before the recording started, and the `record` request.
 *
 * A `recordFrom` run is a run-all session in debug mode whose trace starts at a pause. A pause
 * before that one has no trace to slice, and its stack is the frame chain a `record: false` pause
 * reports, so its reply is built the way a `record: false` stop is (`stopSlice`), from the
 * session's files and output instead of a debug session's.
 */
import type { Session } from '../session/session';
import type { PausedInfo } from '../session/debugState';
import { stopSlice } from '../debug/debugSessionState';
import { redact } from '../util/redact';
import { BridgeError, isStale, readSource } from './bridgeSupport';

/** The slice of a pause with no recording behind it yet: where it is, the block, the stack, the output so far. */
export function preRecordingSlice(session: Session, info: PausedInfo, opts: { scope?: boolean }): Record<string, unknown> {
  const st = session.state;
  const slice = stopSlice(
    {
      paused: info,
      pathForFileId: (fileId) => session.uriForFileId(fileId)?.fsPath,
      readSource: (fileId) => readSource(session, fileId),
      functionAt: (fileId, line) => st.files.functionAt(fileId, line),
      output: { text: redact(st.output), since: 'start', earlier: 0, seq: 0 },
      modified: session.debug.modified,
      staleReason: isStale(session) ? 'unsaved' : null,
      errors: [],
    },
    opts,
  );
  return { ...slice, recording: false };
}

/** The `watch` stream's payload for such a pause: the pause's own place, and no values (nothing was recorded). */
export function preRecordingPayload(session: Session): { location: unknown; values: unknown[] } {
  const p = session.debug.paused;
  if (!p) return { location: null, values: [] };
  const file = session.uriForFileId(p.fileId)?.fsPath ?? session.filePath;
  return { location: { file, line: p.line ?? 0, function: p.stack[0]?.name ?? '<module>', fileId: p.fileId }, values: [] };
}

/**
 * `record`: record from the current pause on. A session that records from the start answers
 * `already`; a `record: false` debug session cannot hold a recording and is refused by its socket.
 */
export async function recordHere(session: Session, waitForPause: (action: () => Promise<void>) => Promise<PausedInfo | 'finished'>): Promise<{ result: PausedInfo | 'finished' | undefined; already: boolean }> {
  const d = session.debug;
  if (!d.paused) {
    if (d.active && session.running) throw new BridgeError('cannot start recording: the program is running', '`pause --live` stops it at its next statement; `record --live` then records from there');
    throw new BridgeError('cannot start recording: no debug run is paused', 'start one with `pyokka debug FILE --record-from NAME`');
  }
  if (!session.debugCtl.recordFrom || session.trace) return { result: undefined, already: true };
  // the runtime announces the same pause again as step 0, with its recorded stack
  const result = await waitForPause(async () => {
    await session.debugCtl.record();
  });
  return { result, already: false };
}
