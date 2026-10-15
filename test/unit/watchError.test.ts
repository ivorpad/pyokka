import { describe, expect, it } from 'vitest';
import { describe as describeStop, pausedBody } from '../../src/debug/dapShared';
import type { PausedInfo } from '../../src/session/debugState';

// A break-when watch that fails to evaluate says so
describe('a watch stop with an evaluation error', () => {
  const info = { reason: 'watch', watch: { id: 'z', exp: '1/0', text: '<evaluation failed>', error: 'ZeroDivisionError: division by zero' } } as unknown as PausedInfo;
  it('names the failure in the stop reason and the stopped event', () => {
    expect(describeStop(info)).toBe('watch 1/0 failed: ZeroDivisionError: division by zero');
    expect(pausedBody(info, 'app.py:3').text).toBe('1/0 failed: ZeroDivisionError: division by zero');
  });
  it('keeps the value form for a watch that evaluated', () => {
    const ok = { reason: 'watch', watch: { id: 'w', exp: 'total', text: '3' } } as unknown as PausedInfo;
    expect(describeStop(ok)).toBe('watch total: 3');
  });
});
