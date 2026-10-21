/** Which value a why tree's "Rerun value" copies (shared/fullValueTarget.ts): the one on its first line. */
import { describe, expect, it } from 'vitest';
import type { Provenance, ProvenanceNode } from '../../src/shared/protocol';
import { whyFullTarget } from '../../src/shared/fullValueTarget';

const tree = (root: ProvenanceNode, step = 12, name = 'order'): Pick<Provenance, 'step' | 'name' | 'root'> => ({ step, name, root });

describe('a why tree\'s rerun value', () => {
  it('a step that made the value: the change, read after its statement, picked by the text the recorder kept', () => {
    const root: ProvenanceNode = { name: 'order', text: "{'tier': 'gold', 'items': []}", source: 'locals', step: 12, scopeId: 4, line: 27 };
    expect(whyFullTarget(tree(root))).toEqual({ kind: 'change', step: 12, name: 'order', scopeId: 4, text: "{'tier': 'gold', 'items': []}" });
  });

  it('a step after the value was made: the value the name had when the step ran', () => {
    const root: ProvenanceNode = { name: 'order', text: "{'tier': 'gold', 'items': [{...}, {...}]}", source: 'locals', step: 7, scopeId: 4 };
    expect(whyFullTarget(tree(root))).toEqual({ kind: 'at', step: 12, name: 'order' });
    // a leaf (nothing recorded, or not assigned yet) has no step of its own
    expect(whyFullTarget(tree({ name: 'order' }))).toEqual({ kind: 'at', step: 12, name: 'order' });
  });

  it('a change with no snapshot of its own carries no text to pick one by', () => {
    // the statement kept the same object: the text is the value from before it
    const same: ProvenanceNode = { name: 'order', text: "{'tier': 'gold', 'items': []}", source: 'assign', unchanged: true, step: 12, scopeId: 4 };
    expect(whyFullTarget(tree(same))).toEqual({ kind: 'change', step: 12, name: 'order', scopeId: 4 });
    // a path under the name changed there: the text is the path's, not the name's
    const path: ProvenanceNode = { name: 'order.total', text: '99.8', source: 'value', step: 12, scopeId: 4 };
    expect(whyFullTarget(tree(path))).toEqual({ kind: 'change', step: 12, name: 'order', scopeId: 4 });
  });
});
