/**
 * Host side of "Whole value" in the Variable pane and the Why tree: one replay per click, one at a
 * time per panel, answered with `wholeValue` under the pane's key. A new run drops every answer
 * (`wholeValue.reset`): a copy belongs to the run it was replayed against.
 */
import type { Session } from '../session/session';
import { sessionWholeValue } from '../session/wholeValueSession';
import type { HostToWebview, WebviewToHost } from '../shared/webviewProtocol';
import { log } from '../util/log';

type Query = Extract<WebviewToHost, { type: 'wholeValue.query' }>;

export class WholeValueHost {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly post: (session: Session, msg: HostToWebview) => void) {}

  /** Another run started (or the panel bound another session): the copies it shows are of an older run. */
  reset(session: Session): void {
    this.post(session, { type: 'wholeValue.reset' });
  }

  query(session: Session, msg: Query): Promise<void> {
    const runId = session.state.runId;
    this.post(session, { type: 'wholeValue', view: { key: msg.key, status: 'pending', step: msg.step, name: msg.name, summary: 'Replaying the run in a separate process…' } });
    // replays one after another: each starts a runner and runs the program up to its step
    const next = this.queue.then(async () => {
      const view = await sessionWholeValue(session, { key: msg.key, kind: msg.kind, step: msg.step, name: msg.name, scopeId: msg.scopeId, text: msg.text });
      if (session.isDisposed || session.state.runId !== runId) return; // a newer run reset the pane
      log.info(`[${session.displayName}] whole value ${msg.name} at #${view.step}: ${view.status}${view.ms !== undefined ? ` in ${view.ms} ms` : ''}`);
      this.post(session, { type: 'wholeValue', view });
    });
    this.queue = next.catch((err) => log.error('whole value replay failed', err));
    return this.queue;
  }
}
