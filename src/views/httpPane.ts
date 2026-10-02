/**
 * Host side of the panel's HTTP view: the table of the bound session's run (httpTable.ts) with
 * display paths, rebuilt at most every 100 ms while rows arrive and at every run boundary. Kept
 * out of outputPanel.ts so the panel stays a message router.
 */
import type { Session } from '../session/session';
import { buildHttpTable } from '../session/httpTable';
import type { HostToWebview } from '../shared/webviewProtocol';

export class HttpPaneHost {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly post: (session: Session, msg: HostToWebview) => void) {}

  /** The panel bound another session (or none): drop a pending push. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** A row arrived: push once, at the end of a 100 ms window (an SDK's retries come in bursts). */
  schedule(session: Session): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.push(session);
    }, 100);
  }

  /** The table of the session's current run (rows so far while it runs); null before the first run. */
  push(session: Session): void {
    this.reset();
    const st = session.state;
    if (!session.running && !st.finished) {
      this.post(session, { type: 'http', panel: null });
      return;
    }
    const panel = buildHttpTable({
      runId: st.runId,
      running: session.running,
      events: st.http,
      finished: st.finished?.http ?? null,
      locate: (rid) => {
        const loc = session.locate(rid);
        return loc && { fileId: loc.fileId, file: session.displayPath(loc.fileId), line: loc.range[0], col: loc.range[1] };
      },
    });
    this.post(session, { type: 'http', panel });
  }
}
