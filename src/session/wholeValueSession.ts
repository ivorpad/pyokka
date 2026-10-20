/**
 * "Whole value" for a session: what its current run kept, handed to the replay
 * (wholeValueReplay.ts). The panel (views/wholeValuePane.ts) and the agent bridge both ask here.
 */
import type { Session } from './session';
import type { WholeValueView } from '../shared/replayProtocol';
import { replayWholeValue, type ReplaySource, type WholeValueQuery } from './wholeValueReplay';
import { replayTimeout } from './wholeValue';

/** A replay waits at most this long when the session has no run timeout of its own. */
const DEFAULT_REPLAY_TIMEOUT_MS = 300_000;

export function sessionWholeValue(session: Session, query: WholeValueQuery): Promise<WholeValueView> {
  const st = session.state;
  const trace = session.trace;
  if (!trace) {
    const summary = session.running ? 'A run is in flight. Ask again when it finishes or pauses.' : 'No run yet: run the file first (save, or Re-execute).';
    return Promise.resolve({ key: query.key, status: 'unavailable', step: query.step, name: query.name, summary });
  }
  const src: ReplaySource = {
    runId: st.runId,
    request: st.request,
    steps: trace.steps,
    count: trace.count,
    scopeId: (step) => trace.scopeId(step),
    locals: st.locals,
    logs: st.entries,
    inputs: st.inputs,
    midRun: st.midRun,
    startedAt: st.startedAt,
    httpCount: st.http.length,
    running: session.running,
    paused: !!session.debug.paused,
    transport: !!session.launch?.transport,
    locate: (rid) => {
      const loc = st.files.locate(rid);
      return loc ? `${session.displayPath(loc.fileId)}:${loc.range[0]}` : `statement ${rid}`;
    },
    makeRunner: () => session.newSideRunner(),
    // the runtime stops the replay at twice the Run Timeout (replayTimeout); the host waits a little longer for its answer
    timeoutMs: replayTimeout(session.runTimeoutMs) > 0 ? replayTimeout(session.runTimeoutMs) + 10_000 : DEFAULT_REPLAY_TIMEOUT_MS,
  };
  return replayWholeValue(src, query);
}
