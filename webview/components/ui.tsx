/** Small shared widgets: icon buttons, dropdown menus, highlighted repr text. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { tokenize } from '../highlight';

export function Icon({ name, class: cls, flip }: { name: string; class?: string; flip?: boolean }) {
  return <i class={`codicon codicon-${name}${flip ? ' pk-flip' : ''}${cls ? ' ' + cls : ''}`} aria-hidden="true" />;
}

export interface IconButtonProps {
  icon: string;
  title: string;
  onClick?: (ev: MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  class?: string;
  flip?: boolean;
  tone?: 'back' | 'forward' | 'stop';
  /** codicon spin animation (a running state) */
  spin?: boolean;
}

/* ---------- tooltips ----------
 * Native `title` tooltips in a VS Code webview take about a second to appear, so the toolbar
 * icons were hard to tell apart. One fixed-position element shows the label after 150 ms,
 * below the button, or to its left when the button sits at the right edge (the rail). */
let tipEl: HTMLDivElement | null = null;
let tipTimer: number | null = null;

export function showTip(target: HTMLElement, text: string): void {
  hideTip();
  tipTimer = window.setTimeout(() => {
    tipTimer = null;
    if (!target.isConnected) return;
    const el = tipEl ?? (tipEl = document.body.appendChild(document.createElement('div')));
    el.className = 'pk-tip';
    el.textContent = text;
    el.style.display = 'block';
    const r = target.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left: number;
    let top: number;
    if (window.innerWidth - r.right < 48) {
      left = r.left - 6 - w;
      top = r.top + r.height / 2 - h / 2;
    } else {
      left = r.left + r.width / 2 - w / 2;
      top = r.bottom + 4;
      if (top + h > window.innerHeight - 4) top = r.top - 4 - h;
    }
    left = Math.max(4, Math.min(left, window.innerWidth - 4 - w));
    top = Math.max(4, Math.min(top, window.innerHeight - 4 - h));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, 150);
}

export function hideTip(): void {
  if (tipTimer !== null) {
    clearTimeout(tipTimer);
    tipTimer = null;
  }
  if (tipEl) tipEl.style.display = 'none';
}

export function IconButton({ icon, title, onClick, active, disabled, class: cls, flip, tone, spin }: IconButtonProps) {
  return (
    <button
      type="button"
      class={`pk-icon-btn${active ? ' active' : ''}${tone ? ' tone-' + tone : ''}${cls ? ' ' + cls : ''}`}
      aria-label={title}
      data-tip={title}
      disabled={disabled}
      onMouseEnter={(e) => showTip(e.currentTarget as HTMLElement, title)}
      onMouseLeave={hideTip}
      onClick={(e) => {
        e.stopPropagation();
        hideTip();
        onClick?.(e);
      }}
    >
      <Icon name={icon} flip={flip} class={spin ? 'codicon-modifier-spin' : undefined} />
    </button>
  );
}

export interface MenuItem {
  label: string;
  checked?: boolean;
  /** shows a check column even when unchecked (toggle items) */
  toggle?: boolean;
  hint?: string;
  onSelect?: () => void;
  separatorAbove?: boolean;
  disabled?: boolean;
  /** custom content instead of label */
  render?: () => ComponentChildren;
  keepOpen?: boolean;
}

export function Menu({ items, onClose, align = 'right', class: cls }: { items: MenuItem[]; onClose: () => void; align?: 'left' | 'right'; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // defer so the opening click does not close it
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const hasChecks = items.some((i) => i.toggle || i.checked !== undefined);
  return (
    <div class={`pk-menu align-${align}${cls ? ' ' + cls : ''}`} ref={ref} role="menu">
      {items.map((item, i) => (
        <div key={i} class={`pk-menu-item-wrap${item.separatorAbove ? ' sep' : ''}`}>
          <button
            type="button"
            role="menuitem"
            class={`pk-menu-item${item.disabled ? ' disabled' : ''}`}
            disabled={item.disabled}
            onClick={(e) => {
              e.stopPropagation();
              item.onSelect?.();
              if (!item.keepOpen) onClose();
            }}
          >
            {hasChecks && <span class="pk-menu-check">{item.checked ? <Icon name="check" /> : null}</span>}
            <span class="pk-menu-label">{item.render ? item.render() : item.label}</span>
            {item.hint && <span class="pk-menu-hint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

/** an icon button that opens a menu below itself */
export function MenuButton({ icon, title, items, active, align = 'right', disabled }: { icon: string; title: string; items: () => MenuItem[]; active?: boolean; align?: 'left' | 'right'; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span class="pk-menu-anchor">
      <IconButton icon={icon} title={title} active={active || open} disabled={disabled} onClick={() => setOpen((o) => !o)} />
      {open && <Menu items={items()} onClose={() => setOpen(false)} align={align} />}
    </span>
  );
}

/** one-line Python repr with token colours */
export function Repr({ text, class: cls }: { text: string; class?: string }) {
  const tokens = tokenize(text);
  return (
    <span class={`pk-repr${cls ? ' ' + cls : ''}`}>
      {tokens.map((t, i) => (
        <span key={i} class={`tk-${t.cls}`}>
          {t.text}
        </span>
      ))}
    </span>
  );
}

export function Checkbox({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label?: ComponentChildren; title?: string }) {
  return (
    <label class="pk-checkbox" title={title} onClick={(e) => e.stopPropagation()}>
      <span class={`pk-checkbox-box${checked ? ' checked' : ''}`} onClick={() => onChange(!checked)} role="checkbox" aria-checked={checked} tabIndex={0} onKeyDown={(e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!checked); } }}>
        {checked && <Icon name="check" />}
      </span>
      {label !== undefined && (
        <span class="pk-checkbox-label" onClick={() => onChange(!checked)}>
          {label}
        </span>
      )}
    </label>
  );
}

export function SourceLink({ file, line, col, showFile, onOpen, class: cls }: { file: string; line: number; col: number; showFile?: boolean; onOpen: (sideView: boolean) => void; class?: string }): JSX.Element {
  const label = showFile ? `${file}:${line}` : `${line}:${col + 1}`;
  return (
    <span class={`pk-srclink${cls ? ' ' + cls : ''}`}>
      <a
        href="#"
        title={`${file}:${line}:${col + 1}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen(false);
        }}
      >
        {label}
      </a>
      <IconButton icon="eye" title="Open to the side" class="pk-eye" onClick={() => onOpen(true)} />
    </span>
  );
}

export function useElementSize<T extends HTMLElement>(): [{ current: T | null }, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
