/**
 * The host's walkthrough builder over the shared fixture run (`fixtures/walkthrough-run.json`,
 * written by python/tests/test_walkthrough.py): it must produce exactly the moments the Python
 * builder wrote to `fixtures/walkthrough-moments.json`. Regenerate both from the Python side
 * with PYOKKA_WRITE_FIXTURES=1.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type ErrorEvent, type FileInstrumentedEvent, type LocalsEvent, type LogEvent, type Range4, type TraceEvent } from '../../src/shared/protocol';
import { buildWalkthrough, cut, displayPath, formatDuration, isUserFile, libraryPackage, packageOf, renderWalkthroughLines, type WalkthroughInputs } from '../../src/session/walkthrough';
import { collapse, enclosingFunction, fileMap } from '../../src/session/decisions';

const FIXTURES = path.join(__dirname, 'fixtures');
const PROGRAM = path.join(FIXTURES, 'walkthrough');
const FIXTURE_ROOT = '/fixture';

interface SavedRun {
  meta: { file: string; workspaceRoot: string; durationMs: number; exitCode: number };
  events: ({ type: string } & Record<string, unknown>)[];
}

function loadInputs(): WalkthroughInputs & { meta: SavedRun['meta'] } {
  const doc = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'walkthrough-run.json'), 'utf8')) as SavedRun;
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
    try {
      return fs.readFileSync(path.join(PROGRAM, p.slice(FIXTURE_ROOT.length + 1)), 'utf8').split('\n');
    } catch {
      return undefined;
    }
  };
  return { trace, files, entries, locals, errors, mainFile: doc.meta.file, workspaceRoot: doc.meta.workspaceRoot, readSource, finished: { exitCode: doc.meta.exitCode, durationMs: doc.meta.durationMs }, meta: doc.meta };
}

describe('walkthrough fixture', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'walkthrough-moments.json'), 'utf8')) as Record<string, unknown>[];

  it('produces the moments the Python builder wrote', () => {
    const w = buildWalkthrough(loadInputs());
    expect(w.moments.map((m) => m.text)).toEqual(expected.map((m) => m['text']));
    expect(JSON.parse(JSON.stringify(w.moments))).toEqual(expected);
    expect(w.total).toBe(expected.length);
    expect(w.capped).toBe(false);
  });

  it('applies glosses, windows and the scope filter like the CLI', () => {
    const inputs = loadInputs();
    const w = buildWalkthrough({ ...inputs, gloss: { m0: 'the program begins', zz: 'ignored', m1: '' } });
    expect(w.moments[0]!.gloss).toBe('the program begins');
    expect(w.moments[1]!.gloss).toBeNull();
    const greet = buildWalkthrough(inputs).moments.find((m) => m.text === 'call to greet from <module>')!;
    const win = buildWalkthrough(inputs, { from: greet.step, to: greet.endStep });
    expect(win.moments.map((m) => m.text).slice(0, 2)).toEqual(['call to greet from <module>', "msg = 'hello bob'"]);
    expect(win.shown).toBeLessThan(w.shown);
    const scoped = buildWalkthrough(inputs, { scope: 'fail' });
    expect(scoped.moments.map((m) => m.text)).toContain('if n > 100 took False');
    expect(scoped.moments.map((m) => m.text)).not.toContain('module main.py starts');
    const helper = inputs.files.all().find((f) => f.path.endsWith('helper.py'))!;
    const byFile = buildWalkthrough(inputs, { fileId: helper.fileId });
    expect(byFile.moments.length).toBeGreaterThan(0);
    expect(byFile.moments.every((m) => m.location.fileId === helper.fileId)).toBe(true);
  });

  it('lists every library call with all', () => {
    const inputs = loadInputs();
    const merged = buildWalkthrough(inputs);
    const every = buildWalkthrough(inputs, { all: true });
    expect(every.total).toBe(merged.total + 1);
    expect(every.moments.map((m) => m.text)).toContain('call to helper (libq) from run');
  });

  it('collapses repeated calls under the cap', () => {
    const inputs = loadInputs();
    const w = buildWalkthrough(inputs, { cap: 10 });
    expect(w.capped).toBe(true);
    expect(w.shown).toBeLessThanOrEqual(10);
    const double = w.moments.find((m) => m.text.startsWith('call 1 of 3 to double'))!;
    expect(double.more).toBe(2);
    expect(w.moments.some((m) => m.text.startsWith('call 2 of 3'))).toBe(false);
  });

  it('renders the text form the CLI prints', () => {
    const lines = renderWalkthroughLines(buildWalkthrough(loadInputs()));
    expect(lines[0]).toBe('#0  module main.py starts');
    expect(lines).toContain("      in name = 'bob'");
    expect(lines.every((l) => l.length <= 100)).toBe(true);
  });
});

describe('decisions (indentation file map)', () => {
  const src = ['class A:', '    class B:', '        def m(self):', '            if x:', '                pass', '            elif (y and', '                  z):', '                return 1', '            for a in b:', '                while c:', '                    pass', '            match p:', '                case 1 | 2:', '                    pass', '                case _:', '                    pass', 'def top():', '    return 2', ''];
  const stmts: Range4[] = [[1, 0, 1, 7], [2, 4, 2, 11], [3, 8, 3, 19], [4, 12, 4, 16], [5, 16, 5, 20], [6, 12, 7, 20], [8, 16, 8, 24], [9, 12, 9, 22], [10, 16, 10, 23], [11, 20, 11, 24], [12, 12, 12, 19], [14, 20, 14, 24], [16, 20, 16, 24], [17, 0, 17, 9], [18, 4, 18, 12]];
  const map = fileMap(src, stmts);
  it('finds qualified names, decisions, loops, returns and function spans like the AST', () => {
    expect([...map.qualnames]).toEqual([[3, 'A.B.m'], [17, 'top']]);
    expect(map.decisions.get(4)).toEqual({ kind: 'if', label: 'if', line: 4, text: 'x', body: [5, 5], orelse: [6, 8] });
    expect(map.decisions.get(6)).toEqual({ kind: 'if', label: 'elif', line: 6, text: 'y and z', body: [8, 8], orelse: [0, 0] });
    expect(map.decisions.get(12)).toEqual({ kind: 'match', line: 12, text: 'p', arms: [{ text: '1 | 2', body: [14, 14] }, { text: '_', body: [16, 16] }] });
    expect(map.loops.get(9)).toEqual({ kind: 'for', line: 9, text: 'a in b', end: 11 });
    expect(map.loops.get(10)?.kind).toBe('while');
    expect([...map.returns]).toEqual([8, 18]);
    expect(map.functions.get(17)).toEqual({ name: 'top', line: 17, end: 18 });
    expect(enclosingFunction(map, 10)?.name).toBe('A.B.m');
    expect(enclosingFunction(map, 1)).toBeUndefined();
  });
  it('collapses and unwraps like Python', () => {
    expect(collapse('  a   b\n c ')).toBe('a b c');
    expect(collapse('x'.repeat(70)).length).toBe(60);
    expect(fileMap(['if ((a)):', '    pass'], [[1, 0, 1, 8], [2, 4, 2, 8]]).decisions.get(1)?.text).toBe('a');
    expect(fileMap(['if (a) and (b):', '    pass'], [[1, 0, 1, 14], [2, 4, 2, 8]]).decisions.get(1)?.text).toBe('(a) and (b)');
  });
  it('finds the else arm like Python', () => {
    const src = ['if a:', '    x = 1', '    # trailing', 'else:', '    y = 1', '    z = 2', 'if b:', '    pass', 'elif c:', '    pass', 'elif d:', '    pass', 'else:', '    q = 1', 'if e:', '    pass', 'w = 1'];
    const stmts: Range4[] = [[1, 0, 1, 4], [2, 4, 2, 9], [5, 4, 5, 9], [6, 4, 6, 9], [7, 0, 7, 4], [8, 4, 8, 8], [9, 0, 9, 6], [10, 4, 10, 8], [11, 0, 11, 6], [12, 4, 12, 8], [14, 4, 14, 9], [15, 0, 15, 4], [16, 4, 16, 8], [17, 0, 17, 5]];
    const map = fileMap(src, stmts);
    expect(map.decisions.get(1)).toMatchObject({ body: [2, 2], orelse: [5, 6] });
    expect(map.decisions.get(7)).toMatchObject({ body: [8, 8], orelse: [9, 14] });
    expect(map.decisions.get(9)).toMatchObject({ body: [10, 10], orelse: [11, 14] });
    expect(map.decisions.get(11)).toMatchObject({ body: [12, 12], orelse: [14, 14] });
    expect(map.decisions.get(15)).toMatchObject({ body: [16, 16], orelse: [0, 0] });
  });
});

describe('walkthrough helpers', () => {
  it('tells user files from packages and names them', () => {
    expect(isUserFile('/w/a.py', '/w', '/w/main.py')).toBe(true);
    expect(isUserFile('/w/venv/site-packages/x/y.py', '/w', '/w/main.py')).toBe(false);
    expect(isUserFile('/elsewhere/main.py', '/w', '/elsewhere/main.py')).toBe(true);
    expect(isUserFile('/elsewhere/other.py', '/w', '/elsewhere/main.py')).toBe(false);
    expect(packageOf('/v/site-packages/openai/_client.py')).toBe('openai');
    expect(packageOf('/v/site-packages/typing_extensions.py')).toBe('typing_extensions');
    expect(packageOf('/w/a.py')).toBeUndefined();
    expect(libraryPackage('/v/site-packages/openai/_client.py')).toBe('openai');
    expect(libraryPackage('/x/pylib/libdemo/__init__.py')).toBe('libdemo');
    expect(libraryPackage('/x/pylib/libdemo/util.py')).toBe('util');
    expect(libraryPackage(null)).toBeUndefined();
    expect(displayPath('/v/site-packages/openai/_client.py', '/w')).toBe('openai/_client.py');
    expect(displayPath('/w/pkg/a.py', '/w')).toBe('pkg/a.py');
  });
  it('formats durations and cuts text like the Python side', () => {
    expect([69.7, 12.5, 999.5, 1250, 3719.4, 4000].map(formatDuration)).toEqual(['70 ms', '13 ms', '1000 ms', '1.3 s', '3.7 s', '4.0 s']);
    expect(cut('  a \n b  ', 10)).toBe('a b');
    expect(cut('abcdefghij', 5)).toBe('abcd…');
  });
});
