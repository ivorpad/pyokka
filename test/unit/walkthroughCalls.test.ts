/**
 * The host's walkthrough builder over `fixtures/walkthrough-calls-run.json` (callbacks from
 * unrecorded code, a tail call), written by python/tests/test_walkthrough_calls.py: it must build
 * the moments the Python builder wrote to `fixtures/walkthrough-calls-moments.json`. Regenerate
 * both from the Python side with PYOKKA_WRITE_FIXTURES=1.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type LocalsEvent, type LogEvent, type TraceEvent } from '../../src/shared/protocol';
import { buildWalkthrough, type WalkthroughInputs } from '../../src/session/walkthrough';

const FIXTURES = path.join(__dirname, 'fixtures');
const PROGRAM = path.join(FIXTURES, 'walkthrough-calls');
const FIXTURE_ROOT = '/fixture';

interface SavedRun {
  meta: { file: string; workspaceRoot: string; durationMs: number; exitCode: number };
  events: ({ type: string } & Record<string, unknown>)[];
}

function loadInputs(): WalkthroughInputs {
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
    else if (ev.type === 'trace' && !ev['partial']) traceEv = ev as unknown as TraceEvent;
  }
  const trace = new TraceModel(decodeSteps(traceEv!.steps), traceEv!.scopes, !!traceEv!.truncated, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const readSource = (fileId: number): string[] | undefined => {
    const p = files.get(fileId)?.path;
    if (!p || !p.startsWith(FIXTURE_ROOT + '/')) return undefined;
    return fs.readFileSync(path.join(PROGRAM, p.slice(FIXTURE_ROOT.length + 1)), 'utf8').split('\n');
  };
  return { trace, files, entries, locals, errors, mainFile: doc.meta.file, workspaceRoot: doc.meta.workspaceRoot, readSource, finished: { exitCode: doc.meta.exitCode, durationMs: doc.meta.durationMs } };
}

describe('walkthrough calls fixture', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'walkthrough-calls-moments.json'), 'utf8')) as Record<string, unknown>[];
  const w = buildWalkthrough(loadInputs());
  const byCallee = new Map(w.moments.filter((m) => m.kind === 'call' || m.kind === 'tool').map((m) => [m.callee!.function, m]));

  it('produces the moments the Python builder wrote', () => {
    expect(w.moments.map((m) => m.text)).toEqual(expected.map((m) => m['text']));
    expect(JSON.parse(JSON.stringify(w.moments))).toEqual(expected);
  });

  it('files a callback from unrecorded code at its entry, under the function that was running', () => {
    const ask = byCallee.get('ask')!;
    for (const name of ['double', 'inc']) {
      const m = byCallee.get(name)!;
      expect(m.kind).toBe('tool');
      expect(m.step).toBe(m.entryStep);
      expect(m.location.function).toBe(name);
      expect(m.callerScopeId).toBe(ask.scopeId);
      expect(m.text).toBe(`callback into ${name} from ask`);
    }
    expect(ask.kind).toBe('call');
    expect(ask.callerScopeId).toBeUndefined();
  });

  it('gives a lambda no out rather than the value the calling statement logged', () => {
    const lambdas = w.moments.filter((m) => m.kind === 'call' && m.callee?.function === '<lambda>');
    expect(lambdas).toHaveLength(2);
    for (const m of lambdas) expect(m.values.filter((v) => v.role === 'out')).toEqual([]);
  });

  it('ends a call that ends in a tail call after the callee', () => {
    const inner = byCallee.get('inner')!;
    expect(byCallee.get('outer')!.endStep).toBe(inner.endStep);
    expect(byCallee.get('main')!.endStep).toBe(byCallee.get('rank')!.endStep);
    expect(inner.endStep!).toBeGreaterThan(inner.entryStep!);
  });
});
