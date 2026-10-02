import { describe, expect, it } from 'vitest';
import { TraceModel, packSteps } from '../../src/timeMachine/traceModel';
import { FileTable } from '../../src/session/fileTable';
import type { LocalsEvent, LogEvent, Range4, StatementBinding, TraceScope } from '../../src/shared/protocol';
import { indexBindings, matchesName, variableHistory, type HistoryInputs } from '../../src/session/variableHistory';

const scope = (scopeId: number, name: string, parent: number, depth: number, first: number, last: number, rid = 0): TraceScope => ({ scopeId, rid, name, parent, depth, first, last });
const log = (rid: number, step: number, text: string, context: string, kind: LogEvent['kind'] = 'autoLog'): LogEvent => ({ type: 'log', runId: 'r', seq: 0, logId: `l-${rid}-${step}`, kind, fileId: 1, rid, hit: 1, step, context, text, runtimeKey: `k${rid}` });

/**
 * rid == source line; one file (id 1, /w/main.py):
 *  1  total = 0
 *  2  for i in range(2):
 *  3      total += i
 *  4  print(total)
 * steps: 0 (line 1) -> 1 (loop start, line 2) -> 2 (iteration 1) -> 3 (line 3) -> 4 (iteration 2) -> 5 (line 3) -> 6 (line 4)
 * locals are observed at the start of a step: total=0 at #1, i=0 at #2 (bound by the iteration step itself),
 * i=1 at #4, total=1 at #6 (0 + 0 left total unchanged after #3)
 */
function loop(): HistoryInputs & { locals: LocalsEvent['entries'] } {
  const files = new FileTable();
  const ranges: Range4[] = [[0, 0, 0, 0], [1, 0, 1, 9], [2, 0, 2, 18], [3, 4, 3, 14], [4, 0, 4, 12]];
  const file = files.add({ fileId: 1, path: '/w/main.py', rangeBase: 0, ranges, statements: [1, 2, 3, 4], functions: [], magic: [] });
  const trace = new TraceModel(packSteps([[1, 0, 0], [2, 0, 0], [2, 0, 0], [3, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]), [scope(0, '<module>', -1, 0, 0, 6)], false, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const locals: LocalsEvent['entries'] = [
    { step: 1, scopeId: 0, changes: [{ name: 'total', text: '0' }] },
    { step: 2, scopeId: 0, changes: [{ name: 'i', text: '0' }] },
    { step: 4, scopeId: 0, changes: [{ name: 'i', text: '1' }] },
    { step: 6, scopeId: 0, changes: [{ name: 'total', text: '1' }] },
  ];
  const statements: StatementBinding[] = [
    { line: 1, col: 0, assigns: ['total'], reads: [] },
    { line: 2, col: 0, assigns: ['i'], reads: [], loop: 3 },
    { line: 3, col: 4, assigns: ['total'], reads: ['total', 'i'] },
    { line: 4, col: 0, assigns: [], reads: ['total'] },
  ];
  return { trace, files, entriesByRid: new Map(), locals, bindings: new Map([[1, indexBindings(file, statements)]]), mainFileId: 1 };
}

describe('variableHistory', () => {
  it('attributes recorded locals to the statement that bound the name and infers unchanged assignments', () => {
    const h = variableHistory(loop(), 'total');
    expect(h.name).toBe('total');
    expect(h.recordedLocals).toBe(true);
    expect(h.total).toBe(3);
    expect(h.truncated).toBe(false);
    expect(h.changes.map((c) => [c.step, c.line, c.text, c.source, c.unchanged ?? false])).toEqual([
      [0, 1, '0', 'locals', false],
      [3, 3, '0', 'assign', true], // ran, the next step of the scope saw no change: still 0
      [5, 3, '1', 'locals', false],
    ]);
    expect(h.changes[0]).toMatchObject({ file: '/w/main.py', fileId: 1, function: '<module>', scopeId: 0, name: 'total' });
    // what `total += i` read at step 5, with the values recorded before it and the steps that made them
    expect(h.changes[2]!.reads).toEqual([
      { name: 'total', text: '0', step: 0 },
      { name: 'i', text: '1', step: 4 },
    ]);
    expect(h.changes[0]!.reads).toBeUndefined();
  });

  it('gives loop iterations their own binding and skips the step before the loop', () => {
    const h = variableHistory(loop(), 'i');
    expect(h.changes.map((c) => [c.step, c.line, c.text, c.source])).toEqual([
      [2, 2, '0', 'locals'],
      [4, 2, '1', 'locals'],
    ]);
  });

  it('merges a logged value with the locals row of its step and lists paths under the name', () => {
    const inputs = loop();
    inputs.entriesByRid = new Map([
      [3, [log(3, 5, '1', 'total')]],
      [4, [log(4, 6, '1', 'total.bit_length()', 'value'), log(4, 6, 'x', 'print', 'log')]],
    ]);
    const h = variableHistory(inputs, 'total');
    expect(h.changes.map((c) => [c.step, c.name, c.source, c.logId])).toEqual([
      [0, 'total', 'locals', undefined],
      [3, 'total', 'assign', undefined],
      [5, 'total', 'locals', 'l-3-5'],
      [6, 'total.bit_length()', 'value', 'l-4-6'],
    ]);
  });

  it('counts an autoExpand log (`# ?+`) as a value', () => {
    const inputs = loop();
    inputs.entriesByRid = new Map([[4, [log(4, 6, '1', 'total', 'autoExpand'), log(4, 6, '1', 'total', 'time')]]]);
    const h = variableHistory(inputs, 'total');
    expect(h.changes.map((c) => [c.step, c.source, c.logId])).toEqual([
      [0, 'locals', undefined],
      [3, 'assign', undefined],
      [5, 'locals', undefined],
      [6, 'value', 'l-4-6'],
    ]);
    expect(h.changes[3]!.reads).toEqual([{ name: 'total', text: '1', step: 5 }]);
  });

  it('lists assignment sites alone when nothing recorded the value', () => {
    const inputs = loop();
    inputs.locals = [];
    const h = variableHistory(inputs, 'total');
    expect(h.recordedLocals).toBe(false);
    expect(h.changes.map((c) => [c.step, c.source, c.text])).toEqual([
      [0, 'assign', undefined],
      [3, 'assign', undefined],
      [5, 'assign', undefined],
    ]);
    expect(h.changes[2]!.reads).toEqual([{ name: 'total' }, { name: 'i' }]);
  });

  it('narrows by file and scope and caps the list', () => {
    const inputs = loop();
    expect(variableHistory(inputs, 'total', { fileId: 2 }).changes).toEqual([]);
    expect(variableHistory(inputs, 'total', { scope: 'f' }).total).toBe(0);
    const capped = variableHistory(inputs, 'total', { limit: 2 });
    expect(capped.total).toBe(3);
    expect(capped.truncated).toBe(true);
    expect(capped.changes.map((c) => c.step)).toEqual([0, 3]);
    expect(variableHistory(inputs, 'nothing').changes).toEqual([]);
  });

  it('falls back to the observed step without bindings', () => {
    const inputs = loop();
    inputs.bindings = new Map();
    const h = variableHistory(inputs, 'total');
    expect(h.changes.map((c) => [c.step, c.line, c.text])).toEqual([
      [1, 2, '0'],
      [6, 4, '1'],
    ]);
  });
});

describe('matchesName and indexBindings', () => {
  it('matches the name and paths under or above it', () => {
    expect(matchesName('acct', 'acct')).toBe(true);
    expect(matchesName('acct.deposit(amount)', 'acct')).toBe(true);
    expect(matchesName('acct[0]', 'acct')).toBe(true);
    expect(matchesName('self', 'self.balance')).toBe(true);
    expect(matchesName('account', 'acct')).toBe(false);
    expect(matchesName(undefined, 'acct')).toBe(false);
    expect(matchesName('acct', '')).toBe(false);
  });

  it('keys bindings by global range id, statements winning over def headers at one position', () => {
    const files = new FileTable();
    const file = files.add({ fileId: 3, path: '/w/lib.py', rangeBase: 10, ranges: [[1, 0, 3, 0], [1, 0, 1, 9], [2, 4, 2, 9]], statements: [1], functions: [{ rid: 0, name: 'f', bodyRange: [1, 0, 3, 0] }, { rid: 1, name: '<lambda>', bodyRange: [1, 0, 1, 9] }], magic: [] });
    const table = indexBindings(file, [{ line: 1, col: 0, assigns: ['x'], reads: [] }, { line: 2, col: 4, assigns: ['y'], reads: ['x'] }, { line: 9, col: 0, assigns: ['z'], reads: [] }]);
    expect([...table.keys()]).toEqual([11]);
    expect(table.get(11)?.assigns).toEqual(['x']);
  });
});
