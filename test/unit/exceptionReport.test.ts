/**
 * The host's exceptions report: byte equality with what the Python builder wrote to
 * `fixtures/exceptions.json` over the shared fixture run `fixtures/exceptions-run.json`
 * (python/tests, PYOKKA_WRITE_FIXTURES=1; program: `fixtures/exceptions/`), and the folding,
 * ordering and text rules of docs/PROTOCOL.md over synthetic events.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type StackFrame, type TraceEvent } from '../../src/shared/protocol';
import { EXCEPTION_MESSAGE_MAX, buildExceptionReport, exceptionSummary, renderExceptionLines, type ExceptionReport, type ExceptionReportInputs } from '../../src/session/exceptionReport';

const FIXTURES = path.join(__dirname, 'fixtures');
const RUN = path.join(FIXTURES, 'exceptions-run.json');
const EXPECTED = path.join(FIXTURES, 'exceptions.json');

interface SavedRun {
  meta: { file: string; workspaceRoot: string; durationMs: number; exitCode: number };
  events: ({ type: string } & Record<string, unknown>)[];
}

/** A saved run as the builder's inputs (the walkthrough test's loader without what the report does not read). */
function loadInputs(runFile: string): ExceptionReportInputs {
  const doc = JSON.parse(fs.readFileSync(runFile, 'utf8')) as SavedRun;
  const files = new FileTable();
  const errors: ErrorEvent[] = [];
  let traceEv: TraceEvent | undefined;
  for (const ev of doc.events) {
    if (ev.type === 'file.instrumented') files.add(ev as unknown as FileInstrumentedEvent);
    else if (ev.type === 'error') errors.push(ev as unknown as ErrorEvent);
    else if (ev.type === 'trace' && !ev['partial']) traceEv = ev as unknown as TraceEvent;
  }
  const trace = new TraceModel(decodeSteps(traceEv!.steps), traceEv!.scopes, !!traceEv!.truncated, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  return { trace, files, errors, mainFile: doc.meta.file, finished: { exitCode: doc.meta.exitCode, durationMs: doc.meta.durationMs } };
}

describe('exceptions fixture', () => {
  it('produces the report the Python builder wrote', () => {
    for (const f of [RUN, EXPECTED]) if (!fs.existsSync(f)) throw new Error(`${f} is missing: the Python side writes it (python/tests, PYOKKA_WRITE_FIXTURES=1)`);
    const report = buildExceptionReport(loadInputs(RUN));
    const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) as ExceptionReport;
    expect(report.rows.map((r) => `${r.kind} ${r.errorType} ×${r.count}`)).toEqual(expected.rows.map((r) => `${r.kind} ${r.errorType} ×${r.count}`));
    expect(JSON.parse(JSON.stringify(report))).toEqual(expected);
    expect(report.total).toBe(8);
    expect(report.rows[0]!.kind).toBe('uncaught');
  });
});

/* ---------- synthetic runs ---------- */

const MAIN = '/w/main.py';
const LIB = '/w/venv/site-packages/libx/__init__.py';

/** main.py: rid 0 the module, 1 `return table[key]` (line 21, in lookup), 2 the `try` at 66, 3 the last line; libx: rid 100 `raise TypeError` (line 6). */
function files(): FileTable {
  const t = new FileTable();
  t.add({ fileId: 1, path: MAIN, rangeBase: 0, ranges: [[1, 0, 92, 30], [21, 4, 21, 21], [66, 4, 69, 12], [92, 0, 92, 30]], statements: [1, 2, 3], functions: [{ rid: 1, name: 'lookup', bodyRange: [20, 0, 21, 21] }], magic: [] });
  t.add({ fileId: 2, path: LIB, rangeBase: 100, ranges: [[6, 8, 6, 40]], statements: [0], functions: [], magic: [] });
  return t;
}

function trace(steps: number): TraceModel {
  return new TraceModel(new Int32Array(steps * 4), [], false, () => undefined);
}

const frame = (over: Partial<StackFrame> = {}): StackFrame => ({ fileId: 1, line: 21, col: 4, rid: 1, function: 'lookup', ...over });

function error(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return { type: 'error', runId: 'r-1', seq: 1, fileId: 1, rid: 1, step: 31, message: "'b'", errorType: 'KeyError', stack: [frame(), frame({ line: 68, rid: 2, function: '<module>' })], handled: true, handledAt: { fileId: 1, line: 68, rid: 2, function: '<module>', broad: true }, count: 1, lastStep: 31, ...over };
}

function report(errors: ErrorEvent[], over: Partial<ExceptionReportInputs> = {}): ExceptionReport {
  return buildExceptionReport({ trace: trace(412), files: files(), errors, mainFile: MAIN, finished: { exitCode: 1, durationMs: 12 }, ...over });
}

describe('buildExceptionReport', () => {
  it('folds events of one (kind, type, raise site, handler): count summed, first message and function kept, lastStep the largest', () => {
    const r = report([error({ step: 40, lastStep: 47, count: 2, message: "'d'", stack: [frame({ function: 'later' })] }), error({ step: 31, lastStep: 31, message: "'b'" })]);
    expect(r.total).toBe(1);
    const row = r.rows[0]!;
    expect(row).toMatchObject({ id: 'x0', kind: 'caught', errorType: 'KeyError', message: "'b'", count: 3, step: 31, lastStep: 47 });
    expect(row.raisedAt).toEqual({ file: MAIN, line: 21, function: 'lookup', fileId: 1, rid: 1 });
    expect(row.handledAt).toEqual({ file: MAIN, line: 68, function: '<module>', fileId: 1, rid: 2, broad: true });
    expect(r).toMatchObject({ count: 412, file: MAIN, exitCode: 1, stale: false, staleFiles: [], raises: 3, uncaught: 0, caught: 1, broad: 1 });
  });

  it('defaults count to 1 and lastStep to the step for events of older runs', () => {
    const ev = error();
    delete ev.count;
    delete ev.lastStep;
    const row = report([ev]).rows[0]!;
    expect(row.count).toBe(1);
    expect(row.lastStep).toBe(31);
  });

  it('keeps a row per handler and per kind, uncaught first, then by step and error type', () => {
    const r = report([
      error({ errorType: 'ValueError', rid: 2, step: 50, handledAt: { fileId: 1, line: 67, rid: 2, function: '<module>', broad: false } }),
      error({ errorType: 'IndexError', rid: 2, step: 50, handledAt: undefined }),
      error({ step: 31 }),
      error({ step: 90, handledAt: { fileId: 1, line: 69, rid: 3, function: '<module>', broad: false } }),
      error({ errorType: 'ZeroDivisionError', message: 'division by zero', rid: 3, step: 410, handled: false, handledAt: undefined, count: undefined, lastStep: undefined, stack: [frame({ line: 92, rid: 3, function: '<module>' })], traceback: 'Traceback…' }),
    ]);
    expect(r.rows.map((x) => [x.id, x.kind, x.step, x.errorType])).toEqual([
      ['x0', 'uncaught', 410, 'ZeroDivisionError'],
      ['x1', 'caught', 31, 'KeyError'],
      ['x2', 'caught', 50, 'IndexError'],
      ['x3', 'caught', 50, 'ValueError'],
      ['x4', 'caught', 90, 'KeyError'],
    ]);
    expect(r.rows[0]!.handledAt).toBeNull();
    expect(r.rows[0]!.raisedAt).toEqual({ file: MAIN, line: 92, function: '<module>', fileId: 1, rid: 3 });
    expect(r.rows[2]!.handledAt).toBeNull();
    expect(r.rows[3]!.handledAt?.broad).toBe(false);
    expect(r).toMatchObject({ total: 5, raises: 5, uncaught: 1, caught: 4, broad: 1 });
  });

  it('names the function of the frame that owns the raising statement, else the innermost frame, else the module', () => {
    const inner = frame({ fileId: 2, line: 6, rid: 100, function: 'unwrap' });
    const caller = frame({ line: 80, rid: 3, function: '<module>' });
    // library stepping off: the event is attributed to the calling statement, whose frame is not the innermost
    expect(report([error({ rid: 3, stack: [inner, caller] })]).rows[0]!.raisedAt.function).toBe('<module>');
    expect(report([error({ rid: 100, fileId: 2, stack: [inner, caller] })]).rows[0]!.raisedAt).toEqual({ file: LIB, line: 6, function: 'unwrap', fileId: 2, rid: 100 });
    expect(report([error({ rid: 3, stack: [frame({ rid: undefined, function: '__getattr__' })] })]).rows[0]!.raisedAt.function).toBe('__getattr__');
    expect(report([error({ stack: [] })]).rows[0]!.raisedAt.function).toBe('<module>');
  });

  it('reports unknown files and statements as null and line 0', () => {
    const row = report([error({ fileId: 9, rid: 999, handledAt: { fileId: 9, line: 5, rid: 998, function: 'f', broad: false } })]).rows[0]!;
    expect(row.raisedAt).toEqual({ file: null, line: 0, function: 'lookup', fileId: 9, rid: 999 });
    expect(row.handledAt?.file).toBeNull();
  });

  it('is empty for a run without exceptions and without a trace', () => {
    expect(report([])).toEqual({ count: 412, file: MAIN, exitCode: 1, stale: false, staleFiles: [], total: 0, raises: 0, uncaught: 0, caught: 0, broad: 0, rows: [] });
    const bare = buildExceptionReport({ trace: TraceModel.empty(), files: new FileTable(), errors: [], mainFile: '' });
    expect(bare).toMatchObject({ count: 0, file: null, exitCode: null, total: 0 });
  });

  it('cuts the message at 200 chars and carries staleness', () => {
    const row = report([error({ message: 'x'.repeat(250) })], { stale: true, staleFiles: [MAIN] }).rows[0]!;
    expect(row.message.length).toBe(EXCEPTION_MESSAGE_MAX);
    expect(row.message.endsWith('…')).toBe(true);
    expect(report([], { stale: true, staleFiles: [MAIN] })).toMatchObject({ stale: true, staleFiles: [MAIN] });
  });
});

describe('renderExceptionLines', () => {
  const r = report([
    error({ step: 31, lastStep: 47, count: 3 }),
    error({ errorType: 'AttributeError', message: 'x', rid: 3, step: 300, handledAt: undefined, count: 2, lastStep: 301, stack: [frame({ rid: undefined, function: '__getattr__' })] }),
    error({ errorType: 'ZeroDivisionError', message: 'division by zero', rid: 3, step: 410, handled: false, handledAt: undefined, count: undefined, lastStep: undefined, stack: [frame({ line: 92, rid: 3, function: '<module>' })] }),
  ]);
  it('summarises the run and prints two lines per row, uncaught first', () => {
    const lines = renderExceptionLines(r, (s) => path.basename(s.file ?? ''));
    expect(lines).toEqual([
      '3 exceptions over 412 steps: 1 uncaught, 2 caught (5 raises), 1 by a broad handler',
      '#410  uncaught ZeroDivisionError: division by zero',
      '      raised main.py:92 <module>',
      "#31  caught ×3 KeyError: 'b'",
      '      raised main.py:21 lookup · caught main.py:68 <module> broad handler · last #47',
      '#300  caught ×2 AttributeError: x',
      '      raised main.py:92 __getattr__ · caught outside stepped code · last #301',
    ]);
  });
  it('bounds every line at 100 chars and words the empty and singular cases', () => {
    const long = renderExceptionLines(report([error({ message: 'y'.repeat(180) })]));
    expect(long.every((l) => l.length <= 100)).toBe(true);
    expect(long[1]!.endsWith('…')).toBe(true);
    expect(long[2]).toBe(`      raised ${MAIN}:21 lookup · caught ${MAIN}:68 <module> broad handler`);
    expect(exceptionSummary(report([]))).toBe('no exceptions over 412 steps');
    expect(exceptionSummary(report([error({ handledAt: { fileId: 1, line: 67, rid: 2, function: '<module>', broad: false } })]))).toBe('1 exception over 412 steps: 0 uncaught, 1 caught');
  });
});
