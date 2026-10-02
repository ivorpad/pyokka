/** DIAGRAM view: SVG graph of an entry's value with pan, zoom, fit and per-node menus. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildGraph, edgePath, layoutGraph, ROW_H, TITLE_H, type DiagramGraph, type DiagramNode, type DiagramRow } from '../diagram';
import { formatText } from '../format';
import type { Entry } from '../model';
import type { ValueNode } from '../src-shared';
import { tokenize } from '../highlight';
import { usePanZoom } from './panZoom';
import { IconButton, Menu, useElementSize, type MenuItem } from './ui';

export interface DiagramProps {
  entry: Entry | null;
  onExpand: (entry: Entry, node: ValueNode) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}

export function Diagram(props: DiagramProps) {
  const [viewRef, size] = useElementSize<HTMLDivElement>();
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const pz = usePanZoom(size, '.pk-dg-node');
  const [menu, setMenu] = useState<{ node: DiagramNode; x: number; y: number } | null>(null);
  const fitted = useRef<string | null>(null);
  const entry = props.entry;
  const root = entry?.valueBag?.data ?? null;

  // reset expansion when the entry changes
  useEffect(() => {
    setExpanded(null);
    fitted.current = null;
  }, [entry?.logId]);

  const graph: DiagramGraph | null = useMemo(() => {
    if (!root) return null;
    const name = entry?.context && /^[A-Za-z_][\w.]*$/.test(entry.context) ? entry.context : 'value';
    return layoutGraph(buildGraph(root, name, expanded));
  }, [root, expanded, entry?.context]);

  // fit once per entry when we know the viewport size
  useEffect(() => {
    if (!graph || size.width === 0 || fitted.current === entry?.logId) return;
    fitted.current = entry?.logId ?? null;
    pz.fitTo(graph);
  }, [graph, size.width, size.height, entry?.logId]);

  const currentExpanded = (): Set<string> => {
    if (expanded) return new Set(expanded);
    // materialise the auto-expansion so toggles are relative to what is shown
    const set = new Set<string>();
    for (const n of graph?.nodes ?? []) if (n.id !== graph?.nodes[0]?.id) set.add(n.id);
    return set;
  };

  const toggleRow = (row: DiagramRow) => {
    if (!entry) return;
    if (row.loadable) {
      props.onExpand(entry, row.node);
      const set = currentExpanded();
      set.add(row.path);
      setExpanded(set);
      return;
    }
    const set = currentExpanded();
    if (set.has(row.path)) {
      // collapse this node and everything under it
      for (const id of [...set]) if (id === row.path || id.startsWith(row.path + '.') || id.startsWith(row.path + '[')) set.delete(id);
    } else set.add(row.path);
    setExpanded(set);
  };

  const fit = () => {
    if (graph) pz.fitTo(graph);
  };

  const menuItems = (node: DiagramNode): MenuItem[] => [
    { label: node.path, disabled: true },
    { label: 'Copy path', separatorAbove: true, onSelect: () => props.onCopy(node.path) },
    { label: 'Copy value', onSelect: () => props.onCopy(formatText(node.node, { rootName: node.path })) },
  ];

  return (
    <section class="pk-pane pk-diagram" aria-label="Diagram">
      <header class="pk-pane-header">
        <span class="pk-pane-title">DIAGRAM</span>
        <span class="pk-toolbar">
          <IconButton icon="zoom-in" title="Zoom in" onClick={() => pz.zoom(1.25)} />
          <IconButton icon="zoom-out" title="Zoom out" onClick={() => pz.zoom(0.8)} />
          <IconButton icon="screen-full" title="Fit view" onClick={fit} />
          <IconButton icon="type-hierarchy-sub" title="Close diagram" active onClick={props.onClose} />
        </span>
      </header>
      <div class="pk-dg-view" ref={viewRef} onWheel={pz.onWheel} onMouseDown={pz.onMouseDown}>
        {!graph ? (
          <div class="pk-empty">{entry ? 'This value has no structure to diagram' : 'Select an entry to show it as a diagram'}</div>
        ) : (
          <svg class="pk-dg-svg" width="100%" height="100%">
            <defs>
              <pattern id="pk-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" fill="none" class="pk-dg-grid" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#pk-grid)" />
            <g transform={`translate(${pz.tf.x} ${pz.tf.y}) scale(${pz.tf.k})`}>
              {graph.edges.map((e, i) => (
                <path key={i} d={edgePath(e)} class="pk-dg-edge" />
              ))}
              {graph.nodes.map((n) => (
                <g key={n.id} class="pk-dg-node" transform={`translate(${n.x} ${n.y})`}>
                  <rect width={n.width} height={n.height} rx="3" class="pk-dg-box" />
                  <rect width={n.width} height={TITLE_H} rx="3" class="pk-dg-title-bg" />
                  <text x={10} y={TITLE_H / 2 + 4} class="pk-dg-title">
                    <tspan class="pk-dg-name">{n.title}</tspan>
                    <tspan class="pk-dg-type">: {n.typeName}</tspan>
                  </text>
                  <g
                    class="pk-dg-more"
                    transform={`translate(${n.width - 18} ${TITLE_H / 2 - 8})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = viewRef.current?.getBoundingClientRect();
                      setMenu({ node: n, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
                    }}
                  >
                    <rect width="16" height="16" fill="transparent" />
                    <text x="8" y="12" text-anchor="middle" class="pk-dg-more-glyph">
                      ⋮
                    </text>
                  </g>
                  {n.rows.map((r, i) => {
                    const y = TITLE_H + i * ROW_H;
                    return (
                      <g key={i} transform={`translate(0 ${y})`}>
                        <line x1={0} x2={n.width} y1={0} y2={0} class="pk-dg-sep" />
                        <text x={10} y={ROW_H / 2 + 4} class="pk-dg-row-name">
                          {r.name}
                        </text>
                        {r.collapsed ? (
                          <text
                            x={n.width - 10}
                            y={ROW_H / 2 + 4}
                            text-anchor="end"
                            class="pk-dg-row-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRow(r);
                            }}
                          >
                            {r.text}
                          </text>
                        ) : r.childId ? (
                          <text
                            x={n.width - 10}
                            y={ROW_H / 2 + 4}
                            text-anchor="end"
                            class="pk-dg-row-link"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRow(r);
                            }}
                          >
                            →
                          </text>
                        ) : (
                          <text x={n.width - 10} y={ROW_H / 2 + 4} text-anchor="end" class="pk-dg-row-value">
                            {tokenize(r.text).map((t, j) => (
                              <tspan key={j} class={`tk-${t.cls}`}>
                                {t.text}
                              </tspan>
                            ))}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              ))}
            </g>
          </svg>
        )}
        {menu && (
          <div class="pk-dg-menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
            <Menu items={menuItems(menu.node)} onClose={() => setMenu(null)} align="left" />
          </div>
        )}
      </div>
    </section>
  );
}
