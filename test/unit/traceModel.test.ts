import { describe, expect, it } from 'vitest';
import { TraceModel, packSteps, storyBlocks } from '../../src/timeMachine/traceModel';
import type { TraceScope } from '../../src/shared/protocol';

/** rid == source line for readability; every step is a one-line statement in file 1. */
const resolve = (rid: number) => ({ fileId: 1, range: [rid, 0, rid, 10] as [number, number, number, number] });

const scope = (scopeId: number, name: string, parent: number, depth: number, first: number, last: number, rid = 0): TraceScope => ({ scopeId, rid, name, parent, depth, first, last });

/**
 * Nested calls:
 *  1  def f():          (rid 1)
 *  2      g()
 *  3  def g():          (rid 3)
 *  4      x = 1
 *  5  f()
 *  6  print()
 * steps: 5(f call) -> 2 (in f) -> 4 (in g) -> 6
 */
function nested(): TraceModel {
  const steps = packSteps([
    [5, 0, 0],
    [2, 1, 1, 4],
    [4, 2, 2, 4],
    [6, 0, 0],
  ]);
  const scopes = [scope(0, '<module>', -1, 0, 0, 3), scope(1, 'f', 0, 1, 1, 1, 1), scope(2, 'g', 1, 2, 2, 2, 3)];
  return new TraceModel(steps, scopes, false, resolve);
}

/**
 * Recursion: fact(3) -> fact(2) -> fact(1)
 *  1 def fact(n):
 *  2     if n <= 1: return 1        (rid 2)
 *  3     return n * fact(n-1)       (rid 3)
 *  4 fact(3)
 *  5 done
 */
function recursion(): TraceModel {
  const steps = packSteps([
    [4, 0, 0],
    [2, 1, 1, 4],
    [3, 1, 1],
    [2, 2, 2, 4],
    [3, 2, 2],
    [2, 3, 3, 4],
    [5, 0, 0],
  ]);
  const scopes = [scope(0, '<module>', -1, 0, 0, 6), scope(1, 'fact', 0, 1, 1, 2, 1), scope(2, 'fact', 1, 2, 3, 4, 1), scope(3, 'fact', 2, 3, 5, 5, 1)];
  return new TraceModel(steps, scopes, false, resolve);
}

/** loop: for i in range(3): body(line 2) */
function loop(): TraceModel {
  const steps = packSteps([
    [1, 0, 0],
    [2, 0, 0, 1],
    [2, 0, 0, 1],
    [2, 0, 0, 1],
    [3, 0, 0],
  ]);
  return new TraceModel(steps, [scope(0, '<module>', -1, 0, 0, 4)], false, resolve);
}

/**
 * Sibling calls at the same depth, no module step between them:
 *  1 def f():       (rid 1)
 *  2     x = 1
 *  3 def g():       (rid 3)
 *  4     y = 2
 *  5 h = (f(), g())
 *  6 done
 */
function siblings(): TraceModel {
  const steps = packSteps([
    [5, 0, 0],
    [1, 1, 1, 4],
    [2, 1, 1],
    [3, 2, 1, 4],
    [4, 2, 1],
    [6, 0, 0],
  ]);
  const scopes = [scope(0, '<module>', -1, 0, 0, 5), scope(1, 'f', 0, 1, 1, 2, 1), scope(2, 'g', 0, 1, 3, 4, 3)];
  return new TraceModel(steps, scopes, false, resolve);
}

/**
 * Coroutines: a direct await runs inside the awaiting frame, a gathered task is resumed by the
 * event loop and gets the module as parent (depth 1). Steps of the two gathered tasks interleave.
 *  1 async def fetch(n):    (rid 1)
 *  2     r = n
 *  3     return r
 *  4 async def turn(i):     (rid 4)
 *  5     a = await fetch(i)
 *  6     return a
 *  7 async def main():      (rid 7)
 *  8     one = await turn(1)
 *  9     both = await asyncio.gather(turn(2), turn(3))
 * 10     print(one, both)
 * 11 asyncio.run(main())
 * scopes: 1 main (parent 0), 2 turn(1) (parent main), 3 fetch (parent 2),
 *         4 turn(2) (parent 0), 5 fetch (parent 4), 6 turn(3) (parent 0), 7 fetch (parent 6)
 */
function gather(): TraceModel {
  const steps = packSteps([
    [11, 0, 0], // 0  asyncio.run(main())
    [7, 1, 1, 4], // 1  main entry
    [8, 1, 1], // 2  one = await turn(1)
    [4, 2, 2, 4], // 3  turn entry
    [5, 2, 2], // 4  a = await fetch(1)
    [1, 3, 3, 4], // 5  fetch entry
    [2, 3, 3], // 6
    [3, 3, 3], // 7
    [6, 2, 2], // 8  return a
    [9, 1, 1], // 9  both = await gather(...)
    [4, 4, 1, 4], // 10 turn(2) entry
    [5, 4, 1], // 11
    [1, 5, 2, 4], // 12 fetch(2) entry
    [2, 5, 2], // 13
    [4, 6, 1, 4], // 14 turn(3) entry
    [5, 6, 1], // 15
    [1, 7, 2, 4], // 16 fetch(3) entry
    [2, 7, 2], // 17
    [3, 5, 2], // 18 fetch(2) return
    [6, 4, 1], // 19 turn(2) return
    [3, 7, 2], // 20 fetch(3) return
    [6, 6, 1], // 21 turn(3) return
    [10, 1, 1], // 22 print(one, both)
  ]);
  const scopes = [
    scope(0, '<module>', -1, 0, 0, 0),
    scope(1, 'main', 0, 1, 1, 22, 7),
    scope(2, 'turn', 1, 2, 3, 8, 4),
    scope(3, 'fetch', 2, 3, 5, 7, 1),
    scope(4, 'turn', 0, 1, 10, 19, 4),
    scope(5, 'fetch', 4, 2, 12, 18, 1),
    scope(6, 'turn', 0, 1, 14, 21, 4),
    scope(7, 'fetch', 6, 2, 16, 20, 1),
  ];
  return new TraceModel(steps, scopes, false, resolve);
}

describe('TraceModel navigation', () => {
  it('over and out follow the scope chain, so a sibling call at the same depth is skipped', () => {
    const t = siblings();
    expect(t.stepOver(2)).toBe(5); // x = 1 in f: next step in f or the module, not g's entry
    expect(t.stepOut(2)).toBe(5);
    expect(t.stepBackOver(3)).toBe(0); // g's entry: back over lands on the call line, not inside f
    expect(t.stepBackOut(4)).toBe(0);
    expect(t.stepOver(0)).toBe(5);
  });

  it('gathered tasks: over on the gather line skips both tasks, moves inside a task stay in it', () => {
    const t = gather();
    expect(t.stepOver(9)).toBe(22); // both = await gather(...) -> print(one, both)
    expect(t.stepOut(9)).toBe(-1); // nothing runs at module level after asyncio.run
    expect(t.stepOver(11)).toBe(19); // a = await fetch(2) -> return a of the same turn
    expect(t.stepOut(13)).toBe(19); // out of fetch(2) -> turn(2)'s next step
    expect(t.stepBackOver(20)).toBe(17); // fetch(3) return -> its previous step, not turn(2)'s
    expect(t.stepBackOut(17)).toBe(15); // back out of fetch(3) -> turn(3)'s await line
    expect(t.stepBackOut(21)).toBe(0); // back out of turn(3) -> the module call
    expect(t.stepOver(2)).toBe(9); // one = await turn(1): the direct await is stepped over
    expect(t.stepOut(6)).toBe(8); // out of fetch(1) -> turn(1)'s return
    expect(t.canStep(9)).toEqual({ into: true, back: true, over: true, backOver: true, out: false, backOut: true });
    expect(t.callStack(17).map((f) => [f.function, f.step, f.line])).toEqual([
      ['fetch', 17, 2],
      ['turn', 15, 5],
      ['<module>', 0, 11],
    ]);
    expect(t.callStack(6).map((f) => f.function)).toEqual(['fetch', 'turn', 'main', '<module>']);
  });

  it('step into / back into are plain +1 / -1 with dead ends', () => {
    const t = nested();
    expect(t.stepInto(0)).toBe(1);
    expect(t.stepInto(3)).toBe(-1);
    expect(t.stepBackInto(0)).toBe(-1);
    expect(t.stepBackInto(2)).toBe(1);
  });

  it('step over skips deeper frames', () => {
    const t = nested();
    expect(t.stepOver(0)).toBe(3); // over the call to f()
    expect(t.stepOver(1)).toBe(3); // inside f, over g(): no more steps in f, lands on module line 6
    expect(t.stepOver(3)).toBe(-1);
    expect(t.stepBackOver(3)).toBe(0);
    expect(t.stepBackOver(2)).toBe(1);
  });

  it('step out lands after the call, step back out before it', () => {
    const t = nested();
    expect(t.stepOut(2)).toBe(3); // out of g: the next step in f or the module is the module's
    expect(t.stepOut(1)).toBe(3);
    expect(t.stepOut(0)).toBe(-1);
    expect(t.stepBackOut(2)).toBe(1);
    expect(t.stepBackOut(1)).toBe(0);
    expect(t.stepBackOut(0)).toBe(-1);
  });

  it('recursion: over/out respect the scope chain, call stack walks parents to call sites', () => {
    const t = recursion();
    expect(t.stepOver(2)).toBe(6); // return n * fact(n-1) in the outer fact -> the module step
    expect(t.stepOut(5)).toBe(6);
    expect(t.stepBackOut(5)).toBe(4);
    const stack = t.callStack(5);
    expect(stack.map((f) => [f.function, f.step, f.line])).toEqual([
      ['fact', 5, 2],
      ['fact', 4, 3],
      ['fact', 2, 3],
      ['<module>', 0, 4],
    ]);
  });

  it('run to line / back to line by start line, breakpoints by key set', () => {
    const t = recursion();
    expect(t.runToLine(0, 1, 3)).toBe(2);
    expect(t.runToLine(2, 1, 3)).toBe(4);
    expect(t.runBackToLine(6, 1, 2)).toBe(5);
    expect(t.runToLine(6, 1, 2)).toBe(-1);
    expect(t.runToBreakpoint(0, new Set(['1:3']))).toBe(2);
    expect(t.runBackToBreakpoint(6, new Set(['1:3']))).toBe(4);
    expect(t.runToBreakpoint(0, new Set())).toBe(-1);
  });

  it('start step: first step on the line, else the next executed line, else 0', () => {
    const t = recursion();
    expect(t.startStep(1, 3)).toBe(2);
    expect(t.startStep(1, 1)).toBe(1); // nothing on line 1; nearest following executed line is 2
    expect(t.startStep(1, 99)).toBe(0);
  });

  it('loops: echo steps share the rid and are capped', () => {
    const t = loop();
    expect(t.echoSteps(2)).toEqual([1, 3]);
    expect(t.echoSteps(1, 1)).toEqual([2]);
    expect(t.isLogStep(1)).toBe(true);
    expect(t.isLogStep(0)).toBe(false);
    expect(t.canStep(4)).toEqual({ into: false, back: true, over: false, backOver: true, out: false, backOut: false });
  });

  it('timeline model and function colours per scope name', () => {
    const t = recursion();
    const m = t.toTimelineModel();
    expect(m.stepCount).toBe(7);
    expect(m.lines).toEqual([4, 2, 3, 2, 3, 2, 5]);
    expect(m.functionColors).toEqual({ 0: 0, 1: 1, 2: 1, 3: 1 });
    expect(t.stepInfo(3)).toMatchObject({ index: 3, rid: 2, line: 2, scopeId: 2, depth: 2, flags: 4 });
  });
});

describe('story blocks', () => {
  /**
   * A for loop re-runs its header line every turn:
   *  1 for p in ps:
   *  2     print(p)
   *  3 done
   * steps: 1,2,1,2,1,3  (three turns of the header, two of the body)
   */
  function forLoop(): TraceModel {
    const steps = packSteps([
      [1, 0, 0],
      [2, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [1, 0, 0],
      [3, 0, 0],
    ]);
    return new TraceModel(steps, [scope(0, '<module>', -1, 0, 0, 5)], false, resolve);
  }

  it('a loop body is one block per turn, not one for the whole loop', () => {
    expect(storyBlocks(forLoop())).toEqual([
      { scopeId: 0, firstStep: 0, lastStep: 1, fileId: 1 },
      { scopeId: 0, firstStep: 2, lastStep: 3, fileId: 1 },
      { scopeId: 0, firstStep: 4, lastStep: 5, fileId: 1 },
    ]);
  });

  it('a call still splices the callee in under its call site, and the caller resumes in a new block', () => {
    expect(storyBlocks(nested())).toEqual([
      { scopeId: 0, firstStep: 0, lastStep: 0, fileId: 1 },
      { scopeId: 1, firstStep: 1, lastStep: 1, fileId: 1 },
      { scopeId: 2, firstStep: 2, lastStep: 2, fileId: 1 },
      { scopeId: 0, firstStep: 3, lastStep: 3, fileId: 1 },
    ]);
  });

  it('recursion: a block per frame, unchanged by the line rule', () => {
    expect(storyBlocks(recursion()).map((b) => [b.scopeId, b.firstStep, b.lastStep])).toEqual([
      [0, 0, 0],
      [1, 1, 2],
      [2, 3, 4],
      [3, 5, 5],
      [0, 6, 6],
    ]);
  });

  it('steps sharing a line do not split: only a line returned to after leaving it does', () => {
    // a comprehension on line 5 ticking four times, then line 6, then back to 5
    const steps = packSteps([
      [5, 0, 0],
      [5, 0, 0],
      [5, 0, 0],
      [6, 0, 0],
      [5, 0, 0],
    ]);
    const t = new TraceModel(steps, [scope(0, '<module>', -1, 0, 0, 4)], false, resolve);
    expect(storyBlocks(t)).toEqual([
      { scopeId: 0, firstStep: 0, lastStep: 3, fileId: 1 },
      { scopeId: 0, firstStep: 4, lastStep: 4, fileId: 1 },
    ]);
  });

  it('a step in another file neither ends the block nor counts as a line coming back', () => {
    // rid 9 resolves into file 2; the block is file 1's and keeps running across it
    const other = (rid: number) => (rid === 9 ? { fileId: 2, range: [1, 0, 1, 5] as [number, number, number, number] } : resolve(rid));
    const steps = packSteps([
      [1, 0, 0],
      [9, 0, 0],
      [2, 0, 0],
    ]);
    const t = new TraceModel(steps, [scope(0, '<module>', -1, 0, 0, 2)], false, other);
    expect(storyBlocks(t)).toEqual([{ scopeId: 0, firstStep: 0, lastStep: 2, fileId: 1 }]);
  });

  it('an empty trace has no blocks', () => {
    expect(storyBlocks(TraceModel.empty())).toEqual([]);
  });
});
