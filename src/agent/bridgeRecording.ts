/**
 * The bridge's `recording` reply: the open session's run as a saved run's `{meta, events}`
 * (PROTOCOL "Saved run"), so a verb that needs the whole trace (`pyokka tour --live`) runs the
 * same Python code over the session as over a `run.json`. Text values go through `redact`, as
 * every bridge reply does; the trace goes as the runtime sent it (base64 of the step quads).
 */
import type { ErrorEvent, HttpExchangeEvent, LogEvent, LocalsEvent, RunFinishedEvent, TraceScope } from '../shared/protocol';
import type { InstrumentedFile } from '../session/fileTable';
import { redact } from '../util/redact';

export interface RecordingInputs {
  runId: string;
  file: string;
  workspaceRoot: string;
  files: readonly InstrumentedFile[];
  trace: { steps: Int32Array; scopes: readonly TraceScope[]; truncated: boolean; midRun?: boolean };
  entries: readonly LogEvent[];
  locals: LocalsEvent['entries'];
  errors: readonly ErrorEvent[];
  coverage: ReadonlyMap<number, { states: number[]; hits: number[] }>;
  http: readonly HttpExchangeEvent[];
  finished: RunFinishedEvent | undefined;
  /** the lines of a file as the run saw them, when the host has them */
  readSource: (fileId: number) => string[] | undefined;
}

export function encodeSteps(steps: Int32Array): string {
  return Buffer.from(steps.buffer, steps.byteOffset, steps.byteLength).toString('base64');
}

function redactText<T extends Record<string, unknown>>(ev: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...ev };
  for (const k of keys) if (typeof out[k] === 'string') out[k] = redact(out[k] as string);
  return out as T;
}

export function recordingDoc(r: RecordingInputs): { meta: Record<string, unknown>; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  for (const f of r.files) {
    events.push({ type: 'file.instrumented', runId: r.runId, fileId: f.fileId, path: f.path, rangeBase: f.rangeBase, ranges: f.ranges, statements: f.statements, functions: f.functions, magic: f.magic });
  }
  for (const [fileId, cov] of r.coverage) events.push({ type: 'coverage', runId: r.runId, fileId, states: cov.states, hits: cov.hits });
  // `live-` and `shadow-` entries are the host's own evaluations (hovers, edited lines), not the run's
  for (const e of r.entries) if (!/^(live|shadow)-/.test(e.logId)) events.push(redactText({ ...e } as unknown as Record<string, unknown>, ['text', 'context']));
  if (r.locals.length) {
    events.push({ type: 'locals', runId: r.runId, entries: r.locals.map((e) => ({ step: e.step, scopeId: e.scopeId, changes: e.changes.map((c) => ({ name: c.name, text: redact(c.text) })) })) });
  }
  for (const e of r.errors) events.push(redactText({ ...e } as unknown as Record<string, unknown>, ['message']));
  for (const h of r.http) events.push(redactText({ ...h } as unknown as Record<string, unknown>, ['url']));
  events.push({ type: 'trace', runId: r.runId, steps: encodeSteps(r.trace.steps), scopes: r.trace.scopes.map((s) => redactText({ ...s } as unknown as Record<string, unknown>, ['returned'])), truncated: r.trace.truncated, ...(r.trace.midRun ? { midRun: true } : {}) });
  if (r.finished) events.push({ ...r.finished });
  const files = r.files.map((f) => {
    const lines = r.readSource(f.fileId);
    return { fileId: f.fileId, path: f.path, ...(lines ? { source: redact(lines.join('\n')) } : {}) };
  });
  const meta: Record<string, unknown> = {
    runId: r.runId,
    file: r.file,
    workspaceRoot: r.workspaceRoot,
    exitCode: r.finished?.exitCode ?? null,
    durationMs: r.finished?.durationMs ?? null,
    stepCount: r.trace.steps.length / 4,
    files,
    live: true,
  };
  return { meta, events };
}
