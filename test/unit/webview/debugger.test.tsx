/** Rendered Time Machine strip pieces: what a step block and the code preview hover say. */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact-render-to-string';

// Monaco needs a window; the popup only uses it to colourise after mount, which a string render never does.
vi.mock('../../../webview/monaco', () => ({ monaco: { editor: { colorize: () => Promise.resolve('') } } }));
import { CapNote, CodePreviewPopup } from '../../../webview/components/Debugger';

describe('CodePreviewPopup', () => {
  const preview = { step: 23, file: 'travel_concierge.py', startLine: 67, lines: ['a', 'b', 'c', 'd'], highlightLine: 70, function: '<lambda>' };
  it('leads with the step number and function, then the location', () => {
    const html = render(<CodePreviewPopup preview={preview} x={0} y={0} theme="dark" />);
    expect(html).toMatch(/pk-cp-step">#23<.*pk-cp-fn">&lt;lambda><.*pk-cp-loc">travel_concierge.py:70</);
    expect(html).not.toContain('called from');
  });
  it('says where the function was called from, by step and line', () => {
    const html = render(<CodePreviewPopup preview={{ ...preview, caller: { step: 22, function: '<module>', file: 'travel_concierge.py', line: 84 } }} x={0} y={0} theme="dark" />);
    expect(html).toMatch(/called from<.*pk-cp-step">#22<.*pk-cp-fn">&lt;module><.*pk-cp-loc">line 84</);
    const other = render(<CodePreviewPopup preview={{ ...preview, caller: { step: 3, function: '<module>', file: 'run.py', line: 20 } }} x={0} y={0} theme="dark" />);
    expect(other).toContain('pk-cp-loc">run.py:20<');
  });
});

describe('CapNote', () => {
  const base = { stepCount: 40, scopeIds: [], flags: [], lines: [], cols: [], fileIds: [], scopes: [], functionColors: {} };
  it('says nothing for a run under the cap', () => {
    expect(render(<CapNote model={{ ...base, truncated: false }} />)).toBe('');
  });
  it('names where the recording stopped, who spent the steps and what to exclude', () => {
    const cap = { cap: 40, stepsRun: 35597429, spentBy: [{ path: 'pageindex/flash.py', steps: 35000000 }, { path: 'run.py', steps: 12 }], exclude: 'pageindex/flash.py' };
    const html = render(<CapNote model={{ ...base, truncated: true, cap }} />);
    expect(html).toContain('Recording stopped at step 39: the program ran 35,597,429 steps and only the first 40 are recorded');
    expect(html).toContain('Most steps: pageindex/flash.py 35,000,000 · run.py 12.');
    expect(html).toContain('Add &quot;pageindex/flash.py&quot; to pyokka.timeMachine.exclude');
  });
  it('still says it stopped when an older runtime sent no details', () => {
    expect(render(<CapNote model={{ ...base, truncated: true }} />)).toContain('Recording stopped at step 39');
  });
});
