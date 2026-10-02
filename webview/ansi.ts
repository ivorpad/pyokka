/**
 * The SGR subset of ANSI, for the Debugger view's output pane: a program that uses rich, colorama
 * or a bare `\x1b[31m` printed its escape codes into the pane as literal text
 * (docs/design/debugger-product.md, 5.6). Colours resolve to VS Code's own `terminal.ansi*` theme
 * colours, so output looks like it does in the integrated terminal and follows the user's theme.
 *
 * Only what a program's stdout actually uses is handled: SGR (`ESC[…m`), and every other CSI
 * sequence is consumed and dropped rather than printed. Cursor addressing is not emulated — a
 * progress bar that repaints with `\r` is handled by the line builder, which is where a carriage
 * return means something.
 */

export interface SgrStyle {
  /** a CSS colour, or a `--vscode-terminal-ansi*` variable name */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** SGR 7: the pane swaps fg and bg when it paints */
  reverse?: boolean;
}

export interface Span {
  text: string;
  style: SgrStyle;
}

export const PLAIN: SgrStyle = {};

const NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];

/** `--vscode-terminal-ansiBrightRed` and friends: the colours the integrated terminal paints with. */
function named(index: number): string {
  const bright = index >= 8;
  return `var(--vscode-terminal-ansi${bright ? 'Bright' : ''}${NAMES[index % 8]})`;
}

/** The xterm 256-colour cube: 0–15 are the theme's own, 16–231 a 6×6×6 cube, 232–255 grey. */
function cube(n: number): string {
  if (n < 16) return named(n);
  if (n < 232) {
    const i = n - 16;
    const step = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return rgb(step(Math.floor(i / 36) % 6), step(Math.floor(i / 6) % 6), step(i % 6));
  }
  const g = 8 + (n - 232) * 10;
  return rgb(g, g, g);
}

function rgb(r: number, g: number, b: number): string {
  const hex = (v: number): string => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Apply one `ESC[…m` parameter list to a style. */
export function applySgr(style: SgrStyle, params: number[]): SgrStyle {
  let out: SgrStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) out = {};
    else if (p === 1) out.bold = true;
    else if (p === 2) out.dim = true;
    else if (p === 3) out.italic = true;
    else if (p === 4) out.underline = true;
    else if (p === 7) out.reverse = true;
    else if (p === 22) { delete out.bold; delete out.dim; }
    else if (p === 23) delete out.italic;
    else if (p === 24) delete out.underline;
    else if (p === 27) delete out.reverse;
    else if (p >= 30 && p <= 37) out.fg = named(p - 30);
    else if (p >= 90 && p <= 97) out.fg = named(p - 90 + 8);
    else if (p >= 40 && p <= 47) out.bg = named(p - 40);
    else if (p >= 100 && p <= 107) out.bg = named(p - 100 + 8);
    else if (p === 39) delete out.fg;
    else if (p === 49) delete out.bg;
    else if (p === 38 || p === 48) {
      // 38;5;n (256) and 38;2;r;g;b (truecolor); anything else is skipped whole
      const key = p === 38 ? 'fg' : 'bg';
      const mode = params[i + 1];
      if (mode === 5 && params.length > i + 2) {
        out[key] = cube(params[i + 2]!);
        i += 2;
      } else if (mode === 2 && params.length > i + 4) {
        out[key] = rgb(params[i + 2]!, params[i + 3]!, params[i + 4]!);
        i += 4;
      } else i = params.length;
    }
  }
  return out;
}

// CSI: ESC [ <params> <final byte>. Also consumes OSC (ESC ] … BEL/ST) and two-character escapes.
const CSI = /\x1b(?:\[([0-9;:?]*)([\x40-\x7e])|\]([^\x07\x1b]*)(?:\x07|\x1b\\)?|[\x20-\x2f]*[\x30-\x7e])/g;

/**
 * Split `text` into styled spans, starting from `start` and reporting the style the next call
 * should continue with. Escape sequences other than SGR are removed, never printed.
 */
export function decodeAnsi(text: string, start: SgrStyle = PLAIN): { spans: Span[]; end: SgrStyle } {
  if (!text.includes('\x1b')) return { spans: text ? [{ text, style: start }] : [], end: start };
  const spans: Span[] = [];
  let style = start;
  let at = 0;
  CSI.lastIndex = 0;
  for (let m = CSI.exec(text); m; m = CSI.exec(text)) {
    if (m.index > at) spans.push({ text: text.slice(at, m.index), style });
    if (m[2] === 'm') {
      const params = (m[1] ?? '').split(';').map((p) => (p === '' ? 0 : Number(p.split(':')[0])));
      style = applySgr(style, params.map((n) => (Number.isFinite(n) ? n : 0)));
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) spans.push({ text: text.slice(at), style });
  return { spans, end: style };
}

/** True when two styles paint the same, so adjacent spans can be merged. */
export function sameStyle(a: SgrStyle, b: SgrStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.reverse === !!b.reverse;
}
