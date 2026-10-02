/**
 * The Execution Diagram's inspector: the selected node's card (location, rows, its calls or hits, the
 * unroll / fold button of a package), a statement's body (source, assigns / reads chips, hits), the
 * rows, and the hit list (`executionGraph.hits`: every step a statement, decision or function ran at
 * with the value logged there, and previous / next hit against the Time Machine's step).
 */
import { isDecision, isStatement, type ExecNode } from '../executionDiagram';
import type { GraphHits } from '../model';
import type { ExecutionGraphPanel, StatementNode } from '../src-shared';
import { IconButton, Repr } from './ui';

export function Rows({ n }: { n: ExecNode }) {
  if (n.rows.length === 0) return <div class="pk-dim pk-exec-none">no values</div>;
  return (
    <div class="pk-exec-rows">
      {n.rows.map((r, i) => (
        <div key={i} class={`pk-exec-row kind-${r.kind}`}>
          <span class="pk-exec-row-kind">{r.kind}</span> <Repr text={r.text} />
          <span class="pk-exec-row-step">#{r.step}</span>
        </div>
      ))}
    </div>
  );
}

/** The hit before and after `step` (the Time Machine inactive: the first hit is next). */
export function hitNeighbours(steps: readonly number[], step: number | null): { prev: number | undefined; next: number | undefined } {
  if (step === null) return { prev: undefined, next: steps[0] };
  let prev: number | undefined;
  let next: number | undefined;
  for (const s of steps) {
    if (s < step) prev = s;
    else if (s > step) {
      next = s;
      break;
    }
  }
  return { prev, next };
}

export function HitList({ hits, currentStep, onGoto }: { hits: GraphHits; currentStep: number | null; onGoto: (step: number) => void }) {
  const { prev, next } = hitNeighbours(hits.steps, currentStep);
  return (
    <div class="pk-exec-hits">
      <div class="pk-exec-hits-head">
        <span>
          {hits.total} hit{hits.total === 1 ? '' : 's'}
        </span>
        <span class="pk-toolbar">
          <IconButton icon="chevron-up" title={prev === undefined ? 'No earlier hit' : `Previous hit: #${prev}`} disabled={prev === undefined} onClick={() => prev !== undefined && onGoto(prev)} />
          <IconButton icon="chevron-down" title={next === undefined ? 'No later hit' : `Next hit: #${next}`} disabled={next === undefined} onClick={() => next !== undefined && onGoto(next)} />
        </span>
      </div>
      <div class="pk-exec-hit-list" role="list">
        {hits.steps.map((s, i) => (
          <div key={s} role="listitem" class={`pk-exec-hit${s === currentStep ? ' current' : ''}`} onClick={() => onGoto(s)} title={`Time Machine to #${s}`}>
            <span class="pk-exec-hit-step">#{s}</span>
            {hits.values[i] != null ? <Repr text={hits.values[i]!} class="pk-exec-hit-value" /> : <span class="pk-dim pk-exec-hit-value">no value logged</span>}
          </div>
        ))}
        {hits.total > hits.steps.length && <div class="pk-dim pk-exec-hit-more">… {hits.total - hits.steps.length} more</div>}
      </div>
    </div>
  );
}

/** The inspector's statement card body: the full source, the assigns / reads chips, the hits (a list once the host answered), the rows. */
export function StatementBody({ n, src, onGoto, hits, currentStep = null }: { n: ExecNode; src: StatementNode; onGoto: (step: number) => void; hits?: GraphHits | null; currentStep?: number | null }) {
  return (
    <div class="pk-exec-stmt">
      <div class="pk-exec-stmt-text">
        <Repr text={src.text} />
      </div>
      {(src.targets.length > 0 || src.reads.length > 0) && (
        <div class="pk-exec-chips">
          {src.targets.length > 0 && <span class="pk-exec-chip kind-assigns">assigns {src.targets.join(', ')}</span>}
          {src.reads.length > 0 && <span class="pk-exec-chip kind-reads">reads {src.reads.join(', ')}</span>}
        </div>
      )}
      {hits ? (
        <HitList hits={hits} currentStep={currentStep} onGoto={onGoto} />
      ) : (
        <div class="pk-exec-stmt-hits">
          <div class="pk-exec-call" onClick={() => onGoto(src.firstStep)} title={`Time Machine to #${src.firstStep}`}>
            {src.hits} hit{src.hits === 1 ? '' : 's'} · first at #{src.firstStep}
          </div>
        </div>
      )}
      <Rows n={n} />
    </div>
  );
}

export interface NodeCardProps {
  n: ExecNode;
  graph: ExecutionGraphPanel;
  /** the node's hits, once the host answered (only ever the selected node's) */
  hits: GraphHits | null;
  currentStep: number | null;
  onGoto: (step: number) => void;
  onExpand: (nodeId: string, collapse?: boolean) => void;
  onOpen: (fileId: number, line: number, sideView: boolean) => void;
}

export function NodeCard({ n, graph, hits, currentStep, onGoto, onExpand, onOpen }: NodeCardProps) {
  const src = n.node;
  const fileId = 'fileId' in src ? src.fileId : undefined;
  const line = 'line' in src ? src.line : undefined;
  const pkg = src.kind === 'module' || src.kind === 'function' || src.kind === 'package' ? src.package : undefined;
  const unrolled = !!pkg && src.kind === 'function' && graph.expanded.includes(pkg);
  return (
    <div class="pk-exec-card">
      <div class="pk-exec-card-title">
        {n.title} <span class="pk-exec-kind">{n.kind}</span>
      </div>
      {n.subtitle && (
        <div class="pk-exec-card-sub">
          {fileId !== undefined && line !== undefined ? (
            <a
              href="#"
              class="pk-link"
              onClick={(e) => {
                e.preventDefault();
                onOpen(fileId, line, false);
              }}
            >
              {n.subtitle}
            </a>
          ) : (
            n.subtitle
          )}
        </div>
      )}
      {isDecision(src) ? (
        <div class="pk-exec-decision">
          {src.taken !== undefined && (
            <div>
              took <Repr text={src.taken} />
            </div>
          )}
          <div>
            {src.hits} hit{src.hits === 1 ? '' : 's'}
          </div>
          {src.notRun.length > 0 && <div class="pk-exec-not-run">not run: line {src.notRun.join(', ')}</div>}
          <div class="pk-exec-call" onClick={() => onGoto(src.firstStep)}>
            first at #{src.firstStep}
          </div>
          {hits && <HitList hits={hits} currentStep={currentStep} onGoto={onGoto} />}
        </div>
      ) : src.kind === 'package' && src.more !== undefined ? (
        <div class="pk-dim">
          {src.more} function{src.more === 1 ? '' : 's'} of {src.file} dropped under the cap; `pyokka graph` lists them all
        </div>
      ) : isStatement(src) ? (
        <StatementBody n={n} src={src} onGoto={onGoto} hits={hits} currentStep={currentStep} />
      ) : (
        <div class="pk-exec-calls">
          <div class="pk-exec-calls-head">
            {src.calls} call{src.calls === 1 ? '' : 's'}
            {src.nested !== undefined ? ` · ${src.nested} nested` : ''}
          </div>
          {hits ? (
            <HitList hits={hits} currentStep={currentStep} onGoto={onGoto} />
          ) : (
            <>
              {src.spans.map(([entry, end], i) => (
                <div key={i} class="pk-exec-call" onClick={() => onGoto(entry)} title={`Time Machine to #${entry}`}>
                  #{entry} → #{end}
                </div>
              ))}
              {src.spans.length < src.calls && <div class="pk-dim">… {src.calls - src.spans.length} more</div>}
            </>
          )}
        </div>
      )}
      {!isStatement(src) && <Rows n={n} />}
      {src.kind === 'package' && !n.placeholder && (
        <button type="button" class="pk-exec-btn" onClick={() => onExpand(n.id)}>
          Unroll {pkg}
        </button>
      )}
      {unrolled && (
        <button type="button" class="pk-exec-btn" onClick={() => onExpand(n.id, true)}>
          Fold {pkg}
        </button>
      )}
    </div>
  );
}
