/**
 * EXECUTION DIAGRAM view: the run as a picture, at the level of detail asked for. Left, the story
 * tree (the run as an outline: modules, phases, statements, the scopes they call) or the walkthrough;
 * centre, the canvas (one cluster per module / function / package: the card and, when the scope is
 * open, its statements and decisions stacked under it; clusters in columns by call depth; the call
 * stack at the Time Machine's step in full colour and the rest faded) with the step scrubber under
 * it; right, the inspector: the selected node with its hits or calls, the current moment's gloss,
 * and "now". What the canvas draws follows `pyokka.diagram.detail` and `pyokka.diagram.dataEdges`,
 * overridden for the open panel by the toolbar and the cards' chevrons (`GraphViewState`).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { activePath, doneNodes, edgeLabelPoint, execEdgePath, execNodeOf, isCallNode, isStatement, momentNode, nodeAtStep, notYet, scopeOf, stackFromFrames, toDiagram, type ExecCluster, type ExecEdge, type ExecNode, type ExecView } from '../executionDiagram';
import { buildStory } from '../execStory';
import type { GraphHits, GraphViewState } from '../model';
import type { DebuggerState, ExecutionGraphPanel, PanelSettings, WalkthroughPanel } from '../src-shared';
import { BoxShape, DecisionShape, StatementShape } from './ExecShapes';
import { NodeCard, Rows, StatementBody } from './ExecInspector';
import { ExecStory } from './ExecStory';
import { usePanZoom } from './panZoom';
import { IconButton, useElementSize } from './ui';
import { activeMomentIndex, Walkthrough } from './Walkthrough';

export interface ExecutionDiagramProps {
  graph: ExecutionGraphPanel | null;
  /** the latest `executionGraph.stack` message */
  graphStack: { runId: string; step: number | null; stack: string[] } | null;
  debug: DebuggerState | null;
  walkthrough: WalkthroughPanel | null;
  /** selected node id */
  selected: string | null;
  /** a run is in flight */
  running: boolean;
  /** `pyokka.diagram.detail` and `pyokka.diagram.dataEdges`; `view` overrides them for the open panel */
  settings: Pick<PanelSettings, 'diagramDetail' | 'diagramDataEdges'>;
  view: GraphViewState;
  /** the selected node's hits, once the host answered */
  hits: GraphHits | null;
  onSelect: (nodeId: string | null) => void;
  /** `debugger.goto` (the host starts the Time Machine when it is inactive) */
  onGoto: (step: number) => void;
  onAction: (action: 'autoPlay' | 'pause') => void;
  /** `executionGraph.expand`: unroll a package node, or fold (`collapse`) the package of an unrolled function */
  onExpand: (nodeId: string, collapse?: boolean) => void;
  onNarrate: () => void;
  onOpen: (fileId: number, line: number, sideView: boolean) => void;
  onClose: () => void;
  /** the toolbar's toggles and the left pane's tabs */
  onView: (patch: Partial<GraphViewState>) => void;
  /** a card's chevron: open or fold the scope's statements on the canvas */
  onToggleScope: (nodeId: string) => void;
  /** `executionGraph.hits` for the selected node */
  onHits: (nodeId: string) => void;
  /** no graph yet: `executionGraph.request` (the host builds on request under `pyokka.diagram.build` onOpen) */
  onRequest: () => void;
}

const EMPTY = new Set<string>();

/** The scopes drawn with their members: every scope but the toggled ones under 'open', only the toggled ones under 'closed'. */
export function openScopes(graph: Pick<ExecutionGraphPanel, 'nodes'>, base: 'open' | 'closed', toggled: readonly string[]): Set<string> {
  const t = new Set(toggled);
  const out = new Set<string>();
  for (const n of graph.nodes) if (isCallNode(n) && (base === 'open' ? !t.has(n.id) : t.has(n.id))) out.add(n.id);
  return out;
}

export function ExecutionDiagram(props: ExecutionDiagramProps) {
  const { graph, debug, walkthrough, settings, view } = props;
  const active = !!debug?.active;
  const step: number | null = active && debug ? debug.currentStep : graph?.currentStep ?? null;
  const count = graph?.count ?? 0;

  // what the canvas draws: the settings, overridden for this panel by the toolbar and the chevrons
  const base = view.base ?? (settings.diagramDetail === 'statements' ? 'open' : 'closed');
  const dataEdges = view.dataEdges ?? settings.diagramDataEdges;
  const open = useMemo(() => (graph ? openScopes(graph, base, view.toggled) : EMPTY), [graph, base, view.toggled]);
  const execView = useMemo((): ExecView => ({ open, dataEdges }), [open, dataEdges]);
  const diagram = useMemo(() => (graph ? toDiagram(graph, execView) : null), [graph, execView]);
  const story = useMemo(() => (graph ? buildStory(graph) : []), [graph]);
  const graphById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);

  // no graph while no run is in flight: ask the host for one
  useEffect(() => {
    if (!graph && !props.running) props.onRequest();
  }, [graph, props.running]);
  // the selected node's hits, once per node and run
  useEffect(() => {
    const id = props.selected;
    if (!graph || !id) return;
    const n = graphById.get(id);
    if (!n || n.kind === 'module' || n.kind === 'package') return;
    if (props.hits && props.hits.runId === graph.runId && props.hits.nodeId === id) return;
    props.onHits(id);
  }, [graph?.runId, props.selected, props.hits]);

  const stack = useMemo(() => {
    if (!graph) return [];
    if (active && debug?.showCallStack && debug.callStack && debug.callStack.frames.length > 0) return stackFromFrames(graph, debug.callStack.frames);
    if (props.graphStack && props.graphStack.runId === graph.runId) return props.graphStack.stack;
    return graph.stack;
  }, [graph, active, debug?.showCallStack, debug?.callStack, props.graphStack]);
  const path = useMemo(() => (graph ? activePath(graph, stack) : { nodes: EMPTY, edges: EMPTY }), [graph, stack]);
  const done = useMemo(() => (graph && step !== null ? doneNodes(graph, step) : EMPTY), [graph, step]);
  const later = useMemo(() => (graph && step !== null ? notYet(graph, step) : EMPTY), [graph, step]);
  const nowId = graph && step !== null ? nodeAtStep(graph, step, stack) : null;
  const byId = useMemo(() => new Map((diagram?.nodes ?? []).map((n) => [n.id, n])), [diagram]);
  /** a node's box: the drawn one, else (its scope folded) an unpositioned one for the inspector */
  const boxOf = (id: string | null): ExecNode | null => {
    if (!id) return null;
    const drawn = byId.get(id);
    if (drawn) return drawn;
    const g = graphById.get(id);
    return g ? execNodeOf(g) : null;
  };
  const selectedNode = boxOf(props.selected);
  const nowNode = boxOf(nowId);
  const hits = props.hits && graph && props.hits.runId === graph.runId && props.hits.nodeId === props.selected ? props.hits : null;
  const momentIndex = walkthrough ? activeMomentIndex(walkthrough.moments, step) : -1;
  const gloss = momentIndex >= 0 ? walkthrough?.moments[momentIndex]?.gloss ?? null : null;

  // canvas
  const [viewRef, size] = useElementSize<HTMLDivElement>();
  const pz = usePanZoom(size, '.pk-ex-node', { minScale: 0.6 });
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!diagram || !graph || size.width === 0 || fitted.current === graph.runId) return;
    fitted.current = graph.runId;
    pz.fitTo(diagram);
  }, [diagram, size.width, size.height, graph?.runId]);

  // scrubber: the thumb follows the drag at once, one goto per animation frame
  const [scrub, setScrub] = useState<number | null>(null);
  useEffect(() => setScrub(null), [step]);
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const postStep = (s: number) => {
    pending.current = s;
    if (frame.current !== null) return;
    const flush = () => {
      frame.current = null;
      const p = pending.current;
      pending.current = null;
      if (p !== null) props.onGoto(p);
    };
    if (typeof requestAnimationFrame === 'function') frame.current = requestAnimationFrame(flush);
    else flush();
  };
  const shown = scrub ?? step ?? 0;
  const onScrub = (e: Event) => {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    setScrub(v);
    postStep(v);
  };
  const goto = (s: number) => props.onGoto(Math.max(0, Math.min(count - 1, s)));

  /** select a node; a statement or decision inside a folded scope opens the scope so the selection is on the canvas */
  const selectNode = (id: string | null) => {
    props.onSelect(id);
    if (!graph || !id) return;
    const sc = scopeOf(graph, id);
    if (sc && sc !== id && !open.has(sc)) props.onToggleScope(sc);
  };
  const clickNode = (n: ExecNode) => {
    selectNode(n.id);
    props.onGoto(n.node.firstStep);
    if (n.kind === 'package' && !n.placeholder) props.onExpand(n.id);
  };

  const nodeClass = (n: ExecNode): string => {
    const cls = ['pk-ex-node', `kind-${n.kind}`];
    if (path.nodes.has(n.id)) cls.push('active');
    else if (later.has(n.id) || stack.length > 0) cls.push('dim');
    if (done.has(n.id)) cls.push('done');
    if (n.id === props.selected) cls.push('selected');
    if (n.placeholder) cls.push('placeholder');
    return cls.join(' ');
  };
  const edgeClass = (e: ExecEdge): string => {
    const cls = ['pk-ex-edge', `kind-${e.kind}`];
    if (e.ids.some((id) => path.edges.has(id))) cls.push('active');
    else if (later.has(e.to) || stack.length > 0) cls.push('dim');
    return cls.join(' ');
  };
  // a cluster fades and lights up with its header; it reads as selected when any of its boxes is
  const clusterClass = (c: ExecCluster): string => {
    const cls = ['pk-ex-cluster', `kind-${c.kind}`];
    if (path.nodes.has(c.id)) cls.push('active');
    else if (later.has(c.id) || stack.length > 0) cls.push('dim');
    if (done.has(c.id)) cls.push('done');
    if (props.selected !== null && (props.selected === c.id || c.boxes.includes(props.selected))) cls.push('selected');
    return cls.join(' ');
  };

  const header = (
    <header class="pk-pane-header">
      <span class="pk-pane-title">
        EXECUTION DIAGRAM {graph && <span class="pk-count">{graph.nodes.length} nodes{graph.capped ? ' (capped)' : ''}</span>}
      </span>
      <span class="pk-toolbar">
        <IconButton icon="list-tree" title={base === 'open' ? 'Statements shown for every scope: fold them all (a card’s chevron opens one)' : 'Statements folded: show every scope’s statements and decisions (a card’s chevron opens one)'} active={base === 'open'} onClick={() => props.onView({ base: base === 'open' ? 'closed' : 'open', toggled: [] })} />
        <IconButton icon="arrow-both" title={dataEdges ? 'Data edges shown: hide them' : 'Data edges hidden: show a value assigned in one statement flowing into the statements that read it'} active={dataEdges} onClick={() => props.onView({ dataEdges: !dataEdges })} />
        <IconButton icon="zoom-in" title="Zoom in" onClick={() => pz.zoom(1.25)} />
        <IconButton icon="zoom-out" title="Zoom out" onClick={() => pz.zoom(0.8)} />
        <IconButton icon="screen-full" title="Fit width (top aligned)" onClick={() => diagram && pz.fitWidth(diagram)} />
        <IconButton icon="type-hierarchy" title="Close execution diagram" active onClick={props.onClose} />
      </span>
    </header>
  );

  if (!graph || !diagram) {
    return (
      <section class="pk-pane pk-exec" aria-label="Execution diagram">
        {header}
        <div class="pk-empty">{props.running ? 'RUNNING…' : 'NO RUN YET'}</div>
      </section>
    );
  }

  const tab = (id: GraphViewState['left'], label: string) => (
    <button type="button" role="tab" class={`pk-exec-tab-btn${view.left === id ? ' active' : ''}`} aria-selected={view.left === id} onClick={() => props.onView({ left: id })}>
      {label}
    </button>
  );

  return (
    <section class="pk-pane pk-exec" aria-label="Execution diagram">
      {header}
      <div class="pk-exec-body">
        <div class="pk-exec-left">
          <div class="pk-exec-tabs" role="tablist">
            {tab('story', 'STORY')}
            {tab('walkthrough', 'WALKTHROUGH')}
          </div>
          {view.left === 'story' ? (
            <ExecStory
              rows={story}
              active={path.nodes}
              nowId={nowId}
              selected={props.selected}
              done={done}
              onSelect={(nodeId, s) => {
                selectNode(nodeId);
                props.onGoto(s);
              }}
            />
          ) : (
            <Walkthrough model={walkthrough} currentStep={step} open onToggle={() => undefined} onGoto={props.onGoto} onNarrate={props.onNarrate} onOpen={props.onOpen} onSelectMoment={(m) => selectNode(momentNode(graph, m))} />
          )}
        </div>
        <div class="pk-exec-centre">
          {props.running && <div class="pk-exec-running">RUNNING…</div>}
          <div
            class="pk-exec-canvas pk-dg-view"
            ref={viewRef}
            onWheel={pz.onWheel}
            onMouseDown={pz.onMouseDown}
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('.pk-ex-node, .pk-ex-cluster')) props.onSelect(null);
            }}
          >
            <svg class="pk-dg-svg pk-exec-svg" width="100%" height="100%">
              <defs>
                <pattern id="pk-exec-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" fill="none" class="pk-dg-grid" />
                </pattern>
                <marker id="pk-exec-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" class="pk-ex-arrow" />
                </marker>
              </defs>
              <rect width="100%" height="100%" fill="url(#pk-exec-grid)" />
              <g transform={`translate(${pz.tf.x} ${pz.tf.y}) scale(${pz.tf.k})`}>
                {diagram.clusters.map((c) => (
                  <g
                    key={c.id}
                    class={clusterClass(c)}
                    data-cluster={c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onSelect(c.id);
                    }}
                  >
                    <rect x={c.x} y={c.y} width={c.width} height={c.height} rx="6" class="pk-ex-cluster-box" />
                  </g>
                ))}
                {diagram.edges.map((e) => {
                  const d = execEdgePath(e);
                  const at = edgeLabelPoint(e);
                  return (
                    <g key={e.id} class={edgeClass(e)} data-edge={e.id}>
                      <title>{e.title}</title>
                      <path d={d} class="pk-ex-edge-hit" />
                      <path d={d} class="pk-ex-edge-line" style={{ strokeWidth: e.width }} marker-end="url(#pk-exec-arrow)" />
                      {e.label && at && (
                        <text x={at.x} y={at.y} class="pk-ex-edge-label" text-anchor="middle">
                          {e.label}
                        </text>
                      )}
                    </g>
                  );
                })}
                {diagram.nodes.map((n) => (
                  <g
                    key={n.id}
                    class={nodeClass(n)}
                    data-node={n.id}
                    transform={`translate(${n.x} ${n.y})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      clickNode(n);
                    }}
                  >
                    <title>{`${n.title}${n.subtitle ? ` · ${n.subtitle}` : ''} · click: Time Machine to #${n.node.firstStep}`}</title>
                    {n.kind === 'decision' ? <DecisionShape n={n} /> : n.kind === 'statement' ? <StatementShape n={n} done={done.has(n.id)} /> : <BoxShape n={n} done={done.has(n.id)} onToggle={props.onToggleScope} />}
                  </g>
                ))}
              </g>
            </svg>
          </div>
          <div class="pk-exec-scrubber">
            <IconButton icon={debug?.autoPlaying ? 'debug-pause' : 'play'} title={debug?.autoPlaying ? 'Pause' : active ? 'Play' : 'Play (starts the Time Machine)'} disabled={count === 0} onClick={() => props.onAction(debug?.autoPlaying ? 'pause' : 'autoPlay')} />
            <IconButton icon="chevron-left" title="Previous step" disabled={count === 0 || shown <= 0} onClick={() => goto(shown - 1)} />
            <input type="range" class="pk-exec-range" min={0} max={Math.max(0, count - 1)} value={shown} disabled={count === 0} onInput={onScrub} onChange={onScrub} aria-label="Step" />
            <IconButton icon="chevron-right" title="Next step" disabled={count === 0 || shown >= count - 1} onClick={() => goto(shown + 1)} />
            <span class="pk-exec-step">
              {step === null && scrub === null ? <span class="pk-dim">Time Machine off · </span> : null}#{shown} of {count}
            </span>
          </div>
        </div>
        <aside class="pk-exec-inspector">
          <div class="pk-subheader">SELECTED</div>
          {selectedNode ? <NodeCard n={selectedNode} graph={graph} hits={hits} currentStep={step} onGoto={props.onGoto} onExpand={props.onExpand} onOpen={props.onOpen} /> : <div class="pk-empty small">CLICK A NODE</div>}
          {gloss && (
            <>
              <div class="pk-subheader">MOMENT</div>
              <div class="pk-exec-gloss">{gloss}</div>
            </>
          )}
          <div class="pk-subheader">NOW{step !== null ? ` #${step}` : ''}</div>
          {nowNode ? (
            <div class="pk-exec-now">
              <div class="pk-exec-card-title">{nowNode.title}</div>
              {isStatement(nowNode.node) ? <StatementBody n={nowNode} src={nowNode.node} onGoto={props.onGoto} /> : <Rows n={nowNode} />}
            </div>
          ) : (
            <div class="pk-empty small">{step === null ? 'TIME MACHINE OFF' : 'NO NODE AT THIS STEP'}</div>
          )}
        </aside>
      </div>
    </section>
  );
}
