import { describe, expect, it } from 'vitest';
import { pauseHistory } from '../../web/codeHistory';

const pause = (snapshot: string, frameName: string, line: number, locals: Record<string, string>) => ({
  line,
  content: '',
  frameName,
  snapshot,
  locals: Object.entries(locals).map(([name, text]) => ({ name, text })),
});

describe('pauseHistory: a name across the live debugger\'s pauses', () => {
  it('lists a row where the frame\'s value changed, numbered by the pause it was seen at', () => {
    const h = pauseHistory('total', [
      { file: 'app.py', pause: pause('r:1:0', 'apply_all', 9, { total: '0', v: '1' }) },
      { file: 'app.py', pause: pause('r:2:0', 'double', 3, { n: '1' }) },
      { file: 'app.py', pause: pause('r:3:0', 'apply_all', 9, { total: '0', v: '2' }) },
      { file: 'app.py', pause: pause('r:4:0', 'apply_all', 9, { total: '2', v: '3' }) },
    ]);
    // pause 2 has no `total` in its frame; pause 3 saw the value pause 1 did
    expect(h?.changes.map((c) => [c.step, c.text, c.function])).toEqual([[1, '0', 'apply_all'], [4, '2', 'apply_all']]);
    expect(h).toMatchObject({ name: 'total', pauses: true, total: 2, truncated: false });
  });

  it('keeps two functions\' bindings of one name apart, and is undefined for a name no pause had', () => {
    const pauses = [
      { file: 'app.py', pause: pause('r:1:0', 'f', 2, { x: '1' }) },
      { file: 'app.py', pause: pause('r:2:0', 'g', 6, { x: '1' }) },
    ];
    expect(pauseHistory('x', pauses)?.changes.map((c) => c.function)).toEqual(['f', 'g']);
    expect(pauseHistory('missing', pauses)).toBeUndefined();
  });
});
