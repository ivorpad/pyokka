/** "Rerun value" in the panel: the copy under its row, the buttons, and the state that holds the answers. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { ValueNode } from '../../../src/shared/protocol';
import type { FullValueView } from '../../../src/shared/replayProtocol';
import type { VariableView } from '../../../src/shared/webviewProtocol';
import { FullValue } from '../../../webview/components/FullValue';
import { VariablePane, canAskFull, changeKey } from '../../../webview/components/VariablePane';
import { DEFAULT_SETTINGS, initialState, reduce } from '../../../webview/model';

const noop = () => undefined;

// orders = {'Ben': {'items': [{'sku': 'MON-27', 'unit_price': '1,299.00'}]}}, every member sent
const item: ValueNode = {
  type: 'dict',
  id: '4',
  queryPath: ['r', 'Ben', 'items', '0'],
  value: "{'sku': 'MON-27', 'unit_price': '1,299.00'}",
  expandable: true,
  props: [
    { name: 'sku', type: 'str', id: '5', queryPath: ['r', 'Ben', 'items', '0', 'sku'], value: 'MON-27' },
    { name: 'unit_price', type: 'str', id: '6', queryPath: ['r', 'Ben', 'items', '0', 'unit_price'], value: '1,299.00' },
  ],
};
const orders: ValueNode = {
  type: 'dict',
  id: '1',
  queryPath: ['r'],
  value: "{'Ben': {'items': [{'sku': 'MON-27', 'unit_price': '1,299.00'}]}}",
  expandable: true,
  props: [
    { name: 'Ben', type: 'dict', id: '2', queryPath: ['r', 'Ben'], value: "{'items': [...]}", expandable: true, props: [{ name: 'items', type: 'list', id: '3', queryPath: ['r', 'Ben', 'items'], value: '[...]', expandable: true, props: [{ ...item, name: '0' }] }] },
    // past the replay's depth: no members came with the copy
    { name: 'Zed', type: 'dict', id: '7', queryPath: ['r', 'Zed'], value: '{...}', expandable: true },
  ],
};

const checked: FullValueView = { key: 'change:3:0:orders', status: 'checked', step: 4, name: 'orders', summary: 'The replay took the same 4 steps, and all 2 values the recording kept on the way came out the same.', value: orders, matched: 4, ms: 1234 };

describe('the copy under a row', () => {
  it('says what was checked, opens at the root and marks what the copy did not reach', () => {
    const html = render(<FullValue view={checked} />);
    expect(html).toContain('pk-full-checked');
    expect(html).toContain('Checked');
    expect(html).toContain('all 2 values the recording kept on the way came out the same');
    expect(html).toContain('Replayed in 1.2 s.');
    // the root row is open: its members are rows, the deeper ones wait for a click
    expect(html).toContain('>Ben<');
    expect(html).toContain('>Zed<');
    expect(html).not.toContain('MON-27</span></span></li><li');
    expect(html).toContain('deeper than a replay copies');
  });

  it('a difference shows both texts, and the copy is still there to read', () => {
    const html = render(<FullValue view={{ ...checked, status: 'differs', summary: 'The replay took the same 4 steps, but orders at step #4 came out different.', difference: { step: 4, name: 'orders', recorded: "{'Ben': {...}}", replay: "{'Ann': {...}}" } }} />);
    expect(html).toContain('pk-full-differs');
    expect(html).toContain('the recording kept');
    expect(html).toContain('the replay has');
    expect(html).toContain('>Ben<');
  });

  it('pending, a replay that went another way and an unavailable one carry no tree', () => {
    for (const status of ['pending', 'diverged', 'unavailable'] as const) {
      const html = render(<FullValue view={{ key: 'k', status, step: 4, name: 'orders', summary: `the ${status} sentence` }} />);
      expect(html).toContain(`the ${status} sentence`);
      expect(html).not.toContain('pk-full-tree');
    }
    expect(render(<FullValue view={{ key: 'k', status: 'pending', step: 4, name: 'orders', summary: 'Replaying…' }} />)).toContain('codicon-modifier-spin');
  });
});

describe('the Variable pane button', () => {
  const view: VariableView = {
    name: 'orders',
    history: {
      name: 'orders',
      total: 2,
      truncated: false,
      recordedLocals: true,
      changes: [
        { step: 3, file: 'invoices.py', fileId: 1, line: 23, function: 'parse_orders', scopeId: 0, name: 'orders', text: '{}', source: 'locals' },
        { step: 9, file: 'invoices.py', fileId: 1, line: 28, function: 'parse_orders', scopeId: 0, name: 'orders', source: 'assign' },
      ],
    },
  };
  const pane = (extra: Partial<Parameters<typeof VariablePane>[0]> = {}) =>
    render(<VariablePane view={view} settings={DEFAULT_SETTINGS} showFileName={false} onQuery={noop} onGoto={noop} onOpen={noop} onWhy={noop} onEnableRecordLocals={noop} onClose={noop} {...extra} />);

  it('only a row whose value the recorder kept can be replayed', () => {
    expect(canAskFull(view.history!.changes[0]!)).toBe(true);
    expect(canAskFull(view.history!.changes[1]!)).toBe(false);
    expect(pane({ onFull: noop }).match(/codicon-list-tree/g)).toHaveLength(1);
  });

  it('without a host that replays (the browser page) there is no button', () => {
    expect(pane()).not.toContain('codicon-list-tree');
  });

  it('the answer shows under its own row', () => {
    const html = pane({ onFull: noop, fullValues: { [changeKey(view.history!.changes[0]!)]: checked } });
    expect(html).toContain('pk-full-checked');
    expect(html.indexOf('pk-full-checked')).toBeGreaterThan(html.indexOf('#3'));
    expect(html.indexOf('pk-full-checked')).toBeLessThan(html.indexOf('#9'));
  });
});

describe('the panel state', () => {
  it('keeps answers by key, drops them on a new run, and learns the feature from init', () => {
    let s = initialState();
    s = reduce(s, { type: 'host', message: { type: 'init', theme: 'dark', settings: DEFAULT_SETTINGS, sessionName: 'invoices.py', features: { fullValue: true } } });
    expect(s.features.fullValue).toBe(true);
    s = reduce(s, { type: 'host', message: { type: 'fullValue', view: { key: 'k', status: 'pending', step: 4, name: 'orders', summary: '…' } } });
    s = reduce(s, { type: 'host', message: { type: 'fullValue', view: checked } });
    expect(Object.keys(s.fullValues).sort()).toEqual(['change:3:0:orders', 'k']);
    s = reduce(s, { type: 'host', message: { type: 'fullValue.reset' } });
    expect(s.fullValues).toEqual({});
    s = reduce(s, { type: 'host', message: { type: 'init', theme: 'dark', settings: DEFAULT_SETTINGS, sessionName: null } });
    expect(s.features).toEqual({});
  });
});
