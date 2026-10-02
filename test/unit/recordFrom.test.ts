/**
 * Recording from a pause (`pyokka debug FILE --record-from X`): the launch and URI fields, the
 * run config's `recordFrom`, a trace that starts mid-program in the Time Machine's moves, and the
 * provenance leaf that marks where the recording began.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { debugUri, parseDebugUri, parseLaunch, recordFromSpec } from '../../src/debug/debugSessionState';
import { TraceModel, packSteps } from '../../src/timeMachine/traceModel';
import { FileTable } from '../../src/session/fileTable';
import { provenance } from '../../src/session/provenance';
import { renderProvenance } from '../../src/shared/provenanceText';
import { pausedInfo } from '../../src/session/debugState';
import type { DebugPausedEvent, Range4, TraceScope } from '../../src/shared/protocol';

const root = path.resolve('/ws');
const app = path.join(root, 'app.py');

describe('recordFrom on the launch', () => {
  it('implies record and keeps the --at text', () => {
    const launch = parseLaunch({ program: app, cwd: root, recordFrom: 'rank' });
    expect(launch.record).toBe(true);
    expect(launch.recordFrom).toBe('rank');
    expect(parseLaunch({ program: app, cwd: root }).recordFrom).toBeUndefined();
  });

  it('refuses a module launch and a value that is not FILE:LINE or a name', () => {
    expect(() => parseLaunch({ module: 'app.server', recordFrom: 'rank' })).toThrow(/module/);
    expect(() => parseLaunch({ program: app, recordFrom: 'not a name' })).toThrow(/recordFrom/);
  });

  it('round-trips through the debug URI, and parseDebugUri reads it', () => {
    const launch = parseLaunch({ program: app, cwd: root, recordFrom: 'app.py:42' });
    const uri = debugUri(launch, 'app.py:42');
    expect(uri).toContain('recordFrom=app.py%3A42');
    const back = parseDebugUri(uri);
    expect(back.launch).toEqual(launch);
    expect(back.launch.record).toBe(true);
    expect(parseDebugUri(`program=${encodeURIComponent(app)}&recordFrom=rrf`).launch).toMatchObject({ record: true, recordFrom: 'rrf' });
  });

  it('becomes the run config spec: a name stays a name, a file is resolved against the cwd', () => {
    expect(recordFromSpec({ recordFrom: 'Ranker.rank', cwd: root })).toEqual({ function: 'Ranker.rank' });
    expect(recordFromSpec({ recordFrom: 'pkg/app.py:7', cwd: root })).toEqual({ path: path.join(root, 'pkg', 'app.py'), line: 7 });
    expect(recordFromSpec({ recordFrom: `${app}:3`, cwd: '/elsewhere' })).toEqual({ path: app, line: 3 });
    expect(recordFromSpec({ cwd: root })).toBeUndefined();
  });

  it('carries recordingStarted from the pause event', () => {
    const ev: DebugPausedEvent = { type: 'debug.paused', runId: 'r', seq: 0, step: 0, rid: 3, fileId: 1, line: 3, scopeId: 2, depth: 2, reason: 'breakpoint', stack: [], recordingStarted: true };
    expect(pausedInfo(ev).recordingStarted).toBe(true);
    expect(pausedInfo({ ...ev, recordingStarted: undefined }).recordingStarted).toBeUndefined();
  });
});

/**
 * A recording that began inside `inner`, called from `outer`, called from the module:
 *  1  def inner(x):        (rid 1)
 *  2      y = x + 1
 *  3      return y
 *  4  def outer(n):        (rid 4)
 *  5      got = inner(n)
 *  6      return got
 *  7  result = outer(1)
 *  8  print(result)
 * Steps: 0 (line 2, the pause), 1 (line 3), 2 (line 6, back in outer), 3 (line 8). The ancestors'
 * scopes start at step 0 with no step of their own before it: their call sites were never recorded.
 */
function midRun(): { trace: TraceModel; files: FileTable } {
  const files = new FileTable();
  const ranges: Range4[] = [[1, 0, 8, 13], [1, 0, 3, 12], [2, 4, 2, 13], [3, 4, 3, 12], [4, 0, 6, 14], [5, 4, 5, 18], [6, 4, 6, 14], [7, 0, 7, 17], [8, 0, 8, 13]];
  files.add({ fileId: 1, path: '/w/main.py', rangeBase: 0, ranges, statements: [2, 3, 5, 6, 7, 8], functions: [{ rid: 1, name: 'inner', bodyRange: [1, 0, 3, 12] }, { rid: 4, name: 'outer', bodyRange: [4, 0, 6, 14] }], magic: [] });
  const scope = (scopeId: number, name: string, parent: number, depth: number, first: number, last: number, rid: number): TraceScope => ({ scopeId, rid, name, parent, depth, first, last });
  const steps = packSteps([
    [2, 2, 2],
    [3, 2, 2],
    [6, 1, 1],
    [8, 0, 0],
  ]);
  const trace = new TraceModel(steps, [scope(0, '<module>', -1, 0, 0, 3, 0), scope(1, 'outer', 0, 1, 0, 2, 4), scope(2, 'inner', 1, 2, 0, 1, 1)], false, (rid) => {
    const l = files.locate(rid);
    return l ? { fileId: l.fileId, range: l.range } : undefined;
  });
  return { trace, files };
}

describe('a trace that starts mid-program', () => {
  it('keeps the Time Machine inside its bounds', () => {
    const { trace } = midRun();
    expect(trace.count).toBe(4);
    expect(trace.stepBackOver(0)).toBe(-1);
    expect(trace.stepBackOut(0)).toBe(-1);
    expect(trace.stepOver(0)).toBe(1);
    expect(trace.stepOut(0)).toBe(2);
    expect(trace.stepOut(2)).toBe(3);
    expect(trace.startStep(1, 7)).toBe(3); // `result = outer(1)` ran before the recording: the next recorded line
    const stack = trace.callStack(0);
    expect(stack[0]).toMatchObject({ function: 'inner', step: 0, line: 2 });
    expect(stack.every((f) => trace.valid(f.step))).toBe(true);
  });

  it('marks a why chain that reaches before step 0', () => {
    const { trace, files } = midRun();
    const inputs = { trace, files, entries: [], locals: [], errors: [], mainFile: '/w/main.py', workspaceRoot: '/w', readSource: () => undefined, entriesByRid: new Map(), bindings: new Map(), mainFileId: 1 };
    const marked = provenance({ ...inputs, midRun: true }, { step: 0, name: 'x' });
    expect(marked.root).toEqual({ name: 'x', beforeRecording: true });
    expect(renderProvenance(marked)).toContain('x = ?   made before #0, where the recording started');
    const plain = provenance(inputs, { step: 0, name: 'x' });
    expect(plain.root).toEqual({ name: 'x' });
    expect(renderProvenance(plain)).not.toContain('recording started');
  });
});
