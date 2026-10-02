/** The watch expression input's completion: what it asks for, how a choice lands, what the dropdown shows. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { WatchInput } from '../../../webview/components/WatchInput';
import { applyCompletion, completionHead, iconForKind } from '../../../webview/watchComplete';

describe('completionHead', () => {
  it('asks for an identifier or a dot before the caret and for nothing else', () => {
    expect(completionHead('tot', 3)).toBe('tot');
    expect(completionHead('payload.', 8)).toBe('payload.');
    expect(completionHead('payload.it', 10)).toBe('payload.it');
    expect(completionHead('1 + rows[0].sc', 14)).toBe('1 + rows[0].sc');
    expect(completionHead('payload.items', 7)).toBe('payload'); // the caret in the middle: the text before it
    expect(completionHead('', 0)).toBeNull();
    expect(completionHead('a + ', 4)).toBeNull();
    expect(completionHead('x[', 2)).toBeNull();
    expect(completionHead('tot', 9)).toBe('tot'); // a caret past the end clamps
  });
});

describe('applyCompletion', () => {
  it('replaces the prefix before the caret and leaves the tail alone', () => {
    expect(applyCompletion('tot', 3, 'tot', 'total')).toEqual({ text: 'total', caret: 5 });
    expect(applyCompletion('payload.', 8, '', 'items')).toEqual({ text: 'payload.items', caret: 13 });
    expect(applyCompletion('1 + pa * 2', 6, 'pa', 'payload')).toEqual({ text: '1 + payload * 2', caret: 11 });
    expect(applyCompletion('x', 5, 'x', 'xs')).toEqual({ text: 'xs', caret: 2 });
  });
});

describe('iconForKind', () => {
  it('uses the symbol codicons the suggest widget uses', () => {
    expect(iconForKind('variable')).toBe('symbol-variable');
    expect(iconForKind('attribute')).toBe('symbol-field');
    expect(iconForKind('method')).toBe('symbol-method');
    expect(iconForKind('property')).toBe('symbol-property');
    expect(iconForKind('class')).toBe('symbol-class');
    expect(iconForKind('module')).toBe('symbol-namespace');
    expect(iconForKind('keyword')).toBe('symbol-keyword');
  });
});

describe('WatchInput', () => {
  const noop = () => undefined;
  it('renders a combobox with the initial expression and no list until the host answers', () => {
    const html = render(<WatchInput initial="payload" placeholder="expression" onSubmit={noop} onCancel={noop} completions={null} onComplete={noop} />);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="payload"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('pk-watch-suggest');
  });
  it('stays a plain input without a completion source', () => {
    const html = render(<WatchInput placeholder="expression" onSubmit={noop} onCancel={noop} />);
    expect(html).toContain('placeholder="expression"');
    expect(html).not.toContain('pk-watch-suggest');
  });
});
