/**
 * The Debugger view (docs/design/debugger-product.md, 5.1): one live `record: false` session.
 * Where it is paused and why, the watches, the breakpoints, where an exception pauses, and the
 * program's output as it arrives. No timeline and no step numbers: nothing is recorded. The call
 * stack, the paused frame's variables and the step controls are VS Code's Run and Debug side bar
 * and debug toolbar, over the same debug session; the panel does not repeat them.
 *
 * It is built to read like VS Code's own Run and Debug sections: 22px rows with a hover
 * background, section headers as pane headers with a count and hover actions, the interface font
 * for labels and the editor font only for code, paths, expressions and values. `test/visual`
 * renders it into a headless browser so the result is judged as pixels.
 *
 * There is no exec box: the Debug Console is where code runs, and this output pane is read-only.
 *
 * While the program runs the sections are ordered by what is live (5.6): output first and given the
 * free space, because a watch has no value until a stop, and because output is the only thing that
 * changes for however long the program takes. At a stop the order goes back to watches, output. The activity row above the pane answers
 * the question a spinner cannot — whether a program that has printed nothing for twenty seconds is
 * still working — out of what the host already knows: elapsed, bytes, and when the last byte came.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { breakpointRows, launchSummary, reasonIcon, watchArg, watchBadge, watchValue, type WatchMode } from '../debuggerView';
import { activity, buildRows, duration, rowsText, size, visibleRows, type OutputRow } from '../outputLines';
import type { SgrStyle } from '../ansi';
import type { DebugSessionPanel, ViewId } from '../src-shared';
import { copyText } from '../vscode';
import { Icon, IconButton, Repr } from './ui';

export interface DebugSessionViewProps {
  state: DebugSessionPanel;
  onOpen: (file: string, line: number) => void;
  onWatchAdd: (exp: string, breakWhen?: 'change' | 'true') => void;
  onWatchRemove: (id: string) => void;
  onBreakpointRemove: (file: string, line?: number, fn?: string) => void;
  onExceptions: (mode: 'off' | 'uncaught' | 'raised') => void;
  onView?: (view: ViewId) => void;
}

/** A pane header: the title, a count when it helps, and actions that appear on hover. */
function SectionHead({ title, count, note, actions }: { title: string; count?: number; note?: string; actions?: preact.ComponentChildren }) {
  return (
    <div class="pk-dbg-head">
      <span class="pk-dbg-title">{title}</span>
      {note ? <span class="pk-dbg-note">{note}</span> : null}
      {count !== undefined && count > 0 ? <span class="pk-dbg-count">{count}</span> : null}
      {actions ? <span class="pk-dbg-head-actions">{actions}</span> : null}
    </div>
  );
}

export function DebugSessionView({ state, onOpen, onWatchAdd, onWatchRemove, onBreakpointRemove, onExceptions, onView }: DebugSessionViewProps) {
  const [watchText, setWatchText] = useState('');
  const [watchMode, setWatchMode] = useState<WatchMode>('display');
  const [adding, setAdding] = useState(false);
  const elapsed = useRunClock(state.elapsed, !state.paused && state.running);
  const paused = state.paused;
  const live = !paused && state.running;
  const outputRows = useMemo(() => buildRows(state.output, state.outputOpen), [state.output, state.outputOpen]);
  // resolved breakpoints first, then the pending ones muted, then one line per file not in this run
  const rows = breakpointRows(state.breakpoints, state.files);
  const bpCount = state.breakpoints.length;

  const outputSection = (
    <OutputPane
      rows={outputRows}
      dropped={state.outputDropped}
      bytes={state.output.reduce((n, c) => n + c.text.length, 0) + (state.outputOpen?.text.length ?? 0)}
      grow={live}
    />
  );

  return (
    <div class="pk-debug-view">
      <div class="pk-header">
        <span class="pk-session">
          Debugger · {state.displayName}
          {!paused && state.running ? <i class="codicon codicon-loading codicon-modifier-spin" /> : null}
        </span>
        <span class="pk-toolbar">
          {onView && <IconButton icon="close" title="Close the Debugger view" onClick={() => onView('output')} />}
        </span>
      </div>

      <div class={`pk-debug-status pk-dbg-status${paused ? '' : ' running'}`}>
        <Icon name={reasonIcon(state)} class={!paused && state.running ? 'codicon-modifier-spin' : undefined} />
        {paused ? (
          <>
            <span class="pk-dbg-lead">Paused at</span>
            <button type="button" class="pk-dbg-loc" title={`Reveal ${state.location}`} onClick={() => openLocation(state.location, onOpen)}>
              {state.location}
            </button>
            <span class="pk-dbg-chip">{state.exception ? 'exception' : state.reasonText}</span>
          </>
        ) : (
          <>
            <span class="pk-dbg-lead">{state.running ? 'Running' : 'The program ended'}</span>
            <span class="pk-dbg-hint">{state.running ? 'it stops at a breakpoint, an exception, or a pause' : ''}</span>
          </>
        )}
        {state.thread && <span class="pk-dbg-chip pk-dbg-thread">{state.thread.name}</span>}
      </div>
      <div class="pk-debug-launch" title={state.launchTitle}>
        {launchSummary(state.launch)}
      </div>
      {state.modified && (
        <div class="pk-dbg-warn">
          <Icon name="warning" />
          Values were changed from the console: they are no longer the program&rsquo;s own.
        </div>
      )}
      {state.exception && (
        <div class="pk-dbg-error">
          <Icon name="error" />
          <span>
            {state.exception.uncaught ? 'uncaught' : 'raised'} <b>{state.exception.type}</b>: {state.exception.message}
          </span>
        </div>
      )}

      {live && <RunActivity state={state} elapsed={elapsed} />}

      {/*
       * Two columns once the panel is wide enough (the container query in debug.css): the pause
       * context on the left, output on the right. Narrow, the grid does not apply and the columns
       * stack, so the view keeps the single column it has always had — with `order` putting output
       * above the context while the program runs, which is the only section with anything in it then.
       */}
      <div class={`pk-debug-cols${live ? ' running' : ''}`}>
        <div class="pk-debug-col pk-debug-context">
      <section class="pk-dbg-section pk-debug-watches">
        <SectionHead
          title="WATCHES"
          count={state.watches.length}
          actions={<IconButton icon="add" title="Add a watch expression" onClick={() => setAdding(true)} />}
        />
        {state.watches.length === 0 && !adding ? <div class="pk-dbg-empty">no watches</div> : null}
        <ul class="pk-dbg-rows pk-watch-list">
          {state.watches.map((w) => {
            const badge = watchBadge(w);
            const value = watchValue(w, live);
            return (
              <li key={w.id} class="pk-dbg-row">
                <span class="pk-dbg-twist" />
                <span class="pk-dbg-exp">{w.exp}</span>
                {badge ? <span class="pk-dbg-badge">{badge}</span> : null}
                {value.text ? (
                  <span class={`pk-dbg-value${value.dim ? ' pk-dbg-dim' : ''}`} title={value.text}>
                    {value.dim ? value.text : <Repr text={value.text} />}
                  </span>
                ) : (
                  <span class="pk-dbg-value" />
                )}
                <span class="pk-dbg-row-actions">
                  <IconButton icon="close" title={`Remove ${w.exp}`} onClick={() => onWatchRemove(w.id)} />
                </span>
              </li>
            );
          })}
        </ul>
        {adding && (
          <form
            class="pk-watch-add"
            onSubmit={(e) => {
              e.preventDefault();
              const exp = watchText.trim();
              if (!exp) return;
              onWatchAdd(exp, watchArg(watchMode));
              setWatchText('');
              setWatchMode('display');
              setAdding(false);
            }}
          >
            {/*
             * The mode names the two break kinds the way `--break-when true|change` already does on
             * the CLI, and it is a select rather than a modifier on submit so it can be found with a
             * mouse: until now the form dropped its second argument and `+` could only ever make a
             * displayed watch, which left break-when reachable from the CLI alone.
             */}
            <select
              class="pk-watch-mode"
              aria-label="What this watch does"
              value={watchMode}
              onChange={(e) => setWatchMode((e.currentTarget as HTMLSelectElement).value as WatchMode)}
            >
              <option value="display">watch</option>
              <option value="true">break when true</option>
              <option value="change">break on change</option>
            </select>
            <input
              class="pk-watch-input"
              type="text"
              aria-label="Watch expression"
              placeholder={watchMode === 'display' ? 'watch an expression' : 'pause when this expression ' + (watchMode === 'true' ? 'is true' : 'changes')}
              autofocus
              value={watchText}
              onInput={(e) => setWatchText((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setAdding(false);
              }}
            />
          </form>
        )}
      </section>

      <section class="pk-dbg-section pk-debug-breakpoints">
        <SectionHead
          title="BREAKPOINTS"
          count={bpCount}
          actions={
            <>
              <label class="pk-dbg-select">
                pause on
                <select aria-label="Pause on exception" value={state.exceptions} onChange={(e) => onExceptions((e.currentTarget as HTMLSelectElement).value as 'off' | 'uncaught' | 'raised')}>
                  <option value="off">no exception</option>
                  <option value="uncaught">uncaught exceptions</option>
                  <option value="raised">every raise</option>
                </select>
              </label>
              {bpCount > 0 && <IconButton icon="clear-all" title="Remove every breakpoint" onClick={() => removeAll(rows, onBreakpointRemove)} />}
            </>
          }
        />
        {rows.length === 0 ? (
          <div class="pk-dbg-empty">no breakpoints; click a gutter to add one</div>
        ) : (
          <ul class="pk-dbg-rows pk-bp-list">
            {rows.map((row) =>
              row.group ? (
                // every breakpoint of a file this run never instrumented: one muted line, not four rows
                <li key={row.key} class="pk-dbg-row unresolved">
                  <span class="pk-dbg-twist">
                    <Icon name="debug-breakpoint-unverified" class="pk-dbg-bp-off" />
                  </span>
                  <span class="pk-dbg-dim pk-bp-group">{row.label}</span>
                  <span class="pk-dbg-row-actions">
                    <IconButton icon="close" title={`Remove the ${row.group.count} breakpoints in ${row.group.file}`} onClick={() => onBreakpointRemove(row.group!.file)} />
                  </span>
                </li>
              ) : (
                <li key={row.key} class={`pk-dbg-row${row.muted ? ' unresolved' : ''}`}>
                  <button type="button" class="pk-dbg-rowbtn" disabled={!row.bp!.line} onClick={() => row.bp!.line && onOpen(row.bp!.file, row.bp!.line)}>
                    <span class="pk-dbg-twist">
                      <Icon name={row.muted ? 'debug-breakpoint-unverified' : 'debug-breakpoint'} class={row.muted ? 'pk-dbg-bp-off' : 'pk-dbg-bp-on'} />
                    </span>
                    {row.bp!.function ? <span class="pk-dbg-name">{row.bp!.function}</span> : null}
                    <span class="pk-dbg-where">
                      {row.bp!.file}
                      {row.bp!.line ? <span class="pk-dbg-line">:{row.bp!.line}</span> : null}
                    </span>
                    {row.bp!.condition ? <span class="pk-dbg-dim pk-dbg-cond">if {row.bp!.condition}</span> : null}
                    {row.muted ? <span class="pk-dbg-dim pk-dbg-cond">not resolved yet</span> : null}
                    {row.bp!.error ? <span class="pk-dbg-dim pk-dbg-cond">({row.bp!.error})</span> : null}
                  </button>
                  <span class="pk-dbg-row-actions">
                    <IconButton icon="close" title="Remove this breakpoint" onClick={() => onBreakpointRemove(row.bp!.file, row.bp!.line, row.bp!.function)} />
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

        </div>
        <div class="pk-debug-col pk-debug-outcol">{outputSection}</div>
      </div>
    </div>
  );
}

/**
 * The run clock. The host stamps `elapsed` on every state it sends, but a program that is awaiting
 * sends nothing at all, which is exactly when the reader wants a clock: it is carried on locally
 * between messages and re-anchored whenever the host speaks.
 */
function useRunClock(hostElapsed: number, running: boolean): number {
  const anchor = useRef({ elapsed: hostElapsed, at: Date.now() });
  const [, tick] = useState(0);
  useEffect(() => {
    anchor.current = { elapsed: hostElapsed, at: Date.now() };
    tick((n) => n + 1);
  }, [hostElapsed]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [running]);
  return anchor.current.elapsed + (running ? Math.max(0, Date.now() - anchor.current.at) : 0);
}

/** How quiet counts as worth pointing out: past this the idle reading is highlighted. */
const STALE_MS = 4000;

/**
 * What a spinner cannot say: how long the program has run, how much it has printed, how long ago
 * that was, and the shape of the last twenty seconds. Every figure is measured, none is a guess
 * about where the program is — the runtime is not asked anything to draw this.
 */
function RunActivity({ state, elapsed }: { state: DebugSessionPanel; elapsed: number }) {
  const bytes = state.output.reduce((n, c) => n + c.text.length, 0) + (state.outputOpen?.text.length ?? 0);
  const idle = state.lastOutputAt === null ? null : Math.max(0, elapsed - state.lastOutputAt);
  const trace = useMemo(() => activity(state.output, state.outputOpen, elapsed), [state.output, state.outputOpen, Math.floor(elapsed / 500)]);
  return (
    <div class="pk-dbg-activity">
      <span class="pk-dbg-elapsed" title="how long this run has been going">{duration(elapsed)}</span>
      <Sparkline values={trace} />
      <span class="pk-dbg-printed">{bytes > 0 ? size(bytes) : 'nothing'} printed</span>
      <span class={`pk-dbg-idle${idle !== null && idle > STALE_MS ? ' stale' : ''}`}>
        {idle === null ? 'no output yet' : `${duration(idle)} ago`}
      </span>
    </div>
  );
}

/** Characters per half second over the last twenty, as an area and a line. */
function Sparkline({ values }: { values: number[] }) {
  const w = 96;
  const h = 16;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`);
  return (
    <svg class="pk-dbg-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`output per half second over the last ${Math.round((values.length * 500) / 1000)} seconds`}>
      <path class="pk-dbg-spark-area" d={`M0,${h} L${points.join(' L')} L${w},${h} Z`} />
      <polyline class="pk-dbg-spark-line" points={points.join(' ')} />
    </svg>
  );
}

/**
 * The output pane. It follows its own tail, and parks when the reader scrolls up — the `atBottom`
 * rule the run-all list has always had (Entries.tsx) and this pane never did, so the tail simply ran
 * off the bottom while the program printed. stderr keeps its own colour and can be filtered out;
 * a long silence is drawn between the rows either side of it.
 */
function OutputPane({ rows, dropped, bytes, grow }: { rows: OutputRow[]; dropped: number; bytes: number; grow: boolean }) {
  const [showStderr, setShowStderr] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [following, setFollowing] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const shown = useMemo(() => visibleRows(rows, showStderr), [rows, showStderr]);
  const stderrCount = rows.length - visibleRows(rows, false).length;

  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, shown[shown.length - 1]?.spans]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    atBottom.current = bottom;
    if (bottom !== following) setFollowing(bottom);
  };

  const toBottom = () => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = true;
    setFollowing(true);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <section class={`pk-dbg-section pk-debug-output${grow ? ' pk-dbg-grow' : ''}`}>
      <SectionHead
        title="OUTPUT"
        note={bytes > 0 ? size(bytes) : undefined}
        actions={
          <>
            {stderrCount > 0 && (
              <IconButton
                icon="list-filter"
                title={showStderr ? `Hide the ${stderrCount} stderr lines` : 'Show stderr'}
                onClick={() => setShowStderr(!showStderr)}
              />
            )}
            <IconButton icon="word-wrap" title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'} onClick={() => setWrap(!wrap)} />
            <IconButton icon="copy" title="Copy the output" onClick={() => copyText(rowsText(shown))} />
          </>
        }
      />
      {shown.length === 0 ? (
        <div class="pk-dbg-empty">the program has printed nothing yet</div>
      ) : (
        <div class="pk-output-wrap">
          <div class={`pk-output-pane${wrap ? '' : ' nowrap'}`} ref={listRef} onScroll={onScroll} role="log" aria-live="off">
            {dropped > 0 && <div class="pk-output-cut">{size(dropped)} dropped from the start of the run</div>}
            {shown.map((row) => (
              <>
                {row.gap !== undefined && <div class="pk-output-gap">{duration(row.gap)} with no output</div>}
                <div key={row.key} class={`pk-output-row${row.stream === 'stderr' ? ' stderr' : ''}`}>
                  <span class="pk-output-at">{row.clock}</span>
                  <span class="pk-output-text">
                    {row.spans.map((sp, i) => (
                      <span key={i} style={spanStyle(sp.style)}>
                        {sp.text}
                      </span>
                    ))}
                    {row.open && <span class="pk-output-caret" />}
                  </span>
                </div>
              </>
            ))}
          </div>
          {!following && (
            <button type="button" class="pk-output-tail" onClick={toBottom}>
              <Icon name="arrow-down" /> follow the output
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** One decoded SGR run as inline style; `reverse` swaps the two colours the way a terminal does. */
function spanStyle(style: SgrStyle): Record<string, string> {
  const fg = style.reverse ? (style.bg ?? 'var(--pk-bg)') : style.fg;
  const bg = style.reverse ? (style.fg ?? 'var(--pk-fg)') : style.bg;
  const out: Record<string, string> = {};
  if (fg) out.color = fg;
  if (bg) out.background = bg;
  if (style.bold) out.fontWeight = '600';
  if (style.dim) out.opacity = '0.7';
  if (style.italic) out.fontStyle = 'italic';
  if (style.underline) out.textDecoration = 'underline';
  return out;
}

/** `api/main.py:52` as a file and a line, for the status row's reveal. */
function openLocation(location: string, onOpen: (file: string, line: number) => void): void {
  const i = location.lastIndexOf(':');
  if (i <= 0) return;
  const line = Number(location.slice(i + 1));
  if (Number.isInteger(line) && line >= 1) onOpen(location.slice(0, i), line);
}

/** The header's remove-all: every row the list shows, collapsed groups included. */
function removeAll(rows: ReturnType<typeof breakpointRows>, onBreakpointRemove: (file: string, line?: number, fn?: string) => void): void {
  for (const row of rows) {
    if (row.group) onBreakpointRemove(row.group.file);
    else if (row.bp) onBreakpointRemove(row.bp.file, row.bp.line, row.bp.function);
  }
}
