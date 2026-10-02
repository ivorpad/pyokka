/**
 * Host side of the panel's Variable pane: the name it shows for the bound session, the query
 * that answers it (variableQuery.ts) and the `variable` messages that carry the answer. Kept
 * out of outputPanel.ts so the panel stays a message router.
 */
import type { Session } from '../session/session';
import { sessionVariableHistory } from '../session/variableQuery';
import type { HostToWebview } from '../shared/webviewProtocol';

export class VariablePaneHost {
  private name: string | undefined;

  constructor(private readonly post: (session: Session, msg: HostToWebview) => void) {}

  /** The panel bound another session (or none): forget the query. */
  reset(): void {
    this.name = undefined;
  }

  /** A query from the pane's input, a read the user clicked, or the Show Variable History command; an empty name clears the pane. */
  query(session: Session, name: string): Promise<void> {
    this.name = name.trim() || undefined;
    return this.push(session);
  }

  /** After a run, or when the webview resyncs: recompute while a query is active. */
  refresh(session: Session): Promise<void> {
    return this.name ? this.push(session) : Promise.resolve();
  }

  private async push(session: Session): Promise<void> {
    const name = this.name;
    if (!name) {
      this.post(session, { type: 'variable', view: { name: '', history: null } });
      return;
    }
    if (!session.trace) {
      const error = session.running ? 'A run is in flight; the history follows it.' : 'No run yet: run the file first (save, or Re-execute).';
      this.post(session, { type: 'variable', view: { name, history: null, error } });
      return;
    }
    this.post(session, { type: 'variable', view: { name, history: null } });
    try {
      const history = await sessionVariableHistory(session, name);
      if (this.name !== name) return;
      if (!history) {
        this.post(session, { type: 'variable', view: { name, history: null, error: 'No execution trace yet: run the file first.' } });
        return;
      }
      // the panel shows display paths; the wire shape carries absolute ones
      this.post(session, { type: 'variable', view: { name, history: { ...history, changes: history.changes.map((c) => ({ ...c, file: session.displayPath(c.fileId) })) } } });
    } catch (err) {
      if (this.name !== name) return;
      this.post(session, { type: 'variable', view: { name, history: null, error: err instanceof Error ? err.message : String(err) } });
    }
  }
}
