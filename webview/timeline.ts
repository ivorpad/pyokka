/**
 * Pure geometry and colour helpers for the Interactive Timeline (Timeline strip + Steps strip).
 */
import { StepFlag } from '../src/shared/protocol';
import type { TimelineModel } from '../src/shared/webviewProtocol';

/** Timeline Guide palette; `functionColors[scopeId]` indexes into it. */
export const PALETTE = [
  '#8fd0f6', // blue
  '#f28b82', // red
  '#b6d46a', // green
  '#f8a75a', // orange
  '#6fe0dc', // cyan
  '#e5c84a', // yellow
  '#c79cf0', // purple
  '#f2a9d6', // pink
  '#9bd7a5', // mint
  '#e3a07c', // clay
  '#8ea9f5', // periwinkle
  '#d4d477', // olive
];

export const ERROR_COLOR = '#f28b82';
export const NO_MAPPING_COLOR = 'rgba(128,128,128,0.45)';

export interface StepWindow {
  /** first visible step (inclusive) */
  start: number;
  /** last visible step (exclusive) */
  end: number;
}

export const MIN_WINDOW = 4;

export function stepColor(model: TimelineModel, i: number): string {
  const flags = model.flags[i] ?? 0;
  if (flags & StepFlag.Error) return ERROR_COLOR;
  if (flags & StepFlag.NoCodeMapping) return NO_MAPPING_COLOR;
  return scopeColor(model, model.scopeIds[i] ?? 0);
}

export function scopeColor(model: TimelineModel, scopeId: number): string {
  const idx = model.functionColors[scopeId] ?? scopeId;
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length] as string;
}

export function stepLabel(model: TimelineModel, i: number): string {
  return `${model.lines[i] ?? '?'}:${(model.cols[i] ?? 0) + 1}`;
}

/** Native tooltip of a Steps strip block: the step number (as the `pyokka` CLI prints it), the location, the function. */
export function stepTitle(step: number, label: string, scopeName: string): string {
  return scopeName ? `#${step}  ${label}  ${scopeName}` : `#${step}  ${label}`;
}

/** Where the previewed step's function was called from, relative to the previewed file. */
export function callerLocation(previewFile: string, caller: { file: string; line: number }): string {
  return caller.file === previewFile ? `line ${caller.line}` : `${caller.file}:${caller.line}`;
}

export function clampWindow(w: StepWindow, total: number): StepWindow {
  const size = Math.max(MIN_WINDOW, Math.min(total, w.end - w.start));
  let start = Math.round(w.start);
  if (start + size > total) start = total - size;
  if (start < 0) start = 0;
  return { start, end: Math.min(total, start + size) };
}

/** initial window size so that blocks have room for a `line:col` label */
export function initialWindow(total: number, widthPx: number, current: number, blockPx = 40): StepWindow {
  const size = Math.max(MIN_WINDOW, Math.min(total, Math.floor(widthPx / blockPx) || MIN_WINDOW));
  return centerWindow({ start: 0, end: size }, current, total);
}

export function centerWindow(w: StepWindow, step: number, total: number): StepWindow {
  const size = w.end - w.start;
  return clampWindow({ start: step - Math.floor(size / 2), end: step - Math.floor(size / 2) + size }, total);
}

/** keep `step` visible, moving the window as little as possible */
export function ensureVisible(w: StepWindow, step: number, total: number): StepWindow {
  if (step >= w.start && step < w.end) return w;
  const size = w.end - w.start;
  if (step < w.start) return clampWindow({ start: step, end: step + size }, total);
  return clampWindow({ start: step - size + 1, end: step + 1 }, total);
}

export function moveWindow(w: StepWindow, deltaSteps: number, total: number): StepWindow {
  return clampWindow({ start: w.start + deltaSteps, end: w.end + deltaSteps }, total);
}

/** zoom by `factor` (>1 zooms out) keeping the step at `anchorFrac` (0..1 of the window) fixed */
export function zoomWindow(w: StepWindow, factor: number, anchorFrac: number, total: number): StepWindow {
  const size = w.end - w.start;
  const newSize = Math.max(MIN_WINDOW, Math.min(total, Math.round(size * factor)));
  const anchorStep = w.start + size * anchorFrac;
  const start = Math.round(anchorStep - newSize * anchorFrac);
  return clampWindow({ start, end: start + newSize }, total);
}

export function resizeWindow(w: StepWindow, edge: 'start' | 'end', step: number, total: number): StepWindow {
  if (edge === 'start') {
    const start = Math.max(0, Math.min(step, w.end - MIN_WINDOW));
    return { start, end: w.end };
  }
  const end = Math.min(total, Math.max(step, w.start + MIN_WINDOW));
  return { start: w.start, end };
}

/** steps that get a notch on the Timeline strip (logs and errors) */
export function notchSteps(model: TimelineModel): number[] {
  const out: number[] = [];
  for (let i = 0; i < model.stepCount; i++) {
    const f = model.flags[i] ?? 0;
    if (f & (StepFlag.Log | StepFlag.Error)) out.push(i);
  }
  return out;
}

/** notches bucketed into pixel columns: returns the x (px) of every column that has a notch */
export function notchColumns(notches: number[], total: number, widthPx: number): { x: number; error: boolean }[] {
  return notchColumnsWithFlags(notches, [], total, widthPx);
}

export function notchColumnsWithFlags(notches: number[], errorSteps: number[], total: number, widthPx: number): { x: number; error: boolean }[] {
  if (total <= 0 || widthPx <= 0) return [];
  const errors = new Set(errorSteps);
  const cols = new Map<number, boolean>();
  for (const s of notches) {
    const x = Math.floor((s / total) * widthPx);
    cols.set(x, (cols.get(x) ?? false) || errors.has(s));
  }
  return [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([x, error]) => ({ x, error }));
}

/** step under pixel `x` on a strip that maps `total` steps to `widthPx` */
export function stepAtX(x: number, total: number, widthPx: number): number {
  if (widthPx <= 0 || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.floor((x / widthPx) * total)));
}

/** snap `step` to the closest notch if it is within `thresholdSteps` */
export function snapToNotch(step: number, notches: number[], thresholdSteps: number): number {
  if (notches.length === 0) return step;
  // binary search for insertion point
  let lo = 0;
  let hi = notches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((notches[mid] as number) < step) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [notches[lo - 1], notches[lo]].filter((n): n is number => n !== undefined);
  let best = step;
  let bestDist = thresholdSteps + 1;
  for (const c of candidates) {
    const d = Math.abs(c - step);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return bestDist <= thresholdSteps ? best : step;
}

export interface GuideEntry {
  scopeId: number;
  name: string;
  color: string;
}

/** legend rows: one per distinct scope name, in order of first execution */
export function timelineGuide(model: TimelineModel): GuideEntry[] {
  const seen = new Set<string>();
  const out: GuideEntry[] = [];
  const scopes = [...model.scopes].sort((a, b) => a.first - b.first);
  for (const s of scopes) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ scopeId: s.scopeId, name: s.name, color: scopeColor(model, s.scopeId) });
  }
  return out;
}

export interface StepBlock {
  step: number;
  color: string;
  label: string;
  scopeName: string;
  title: string;
  error: boolean;
  log: boolean;
  noMapping: boolean;
  scopeSwitch: boolean;
  current: boolean;
  echo: boolean;
}

export function stepBlocks(model: TimelineModel, w: StepWindow, current: number, echo: Set<number>): StepBlock[] {
  const out: StepBlock[] = [];
  const names = new Map(model.scopes.map((s) => [s.scopeId, s.name]));
  for (let i = w.start; i < w.end && i < model.stepCount; i++) {
    const f = model.flags[i] ?? 0;
    const label = stepLabel(model, i);
    const scopeName = names.get(model.scopeIds[i] ?? -1) ?? '';
    out.push({
      step: i,
      color: stepColor(model, i),
      label,
      scopeName,
      title: stepTitle(i, label, scopeName),
      error: !!(f & StepFlag.Error),
      log: !!(f & StepFlag.Log),
      noMapping: !!(f & StepFlag.NoCodeMapping),
      scopeSwitch: i > 0 && model.scopeIds[i] !== model.scopeIds[i - 1],
      current: i === current,
      echo: echo.has(i),
    });
  }
  return out;
}
