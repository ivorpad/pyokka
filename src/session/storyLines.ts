/**
 * The Code Story document: which source lines a block shows (L1-L6) and how the rows are laid out
 * (D3-D4). A block lists the lines its pass ran plus a little of the source around them, so a turn
 * of a loop reads in context instead of as two stranded lines. Lines the pass did not run come back
 * without a step and are rendered dim, as is every column of an executed line outside the step's
 * own range. Pure: nothing here touches vscode, so `test/unit/codeStory.test.ts` can pin the
 * rendered document.
 */

/** Lines of source kept either side of what the block ran (L2). */
export const CONTEXT_LINES = 2;
/** An interior run of lines the block did not run collapses to a fold marker past this length (L4). */
export const GAP_FILL = 4;
/** The fold marker: a row that holds nothing but this is a `…` row (D3, D6). */
export const FOLD = '…';

export type StoryEntry = { kind: 'line'; line: number; step?: number } | { kind: 'gap' };

export interface StoryBlockLineOptions {
  /** the enclosing scope, `[first, last]`; the window never leaves it (L2) */
  span?: [number, number];
}

/** A run of columns of one row, `[start, end)`. */
export type Span = [number, number];

export interface StoryLine {
  kind: 'code' | 'gap' | 'blank' | 'note';
  fileId?: number;
  sourceLine?: number;
  step?: number;
  block?: number;
  /** width of the line number and the two spaces after it: document column of the source text */
  prefixLength?: number;
  /** the row is inside the block's window but the block did not run it */
  context?: boolean;
  /** the row's columns to render dim: everything outside the block's step ranges (L6) */
  dim?: Span[];
}

export interface StoryBlockInput {
  fileId: number;
  /** the block's file, one entry per line */
  src: readonly string[];
  /** first line of each of the block's step ranges -> the block's first step on it (L1) */
  firstStepOfLine: ReadonlyMap<number, number>;
  /** per executed line, the columns its step ranges cover, `[start, end)` into the source text (L6) */
  bright?: ReadonlyMap<number, Span[]>;
  /** the scope's span: the whole function, or the file for the module scope (L2) */
  span?: [number, number];
  /** listed alone when the block's file has no readable source */
  note?: string;
}

/** Which values the story paints (`pyokka.story.values`). */
export type StoryValuesMode = 'all' | 'asOf' | 'step';

/** One painted value, as the test API reports it: the document row, the block and source line it sits on. */
export interface StoryValue {
  row: number;
  block: number;
  sourceLine: number;
  text: string;
  kind: string;
}

/**
 * Whether an entry produced at `entryStep` is painted in a block covering `[firstStep, lastStep]`:
 * `all` paints every entry of the block, `asOf` those at or before the current step, `step` only
 * the current step's (Quokka's rule, V1). Outside the block nothing is painted.
 */
export function storyValueWanted(mode: StoryValuesMode, entryStep: number, block: { firstStep: number; lastStep: number }, currentStep: number | undefined): boolean {
  if (entryStep < block.firstStep || entryStep > block.lastStep) return false;
  if (mode === 'step') return currentStep !== undefined && entryStep === currentStep;
  if (mode === 'asOf') return currentStep === undefined || entryStep <= currentStep;
  return true;
}

/** `block:fileId:sourceLine` -> document row, for `storyValueRow`. */
export function storyRowIndex(lines: readonly StoryLine[]): Map<string, number> {
  const rows = new Map<string, number>();
  lines.forEach((l, i) => {
    if (l.kind === 'code' && l.block !== undefined && l.sourceLine !== undefined) rows.set(`${l.block}:${l.fileId}:${l.sourceLine}`, i);
  });
  return rows;
}

/**
 * The row a value sits on: the end of its statement's row in that block; when the block folded
 * the tail away, the fold row under the statement (a value dropped mid-statement is unreadable);
 * when the window cut the tail, the statement's last listed row. Undefined when the block lists
 * none of the statement's lines.
 */
export function storyValueRow(lines: readonly StoryLine[], rows: ReadonlyMap<string, number>, block: number, fileId: number, range: readonly [number, number, number, number]): number | undefined {
  const key = (l: number): string => `${block}:${fileId}:${l}`;
  const endRow = rows.get(key(range[2]));
  if (endRow !== undefined) return endRow;
  for (let l = range[2] - 1; l >= range[0]; l--) {
    const i = rows.get(key(l));
    if (i === undefined) continue;
    const next = lines[i + 1];
    return next && next.kind === 'gap' && next.block === block ? i + 1 : i;
  }
  return undefined;
}

export interface StoryDocument {
  text: string;
  lines: StoryLine[];
}

const isBlank = (text: string | undefined): boolean => (text ?? '').trim() === '';

/**
 * Where a function's span starts (L2): the `def` line, walked up over the comment and decorator
 * lines written directly above it. A blank line ends the run.
 */
export function scopeTop(src: readonly string[], defLine: number): number {
  let top = defLine;
  for (let l = defLine - 1; l >= 1; l--) {
    const text = (src[l - 1] ?? '').trim();
    if (!text.startsWith('#') && !text.startsWith('@')) break;
    top = l;
  }
  return top;
}

/**
 * The block's lines in source order, with `…` fold markers between the runs it keeps (L1-L5).
 * `step` is the block's first step on that line; a line without one is context.
 */
export function storyBlockLines(src: readonly string[], firstStepOfLine: ReadonlyMap<number, number>, opts: StoryBlockLineOptions = {}): StoryEntry[] {
  const lineCount = src.length;
  const executed = [...firstStepOfLine.keys()].filter((l) => l >= 1 && l <= lineCount).sort((a, b) => a - b);
  if (executed.length === 0 || lineCount === 0) return [];
  const limitLo = Math.max(1, opts.span?.[0] ?? 1);
  const limitHi = Math.min(lineCount, opts.span?.[1] ?? lineCount);
  // L2: what the block ran, two lines either side, kept inside the scope
  let start = Math.max(limitLo, executed[0]! - CONTEXT_LINES);
  let end = Math.min(limitHi, executed[executed.length - 1]! + CONTEXT_LINES);
  if (start > end) return [];
  // L3: a blank line at either edge is not context, it is a hole; interior blanks stay
  while (start < end && isBlank(src[start - 1]) && !firstStepOfLine.has(start)) start++;
  while (end > start && isBlank(src[end - 1]) && !firstStepOfLine.has(end)) end--;
  const wanted = new Set<number>();
  for (let l = start; l <= end; l++) wanted.add(l);
  // L4: a long run of lines the pass did not run is a fold, not context; the runs at either end of
  // the window are the context itself and are short enough to survive
  let run: number[] = [];
  const closeRun = (): void => {
    if (run.length > GAP_FILL) for (const l of run) wanted.delete(l);
    run = [];
  };
  for (let l = start; l <= end; l++) {
    if (firstStepOfLine.has(l)) closeRun();
    else run.push(l);
  }
  closeRun();
  const out: StoryEntry[] = [];
  const sorted = [...wanted].sort((a, b) => a - b);
  for (let k = 0; k < sorted.length; k++) {
    const cur = sorted[k]!;
    const prev = sorted[k - 1];
    if (prev !== undefined && cur - prev > 1) out.push({ kind: 'gap' });
    const step = firstStepOfLine.get(cur);
    out.push(step === undefined ? { kind: 'line', line: cur } : { kind: 'line', line: cur, step });
  }
  return out;
}

/** The complement of `bright` (source columns) over a row of `length` columns whose code starts at `prefix`. */
function dimSpans(length: number, prefix: number, bright: readonly Span[]): Span[] {
  const on: Span[] = [];
  for (const [a, b] of bright) {
    const s = Math.max(prefix, Math.min(length, prefix + a));
    const e = Math.max(s, Math.min(length, prefix + b));
    if (e > s) on.push([s, e]);
  }
  on.sort((x, y) => x[0] - y[0]);
  const merged: Span[] = [];
  for (const [s, e] of on) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const out: Span[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) out.push([at, s]);
    at = Math.max(at, e);
  }
  if (at < length) out.push([at, length]);
  return out;
}

/**
 * The whole document (D3, D4): an empty row, the walkthrough when there is one, then the blocks
 * with exactly one `…` row between them. No fences, no header, no trailing marker.
 */
export function renderStoryDocument(blocks: readonly StoryBlockInput[], opts: { walkthrough?: readonly string[] } = {}): StoryDocument {
  const out: string[] = [];
  const lines: StoryLine[] = [];
  out.push('');
  lines.push({ kind: 'blank' });
  for (const text of opts.walkthrough ?? []) {
    out.push(text);
    lines.push({ kind: 'note' });
  }
  let emitted = (opts.walkthrough ?? []).length > 0;
  blocks.forEach((block, index) => {
    const width = String(Math.max(block.src.length, 1)).length;
    const prefixLength = width + 2;
    const fold = `${' '.repeat(width)}  ${FOLD}`;
    const rows = storyBlockLines(block.src, block.firstStepOfLine, { span: block.span });
    if (rows.length === 0 && block.note === undefined) return;
    const pushFold = (): void => {
      out.push(fold);
      lines.push({ kind: 'gap', block: index, prefixLength, dim: [[0, fold.length]] });
    };
    if (emitted) pushFold();
    emitted = true;
    if (rows.length === 0) {
      out.push(`# ${block.note}`);
      lines.push({ kind: 'note', block: index });
      return;
    }
    for (const row of rows) {
      if (row.kind === 'gap') {
        pushFold();
        continue;
      }
      const source = block.src[row.line - 1] ?? '';
      const number = String(row.line).padStart(width);
      // D4: a blank source line is the number and nothing after it
      const text = isBlank(source) ? number : `${number}  ${source}`;
      out.push(text);
      const line: StoryLine = { kind: 'code', fileId: block.fileId, sourceLine: row.line, block: index, prefixLength };
      if (row.step === undefined) line.context = true;
      else line.step = row.step;
      line.dim = dimSpans(text.length, prefixLength, row.step === undefined ? [] : (block.bright?.get(row.line) ?? []));
      lines.push(line);
    }
  });
  return { text: out.join('\n') + '\n', lines };
}
