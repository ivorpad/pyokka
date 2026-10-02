/**
 * Promises over a session's status (the `PyokkaApi` of the e2e suite): settle once the current run
 * has finished, or once the next run has started and finished.
 */
import type { Session } from './session';

/** Resolves when no run is in flight and one has finished (immediately when idle); rejects after `timeoutMs`. */
export function waitForIdle(session: Session, timeoutMs = 30000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const idle = (): boolean => !session.running && session.state.finished !== undefined;
    if (idle()) return resolve();
    const handler = (): void => {
      if (idle()) {
        clearTimeout(timer);
        session.off('statusChanged', handler);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      session.off('statusChanged', handler);
      reject(new Error('run did not finish in time'));
    }, timeoutMs);
    session.on('statusChanged', handler);
  });
}

/** Resolves when the next run (or the one in flight) has finished; rejects after `timeoutMs`. */
export function waitForNextRun(session: Session, timeoutMs = 30000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let started = session.running;
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      session.off('statusChanged', handler);
      ok ? resolve() : reject(new Error('run did not happen in time'));
    };
    const handler = (): void => {
      if (session.running) started = true;
      else if (started && session.state.finished !== undefined) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    session.on('statusChanged', handler);
  });
}
