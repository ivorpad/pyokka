/**
 * The live debugger's controls under the code pane: what VS Code's debug toolbar and Run and Debug
 * side bar show for a `record: false` session (continue, pause, step over / into / out, restart,
 * stop; where it is paused and why; the call stack; the selected frame's variables). The panel's
 * Debugger view keeps the watches, breakpoints, exceptions and output, as it does in VS Code.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ValueNode } from '../src/shared/protocol';
import { tokenize } from '../webview/highlight';
import type { DebugHost, LocalVar } from './debugHost';
import { runtimeCapped } from './pausedValues';

type Inspector = Pick<DebugHost, 'expandNode'>;

/** A Python repr, coloured by the tokenizer the panel's value rows use. */
export function ValueSyntax({ text }: { text: string }) {
  return <>{tokenize(text).map((t, i) => <span key={i} class={`pkw-token-${t.cls}`}>{t.text}</span>)}</>;
}

/** A string longer than this, or one with a line break, opens to its full captured text. */
const LONG_STRING = 80;

/** What a closed row shows: the runtime's repr preview, a string quoted, a newline as `\n`. */
export function valuePreview(node: ValueNode): string {
  if (node.circular) return '[Circular]';
  if (node.type === 'str') return JSON.stringify(node.value ?? '') + (node.capped ? '…' : '');
  return node.value ?? node.type;
}

export function valueExpandable(node: ValueNode): boolean {
  if (node.circular) return false;
  if (node.props?.length || node.expandable || node.functionSource) return true;
  return node.type === 'str' && ((node.value?.length ?? 0) > LONG_STRING || /[\r\n]/.test(node.value ?? ''));
}

/**
 * One value as a tree row: a click opens it one level, loading the children from the paused
 * frame's value store when the pause captured only the container's preview.
 */
export function ValueTree({ node, name, debug, initialOpen = false }: { node: ValueNode; name: string; debug: Inspector; initialOpen?: boolean }) {
  const [value, setValue] = useState(node);
  const [open, setOpen] = useState(initialOpen);
  const [message, setMessage] = useState('');
  useEffect(() => setValue(node), [node]);
  const toggle = async () => {
    setOpen(!open);
    if (open || !value.expandable || value.props?.length) return;
    setMessage('Loading…');
    try {
      const more = await debug.expandNode(value);
      if (more) setValue(more);
      setMessage(more ? '' : 'More detail is unavailable for this pause.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };
  const expandable = valueExpandable(value);
  const props = value.props?.filter((p) => !p.loadActionNode);
  const row = (
    <>
      <i class={`codicon codicon-${expandable ? (open ? 'chevron-down' : 'chevron-right') : 'blank'}`} />
      <span class="pkw-value-name">{name}</span>
      <span class="pkw-value-colon">:</span>
      <span class="pkw-value-preview"><ValueSyntax text={valuePreview(value)} /></span>
    </>
  );
  return (
    <div class={`pkw-value-tree${open ? ' open' : ''}`}>
      {expandable ? (
        <button type="button" class="pkw-value-toggle" aria-label={`Inspect ${name}`} aria-expanded={open} title={valuePreview(value)} onClick={() => void toggle()}>{row}</button>
      ) : (
        <div class="pkw-value-row" title={valuePreview(value)}>{row}</div>
      )}
      {open && expandable ? (
        <div class="pkw-value-children">
          {message ? <div class="pkw-value-note">{message}</div> : null}
          {value.type === 'str' ? <pre class="pkw-value-string">{value.value}</pre> : null}
          {value.functionSource ? <pre class="pkw-function-source"><ValueSyntax text={value.functionSource} /></pre> : null}
          {props?.map((p, i) => <ValueTree key={`${p.name}:${i}`} node={p} name={p.keyRepr ?? p.name} debug={debug} />)}
          {value.cappedProps || value.cappedElements ? <div class="pkw-value-note">The runtime kept the first {props?.length ?? 0} of {value.length ?? 'more'}.</div> : null}
          {value.type === 'str' && value.capped ? <div class="pkw-value-note">The runtime kept the first {value.value?.length} of {value.length} characters.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A variable of the selected frame: its captured value as a tree, or its text when the runtime sent no value. */
function Variable({ v, debug }: { v: LocalVar; debug: Inspector }) {
  if (v.valueBag) return <div class="pkw-variable" data-variable-name={v.name}><ValueTree node={v.valueBag.data} name={v.name} debug={debug} /></div>;
  return (
    <details class="pkw-variable" data-variable-name={v.name}>
      <summary class="pkw-debug-row" title={v.text}>
        <span class="pkw-debug-name">{v.name}</span>
        <span class="pkw-debug-value"><ValueSyntax text={v.text} /></span>
      </summary>
      <div class="pkw-variable-detail">
        <pre><ValueSyntax text={v.text} /></pre>
        {runtimeCapped(undefined, v.text) ? <div class="pkw-value-note">The runtime limited this preview; no structured detail is available.</div> : null}
      </div>
    </details>
  );
}

/** Pointer capture keeps the drag going when the pointer leaves the thin handle. preventDefault
 * also stops the browser focusing it, so it takes focus here and the arrow keys work after a click. */
function dragSeparator(event: PointerEvent, move: (e: PointerEvent) => void) {
  const el = event.currentTarget as HTMLElement;
  event.preventDefault();
  el.focus();
  el.setPointerCapture(event.pointerId);
  const finish = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', finish);
    el.removeEventListener('pointercancel', finish);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

type Action = 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut' | 'restart' | 'stop';

function Btn({ icon, title, disabled, onClick }: { icon: string; title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" class="pkw-btn" title={title} disabled={disabled} onClick={onClick}>
      <i class={`codicon codicon-${icon}`} />
    </button>
  );
}

export function DebugPane({ debug, onShowView, onLayout = () => {} }: { debug: DebugHost; onShowView: () => void; onLayout?: () => void }) {
  const state = debug.state();
  if (!state) return null;
  const paused = state.paused;
  const live = state.running;
  const act = (a: Action) => void debug.control(a);
  // the height lives on #pkw-debugpane, which a re-render of the pane leaves alone
  const height = (el: HTMLElement, pixels: number) => {
    const wrapper = el.closest('#pkw-debugpane') as HTMLElement;
    const total = wrapper.parentElement!.clientHeight;
    wrapper.style.height = `${Math.max(90, Math.min(total - 100, pixels))}px`;
    onLayout();
  };
  return (
    <div class="pkw-debug">
      <div
        class="pkw-debug-resize"
        role="separator"
        aria-label="Debugger height"
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={(e) => {
          const el = e.currentTarget;
          const bottom = el.closest('#pkw-debugpane')!.getBoundingClientRect().bottom;
          dragSeparator(e, (p) => height(el, bottom - p.clientY));
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          height(e.currentTarget, e.currentTarget.closest('#pkw-debugpane')!.clientHeight + (e.key === 'ArrowUp' ? 20 : -20));
        }}
      />
      <div class="pkw-debug-bar">
        <span class="pkw-debug-title">
          <i class="codicon codicon-debug-alt" /> Debugger
        </span>
        <span class="pkw-debug-reason" title={state.location}>
          {paused ? `${state.reasonText} · ${state.location}` : state.reasonText}
        </span>
        <span class="pkw-spacer" />
        {live && !paused ? <Btn icon="debug-pause" title="Pause" onClick={() => act('pause')} /> : <Btn icon="debug-continue" title="Continue (F5)" disabled={!paused} onClick={() => act('continue')} />}
        <button type="button" class="pkw-btn" title="Step: the next executed statement, including calls" aria-label="Step" disabled={!paused} onClick={() => act('stepInto')}>
          <i class="codicon codicon-debug-step-into pkw-step-forward" />
        </button>
        <Btn icon="debug-step-over" title="Step over (F10)" disabled={!paused} onClick={() => act('stepOver')} />
        <Btn icon="debug-step-into" title="Step into (F11)" disabled={!paused} onClick={() => act('stepInto')} />
        <Btn icon="debug-step-out" title="Step out (Shift+F11)" disabled={!paused} onClick={() => act('stepOut')} />
        <Btn icon="debug-restart" title="Restart" onClick={() => act('restart')} />
        {live ? <Btn icon="debug-stop" title="Stop" onClick={() => act('stop')} /> : null}
        <Btn icon="output" title="Watches, breakpoints and output (the Debugger view)" onClick={onShowView} />
      </div>
      {paused ? (
        <div class="pkw-debug-body">
          <div class="pkw-debug-col">
            <div class="pkw-debug-head">CALL STACK</div>
            {state.stack.map((f, i) => (
              <div key={i} class={`pkw-debug-row${i === state.selectedFrame ? ' selected' : ''}${f.library ? ' dim' : ''}`} onClick={() => void debug.selectFrame(i)} title={`${f.file}:${f.line}`}>
                <span class="pkw-debug-name">{f.name}</span>
                <span class="pkw-debug-loc">
                  {f.file.split('/').pop()}:{f.line}
                </span>
              </div>
            ))}
          </div>
          <div class="pkw-debug-col">
            <div class="pkw-debug-head">VARIABLES</div>
            {state.locals.length ? (
              state.locals.map((v) => <Variable key={`${state.id}:${debug.paused?.step}:${state.selectedFrame}:${v.name}`} v={v} debug={debug} />)
            ) : (
              <div class="pkw-debug-row dim">none in this frame</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
