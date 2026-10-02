/**
 * The Details pane's "why" document: the text form of a provenance tree (`provenanceLines`, shared
 * with `pyokka why`) plus what a click on each line needs. Pure, so the pane and its tests share
 * it; Details.tsx owns the Monaco side.
 */
import { provenanceLines } from '../src/shared/provenanceText';
import type { PanelEntry, WhyView } from './src-shared';

export interface WhyLine {
  /** the text form's own kinds (`title` is its `header`), or the line standing in for the tree */
  kind: 'title' | 'node' | 'call' | 'opaque' | 'note' | 'conclusion' | 'wait' | 'error';
  /** the Time Machine target of a node or call line */
  step?: number;
  /** the producing statement (a node) or the `def` header (a call) */
  link?: { fileId: number; line: number; col: number };
  /** the `#step file:line …` part of a node or call line, 0-based columns [start, end): the visible link */
  linkSpan?: [number, number];
}

export interface WhyDocument {
  text: string;
  lines: WhyLine[];
}

/** Where the location sits in a node line (`   #23 main.py:28 <module>   statement`) or a call line (`↳ f #25–#27 helper.py:1   in …`). */
function locationSpan(text: string, kind: 'node' | 'call', step: number): [number, number] | undefined {
  const m = (kind === 'node' ? new RegExp(`(?:^\\s*(?:← )?|\\s{3})#${step} `) : new RegExp(`#${step}–#\\d+ `)).exec(text);
  if (!m) return undefined;
  const start = m.index + m[0].indexOf('#');
  const end = start + text.slice(start).search(/\s{2,}|$/);
  return [start, end];
}

/** The document for a query: one waiting line until the host answers, the error when it has none, else the tree's text form. */
export function buildWhyDocument(view: WhyView): WhyDocument {
  if (view.error) return { text: view.error, lines: [{ kind: 'error' }] };
  if (!view.tree) return { text: 'LOOKING UP…', lines: [{ kind: 'wait' }] };
  // the panel's trees carry display paths already
  const lines = provenanceLines(view.tree, (_, file) => file ?? '<unknown>');
  return {
    text: lines.map((l) => l.text).join('\n'),
    lines: lines.map((l) => {
      const kind = l.kind === 'header' ? 'title' : l.kind;
      const line: WhyLine = { kind, step: l.step };
      if (l.fileId !== undefined && l.line !== undefined) line.link = { fileId: l.fileId, line: l.line, col: 0 };
      if ((kind === 'node' || kind === 'call') && l.step !== undefined) line.linkSpan = locationSpan(l.text, kind, l.step);
      return line;
    }),
  };
}

/** The name a "Why" on an entry asks about: its context when that is a name or attribute path, else the statement itself (the empty name). */
export function whyName(entry: Pick<PanelEntry, 'context'>): string {
  return entry.context && /^[A-Za-z_][\w.]*$/.test(entry.context) ? entry.context : '';
}
