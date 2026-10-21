/** The Why header's "Rerun value" button (components/Details.tsx): there once the tree is, and only where the host can replay. */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact-render-to-string';
import type { Provenance } from '../../../src/shared/protocol';
import type { WhyView } from '../../../src/shared/webviewProtocol';

vi.mock('../../../webview/monaco', () => ({ monaco: { editor: {} }, monacoTheme: () => 'vs-dark', READONLY_OPTIONS: {} }));

import { Details } from '../../../webview/components/Details';
import { DEFAULT_PREFS } from '../../../webview/vscode';

const noop = (): void => undefined;
const tree: Provenance = { name: 'order', step: 53, depth: 5, nodes: 1, truncated: false, recordedLocals: true, root: { name: 'order', text: "{'items': [{...}, {...}], 'tier': 'gold'}", source: 'locals', step: 53, scopeId: 9, line: 40 } };

function details(why: WhyView, replays: boolean): string {
  return render(<Details entries={[]} total={0} theme="dark" prefs={DEFAULT_PREFS} compareEnabled={false} why={why} onPrefs={noop} onOpen={noop} onExpand={noop} onCopy={noop} onCompare={noop} onDiagram={noop} onGoto={noop} onCloseWhy={noop} {...(replays ? { onFull: noop } : {})} />);
}

describe('the Why header', () => {
  it('offers the rerun value of the tree\'s name, named so, once the tree is there', () => {
    expect(details({ step: 53, name: 'order', tree }, true)).toContain('aria-label="Rerun value of order at #53: runs the program again in a separate process up to this step');
    // still computing: nothing to read the value of yet
    expect(details({ step: 53, name: 'order', tree: null }, true)).not.toContain('Rerun value of');
  });

  it('has no button where the host cannot replay (the browser page), nor for a statement without a name', () => {
    expect(details({ step: 53, name: 'order', tree }, false)).not.toContain('Rerun value of');
    expect(details({ step: 53, name: '', tree: { ...tree, name: '' } }, true)).not.toContain('Rerun value of');
    expect(details({ step: 53, name: 'order', tree }, true)).not.toMatch(/[Ww]hole value|[Ff]ull value|[Rr]eplay value/);
  });
});
