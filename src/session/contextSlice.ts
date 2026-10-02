/**
 * Context slice: the one JSON shape an agent reads per stop (docs/PROTOCOL.md, "Context slice").
 * Pure: takes the run's trace, file table, log entries, coverage and errors plus a source reader;
 * nothing here touches vscode. Blocks are bounded by `storyBlocks`, the same passes the Code
 * Story lists, but a slice lists only the lines the pass ran: the story pads those with dimmed
 * context for reading, which would be spent context window here.
 */
import type { ErrorEvent, LogEvent, ValueBag } from '../shared/protocol';
import { storyBlocks, type TraceModel } from '../timeMachine/traceModel';
import type { FileTable } from './fileTable';
import { isBlankOrComment } from '../util/text';

export const BLOCK_LINE_CAP = 60;
export const VALUE_CAP = 20;

export interface SliceInputs {
  trace: TraceModel;
  files: FileTable;
  entriesByRid: ReadonlyMap<number, LogEvent[]>;
  coverage: ReadonlyMap<number, { states: number[]; hits: number[] }>;
  errors: readonly ErrorEvent[];
  /** source lines of a file (the editor buffer, or the file on disk); undefined when unavailable */
  readSource: (fileId: number) => string[] | undefined;
  /** the document changed since the run */
  stale?: boolean;
}

export interface SliceOptions {
  /** lift the line and value caps */
  scope?: boolean;
  /** include `valueBag` on values */
  valueBag?: boolean;
}

export interface SliceLocation {
  file: string;
  line: number;
  col: number;
  function: string;
  fileId: number;
}

export interface SliceFrame {
  file: string;
  line: number;
  function: string;
  step: number;
}

export interface BlockLine {
  line: number;
  text: string;
  step?: number;
  current?: boolean;
}

export interface SliceBlock {
  file: string;
  function: string;
  scopeId: number;
  lines: BlockLine[];
  /** present (true) when the line cap cut the block; `scope: true` lifts it */
  capped?: boolean;
  /** with `capped`: how long the block is in full, so a reader knows what the shown lines are part of */
  totalLines?: number;
}

export interface SliceValue {
  line: number;
  context?: string;
  text: string;
  step: number;
  hit: number;
  runtimeKey: string;
  valueBag?: ValueBag;
  /** the log's own id (Time Machine entries, live values); lets `expand` address the value */
  logId?: string;
}

export interface SliceError {
  file: string;
  line: number;
  type: string;
  message: string;
  step: number;
}

export interface Moves {
  into: number | null;
  over: number | null;
  out: number | null;
  back: number | null;
  backOver: number | null;
  backOut: number | null;
}

export interface ContextSlice {
  step: number;
  count: number;
  location: SliceLocation;
  stale: boolean;
  stack: SliceFrame[];
  block: SliceBlock;
  values: SliceValue[];
  /** present (true) when the value cap cut the list; `scope: true` lifts it */
  valuesCapped?: boolean;
  coverage?: { notRun: number[] };
  moves: Moves;
  errors: SliceError[];
}

/* ---------- helpers ---------- */

function pathOf(files: FileTable, fileId: number): string {
  return files.get(fileId)?.path ?? '';
}

function scopeName(trace: TraceModel, scopeId: number): string {
  return trace.scope(scopeId)?.name ?? '<module>';
}

function orNull(i: number): number | null {
  return i >= 0 ? i : null;
}

export function movesAt(trace: TraceModel, i: number): Moves {
  if (!trace.valid(i)) return { into: null, over: null, out: null, back: null, backOver: null, backOut: null };
  return {
    into: orNull(trace.stepInto(i)),
    over: orNull(trace.stepOver(i)),
    out: orNull(trace.stepOut(i)),
    back: orNull(trace.stepBackInto(i)),
    backOver: orNull(trace.stepBackOver(i)),
    backOut: orNull(trace.stepBackOut(i)),
  };
}

export function locationAt(inputs: SliceInputs, i: number): SliceLocation {
  const loc = inputs.trace.location(i);
  return {
    file: loc ? pathOf(inputs.files, loc.fileId) : '',
    line: loc?.range[0] ?? 0,
    col: loc?.range[1] ?? 0,
    function: scopeName(inputs.trace, inputs.trace.scopeId(i)),
    fileId: loc?.fileId ?? -1,
  };
}

function stackAt(inputs: SliceInputs, i: number): SliceFrame[] {
  return inputs.trace.callStack(i).map((f) => ({ file: pathOf(inputs.files, f.fileId), line: f.line, function: f.function, step: f.step }));
}

export function sliceErrors(inputs: SliceInputs): SliceError[] {
  return inputs.errors.map((e) => {
    const loc = inputs.files.locate(e.rid);
    return { file: loc?.path ?? pathOf(inputs.files, e.fileId), line: loc?.range[0] ?? e.stack[0]?.line ?? 0, type: e.errorType, message: e.message, step: e.step };
  });
}

function toValue(e: LogEvent, line: number, withBag: boolean): SliceValue {
  const v: SliceValue = { line, context: e.context, text: e.text, step: e.step, hit: e.hit, runtimeKey: e.runtimeKey, logId: e.logId };
  if (withBag && e.valueBag) v.valueBag = e.valueBag;
  return v;
}

/** The Code Story block that contains step `i`: one pass through a scope. */
export function blockBounds(trace: TraceModel, i: number): { first: number; last: number; scopeId: number } {
  const block = storyBlocks(trace).find((b) => i >= b.firstStep && i <= b.lastStep);
  if (block) return { first: block.firstStep, last: block.lastStep, scopeId: block.scopeId };
  return { first: i, last: i, scopeId: trace.scopeId(i) };
}

interface BuiltBlock {
  fileId: number;
  scopeId: number;
  first: number;
  last: number;
  /** every story line of the block (executed lines, header, one-line gap context), ascending */
  lines: BlockLine[];
  /** [first, last] source line of the block (function body for a function scope) */
  span: [number, number];
}

function buildBlock(inputs: SliceInputs, i: number): BuiltBlock {
  const { trace, files } = inputs;
  const { first, last, scopeId } = blockBounds(trace, i);
  const loc = trace.location(i);
  const fileId = loc?.fileId ?? -1;
  const src = inputs.readSource(fileId) ?? [];
  const firstStepOfLine = new Map<number, number>();
  for (let k = first; k <= last; k++) {
    const l = trace.location(k);
    if (!l || l.fileId !== fileId) continue;
    for (let n = l.range[0]; n <= Math.min(l.range[2], l.range[0] + 1); n++) if (!firstStepOfLine.has(n)) firstStepOfLine.set(n, k);
    if (!firstStepOfLine.has(l.range[0])) firstStepOfLine.set(l.range[0], k);
  }
  const executed = [...firstStepOfLine.keys()];
  const wanted = new Set<number>(executed);
  const scope = trace.scope(scopeId);
  const scopeLoc = scope ? files.locate(scope.rid) : undefined;
  let span: [number, number] = executed.length ? [Math.min(...executed), Math.max(...executed)] : [0, 0];
  if (scopeLoc && scopeLoc.fileId === fileId && scope && scope.parent >= 0) {
    // function header (+ leading comment lines)
    wanted.add(scopeLoc.range[0]);
    let l = scopeLoc.range[0] - 1;
    while (l >= 1 && (src[l - 1] ?? '').trim().startsWith('#') && scopeLoc.range[0] - l <= 3) {
      wanted.add(l);
      l--;
    }
    span = [scopeLoc.range[0], Math.max(scopeLoc.range[2], span[1])];
  }
  const sorted = [...wanted].filter((l) => l >= 1 && (src.length === 0 || l <= src.length)).sort((a, b) => a - b);
  // single-line gaps that are blank or a comment become context (wider gaps are simply skipped)
  const lines: BlockLine[] = [];
  const push = (line: number): void => {
    const step = firstStepOfLine.get(line);
    const bl: BlockLine = { line, text: src[line - 1] ?? '' };
    if (step !== undefined) bl.step = step;
    lines.push(bl);
  };
  for (let k = 0; k < sorted.length; k++) {
    const cur = sorted[k]!;
    const prev = sorted[k - 1];
    if (prev !== undefined && cur - prev === 2 && isBlankOrComment(src[prev] ?? '')) push(prev + 1);
    push(cur);
  }
  return { fileId, scopeId, first, last, lines, span };
}

/** Values logged by the block's lines during the block's steps, ascending by step. */
function blockValues(inputs: SliceInputs, block: BuiltBlock, withBag: boolean): SliceValue[] {
  const lines = new Set(block.lines.map((l) => l.line));
  const out: SliceValue[] = [];
  for (const [rid, entries] of inputs.entriesByRid) {
    const loc = inputs.files.locate(rid);
    if (!loc || loc.fileId !== block.fileId || !lines.has(loc.range[0])) continue;
    for (const e of entries) if (e.step >= block.first && e.step <= block.last) out.push(toValue(e, loc.range[0], withBag));
  }
  return out.sort((a, b) => a.step - b.step || a.hit - b.hit);
}

function notRunLines(inputs: SliceInputs, block: BuiltBlock): number[] | undefined {
  const cov = inputs.coverage.get(block.fileId);
  const f = inputs.files.get(block.fileId);
  if (!cov || !f) return undefined;
  const [lo, hi] = block.span;
  const out = new Set<number>();
  for (const local of f.statements) {
    const r = f.ranges[local];
    if (!r || r[0] < lo || r[0] > hi) continue;
    if (cov.states[local] === 0) out.add(r[0]);
  }
  return [...out].sort((a, b) => a - b);
}

/** Keep `cap` items around index `centre` (window clamped to the array). */
function windowAround<T>(items: T[], centre: number, cap: number): { items: T[]; capped: boolean } {
  if (items.length <= cap) return { items, capped: false };
  const start = Math.max(0, Math.min(items.length - cap, centre - Math.floor(cap / 2)));
  return { items: items.slice(start, start + cap), capped: true };
}

/* ---------- public API ---------- */

/** The context slice for step `i`. */
export function contextSliceForStep(inputs: SliceInputs, i: number, opts: SliceOptions = {}): ContextSlice | undefined {
  const { trace } = inputs;
  if (!trace.valid(i)) return undefined;
  const loc = trace.location(i);
  const built = buildBlock(inputs, i);
  const currentLine = loc?.range[0] ?? -1;
  const marked = built.lines.map((l) => (l.line === currentLine ? { ...l, current: true } : l));
  const centre = Math.max(0, marked.findIndex((l) => l.current));
  const lines = opts.scope ? { items: marked, capped: false } : windowAround(marked, centre, BLOCK_LINE_CAP);
  const allValues = blockValues(inputs, built, !!opts.valueBag);
  let vCentre = allValues.findIndex((v) => v.step >= i);
  if (vCentre < 0) vCentre = allValues.length - 1;
  const values = opts.scope ? { items: allValues, capped: false } : windowAround(allValues, Math.max(0, vCentre), VALUE_CAP);
  const block: SliceBlock = { file: pathOf(inputs.files, built.fileId), function: scopeName(trace, built.scopeId), scopeId: built.scopeId, lines: lines.items };
  if (lines.capped) block.capped = true;
  const notRun = notRunLines(inputs, built);
  const slice: ContextSlice = {
    step: i,
    count: trace.count,
    location: locationAt(inputs, i),
    stale: !!inputs.stale,
    stack: stackAt(inputs, i),
    block,
    values: values.items,
    moves: movesAt(trace, i),
    errors: sliceErrors(inputs),
  };
  if (values.capped) slice.valuesCapped = true;
  if (notRun) slice.coverage = { notRun };
  return slice;
}

/** First step that starts on a line of `[line, endLine]` of the file (then one that spans it), or -1. */
export function firstStepOnLines(trace: TraceModel, fileId: number, line: number, endLine = line): number {
  const hi = Math.max(line, endLine);
  for (let j = 0; j < trace.count; j++) {
    const l = trace.location(j);
    if (l && l.fileId === fileId && l.range[0] >= line && l.range[0] <= hi) return j;
  }
  for (let j = 0; j < trace.count; j++) {
    const l = trace.location(j);
    if (l && l.fileId === fileId && l.range[0] <= line && l.range[2] >= line) return j;
  }
  return -1;
}

/** The context slice for `file:line(-endLine)`: the first step on those lines. */
export function contextSliceForLine(inputs: SliceInputs, fileId: number, line: number, endLine?: number, opts: SliceOptions = {}): ContextSlice | undefined {
  const step = firstStepOnLines(inputs.trace, fileId, line, endLine);
  return step < 0 ? undefined : contextSliceForStep(inputs, step, opts);
}

/** Every value logged on a line, by step then hit. */
export function valuesForLine(inputs: SliceInputs, fileId: number, line: number, opts: SliceOptions = {}): SliceValue[] {
  const out: SliceValue[] = [];
  for (const [rid, entries] of inputs.entriesByRid) {
    const loc = inputs.files.locate(rid);
    if (!loc || loc.fileId !== fileId || loc.range[0] !== line) continue;
    for (const e of entries) out.push(toValue(e, line, !!opts.valueBag));
  }
  return out.sort((a, b) => a.step - b.step || a.hit - b.hit);
}

/** Values produced at exactly step `i` (what a `watch` stream reports per stop). */
export function valuesAtStep(inputs: SliceInputs, i: number, opts: SliceOptions = {}): SliceValue[] {
  const out: SliceValue[] = [];
  for (const [rid, entries] of inputs.entriesByRid) {
    for (const e of entries) {
      if (e.step !== i) continue;
      const loc = inputs.files.locate(rid);
      out.push(toValue(e, loc?.range[0] ?? 0, !!opts.valueBag));
    }
  }
  return out.sort((a, b) => a.hit - b.hit);
}
