/**
 * The watch expression input: one line of text, Enter submits, Escape cancels, and a completion
 * dropdown while typing. The host answers `watch.complete` with the names in scope for a bare
 * prefix or the object's attributes after a dot (docs/PROTOCOL.md, `complete`); answers to older
 * requests are dropped by requestId. Up/Down choose, Tab or Enter accept (Enter submits instead
 * when the choice is already typed out), Escape closes the list first. Tab with no list asks for
 * one and stays in the field; leaving the field (a click elsewhere, to copy a value) keeps what
 * was typed and only closes the list, so the text is still there on return.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WatchCompletions } from '../model';
import type { CompletionItem } from '../src-shared';
import { requestId } from '../vscode';
import { applyCompletion, completionHead, iconForKind } from '../watchComplete';
import { Icon } from './ui';

export interface WatchInputProps {
  initial?: string;
  placeholder: string;
  onSubmit: (exp: string) => void;
  onCancel: () => void;
  /** the latest answer from the host; absent when the panel has no completion source */
  completions?: WatchCompletions | null;
  /** ask the host to complete the text before the caret */
  onComplete?: (requestId: number, text: string) => void;
}

const DEBOUNCE_MS = 80;

export function WatchInput({ initial = '', placeholder, onSubmit, onCancel, completions, onComplete }: WatchInputProps) {
  const [text, setText] = useState(initial);
  const [list, setList] = useState<{ prefix: string; items: CompletionItem[] } | null>(null);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef(initial.length);
  const lastRequest = useRef(0);
  const timer = useRef<number | null>(null);
  const placeCaret = useRef<number | null>(null);

  useEffect(() => {
    if (!completions || completions.requestId !== lastRequest.current) return;
    setList(completions.items.length > 0 ? { prefix: completions.prefix, items: completions.items } : null);
    setSelected(0);
  }, [completions]);

  useEffect(() => {
    if (placeCaret.current === null || !input.current) return;
    input.current.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  }, [text]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const ask = (value: string, at: number, now = false): void => {
    if (!onComplete) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    const head = completionHead(value, at);
    if (head === null) {
      setList(null);
      return;
    }
    const send = (): void => {
      const id = requestId();
      lastRequest.current = id;
      onComplete(id, head);
    };
    if (now) send();
    else timer.current = window.setTimeout(send, DEBOUNCE_MS);
  };

  const accept = (item: CompletionItem): void => {
    if (!list) return;
    const next = applyCompletion(text, caret.current, list.prefix, item.label);
    caret.current = next.caret;
    placeCaret.current = next.caret;
    setText(next.text);
    setList(null);
  };

  const syncCaret = (el: HTMLInputElement): void => {
    caret.current = el.selectionStart ?? el.value.length;
  };

  return (
    <span class="pk-watch-editor">
      <input
        ref={input}
        class="pk-watch-input"
        type="text"
        value={text}
        placeholder={placeholder}
        autoFocus
        spellcheck={false}
        autocomplete="off"
        role="combobox"
        aria-expanded={!!list}
        aria-autocomplete="list"
        onClick={(e) => {
          e.stopPropagation();
          syncCaret(e.currentTarget as HTMLInputElement);
        }}
        onInput={(e) => {
          const el = e.currentTarget as HTMLInputElement;
          syncCaret(el);
          setText(el.value);
          ask(el.value, caret.current);
        }}
        onKeyUp={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') syncCaret(e.currentTarget as HTMLInputElement);
        }}
        onKeyDown={(e) => {
          if (list) {
            const n = list.items.length;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => (s + 1) % n);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => (s - 1 + n) % n);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setList(null);
              return;
            }
            const choice = list.items[selected];
            if (e.key === 'Tab' || (e.key === 'Enter' && choice && choice.label !== list.prefix)) {
              e.preventDefault();
              if (choice) accept(choice);
              return;
            }
          }
          if (e.key === 'Tab') {
            // never leave the field on Tab: ask for completions of what is typed instead
            e.preventDefault();
            syncCaret(e.currentTarget as HTMLInputElement);
            ask(text, caret.current, true);
            return;
          }
          if (e.key === 'Enter') onSubmit(text.trim());
          else if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => setList(null)}
      />
      {list && (
        <ul class="pk-watch-suggest" role="listbox">
          {list.items.map((item, i) => (
            <li
              key={`${item.kind}:${item.label}`}
              class={i === selected ? 'selected' : undefined}
              role="option"
              aria-selected={i === selected}
              title={item.type ? `${item.label}: ${item.type}` : `${item.label} (${item.kind})`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the input: a blur would cancel the edit
                accept(item);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <Icon name={iconForKind(item.kind)} class="pk-suggest-icon" />
              <span class="pk-suggest-label">{item.label}</span>
              <span class="pk-suggest-type">{item.type ?? item.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
