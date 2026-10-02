import { describe, expect, it } from 'vitest';
import { findSnaps, fenceAt } from '../../src/features/snapFences';

describe('findSnaps', () => {
  it('finds fences anywhere, including inside functions', () => {
    const src = ['x = 1', '"""{{', 'x + 1', '}}"""', '#» 2', 'def f():', '    """{{', '    f()', '    }}"""', ''].join('\n');
    const fences = findSnaps(src);
    expect(fences).toEqual([
      { openLine: 1, closeLine: 3 },
      { openLine: 6, closeLine: 8 },
    ]);
    expect(fenceAt(fences, 7)).toEqual({ openLine: 6, closeLine: 8 });
    expect(fenceAt(fences, 4)).toBeUndefined();
  });

  it('ignores an unterminated fence', () => {
    expect(findSnaps('"""{{\nx\n')).toEqual([]);
  });
});
