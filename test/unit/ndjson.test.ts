import { describe, expect, it } from 'vitest';
import { NdjsonDecoder, encodeNdjson } from '../../src/runtime/ndjson';

describe('NdjsonDecoder', () => {
  it('reassembles messages split across arbitrary chunk boundaries', () => {
    const messages = [{ type: 'ready', id: 1 }, { type: 'log', text: 'héllo → 世界', seq: 2 }, { type: 'ok', id: 3 }];
    const wire = Buffer.from(messages.map(encodeNdjson).join(''));
    for (const size of [1, 2, 3, 5, 7, 11, 64]) {
      const dec = new NdjsonDecoder();
      const out: unknown[] = [];
      for (let i = 0; i < wire.length; i += size) out.push(...dec.push(wire.subarray(i, i + size)));
      out.push(...dec.end());
      expect(out, `chunk size ${size}`).toEqual(messages);
    }
  });

  it('accepts CRLF, skips blank lines and reports bad lines', () => {
    const bad: string[] = [];
    const dec = new NdjsonDecoder((line) => bad.push(line));
    expect(dec.push('{"a":1}\r\n\r\nnot json\n{"b":2}')).toEqual([{ a: 1 }]);
    expect(dec.end()).toEqual([{ b: 2 }]);
    expect(bad).toEqual(['not json']);
  });
});
