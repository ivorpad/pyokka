/**
 * Values as of a Time Machine step. A range's log entries are one per hit, each stamped with
 * the step that produced it; while navigating, the one that stands for "now" is the last whose
 * step is ≤ the current step, and the hit count is how often the range had run by then.
 * Pure: the decorator (inline text and its hover) and the Value Peek hover share it.
 */
import type { LogEvent } from '../shared/protocol';
import type { InlineKind } from '../decorations/styles';
import { truncateOneLine } from '../util/text';

/** `entries` in step order (arrival order breaks ties), those produced at or before `step`; every entry when `step` is undefined (not navigating). */
export function entriesAsOf(entries: readonly LogEvent[], step: number | undefined): LogEvent[] {
  const list = step === undefined ? [...entries] : entries.filter((e) => e.step <= step);
  return list.sort((a, b) => a.step - b.step || a.seq - b.seq);
}

/** The entry that stands for "now" at `step`: the last one produced at or before it; undefined when the range has not run yet. */
export function entryAsOf(entries: readonly LogEvent[], step: number | undefined): LogEvent | undefined {
  const list = entriesAsOf(entries, step);
  return list[list.length - 1];
}

/** The run's last entry for the range: what the inline value shows when the Time Machine is off. */
export function finalEntry(entries: readonly LogEvent[]): LogEvent | undefined {
  return entryAsOf(entries, undefined);
}

/** Inline text for a range's entries: the last one's text, `×hits` when it ran more than once, timings summarised. */
export function inlineTextFor(logs: LogEvent[]): { text: string; kind: InlineKind } {
  const last = logs[logs.length - 1]!;
  const hits = Math.max(logs.length, last.hit ?? 1);
  let text = last.text;
  if (last.kind === 'time' && last.time && !text) {
    const t = last.time;
    text = t.n <= 1 ? `${t.total.toFixed(3)}ms` : `Σ ${t.total.toFixed(3)}ms, μ ${(t.total / t.n).toFixed(3)}ms, ⋀ ${t.min.toFixed(3)}ms, ⋁ ${t.max.toFixed(3)}ms, n ${t.n}`;
  }
  text = truncateOneLine(text ?? '');
  if (hits > 1 && last.kind !== 'time') text = `×${hits} ${text}`;
  const kind: InlineKind = last.kind === 'error' ? 'error' : last.kind === 'system' ? 'system' : 'log';
  return { text, kind };
}

/**
 * One-line markdown footer for a hover on a value while navigating: "as of step N", plus
 * "; final: …" when the run's last value for the range differs. Without an entry as of the
 * step (the range has not run yet) it says so and gives the final value. Undefined when the
 * Time Machine is off (`step` undefined) or nothing was ever recorded for the range.
 */
export function asOfFooter(asOf: LogEvent | undefined, final: LogEvent | undefined, step: number | undefined): string | undefined {
  if (step === undefined) return undefined;
  if (!asOf) return final ? `*not run yet as of step ${step}; final:* ${codeSpan(final.text)}` : undefined;
  if (final && final.text !== asOf.text) return `*as of step ${step}; final:* ${codeSpan(final.text)}`;
  return `*as of step ${step}*`;
}

/** A markdown code span whose fence outlasts any backtick run in the text; one line, 120 characters at most. */
function codeSpan(text: string): string {
  const one = truncateOneLine(text, 120);
  const longest = Math.max(0, ...(one.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${one}${pad}${fence}`;
}
