/**
 * Host side of the Details pane's "why" tree: the query (a step and a name) it shows for the
 * bound session, the answer from variableQuery.ts and the `why` messages that carry it. Kept out
 * of outputPanel.ts so the panel stays a message router; variablePane.ts is the same pattern.
 */
import type { Session } from '../session/session';
import { sessionProvenance } from '../session/variableQuery';
import { stepOfEntry } from '../session/provenance';
import type { Provenance, ProvenanceNode } from '../shared/protocol';
import type { HostToWebview } from '../shared/webviewProtocol';

/** The tree with display paths on every node and call; the wire shape carries absolute ones. */
export function withDisplayPaths(tree: Provenance, displayPath: (fileId: number) => string): Provenance {
  const node = (n: ProvenanceNode): ProvenanceNode => ({
    ...n,
    ...(n.fileId !== undefined ? { file: displayPath(n.fileId) } : {}),
    ...(n.reads ? { reads: n.reads.map(node) } : {}),
    ...(n.calls ? { calls: n.calls.map((c) => ({ ...c, file: displayPath(c.fileId) })) } : {}),
  });
  return { ...tree, root: node(tree.root) };
}

export class WhyPaneHost {
  private target: { step: number; name: string } | undefined;

  constructor(private readonly post: (session: Session, msg: HostToWebview) => void) {}

  /** The panel bound another session (or none): forget the query. */
  reset(): void {
    this.target = undefined;
  }

  /** The pane closed the tree: no more refreshes after a run. */
  close(): void {
    this.target = undefined;
  }

  /**
   * "Why" on an entry, a Variable pane row, a hover or the command; the pane keeps following the
   * session's runs. With `logId` (the entry the query came from) the step is the entry's own
   * statement's: an entry is stamped inside the last callee its statement entered.
   */
  query(session: Session, step: number, name: string, logId?: string): Promise<void> {
    const entry = logId ? session.state.entriesById.get(logId) : undefined;
    this.target = { step: entry && session.trace ? stepOfEntry(session.trace, entry) : step, name: name.trim() };
    return this.push(session);
  }

  /** After a run, or when the webview resyncs: recompute while a query is active. */
  refresh(session: Session): Promise<void> {
    return this.target ? this.push(session) : Promise.resolve();
  }

  private async push(session: Session): Promise<void> {
    const target = this.target;
    if (!target) return;
    const { step, name } = target;
    const fail = (error: string): void => this.post(session, { type: 'why', view: { step, name, tree: null, error } });
    const trace = session.trace;
    if (!trace) return fail(session.running ? 'A run is in flight; the tree follows it.' : 'No run yet: run the file first (save, or Re-execute).');
    if (!trace.valid(step)) return fail(`Step ${step} is not in this run (it has ${trace.count} steps); ask again from a value of the last run.`);
    this.post(session, { type: 'why', view: { step, name, tree: null } });
    try {
      const tree = await sessionProvenance(session, step, name);
      if (this.target !== target) return;
      if (!tree) return fail('No execution trace yet: run the file first.');
      this.post(session, { type: 'why', view: { step, name, tree: withDisplayPaths(tree, (fileId) => session.displayPath(fileId)) } });
    } catch (err) {
      if (this.target === target) fail(err instanceof Error ? err.message : String(err));
    }
  }
}
