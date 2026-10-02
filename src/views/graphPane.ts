/**
 * Host side of the Execution Diagram view: when its graph is built and sent (`pyokka.diagram.build`),
 * the phases of the story tree, the call stack at the Time Machine's step, unrolling a package, and
 * the steps a node ran at for the inspector. Kept out of outputPanel.ts so the panel stays a message
 * router; whyPane.ts and httpPane.ts are the same pattern. The provider (`features/executionGraph.ts`)
 * caches the graphs; nothing here reaches the webview except through `post`.
 */
import type { Session } from '../session/session';
import type { GraphProvider } from '../features/executionGraph';
import type { GraphNode } from '../session/executionGraphTypes';
import type { ExecutionGraphPanel, HostToWebview } from '../shared/webviewProtocol';
import { buildPhases } from '../session/executionGraphPhases';
import { nodeHits } from '../session/executionGraphHits';
import { walkthroughInputs } from '../agent/bridgeSupport';
import { setting } from '../config/settings';
import { entryText } from './panelSupport';

export type DiagramBuild = 'onOpen' | 'onRun';

/** `pyokka.diagram.build`: build as every run finishes, or only when the view asks. */
export function diagramBuild(): DiagramBuild {
  return setting<string>('diagram.build', 'onOpen') === 'onRun' ? 'onRun' : 'onOpen';
}

export class GraphPaneHost {
  private provider: GraphProvider | undefined;
  /** the run whose graph each session (by key) last received: a resync or a request for the same run re-sends it */
  private readonly sent = new Map<string, string>();

  constructor(private readonly post: (session: Session, msg: HostToWebview) => void) {}

  setProvider(provider: GraphProvider): void {
    this.provider = provider;
  }

  /**
   * A run finished, or the panel resynced: send the graph when the setting builds on every run or
   * when this run's graph was already on the panel; otherwise clear the view and wait for its request.
   */
  afterRun(session: Session): void {
    if (diagramBuild() === 'onRun' || this.sent.get(session.key) === session.state.runId) this.push(session);
    else this.post(session, { type: 'executionGraph', graph: null });
  }

  /** The view opened without a graph, or a run finished while it was open: build and send. */
  request(session: Session): void {
    this.push(session);
  }

  /** Build the graph of the last run and send it; null while a run is in flight or before the first run. */
  push(session: Session): void {
    const provider = this.provider;
    if (!provider) return;
    const g = session.running || !session.state.finished ? undefined : provider.panelGraph(session);
    if (!g) {
      this.sent.delete(session.key);
      this.post(session, { type: 'executionGraph', graph: null });
      return;
    }
    const inputs = walkthroughInputs(session);
    const phases = inputs && setting<boolean>('diagram.phases', true) ? buildPhases(g, inputs.readSource) : [];
    const nodes = g.nodes.map((n): GraphNode => (n.fileId !== undefined ? { ...n, file: session.displayPath(n.fileId) } : n));
    const panel: ExecutionGraphPanel = { ...g, nodes, phases, runId: session.state.runId, expanded: provider.expanded(session), stack: provider.stack(session), currentStep: session.nav.active ? session.nav.currentStep : null };
    this.sent.set(session.key, session.state.runId);
    this.post(session, { type: 'executionGraph', graph: panel });
  }

  /** The call stack at the Time Machine's step as node ids (the provider throttles the calls). */
  stack(session: Session): void {
    if (!this.provider) return;
    this.post(session, { type: 'executionGraph.stack', runId: session.state.runId, step: session.nav.active ? session.nav.currentStep : null, stack: this.provider.stack(session) });
  }

  /** Unroll the package of `nodeId` into its functions, or fold it back; the provider's change event re-sends the graph. */
  expand(session: Session, nodeId: string, collapse?: boolean): void {
    const provider = this.provider;
    if (!provider) return;
    const g = provider.panelGraph(session);
    const node = g?.nodes.find((n) => n.id === nodeId);
    const pkg = node && node.kind !== 'decision' && node.kind !== 'statement' ? node.package : undefined;
    if (!pkg) return;
    const expanded = provider.expanded(session);
    const fold = collapse ?? expanded.includes(pkg);
    provider.setExpanded(session, fold ? expanded.filter((p) => p !== pkg) : [...expanded, pkg]);
  }

  /** The steps `nodeId` ran at, with the value logged on its line at each, for the inspector. */
  hits(session: Session, nodeId: string): void {
    const provider = this.provider;
    const trace = session.trace;
    if (!provider || !trace || session.running || !session.state.finished) return;
    const g = provider.panelGraph(session);
    const node = g?.nodes.find((n) => n.id === nodeId);
    if (!g || !node) return;
    const byStep = new Map<number, string>();
    if (node.kind === 'statement' || node.kind === 'decision') {
      for (const e of session.state.entries) {
        if (e.fileId !== node.fileId || byStep.has(e.step)) continue;
        const loc = session.locate(e.rid);
        if (loc && loc.range[0] === node.line) byStep.set(e.step, entryText(e));
      }
    }
    const hits = nodeHits(g, trace, nodeId, (step) => byStep.get(step));
    if (hits) this.post(session, { type: 'executionGraph.hits', runId: session.state.runId, nodeId, ...hits });
  }
}
