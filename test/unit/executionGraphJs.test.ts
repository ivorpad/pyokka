/**
 * The execution graph of a TypeScript run (`fixtures/graph-js/main.ts`, saved into
 * `fixtures/graph-js-run.json` by a JavaScript runtime's `run --save`): statement and header names come from
 * the runtime's AST (`walk.names`), labels drop `//` and `/* *\/` comments and keep `#` in strings,
 * and declarations, imports and decision headers are not statement nodes.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import { TraceModel } from '../../src/timeMachine/traceModel';
import { decodeSteps, type FileInstrumentedEvent, type LocalsEvent, type LogEvent, type TraceEvent } from '../../src/shared/protocol';
import { buildExecutionGraph, type ExecutionGraph, type StatementNode } from '../../src/session/executionGraph';
import { stripJsCode } from '../../src/session/names';
import { notRun } from '../../src/session/executionGraphRows';

const FIXTURES = path.join(__dirname, 'fixtures');

function build(): ExecutionGraph {
  const doc = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'graph-js-run.json'), 'utf8'));
  const files = new FileTable();
  const entries: LogEvent[] = [];
  const locals: LocalsEvent['entries'] = [];
  let traceEv: TraceEvent | undefined;
  for (const ev of doc.events) {
    if (ev.type === 'file.instrumented') files.add(ev as FileInstrumentedEvent);
    else if (ev.type === 'log') entries.push(ev as LogEvent);
    else if (ev.type === 'locals') locals.push(...(ev as LocalsEvent).entries);
    else if (ev.type === 'trace' && !ev.partial) traceEv = ev as TraceEvent;
  }
  const trace = new TraceModel(decodeSteps(traceEv!.steps), traceEv!.scopes, false, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const readSource = () => fs.readFileSync(path.join(FIXTURES, 'graph-js', 'main.ts'), 'utf8').split('\n');
  return buildExecutionGraph({ trace, files, entries, locals, errors: [], mainFile: doc.meta.file, workspaceRoot: doc.meta.workspaceRoot, readSource, finished: { exitCode: 0, durationMs: 5 } }, {});
}

describe('execution graph of a TypeScript run', () => {
  const g = build();
  const statements = g.nodes.filter((n): n is StatementNode => n.kind === 'statement');
  const labelOf = (id: string) => g.nodes.find((n) => n.id === id)!.label;

  const statement = (line: number) => statements.find((s) => s.line === line)!;
  const dataEdges = () => g.edges.filter((e) => e.kind === 'data').map((e) => `${labelOf(e.from)} ⇢ ${labelOf(e.to)} ${e.label}`);

  it('names destructuring, augmented assignment and template literals from the AST', () => {
    expect(statement(19)).toMatchObject({ label: 'const [first] = items;', targets: ['first'], reads: ['items'] });
    expect(statement(8)).toMatchObject({ targets: ['sum'], reads: ['sum', 'price'] });
    expect(statement(20)).toMatchObject({ label: 'const label = `#${first!.name}`;', targets: ['label'], reads: ['first'] });
    expect(statement(10)).toMatchObject({ label: 'const tax = sum * rate;', targets: ['tax'], reads: ['sum', 'rate'] });
  });

  it('leaves declarations and decision headers out of the statement nodes', () => {
    expect(statements.map((s) => s.line).sort((a, b) => a - b)).toEqual([6, 8, 10, 12, 17, 18, 19, 20, 21]);
  });

  it('draws data edges into loop and if headers from their AST names', () => {
    expect(dataEdges()).toEqual(expect.arrayContaining(['for (const { price } of items) ⇢ sum += price; price', 'const tax = sum * rate; ⇢ if (tax > 1) tax', 'let sum = 0; ⇢ sum += price; sum']));
  });

  it('strips JS comments but not `#` or `//` inside strings', () => {
    expect(stripJsCode(["const a = '#x' // c", 'const u = "http://h" /* b */ + 1'])).toBe("const a = '#x'  const u = \"http://h\"  + 1");
    expect(stripJsCode(['x = 1 /* across', 'lines */ + 2'])).toBe('x = 1   + 2');
  });
});

describe('notRun on a JS decision', () => {
  // a JS/TS run records the branch taken as `true`/`false`, Python as `True`/`False`
  const builder = { fileMapOf: () => ({ decisions: new Map([[3, { kind: 'if', body: [4], orelse: [6] }]]) }) } as never;
  it('names the arm a one-sided JS if never ran', () => {
    expect(notRun(builder, { loop: false, fileId: 1, line: 3, takens: new Set(['true']) })).toEqual([6]);
    expect(notRun(builder, { loop: false, fileId: 1, line: 3, takens: new Set(['false']) })).toEqual([4]);
    expect(notRun(builder, { loop: false, fileId: 1, line: 3, takens: new Set(['true', 'false']) })).toEqual([]);
    expect(notRun(builder, { loop: false, fileId: 1, line: 3, takens: new Set(['True']) })).toEqual([6]);
  });
});
