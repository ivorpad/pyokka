import { describe, expect, it } from 'vitest';
import { TraceModel, packSteps } from '../../src/timeMachine/traceModel';
import { FileTable } from '../../src/session/fileTable';
import type { ErrorEvent, LogEvent, Range4, TraceScope } from '../../src/shared/protocol';
import { BLOCK_LINE_CAP, VALUE_CAP, contextSliceForLine, contextSliceForStep, firstStepOnLines, valuesAtStep, valuesForLine, type SliceInputs } from '../../src/session/contextSlice';

const scope = (scopeId: number, name: string, parent: number, depth: number, first: number, last: number, rid = 0): TraceScope => ({ scopeId, rid, name, parent, depth, first, last });
const log = (rid: number, step: number, text: string, context?: string, hit = 1): LogEvent => ({ type: 'log', runId: 'r', seq: 0, logId: `l-${rid}-${step}`, kind: 'autoLog', fileId: 1, rid, hit, step, context, text, runtimeKey: `k${rid}` });

/**
 * rid == source line; one file (id 1, path /w/main.py):
 *  1  def f():
 *  2      x = g()
 *  3  def g():
 *  4      if False:
 *  5          never = 1
 *  6      return 1
 *  7  f()
 *  8  print(x)
 * steps: 7 (call f) -> 2 (in f) -> 4, 6 (in g) -> 8
 */
const SOURCE = ['def f():', '    x = g()', 'def g():', '    if False:', '        never = 1', '    return 1', 'f()', 'print(x)'];

function nested(): SliceInputs & { entriesByRid: Map<number, LogEvent[]> } {
  const files = new FileTable();
  const ranges: Range4[] = [[0, 0, 0, 0], [1, 0, 2, 11], [2, 4, 2, 11], [3, 0, 6, 12], [4, 4, 4, 13], [5, 8, 5, 17], [6, 4, 6, 12], [7, 0, 7, 3], [8, 0, 8, 8]];
  files.add({ fileId: 1, path: '/w/main.py', rangeBase: 0, ranges, statements: [1, 2, 3, 4, 5, 6, 7, 8], functions: [{ rid: 1, name: 'f', bodyRange: [1, 0, 2, 11] }, { rid: 3, name: 'g', bodyRange: [3, 0, 6, 12] }], magic: [] });
  const steps = packSteps([
    [7, 0, 0],
    [2, 1, 1, 4],
    [4, 2, 2, 4],
    [6, 2, 2],
    [8, 0, 0],
  ]);
  const scopes = [scope(0, '<module>', -1, 0, 0, 4), scope(1, 'f', 0, 1, 1, 1, 1), scope(2, 'g', 1, 2, 2, 3, 3)];
  const trace = new TraceModel(steps, scopes, false, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const entriesByRid = new Map<number, LogEvent[]>([
    [2, [log(2, 1, '1', 'x')]],
    [6, [log(6, 3, '1', 'return')]],
    [8, [log(8, 4, '1', 'print')]],
  ]);
  const coverage = new Map([[1, { states: [0, 1, 1, 1, 1, 0, 1, 1, 1], hits: [0, 1, 1, 1, 1, 0, 1, 1, 1] }]]);
  const errors: ErrorEvent[] = [{ type: 'error', runId: 'r', seq: 0, fileId: 1, rid: 8, step: 4, message: 'Kaboom', errorType: 'ValueError', stack: [], handled: false }];
  return { trace, files, entriesByRid, coverage, errors, readSource: (fileId) => (fileId === 1 ? SOURCE : undefined), stale: false };
}

describe('contextSliceForStep', () => {
  it('describes a step inside a function: location, stack, block with header, values, moves', () => {
    const s = contextSliceForStep(nested(), 1)!;
    expect(s.step).toBe(1);
    expect(s.count).toBe(5);
    expect(s.location).toEqual({ file: '/w/main.py', line: 2, col: 4, function: 'f', fileId: 1 });
    expect(s.stale).toBe(false);
    expect(s.stack).toEqual([
      { file: '/w/main.py', line: 2, function: 'f', step: 1 },
      { file: '/w/main.py', line: 7, function: '<module>', step: 0 },
    ]);
    expect(s.block.file).toBe('/w/main.py');
    expect(s.block.function).toBe('f');
    expect(s.block.scopeId).toBe(1);
    expect(s.block.lines).toEqual([
      { line: 1, text: 'def f():' },
      { line: 2, text: '    x = g()', step: 1, current: true },
    ]);
    expect(s.block.capped).toBeUndefined();
    expect(s.values).toEqual([{ line: 2, context: 'x', text: '1', step: 1, hit: 1, runtimeKey: 'k2', logId: 'l-2-1' }]);
    expect(s.moves).toEqual({ into: 2, over: 4, out: 4, back: 0, backOver: 0, backOut: 0 });
    expect(s.errors).toEqual([{ file: '/w/main.py', line: 8, type: 'ValueError', message: 'Kaboom', step: 4 }]);
  });

  it('reports the lines of the block that never ran', () => {
    const s = contextSliceForStep(nested(), 2)!;
    expect(s.block.function).toBe('g');
    expect(s.block.lines.map((l) => l.line)).toEqual([3, 4, 6]);
    expect(s.block.lines.find((l) => l.current)?.line).toBe(4);
    expect(s.coverage).toEqual({ notRun: [5] });
    // values of the block's steps only (the module's print is outside)
    expect(s.values.map((v) => v.text)).toEqual(['1']);
    expect(s.values[0]!.step).toBe(3);
  });

  it('has no coverage when the file has none, null moves at the ends and a module block without header', () => {
    const inputs = nested();
    inputs.coverage = new Map();
    const s = contextSliceForStep(inputs, 4)!;
    expect(s.coverage).toBeUndefined();
    expect(s.moves).toEqual({ into: null, over: null, out: null, back: 3, backOver: 0, backOut: null });
    expect(s.block.function).toBe('<module>');
    expect(s.block.lines).toEqual([{ line: 8, text: 'print(x)', step: 4, current: true }]);
    expect(s.stack).toEqual([{ file: '/w/main.py', line: 8, function: '<module>', step: 4 }]);
  });

  it('includes valueBag only on request and marks stale', () => {
    const inputs = nested();
    inputs.stale = true;
    inputs.entriesByRid.get(2)![0]!.valueBag = { data: { type: 'number', value: '1', id: 'v', queryPath: [] }, runtimeKey: 'k2' };
    expect(contextSliceForStep(inputs, 1)!.values[0]!.valueBag).toBeUndefined();
    const s = contextSliceForStep(inputs, 1, { valueBag: true })!;
    expect(s.values[0]!.valueBag?.data.value).toBe('1');
    expect(s.stale).toBe(true);
  });

  it('returns undefined for an invalid step', () => {
    expect(contextSliceForStep(nested(), 99)).toBeUndefined();
    expect(contextSliceForStep(nested(), -1)).toBeUndefined();
  });
});

/** One flat module of `n` lines, each executed once at step line-1, each logging one value. */
function flat(n: number): SliceInputs {
  const files = new FileTable();
  const ranges: Range4[] = [];
  for (let l = 0; l <= n; l++) ranges.push([l, 0, l, 5]);
  files.add({ fileId: 1, path: '/w/flat.py', rangeBase: 0, ranges, statements: ranges.map((_, i) => i).slice(1), functions: [], magic: [] });
  const quads: [number, number, number][] = [];
  for (let l = 1; l <= n; l++) quads.push([l, 0, 0]);
  const trace = new TraceModel(packSteps(quads), [scope(0, '<module>', -1, 0, 0, n - 1)], false, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  const entriesByRid = new Map<number, LogEvent[]>();
  for (let l = 1; l <= n; l++) entriesByRid.set(l, [log(l, l - 1, `v${l}`)]);
  const src = Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  return { trace, files, entriesByRid, coverage: new Map(), errors: [], readSource: () => src };
}

describe('caps', () => {
  it('keeps 60 lines and 20 values around the current step; scope lifts both', () => {
    const inputs = flat(200);
    const s = contextSliceForStep(inputs, 99)!;
    expect(s.block.lines.length).toBe(BLOCK_LINE_CAP);
    expect(s.block.capped).toBe(true);
    expect(s.block.lines.find((l) => l.current)?.line).toBe(100);
    expect(s.block.lines[0]!.line).toBe(70);
    expect(s.values.length).toBe(VALUE_CAP);
    expect(s.valuesCapped).toBe(true);
    expect(s.values.some((v) => v.step === 99)).toBe(true);
    const full = contextSliceForStep(inputs, 99, { scope: true })!;
    expect(full.block.lines.length).toBe(200);
    expect(full.block.capped).toBeUndefined();
    expect(full.values.length).toBe(200);
    expect(full.valuesCapped).toBeUndefined();
  });

  it('clamps the window at the start and the end', () => {
    const inputs = flat(100);
    expect(contextSliceForStep(inputs, 0)!.block.lines.map((l) => l.line)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(contextSliceForStep(inputs, 99)!.block.lines.at(-1)!.line).toBe(100);
    expect(contextSliceForStep(inputs, 99)!.block.lines[0]!.line).toBe(41);
  });
});

describe('by line', () => {
  it('finds the first step on a line or a range of lines', () => {
    const inputs = nested();
    expect(firstStepOnLines(inputs.trace, 1, 4)).toBe(2);
    expect(firstStepOnLines(inputs.trace, 1, 5, 6)).toBe(3);
    expect(firstStepOnLines(inputs.trace, 1, 9)).toBe(-1);
    expect(firstStepOnLines(inputs.trace, 2, 4)).toBe(-1);
    expect(contextSliceForLine(inputs, 1, 6)!.step).toBe(3);
    expect(contextSliceForLine(inputs, 1, 9)).toBeUndefined();
  });

  it('lists every value of a line by step and hit', () => {
    const inputs = nested();
    inputs.entriesByRid.set(2, [log(2, 1, '2', 'x', 2), log(2, 1, '1', 'x', 1)]);
    expect(valuesForLine(inputs, 1, 2).map((v) => [v.hit, v.text])).toEqual([[1, '1'], [2, '2']]);
    expect(valuesForLine(inputs, 1, 3)).toEqual([]);
    expect(valuesAtStep(inputs, 3).map((v) => v.text)).toEqual(['1']);
    expect(valuesAtStep(inputs, 0)).toEqual([]);
  });
});
