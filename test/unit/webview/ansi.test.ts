/**
 * The SGR subset of ANSI in the Debugger view's output pane: a program that uses rich or colorama
 * printed its escape codes as text before this (docs/design/debugger-product.md, 5.6).
 */
import { describe, expect, it } from 'vitest';
import { applySgr, decodeAnsi, PLAIN, sameStyle } from '../../../webview/ansi';

const texts = (spans: { text: string }[]): string => spans.map((s) => s.text).join('');

describe('decodeAnsi', () => {
  it('leaves text with no escapes alone', () => {
    const { spans, end } = decodeAnsi('plain output');
    expect(spans).toEqual([{ text: 'plain output', style: PLAIN }]);
    expect(end).toBe(PLAIN);
  });

  it('splits on a colour and never prints the escape itself', () => {
    const { spans } = decodeAnsi('ok \x1b[31mbad\x1b[0m done');
    expect(texts(spans)).toBe('ok bad done');
    expect(spans[1]!.style.fg).toBe('var(--vscode-terminal-ansiRed)');
    expect(spans[2]!.style).toEqual({});
  });

  it('takes its colours from the theme, bright ones included', () => {
    expect(applySgr(PLAIN, [32]).fg).toBe('var(--vscode-terminal-ansiGreen)');
    expect(applySgr(PLAIN, [91]).fg).toBe('var(--vscode-terminal-ansiBrightRed)');
    expect(applySgr(PLAIN, [44]).bg).toBe('var(--vscode-terminal-ansiBlue)');
    expect(applySgr(PLAIN, [104]).bg).toBe('var(--vscode-terminal-ansiBrightBlue)');
  });

  it('reads the 256-colour cube and truecolor', () => {
    expect(applySgr(PLAIN, [38, 5, 9]).fg).toBe('var(--vscode-terminal-ansiBrightRed)');
    expect(applySgr(PLAIN, [38, 5, 196]).fg).toBe('#ff0000');
    expect(applySgr(PLAIN, [38, 5, 232]).fg).toBe('#080808');
    expect(applySgr(PLAIN, [38, 2, 12, 34, 56]).fg).toBe('#0c2238');
  });

  it('turns attributes on and off one at a time, and 0 resets everything', () => {
    let s = applySgr(PLAIN, [1, 3, 4, 31]);
    expect(s).toMatchObject({ bold: true, italic: true, underline: true });
    s = applySgr(s, [22]);
    expect(s.bold).toBeUndefined();
    expect(s.italic).toBe(true);
    s = applySgr(s, [39]);
    expect(s.fg).toBeUndefined();
    expect(applySgr(s, [0])).toEqual({});
  });

  it('carries the style into the next call, because a colour can outlive a chunk', () => {
    const first = decodeAnsi('\x1b[33mwarn');
    expect(first.end.fg).toBe('var(--vscode-terminal-ansiYellow)');
    const second = decodeAnsi('ing\x1b[0m', first.end);
    expect(second.spans[0]!.style.fg).toBe('var(--vscode-terminal-ansiYellow)');
    expect(second.end).toEqual({});
  });

  it('swallows the sequences it does not act on rather than printing them', () => {
    // a progress bar's erase-line and cursor moves, and an OSC title
    expect(texts(decodeAnsi('\x1b[2K\x1b[1Ghalf\x1b[?25lway').spans)).toBe('halfway');
    expect(texts(decodeAnsi('\x1b]0;a title\x07body').spans)).toBe('body');
  });

  it('treats an empty parameter list as a reset, the way a terminal does', () => {
    expect(decodeAnsi('\x1b[31ma\x1b[mb').spans[1]!.style).toEqual({});
  });

  it('knows when two styles paint the same', () => {
    expect(sameStyle({ fg: 'red' }, { fg: 'red' })).toBe(true);
    expect(sameStyle({ fg: 'red' }, { fg: 'red', bold: true })).toBe(false);
    expect(sameStyle({ bold: undefined }, {})).toBe(true);
  });
});
