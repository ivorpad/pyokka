/**
 * A JavaScript/TypeScript run's walkthrough: decisions, loops and returns come from the runtime's
 * AST table (`file.instrumented.walk`), not from Python's indentation.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type FileInstrumentedEvent, type LogEvent, type TraceEvent } from '../../src/shared/protocol';
import { buildWalkthrough } from '../../src/session/walkthrough';
import { fileMap } from '../../src/session/decisions';

const FIXTURES = path.join(__dirname, 'fixtures');

function inputs() {
  const doc = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'walkthrough-js-run.json'), 'utf8'));
  const files = new FileTable();
  const entries: LogEvent[] = [];
  let traceEv: TraceEvent | undefined;
  for (const ev of doc.events) {
    if (ev.type === 'file.instrumented') files.add(ev as FileInstrumentedEvent);
    else if (ev.type === 'log') entries.push(ev as LogEvent);
    else if (ev.type === 'trace' && !ev.partial) traceEv = ev as TraceEvent;
  }
  const trace = new TraceModel(decodeSteps(traceEv!.steps), traceEv!.scopes, false, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const readSource = () => fs.readFileSync(path.join(FIXTURES, 'walkthrough-js', 'grade.ts'), 'utf8').split('\n');
  return { trace, files, entries, locals: [], errors: [], mainFile: doc.meta.file, workspaceRoot: doc.meta.workspaceRoot, readSource, finished: { exitCode: 0, durationMs: 5 } };
}

describe('walkthrough of a TypeScript run', () => {
  it('reads if / else if / else, for...of, while and switch from the walk table', () => {
    const f = inputs().files.all()[0]!;
    const map = fileMap([], [], f.walk);
    expect(map.js).toBe(true);
    expect(map.decisions.get(4)).toMatchObject({ kind: 'if', label: 'else if', text: '(n > 80)', body: [5, 5], orelse: [7, 7] });
    expect(map.loops.get(11)).toMatchObject({ kind: 'for', text: '(const n of [95, 85, 70])' });
    expect(map.returns.has(3)).toBe(true);
    expect(map.functions.get(1)).toEqual({ name: 'grade', line: 1, end: 9 });
  });

  it('says which way each decision went in JavaScript terms', () => {
    const texts = buildWalkthrough(inputs()).moments.map((m) => m.text);
    expect(texts).toContain('if (n > 90) took true');
    expect(texts).toContain('else if (n > 80) took true');
    expect(texts).toContain('else if (n > 80) took false');
    expect(texts).toContain('for (const n of [95, 85, 70]) ran 3 times');
    expect(texts).toContain('while (i < 2) ran 2 times');
    expect(texts).toContain("switch (out[0]) took case 'A'");
  });
});
