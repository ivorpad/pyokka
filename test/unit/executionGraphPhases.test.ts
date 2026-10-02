/**
 * Phases of the story tree (`src/session/executionGraphPhases.ts`): where a scope's statements split
 * (a blank or comment line between two members on the scope's base indentation), what stays together
 * (a loop body, an if arm, however the source spaces them), the labels (the comment above, else the
 * names assigned, else the first member's source), the fallbacks without source, and the ids.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionGraph, GraphNode } from '../../src/session/executionGraphTypes';
import { buildPhases, commentAbove, PHASE_LABEL_MAX } from '../../src/session/executionGraphPhases';

const SOURCE = [
  /* 1 */ 'import os',
  /* 2 */ '',
  /* 3 */ '# load the data',
  /* 4 */ '# from disk',
  /* 5 */ 'data = read()',
  /* 6 */ 'total = 0',
  /* 7 */ '',
  /* 8 */ 'for x in data:',
  /* 9 */ '    total += x',
  /* 10 */ '',
  /* 11 */ '    # a comment inside the body',
  /* 12 */ '    print(x)',
  /* 13 */ '# report',
  /* 14 */ 'print(total)',
  /* 15 */ 'if total > 1:',
  /* 16 */ '    big = True',
  /* 17 */ 'done = True  # trailing comments are code lines',
];

function statement(id: string, parent: string, line: number, label: string, targets: string[], firstStep: number): GraphNode {
  return { id, kind: 'statement', parent, label, file: 'main.py', line, fileId: 1, text: label, targets, reads: [], firstStep, hits: 1, rows: [] };
}
function decision(id: string, parent: string, line: number, label: string, firstStep: number): GraphNode {
  return { id, kind: 'decision', parent, label, file: 'main.py', line, fileId: 1, text: `${label} took True`, taken: 'True', firstStep, hits: 1, notRun: [], rows: [] };
}

const graph: Pick<ExecutionGraph, 'nodes'> = {
  nodes: [
    { id: 'n0', kind: 'module', label: '<module>', file: 'main.py', line: 1, fileId: 1, function: '<module>', calls: 1, firstStep: 0, spans: [[0, 20]], rows: [] },
    statement('n1', 'n0', 5, 'data = read()', ['data'], 1),
    statement('n2', 'n0', 6, 'total = 0', ['total'], 2),
    decision('n3', 'n0', 8, 'for x in data', 3),
    statement('n4', 'n0', 9, 'total += x', ['total'], 4),
    statement('n5', 'n0', 12, 'print(x)', [], 5),
    statement('n6', 'n0', 14, 'print(total)', [], 8),
    decision('n7', 'n0', 15, 'if total > 1', 9),
    statement('n8', 'n0', 16, 'big = True', ['big'], 10),
    statement('n9', 'n0', 17, 'done = True', ['done'], 11),
    // a statement whose parent is not in the graph: ignored
    statement('n10', 'n99', 1, 'orphan = 1', ['orphan'], 12),
  ],
};
const readSource = (fileId: number) => (fileId === 1 ? SOURCE : undefined);

describe('buildPhases', () => {
  const phases = buildPhases(graph, readSource);

  it('splits the module at blank and comment lines between top-level members, and keeps a loop body together', () => {
    expect(phases.map((p) => p.members)).toEqual([['n1', 'n2'], ['n3', 'n4', 'n5'], ['n6', 'n7', 'n8', 'n9']]);
    expect(phases.map((p) => p.id)).toEqual(['n0:p0', 'n0:p1', 'n0:p2']);
    expect(phases.every((p) => p.parent === 'n0')).toBe(true);
    expect(phases.map((p) => p.line)).toEqual([5, 8, 14]);
    expect(phases.map((p) => p.firstStep)).toEqual([1, 3, 8]);
  });
  it('labels a phase by the comment block above it, else by the names it assigns', () => {
    expect(phases[0]).toMatchObject({ label: 'load the data from disk', comment: true });
    expect(phases[1]).toMatchObject({ label: 'total', comment: false });
    expect(phases[2]).toMatchObject({ label: 'report', comment: true });
  });
  it('orders the members of a phase by firstStep, whatever their lines', () => {
    const g: Pick<ExecutionGraph, 'nodes'> = { nodes: [graph.nodes[0]!, statement('a', 'n0', 6, 'total = 0', ['total'], 7), statement('b', 'n0', 5, 'data = read()', ['data'], 9)] };
    expect(buildPhases(g, readSource)[0]!.members).toEqual(['a', 'b']);
    expect(buildPhases(g, readSource)[0]!.firstStep).toBe(7);
  });
  it('falls back to one phase per scope without source, labelled by the first three names assigned', () => {
    const one = buildPhases(graph, () => undefined);
    expect(one).toHaveLength(1);
    expect(one[0]!.members).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
    expect(one[0]!.label).toBe('data, total, big, …');
    expect(one[0]!.comment).toBe(false);
  });
  it('labels a phase of decisions and prints by its first member when nothing is assigned, cut at the label cap', () => {
    const long = 'x'.repeat(PHASE_LABEL_MAX + 10);
    const g: Pick<ExecutionGraph, 'nodes'> = { nodes: [graph.nodes[0]!, statement('a', 'n0', 14, `print(${long})`, [], 1), decision('b', 'n0', 15, 'if total > 1', 2)] };
    const [p] = buildPhases(g, () => ['', '', '', '', '', '', '', '', '', '', '', '', '', 'print(...)', 'if total > 1:']);
    expect(p!.label).toHaveLength(PHASE_LABEL_MAX);
    expect(p!.label.endsWith('…')).toBe(true);
    expect(p!.label.startsWith('print(')).toBe(true);
  });
  it('phases every scope with members separately and ignores members of scopes not in the graph', () => {
    const g: Pick<ExecutionGraph, 'nodes'> = {
      nodes: [
        ...graph.nodes,
        { id: 'f', kind: 'function', label: 'helper', file: 'main.py', line: 1, fileId: 1, function: 'helper', calls: 1, firstStep: 6, spans: [[6, 7]], rows: [] },
        statement('f1', 'f', 5, 'data = read()', ['data'], 6),
      ],
    };
    const all = buildPhases(g, readSource);
    expect(all.filter((p) => p.parent === 'f').map((p) => p.id)).toEqual(['f:p0']);
    expect(all.some((p) => p.members.includes('n10'))).toBe(false);
  });
  it('reads the comment block directly above a line', () => {
    expect(commentAbove(SOURCE, 5)).toBe('load the data from disk');
    expect(commentAbove(SOURCE, 14)).toBe('report');
    expect(commentAbove(SOURCE, 6)).toBe('');
    expect(commentAbove(SOURCE, 1)).toBe('');
    expect(commentAbove(['#no space', '## two', 'x = 1'], 3)).toBe('no space two');
  });
});
