/**
 * Time Machine view: Timeline strip, Steps strip, LOGS with Watch expressions, Timeline Guide,
 * floating code preview. The panel is the whole run; this moment (the call stack, the variables
 * at the step, the step controls) is VS Code's Run and Debug side bar and debug toolbar, which the
 * Time Machine's replay debug session fills (src/debug/replaySession.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { flat, formatText } from '../format';
import type { CodePreview, Entry, Theme, WatchCompletions } from '../model';
import { monaco } from '../monaco';
import type { DebuggerState, TimelineModel, ValueNode } from '../src-shared';
import { capSentence, StepFlag } from '../src-shared';
import {
  callerLocation,
  centerWindow,
  clampWindow,
  ensureVisible,
  initialWindow,
  moveWindow,
  notchColumnsWithFlags,
  notchSteps,
  resizeWindow,
  snapToNotch,
  stepAtX,
  stepBlocks,
  timelineGuide,
  zoomWindow,
  type StepWindow,
} from '../timeline';
import { Icon, IconButton, Repr, SourceLink, useElementSize } from './ui';
import { AheadBlock, DebugStatus } from './DebugFrontier';
import { WatchInput } from './WatchInput';

export interface DebuggerProps {
  model: TimelineModel | null;
  state: DebuggerState;
  entries: Entry[];
  watchNodes: Map<string, ValueNode>;
  theme: Theme;
  codePreview: CodePreview | null;
  onGoto: (step: number) => void;
  onPreviewRequest: (step: number) => void;
  onAction: (action: 'toggleEcho' | 'toggleCodePreview') => void;
  onWatch: (op: 'remove' | 'refresh', id: string) => void;
  /** the + in the Watch expressions header: a new expression typed in the panel */
  onWatchAdd: (exp: string) => void;
  /** an expression changed in place (double-click or the pencil) */
  onWatchEdit: (id: string, exp: string) => void;
  /** the row's Evaluate action: one run of the file records the watch at this step (outside Automatic mode) */
  onWatchEvaluate?: (id: string) => void;
  /** the host's latest completions for the expression being typed (WatchInput.tsx) */
  completions?: WatchCompletions | null;
  /** ask the host to complete the watch expression typed so far */
  onWatchComplete?: (requestId: number, text: string) => void;
  onWatchExpand: (watchId: string, node: ValueNode) => void;
  onOpen: (fileId: number, line: number, col: number, sideView: boolean) => void;
  onCopy: (text: string) => void;
  onCommand: (command: string) => void;
  showFileName: boolean;
  /** entries list rendered under the watch expressions */
  children?: preact.ComponentChildren;
  /** details pane rendered under the guide */
  details?: preact.ComponentChildren;
}

export function DebuggerView(props: DebuggerProps) {
  const { model, state } = props;
  return (
    <div class="pk-debugger">
      {model && model.stepCount > 0 ? <Strips {...props} model={model} /> : <div class="pk-strips pk-empty">NO TRACE RECORDED</div>}
      <DebugStatus debug={state.debug} />
      <div class="pk-debugger-body">
        <section class="pk-pane pk-logs">
          <header class="pk-pane-header">
            <span class="pk-pane-title">LOGS</span>
            <span class="pk-toolbar">
              <IconButton icon="map" title="View Code Story" onClick={() => props.onCommand('pyokka.viewCodeStory')} />
            </span>
          </header>
          <div class="pk-logs-body">
            <Watches {...props} />
            {props.children}
          </div>
        </section>
        <section class={`pk-pane pk-guide-pane${props.details ? ' has-details' : ''}`}>
          <header class="pk-pane-header">
            <span class="pk-pane-title">TIMELINE GUIDE</span>
            <span class="pk-toolbar">
              <IconButton icon="broadcast" title={state.echo ? 'Hide current step echo' : 'Show current step echo'} active={state.echo} onClick={() => props.onAction('toggleEcho')} />
              <IconButton icon="open-preview" title="Toggle code preview display" active={state.codePreview} onClick={() => props.onAction('toggleCodePreview')} />
            </span>
          </header>
          <div class="pk-guide-body">{model ? <Guide model={model} /> : null}</div>
          {props.details}
        </section>
      </div>
    </div>
  );
}

/* ---------- Timeline + Steps strips ---------- */

/** Under the timeline of a run cut at the step cap: where it stopped, who spent the steps, what to exclude. */
export function CapNote({ model }: { model: TimelineModel }) {
  if (!model.truncated) return null;
  const text = model.cap
    ? capSentence(model.cap, model.stepCount)
    : `Recording stopped at step ${Math.max(0, model.stepCount - 1).toLocaleString('en-US')}: the run reached the step cap (pyokka.maxTraceSteps), and what ran after it is not recorded.`;
  return (
    <div class="pk-tl-capnote" role="status">
      {text}
    </div>
  );
}

function Strips(props: DebuggerProps & { model: TimelineModel }) {
  const { model, state } = props;
  const total = model.stepCount;
  const [stripRef, size] = useElementSize<HTMLDivElement>();
  const [win, setWin] = useState<StepWindow>({ start: 0, end: Math.min(total, 24) });
  const initialised = useRef(false);
  const [hover, setHover] = useState<{ step: number; x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);

  const notches = useMemo(() => notchSteps(model), [model]);
  const errorSteps = useMemo(() => notches.filter((s) => ((model.flags[s] ?? 0) & StepFlag.Error) !== 0), [notches, model]);
  const columns = useMemo(() => notchColumnsWithFlags(notches, errorSteps, total, size.width), [notches, errorSteps, total, size.width]);
  const echo = useMemo(() => new Set(state.echo ? state.echoSteps : []), [state.echo, state.echoSteps]);

  // first layout: size the window to the strip width; afterwards keep the current step visible
  useEffect(() => {
    if (size.width === 0) return;
    if (!initialised.current) {
      initialised.current = true;
      setWin(initialWindow(total, size.width, state.currentStep));
    }
  }, [size.width, total]);
  useEffect(() => {
    setWin((w) => ensureVisible(clampWindow(w, total), state.currentStep, total));
  }, [state.currentStep, total]);

  const pxPerStep = size.width > 0 ? size.width / total : 1;
  const blocks = useMemo(() => stepBlocks(model, win, state.currentStep, echo), [model, win, state.currentStep, echo]);
  const blockW = size.width > 0 ? size.width / Math.max(1, win.end - win.start) : 0;

  const onTimelineWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = stripRef.current?.getBoundingClientRect();
    const frac = rect ? (e.clientX - rect.left - win.start * pxPerStep) / Math.max(1, (win.end - win.start) * pxPerStep) : 0.5;
    setWin((w) => zoomWindow(w, e.deltaY > 0 ? 1.25 : 0.8, Math.max(0, Math.min(1, frac)), total));
  };

  const onStepsWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      setWin((w) => moveWindow(w, Math.sign(e.deltaX) * Math.max(1, Math.round((w.end - w.start) / 10)), total));
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = (e.clientX - rect.left) / Math.max(1, rect.width);
    setWin((w) => zoomWindow(w, e.deltaY > 0 ? 1.25 : 0.8, frac, total));
  };

  const dragWindow = (e: MouseEvent, mode: 'move' | 'start' | 'end') => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWin = win;
    const move = (ev: MouseEvent) => {
      const dSteps = (ev.clientX - startX) / pxPerStep;
      if (mode === 'move') setWin(moveWindow(startWin, Math.round(dSteps), total));
      else if (mode === 'start') setWin(resizeWindow(startWin, 'start', Math.round(startWin.start + dSteps), total));
      else setWin(resizeWindow(startWin, 'end', Math.round(startWin.end + dSteps), total));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onTimelineClick = (e: MouseEvent) => {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect) return;
    const raw = stepAtX(e.clientX - rect.left, total, rect.width);
    const locked = model.lockedBefore ?? 0;
    const step = Math.max(locked, snapToNotch(raw, notches, Math.max(1, Math.round(4 / pxPerStep))));
    props.onGoto(step);
    setWin((w) => centerWindow(w, step, total));
  };

  const onBlockEnter = (step: number, e: MouseEvent) => {
    if (!state.codePreview) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const host = stripRef.current?.parentElement?.getBoundingClientRect();
    const pos = { step, x: rect.left - (host?.left ?? 0) + rect.width / 2, y: rect.bottom - (host?.top ?? 0) };
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      setHover(pos);
      props.onPreviewRequest(step);
    }, 120);
  };
  const onBlockLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  };

  const locked = model.lockedBefore ?? 0;
  const lockedPx = (locked / total) * size.width;
  const winLeft = win.start * pxPerStep;
  const winWidth = Math.max(6, (win.end - win.start) * pxPerStep);
  const cursorX = state.currentStep * pxPerStep;
  // the debugger's frontier: the last recorded step while the run is paused there (percentages: no layout needed)
  const frontier = state.debug?.paused ? state.debug.frontier : undefined;
  const frontierPct = frontier !== undefined ? Math.min(100, ((frontier + 1) / total) * 100) : undefined;

  return (
    <div class="pk-strips">
      <div class="pk-timeline-row">
      <div class="pk-timeline" ref={stripRef} onWheel={onTimelineWheel} onClick={onTimelineClick} title="Click to jump; drag the window to scroll the steps; wheel to zoom">
        {locked > 0 && (
          <div class="pk-tl-locked" style={{ width: `${lockedPx}px` }}>
            <Icon name="lock" />
          </div>
        )}
        {model.truncated && <div class="pk-tl-truncated" title={model.cap ? capSentence(model.cap, model.stepCount) : 'Recording stopped at the step cap (pyokka.maxTraceSteps)'} />}
        {columns.map((c) => (
          <div key={c.x} class={`pk-tl-notch${c.error ? ' error' : ''}`} style={{ left: `${c.x}px` }} />
        ))}
        <div class="pk-tl-cursor" style={{ left: `${cursorX}px` }} />
        {frontierPct !== undefined && (
          <div class="pk-tl-frontier" style={{ left: `calc(${frontierPct}% - 2px)` }} title={`Frontier: the run is paused before step ${frontier}`}>
            <span class="pk-tl-frontier-label">frontier</span>
          </div>
        )}
        <div class="pk-tl-window" style={{ left: `${winLeft}px`, width: `${winWidth}px` }} onMouseDown={(e) => dragWindow(e, 'move')} onClick={(e) => e.stopPropagation()}>
          <div class="pk-tl-handle start" onMouseDown={(e) => dragWindow(e, 'start')} />
          <div class="pk-tl-handle end" onMouseDown={(e) => dragWindow(e, 'end')} />
        </div>
      </div>
      {frontier !== undefined && <AheadBlock kind="timeline" />}
      </div>
      <CapNote model={model} />
      <div class="pk-steps" onWheel={onStepsWheel}>
        {blocks.map((b) => (
          <div
            key={b.step}
            class={`pk-step${b.current ? ' current' : ''}${b.echo ? ' echo' : ''}${b.error ? ' error' : ''}${b.noMapping ? ' nomap' : ''}${b.scopeSwitch ? ' switch' : ''}${b.log ? ' log' : ''}`}
            style={{ width: `${blockW}px`, background: b.color }}
            title={b.title}
            onClick={() => props.onGoto(b.step)}
            onMouseEnter={(e) => onBlockEnter(b.step, e)}
            onMouseLeave={onBlockLeave}
          >
            {b.log && <span class="pk-step-log" />}
            {b.scopeSwitch && <span class="pk-step-switch" />}
            {blockW >= 34 && <span class="pk-step-num">#{b.step}</span>}
            {blockW >= 34 && <span class="pk-step-label">{b.label}</span>}
            {b.current && <span class="pk-step-current" />}
            {b.echo && !b.current && <span class="pk-step-echo" />}
          </div>
        ))}
        {frontier !== undefined && win.end >= total && <AheadBlock kind="steps" width={Math.max(48, blockW * 2)} />}
      </div>
      {hover && props.codePreview && props.codePreview.step === hover.step && <CodePreviewPopup preview={props.codePreview} x={hover.x} y={hover.y} theme={props.theme} />}
    </div>
  );
}

export function CodePreviewPopup({ preview, x, y, theme }: { preview: CodePreview; x: number; y: number; theme: Theme }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void monaco.editor.colorize(preview.lines.join('\n'), 'python', { tabSize: 4 }).then((html) => {
      if (cancelled || !el) return;
      const code = el.querySelector('.pk-cp-code');
      if (code) code.innerHTML = html;
    });
    return () => {
      cancelled = true;
    };
  }, [preview, theme]);
  const rows = preview.lines.length;
  return (
    <div class="pk-code-preview" ref={ref} style={{ left: `${Math.max(8, x - 160)}px`, top: `${y + 6}px` }}>
      <div class="pk-cp-head">
        <div class="pk-cp-title">
          <span class="pk-cp-step">#{preview.step}</span>
          <span class="pk-cp-fn">{preview.function}</span>
          <span class="pk-cp-loc">
            {preview.file}:{preview.highlightLine}
          </span>
        </div>
        {preview.caller && (
          <div class="pk-cp-from">
            <span>called from</span>
            <span class="pk-cp-step">#{preview.caller.step}</span>
            <span class="pk-cp-fn">{preview.caller.function}</span>
            <span class="pk-cp-loc">{callerLocation(preview.file, preview.caller)}</span>
          </div>
        )}
      </div>
      <div class="pk-cp-body">
        <div class="pk-cp-gutter">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} class={preview.startLine + i === preview.highlightLine ? 'hl' : ''}>
              {preview.startLine + i}
            </div>
          ))}
        </div>
        <div class="pk-cp-lines">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} class={`pk-cp-bg${preview.startLine + i === preview.highlightLine ? ' hl' : ''}`} />
          ))}
          <pre class="pk-cp-code">{preview.lines.join('\n')}</pre>
        </div>
      </div>
    </div>
  );
}

/* ---------- Watch expressions ---------- */

function Watches(props: DebuggerProps) {
  const { state, model } = props;
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  const some = state.watches.length > 0;
  return (
    <div class="pk-watches">
      <div class="pk-subheader pk-watch-header">
        <Icon name="eye" />
        <span>Watch expressions</span>
        <span class="pk-toolbar">
          <IconButton icon="add" title="Add watch expression" active={adding} onClick={() => setAdding((a) => !a)} />
          {some && <IconButton icon="refresh" title="Refresh all" onClick={() => state.watches.forEach((w) => props.onWatch('refresh', w.id))} />}
          {some && <IconButton icon="clear-all" title="Remove all" onClick={() => state.watches.forEach((w) => props.onWatch('remove', w.id))} />}
        </span>
      </div>
      {adding && (
        <div class="pk-row pk-watch-row">
          <WatchInput
            placeholder="expression, Enter adds it"
            completions={props.completions}
            onComplete={props.onWatchComplete}
            onSubmit={(exp) => {
              setAdding(false);
              if (exp) props.onWatchAdd(exp);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      {state.watches.map((w) => {
        const node = props.watchNodes.get(w.id) ?? w.valueBag?.data;
        const expanded = open.has(w.id);
        const line = w.step !== undefined && model ? model.lines[w.step] : undefined;
        const col = w.step !== undefined && model ? model.cols[w.step] : undefined;
        const fileId = w.step !== undefined && model ? model.fileIds[w.step] : undefined;
        return (
          <div key={w.id} class={`pk-watch${w.error ? ' error' : ''}`}>
            <div class="pk-row pk-watch-row" onClick={() => node && editing !== w.id && toggle(w.id)}>
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} class={`pk-twistie${node ? '' : ' invisible'}`} />
              {editing === w.id ? (
                <WatchInput
                  initial={w.exp}
                  placeholder="expression"
                  completions={props.completions}
                  onComplete={props.onWatchComplete}
                  onSubmit={(exp) => {
                    setEditing(undefined);
                    if (exp && exp !== w.exp) props.onWatchEdit(w.id, exp);
                  }}
                  onCancel={() => setEditing(undefined)}
                />
              ) : (
                <span
                  class="pk-watch-exp"
                  title={`${w.exp} (double-click to edit)`}
                  onDblClick={(e) => {
                    e.stopPropagation();
                    setEditing(w.id);
                  }}
                >
                  {w.error ? (
                    <>
                      <span class="pk-error-text">{w.error}</span>
                      {w.needsRun && (
                        <button
                          class="pk-why-link pk-watch-run"
                          title="Run the file once to record this expression at the current step and the next ten"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onWatchEvaluate?.(w.id);
                          }}
                        >
                          Evaluate (runs the file once)
                        </button>
                      )}
                    </>
                  ) : node ? (
                    <Repr text={flat(node)} />
                  ) : w.text !== undefined ? (
                    <>
                      <Repr text={w.text} />
                      {w.note && <span class="pk-dim pk-watch-note">{w.note}</span>}
                    </>
                  ) : (
                    <span class="pk-dim">{w.exp}</span>
                  )}
                </span>
              )}
              {line !== undefined && col !== undefined && fileId !== undefined && <SourceLink file={`file ${fileId}`} line={line} col={col} showFile={false} onOpen={(side) => props.onOpen(fileId, line, col, side)} />}
              <span class="pk-toolbar pk-watch-actions">
                <IconButton icon="edit" title="Edit expression" onClick={() => setEditing(w.id)} />
                <IconButton icon="inspect" title="Explore value" disabled={!node} onClick={() => toggle(w.id)} />
                <IconButton icon="copy" title="Copy value" disabled={!node} onClick={() => node && props.onCopy(formatText(node, { rootName: w.exp }))} />
                <IconButton icon="refresh" title="Refresh" onClick={() => props.onWatch('refresh', w.id)} />
                <IconButton icon="close" title="Remove" onClick={() => props.onWatch('remove', w.id)} />
              </span>
            </div>
            {expanded && node && <WatchValue node={node} exp={w.exp} onLoad={(n) => props.onWatchExpand(w.id, n)} />}
          </div>
        );
      })}
    </div>
  );
}

function WatchValue({ node, exp, onLoad }: { node: ValueNode; exp: string; onLoad: (n: ValueNode) => void }) {
  const lines = useMemo(() => formatText(node, { rootName: exp }).split('\n'), [node, exp]);
  return (
    <pre class="pk-watch-value">
      {lines.map((l, i) => (
        <div key={i} class={l.trim() === '…' ? 'pk-load-line' : ''} onClick={l.trim() === '…' ? () => onLoad(node) : undefined}>
          <Repr text={l} />
        </div>
      ))}
    </pre>
  );
}

/* ---------- right column ---------- */

function Guide({ model }: { model: TimelineModel }) {
  const rows = useMemo(() => timelineGuide(model), [model]);
  return (
    <ul class="pk-guide">
      {rows.map((r) => (
        <li key={r.scopeId}>
          <span class="pk-guide-swatch" style={{ background: r.color }} />
          <span>{r.name}</span>
        </li>
      ))}
    </ul>
  );
}
