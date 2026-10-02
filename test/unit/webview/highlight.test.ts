import { describe, expect, it } from 'vitest';
import { tokenize } from '../../../webview/highlight';

describe('tokenize', () => {
  it('colours strings, numbers, keywords, names and types', () => {
    const t = tokenize("{'msg': 'hi', 'n': 3, 'ok': True, 'p': Point(x=5, y=-1.5)}");
    const byCls = (cls: string) => t.filter((x) => x.cls === cls).map((x) => x.text);
    expect(byCls('str')).toEqual(["'msg'", "'hi'", "'n'", "'ok'", "'p'"]);
    expect(byCls('num')).toEqual(['3', '5', '-1.5']);
    expect(byCls('kw')).toEqual(['True']);
    expect(byCls('type')).toEqual(['Point']);
    expect(byCls('name')).toEqual(['x', 'y']);
  });
  it('handles escaped quotes, bytes and ellipsis', () => {
    const t = tokenize("['it\\'s', b'\\x00', …]");
    expect(t.filter((x) => x.cls === 'str').map((x) => x.text)).toEqual(["'it\\'s'", "b'\\x00'"]);
    expect(t.some((x) => x.cls === 'ellipsis')).toBe(true);
  });
  it('marks a masked secret literal so it can be blurred', () => {
    const t = tokenize("OpenAI(api_key='••••••••', organization=None)");
    expect(t.filter((x) => x.cls === 'secret').map((x) => x.text)).toEqual(["'••••••••'"]);
    expect(tokenize("b'••••••••'")[0]?.cls).toBe('secret');
    expect(tokenize("'plain'")[0]?.cls).toBe('str');
  });
  it('round-trips the text', () => {
    const s = "Car(vin='1DEMC12A1985', owner=None, engine={'volume': 10})";
    expect(tokenize(s).map((x) => x.text).join('')).toBe(s);
  });
});
