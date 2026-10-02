/**
 * The wait for the next stop of a debug session: a pause, or the end of the program. Split out of
 * debugSession.ts so that file stays about the session; the bridge's stop replies and the e2e
 * suite's `waitForPause` both come through here.
 */

export interface Waiter<T> {
  resolve: (r: T) => void;
  timer: NodeJS.Timeout | undefined;
}

export class StopWaiters<T> {
  private waiters: Waiter<T>[] = [];

  /** The next result; rejects after `timeoutMs` (0 or less waits forever). */
  wait(timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, timer: undefined };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`${what} within ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  /** Give every waiter the same result and forget them. */
  settle(result: T): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve(result);
    }
  }
}
