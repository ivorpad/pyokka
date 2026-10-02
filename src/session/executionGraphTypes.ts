/**
 * The execution graph: the diagram of a run as a projection of the walkthrough (docs/PROTOCOL.md,
 * "Execution graph"). Built by `executionGraph.ts` (host) and `python/pyokka_runtime/agent/graph.py`
 * (saved runs) with identical output; `test/unit/fixtures/execution-graph.json` pins both.
 */

export const GRAPH_CAP = 200;
export const SPANS_MAX = 50;
export const STEPS_MAX = 50;
export const ROWS_MAX = 12;
export const DATA_EDGES_MAX = 100;
/** statement nodes per module or function */
export const STATEMENTS_MAX = 60;

export type GraphNodeKind = 'module' | 'function' | 'package' | 'decision' | 'statement';
export type GraphRowKind = 'in' | 'out' | 'raised' | 'took' | 'print';
export type GraphEdgeKind = 'call' | 'tool' | 'data';

export interface GraphRow {
  kind: GraphRowKind;
  name: string;
  text: string;
  step: number;
}

/** A module, a user function, a library function (`--all` / expanded: `package` set), a package, or a "N more functions" placeholder. */
export interface CallNode {
  id: string;
  kind: 'module' | 'function' | 'package';
  label: string;
  /** absent on package nodes */
  file?: string | null;
  line?: number;
  fileId?: number;
  function?: string;
  /** library package: set on package nodes and on unrolled library functions */
  package?: string;
  calls: number;
  firstStep: number;
  /** one [entry, end] per call, ≤ SPANS_MAX */
  spans: [number, number][];
  /** the first call's values, ≤ ROWS_MAX */
  rows: GraphRow[];
  /** package nodes: scopes entered inside the spans */
  nested?: number;
  /** placeholder under the cap: this many functions of `file` were dropped */
  more?: number;
}

export interface DecisionNode {
  id: string;
  kind: 'decision';
  /** the node of the function (or module) the statement lives in */
  parent: string;
  /** `if amount > self.balance`, `for i in items`, `match total` */
  label: string;
  file: string | null;
  line: number;
  fileId: number;
  /** the first moment's sentence */
  text: string;
  /** "True" / "False" / "case _"; absent for loops */
  taken?: string;
  firstStep: number;
  /** decision moments on the statement (loops: iterations, summed) */
  hits: number;
  /** first line of the arm that never ran over all hits */
  notRun: number[];
  /** `took` values of the first moment */
  rows: GraphRow[];
}

/** A simple statement a step ran, under the module or user function it lives in (docs/PROTOCOL.md, "statement"). */
export interface StatementNode {
  id: string;
  kind: 'statement';
  parent: string;
  /** the statement's source, collapsed, ≤ 60 chars */
  label: string;
  file: string | null;
  line: number;
  fileId: number;
  /** the statement's source, collapsed, ≤ 200 chars */
  text: string;
  /** names the statement assigns */
  targets: string[];
  /** names the statement uses (see the contract for what counts) */
  reads: string[];
  firstStep: number;
  /** steps on the statement over the whole run */
  hits: number;
  /** `out` (the logged value), `print`, `raised` */
  rows: GraphRow[];
}

export type GraphNode = CallNode | DecisionNode | StatementNode;

export interface CallEdge {
  id: string;
  from: string;
  to: string;
  kind: 'call' | 'tool';
  count: number;
  firstStep: number;
  /** call-site steps (tool: entry steps), ≤ STEPS_MAX */
  steps: number[];
  momentIds: string[];
}

export interface DataEdge {
  id: string;
  from: string;
  to: string;
  kind: 'data';
  /** the parameter name */
  label: string;
  firstStep: number;
}

export type GraphEdge = CallEdge | DataEdge;

export interface GraphMomentRef {
  id: string;
  kind: string;
  step: number;
  nodeId: string;
  edgeId?: string;
}

export interface ExecutionGraph {
  count: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  moments: GraphMomentRef[];
  /** trace scopeId -> node id */
  scopes: Record<string, string>;
  capped: boolean;
  truncated: boolean;
}

export interface ExecutionGraphOptions {
  /** every library function as its own node */
  all?: boolean;
  /** the walkthrough's scope window */
  scope?: string;
  /** packages to unroll into their functions (implies the `all` moments; the others fold back) */
  expand?: string[];
  /** module + function + package nodes kept (default GRAPH_CAP) */
  cap?: number;
  /** statement nodes under the user-code scopes (default true) */
  statements?: boolean;
}

export function isDecisionNode(n: GraphNode): n is DecisionNode {
  return n.kind === 'decision';
}

export function isStatementNode(n: GraphNode): n is StatementNode {
  return n.kind === 'statement';
}

export function isDataEdge(e: GraphEdge): e is DataEdge {
  return e.kind === 'data';
}
