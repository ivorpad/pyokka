import { describe, expect, it } from 'vitest';
import { PartialScopes } from '../../src/session/traceDelta';
import type { TraceScope } from '../../src/shared/protocol';

const scope = (scopeId: number, parent: number, first: number, last = first): TraceScope => ({ scopeId, rid: scopeId, name: scopeId ? 'f' : '<module>', parent, depth: scopeId ? 1 : 0, first, last });

describe('PartialScopes', () => {
  it('appends the scopes of each delta and extends `last` of earlier scopes from the steps', () => {
    const p = new PartialScopes();
    // delta 1: steps 0..2, module scope + scope 1 created at step 1
    const t1 = p.apply([scope(0, -1, 0, 2), scope(1, 0, 1, 2)], new Int32Array([0, 0, 0, 0, 1, 1, 1, 4, 2, 1, 1, 0]), 0);
    expect(t1.map((s) => [s.scopeId, s.last])).toEqual([[0, 2], [1, 2]]);
    // delta 2: steps 3..5, only scope 2 is new; scope 0 gets a step at 3, scope 2 at 4 and 5
    const t2 = p.apply([scope(2, 0, 4)], new Int32Array([3, 0, 0, 0, 4, 2, 1, 4, 5, 2, 1, 0]), 3);
    expect(t2.map((s) => [s.scopeId, s.first, s.last])).toEqual([[0, 0, 3], [1, 1, 2], [2, 4, 5]]);
    // a delta without new scopes still updates `last`
    const t3 = p.apply([], new Int32Array([6, 1, 1, 0]), 6);
    expect(t3.find((s) => s.scopeId === 1)?.last).toBe(6);
    expect(t3).toHaveLength(3);
  });
});
