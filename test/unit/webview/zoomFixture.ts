/**
 * A small panel graph for the Execution Diagram's semantic-zoom tests (`execView.test.tsx`,
 * `execStory.test.ts`): a module with three statements in two phases, `double` called from two of
 * them, `fail` called from the module's card (a call site without a statement node) with a decision
 * and a raise under it, a package `libq` tool-calling a lambda, data edges inside the module's chain
 * and across clusters.
 */
import type { ExecutionGraphPanel } from '../../../src/shared/webviewProtocol';

export function zoomGraph(over: Partial<ExecutionGraphPanel> = {}): ExecutionGraphPanel {
  return {
    runId: 'r1',
    expanded: [],
    stack: [],
    currentStep: null,
    count: 100,
    nodes: [
      { id: 'n0', kind: 'module', label: '<module>', file: 'main.py', line: 1, fileId: 1, function: '<module>', calls: 1, firstStep: 0, spans: [[0, 99]], rows: [] },
      { id: 'n1', kind: 'function', label: 'double', file: 'main.py', line: 10, fileId: 1, function: 'double', calls: 2, firstStep: 4, spans: [[6, 9], [20, 23]], rows: [{ kind: 'in', name: 'x', text: '3', step: 6 }, { kind: 'out', name: 'total', text: '6', step: 9 }] },
      { id: 'n2', kind: 'function', label: 'fail', file: 'main.py', line: 3, fileId: 1, function: 'fail', calls: 1, firstStep: 12, spans: [[13, 17]], rows: [{ kind: 'in', name: 'n', text: '6', step: 13 }, { kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 17 }] },
      { id: 'n3', kind: 'decision', parent: 'n2', label: 'if n > 100', file: 'main.py', line: 5, fileId: 1, text: 'if n > 100 took False', taken: 'False', firstStep: 14, hits: 1, notRun: [7], rows: [] },
      { id: 'n4', kind: 'package', label: 'libq', package: 'libq', calls: 1, firstStep: 60, spans: [[61, 70]], rows: [], nested: 4 },
      { id: 'n5', kind: 'function', label: '<lambda>', file: 'main.py', line: 30, fileId: 1, function: '<lambda>', calls: 1, firstStep: 63, spans: [[63, 65]], rows: [{ kind: 'out', name: 'return', text: '7', step: 65 }] },
      { id: 'n6', kind: 'statement', parent: 'n0', label: 'total = double(3)', file: 'main.py', line: 20, fileId: 1, text: 'total = double(3)', targets: ['total'], reads: ['double'], firstStep: 4, hits: 1, rows: [{ kind: 'out', name: 'total', text: '6', step: 10 }] },
      { id: 'n7', kind: 'statement', parent: 'n0', label: 'x = double(total)', file: 'main.py', line: 21, fileId: 1, text: 'x = double(total)', targets: ['x'], reads: ['double', 'total'], firstStep: 19, hits: 1, rows: [{ kind: 'out', name: 'x', text: '12', step: 24 }] },
      { id: 'n8', kind: 'statement', parent: 'n0', label: "print('got', x)", file: 'main.py', line: 23, fileId: 1, text: "print('got', x)", targets: [], reads: ['print', 'x'], firstStep: 30, hits: 1, rows: [{ kind: 'print', name: 'stdout', text: 'got 12', step: 30 }] },
      { id: 'n9', kind: 'statement', parent: 'n2', label: 'raise ValueError(f"too small: {n}")', file: 'main.py', line: 6, fileId: 1, text: 'raise ValueError(f"too small: {n}")', targets: [], reads: ['n'], firstStep: 16, hits: 1, rows: [{ kind: 'raised', name: 'ValueError', text: 'too small: 6', step: 17 }] },
    ],
    edges: [
      { id: 'e0', from: 'n6', to: 'n1', kind: 'call', count: 1, firstStep: 4, steps: [4], momentIds: ['m1'] },
      { id: 'e2', from: 'n0', to: 'n2', kind: 'call', count: 1, firstStep: 12, steps: [12], momentIds: ['m2'] },
      { id: 'e5', from: 'n1', to: 'n2', kind: 'data', label: 'n', firstStep: 13 },
      { id: 'e1', from: 'n7', to: 'n1', kind: 'call', count: 1, firstStep: 19, steps: [19], momentIds: ['m3'] },
      { id: 'e3', from: 'n6', to: 'n7', kind: 'data', label: 'total', firstStep: 19 },
      { id: 'e4', from: 'n7', to: 'n8', kind: 'data', label: 'x', firstStep: 30 },
      { id: 'e6', from: 'n0', to: 'n4', kind: 'call', count: 1, firstStep: 60, steps: [60], momentIds: ['m4'] },
      { id: 'e7', from: 'n4', to: 'n5', kind: 'tool', count: 1, firstStep: 63, steps: [63], momentIds: ['m6'] },
    ],
    moments: [
      { id: 'm0', kind: 'start', step: 0, nodeId: 'n0' },
      { id: 'm1', kind: 'call', step: 4, nodeId: 'n1', edgeId: 'e0' },
      { id: 'm2', kind: 'call', step: 12, nodeId: 'n2', edgeId: 'e2' },
      { id: 'm3', kind: 'call', step: 19, nodeId: 'n1', edgeId: 'e1' },
      { id: 'm5', kind: 'print', step: 30, nodeId: 'n8' },
      { id: 'm4', kind: 'call', step: 60, nodeId: 'n4', edgeId: 'e6' },
      { id: 'm6', kind: 'tool', step: 63, nodeId: 'n5', edgeId: 'e7' },
    ],
    scopes: { '0': 'n0', '1': 'n1', '2': 'n2', '3': 'n4', '4': 'n5' },
    capped: false,
    truncated: false,
    phases: [
      { id: 'n0:p0', parent: 'n0', label: 'load', comment: true, members: ['n6', 'n7'], line: 20, firstStep: 4 },
      { id: 'n0:p1', parent: 'n0', label: 'report', comment: true, members: ['n8'], line: 23, firstStep: 30 },
    ],
    ...over,
  };
}
