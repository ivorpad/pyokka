/** The debugger in the Time Machine view: the paused header and the frontier on the strips; the stack, the variables and the step buttons are VS Code's. */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact-render-to-string';

vi.mock('../../../webview/monaco', () => ({ monaco: { editor: { colorize: () => Promise.resolve('') } } }));
import { DebuggerView } from '../../../webview/components/Debugger';
import { DebugToolbar } from '../../../webview/components/Chrome';
import { debugHeader, pausedPhrase } from '../../../webview/debugView';
import type { DebuggerState, DebugPanelInfo, TimelineModel } from '../../../src/shared/webviewProtocol';
import type { ValueNode } from '../../../src/shared/protocol';

const noop = () => undefined;
const icons = (html: string): string[] => [...html.matchAll(/codicon-([a-z-]+)/g)].map((m) => m[1]!).filter((n) => !n.startsWith('modifier'));
const tips = (html: string): string[] => [...html.matchAll(/data-tip="([^"]+)"/g)].map((m) => m[1]!);

const model: TimelineModel = {
  stepCount: 5,
  scopeIds: [0, 0, 1, 1, 0],
  flags: [0, 0, 4, 0, 0],
  lines: [3, 4, 1, 2, 5],
  cols: [0, 0, 0, 4, 0],
  fileIds: [1, 1, 1, 1, 1],
  scopes: [
    { scopeId: 0, rid: 0, name: '<module>', parent: -1, depth: 0, first: 0, last: 4 },
    { scopeId: 1, rid: 7, name: 'f', parent: 0, depth: 1, first: 2, last: 3 },
  ],
  functionColors: { 0: 0, 1: 1 },
  truncated: false,
};

const base: DebuggerState = { active: true, autoPlaying: false, currentStep: 4, canStep: { into: true, back: true, over: true, backOver: true, out: false, backOut: false }, echoSteps: [], showCallStack: false, codePreview: false, echo: false, watches: [] };

const num = (id: string, v: string): ValueNode => ({ type: 'number', value: v, id, queryPath: [] });
const row = (i: number, path: string, score: string, patron: string | null): ValueNode & { name: string } => ({
  name: String(i),
  type: 'dict',
  id: `r${i}`,
  queryPath: [String(i)],
  length: 3,
  props: [
    { name: 'path', type: 'str', value: `'${path}'`, id: `r${i}p`, queryPath: [String(i), 'path'] },
    { name: 'score', type: 'number', value: score, id: `r${i}s`, queryPath: [String(i), 'score'] },
    { name: 'patron', type: patron === null ? 'None' : 'str', value: patron === null ? 'None' : `'${patron}'`, id: `r${i}t`, queryPath: [String(i), 'patron'] },
  ],
});
const paused: DebugPanelInfo = {
  active: true,
  paused: true,
  frontier: 4,
  reason: 'watch',
  location: 'demo.py:48',
  watch: { id: 'w1', exp: 'normalized is None', text: 'True', breakWhen: 'true' },
  stack: [{ name: '<module>', scopeId: 0, depth: 0 }],
  locals: [
    { name: 'self', text: 'Point(x=5, y=1)', valueBag: { runtimeKey: 'a', data: { type: 'Point', value: 'Point(x=5, y=1)', id: 'a', queryPath: [] } } },
    { name: 'x', text: '5', valueBag: { runtimeKey: 'b', data: num('b', '5') } },
    { name: 'other', text: 'Point(x=5, y=1)', valueBag: { runtimeKey: 'c', data: { type: 'Point', value: 'Point(x=5, y=1)', id: 'c', queryPath: [] } } },
    { name: 'normalized', text: 'None', valueBag: { runtimeKey: 'd', data: { type: 'None', value: 'None', id: 'd', queryPath: [] } } },
    { name: 'items', text: '[{…}, {…}, {…}, {…}]', valueBag: { runtimeKey: 'e', data: { type: 'list', id: 'e', queryPath: [], length: 4, props: [row(0, 'a.yaml', '1.0', 'LIBRE'), row(1, 'b.yaml', '0.6', 'LIBRE'), row(2, 'c.yaml', '0.583333', null), row(3, 'd.yaml', '1.0', null)] } } },
  ],
};

const view = (state: DebuggerState) =>
  render(<DebuggerView model={model} state={state} entries={[]} watchNodes={new Map()} theme="dark" codePreview={null} onGoto={noop} onPreviewRequest={noop} onAction={noop} onWatch={noop} onWatchAdd={noop} onWatchEdit={noop} onWatchExpand={noop} onOpen={noop} onCopy={noop} onCommand={noop} showFileName={false} />);

describe('pausedPhrase and debugHeader', () => {
  it('names every reason the way the mockup does', () => {
    expect(pausedPhrase({ active: true, paused: true, reason: 'start' })).toBe('start of the run');
    expect(pausedPhrase({ active: true, paused: true, reason: 'breakpoint', breakpoint: { line: 13 } })).toBe('breakpoint');
    expect(pausedPhrase({ active: true, paused: true, reason: 'breakpoint', breakpoint: { line: 13, condition: 'i == 3' }, conditionError: 'NameError: nope' })).toBe('breakpoint if i == 3 · condition failed: NameError: nope');
    expect(pausedPhrase({ active: true, paused: true, reason: 'step', kind: 'over' })).toBe('step over');
    expect(pausedPhrase(paused)).toBe('watch w1 normalized is None turned true');
    expect(pausedPhrase({ ...paused, watch: { id: 'w2', exp: 'total', text: '3', breakWhen: 'change' } })).toBe('watch w2 total changed to 3');
    expect(pausedPhrase({ active: true, paused: true, reason: 'pause' })).toBe('paused on request');
    expect(pausedPhrase({ active: true, paused: true, reason: 'exception', exception: { type: 'ValueError', message: 'too big: 3', uncaught: true } })).toBe('uncaught ValueError: too big: 3');
    expect(pausedPhrase({ active: true, paused: true, reason: 'exception', exception: { type: 'ValueError', message: 'too big: 3', uncaught: false } })).toBe('raised ValueError: too big: 3');
  });
  it('builds the header for a pause, says running while the debug run runs, and nothing otherwise', () => {
    expect(debugHeader(paused)).toBe('Paused at demo.py:48 · watch w1 normalized is None turned true · step 4 · behind the frontier the recording replays, ahead nothing has run');
    expect(debugHeader({ active: true, paused: false })).toBe('Debug: running…');
    expect(debugHeader(undefined)).toBe('');
    expect(debugHeader({ active: false, paused: false })).toBe('');
  });
});

describe('DebuggerView while a debug run is paused', () => {
  const state: DebuggerState = { ...base, debug: paused };
  it('leads with where and why the run is paused', () => {
    const html = view(state);
    expect(html).toContain('pk-debug-status">Paused at <b>demo.py:48</b> · watch w1 normalized is None turned true · step 4 · behind the frontier the recording replays, ahead nothing has run<');
  });
  it('marks the frontier on the timeline and hatches what has not run yet on both strips', () => {
    const html = view(state);
    expect(html).toMatch(/pk-tl-frontier" style="left:calc\(100% - 2px\);"[^>]*title="Frontier: the run is paused before step 4"/);
    expect(html).toContain('pk-tl-frontier-label">frontier<');
    expect(html.match(/not run yet/g)?.length).toBe(2);
    expect(view(base)).not.toContain('pk-tl-frontier');
    expect(view(base)).not.toContain('not run yet');
  });
  it('leaves the call stack and the variables at the step to the Run and Debug side bar', () => {
    const html = view({ ...state, showCallStack: true, callStack: { frames: [{ fileId: 1, line: 5, col: 0, function: '<module>', step: 4, scopeId: 0 }], selected: 0 }, locals: [{ name: 'n', text: '21' }] });
    expect(html).not.toContain('STEP VARIABLES');
    expect(html).not.toContain('CALL STACK');
    expect(html).not.toContain('pk-local-name');
    expect(html).not.toContain('Show call stack');
    expect(html).toContain('TIMELINE GUIDE');
  });
});

describe('DebugToolbar while debugging', () => {
  const session = { name: 'a.py', running: false, runMode: 'onSave' as const };
  it('has no step, continue, pause or stop buttons: the VS Code debug toolbar drives the same Time Machine', () => {
    for (const debug of [paused, { active: true, paused: false }, undefined]) {
      const html = render(<DebugToolbar state={{ ...base, debug }} session={session} onAction={noop} onStop={noop} />);
      expect(icons(html)).toEqual(['play', 'close']);
      expect(tips(html)).toEqual(['Auto play', 'Close the Time Machine']);
    }
  });
});

describe('watch expressions in the panel', () => {
  it('offers to add one even when the list is empty, and to edit each one in place', () => {
    const empty = view({ ...base, watches: [] });
    expect(empty).toContain('Add watch expression');
    expect(empty).not.toContain('Edit expression');
    const one = view({ ...base, watches: [{ id: 'w-1', exp: 'dt.year', valueBag: { runtimeKey: 'w', data: num('w', '2026') } }] });
    expect(one).toContain('Edit expression');
    expect(one).toContain('double-click to edit');
    expect(one).toContain('2026');
  });
  it('shows a recorded variable value with where it was recorded, and an error in place of a value', () => {
    const recorded = view({ ...base, watches: [{ id: 'w-2', exp: 'total', text: '12', note: 'as of step 3, recorded in <module>, line 13', step: 3 }] });
    expect(recorded).toContain('12');
    expect(recorded).toContain('pk-watch-note');
    expect(recorded).toContain('as of step 3, recorded in &lt;module>, line 13');
    const pending = view({ ...base, watches: [{ id: 'w-3', exp: 'total * 2', error: 'not recorded at this step', needsRun: true }] });
    expect(pending).toContain('pk-error-text');
    expect(pending).toContain('not recorded at this step');
    expect(pending).toContain('Evaluate (runs the file once)');
    const paused = view({ ...base, watches: [{ id: 'w-4', exp: 'total * 2', error: 'not recorded at this step; the paused frame evaluates it at the frontier' }] });
    expect(paused).not.toContain('Evaluate (runs the file once)');
  });
});
