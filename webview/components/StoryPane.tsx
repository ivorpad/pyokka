/**
 * CODE STORY view: the browser page's Code Story in the panel (VS Code opens the same document as
 * an editor). Every pass through a scope in execution order, the Time Machine step boxed, the
 * columns that did not run dim, values at the end of their rows. A row that ran a source line
 * moves the Time Machine to it; Ctrl/Cmd+click opens the source line in the code pane.
 */
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { StoryPanel } from '../src-shared';
import { tokenize, type TokenClass } from '../highlight';
import { IconButton } from './ui';

export interface StoryPaneProps {
  story: StoryPanel | null;
  onPick: (line: number, open: boolean) => void;
  onClose: () => void;
}

const PY_KEYWORDS = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

/** a token's colour, or `cmt` from a `#` outside a string to the end of the row */
type SegmentClass = TokenClass | 'cmt';

interface Segment {
  text: string;
  cls: SegmentClass;
  dim: boolean;
  box: boolean;
}

/** `text` cut where a token, a dim range or the box starts or ends. */
export function storySegments(text: string, dim: readonly [number, number][], box: [number, number] | null): Segment[] {
  const tokens: { start: number; end: number; cls: TokenClass }[] = [];
  let at = 0;
  for (const t of tokenize(text)) {
    const cls = t.cls === 'plain' && PY_KEYWORDS.has(t.text) ? 'kw' : t.cls;
    tokens.push({ start: at, end: at + t.text.length, cls });
    at += t.text.length;
  }
  // a comment: the first `#` in a token that is not a string
  let comment = text.length;
  for (const t of tokens) {
    const hash = t.cls === 'str' || t.cls === 'secret' ? -1 : text.slice(t.start, t.end).indexOf('#');
    if (hash >= 0) {
      comment = t.start + hash;
      break;
    }
  }
  const cuts = new Set<number>([0, text.length, comment]);
  for (const t of tokens) cuts.add(t.start).add(t.end);
  for (const [a, b] of dim) cuts.add(Math.min(a, text.length)).add(Math.min(b, text.length));
  if (box) cuts.add(Math.min(box[0], text.length)).add(Math.min(box[1], text.length));
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    out.push({
      text: text.slice(a, b),
      cls: a >= comment ? 'cmt' : (tokens.find((t) => a >= t.start && a < t.end)?.cls ?? 'plain'),
      dim: dim.some(([s, e]) => a >= s && a < e),
      box: !!box && a >= box[0] && a < box[1],
    });
  }
  return out;
}

/** Runs of segments inside and outside the box, so the box is drawn once around its columns. */
function grouped(segments: Segment[]): { box: boolean; segments: Segment[] }[] {
  const out: { box: boolean; segments: Segment[] }[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.box === s.box) last.segments.push(s);
    else out.push({ box: s.box, segments: [s] });
  }
  return out;
}

function paint(s: Segment, k: number) {
  return (
    <span key={k} class={`tk-${s.cls}${s.dim ? ' pk-codestory-dim' : ''}`}>
      {s.text}
    </span>
  );
}

export function StoryPane({ story, onPick, onClose }: StoryPaneProps) {
  const body = useRef<HTMLDivElement>(null);
  const picks = useMemo(() => new Set(story?.picks ?? []), [story?.picks]);
  const dimOf = useMemo(() => {
    const m = new Map<number, [number, number][]>();
    for (const d of story?.dim ?? []) m.set(d.line, [...(m.get(d.line) ?? []), [d.start, d.end]]);
    return m;
  }, [story?.dim]);
  const valueOf = useMemo(() => new Map((story?.values ?? []).map((v) => [v.line, v])), [story?.values]);
  const current = story?.current ?? null;
  // the Time Machine's row stays in sight as the step moves (T2)
  useEffect(() => {
    if (!current) return;
    body.current?.querySelector<HTMLElement>(`[data-line="${current.line}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current?.line, story?.runId]);
  return (
    <section class="pk-pane pk-codestory" aria-label="Code Story">
      <header class="pk-pane-header">
        <span class="pk-pane-title">CODE STORY</span>
        <span class="pk-toolbar">
          <IconButton icon="close" title="Close" onClick={onClose} />
        </span>
      </header>
      {!story ? (
        <p class="pk-caption pk-caption-sub">No Code Story yet: run the file, then open the story again.</p>
      ) : (
        <div class="pk-codestory-body pk-repr" ref={body} role="list">
          {story.rows.map((text, i) => {
            const line = i + 1;
            const box = current && current.line === line ? ([current.start, current.end] as [number, number]) : null;
            const value = valueOf.get(line);
            const pick = picks.has(line);
            return (
              <div
                key={line}
                data-line={line}
                role="listitem"
                class={`pk-codestory-row${pick ? ' pick' : ''}${box ? ' current' : ''}`}
                title={pick ? 'Go to the step that ran this line · Ctrl/Cmd+click: open the source line' : undefined}
                onClick={pick ? (e) => onPick(line, e.metaKey || e.ctrlKey) : undefined}
              >
                {grouped(storySegments(text, dimOf.get(line) ?? [], box)).map((g, k) =>
                  g.box ? (
                    <span key={k} class="pk-codestory-box">
                      {g.segments.map(paint)}
                    </span>
                  ) : (
                    g.segments.map(paint)
                  ),
                )}
                {value && <span class={`pk-codestory-value${value.error ? ' error' : ''}`}>{`  ${value.text}`}</span>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
