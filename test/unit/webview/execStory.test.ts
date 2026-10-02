/**
 * The story tree (`webview/execStory.ts`): modules as roots, phases when a scope has more than one,
 * members in firstStep order, the scopes a statement calls nested under it once and referenced
 * after, the card's own callees after the members, scopes nobody's statement calls as roots, the
 * default folding and the flattening the view draws from.
 */
import { describe, expect, it } from 'vitest';
import { buildStory, defaultClosed, flattenStory, type StoryRow } from '../../../webview/execStory';
import { zoomGraph } from './zoomFixture';

const ids = (rows: readonly StoryRow[]): string[] => rows.map((r) => r.id);

describe('buildStory', () => {
  const rows = buildStory(zoomGraph());
  const root = rows[0]!;
  const child = (row: StoryRow, id: string): StoryRow => {
    const c = row.children.find((x) => x.id === id);
    expect(c, `${row.id} has child ${id}`).toBeDefined();
    return c!;
  };

  it('roots the tree at the module and hangs its phases, then the callees of its own card, under it', () => {
    expect(ids(rows)).toEqual(['n0']);
    expect(root.kind).toBe('scope');
    expect(root.nodeKind).toBe('module');
    expect(root.label).toBe('<module>');
    expect(root.meta).toBe('');
    expect(ids(root.children)).toEqual(['n0:p0', 'n0:p1', 'n2', 'n4']);
  });
  it('lists a phase with its members and nests a callee under the statement that first calls it, a reference after', () => {
    const p0 = child(root, 'n0:p0');
    expect(p0.kind).toBe('phase');
    expect(p0.label).toBe('load');
    expect(p0.members).toEqual(['n6', 'n7']);
    expect(ids(p0.children)).toEqual(['n6', 'n7']);
    const first = child(p0, 'n6');
    expect(first.kind).toBe('statement');
    expect(first.label).toBe('total = double(3)');
    expect(ids(first.children)).toEqual(['n1']);
    expect(child(first, 'n1').meta).toBe('×2');
    expect(child(first, 'n1').nodeKind).toBe('function');
    const second = child(p0, 'n7');
    expect(second.children).toHaveLength(1);
    expect(second.children[0]!.kind).toBe('ref');
    expect(second.children[0]!.nodeId).toBe('n1');
    expect(second.children[0]!.id).toMatch(/^ref:\d+:n1$/);
    expect(second.children[0]!.step).toBe(4);
    const p1 = child(root, 'n0:p1');
    expect(ids(p1.children)).toEqual(['n8']);
    expect(child(p1, 'n8').meta).toBe('');
  });
  it('gives a decision its detail and a called function its members, and follows a tool edge out of a package', () => {
    const fail = child(root, 'n2');
    expect(fail.kind).toBe('scope');
    expect(fail.step).toBe(12);
    expect(ids(fail.children)).toEqual(['n3', 'n9']);
    expect(child(fail, 'n3').kind).toBe('decision');
    expect(child(fail, 'n3').meta).toBe('took False · not run: 7');
    const libq = child(root, 'n4');
    expect(libq.nodeKind).toBe('package');
    expect(ids(libq.children)).toEqual(['n5']);
  });
  it('lists the members in firstStep order without phases, and a scope nobody calls from a statement as a root', () => {
    const flat = buildStory(zoomGraph({ phases: [] }));
    expect(ids(flat[0]!.children)).toEqual(['n6', 'n7', 'n8', 'n2', 'n4']);
    const g = zoomGraph();
    const orphan = buildStory({ ...g, edges: g.edges.filter((e) => e.id !== 'e6') });
    expect(ids(orphan)).toEqual(['n0', 'n4']);
    expect(ids(orphan[1]!.children)).toEqual(['n5']);
    const placeholder = buildStory(zoomGraph({ nodes: [...g.nodes, { id: 'n10', kind: 'package', label: '2 more functions', file: 'main.py', fileId: 1, calls: 2, firstStep: 80, spans: [], rows: [], more: 2 }] }));
    expect(placeholder.at(-1)!.id).toBe('n10');
    expect(placeholder.at(-1)!.meta).toBe('2 more');
  });
  it('folds the scopes reached through a call by default and flattens what is open', () => {
    const closed = defaultClosed(rows);
    expect([...closed].sort()).toEqual(['n2', 'n4']);
    expect(flattenStory(rows, closed).map((r) => `${r.depth}:${r.row.id}`)).toEqual(['0:n0', '1:n0:p0', '2:n6', '3:n1', '2:n7', `3:${child(root, 'n0:p0').children[1]!.children[0]!.id}`, '1:n0:p1', '2:n8', '1:n2', '1:n4']);
    expect(flattenStory(rows, new Set()).map((r) => r.row.id)).toContain('n9');
    expect(flattenStory(rows, new Set(['n0'])).map((r) => r.row.id)).toEqual(['n0']);
  });
});
