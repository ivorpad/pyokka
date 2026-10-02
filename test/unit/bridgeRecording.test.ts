/**
 * The bridge's `recording` reply: a session's run as a saved run's `{meta, events}`, the input of
 * `pyokka tour --live` (python/tests/test_tour.py reads the same shape from a fake bridge).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type HttpExchangeEvent, type LocalsEvent, type LogEvent, type TraceEvent } from '../../src/shared/protocol';
import { encodeSteps, recordingDoc, type RecordingInputs } from '../../src/agent/bridgeRecording';

const FIXTURES = path.join(__dirname, 'fixtures');

interface SavedRun {
  meta: { file: string; workspaceRoot: string };
  events: ({ type: string } & Record<string, unknown>)[];
}

function inputs(): { r: RecordingInputs; traceEv: TraceEvent } {
  const doc = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'walkthrough-calls-run.json'), 'utf8')) as SavedRun;
  const files = new FileTable();
  const entries: LogEvent[] = [];
  const locals: LocalsEvent['entries'] = [];
  const errors: ErrorEvent[] = [];
  let traceEv: TraceEvent | undefined;
  for (const ev of doc.events) {
    if (ev.type === 'file.instrumented') files.add(ev as unknown as FileInstrumentedEvent);
    else if (ev.type === 'log') entries.push(ev as unknown as LogEvent);
    else if (ev.type === 'locals') locals.push(...(ev as unknown as LocalsEvent).entries);
    else if (ev.type === 'error') errors.push(ev as unknown as ErrorEvent);
    else if (ev.type === 'trace') traceEv = ev as unknown as TraceEvent;
  }
  if (!traceEv) throw new Error('fixture has no trace');
  const http = [{ type: 'http.exchange', runId: 'r1', seq: 1, n: 1, method: 'GET', url: 'https://example.test/v1/items?api_key=sk-abcdefghijklmnopqrstuvwxyz0123', status: 200, rid: 3, step: 4 } as unknown as HttpExchangeEvent];
  const r: RecordingInputs = {
    runId: 'r1',
    file: doc.meta.file,
    workspaceRoot: doc.meta.workspaceRoot,
    files: files.all(),
    trace: { steps: decodeSteps(traceEv.steps), scopes: traceEv.scopes, truncated: false },
    entries: [...entries, { type: 'log', runId: 'r1', seq: 0, logId: 'live-1', kind: 'value', fileId: 1, rid: 0, hit: 1, step: 0, context: 'x', text: '1' } as LogEvent],
    locals: [...locals, { step: 1, scopeId: 0, changes: [{ name: 'token', text: "'sk-abcdefghijklmnopqrstuvwxyz0123'" }] }],
    errors,
    coverage: new Map([[1, { states: [1, 2], hits: [1, 0] }]]),
    http,
    finished: { type: 'run.finished', runId: 'r1', seq: 9, exitCode: 0, durationMs: 12 } as RecordingInputs['finished'],
    readSource: (fileId) => (fileId === files.all()[0]?.fileId ? ['x = 1', 'print(x)'] : undefined),
  };
  return { r, traceEv };
}

describe('recordingDoc', () => {
  it('carries the trace as the runtime sent it and every file with its source', () => {
    const { r, traceEv } = inputs();
    const doc = recordingDoc(r);
    const trace = doc.events.find((e) => e['type'] === 'trace');
    expect(trace?.['steps']).toBe(traceEv.steps);
    expect(encodeSteps(decodeSteps(traceEv.steps))).toBe(traceEv.steps);
    expect(doc.events.filter((e) => e['type'] === 'file.instrumented')).toHaveLength(r.files.length);
    const files = doc.meta['files'] as { fileId: number; path: string; source?: string }[];
    expect(files[0]?.source).toBe('x = 1\nprint(x)');
    expect(doc.meta['file']).toBe(r.file);
    expect(doc.meta['exitCode']).toBe(0);
    expect(doc.meta['stepCount']).toBe(r.trace.steps.length / 4);
    expect(doc.events.some((e) => e['type'] === 'coverage' && e['fileId'] === 1)).toBe(true);
    expect(doc.events.some((e) => e['type'] === 'run.finished')).toBe(true);
  });

  it('leaves out the host evaluations and redacts secrets in values and URLs', () => {
    const { r } = inputs();
    const doc = recordingDoc(r);
    expect(doc.events.some((e) => e['type'] === 'log' && e['logId'] === 'live-1')).toBe(false);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    const localsEv = doc.events.find((e) => e['type'] === 'locals') as { entries: LocalsEvent['entries'] } | undefined;
    expect(localsEv?.entries.length).toBe(r.locals.length);
  });
});
