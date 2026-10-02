import { describe, expect, it } from 'vitest';
import type { DebugPausedEvent } from '../../src/shared/protocol';
import type { DebugState } from '../../src/session/debugState';
import type { DebugFrame } from '../../src/session/debugState';
import { atFrontier, blocksRun, decideMove, exceptionText, fileHasBreakpoints, freshDebugState, mapSourceBreakpoints, mergeBreakpoints, pausedInfo, reduceDebugState } from '../../src/session/debugState';

const paused = (over: Partial<DebugPausedEvent> = {}): DebugPausedEvent => ({ type: 'debug.paused', runId: 'r-1', seq: 9, step: 12, rid: 40, fileId: 1, line: 7, scopeId: 0, depth: 0, reason: 'breakpoint', stack: [{ scopeId: 0, name: '<module>', rid: 0, depth: 0 }], breakpoint: { path: '/w/a.py', line: 7, rid: 40, fileId: 1, resolvedLine: 7 }, ...over });

describe('reduceDebugState', () => {
  it('follows a debug run from start to finish: run id, pause with frontier, resume, finish', () => {
    let st = { ...freshDebugState(), active: true };
    st = reduceDebugState(st, { type: 'run.started', runId: 'r-1' });
    expect(st.runId).toBe('r-1');
    st = reduceDebugState(st, paused());
    expect(st.frontier).toBe(12);
    expect(st.paused).toEqual({ step: 12, rid: 40, fileId: 1, line: 7, scopeId: 0, depth: 0, reason: 'breakpoint', stack: [{ scopeId: 0, name: '<module>', rid: 0, depth: 0 }], breakpoint: { path: '/w/a.py', line: 7, rid: 40, fileId: 1, resolvedLine: 7 } });
    st = reduceDebugState(st, { type: 'debug.resumed' });
    expect(st.paused).toBeUndefined();
    expect(st.frontier).toBeUndefined();
    expect(st.active).toBe(true);
    st = reduceDebugState(st, paused({ step: 30, reason: 'step', kind: 'over', breakpoint: undefined }));
    expect(st.paused?.kind).toBe('over');
    expect(st.paused?.breakpoint).toBeUndefined();
    st = reduceDebugState(st, { type: 'run.finished' });
    expect(st.paused).toBeUndefined();
    expect(st.active).toBe(true);
    st = reduceDebugState(st, { type: 'stop' });
    expect(st.active).toBe(false);
  });
  it('keeps the exception mode across the run and across stop, and names an exception pause', () => {
    expect(freshDebugState().exceptions).toBe('uncaught');
    let st: DebugState = { ...freshDebugState(), active: true, exceptions: 'raised' };
    st = reduceDebugState(st, { type: 'run.started', runId: 'r-1' });
    st = reduceDebugState(st, paused({ reason: 'exception', breakpoint: undefined, exception: { type: 'ValueError', message: 'too big: 3', uncaught: true } }));
    expect(st.paused?.exception).toEqual({ type: 'ValueError', message: 'too big: 3', uncaught: true });
    expect(exceptionText(st.paused!.exception!)).toBe('uncaught ValueError: too big: 3');
    expect(exceptionText({ type: 'ValueError', message: 'too big: 3', uncaught: false })).toBe('raised ValueError: too big: 3');
    st = reduceDebugState(st, { type: 'run.finished' });
    expect(st.exceptions).toBe('raised');
    st = reduceDebugState(st, { type: 'stop' });
    expect(st.exceptions).toBe('raised');
  });
  it('keeps the optional fields of a pause only when present', () => {
    const info = pausedInfo(paused({ reason: 'watch', watch: { id: 'w1', exp: 'total', text: '3' }, breakpoint: undefined, line: null }));
    expect(info.watch).toEqual({ id: 'w1', exp: 'total', text: '3' });
    expect(info.line).toBeNull();
    expect('breakpoint' in info).toBe(false);
    expect('kind' in info).toBe(false);
    expect('exception' in info).toBe(false);
  });
});

describe('modified and the two frame shapes', () => {
  it('sets modified from a pause and resets it on a new run', () => {
    expect(freshDebugState().modified).toBe(false);
    let st = reduceDebugState({ ...freshDebugState(), active: true }, { type: 'run.started', runId: 'r-1' });
    st = reduceDebugState(st, paused({ modified: true }));
    expect(st.modified).toBe(true);
    // absent means "unchanged", so a later pause keeps it
    st = reduceDebugState(st, paused({ step: 20 }));
    expect(st.modified).toBe(true);
    expect(st.paused?.modified).toBeUndefined();
    // a new child is a new namespace
    st = reduceDebugState(st, { type: 'run.started', runId: 'r-2' });
    expect(st.modified).toBe(false);
  });

  it('carries the thread and both frame shapes through pausedInfo', () => {
    const scopeChain: DebugFrame[] = [{ scopeId: 3, name: 'twice', rid: 40, depth: 1 }];
    const frameChain: DebugFrame[] = [{ frameId: 0, name: 'do_GET', fileId: 2, line: 42 }, { frameId: 1, name: 'handle_one_request', fileId: 0, line: 427 }];
    const recording = pausedInfo(paused({ stack: scopeChain }));
    expect(recording.stack).toEqual(scopeChain);
    expect(recording.thread).toBeUndefined();
    const debugger_ = pausedInfo(paused({ stack: frameChain, thread: { name: 'Thread-3', ident: 6108209152 }, modified: true }));
    expect(debugger_.stack).toEqual(frameChain);
    expect(debugger_.thread).toEqual({ name: 'Thread-3', ident: 6108209152 });
    expect(debugger_.modified).toBe(true);
  });
});

describe('breakpoints', () => {
  const bp = (line: number, over: Record<string, unknown> = {}) => ({ enabled: true, location: { uri: { scheme: 'file', fsPath: '/w/a.py' }, range: { start: { line } } }, ...over });
  it('maps enabled file breakpoints to 1-based lines, skipping logpoints, disabled ones and non-file schemes', () => {
    expect(mapSourceBreakpoints([bp(6), bp(9, { condition: ' i > 2 ' }), bp(3, { logMessage: 'x = {x}' }), bp(4, { enabled: false }), bp(5, { location: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' }, range: { start: { line: 5 } } } })])).toEqual([
      { path: '/w/a.py', line: 7 },
      { path: '/w/a.py', line: 10, condition: 'i > 2' },
    ]);
  });
  it('says a file can pause on a plain breakpoint, and not on a logpoint, a disabled one or one in another file', () => {
    // the key behind F5: a logpoint is a marker in Pyokka and never pauses, so it must not take F5
    expect(fileHasBreakpoints([bp(6)], '/w/a.py')).toBe(true);
    expect(fileHasBreakpoints([bp(6, { condition: 'i > 2' })], '/w/a.py')).toBe(true);
    expect(fileHasBreakpoints([bp(6, { logMessage: 'x = {x}' })], '/w/a.py')).toBe(false);
    expect(fileHasBreakpoints([bp(6, { enabled: false })], '/w/a.py')).toBe(false);
    expect(fileHasBreakpoints([bp(6)], '/w/b.py')).toBe(false);
    expect(fileHasBreakpoints([], '/w/a.py')).toBe(false);
    // a logpoint on another line does not hide a real breakpoint
    expect(fileHasBreakpoints([bp(3, { logMessage: 'x = {x}' }), bp(6)], '/w/a.py')).toBe(true);
  });
  it('merges lists without duplicates and keeps distinct conditions apart', () => {
    expect(mergeBreakpoints([{ path: '/w/a.py', line: 7 }], [{ path: '/w/a.py', line: 7 }, { path: '/w/a.py', line: 7, condition: 'i' }], undefined, [{ path: '/w/b.py', line: 1 }])).toEqual([
      { path: '/w/a.py', line: 7 },
      { path: '/w/a.py', line: 7, condition: 'i' },
      { path: '/w/b.py', line: 1 },
    ]);
  });
});

describe('moves at and behind the frontier', () => {
  const st = reduceDebugState({ ...freshDebugState(), active: true, runId: 'r-1' }, paused({ step: 12 }));
  it('executes a forward move at the frontier and replays everything else', () => {
    expect(decideMove(st, { active: true, currentStep: 12 }, 'into')).toBe('execute');
    expect(decideMove(st, { active: true, currentStep: 12 }, 'over')).toBe('execute');
    expect(decideMove(st, { active: true, currentStep: 12 }, 'out')).toBe('execute');
    expect(decideMove(st, { active: true, currentStep: 12 }, 'back')).toBe('replay');
    expect(decideMove(st, { active: true, currentStep: 12 }, 'backOver')).toBe('replay');
    expect(decideMove(st, { active: true, currentStep: 5 }, 'into')).toBe('replay');
    expect(decideMove(st, { active: false, currentStep: 12 }, 'into')).toBe('replay');
    expect(decideMove(reduceDebugState(st, { type: 'debug.resumed' }), { active: true, currentStep: 12 }, 'into')).toBe('replay');
    expect(atFrontier(st, { active: true, currentStep: 12 })).toBe(true);
    expect(atFrontier(st, { active: true, currentStep: 11 })).toBe(false);
  });
});

describe('blocksRun', () => {
  it('refuses implicit runs while a debug run is in flight, and nothing otherwise', () => {
    const active = { ...freshDebugState(), active: true };
    for (const reason of ['edit', 'save', 'autoLog', 'watch', 'marker', 'evaluate', 'hover', 'logpoints', 'time-machine']) expect(blocksRun(active, true, reason), reason).toBe(true);
    for (const reason of ['debug', 'manual', 'start']) expect(blocksRun(active, true, reason), reason).toBe(false);
    expect(blocksRun(active, false, 'edit')).toBe(false);
    expect(blocksRun(freshDebugState(), true, 'edit')).toBe(false);
  });
});
