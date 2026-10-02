/** The pure half of the watch expression dropdown: what to ask for, how a choice lands, which icon a kind gets. */
import type { CompletionKind } from './src-shared';

const IDENT_TAIL = /[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The text to complete: what precedes the caret when it ends in an identifier or a dot. Null when
 * there is nothing to complete (an empty box, an operator, a space), which closes the dropdown.
 */
export function completionHead(text: string, caret: number): string | null {
  const head = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  if (!head) return null;
  if (head.endsWith('.')) return head;
  return IDENT_TAIL.test(head) ? head : null;
}

/** The chosen label replaces the prefix before the caret; the caret lands after it. */
export function applyCompletion(text: string, caret: number, prefix: string, label: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const start = Math.max(0, at - prefix.length);
  return { text: text.slice(0, start) + label + text.slice(at), caret: start + label.length };
}

const ICONS: Record<CompletionKind, string> = {
  variable: 'symbol-variable',
  attribute: 'symbol-field',
  function: 'symbol-method',
  method: 'symbol-method',
  property: 'symbol-property',
  class: 'symbol-class',
  module: 'symbol-namespace',
  builtin: 'symbol-method',
  keyword: 'symbol-keyword',
};

export function iconForKind(kind: CompletionKind): string {
  return ICONS[kind] ?? 'symbol-misc';
}
