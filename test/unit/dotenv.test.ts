import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../src/config/dotenv';

describe('parseDotenv', () => {
  it('reads plain, quoted and exported values and skips comments', () => {
    const text = [
      '# comment',
      '',
      'PLAIN=hello world  # trailing comment',
      'export EXPORTED=1',
      'DQ="a \\"quoted\\" value\\nwith newline"',
      "SQ='keep # this'",
      'EMPTY=',
      'not a line',
      '9BAD=x',
    ].join('\n');
    expect(parseDotenv(text)).toEqual({
      PLAIN: 'hello world',
      EXPORTED: '1',
      DQ: 'a "quoted" value\nwith newline',
      SQ: 'keep # this',
      EMPTY: '',
    });
  });
});
