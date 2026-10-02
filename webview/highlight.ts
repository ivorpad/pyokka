/**
 * Tiny tokenizer for one-line Python reprs (entry rows, diagram cells, watch rows).
 * Returns spans with a CSS class suffix; rendering happens in the components.
 */
export type TokenClass = 'str' | 'num' | 'kw' | 'name' | 'type' | 'punct' | 'plain' | 'ellipsis' | 'secret';

/** what the runtime puts in place of a masked secret (python/pyokka_runtime/secrets.py) */
export const SECRET_MASK = '••••••••';

export interface Token {
  cls: TokenClass;
  text: string;
}

const KEYWORDS = new Set(['True', 'False', 'None', 'nan', 'inf']);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /-?(?:0[xob][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:e[+-]?\d+)?j?|\.\d+)/y;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let plain = '';
  const flush = () => {
    if (plain) {
      out.push({ cls: 'plain', text: plain });
      plain = '';
    }
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"') {
      flush();
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j++;
        j++;
      }
      out.push({ cls: strClass(text.slice(i, j + 1)), text: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === '…') {
      flush();
      out.push({ cls: 'ellipsis', text: ch });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(text);
      if (m) {
        const word = m[0];
        const next = text.slice(i + word.length).match(/^\s*([:=({])/);
        // a `b'…'` prefix belongs to the string token
        if ((word === 'b' || word === 'r' || word === 'f' || word === 'u' || word === 'br' || word === 'rb') && (text[i + word.length] === "'" || text[i + word.length] === '"')) {
          flush();
          const q = text[i + word.length] as string;
          let j = i + word.length + 1;
          while (j < text.length && text[j] !== q) {
            if (text[j] === '\\') j++;
            j++;
          }
          out.push({ cls: strClass(text.slice(i, j + 1)), text: text.slice(i, j + 1) });
          i = j + 1;
          continue;
        }
        flush();
        if (KEYWORDS.has(word)) out.push({ cls: 'kw', text: word });
        else if (next && (next[1] === ':' || next[1] === '=') && !text.slice(i + word.length).startsWith('==')) out.push({ cls: 'name', text: word });
        else if (next && (next[1] === '(' || next[1] === '{')) out.push({ cls: 'type', text: word });
        else out.push({ cls: 'plain', text: word });
        i += word.length;
        continue;
      }
    }
    if (/[-0-9.]/.test(ch) && (ch !== '-' || /[0-9.]/.test(text[i + 1] ?? '')) && (ch !== '.' || /[0-9]/.test(text[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m && m[0].length > 0 && m[0] !== '-' && m[0] !== '.') {
        flush();
        out.push({ cls: 'num', text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if ('{}[](),:='.includes(ch)) {
      flush();
      out.push({ cls: 'punct', text: ch });
      i++;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** a string literal that holds the mask is a masked secret */
function strClass(literal: string): TokenClass {
  return literal.includes(SECRET_MASK) ? 'secret' : 'str';
}
