/**
 * Walkthrough shapes and the helpers both builders share (docs/PROTOCOL.md, "Walkthrough"):
 * user-file detection, package names, display paths, durations, text cuts. Pure; identical
 * rules in `python/pyokka_runtime/agent/walkthrough.py`.
 */
import * as path from 'node:path';
import type { ErrorEvent, LocalsEvent, LogEvent } from '../shared/protocol';
import type { TraceModel } from '../timeMachine/traceModel';
import type { FileTable } from './fileTable';

export const WALKTHROUGH_CAP = 400;
export const PRINT_MAX = 120;
export const VALUE_MAX = 200;
export const INLINE_MAX = 60;
export const PARAM_MAX = 20;
export const ORDER: Record<string, number> = { start: 0, call: 1, tool: 1, decision: 2, value: 3, print: 4, error: 5, end: 9 };
export const VALUE_KINDS = new Set(['value', 'autoLog', 'logpoint']);
export const SKIP_PARAMS = new Set(['self', 'cls']);
const LIBRARY_MARKERS = ['site-packages', 'dist-packages'];

export type MomentKind = 'start' | 'end' | 'call' | 'tool' | 'decision' | 'value' | 'print' | 'error';
export type ValueRole = 'in' | 'out' | 'took' | 'value';

export interface MomentLocation {
  file: string | null;
  line: number;
  function: string;
  fileId: number;
}
export interface MomentValue {
  role: ValueRole;
  name: string;
  text: string;
}
export interface Moment {
  id: string;
  kind: MomentKind;
  step: number;
  location: MomentLocation;
  text: string;
  values: MomentValue[];
  durationMs: number | null;
  gloss: string | null;
  scopeId?: number;
  entryStep?: number;
  endStep?: number;
  /** tool moments: the scope that was running when the callback came in (the recorded parent can be too shallow) */
  callerScopeId?: number;
  callee?: MomentLocation;
  /** loops: iterations */
  count?: number;
  /** collapsed under the cap: this many more like it were dropped */
  more?: number;
}
export interface Walkthrough {
  count: number;
  total: number;
  shown: number;
  capped: boolean;
  truncated: boolean;
  file: string | null;
  exitCode: number | null;
  stale: boolean;
  staleFiles: string[];
  moments: Moment[];
}

export interface WalkthroughInputs {
  trace: TraceModel;
  files: FileTable;
  entries: readonly LogEvent[];
  locals: readonly LocalsEvent['entries'][number][];
  errors: readonly ErrorEvent[];
  mainFile: string;
  workspaceRoot: string;
  readSource: (fileId: number) => string[] | undefined;
  finished?: { exitCode: number | null; durationMs: number | null; timedOut?: boolean; stopped?: boolean };
  stale?: boolean;
  staleFiles?: string[];
  gloss?: Record<string, string> | undefined;
}
export interface WalkthroughOptions {
  fileId?: number;
  scope?: string;
  from?: number;
  to?: number;
  all?: boolean;
  cap?: number;
}

/* ---------- helpers shared with the Python side ---------- */

export function isUserFile(file: string | null | undefined, workspaceRoot: string, mainFile: string): boolean {
  if (!file) return false;
  if (mainFile && path.resolve(file) === path.resolve(mainFile)) return true;
  if (file.split(path.sep).some((p) => LIBRARY_MARKERS.includes(p))) return false;
  const root = workspaceRoot.replace(/[\\/]+$/, '') + path.sep;
  return !!workspaceRoot && file.startsWith(root);
}

export function packageOf(file: string | null | undefined): string | undefined {
  if (!file) return undefined;
  for (const marker of LIBRARY_MARKERS) {
    const i = file.lastIndexOf(marker + path.sep);
    if (i >= 0) {
      const top = file.slice(i + marker.length + 1).split(path.sep)[0] ?? '';
      return top.endsWith('.py') ? top.slice(0, -3) : top;
    }
  }
  return undefined;
}

/** The package a library file belongs to: `packageOf`, else (a path on sys.path outside site-packages) the directory of an `__init__.py` or the module's stem. */
export function libraryPackage(file: string | null | undefined): string | undefined {
  const pkg = packageOf(file);
  if (pkg || !file) return pkg;
  const base = path.basename(file);
  if (base === '__init__.py') return path.basename(path.dirname(file));
  return base.endsWith('.py') ? base.slice(0, -3) : base;
}

export function displayPath(file: string | null | undefined, workspaceRoot: string): string {
  if (!file) return '<unknown>';
  for (const marker of LIBRARY_MARKERS) {
    const i = file.lastIndexOf(marker + path.sep);
    if (i >= 0) return file.slice(i + marker.length + 1);
  }
  const root = workspaceRoot.replace(/[\\/]+$/, '') + path.sep;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '?';
  if (ms < 1000) return `${Math.floor(ms + 0.5)} ms`;
  return `${(Math.floor(ms / 100 + 0.5) / 10).toFixed(1)} s`;
}

export function cut(text: unknown, limit: number): string {
  const s = String(text ?? '').trim().split(/\s+/).join(' ');
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}
