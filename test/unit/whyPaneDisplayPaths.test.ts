/** The why tree the panel gets has display paths everywhere a node names a file, a parameter's argument included. */
import { describe, expect, it } from 'vitest';
import { withDisplayPaths } from '../../src/session/provenance';
import type { Provenance } from '../../src/shared/protocol';

describe('withDisplayPaths', () => {
  it('rewrites the argument of a parameter node', () => {
    const tree: Provenance = {
      name: 'order', step: 34, depth: 5, nodes: 2, truncated: false, recordedLocals: true,
      root: { name: 'order', step: 34, file: '/w/billing.py', fileId: 2, line: 5, argument: { text: 'bo', step: 33, file: '/w/main.py', fileId: 1, line: 12 }, reads: [{ name: 'bo', step: 15, file: '/w/main.py', fileId: 1, line: 9 }] },
    };
    const out = withDisplayPaths(tree, (id) => (id === 1 ? 'main.py' : 'billing.py'));
    expect([out.root.file, out.root.argument?.file, out.root.reads?.[0]?.file]).toEqual(['billing.py', 'main.py', 'main.py']);
  });

  it('rewrites the file of a shared holding', () => {
    const tree: Provenance = {
      name: 'bill', step: 40, depth: 5, nodes: 1, truncated: false, recordedLocals: true,
      root: { name: 'bill', step: 40, file: '/w/main.py', fileId: 1, line: 20, shared: { path: 'ledger.totals', since: 11, file: '/w/orders/billing.py', fileId: 2, line: 3, function: 'charge' } },
    };
    const out = withDisplayPaths(tree, (id) => (id === 1 ? 'main.py' : 'billing.py'));
    expect(out.root.shared?.file).toBe('billing.py');
  });
});
