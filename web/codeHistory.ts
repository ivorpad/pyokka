/**
 * Code history beside declarations: each binding's values across the live debugger's pauses, as
 * `total = 0 → 6 → 18` after the line that declares it. Built from the pauses' own variables (the
 * snapshots the page kept); nothing is evaluated and no recording is read.
 */
import { pausedHover, pausedOccurrences, pausedSummary, type PausedValues } from './pausedValues';
import type { LocalVar } from './debugHost';
import type { VariableHistory } from '../src/shared/protocol';

/** Changes shown inline at most; the hover lists them all. */
const INLINE_CHANGES = 3;

export interface HistoryRow {
  /** `name = a → b · other = c` */
  preview: string;
  /** Markdown: every observed change of each binding on the line, oldest first */
  hover: string;
  /** the bindings the row shows, in its order */
  names: string[];
}

/** Per declaration line, the observed changes of the bindings it declares, over `snapshots` (oldest first) of `content`. */
export function inlineHistory(content: string, snapshots: PausedValues[]): Map<number, HistoryRow> {
  const bindings = new Map<string, { line: number; name: string; changes: LocalVar[] }>();
  for (const pause of snapshots) {
    if (pause.content !== content) continue;
    const seen = new Set<string>();
    for (const o of pausedOccurrences(pause)) {
      // the first declaration at or above the paused line, as the shadows choose it
      if (!o.declaration || o.unavailable || o.line > pause.line || seen.has(o.local.name)) continue;
      seen.add(o.local.name);
      const key = `${o.line}:${o.start}:${o.local.name}`;
      const binding = bindings.get(key) ?? { line: o.line, name: o.local.name, changes: [] };
      if (binding.changes.at(-1)?.text !== o.local.text) binding.changes.push(o.local);
      bindings.set(key, binding);
    }
  }
  const rows = new Map<number, { previews: string[]; hovers: string[]; names: string[] }>();
  for (const b of bindings.values()) {
    const row = rows.get(b.line) ?? { previews: [], hovers: [], names: [] };
    row.names.push(b.name);
    const shown = b.changes.slice(-INLINE_CHANGES).map(pausedSummary).join(' → ');
    row.previews.push(`${b.name} = ${b.changes.length > INLINE_CHANGES ? '… → ' : ''}${shown}`);
    row.hovers.push(b.changes.length > 1 ? `${b.changes.length} values at the pauses so far, oldest first\n\n${b.changes.map((c) => pausedHover(c)).join('\n\n---\n\n')}` : pausedHover(b.changes[0]!));
    rows.set(b.line, row);
  }
  return new Map([...rows].map(([line, row]) => [line, { preview: row.previews.join(' · '), hover: row.hovers.join('\n\n---\n\n'), names: row.names }]));
}

/**
 * `name` in the selected frame of each pause of the live run (oldest first), as the Variable
 * History view shows a recorded run's changes: a row where its value differs from the frame's
 * previous one. `step` is the pause's ordinal; a pause is no Time Machine step. Undefined when no
 * pause had `name`, so the view falls back to the recording.
 */
export function pauseHistory(name: string, pauses: { file: string; pause: Omit<PausedValues, 'identifiers'> }[]): VariableHistory | undefined {
  const changes: VariableHistory['changes'] = [];
  const last = new Map<string, string>();
  pauses.forEach(({ file, pause }, i) => {
    const local = pause.locals.find((l) => l.name === name);
    if (!local) return;
    const frame = `${file}:${pause.frameName}`;
    if (last.get(frame) === local.text) return;
    last.set(frame, local.text);
    changes.push({ step: i + 1, file, fileId: -1, line: pause.line, function: pause.frameName, scopeId: 0, name, text: local.text, source: 'locals' });
  });
  return changes.length ? { name, changes, total: changes.length, truncated: false, recordedLocals: true, pauses: true } : undefined;
}
