import { describe, expect, it } from 'vitest';
import type { TimelineModel } from '../../../src/shared/webviewProtocol';
import { callerLocation, clampWindow, ensureVisible, initialWindow, notchColumnsWithFlags, notchSteps, PALETTE, snapToNotch, stepAtX, stepBlocks, stepColor, stepTitle, timelineGuide, zoomWindow } from '../../../webview/timeline';

function model(): TimelineModel {
  const stepCount = 20;
  const scopeIds = Array.from({ length: stepCount }, (_, i) => (i < 10 ? 0 : 1));
  const flags = Array.from({ length: stepCount }, () => 0);
  flags[3] = 1; // log
  flags[15] = 2; // error
  flags[17] = 8; // no mapping
  return {
    stepCount,
    scopeIds,
    flags,
    lines: Array.from({ length: stepCount }, (_, i) => i + 1),
    cols: Array.from({ length: stepCount }, () => 1),
    fileIds: Array.from({ length: stepCount }, () => 1),
    scopes: [
      { scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 19 },
      { scopeId: 1, rid: 5, name: 'f', parent: 0, depth: 1, first: 10, last: 19 },
    ],
    functionColors: { 0: 3, 1: 0 },
    truncated: false,
  };
}

describe('window math', () => {
  it('clamps to the trace and to the minimum size', () => {
    expect(clampWindow({ start: -5, end: 3 }, 20)).toEqual({ start: 0, end: 8 });
    expect(clampWindow({ start: 18, end: 30 }, 20)).toEqual({ start: 8, end: 20 });
    expect(clampWindow({ start: 5, end: 6 }, 20)).toEqual({ start: 5, end: 9 });
  });
  it('sizes the initial window from the strip width and centres the current step', () => {
    expect(initialWindow(20, 400, 10)).toEqual({ start: 5, end: 15 });
    expect(initialWindow(20, 4000, 10)).toEqual({ start: 0, end: 20 });
  });
  it('keeps the current step visible with minimal movement', () => {
    expect(ensureVisible({ start: 0, end: 5 }, 3, 20)).toEqual({ start: 0, end: 5 });
    expect(ensureVisible({ start: 0, end: 5 }, 9, 20)).toEqual({ start: 5, end: 10 });
    expect(ensureVisible({ start: 10, end: 15 }, 2, 20)).toEqual({ start: 2, end: 7 });
  });
  it('zooms around an anchor', () => {
    const w = zoomWindow({ start: 4, end: 12 }, 2, 0.5, 20);
    expect(w.end - w.start).toBe(16);
    expect(w.start).toBe(0);
    const z = zoomWindow({ start: 0, end: 20 }, 0.5, 0, 20);
    expect(z).toEqual({ start: 0, end: 10 });
  });
});

describe('notches and snapping', () => {
  it('lists log and error steps', () => {
    expect(notchSteps(model())).toEqual([3, 15]);
  });
  it('buckets notches per pixel and flags errors', () => {
    const cols = notchColumnsWithFlags([3, 15], [15], 20, 200);
    expect(cols).toEqual([
      { x: 30, error: false },
      { x: 150, error: true },
    ]);
  });
  it('snaps within the threshold only', () => {
    expect(snapToNotch(4, [3, 15], 1)).toBe(3);
    expect(snapToNotch(9, [3, 15], 1)).toBe(9);
    expect(snapToNotch(14, [3, 15], 2)).toBe(15);
    expect(snapToNotch(7, [], 5)).toBe(7);
  });
  it('maps pixels to steps', () => {
    expect(stepAtX(0, 20, 200)).toBe(0);
    expect(stepAtX(199, 20, 200)).toBe(19);
    expect(stepAtX(500, 20, 200)).toBe(19);
  });
});

describe('colours and blocks', () => {
  it('uses the palette via functionColors, red for errors, grey for no mapping', () => {
    const m = model();
    expect(stepColor(m, 0)).toBe(PALETTE[3]);
    expect(stepColor(m, 12)).toBe(PALETTE[0]);
    expect(stepColor(m, 15)).toBe('#f28b82');
    expect(stepColor(m, 17)).toContain('rgba');
  });
  it('builds blocks with markers', () => {
    const blocks = stepBlocks(model(), { start: 8, end: 12 }, 10, new Set([11]));
    expect(blocks.map((b) => b.step)).toEqual([8, 9, 10, 11]);
    expect(blocks[2]?.current).toBe(true);
    expect(blocks[2]?.scopeSwitch).toBe(true);
    expect(blocks[3]?.echo).toBe(true);
    expect(blocks[0]?.label).toBe('9:2');
  });
  it('names every block after its step number, location and function, as the pyokka CLI prints them', () => {
    const blocks = stepBlocks(model(), { start: 8, end: 12 }, 10, new Set());
    expect(blocks.map((b) => b.scopeName)).toEqual(['<module>', '<module>', 'f', 'f']);
    expect(blocks[0]?.title).toBe('#8  9:2  <module>');
    expect(blocks[2]?.title).toBe('#10  11:2  f');
    expect(stepTitle(3, '4:1', '')).toBe('#3  4:1');
  });
  it('describes a call site relative to the previewed file', () => {
    expect(callerLocation('travel_concierge.py', { file: 'travel_concierge.py', line: 84 })).toBe('line 84');
    expect(callerLocation('travel_concierge.py', { file: 'run.py', line: 20 })).toBe('run.py:20');
  });
  it('builds the guide in execution order without duplicates', () => {
    const rows = timelineGuide(model());
    expect(rows.map((r) => r.name)).toEqual(['<module>', 'f']);
    expect(rows[1]?.color).toBe(PALETTE[0]);
  });
});
