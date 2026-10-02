# Handoff: the execution diagram (item 7), built with subagents

Self-contained: a new session executes this file alone, in one run. Read `docs/HANDOFF.md`
first for decisions, commands and quirks (`command cat` / `command grep` /
`command git`; absolute paths in parallel Bash calls; the worktree guard rejects `cd x &&`,
`$VAR` arguments and most heredocs, so put patch and inspection scripts in the scratchpad and
run `python3 /scratchpad/x.py`; never read or print the example project's `.env`; runs of
`agent.py` / `run.py` cost tokens, so use `examples/demo.py`, the fixture run under
`test/unit/fixtures/walkthrough-run.json` or `$TMPDIR/agent-run.json` for
every check). The preview the user approved on 2026-09-11 is the artifact "run.py Execution
Diagram": the canvas, the
step scrubber under it, the inspector on the right and the walkthrough list on the left.
The walkthrough list exists (`docs/HANDOFF-walkthrough-narration.md`, status block at the
top); this item draws the rest of that preview from the same data.

Branch: the walkthrough lives on `worktree-walkthrough-narration` (commits `3fff06f`,
`6ebe2f8`). Merge it into `main` before creating the worktree for this item, or create the
worktree from that branch: everything below imports from `src/session/walkthrough.ts` and
`python/pyokka_runtime/agent/walkthrough.py`.

## Status (2026-09-11): built

Built on branch `worktree-execution-diagram` the way this file says: the contract first
(`docs/PROTOCOL.md` "Execution graph", `src/session/executionGraphTypes.ts`, the panel
messages), then three subagents on disjoint files, then the integration. In: `pyokka graph`
(`python/pyokka_runtime/agent/graph.py`, `graph_dot.py`, the `graph` subcommand with
`--all`, `--scope`, `--expand`, `--json`, `--dot`, `--live`), the host builder
(`src/session/executionGraph.ts`, `executionGraphText.ts`), the bridge request `graph`, the
`GraphProvider` (`src/features/executionGraph.ts`: cache per run, unrolled packages, the
call stack at the current step throttled at 50 ms), the panel view (`webview/components/
ExecutionDiagram.tsx`, `webview/executionDiagram.ts`: canvas, scrubber, walkthrough list,
inspector; `layoutGraph` is generic now and the value diagram keeps its look), the command
`pyokka.showExecutionDiagram` (the rail's More menu and the Time Machine toolbar switch the
view too), `graph` / `graphProvider` on the API, the fixture
`test/unit/fixtures/execution-graph.json` (four graphs: default, `--all`, `--scope fail`,
cap 6; both builders equal it byte for byte), `test/unit/executionGraph.test.ts`,
`test/unit/webview/executionDiagram.test.tsx`, `python/tests/test_graph.py`,
`test/e2e/execution-diagram.test.js`, the skill and the CHANGELOG.

Departures from the text below, all deliberate: `stack` travels as its own message
(`executionGraph.stack`) so navigation does not resend the graph; `expand` takes package
names (node ids change when a package unrolls); the graph also carries `scopes` (trace scope
→ node) so the call stack maps onto it on both sides; decisions do not count toward the
200-node cap; over 12 rows the `in` rows go first so a long parameter list (`OpenAI.__init__`)
never hides the `raised` row; node labels are qualified names (`Point.__init__`), the sketch's
`withdraw` was loose. Seen and left alone: a self data edge (`double ⇢ double x`) appears when
one call's `in` equals a previous call's `out` by text; short literals match by text, which
is noisy on `0`/`None`; a smarter rule (skip texts under three characters) is a one-line
change on both sides if it bothers. Not done: the value-diagram jump from a row (rows carry
no logId), arrowheads keep one colour on the active path (SVG markers), and no screenshot
pass of the view yet.

## Statement nodes (2026-09-11, second pass)

Opened on the user's agent.py (a module with no functions, calling into openai and
pydantic) the graph was one module box and two decisions: useless, as the user said. Second
pass, same method (contract first, three subagents, integration): `statement` nodes, one per
simple statement a step ran under its module or function, with the source, hits, the names
assigned and read (a small scanner in `names.py` / `names.ts` that both sides implement
identically: strings and comments stripped, f-string parts kept, keyword arguments
excluded), out / print / raised rows; call edges leave from statements; statement-level data
edges (`x = …` ⇢ the statements and decisions that read `x`); the running statement first
on the panel's stack. Fixture program `test/unit/fixtures/graph/main.py`, run
`graph-run.json`, graphs `execution-graph-statements.json`. `--no-statements` /
`statements: false` gives the first pass's shape.

## Column layout (2026-09-11, third pass)

Dagre placed a callee's chain beside the caller's remaining statements, so demo.py fanned out
into a wide strip that fit small. Same method (the cluster shape committed first, three
subagents on disjoint files, integration). `webview/execLayout.ts` replaces dagre for this
view (`layoutColumns` positions the boxes, `routeEdges` draws the edges, `toDiagram` runs
both): one cluster per module / function / package (the card, then its statements and
decisions stacked in `firstStep` order; `CLUSTER_PAD` 12, `BOX_GAP` 10), columns by call
depth (modules in column 0; a function or package one column right of the cluster holding the
statement that first calls it; none, such as a dropped package, means column 1), a cluster's
top aligned with that statement or `CLUSTER_GAP` under the previous cluster of its column,
columns `COLUMN_GAP` 96 apart. Every edge is a cubic. A call edge leaves the statement along
its row to the column's edge and curves across the gap into the callee's card: six points,
`M L C L`; the straight lead is what keeps a curve leaving a narrow box out of the wider
boxes above and below it (the first draft curved from the box and cut through them). A data
edge inside a chain is an arc on the chain's left, `DATA_ARC` 18 plus 6 px per hop between
the two boxes, capped at 4 hops so column 0's arcs stay on the canvas. An edge whose ends
share a column arcs on the column's right (a module importing a module); a call back to an
earlier column mirrors the forward shape; cross-cluster data edges are dashed. The component
draws a `pk-ex-cluster` rectangle behind each scope (`active`, `done`, `dim` with its header;
`selected` when the selection is the header or any of its boxes; a click on the empty part
selects the header), the fit on a new run clamps the scale at 0.6 and aligns the top when the
graph is then taller than the view, and the fit button fits the width and aligns the top so a
long script reads from its first statement. `activePath` adds no edge for the running
statement (the chain links are gone). A statement or decision whose parent is not in the
graph is dropped. The value diagram keeps dagre (`webview/diagram.ts`). Tests:
`test/unit/webview/execLayout.test.ts` (a literal graph with the exact geometry, then the two
fixtures: no overlapping clusters, the column numbers, every edge on the canvas) and the
rendering cases in `executionDiagram.test.tsx`. Seen and left alone: the spurious data edges
of the first pass (`Event.__init__ ⇢ shout [word]`) now draw as long dashed arcs, which makes
the "skip texts under three characters" rule more tempting.

## Semantic zoom (2026-09-13, fourth pass)

On a long script the canvas drew every statement of every scope at once, a wall of boxes, and
the graph was built after every run whether or not the view was showing. Fourth pass, one
session, no subagents, behind settings whose defaults fold everything: the view opens at the
scopes level (cards and call edges only) and a chevron on each card opens its statements.
`ExecView` in `webview/executionDiagram.ts`: `toDiagram(graph, view)` drops the members of closed
scopes, re-homes their call and tool edges to the card and merges edges that then share both ends
(`ids` keeps the originals so the active path still lights a merged edge); `layoutColumns` gets
the re-homed edges so a callee still sits beside its caller's card; `execNodeOf` boxes a hidden
node for the inspector. `GraphViewState` in `webview/model.ts`: `base` and `dataEdges` override
`PanelSettings.diagramDetail` / `diagramDataEdges` for the open panel and clear when those
settings change; `toggled` (the chevrons) is per run; `left` is the tab. The left pane has tabs:
STORY (`webview/execStory.ts` `buildStory`, `components/ExecStory.tsx`: modules → phases →
statements, the callees nested under the statement that first calls them and referenced after,
unreached scopes as roots, callee sub-trees folded at first, the now row kept in view) and
WALKTHROUGH. Phases are computed on the host (`src/session/executionGraphPhases.ts`: a split at a
blank or comment line between two members on the scope's base indentation; the label from the
comment above, else the targets, else the first member) and travel as
`ExecutionGraphPanel.phases`, panel-only, so `pyokka graph`, the bridge and the Python builder
are untouched. The inspector asks `executionGraph.hits` for the selected node
(`src/session/executionGraphHits.ts`: the steps on a statement's or decision's line, a function's
scope entries beyond the 50 spans, capped at 400, with the value logged at each) and lists them
with previous / next. The host side moved out of `outputPanel.ts` into `src/views/graphPane.ts`
(`GraphPaneHost`, the whyPane pattern): `afterRun` sends the graph only under
`pyokka.diagram.build: onRun` or when this run's graph was already sent, else null; the view
posts `executionGraph.request` when it mounts without a graph, and the Show Execution Diagram
command still pushes unconditionally. Settings in `scripts/gen-manifest.py`: `diagram.build`
(`onOpen`), `diagram.detail` (`scopes`), `diagram.dataEdges` (false), `diagram.phases` (true);
`story.walkthrough` set to `False` there too, which package.json already had. Components split
along their seams: `ExecShapes.tsx`, `ExecInspector.tsx`, `ExecStory.tsx`; styles in
`webview/exec-story.css`. Tests: `test/unit/executionGraphPhases.test.ts`,
`executionGraphZoom.test.ts`, `webview/execView.test.tsx`, `webview/execStory.test.ts`,
`webview/graphView.test.ts`, a manifest case; the existing diagram tests render with
`diagramDetail: 'statements'` so their expectations hold. Seen and left alone: the hits of a loop
header count its entry step too, one more than the graph's `hits`; a script without blank lines
is one phase, so the tree lists its statements directly; the e2e suite was not extended (the API's
`graph` and the command are unchanged).

## Objective

A reader of generated code sees the run as a picture: where it started, which functions
were called from where and how often, which decisions were taken, what data went into
each call and what came out, where it raised. A step scrubber replays the run on the
picture, the walkthrough list beside it is the same list in words, and every node, edge
and moment moves the Time Machine. Deterministic, no model; the narration glosses from the
walkthrough show in the inspector when they exist.

## Design in one paragraph

The graph is a projection of the walkthrough. `walkthrough(run)` already yields every call
(with `scopeId`, `entryStep`, `endStep`, `callee`, `in`/`out`/`raised` values), every
decision (with the arm taken), every tool callback and every error, in step order. The
graph builder groups call moments by callee (one node per distinct user function, one
collapsed node per library package), draws one edge per (caller node, callee node) with
the count and the steps, hangs decision nodes under the function they live in, and turns
values into rows. Because both sides already agree on the moments, the two graph builders
are thin and the shared fixture pins them. The canvas reuses `webview/diagram.ts` (dagre
layout, `DiagramNode` rows, edge paths, fit) and `components/Diagram.tsx` (pan, zoom) with
a new graph source; the time layer is a scrubber over the trace plus the call stack at the
current step, which the trace model already computes.

## Contract (add to `docs/PROTOCOL.md`, section "Agent access", after "Walkthrough")

`pyokka graph run.json [--json | --dot] [--all] [--scope NAME]`, `--live` through a new
bridge request `graph {all?, scope?}`, and the host's `buildExecutionGraph` all return:

```jsonc
{ "count": 4108,                               // steps
  "nodes": [
    { "id": "n0", "kind": "module",            // module | function | package | decision
      "label": "<module>", "file": "/abs/run.py", "line": 1, "fileId": 1, "function": "<module>",
      "calls": 1, "firstStep": 0, "spans": [[0, 4107]],        // one [entry, end] per call, ≤ 50, more in `calls`
      "rows": [] },
    { "id": "n3", "kind": "function", "label": "withdraw", "file": "/abs/example.py", "line": 12, "fileId": 1, "function": "Account.withdraw",
      "calls": 1, "firstStep": 40, "spans": [[41, 47]],
      "rows": [ { "kind": "in", "name": "amount", "text": "30", "step": 41 },              // in | out | raised | took
                { "kind": "out", "name": "return", "text": "55.5", "step": 47 } ] },       // rows ≤ 12, the first call's values
    { "id": "n7", "kind": "package", "label": "openai", "package": "openai", "calls": 3, "firstStep": 2111, "spans": [[2112, 2142]],
      "rows": [ { "kind": "raised", "name": "OpenAIError", "text": "Missing credentials…", "step": 2142 } ], "nested": 320 },
    { "id": "n4", "kind": "decision", "parent": "n3", "label": "if amount > self.balance", "file": "/abs/example.py", "line": 14, "fileId": 1,
      "text": "if amount > self.balance took False", "taken": "False", "firstStep": 42, "hits": 1, "notRun": [15] } ], // notRun: first line of the arm that never ran
  "edges": [
    { "id": "e0", "from": "n0", "to": "n3", "kind": "call",   // call | tool | data
      "count": 1, "firstStep": 40, "steps": [40], "momentIds": ["m12"] },
    { "id": "e5", "from": "n3", "to": "n9", "kind": "data", "label": "amount", "firstStep": 41 } ], // a value produced at `from` and passed in at `to`
  "moments": [ { "id": "m12", "nodeId": "n3", "edgeId": "e0" }, ... ],   // walkthrough moment -> node / edge (moments without a node map to nothing)
  "capped": false, "truncated": false }
```

Rules:
- Nodes: the module (`<module>` of the main file; imported project modules are `module`
  nodes too), one `function` node per distinct user-code callee (`callee.file` +
  `callee.function`; recursion is one node with a self edge), one `package` node per
  library package (the merged library call moments; `nested` sums their nested calls;
  `--all` gives one `function` node per library function instead, with `package` set),
  one `decision` node per decision moment's statement (loops included: label "for i in
  items", `hits` = the run count, `text` the moment text), with `parent` the node of the
  function it lives in (`location.function` → the function node, `<module>` → the module
  node). `notRun` for `if`/`elif`: the body's first line when it took False, else the first
  line of the `else` arm when there is one and it took True (from the file maps:
  `decisions.py` / `decisions.ts`, add the else span to both if it is not there).
- Edges: one `call` edge per (caller node, callee node) over all call moments, `count` and
  `steps` (the call-site steps, ≤ 50), `momentIds`. `tool` edges from the package node of
  the caller to the user function. `data` edges: for every call moment with an `in` value
  whose `text` equals an `out` or `value` recorded earlier in the caller's span (same
  `name` or same text, the most recent one), an edge from the producing node to the callee
  labelled with the parameter name; at most one per parameter, ≤ 100 in total.
- Bound: 200 nodes. Beyond it, keep the module, every decision's parent, the 150 most
  called functions and the packages; drop the rest with `capped: true` and a final node
  `{"kind": "package", "label": "N more functions", ...}` per file. Edges to dropped nodes
  go too.
- Ids are stable for a run: `n<index>` in first-step order, `e<index>` likewise.

Text form (`pyokka graph run.json`): one line per node in first-step order (`n3 withdraw
example.py:12  ×1  in amount = 30 · out 55.5`), decisions indented under their parent
(`   n4 if amount > self.balance took False`), then the edges (`n0 → n3  ×1  #40`),
≤ 100 chars per line. `--dot`: Graphviz, nodes with the rows as record labels, `data`
edges dashed, decisions as diamonds.

## Time layer (the preview's scrubber, reviewed 2026-09-11)

- Under the canvas: a scrubber over `0..count-1` with play/pause (reuse the auto-play
  cadence of the Time Machine) and the step number; dragging it calls `debugger.goto`;
  the Time Machine's `debugger` message moves it.
- At step `s`, the active path is the call stack (`TraceModel.callStack(s)` in the host;
  the panel gets it from the `debugger` message's `callStack` when `showCallStack` is on,
  so add `stack: {nodeIds: string[]}` to the `executionGraph` message the host recomputes on
  every `navChanged` at most every 50 ms): its nodes and the edges between consecutive
  frames are full colour, everything else 35 % opacity. Nodes whose `spans` all end before
  `s` get a "done" tick; nodes not yet entered stay dimmed.
- The walkthrough list (the existing `Walkthrough` component) on the left, active moment
  following the step as it does today; clicking a moment also selects its node.
- The inspector (right): the selected node's rows, its calls one per line ("Runner.run ×5":
  the unrolling, each with its steps and a click to jump), the gloss of the moment at the
  current step when narrated, and "now": the rows of the node the current step is in.
- Selecting a merged package node unrolls it into its functions side by side (`--all`
  granularity for that node only; the host serves `graph {expand: nodeId}`).

## Steps, and who does them

Phase 0, the main session, sequential, then commit (subagents start from this commit):

1. Merge `worktree-walkthrough-narration` into `main` (fast-forward) and create the
   worktree. Run `scripts/check.sh` once to confirm the baseline.
2. Write the contract into `docs/PROTOCOL.md` (above), the TypeScript types into
   `src/session/executionGraphTypes.ts` (nodes, edges, `ExecutionGraph`,
   `ExecutionGraphOptions {all?, scope?, expand?, cap?}`), the panel message types into
   `src/shared/webviewProtocol.ts` (`HostToWebview` `{type: 'executionGraph', graph:
   ExecutionGraphPanel | null}` where `ExecutionGraphPanel` is the graph with display paths
   plus `stack: string[]` and the Time Machine's `currentStep`; `WebviewToHost` `{type:
   'executionGraph.expand', nodeId}`), the bridge request name, the CLI command name and
   flags, and the fixture plan: `test/unit/fixtures/execution-graph.json` is written by the
   Python test from `test/unit/fixtures/walkthrough-run.json` (`PYOKKA_WRITE_FIXTURES=1`),
   the TypeScript test reads it. Add a second fixture program for the data edges and the
   cap if the walkthrough fixture cannot show them (`test/unit/fixtures/graph/…`).
3. Commit ("Execution diagram: contract, types, fixture plan").

Phase 1, three subagents in parallel (Agent tool, no `name:`, each in the same worktree,
disjoint files, each told to run its own tests and to stop at the file boundary; each
reports the commands it ran and what passed):

- **A, runtime + CLI**: `python/pyokka_runtime/agent/graph.py` (builder over
  `walkthrough()` + `SavedRun`; `graph_dot.py` for `--dot` if it does not fit in 500
  lines), `commands.py` (`graph` subcommand, renderer, `--json`, `--dot`, `--live` via
  `live.py`'s new `graph` method), `python/tests/test_graph.py` (the fixture writer, the
  demo run, `--all`, `--scope`, the cap, the data edges, the text and dot forms). Files it
  may touch: `python/**`, `test/unit/fixtures/execution-graph*.json`,
  `test/unit/fixtures/graph/**`.
- **B, host**: `src/session/executionGraph.ts` (pure builder over `buildWalkthrough`,
  same output as A on the fixture; `test/unit/executionGraph.test.ts`), the bridge request
  in `src/agent/bridge.ts` (+ `redactGraph` in `bridgeSupport.ts`), a `GraphProvider` in
  `src/features/executionGraph.ts` (cache per run, `stack` per step throttled at 50 ms,
  posts `executionGraph` on `runFinished` / `navChanged` / expand), `outputPanel.ts`
  (post + the `executionGraph.expand` message), `extension.ts` (command
  `pyokka.showExecutionDiagram`, API `graph`), `scripts/gen-manifest.py` (the command,
  regenerate `package.json`). Files: `src/**`, `scripts/**`, `package.json`.
- **C, panel**: `webview/executionDiagram.ts` (graph → `DiagramNode`/`DiagramEdge` for
  `layoutGraph`, `rankdir: TB`, decision nodes as diamonds or a `decision` row style,
  edges thicker with count, data edges dashed, dimming by the active path),
  `webview/components/ExecutionDiagram.tsx` (the view: canvas from `Diagram.tsx`'s
  pan/zoom, the scrubber, the walkthrough list on the left via the existing `Walkthrough`
  component, the inspector on the right), `webview/model.ts` (`executionGraph` state, a
  `'run-diagram'` view id), `webview/App.tsx` (the view, "Show execution diagram" in the
  rail's More menu and on the Time Machine toolbar), `webview/styles.css`,
  `test/unit/webview/executionDiagram.test.ts(x)` (layout of a small graph, rendered rows,
  the active path classes, the scrubber position). Files: `webview/**`,
  `test/unit/webview/**`, and only the `ViewId` union in `src/shared/webviewProtocol.ts`.

Phase 2, the main session: integrate (typecheck, `scripts/check.sh`), the e2e
`test/e2e/execution-diagram.test.js` (on `demo.py`: `pyokka graph --live --json` equals
`pyokka graph` on a saved run of the same file in node and edge sets; the API's graph has
the node set below; `pyokka.showExecutionDiagram` switches the panel view; `expand` on a
package node when Step Into Library Code is on), add it to `.vscode-test.mjs`, CHANGELOG,
`docs/PROTOCOL.md` final wording, the skill `skills/pyokka-agent/SKILL.md` (the `graph`
command), a line in `docs/HANDOFF-understanding-generated-code.md` item 7 saying it exists
(and items 10 and 16, absorbed), vsix rebuilt and installed, commit.

## Acceptance

- `pyokka graph` on a saved run of `examples/demo.py` has the nodes `<module>`,
  `Point.__init__` (calls 4), `generate_random_point`, `Rectangle.__init__` (2),
  `rectangles_overlap`, `Rectangle.contains`, `Point.distance`, the decision `if False took
  False` under `<module>` with `notRun: [32]`, edges `<module> → Point.__init__ ×3` and
  `generate_random_point → Point.__init__ ×1`, `in x = 5 · in y = 10` rows on
  `Point.__init__`, and the `raised ValueError` row on `<module>`.
- On `$TMPDIR/agent-run.json` (`--library-code`): `<module> → openai ×1`
  with the `raised OpenAIError` row and `nested`, `<module> → pydantic` for the model class,
  and `--all` unrolls `openai` into `OpenAI.__init__` and its callees; the cap keeps the
  node count ≤ 200 with `capped: true` when `--all` exceeds it.
- The test bed's `example.py` (only when the user runs it: no cost, no network): `<module>
  → Account.__init__ ×2`, `<module> → withdraw` with `in amount = 30`, `out 55.5`, the `if
  amount > self.balance` decision with the raise arm in `notRun`.
- In VS Code on `demo.py`: the view opens from the rail and the toolbar, dragging the
  scrubber moves the Time Machine and the highlighted path, clicking a node jumps to its
  first call, the walkthrough list on the left stays in sync, a package node unrolls on
  selection.
- `scripts/check.sh` and the whole e2e suite pass (in a worktree: `.vscode-test.short.mjs`,
  see `docs/HANDOFF.md`); both graph builders produce identical JSON on the fixture.

## Out of scope here

HTTP rows (item 6/12), per-step timings (item 18), the run summary paragraph (item 2),
concurrency-correct stacks for coroutines (item 1: the diagram shows what the trace
records). Note anything that needs one of them in the handoff and keep going.
