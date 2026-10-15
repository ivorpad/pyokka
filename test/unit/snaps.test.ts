import { describe, expect, it } from 'vitest';
import { findSnaps, fenceAt, insideFence, OUTPUT_PREFIX } from '../../src/features/snapFences';

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

describe('fence lines', () => {
  it('the code is between the fence lines', () => {
    expect(insideFence({ openLine: 1, closeLine: 3 }, 1)).toBe(false);
    expect(insideFence({ openLine: 1, closeLine: 3 }, 2)).toBe(true);
    expect(insideFence({ openLine: 1, closeLine: 3 }, 3)).toBe(false);
  });
  it('writes output under a Python comment marker', () => {
    expect(OUTPUT_PREFIX).toBe('#» ');
  });
});
