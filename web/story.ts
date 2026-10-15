/**
 * The Code Story in the browser: the same document src/features/codeStory.ts gives VS Code (one
 * block per pass through a scope, rendered by the pure src/session/storyLines.ts), built from the
 * page's run instead of a Session. The code pane shows it as a read-only file; this module says
 * what is on each row, where the Time Machine's step is, and which values sit where.
 */
import { storyBlocks, type StepLocation } from '../src/timeMachine/traceModel';
import { renderStoryDocument, scopeTop, storyRowIndex, storyValueRow, storyValueWanted, type Span, type StoryBlockInput, type StoryLine, type StoryValuesMode } from '../src/session/storyLines';
import { inlineTextFor } from '../src/session/valuesAsOf';
import { truncateOneLine } from '../src/util/text';
import type { RunData } from './runState';

/** The path the code pane shows the story under (never a file on disk). */
export const STORY_PATH = 'pyokka://code-story';
const STORY_VALUE_MAX = 120;

export interface StoryBlock {
  index: number;
  scopeId: number;
  firstStep: number;
  lastStep: number;
  fileId: number;
}

export interface StoryModel {
  text: string;
  lines: StoryLine[];
  blocks: StoryBlock[];
  runId: string;
}

/** What the code pane draws on the story: the current step's box, dim columns, values (1-based lines). */
export interface StoryPaint {
  current: { line: number; start: number; end: number } | null;
  dim: { line: number; start: number; end: number }[];
  values: Map<number, { text: string; error: boolean }>;
}

/** Build the story of `run`; `sourceLines` gives a file's lines, `[]` when it has none to show. */
export function buildStory(run: RunData, sourceLines: (fileId: number) => string[], walkthrough?: readonly string[]): StoryModel {
  const trace = run.trace;
  if (!trace || trace.count === 0) return { text: '# Code Story\n# No execution recorded yet.\n', lines: [{ kind: 'note' }, { kind: 'note' }], blocks: [], runId: run.runId };
  const cache = new Map<number, string[]>();
  const src = (fileId: number): string[] => {
    let s = cache.get(fileId);
    if (!s) cache.set(fileId, (s = sourceLines(fileId)));
    return s;
  };
  const blocks: StoryBlock[] = [];
  const inputs: StoryBlockInput[] = [];
  for (const range of storyBlocks(trace)) {
    const block: StoryBlock = { index: blocks.length, ...range };
    blocks.push(block);
    inputs.push(blockInput(run, block, src(range.fileId)));
  }
  const doc = renderStoryDocument(inputs, { walkthrough });
  return { text: doc.text, lines: doc.lines, blocks, runId: run.runId };
}

function blockInput(run: RunData, block: StoryBlock, src: string[]): StoryBlockInput {
  const trace = run.trace!;
  const firstStepOfLine = new Map<number, number>();
  const bright = new Map<number, Span[]>();
  for (let k = block.firstStep; k <= block.lastStep; k++) {
    const loc = trace.location(k);
    if (!loc || loc.fileId !== block.fileId) continue;
    const line = loc.range[0];
    if (!firstStepOfLine.has(line)) firstStepOfLine.set(line, k);
    const spans = bright.get(line) ?? [];
    spans.push(brightSpan(loc, src[line - 1] ?? ''));
    bright.set(line, spans);
  }
  if (src.length === 0) {
    const f = run.files.get(block.fileId);
    return { fileId: block.fileId, src, firstStepOfLine, note: `${f ? (f.path.split(/[\\/]/).pop() ?? f.path) : 'external code'} (no source available)` };
  }
  if (firstStepOfLine.size === 0) return { fileId: block.fileId, src, firstStepOfLine };
  return { fileId: block.fileId, src, firstStepOfLine, bright, span: scopeSpan(run, block, src, firstStepOfLine) };
}

/** L2: a function's block may not leave the function (its decorators and comments included). */
function scopeSpan(run: RunData, block: StoryBlock, src: string[], firstStepOfLine: ReadonlyMap<number, number>): [number, number] | undefined {
  const scope = run.trace!.scope(block.scopeId);
  if (!scope || scope.parent < 0) return undefined;
  const loc = run.files.locate(scope.rid);
  if (!loc || loc.fileId !== block.fileId) return undefined;
  const body = run.files.get(block.fileId)?.functions.find((f) => f.rid === loc.localRid)?.bodyRange;
  const def = body ? Math.min(body[0], loc.range[0]) : loc.range[0];
  const last = Math.max(...firstStepOfLine.keys(), loc.range[2]);
  return [scopeTop(src, def), Math.max(body ? body[2] : last, def)];
}

function brightSpan(loc: StepLocation, text: string): Span {
  return [loc.range[1], loc.range[0] === loc.range[2] ? loc.range[3] : text.length];
}

/** The story row (0-based) of `step`: its source line inside the block holding it (T1). */
export function storyRowOf(m: StoryModel, run: RunData, step: number): { row: number; loc: StepLocation; line: StoryLine } | undefined {
  const loc = run.trace?.location(step);
  if (!loc) return undefined;
  const block = m.blocks.find((b) => step >= b.firstStep && step <= b.lastStep);
  if (!block) return undefined;
  for (let i = 0; i < m.lines.length; i++) {
    const l = m.lines[i]!;
    if (l.kind === 'code' && l.block === block.index && l.sourceLine === loc.range[0]) return { row: i, loc, line: l };
  }
  return undefined;
}

/** The decorations of the story at `step` (undefined: the Time Machine is off), values by `mode`. */
export function paintStory(m: StoryModel, run: RunData, text: readonly string[], step: number | undefined, mode: StoryValuesMode = 'all'): StoryPaint {
  const out: StoryPaint = { current: null, dim: [], values: new Map() };
  m.lines.forEach((l, i) => {
    const width = text[i]?.length ?? 0;
    for (const [a, b] of l.dim ?? []) {
      const start = Math.min(a, width);
      const end = Math.min(b, width);
      if (end > start) out.dim.push({ line: i + 1, start, end });
    }
  });
  const cur = step === undefined ? undefined : storyRowOf(m, run, step);
  if (cur) {
    const width = text[cur.row]?.length ?? 0;
    const prefix = cur.line.prefixLength ?? 0;
    const start = Math.min(prefix + cur.loc.range[1], width);
    let end = cur.loc.range[0] === cur.loc.range[2] ? Math.min(prefix + cur.loc.range[3], width) : width;
    if (end <= start) end = width;
    out.current = { line: cur.row + 1, start, end: Math.max(start, end) };
  }
  const rows = storyRowIndex(m.lines);
  for (const block of m.blocks) {
    for (const [rid, logs] of run.logsByRid) {
      const loc = run.files.locate(rid);
      if (!loc || loc.fileId !== block.fileId) continue;
      const visible = logs.filter((l) => storyValueWanted(mode, l.step, block, step));
      if (visible.length === 0) continue;
      const row = storyValueRow(m.lines, rows, block.index, loc.fileId, loc.range) ?? (mode === 'step' ? cur?.row : undefined);
      if (row === undefined) continue;
      out.values.set(row + 1, { text: truncateOneLine(inlineTextFor(visible).text, STORY_VALUE_MAX), error: false });
    }
    for (const err of run.errors) {
      if (err.handled || !storyValueWanted(mode, err.step, block, step)) continue;
      const loc = run.files.locate(err.rid);
      if (!loc || loc.fileId !== block.fileId) continue;
      const row = storyValueRow(m.lines, rows, block.index, loc.fileId, loc.range);
      if (row !== undefined) out.values.set(row + 1, { text: truncateOneLine(err.message || err.errorType, STORY_VALUE_MAX), error: true });
    }
  }
  return out;
}

/** Where a story row (1-based) points: its source file, line and the step that ran it. */
export function storyTarget(m: StoryModel, line: number): { fileId: number; line: number; step?: number } | undefined {
  const sl = m.lines[line - 1];
  if (!sl || sl.kind !== 'code' || sl.fileId === undefined || sl.sourceLine === undefined) return undefined;
  return { fileId: sl.fileId, line: sl.sourceLine, ...(sl.step === undefined ? {} : { step: sl.step }) };
}
