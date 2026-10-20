/**
 * A whole value a replay copied, under the Variable pane row or the Why tree that asked for it.
 * First what was checked, in a sentence (the same steps, and every value the recording kept on the
 * way came out the same, or where one did not), then the value as a tree. Every member came with
 * the copy, so a row opens here, in the panel: nothing is loaded later, nothing runs, and nothing
 * moves the Time Machine. A member past the replay's copy limits says so instead of loading.
 */
import { useMemo, useState } from 'preact/hooks';
import type { WholeValueStatus, WholeValueView } from '../../src/shared/replayProtocol';
import { frameRows } from '../debuggerView';
import { Icon, Repr } from './ui';

const STATUS_ICON: Record<WholeValueStatus, string> = {
  pending: 'loading',
  checked: 'pass',
  path: 'info',
  differs: 'warning',
  diverged: 'warning',
  unavailable: 'info',
  error: 'error',
};

const STATUS_LABEL: Record<WholeValueStatus, string> = {
  pending: 'Replaying',
  checked: 'Checked',
  path: 'Path checked',
  differs: 'Differs',
  diverged: 'Went another way',
  unavailable: 'Not available',
  error: 'Failed',
};

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function WholeValue({ view }: { view: WholeValueView }) {
  // the root starts open: the copy was asked for to be read
  const [open, setOpen] = useState<Set<string>>(() => new Set([view.name]));
  const value = view.value;
  const rows = useMemo(() => (value ? frameRows([{ name: view.name, text: value.value ?? '', valueBag: { data: value, runtimeKey: '' } }], open) : []), [value, view.name, open]);
  const toggle = (key: string): void =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const d = view.difference;
  return (
    <div class={`pk-whole pk-whole-${view.status}`} onClick={(e) => e.stopPropagation()} aria-label={`Whole value of ${view.name}`}>
      <div class="pk-whole-status" role="status">
        <Icon name={STATUS_ICON[view.status]} class={view.status === 'pending' ? 'codicon-modifier-spin' : undefined} />
        <span class="pk-whole-label">{STATUS_LABEL[view.status]}</span>
        <span class="pk-whole-summary">
          {view.summary}
          {view.ms !== undefined && view.status !== 'pending' && view.status !== 'unavailable' ? <span class="pk-dim"> Replayed in {seconds(view.ms)}.</span> : null}
        </span>
      </div>
      {d && (
        <div class="pk-whole-diff">
          <span class="pk-dim">
            #{d.step} {d.name}:
          </span>{' '}
          <span class="pk-dim">the recording kept</span> <Repr text={d.recorded} /> <span class="pk-dim">the replay has</span> <Repr text={d.replay} />
        </div>
      )}
      {rows.length > 0 && (
        <ul class="pk-dbg-rows pk-whole-tree">
          {rows.map((r) => {
            // a member the copy did not reach (its limits): there is no child process to load it from
            const beyond = r.needsLoad || r.more;
            const twist = r.expandable && !beyond;
            return (
              <li key={r.key} class={`pk-dbg-row${r.depth ? ' pk-dbg-member' : ''}`} style={r.depth ? { paddingLeft: `${8 + r.depth * 14}px` } : undefined}>
                {twist ? (
                  <button type="button" class="pk-dbg-twist" aria-label={r.open ? `Collapse ${r.name}` : `Expand ${r.name}`} onClick={() => toggle(r.key)}>
                    <Icon name={r.open ? 'chevron-down' : 'chevron-right'} />
                  </button>
                ) : (
                  <span class="pk-dbg-twist" />
                )}
                {r.more ? (
                  <span class="pk-dbg-dim">more elements, past what a replay copies</span>
                ) : (
                  <>
                    <span class="pk-dbg-name">{r.name}</span>
                    {r.type ? <span class="pk-dbg-type">{r.type}</span> : null}
                    <span class="pk-dbg-value" title={r.text}>
                      <Repr text={r.text} />
                    </span>
                    {r.needsLoad ? <span class="pk-dbg-dim"> (deeper than a replay copies)</span> : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
