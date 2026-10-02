/**
 * The watch expressions of a session: add, remove, edit, refresh, and the value each one shows at
 * the Time Machine's current step. Where that value comes from depends on where the step is: the
 * live frame at a paused debug run's frontier, a run of the file in Automatic mode, and outside it
 * the finished child at the last step, then the run's recorded variables, then a row that offers
 * one run. `TimeMachine` owns the instance and forwards the public methods (navigator.ts).
 */
import type { Range4, VariableHistory } from '../shared/protocol';
import { sessionVariableHistory } from '../session/variableQuery';
import { pickLocal } from '../features/hoverLocals';
import type { DebuggerState } from '../shared/webviewProtocol';
import type { Session } from '../session/session';
import type { Decorator } from '../decorations/decorator';
import type { TimeMachineSink } from './navigator';
import { atFrontier } from '../session/debugState';
import { log } from '../util/log';

export class Watches {
  private sink: TimeMachineSink | undefined;
  /** variable histories behind watches outside Automatic mode, per session, run and name */
  private readonly histories = new Map<string, Promise<VariableHistory | undefined>>();
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly decorator: Decorator) {}

  setSink(sink: TimeMachineSink): void {
    this.sink = sink;
  }

  dispose(): void {
    for (const t of this.watchTimers.values()) clearTimeout(t);
  }

  addWatch(session: Session, exp: string, range?: Range4, fileId?: number): void {
    const trimmed = exp.trim();
    if (!trimmed) return;
    if (session.watches.some((w) => w.exp === trimmed)) return;
    session.addWatch(trimmed, range, fileId);
    this.requestWatchWindow(session, true);
    this.decorator.refreshSession(session);
    this.sink?.pushDebugger(session);
  }

  removeWatch(session: Session, id: string): void {
    if (!session.removeWatch(id)) return;
    this.decorator.refreshSession(session);
    this.sink?.pushDebugger(session);
  }

  refreshWatch(session: Session, id: string): void {
    const w = session.watches.find((x) => x.id === id);
    if (!w) return;
    w.values.clear();
    this.requestWatchWindow(session, true);
  }

  /** Change a watch's expression in place: it is re-evaluated at the current step (in the paused frame at the frontier). */
  editWatch(session: Session, id: string, exp: string): void {
    const w = session.watches.find((x) => x.id === id);
    const trimmed = exp.trim();
    if (!w || !trimmed || trimmed === w.exp) return;
    if (session.watches.some((x) => x.id !== id && x.exp === trimmed)) {
      this.removeWatch(session, id); // the new text already has a watch: this one folds into it
      return;
    }
    w.exp = trimmed;
    w.range = undefined;
    w.fileId = undefined;
    w.values.clear();
    this.requestWatchWindow(session, true);
    this.decorator.refreshSession(session);
    this.sink?.pushDebugger(session);
  }

  /** The Time Machine moved: ask for the values this step is missing, after a short settle. */
  scheduleWatchWindow(session: Session): void {
    if (!session.watches.length) return;
    const step = session.nav.currentStep;
    const missing = session.watches.some((w) => !w.values.has(step));
    if (!missing) {
      this.sink?.pushDebugger(session);
      return;
    }
    const prev = this.watchTimers.get(session.key);
    if (prev) clearTimeout(prev);
    this.watchTimers.set(
      session.key,
      setTimeout(() => {
        this.watchTimers.delete(session.key);
        this.requestWatchWindow(session, false);
      }, 120),
    );
  }

  private requestWatchWindow(session: Session, force: boolean): void {
    if (!session.nav.active || session.isDisposed) return;
    if (atFrontier(session.debug, session.nav)) {
      void this.evaluateWatchesAtFrontier(session);
      return;
    }
    const step = session.nav.currentStep;
    if (!force && session.nav.requestedStep !== undefined && step >= session.nav.requestedStep && step <= session.nav.requestedStep + session.nav.prefetch && session.running) return;
    session.nav.requestedStep = step;
    session.setTraceContext({ step, prefetch: session.nav.prefetch });
    if (!session.implicitRunsAllowed) {
      // no run for a watch outside Automatic mode: what the run already knows answers now, the
      // rest arrives with the next explicit run (the trace context is part of the request)
      void this.evaluateWatchesWithoutRun(session, step);
      session.scheduleImplicitRun('watch');
      return;
    }
    void session.runNow('watch').catch((err) => log.error('watch run failed', err));
  }

  /** Watches at the frontier evaluate in the paused frame, never through a re-run. */
  private async evaluateWatchesAtFrontier(session: Session): Promise<void> {
    const step = session.nav.currentStep;
    for (const w of session.watches) {
      if (w.values.has(step)) continue;
      const ev = await session.evaluateLive(w.exp);
      if (!atFrontier(session.debug, session.nav) || session.nav.currentStep !== step) return;
      w.values.set(step, ev ? { valueBag: ev.valueBag, text: ev.text } : { error: 'not evaluable at the paused statement (calls are refused; the name may not be in scope)' });
    }
    this.sink?.pushDebugger(session);
  }

  /**
   * On Save / On Demand: at the run's last step the finished child evaluates the expression (the
   * final namespace is the state at that step); behind it a bare name answers from the run's
   * recorded variables as of the step, with a note saying where it was recorded; anything else
   * waits for the next explicit run and says so.
   */
  private async evaluateWatchesWithoutRun(session: Session, step: number): Promise<void> {
    const trace = session.trace;
    const last = trace ? trace.count - 1 : -1;
    const moved = (): boolean => session.isDisposed || !session.nav.active || session.nav.currentStep !== step;
    for (const w of session.watches) {
      if (w.values.has(step)) continue;
      if (step === last) {
        const ev = await session.evaluateLive(w.exp);
        if (moved()) return;
        if (ev) {
          w.values.set(step, { valueBag: ev.valueBag, text: ev.text });
          continue;
        }
      }
      if (trace && /^[A-Za-z_]\w*$/.test(w.exp)) {
        const history = await this.recordedHistory(session, w.exp);
        if (moved()) return;
        const change = history ? pickLocal(w.exp, history.changes, { step, scopes: new Set([trace.scopeId(step), 0]) }) : undefined;
        if (change?.text !== undefined) {
          w.values.set(step, { text: change.text, note: `as of step ${change.step}, ${change.source === 'locals' ? 'recorded' : 'logged'} in ${change.function}, line ${change.line}` });
          continue;
        }
      }
      // the recording has the steps, the logged values and the locals' text, not this expression at
      // this step: one run of the file records it (the row offers it), except while a debug run is
      // paused, when no run can start and only the frontier evaluates live
      if (session.debug.paused) w.values.set(step, { error: 'not recorded at this step; the paused frame evaluates it at the frontier' });
      else w.values.set(step, { error: 'not recorded at this step', needsRun: true });
    }
    this.sink?.pushDebugger(session);
  }

  /** The row's "Evaluate" action outside Automatic mode: one run of the file, recording the watches around the current step. */
  evaluateWatchNow(session: Session, id: string): void {
    if (!session.nav.active || session.isDisposed || session.running || !session.watches.some((w) => w.id === id)) return;
    // a finished debug run leaves debug mode on until something ends it; this run is a plain recording one, not a paused debug run
    if (session.debug.active) session.stopDebug();
    const step = session.nav.currentStep;
    for (const w of session.watches) {
      const v = w.values.get(step);
      if (v?.needsRun) w.values.delete(step);
    }
    session.nav.requestedStep = step;
    session.setTraceContext({ step, prefetch: session.nav.prefetch });
    this.sink?.pushDebugger(session);
    void session.runNow('watch').catch((err) => log.error('watch run failed', err));
  }

  /** The variable history of a name, computed once per run (the hover computes the same). */
  private recordedHistory(session: Session, name: string): Promise<VariableHistory | undefined> {
    const key = `${session.key}|${session.state.runId}|${name}`;
    let p = this.histories.get(key);
    if (!p) {
      if (this.histories.size > 200) this.histories.clear();
      p = sessionVariableHistory(session, name, { limit: 100_000 }).catch(() => undefined);
      this.histories.set(key, p);
    }
    return p;
  }

  /** The watch rows for the panel at `step`: the value recorded there, else the last one before it. */
  panelRows(session: Session, step: number): DebuggerState['watches'] {
    return session.watches.map((w) => {
      const exact = w.values.get(step);
      if (exact) return { id: w.id, exp: w.exp, valueBag: exact.valueBag, text: exact.valueBag ? undefined : exact.text, note: exact.note, error: exact.error, needsRun: exact.needsRun, step };
      let bestStep = -1;
      for (const s of w.values.keys()) if (s <= step && s > bestStep) bestStep = s;
      const near = bestStep >= 0 ? w.values.get(bestStep) : undefined;
      return { id: w.id, exp: w.exp, valueBag: near?.valueBag, text: near?.valueBag ? undefined : near?.text, note: near?.note, error: near?.error, needsRun: near?.needsRun, step: bestStep >= 0 ? bestStep : undefined };
    });
  }
}
