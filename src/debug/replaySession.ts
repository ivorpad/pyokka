/**
 * The Time Machine as a VS Code debug session in replay (docs/PROTOCOL.md, "Replay debug
 * session"): the `ReplaySource` the DAP translator reads a run-all session's recording through,
 * and the target of a replay of a finished run. The source moves the one Time Machine that the
 * panel, the Code Story and the agent bridge move, and it reports every move they make through
 * the session's `navChanged`, so the debug views and those three never disagree.
 */
import type { Session } from '../session/session';
import { atFrontier, decideMove } from '../session/debugState';
import { ReplayIndex, replayFrames, type ReplayVar } from '../session/replayFrames';
import type { TimeMachine } from '../timeMachine/navigator';
import type { DebugTarget, ReplayMove, ReplayOutcome, ReplaySource } from './debugTarget';

export function timeMachineReplay(session: Session, tm: TimeMachine): ReplaySource {
  // The recording the step indexes. A re-run (Auto Log switched on by the Time Machine, an edit, a
  // watch's Evaluate) replaces `session.state` with a run that has no trace yet; until it finishes
  // the Time Machine stays on the previous run's recording, so the debug views do too. A debug run
  // in flight is the exception: its partial trace is the recording the Time Machine sits in.
  const recorded = () => (session.running && !session.debug.active && session.previous?.trace ? session.previous : session.state);
  // the recorded values by scope, rebuilt when the run, its log or its recorded locals grew
  let cache: { key: string; index: ReplayIndex } | undefined;
  const index = (): ReplayIndex | undefined => {
    const st = recorded();
    const trace = st.trace;
    if (!trace) return undefined;
    const key = `${st.runId}:${trace.count}:${st.entries.length}:${st.locals.length}`;
    if (cache?.key !== key) cache = { key, index: new ReplayIndex(trace, st.locals, st.entries) };
    return cache.index;
  };
  const active = (): boolean => session.nav.active && !!recorded().trace && !session.isDisposed;
  return {
    get active() {
      return active();
    },
    get step() {
      return active() ? session.nav.currentStep : -1;
    },
    frames: () => {
      const trace = recorded().trace;
      return active() && trace ? replayFrames(trace, session.nav.currentStep) : [];
    },
    variables: (i): ReplayVar[] => (active() ? (index()?.frameVariables(session.nav.currentStep, i) ?? []) : []),
    move: (kind: ReplayMove): ReplayOutcome => {
      if (!active()) return 'none';
      // at the frontier of a paused debug run the program itself takes a forward step (navigator.ts)
      const executes = decideMove(session.debug, session.nav, kind) === 'execute';
      const moved = tm.move(session, kind);
      return executes ? 'executed' : moved ? 'moved' : 'none';
    },
    toBreakpoint: (backward): ReplayOutcome => {
      const trace = session.trace;
      if (!active() || !trace) return 'none';
      if (!backward && atFrontier(session.debug, session.nav)) {
        tm.runToBreakpoint(session, false);
        return 'executed';
      }
      const here = session.nav.currentStep;
      const targets = tm.breakpointTargets(session);
      let next = backward ? trace.runBackToBreakpoint(here, targets) : trace.runToBreakpoint(here, targets);
      // no breakpoint that way: to the end of the recording, which is the frontier of a paused run
      if (next < 0) next = backward ? 0 : (session.debug.paused?.step ?? trace.count - 1);
      next = trace.clamp(next);
      if (next === here) return 'none';
      tm.goto(session, next);
      return 'moved';
    },
    goto: (step) => tm.goto(session, step),
    onChanged: (fn) => {
      session.on('navChanged', fn);
      return () => session.off('navChanged', fn);
    },
  };
}

/**
 * A replay of a finished run as the translator's target: no program, so starting, pausing and
 * stepping a process do nothing or refuse, and Stop in the debug toolbar closes the Time Machine
 * unless `closesTimeMachine` says the replay is only giving way.
 */
export function wrapReplay(session: Session, tm: TimeMachine, opts: { closesTimeMachine?: () => boolean } = {}): DebugTarget {
  const refuse = (): Promise<never> => Promise.reject(new Error(`${session.displayName} is a replay of a finished run: debug the file to run it again`));
  return {
    id: session.key,
    kind: 'run',
    record: true,
    launch: undefined,
    replay: timeMachineReplay(session, tm),
    replayOnly: true,
    get displayName() {
      return session.displayName;
    },
    get debug() {
      return session.debug;
    },
    get running() {
      return session.running;
    },
    get output() {
      return session.state.output;
    },
    modified: false,
    thread: undefined,
    startDebug: () => Promise.resolve(),
    stopDebug: () => undefined,
    restart: () => Promise.resolve(),
    // Stop in the debug toolbar closes the Time Machine; a replay that gives way to a recording debug run leaves it open
    terminate: () => {
      if (opts.closesTimeMachine?.() ?? true) tm.stop(session);
    },
    debugContinue: refuse,
    debugStep: refuse,
    debugPause: refuse,
    debugLocals: () => Promise.resolve([]),
    evaluate: () => Promise.resolve(undefined),
    exec: refuse,
    complete: () => Promise.resolve({ prefix: '', items: [] }),
    expand: async (valueId, queryPath) => (session.state.runId ? session.runner.expand(session.state.runId, valueId, queryPath) : undefined),
    setDebugBreakpoints: () => Promise.resolve([]),
    setDebugWatches: () => Promise.resolve(),
    setDebugExceptions: () => Promise.resolve(),
    runToLine: refuse,
    pathForFileId: (fileId) => session.uriForFileId(fileId)?.fsPath,
    locate: (rid) => {
      const loc = session.files.locate(rid);
      return loc ? { path: loc.path, line: loc.range[0] } : undefined;
    },
    onPaused: () => () => undefined,
    onResumed: () => () => undefined,
    // the replay ends with the session; a re-run re-anchors the Time Machine and the replay follows it
    onFinished: (fn) => {
      const gone = (): void => fn(null);
      session.once('disposed', gone);
      return () => session.off('disposed', gone);
    },
    waitForPause: () => Promise.resolve('finished'),
  };
}
