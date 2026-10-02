/**
 * STORY tab of the Execution Diagram's left pane: the run as an outline (`execStory.ts`), one row per
 * scope, phase, statement and decision, the scopes a statement calls nested under it. Rows on the
 * call stack read in full colour and the rest faded; the node the current step is in is highlighted
 * and kept in view; a click selects the node, moves the Time Machine to its step and opens its scope
 * on the canvas. Twisties fold sub-trees; the scopes reached through a call start folded.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { defaultClosed, flattenStory, type StoryRow } from '../execStory';
import { Icon } from './ui';

export interface ExecStoryProps {
  rows: StoryRow[];
  /** node ids on the call stack at the current step */
  active: ReadonlySet<string>;
  /** the node the current step is in */
  nowId: string | null;
  selected: string | null;
  done: ReadonlySet<string>;
  onSelect: (nodeId: string, step: number) => void;
}

const KIND_ICON: Record<StoryRow['kind'], string> = { scope: 'symbol-method', phase: 'list-selection', statement: 'circle-small', decision: 'git-branch', ref: 'arrow-right' };
const SCOPE_ICON: Partial<Record<StoryRow['nodeKind'], string>> = { module: 'file-code', package: 'package' };

function iconOf(row: StoryRow): string {
  if (row.kind === 'scope') return SCOPE_ICON[row.nodeKind] ?? KIND_ICON.scope;
  return KIND_ICON[row.kind];
}

export function ExecStory(props: ExecStoryProps) {
  const { rows } = props;
  const [closed, setClosed] = useState<Set<string> | null>(null);
  // a new tree (a new run, a package unrolled) starts from the defaults again
  useEffect(() => setClosed(null), [rows]);
  const effective = useMemo(() => closed ?? defaultClosed(rows), [closed, rows]);
  const flat = useMemo(() => flattenStory(rows, effective), [rows, effective]);
  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev ?? defaultClosed(rows));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const nowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    nowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [props.nowId]);

  if (rows.length === 0) {
    return (
      <div class="pk-story">
        <div class="pk-story-empty">NO RUN YET</div>
      </div>
    );
  }
  return (
    <div class="pk-story" role="tree">
      {flat.map(({ row, depth }) => {
        const isNow = row.kind === 'phase' ? !!props.nowId && !!row.members?.includes(props.nowId) : row.nodeId === props.nowId;
        const isActive = row.kind === 'phase' ? !!row.members?.some((m) => props.active.has(m)) : props.active.has(row.nodeId);
        const cls = ['pk-story-row', `kind-${row.kind}`];
        if (isActive) cls.push('active');
        if (isNow) cls.push('now');
        if (row.kind !== 'phase' && row.nodeId === props.selected) cls.push('selected');
        if (row.kind !== 'phase' && props.done.has(row.nodeId)) cls.push('done');
        const folded = effective.has(row.id);
        return (
          <div
            key={row.id}
            role="treeitem"
            aria-expanded={row.children.length ? !folded : undefined}
            class={cls.join(' ')}
            style={{ paddingLeft: `${6 + depth * 14}px` }}
            data-story={row.id}
            data-node={row.nodeId}
            ref={isNow && row.kind !== 'phase' ? nowRef : undefined}
            onClick={() => props.onSelect(row.nodeId, row.step)}
            title={`${row.label}${row.meta ? ` · ${row.meta}` : ''} · click: Time Machine to #${row.step}`}
          >
            <span
              class="pk-story-twistie"
              onClick={(e) => {
                if (!row.children.length) return;
                e.stopPropagation();
                toggle(row.id);
              }}
            >
              {row.children.length > 0 && <Icon name={folded ? 'chevron-right' : 'chevron-down'} />}
            </span>
            <Icon name={iconOf(row)} class="pk-story-icon" />
            <span class={`pk-story-label${row.kind === 'statement' ? ' pk-story-code' : ''}`}>
              {row.kind === 'ref' ? '→ ' : ''}
              {row.label}
            </span>
            {row.meta && <span class="pk-story-meta">{row.meta}</span>}
            <span class="pk-story-step">#{row.step}</span>
          </div>
        );
      })}
    </div>
  );
}
