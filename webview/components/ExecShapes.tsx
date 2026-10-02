/**
 * The Execution Diagram's SVG shapes: a scope card (the module / function / package header with its
 * rows, the chevron that opens or folds its statements on the canvas, the done tick, the nested
 * count), a statement box (a bar down its left, the source as its label, the rows), the rows
 * themselves, and a decision diamond. Drawn at the origin; ExecutionDiagram.tsx positions them with
 * the parent `<g transform>`.
 */
import { ROW_H } from '../diagram';
import { DECISION_H, decisionDetail, EXEC_TITLE_H, isDecision, STATEMENT_TITLE_H, type ExecNode } from '../executionDiagram';
import { tokenize } from '../highlight';

/** A module, function or package card; `onToggle` (the chevron) opens or folds its statements and decisions on the canvas. */
export function BoxShape({ n, done, onToggle }: { n: ExecNode; done: boolean; onToggle?: (nodeId: string) => void }) {
  const chevron = n.children > 0 && !n.placeholder;
  const members = `${n.children} statement${n.children === 1 ? '' : 's'} and decision${n.children === 1 ? '' : 's'}`;
  return (
    <>
      {n.kind === 'package' && <rect x={0} y={-6} width={Math.min(48, n.width / 3)} height={10} rx="2" class="pk-ex-tab" />}
      <rect width={n.width} height={n.height} rx="3" class="pk-ex-box" />
      <rect width={n.width} height={EXEC_TITLE_H} rx="3" class="pk-ex-title-bg" />
      <text x={10} y={14} class="pk-ex-title">
        {n.title}
      </text>
      {n.subtitle && (
        <text x={10} y={27} class="pk-ex-sub">
          {n.subtitle}
        </text>
      )}
      {done && (
        <text x={n.width - (chevron ? 52 : 8)} y={14} text-anchor="end" class="pk-ex-tick">
          ✓
        </text>
      )}
      {chevron && (
        <g
          class={`pk-ex-chevron${n.open ? ' open' : ''}`}
          data-chevron={n.id}
          transform={`translate(${n.width - 48} 2)`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.(n.id);
          }}
        >
          <title>{n.open ? `Fold the ${members} of this scope` : `Show the ${members} of this scope on the canvas`}</title>
          <rect width={44} height={16} rx="3" class="pk-ex-chevron-hit" />
          <text x={40} y={12} text-anchor="end" class="pk-ex-chevron-glyph">
            {n.open ? '▾' : '▸'} {n.children}
          </text>
        </g>
      )}
      <BoxRows n={n} top={EXEC_TITLE_H} />
      {n.nested !== undefined && (
        <g transform={`translate(0 ${EXEC_TITLE_H + n.rows.length * ROW_H})`}>
          <line x1={0} x2={n.width} y1={0} y2={0} class="pk-dg-sep" />
          <text x={10} y={ROW_H / 2 + 4} class="pk-ex-nested">
            {n.nested} nested
          </text>
        </g>
      )}
    </>
  );
}

/** A step of the pipeline: a plain box with a bar down its left side, the source as its label, the rows under it. */
export function StatementShape({ n, done }: { n: ExecNode; done: boolean }) {
  return (
    <>
      <rect width={n.width} height={n.height} rx="3" class="pk-ex-box" />
      <rect width={3} height={n.height} class="pk-ex-step-bar" />
      <text x={12} y={STATEMENT_TITLE_H / 2 + 4} class="pk-ex-stmt-label">
        {n.title}
      </text>
      {done && (
        <text x={n.width - 8} y={STATEMENT_TITLE_H / 2 + 4} text-anchor="end" class="pk-ex-tick">
          ✓
        </text>
      )}
      <BoxRows n={n} top={STATEMENT_TITLE_H} />
    </>
  );
}

export function BoxRows({ n, top }: { n: ExecNode; top: number }) {
  return (
    <>
      {n.rows.map((r, i) => {
        const y = top + i * ROW_H;
        return (
          <g key={i} transform={`translate(0 ${y})`} class={`pk-ex-row kind-${r.kind}`}>
            <line x1={0} x2={n.width} y1={0} y2={0} class="pk-dg-sep" />
            <text x={10} y={ROW_H / 2 + 4} class="pk-ex-row-kind">
              {r.kind}
            </text>
            <text x={52} y={ROW_H / 2 + 4} class="pk-dg-row-value pk-ex-row-text">
              {tokenize(r.text).map((t, j) => (
                <tspan key={j} class={`tk-${t.cls}`}>
                  {t.text}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function DecisionShape({ n }: { n: ExecNode }) {
  const w = n.width;
  const h = DECISION_H;
  const dn = n.node;
  const detail = isDecision(dn) ? decisionDetail(dn) : '';
  return (
    <>
      <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} class="pk-ex-diamond" />
      <text x={w / 2} y={h / 2 - 3} text-anchor="middle" class="pk-ex-title pk-ex-decision-label">
        {n.title}
      </text>
      {detail && (
        <text x={w / 2} y={h / 2 + 11} text-anchor="middle" class={`pk-ex-sub pk-ex-decision-detail${n.notRun.length ? ' has-not-run' : ''}`}>
          {detail}
        </text>
      )}
    </>
  );
}
