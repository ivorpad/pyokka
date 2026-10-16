/**
 * The FRAME section, the top of the Debugger view at a pause: the paused frame's variables as a
 * tree, the call stack under them, and the step controls. The initial view of a plain debug session
 * is wherever the values are (docs/HANDOFF-debugger.md, 2026-10-16), and before this section the
 * view opened on watches, breakpoints and output while the frame's dicts sat in the side bar only.
 *
 * The tree is the same `ValueNode` data the DAP Variables provider serves to VS Code. A member the
 * runtime has not sent yet (`expandable` without `props`, the `…` of a capped container) loads on
 * click through `onExpand`: the host runs `expand` in the paused run, splices the answer into the
 * locals it caches for this pause, and the next `debug.session` carries it, so an open row survives
 * every later push. Until that state arrives the row's twist spins.
 *
 * A frame click selects the frame as the Call Stack view does (the host reveals it and re-reads
 * the locals of that frame). The controls post `debug.control`; the host's seven actions already
 * existed for the Running header's Pause, Restart and Stop.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { frameParts, frameRows, libraryFoldLabel, stackRows, type FrameRow } from '../debuggerView';
import type { DebugSessionPanel, ValueNode } from '../src-shared';
import { Icon, IconButton, Repr } from './ui';

export type DebugControl = 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop';

/** A pane header: the title, a count when it helps, and actions that appear on hover. */
export function SectionHead({ title, count, note, actions }: { title: string; count?: number; note?: string; actions?: preact.ComponentChildren }) {
  return (
    <div class="pk-dbg-head">
      <span class="pk-dbg-title">{title}</span>
      {note ? <span class="pk-dbg-note">{note}</span> : null}
      {count !== undefined && count > 0 ? <span class="pk-dbg-count">{count}</span> : null}
      {actions ? <span class="pk-dbg-head-actions">{actions}</span> : null}
    </div>
  );
}

export interface FrameSectionProps {
  state: DebugSessionPanel;
  onControl?: (action: DebugControl) => void;
  onSelectFrame?: (frameId: number) => void;
  /** a member the runtime has not sent: ask for it; the next state carries it */
  onExpand?: (local: string, node: ValueNode) => void;
  /** rows open from the start (the visual harness and the tests); the view itself starts closed */
  initiallyOpen?: readonly string[];
}

export function FrameSection({ state, onControl, onSelectFrame, onExpand, initiallyOpen }: FrameSectionProps) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initiallyOpen));
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [openFolds, setOpenFolds] = useState<number[]>([]);
  // a state from the host answers every load in flight: it carries the members, or it does not
  useEffect(() => setLoading((cur) => (cur.size ? new Set() : cur)), [state.locals]);
  const rows = useMemo(() => frameRows(state.locals, open), [state.locals, open]);
  const frames = stackRows(state.stack, state.selectedFrame, new Set(openFolds));
  const selected = state.stack.find((f) => f.frameId === state.selectedFrame);

  const toggle = (row: FrameRow): void => {
    if (row.needsLoad) {
      if (!onExpand || !row.node) return;
      setLoading((cur) => new Set(cur).add(row.key));
      // the row opens on the state that brings its members
      if (!row.more) setOpen((cur) => new Set(cur).add(row.key));
      onExpand(row.local, row.node);
      return;
    }
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
  };

  return (
    <section class="pk-dbg-section pk-debug-frame">
      <SectionHead title="FRAME" note={selected ? frameParts(selected).where : undefined} count={state.locals.length} />
      {selected?.library ? (
        <div class="pk-dbg-empty">no variables: library frame</div>
      ) : state.locals.length === 0 ? (
        <div class="pk-dbg-empty">{state.localsPending ? 'reading the frame…' : 'no variables in this frame'}</div>
      ) : (
        <ul class="pk-dbg-rows pk-locals-list">
          {rows.map((r) => {
            const busy = loading.has(r.key);
            const twist = r.expandable || r.more;
            return (
              <li
                key={r.key}
                class={`pk-dbg-row${r.depth ? ' pk-dbg-member' : ''}${r.more ? ' pk-dbg-more' : ''}`}
                style={r.depth ? { paddingLeft: `${8 + r.depth * 14}px` } : undefined}
                onClick={r.more ? () => toggle(r) : undefined}
              >
                {twist ? (
                  <button type="button" class="pk-dbg-twist" aria-label={r.more ? 'Load more elements' : r.open ? `Collapse ${r.name}` : `Expand ${r.name}`} onClick={(e) => { e.stopPropagation(); toggle(r); }}>
                    <Icon name={busy ? 'loading' : r.open ? 'chevron-down' : 'chevron-right'} class={busy ? 'codicon-modifier-spin' : undefined} />
                  </button>
                ) : (
                  <span class="pk-dbg-twist" />
                )}
                {r.more ? (
                  <span class="pk-dbg-dim">{r.text}</span>
                ) : (
                  <>
                    <span class="pk-dbg-name">{r.name}</span>
                    {r.type ? <span class="pk-dbg-type">{r.type}</span> : null}
                    <span class="pk-dbg-value" title={r.text}>
                      <Repr text={r.text} />
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div class="pk-dbg-subhead">
        <span class="pk-dbg-title">CALL STACK</span>
        {state.stack.length > 0 ? <span class="pk-dbg-count">{state.stack.length}</span> : null}
      </div>
      {frames.length === 0 ? (
        <div class="pk-dbg-empty">no frames</div>
      ) : (
        <ul class="pk-dbg-rows pk-stack-list">
          {frames.map((row) =>
            row.kind === 'library' ? (
              <li key={row.key} class="pk-dbg-row pk-dbg-fold">
                <button type="button" class="pk-dbg-rowbtn" aria-label={`Show the ${libraryFoldLabel(row.frames!)}`} onClick={() => setOpenFolds((cur) => [...cur, row.frames![0]!.frameId])}>
                  <span class="pk-dbg-twist">
                    <Icon name="chevron-right" />
                  </span>
                  <span class="pk-dbg-dim pk-dbg-fold-label">{libraryFoldLabel(row.frames!)}</span>
                </button>
              </li>
            ) : (
              <li key={row.key} class={`pk-dbg-row${row.current ? ' cur' : ''}${row.frame!.library ? ' library' : ''}`} aria-current={row.current ? 'true' : undefined}>
                <button type="button" class="pk-dbg-rowbtn pk-frame-btn" onClick={() => onSelectFrame?.(row.frame!.frameId)}>
                  <span class="pk-dbg-twist">{row.current ? <Icon name="debug-stackframe" /> : null}</span>
                  <span class="pk-dbg-name">{frameParts(row.frame!).name}</span>
                  <span class="pk-dbg-where">{frameParts(row.frame!).where}</span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      {onControl && (
        <div class="pk-frame-controls" role="toolbar" aria-label="Step controls">
          <IconButton icon="debug-continue" class="pk-go" title="Continue (F5)" onClick={() => onControl('continue')} />
          <IconButton icon="debug-step-over" title="Step Over (F10)" onClick={() => onControl('stepOver')} />
          <IconButton icon="debug-step-into" title="Step Into (F11)" onClick={() => onControl('stepInto')} />
          <IconButton icon="debug-step-out" title="Step Out (Shift+F11)" onClick={() => onControl('stepOut')} />
          <IconButton icon="debug-restart" title="Restart from the top" onClick={() => onControl('restart')} />
          <IconButton icon="debug-stop" tone="stop" title="Stop the program" onClick={() => onControl('stop')} />
        </div>
      )}
    </section>
  );
}
