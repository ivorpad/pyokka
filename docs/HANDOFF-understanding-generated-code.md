# Handoff: understanding generated code with Pyokka

Read `docs/HANDOFF.md` first (decisions, commands, quirks, map). This file holds the work
items, in the order to do them. The user's objective, stated 2026-09-10: AI generates a lot
of Python for them and they have a hard time understanding all of it; they want Pyokka (and
agents through it) to make a recorded run explain the code. Every item below serves that.
The motivating test bed was an agent program (`agent.py`, a ported OpenAI cookbook) that is
not in this repository; its runs call an LLM and cost tokens. For anything that needs a
run, use `examples/demo.py`, `examples/rrf/` or a scratch under `$TMPDIR`.

Conventions for every item: contract first in `docs/PROTOCOL.md` (event or CLI shape), then
runtime (`python/`, stdlib only, pytest), host (`src/`, vitest), panel (`webview/`, rendered
tests in `test/unit/webview/chrome.test.tsx`), e2e in `test/e2e/`, then CHANGELOG. Redact
everything that leaves the process (`redact.py` / `src/util/redact.ts`, shared fixture).
`scripts/check.sh` and `./node_modules/.bin/vscode-test` must pass before the vsix is
installed. Bounded outputs everywhere: an agent or a human reads them.

---

## 1. Truthful stacks and moves for coroutines (prerequisite for SDK code)

**Done 2026-09-11** (branch `worktree-coroutine-scopes`): `enter()` reads the caller frame's
`_pk_scope_` (module frame ends the walk); moves follow the scope's parent chain in both
models (`gather` and `siblings` cases in the shared fixture); `test_gathered_coroutines_have_module_parents`;
e2e "steps over an awaited gather". Cost and the rejected frame-id variant: `docs/PROTOCOL.md`
runtime notes. Acceptance checked on `aio.py`: `turn(3)` stack `turn ← <module>`, max depth 3,
`step 16 --over` lands on `print(one, both)` (step 41).

**Problem, verified** (`$TMPDIR/aio.py`, saved run): a scope entered while
another task's scope was current gets that scope as parent (`tracer.py` `enter()` uses
`tracer.cur_scope`), so a `fetch` under one gathered task shows at depth 5 under the other
task's `fetch`, call stacks are wrong, and the depth-based moves in `traceModel.ts` /
`trace.py` (`stepOver` = next step with depth <= current) hop between tasks. Sequential
awaits are fine. Agent SDKs run internal tasks, so stepping into them today misleads.

**Design.**
- Runtime, `enter(rid)`: parent = the caller frame's `_pk_scope_` local. `getframe(1)` is
  the entered function's frame; walk `f_back` up to 4 frames looking for `_pk_scope_` in
  `f_locals` (3.13+: a proxy, cheap; 3.12: a dict snapshot, measure). A direct `await`
  runs inside the awaiting frame's stack, so the parent is the awaiting coroutine;
  generators get the consumer; lambdas the call site. No instrumented caller within the
  walk (a task resumed by the event loop, a thread) → parent 0 (module), depth 1. Drop
  `cur_scope` from parentage; keep it for `cur_rid`/logs.
- Moves by scope, not depth, in both models: over = next step whose scope is the current
  scope or one of its ancestors (parent chain); out = next step in an ancestor; back
  variants mirror; into stays "next step". `canStep` follows. Keep `depth` in the quads
  for display. This also fixes plain code: over from inside `f` no longer lands on a
  sibling call `g` at the same depth.
- Timeline strip / call stack in the panel read `depth` and `parent`: verify they still
  render; gathered tasks now sit at depth 1.

**Steps.** (1) Add a `gather` case to `test/unit/traceMoves.fixture.test.ts` with the
expected scope-based moves written by hand; regenerate `fixtures/trace-moves.json`
(`PYOKKA_WRITE_FIXTURES=1`); `python/tests/test_trace.py` reads the same file. (2) Change
the moves in `traceModel.ts` and `trace.py`. (3) Change `enter()`; add
`python/tests/test_tracer.py::test_gathered_coroutines_have_module_parents` (two tasks,
each with a nested call; assert parents, depths, and `step over` on the `await gather`
line landing on the next `main` statement). (4) `tests/test_perf.py` must stay under
budget; if 3.12 `f_locals` costs more than ~10%, use a per-task current scope keyed by
`asyncio.current_task()` (try/except when no loop) instead of the frame walk. (5) e2e:
`features.test.js` step tests still pass; add one on an async fixture file.
**Acceptance**: in `aio.py`, `context` at any step of `turn(3)` shows stack `turn ←
<module>`, no depth above 3; `step 16 --over` (the `gather` line) lands on `print(one,
both)`.

## 2. Run summary: what happened, in one screen

The walkthrough list and the narration backend this item relies on are specified on
their own in `docs/HANDOFF-walkthrough-narration.md`. **Built 2026-09-11**: `pyokka
walkthrough` / `narrate`, the bridge's `walkthrough` request, the WALKTHROUGH section and
the Code Story block, `src/agent/narrate.ts` + `src/features/narrator.ts` (the backend
this item's "Explain run" should reuse: `Narrator.narrate` runs one command or `vscode.lm`
and caches per run).

**Problem.** After a run of generated code the user faces values scattered over the file
and a Time Machine strip. They need a first paragraph: what ran, what was called, what
failed, what was printed.

**Data, all recorded already**: `file.instrumented` (files, functions, statements),
`trace` (steps, scopes: one scope per call, `name`, `rid`), `log` events (values, prints),
`error` events (`handled` true/false, `traceback` for the uncaught one), `output` events,
`coverage`, `run.finished` (duration, exit code), `meta` in saved runs.

**Design.** Two layers. (a) Deterministic summary, no model: `pyokka summary run.json`
(also `--live`) and a host function `src/session/runSummary.ts` producing the same JSON:
entry file and exit code, duration, top-level statements executed in order (first N),
functions called with counts and the file each lives in (user code first, library
grouped by package), exceptions (uncaught with type/message/location; handled ones
grouped), output lines (first N), coverage headline (statements run / total per user
file), files touched (any `open(` value seen), network (any `httpx`/`openai`/`requests`
scope entered: count). Text rendering ≤ 40 lines. (b) An agent's paragraph on top: the
extension asks `vscode.lm.selectChatModels` (Copilot's models, VS Code ≥ 1.90; the
manifest engine is ^1.93) for a 5-sentence narrative from the deterministic JSON, only
when the user clicks "Explain run" (never automatic: cost and privacy); the CLI leaves
that to the calling agent (the skill tells it to run `summary` first). Show it at the top
of Code Story as a fenced note block and in a new "SUMMARY" section of the Output view
(collapsed by default). Cache per `runId`.
**Narration backend, shared with items 3 and 7.** Deterministic text comes first and
covers most of the need: templates per recorded event (scope entry with caller and step,
decision with the value that decided it, tool call, logged value, duration, exception)
produce sentences in order with step numbers; no model, instant, free. A model only adds
the gloss, in one batched call per run (the deterministic JSON in, sentences keyed by
moment id out, cached by `runId`, never automatic, values masked). The backend is a
command template, setting `pyokka.explain.command` with `{prompt}` on stdin, defaulting
to the first available of: `claude -p --output-format json` (no tools), `codex exec`
(last message captured), and inside VS Code `vscode.lm.selectChatModels` when neither
CLI is on the PATH. Verify the CLIs' current flags before wiring them; no API keys in the
extension.
**Steps.** Contract shape in `docs/PROTOCOL.md` (`RunSummary`); Python builder in
`pyokka_runtime/agent/summary.py` from `SavedRun`; TS builder from `Session` state (share
the shape, test both against one fixture run saved from `examples/demo.py`); CLI command;
Code Story block; Output section; `Explain run` command and LM call behind a setting
`pyokka.explain.model` (`"copilot"` | `"off"`); rendered tests; e2e for the CLI on a saved
demo run.
**Acceptance**: `pyokka summary` on the `agent.py` saved run names `OpenAI(...)` as the
call that raised `OpenAIError`, lists `CalendarEvent` as defined and never used, and fits
on one screen; on `demo.py` the summary lists the prints and the functions called.

## 3. Explain on selection, with recorded values as evidence

**Problem.** "What does this do?" on generated code should be answered from what it did,
not from reading the source. The context slice already assembles exactly that evidence.

**Design.** Command `pyokka.explainSelection` (editor context menu and `Cmd+K E`): take
the selection (or the statement at the cursor), build `contextSliceForLine` for the range
with `scope: true` (block, values, stack at the first step on those lines, errors,
coverage of the block), plus the run summary headline, and hand it to a model with a
fixed prompt ("explain what these lines did in this run; cite step numbers and values;
say what never ran"). Two backends: `vscode.lm` (Copilot) rendered in a chat response via
a `@pyokka` chat participant (`vscode.chat.createChatParticipant`, `/explain` command;
the participant attaches the slice as a reference so the user sees the evidence), and
"copy prompt" for any external agent (the slice as Markdown on the clipboard, and the
`pyokka context --live --line F:L --scope` equivalent printed so Claude Code can be asked
directly). When the lines never ran in the last run, say so instead of guessing, and
offer Re-execute. Library lines: the slice reads the library source from disk already.
**Steps.** Markdown renderer for a context slice (`src/agent/sliceMarkdown.ts`, pure,
unit-tested; also used by the CLI's `--format md` later); chat participant registration
in `scripts/gen-manifest.py` (`contributes.chatParticipants`) and `src/features/explain.ts`;
prompt text in one place with a test that it includes step numbers and values; command,
keybinding, context-menu entry; e2e that the command produces a prompt for `demo.py:11`
containing `'is_awesome': True` (the LM call itself is not e2e-tested; stub the model
behind an interface).
**Acceptance**: select `client = OpenAI(...)` in `agent.py` after a run: the explanation
says the key was `None`, names the OpenAI error, and cites the step; select a function
that never ran: the answer says it never ran.

## 4. Variable history (data-flow view)

**Problem.** Following one variable through generated code is the most common question
("where does `dt` come from?"). Values exist per statement only where logged; the
`locals` events (`recordLocals`, on by default for `pyokka run --save`, off in the
extension) give per-step changes of every local, and the trace gives the order.

**Design.** A "VARIABLE" pane in the Output view and `pyokka var run.json NAME [--scope
F]`: for a name (from the cursor or typed), the list of steps where it changed, with
scope, `file:line`, the new value text, and the step; click → Time Machine at that step.
Sources, in order of preference: `locals` entries (`{step, scopeId, changes:[{name,
text}]}`), `log` values whose `context` is the name (`# ?`, Auto Log, identifier
statements), and as a last resort the statements that assign the name (AST of the file:
`Assign`/`AugAssign`/`AnnAssign`/`For` targets, `with … as`), shown as "assigned here at
step N (value not recorded)". Attribute paths (`self.balance`, `r.output_parsed.date`)
match on prefix. "Where it came from": for the selected change, the values of the names
read on that statement (AST `Name` loads) at that step, one level, so the user can walk
backwards by clicking.
**Steps.** Session-side `recordLocals` as a per-session toggle in Settings ("Record
variable changes", off by default; the runtime caps at 100k entries); `src/session/
variableHistory.ts` (pure, tests with a hand-built trace + locals); Python twin in
`agent/context.py` for the CLI; the pane (rendered test), the CLI command, the click to
step, the e2e on `demo.py` (`pyokka` and `working_dir`).
**Acceptance**: `pyokka var agent-run.json api_key` lists the two locals in
`openai/_client.py` with `None`; in the panel, typing `acct` on `example.py` lists its
assignment and the balance changes with steps that navigate.
**Built 2026-09-11.** Contract in `docs/PROTOCOL.md` ("Variable history", the `bindings`
runner request, the bridge's `var`). Runtime: `pyokka_runtime/bindings.py` (assigns / reads per
statement from the AST, loop headers flagged), the stateless `bindings` request in
`runner.py`, `agent/history.py` (the builder; `context.py` was at the line ceiling), `var` in
`commands.py`, `SavedRun.var` / `LiveRun.var`. Host: `src/session/variableHistory.ts` (pure
twin, hand-built trace tests) and `variableQuery.ts` (bindings fetched per run and file,
cached on the run state), `Session.recordLocals` + `setRecordLocals`, the bridge's `var`, the
`pyokka.showVariableHistory` command (name under the cursor, else an input box), the API's
`variableHistory` for e2e. Panel: `webview/components/VariablePane.tsx` (rail button
`symbol-variable`; a row posts `debugger.goto`, a read name re-queries; the view stays when
the Time Machine starts from it), "Record Variable Changes" in Settings. Tests: pytest
(`test_bindings.py`, `var` in the CLI and live suites, the runner request), vitest
(`variableHistory.test.ts`, rendered pane, reducer), e2e (bridge `var`, `pyokka var --live`,
`api.variableHistory` before and after the session toggle on `demo.py`). Verified on the test
bed: `api_key` gives the parameter `None` at `_client.py:159` and the re-assignment at line
250 as `None (unchanged)` (the runtime records changes only; the second row is inferred from
the following step observing none). Open: `reads` resolve names only (not attribute paths,
whose values exist only when logged); library files get AST rows and reads only when the name
was recorded in them (bindings are fetched for the main file, project files and those files);
a `for` over an empty iterable still lists its header as an assignment site.

## 5. Swallowed-exception report

**Status (2026-09-11): built** on branch `worktree-swallowed-exceptions`, contract first
(`docs/PROTOCOL.md` "### `error`" and "Exceptions report", `protocol.ts`,
`src/session/exceptionReportTypes.ts`, the panel message, the fixture program
`test/unit/fixtures/exceptions/`), then three subagents on disjoint files. Runtime
(`errors.py`, `instrument.py`): EXCEPTION_HANDLED sets a tentative handler that a later
RERAISE or RAISE of the same exception object clears, so a `finally`, a `with` cleanup, a
non-matching `except` block, a re-raising handler and the instrumenter's own `try/finally`
never count; the handler line comes from `code.co_lines()` at the event's offset
(`f_lineno` still says the raising line there); a multi-clause block resolves to the clause
whose body owns the next recorded step, from a per-file clause table
(`InstrumentedFile.except_clauses`, built before the rewrite); groups per (type, origin
rid, handler rid) fold at eviction and at `finish`, 50 at most. Departures from the text
below: `handledAt.rid` is the `try`/`with` statement's rid (compound ranges cover only the
header, so `rid_at` of the clause line is the try body's last statement); caught events
reach the host only when the run ends (aggregation needs the whole run); an exception
raised in a library and swallowed by C code or the stdlib stays out too. Report:
`python/pyokka_runtime/agent/exceptions.py` and `src/session/exceptionReport.ts`, pinned
to each other by `test/unit/fixtures/exceptions.json` over `exceptions-run.json` (eight
rows: the bare `except:` loop ×3, a specific handler, through a `with` and a `finally`, a
re-raise, `contextlib.suppress`, a library raise into user code, a C-code swallow ×2, the
uncaught `ZeroDivisionError`); `pyokka exceptions RUN` (text form in `agent/render.py`,
where `commands.py`'s renderers moved for the 500-line ceiling), bridge request
`exceptions`, `api.exceptions(session)`, the EXCEPTIONS section
(`webview/components/Exceptions.tsx`, rendered in `chrome.test.tsx`; `extension.ts` and
`outputPanel.ts` shed `api.ts`, `quickPicks.ts`, `wait.ts` and the HTML shell for the
ceiling), `test/e2e/exceptions.test.js` on the fixture copied into the workspace.
Acceptance on the cookbook file was not run (a run costs tokens); the old saved run
`$TMPDIR/agent-run.json` predates `handledAt`, so on it every caught row
reads "caught outside stepped code". `demo.py` shows only its uncaught `ValueError`.
`walkthrough` and the moments still say "handled at" from the step after the raise (where
execution resumed), not from `handledAt`; switching them is a small change on both sides.

**Problem.** Generated code catches broadly. The runtime records handled exceptions
(`errors.py`: RAISE + EXCEPTION_HANDLED via `sys.monitoring`, up to 50 events per run,
never for library files, `handled: true`), and the panel folds them into the entries
list where they are easy to miss.

**Design.** Extend the `error` event with `handledAt: {fileId, line, rid, function}` (the
code/offset from the EXCEPTION_HANDLED callback resolved with `rid_at`), and `count` when
the same (type, origin rid, handler rid) repeats (aggregate instead of emitting 50
identical events; keep the first step and the last step). A report: `pyokka exceptions
run.json` and an "EXCEPTIONS" section in the Output view: one row per (type, raised at,
handled at), count, first step, message of the first; rows for exceptions handled by a
bare `except:` or `except Exception` are flagged "broad handler" (AST of the handler
statement: `ExceptHandler.type` is None or `Exception`/`BaseException`). Click → the
raising step. Uncaught exception rows first. Library-internal exceptions stay excluded;
an exception raised in library code but handled in user code is reported (the handler is
user code).
**Steps.** Runtime: record the handler location and aggregate (tests in
`test_errors.py`: three identical raises → one event with `count: 3`); protocol doc and
`protocol.ts`; session stores `errors` unchanged plus the new fields; report builder
(pure, TS + Python); panel section (rendered test); CLI command; e2e on a fixture with a
broad `except:`.
**Acceptance**: on the cookbook file after a run, the report lists every caught
exception with its handler line; `demo.py` shows none.

## 6. Replay a run from recorded HTTP responses

**Done 2026-09-11** (branch `worktree-http-replay`, contract committed first, then three
subagents on disjoint files: the plugin, the runtime wiring, the host and panel; a fourth
wrote the e2e). Contract: `docs/PROTOCOL.md` "Plugins" and "HTTP record and replay".
Runtime: `python/pyokka_runtime/plugins/http_record.py` with the private `_http_store`,
`_http_clients`, `_http_fallback` modules (the 500-line hook forced the split);
`RunConfig.http` appends the plugin itself; plugins gained `after(config)`,
`execute.current` and `execute.runner_error`; `pyokka run --http record|replay`.
Host: `pyokka.http`, `Session.http` / `setHttp`, the Settings dropdown, the status-bar
badge, `src/features/replayGitignore.ts`. Tests: `test_http_record*.py` (22, real httpx
and requests from the dev group with faked network layers, a local `http.server` for the
fallback), runtime wiring tests in `test_runner.py`, vitest for merge / Settings /
gitignore, e2e `test/e2e/http-replay.test.js`. Acceptance checked in a dev host on the
user's `agent.py` (On Demand): one record run, 5.16 s, `recorded 1`, the recording without
credentials and the `.gitignore` offer; then Replay: 887 ms, same participants, event and
date, `replayed`. Two deviations from the plan text: a record run *replaces* the file
instead of appending (the file mirrors the last recorded run), and when the keys of a
request are used up the last entry repeats. Known limit: raw urllib3 over HTTPS in replay
still opens the TLS connection before our `send` hook (requests is unaffected).

**Addendum 2026-09-12** (same branch): the HTTP view. Using the feature in the dev host showed
that the mode was invisible until the next run and the recording unreachable. Now every run
emits one `http.exchange` row per request (the calling statement found by a frame walk at
request start, so worker threads and instrumented libraries still name the user's line), the
panel has an HTTP pane (rows live, footer totals, mode dropdown, Open recording), the status
bar and the rail button show the mode while it is on, HTTP Off observes (`pyokka.httpObserve:
false` opts out), and `pyokka http` / bridge `http` serve the same table. Contract: PROTOCOL
"HTTP record and replay" (Modes, Rows, HTTP table, Hosts). Left for later: walkthrough `http`
moments from the same events (the kind stays reserved), header/body inspection in the pane,
rows for requests that raised before a response.

**Problem.** Re-running API-driven code costs money and time, and edit-and-continue is
useless when every re-run makes new calls. Recording the HTTP layer once and replaying it
makes re-runs free and deterministic.

**Design.** A runtime plugin (the `plugins` config already loads modules and calls
`before(cfg)` / `before_each(cfg)` in `execute.run_plugins`): `pyokka_runtime/plugins/
http_record.py`. Modes via config `http: "off" | "record" | "replay"` (session setting in
the panel's Settings, "HTTP: record / replay", and `--http` on `pyokka run`). It wraps
the transports of the clients present: `httpx.HTTPTransport.handle_request`,
`httpx.AsyncHTTPTransport.handle_async_request` (the example venv ships these as
`httpx2`, same class names; wrap whichever imports), `urllib3`/`requests` via
`HTTPAdapter.send`, `http.client.HTTPConnection.getresponse` as the fallback. Record:
per request `{method, url, headers (Authorization/Cookie/api-key stripped), body (bytes,
base64 when not UTF-8), status, headers, body, streamed: bool, chunks}` appended to
`<workspace>/.pyokka/replay/<file hash>.jsonl`, plus a `key` = sha256(method, url, body
with whitespace normalised). Replay: a transport that answers by `key`, in recording
order for identical keys, serving streamed bodies as chunks (SSE from the OpenAI SDK);
a miss emits a `runner.error` "no recorded response for POST …; run once in record
mode" and raises `ConnectionError` in the program. Time: replay is fast, so the values,
coverage and Time Machine reflect the original call results; a `replayed: true` flag on
`run.finished` and a status-bar badge say so. Values and bodies pass through the secret
masking. The replay file is git-ignored on first write (ask once, like saved runs).
**Steps.** Contract in `docs/PROTOCOL.md`; the plugin with unit tests against a fake
transport (record then replay, streamed and plain, miss); wire into `execute.run`
(config → plugins list); `pyokka run --http record|replay`; panel setting and badge;
e2e with a local `http.server` fixture (no network): record a scratch that GETs it, stop
the server, replay, same values.
**Acceptance**: `agent.py` with a real key (user present, On Demand): one run in record
mode, then edit the `print` lines and re-run in replay mode with no network and no
tokens; `dt` and `response.output_parsed` are identical.

---

## 7. Execution diagram: start, calls, decisions, data in and out

**Done 2026-09-11** on branch `worktree-execution-diagram` (`docs/HANDOFF-execution-diagram.md`,
status block at the top): `pyokka graph`, the bridge's `graph`, the panel's Execution Diagram
view with the scrubber, the walkthrough list and the inspector. Items 10 and 16 are absorbed
(their acceptance checks hold on the demo run: `<module> → Point.__init__ ×3` and the rows of
the first call on every function node). The text below is the original brief.

**Problem.** The user asked for the Diagram pane's kind of picture, but of the run: where
it started, which decisions were taken, what data went into each call and what came out.
The canvas exists (`webview/diagram.ts`: generic nodes with rows, edges, dagre layout;
`components/Diagram.tsx` for pan/zoom/expand); only its graph builder is value-specific.
**Data.** Scopes (one per call: name, rid, parent, first/last step) → nodes and call
edges; statements + coverage (`states`, `expr_children` partial branches, never-run lines)
→ decision nodes for `if`/`while`/`match`/ternary that ran, with the branch taken;
values (`log` entries by rid: parameters from Auto Log or `def` logpoints, `Return`
values, `# ?`, locals changes when recorded) → rows in and out; errors → a red row on the
raising node; item 11's http entries → "sent / got" rows on SDK calls; item 17's times →
duration rows. Item 1 makes concurrent branches correct.
**Design.** "Show execution diagram" in the panel rail's More menu and on the Time
Machine toolbar; `pyokka graph run.json --json|--dot`. Graph builder `src/session/
executionGraph.ts` (pure, TS) and `agent/graph.py` (Python, same JSON): nodes = the
module node plus one node per distinct function that ran (calls of the same function
merge; the edge carries the count and the first step), collapsed nodes per library
package (expand on click), decision nodes inline under their function with the
condition text, taken-branch label and the deciding value when logged, greyed never-run
arm. Edges numbered by first step so the walk from the start is explicit; thicker with
count. Rows: `in: amount = 30`, `out: 55.5`, `raised OpenAIError`, `POST /responses →
200`. Click a node → Time Machine at its first step; click a row → the existing value
diagram of that value; hover an edge → the steps it stands for. Bounded: at most 200
nodes, then "N more in package X" nodes; loops show as counts, recursion as one node
with a self-edge. Layout top-down from the module node (dagre `rankdir: TB`).
**Time layer, from the preview reviewed on 2026-09-11** (artifact "run.py Execution
Diagram"): the DAG alone is a map, not an explanation. Add: a step scrubber with play
under the canvas, the path active at that step highlighted and the rest dimmed; a
walkthrough list in execution order (**exists since 2026-09-11** as `pyokka walkthrough` /
the bridge's `walkthrough` request / `buildWalkthrough` in `src/session/walkthrough.ts`,
with `scopeId`, `entryStep` and `endStep` per call moment to link into the graph, and glosses
from the narration backend), each entry linked to the graph and the Time Machine; data-flow edges (produced here, used there, labelled with the
name) drawn from values and locals changes; "your code only" as the default with
packages collapsed; unrolling a merged call (`Runner.run ×5`) into its calls side by side
on selection; the inspector shows "now" (the current moment's values) above the selected
node.
**Steps.** JSON contract in `docs/PROTOCOL.md` (`ExecutionGraph`); builders with a shared
fixture from `examples/demo.py`; decision extraction from the AST of user files (which
statement is a decision, which lines belong to which arm) cached per file; the pane mode
(rendered test of node rows; layout test in `diagram.test.ts`); the CLI; e2e opening the
diagram on `demo.py` and asserting the node set. Items 10 (function cards) and 16 (call
graph) are absorbed here; keep their acceptance checks.
**Acceptance**: `example.py` shows `<module> → Account.__init__ ×2`, `<module> →
withdraw` with `in: amount = 30`, `out: 55.5`, and the `if amount > self.balance` decision
with the false branch taken and the raise arm greyed; the cookbook run shows five
`Runner.run` nodes' worth of edges from `run_session` with counts, collapsed SDK packages,
and the decision on `dt.year < 2024`.

## 8. Coverage as a review report: what never ran

**Problem.** "The AI wrote 400 lines and 120 never ran" is invisible today: coverage is
gutter colour per line, not a list.
**Data.** `coverage` events (`states` per local rid: 0 not run, 1 covered, 2 partial, 3/4
error, 5 ignored; `hits`), `file.instrumented.statements` and `functions` (with
`bodyRange`), `expr_children` for partial branches.
**Design.** `pyokka coverage run.json [--file F]` and a "COVERAGE" section in the Output
view: per user file, functions never called (name, line, size), statements never run
grouped into contiguous ranges with the first line's text, partial statements with the
branch that never ran (the `expr_children` that has 0 hits: `and`/`or` operand, ternary
arm, comprehension condition), and the headline `N of M statements ran`. Library files
excluded unless `--all`. Click → the line. Sorted by size of the never-run block.
**Steps.** Pure builder in TS (`src/session/coverageReport.ts`) and Python
(`agent/coverage.py`) sharing a fixture; CLI; panel section (rendered test); e2e on
`demo.py` (`print("noCoverage")` at line 32 is never run).
**Acceptance**: on the `agent.py` saved run the report lists the `if/else` after the call
as never run and `CalendarEvent` as never instantiated.

## 9. "Why is this value here": walk backwards to the producing statements

**Problem.** Item 4 lists where a name changed; the next question is which values fed the
change. Generated code chains many small transformations.
**Data.** Same as item 4, plus the AST of the statement (names read, calls made) and the
trace's back moves to find the previous step in the same scope.
**Design.** From a selected value (panel entry, hover, or `pyokka why run.json STEP NAME`):
show the statement, the names it read with their values at that step (locals snapshot or
the last logged value before the step), and for each read name a link "changed at step
K" (item 4's history). Walk up to 5 levels automatically into a tree ("`dt` ← `parser.parse(
response.output_parsed.date)` ← `response` ← `client.responses.parse(...)`"). Calls whose
body was stepped show their return step; opaque calls show as leaves.
**Steps.** `src/session/provenance.ts` (pure, tests), Python twin, CLI command, a
"Why" action on entries and on the Variable pane rows, tree rendering in the Details pane.
**Acceptance**: on `example.py`, "why" on `total` shows the generator's inputs `acct` and
`Account("guest", 5)` with their balances.
**Built 2026-09-12** (branch `worktree-why-provenance`; the contract committed first, then three
subagents on disjoint files: runtime and CLI, host, panel; integration by the main session).
Contract in `docs/PROTOCOL.md` ("Provenance", the bridge's `why`, `calls` in the bindings reply,
`autoExpand` as a value kind of `var`). Runtime: `bindings.py` lists the calls each statement
makes; `agent/provenance.py` builds the tree over `History` (item 4) and `MomentBuilder` (the
walkthrough's call rules); `why` in `commands.py`, `render_why` in `agent/render.py` (the
renderers moved there: `commands.py` was at the ceiling), `SavedRun.why` / `LiveRun.why`. Host:
`src/session/provenance.ts` (pure twin), `sessionProvenance` in `variableQuery.ts`, the bridge's
`why`, `pyokka.whyValue` ("Pyokka: Why This Value": the hover's Why link, or the name under the
cursor at the Time Machine's step, else at its last change), `WhyPaneHost` in
`src/views/whyPane.ts`, `api.provenance`. Panel: a Why button on every entry and on every Variable
pane row; the tree is the Details pane's document (`webview/why.ts` over the shared renderer
`src/shared/provenanceText.ts`, so the pane and the CLI print the same lines); a line moves the
Time Machine to its step, the eye opens the statement. `test/unit/fixtures/provenance/` is the
program both builders are pinned to: `python/tests/test_provenance.py` writes the run and 13 trees
(`PYOKKA_WRITE_FIXTURES=1`), `test/unit/provenance.test.ts` must reproduce them. Tests: pytest
(bindings, the fixture cases, the CLI text and JSON, the live fake bridge), vitest (the builder over
hand-built traces and the fixture, the document builder, the reducer, the rendered buttons), e2e
`test/e2e/why.test.js` (bridge, `--live` and saved CLI, the API, the call's arguments once locals
are recorded). Verified on `example.py`: `why 21 total` shows `acct = Account(owner='ivor',
balance=85.5)` (through the `# ?+` value at #20, back to the assignment at #3) and
`Account("guest", 5)` as an opaque call next to `sum(...)`. Open: a generator expression is not
a scope, so its variable never appears; locals record rebinding only, so a mutation between a
binding and a read shows only through the calls made in between (`acct.deposit` is not on the
tree of `total`, only the `# ?+` observation is); a `def` bound before the first step is
attributed to the first observed step (`var`'s rule); reads inside library statements resolve
only where bindings were fetched (the main file, the project files, the files where the name
was recorded).

## 10. Per-function cards in Code Story

**Absorbed by item 7 (2026-09-11)**: every function node of the execution graph is that card
(calls, spans, the first call's parameters and result, what it raised); the Code Story mode and
per-call timings are not built.

**Problem.** Generated code is many small functions; reading them as a story block per
call repeats them. A card per function reads like documentation that is true.
**Data.** Scopes (name, rid, first/last step, parent), `def_logs`/entry parameters when
Auto Log or a logpoint on the `def` recorded them, return values (`Return` statements are
auto-loggable), call counts, callers (parent scope's rid → file:line), time per call from
step timestamps (not recorded today: add an optional `t` per scope entry/exit in the
tracer, ms since run start, behind the same flag as `recordLocals`).
**Design.** A "Functions" mode of Code Story (toggle in its title): one card per function
that ran: signature line, called N times from [file:line …], parameters seen (first 3
distinct), return values seen (first 3 distinct), min/avg/max time, exceptions raised
inside, a link to each call's story block. Library functions grouped under their package,
collapsed. Also `pyokka functions run.json`.
**Steps.** Tracer: optional timestamps on scope entry/exit (protocol `scopes[].t0/t1`);
builder (TS + Python, fixture); Code Story mode; CLI; tests.
**Acceptance**: `example.py` shows `withdraw` called once from line 33 with `amount=30`
and return `55.5`; the cookbook run shows the SDK's top-level entry points with counts.

## 11. Error moment: land on the failing step with its frame

**Problem.** An uncaught exception today shows a red entry and gutter; the user then has
to find the step. The panel should open there, with the frame's values, one click from
the Time Machine.
**Data.** The unhandled `error` event (`step`, `stack` with rids, `traceback`), locals if
recorded, values logged in the frame's scope.
**Design.** On `run.finished` with an unhandled error: the Output view shows an "ERROR"
band at the top (type, message, `file:line`, "Open in Time Machine" and "Explain" (item
3) buttons); the Time Machine, when started from that band, goes to the error step with
the call stack open; the Details pane shows the frame's variables (locals at that step, or
the last logged values of the scope). Setting `pyokka.openPanelOnError` (default true) to
reveal the panel when a run fails.
**Steps.** Session exposes `state.errors.find(!handled)`; panel band (rendered test);
navigator `startAtError(session)`; setting in the manifest; e2e on a scratch that raises.
**Acceptance**: `agent.py`'s run ends with the band naming `OpenAIError` at line 16 and
one click lands the Time Machine there with `api_key = None` visible.

## 12. LLM calls as values: request and response on the calling line

**Problem.** Stepping into httpx to see what was sent and received is the wrong level.
The user wants `r1 = await Runner.run(...)` to show "sent these messages, got this text".
**Data.** The HTTP capture from item 6 (record mode gives request/response bodies); the
step at which the call happened (the transport wrapper runs while the user's statement is
the current step: `tracer.cur_step`).
**Design.** The http plugin, in record and off modes alike, emits a `log` event of a new
kind `http` at the current step: `context` = `POST /chat/completions` (host stripped),
`text` = one line (`200 · 1.9 s · 412 tokens` when the response JSON has `usage`),
`valueBag` = `{request: {url, method, json|text}, response: {status, json|text}}`
bounded by the log limits, secrets masked. Streamed responses are assembled. The panel
shows these entries like values; hover on the calling line lists them.
**Steps.** Depends on item 6's transport wrapper; a `kind: "http"` in `LOG_KINDS` and
`protocol.ts`; an icon in the entries list; tests with a fake transport; e2e with the local
`http.server` fixture.
**Acceptance**: the cookbook run shows one `http` entry per turn on the `Runner.run` line
with the model's reply in the response value.

## 13. Tool-call trace for agent frameworks

**Problem.** With the OpenAI Agents SDK (and similar), what matters is which tools the
model invoked, with what arguments and results, not the SDK's internals.
**Data.** Two sources: the SDK's own objects (`RunResult.new_items`, `raw_responses`,
tool call items) visible as values when the result is logged; and the http entries of
item 11 (the request body carries `tools`, the response carries `tool_calls`).
**Design.** A "TOOL CALLS" section per step in the Details pane and `pyokka tools
run.json`: one row per tool call (name, arguments, result text, which turn/step),
extracted by adapters per framework (`openai-agents`, `openai` responses/chat, `anthropic`)
from the recorded values, with a generic fallback that scans response JSON for
`tool_calls`/`function_call`. Adapters live in the runtime (`agent/adapters/`) so the CLI
and the panel share them.
**Steps.** Depends on 11; adapters with unit tests on recorded JSON fixtures; panel
section; CLI.
**Acceptance**: the cookbook's turn 3 shows `save_memory_note` with its arguments.

## 14. Side-effect audit

**Problem.** Before re-running generated code the user wants to know what it touches:
files, subprocesses, network, environment.
**Data.** Not recorded today. Wrap at run start (tracer install): `builtins.open`,
`os.open`, `pathlib.Path.open/write_*`, `subprocess.Popen`, `socket.socket.connect`,
`os.environ.__getitem__/get`, `shutil.*`, `os.remove/rename/mkdir`, recording (kind,
target, mode, step, rid). Bounded (first 500 events, then counts).
**Design.** A `sideEffects` event at the end (and streamed as `log` kind `effect` at the
step) and a "SIDE EFFECTS" report: files read / written / deleted, processes spawned
(argv), hosts connected (host:port, count), env vars read (names only, values never), each
with the first step. `pyokka effects run.json`. Panel section with click-to-step.
**Steps.** Runtime wrappers in a new `effects.py` mixin (careful with recursion: the
tracer's own file writes must bypass); protocol; report builders; tests (a scratch that
writes a temp file and reads an env var); CLI; panel.
**Acceptance**: `run.py` reports `.env` read by `load_dotenv`, `openrouter.ai:443`
connected N times, no files written.

## 15. Diff two runs

**Problem.** After a generated change, "what actually differed" is the review question.
**Data.** Two saved runs (or the previous and current session states: `Session.previous`
is kept for re-anchoring).
**Design.** `pyokka diff a.json b.json` and a "Compare with previous run" command: align
statements by file and rid via the source hashes in `meta` (same file) or by line text
(changed file), then report per statement: value changed (old → new, first hit), hits
changed, newly run / no longer run, exceptions added or gone, output diff, step counts.
Rendered as the existing Compare pane (two Monaco columns) for values, plus a summary
list.
**Steps.** Alignment (pure, tests with an edited fixture); report; CLI; command + pane.
**Acceptance**: change a constant in `example.py`, run, compare: the changed values are
listed and nothing else.

## 16. The call graph that ran

**Absorbed by item 7 (2026-09-11)**: `pyokka graph run.json [--dot]` and the Execution Diagram
view are this graph (caller → callee edges with counts and steps, packages collapsed). No
`callRid` in the tracer: the call site is the caller's step before the entry, as the walkthrough
computes it.

**Problem.** Generated code's structure is easiest to grasp as who-called-whom, with
counts, from the run rather than from static analysis.
**Data.** Scopes and their parents (`rid` of the callee, parent scope's current rid at
entry is the call site: record `callRid` on scope entry in the tracer, one int).
**Design.** Edges (caller function → callee function) with counts and total time (item
9's timestamps), rendered with the existing Diagram pane (it draws value graphs; reuse
its layout) and as `pyokka graph run.json --dot`. User code by default; library packages
as collapsed nodes.
**Steps.** Tracer `callRid`; builder; Diagram reuse; CLI; tests.
**Acceptance**: `example.py` shows `<module> → Account.__init__ ×2`, `<module> →
withdraw ×1`.

## 17. asyncio task swimlanes

**Problem.** One linear strip hides concurrency; interleaved tasks read as noise.
**Data.** After item 1, each task's root scope has parent 0; add `taskId` to scope entries
(`id(asyncio.current_task())` when a loop runs, else 0) in the tracer.
**Design.** A lanes mode of the timeline strip: one lane per task in first-seen order,
the module lane on top, steps placed by index; the current step highlighted across lanes;
Step Over stays within the lane (item 1's scope-based moves already do). `pyokka steps
--task N`.
**Steps.** Protocol `scopes[].task`; timeline model; strip rendering (webview test via
`timeline.test.ts`); CLI filter.
**Acceptance**: `aio.py` shows three lanes after `gather`.

## 18. Time per await and per step

**Problem.** Slow steps of a pipeline (the LLM calls) are invisible; `# ?.` timing is
manual.
**Data.** Per-step timestamps are not recorded; add `t` (ms since run start, float32)
per step as a fifth quad element behind a flag `recordTimes` (default on: 4 bytes per
step), or per scope entry/exit (item 9) if the per-step cost shows in `test_perf.py`.
**Design.** The timeline strip shades steps by duration to the next step; hover shows it;
Code Story annotates lines that took more than 100 ms; `pyokka slow run.json` lists the
top 20 gaps with the statement (an `await` on a network call dominates).
**Steps.** Tracer + protocol (quads become quints, or a parallel array `times` in the
trace event to keep quads stable: prefer the parallel array); host decoding; strip; CLI.
**Acceptance**: the cookbook run's top gaps are the five `Runner.run` awaits.

## 19. Run cost estimate and a confirmation for Automatic mode

**Problem.** A run that calls an API costs money; Automatic mode re-runs on hover.
**Data.** The previous run's duration, http entries (item 11) or connected hosts (item
13), and `run.finished`.
**Design.** Status bar tooltip and the Run button show "last run 41 s, 5 network calls";
switching a session to Automatic, or hovering in Automatic, when the last run made network
calls asks once per session ("This file called openrouter.ai 5 times last run; Automatic
mode re-runs on hover. Continue?"). Setting `pyokka.confirmNetworkReruns` (default true).
**Steps.** Session keeps `lastRunStats`; the guard in `scheduleImplicitRun`; status bar;
rendered/unit tests; e2e with the local server fixture.
**Acceptance**: after a cookbook run, choosing Automatic prompts; `demo.py` never does.

## 20. Run until here

**Problem.** Files with an expensive tail: the user wants everything up to a line
recorded without paying for the rest.
**Data.** A run request already carries markers; add `stopAt: {file, line}`.
**Design.** The instrumenter inserts a `_pk_stop(rid)` hook before the statement at the
line (main file only); the tracer raises a private `PyokkaStop` there, caught in
`execute.run` as a clean end (`run.finished.stoppedAt`); values, coverage and trace are
complete up to that point. Command "Run to Cursor" (Ctrl+F10 while not navigating is
taken; use the editor context menu and a command), gutter decoration on the stop line,
cleared on the next full run.
**Steps.** Protocol; rewrite + tracer + execute; host command; e2e on `demo.py`.
**Acceptance**: "Run to line 20" of `agent.py` records the imports and the class and
never constructs the client.

## 21. Per-project defaults in `[tool.pyokka]`

**Problem.** Run mode, timeout, library packages and http mode are per project, and the
merge already reads `pyproject.toml [tool.pyokka]` but nothing writes it and the docs
do not say which keys work.
**Design.** Document the table (`runMode`, `runTimeout`, `libraryCode`, `libraryPackages`,
`http`, `recordLocals`, `plugins`, `env`); a command "Pyokka: Write Project Defaults"
that writes the current session's settings into `[tool.pyokka]` (creating the table,
preserving the rest of the file with the existing TOML reader plus a minimal writer that
only appends or replaces that table); the Settings view's save button offers "for this
project" next to "for new files".
**Steps.** TOML table writer with tests (round-trips on the example `pyproject.toml`);
command; Settings view button; README.
**Acceptance**: the example project gets `runMode = "onDemand"` and `runTimeout = 0`
and new sessions pick them up.

## 22. Secret exposure report

**Problem.** Masking exists (provenance-based in the run child, pattern-based on the way
out); the user cannot see where secrets went.
**Data.** The masking module knows every value it masked (rid, step, name, kind of
secret); the http plugin knows which requests carried them in headers.
**Design.** `pyokka secrets run.json` and a "SECRETS" report: each masked value's origin
(env var name, `.env` key), the statements where it flowed (assignments, call arguments),
and the hosts it was sent to. Names and hosts only, never the values.
**Steps.** The masking mixin records origins and flows (it already tags provenance);
report builders; CLI; panel section; tests.
**Acceptance**: the cookbook run shows `OPENROUTER_API_KEY` → `client` → `openrouter.ai`.

## 23. Assertions from a run

**Problem.** Generated code has no tests; the recording knows the real inputs and outputs.
**Data.** Item 9's parameters and return values per call (needs Auto Log or `def`
logpoints, or locals recording) and the values of module-level names.
**Design.** "Generate test from run" on a function: writes `test_<file>.py` with one test
per distinct (arguments → return) pair seen, using `repr` of the recorded values when
they round-trip (`ast.literal_eval` succeeds), else `pytest.approx` for floats and a
`TODO` comment for objects. `pyokka tests run.json --function NAME`.
**Steps.** Generator (Python, in the runtime, unit-tested on `example.py`'s `withdraw`);
host command that runs it and opens the file.
**Acceptance**: `withdraw` yields `assert Account("ivor", 85.5).withdraw(30) == 55.5`.

## 24. Annotated source copy

**Problem.** Reading offline, or in a review, with the run's facts inline.
**Design.** "Export annotated copy": the file with a trailing comment per statement that
ran (`# → 55.5`, `# ×3`, `# never ran`, `# raised OpenAIError`), values truncated to 60
chars, written next to the file as `<name>.annotated.py` (never overwriting the source),
or as Markdown with the story. `pyokka annotate run.json FILE`.
**Steps.** Builder from coverage + values + errors (pure, tests); CLI; command.
**Acceptance**: `example.py.annotated.py` reads correctly and `python -c "import ast;
ast.parse(open(...).read())"` succeeds.

## 25. Hover on pure calls, with an allowlist

**Problem.** `evaluate` refuses calls, so hovering `len(items)` or `obj.name.upper()`
shows nothing in On Save mode.
**Design.** Allow calls whose callee resolves to a builtin from a fixed pure set (`len`,
`str`, `int`, `repr`, `sorted`, `min`, `max`, `sum`, `type`, `isinstance`), `str`/`bytes`/
`dict`/`list` methods that do not mutate, and names listed in a per-project allowlist
(`[tool.pyokka] pureCalls = ["mymodule.fmt"]`). Everything else stays refused; a hover
on a refused call says why and offers "add to allowlist".
**Steps.** `Tracer._check_side_effect_free` gets the allowlist; tests; settings plumbing;
hover message.
**Acceptance**: hovering `len(user_state.session_memory)` shows the count without a run.

## 26. Values as of this step

**Status (2026-09-12): built** on branch `worktree-values-as-of-step`, the rule first
(`src/session/valuesAsOf.ts`: `entriesAsOf` / `entryAsOf` / `finalEntry`, `inlineTextFor`
moved there from the decorator unchanged, `asOfFooter`; `test/unit/valuesAsOf.test.ts`
renders the decoration text at each step of a loop), then three subagents on disjoint
files. Decorator (`decorator.ts`): `dimOthers` paints the current step's values in full
and, dimmed, each other statement's last entry at or before the step; a statement that
has not run yet as of the step shows nothing (an uncaught error included; `≈` shadow
values of edited lines no longer show dimmed while navigating either); the item hover
carries the footer; `api.inlineValues(editor)` returns what an editor paints (the e2e
reads it, the editor API cannot). Value Peek (`valuePeek.ts`): the entry as of the step
instead of an evaluation, the footer, "not run yet as of step N; final: …" without a
value before the first hit; an expression that was never logged is still evaluated
(Automatic: a fresh run, whose transient marker yields its first hit; otherwise the live
child's final value) and the hover says in both cases that it is not this step's value.
`examples/demo.py` gained a three-pass loop after the prints (`total = 0` on line 97,
`total += n` on 99, the `raise` moved to 105; nothing above the section shifted, the other
suites hard-code those lines); `test/e2e/values-as-of.test.js` finds its lines by text,
steps through the loop, reads what the editor paints through `api.inlineValues` and the
hovers with `vscode.executeHoverProvider`, and reads the final values right after the stop
command, before the Auto Log re-run that the stop schedules swaps in an empty state. Departures from the text below: the rule
lives in `src/session/valuesAsOf.ts`, not `liveValues.ts` (that file holds the Show Value
commands; the inline rendering is the decorator's); `all` mode is untouched; locals
snapshots were not needed (log entries carry the step). Not done: the Code Story's
per-line values, the snaps output and the panel's entries list still show the run's last
hit.

**Problem.** While navigating, inline values show the last hit; hovers show the final
state. Both mislead inside loops and after mutations.
**Data.** Log entries carry `step`; locals snapshots (when recorded) are per step.
**Design.** While the Time Machine is active, inline values show the entry whose step is
the last ≤ current step (already partly there for dimming: make the value text follow),
and hovers show that entry instead of evaluating; a hover footer says "as of step N;
final: …" with the final value when it differs.
**Steps.** `liveValues.ts` selection rule; hover provider; rendered tests of the
decoration text (unit) and an e2e on `demo.py`'s loop.
**Acceptance**: stepping through a loop shows the loop variable's value at each step.

## 27. Snapshot a value as a Python literal

**Design.** "Copy as Python" on any entry or hover value: the serialised node rendered as
a literal (`{'a': [1, 2]}`), objects as `Type(attr=…)` comments, bounded by the expand
limits (offer to expand first). Uses the value node tree, no re-run.
**Steps.** Renderer (pure, tests), context-menu entry in the panel and hover.
**Acceptance**: copying `user_state.session_memory` gives a literal that `ast.literal_eval`
accepts.

## 28. Watch history across runs

**Design.** Watches keep the last 10 results per run (`runId`, `text`) in the session's
watch entries; the Watches pane shows a small history strip (▁▃▅ for numbers, `≠` when
the text changed) and a diff on click.
**Steps.** Session stores history on `runFinished`; webview rendering (test); no runtime
change.
**Acceptance**: a watch on `total` in `example.py` shows its previous values after edits.

## 29. Run a function with recorded arguments

**Design.** A gutter action on a `def` that ran: "Run `withdraw(30)` again" opens a
scratch that imports the module and calls the function with the recorded arguments as
literals (from item 22's renderer), in a new Pyokka session, so the user can iterate on
one function without the whole file.
**Steps.** Depends on 9 (arguments) and 26 (literals); code lens; scratch generation.
**Acceptance**: the scratch runs and shows `55.5`.

## 30. Cells in a plain file

**Problem.** Re-running a whole file to change one part; snaps (`"""{{ … }}"""`) are the
seed.
**Design.** `# %%` cell markers (the convention Jupyter and VS Code already use): a run in
"cell" mode executes cells in order, records each cell's step range, and a change inside
one cell re-executes from that cell onward using the finished process's namespace
(`exec` in the kept module dict) instead of a full re-run; earlier cells' values stay.
Only when the session runs in-process-kept mode (the finished child is alive already).
**Steps.** Protocol `run {mode: "cells", fromCell}`; child support in `execute` (re-exec a
code range in the existing module); host dirty-cell detection; UI: cell separators in the
gutter and "run from here".
**Acceptance**: editing the last cell of a 3-cell file re-runs only it and keeps the
earlier values.

## 31. Export a run as self-contained HTML

**Design.** `pyokka export run.json --html out.html`: the story with values, coverage
colours, the exceptions report and the summary, one file, no JS dependencies beyond
inline, redacted. "Export Run…" command in the panel's More menu.
**Steps.** Renderer in the runtime (string templates, tests), command.
**Acceptance**: the file opens in a browser and every step number links within the page.

## 32. Attach a recording to a PR

**Design.** On top of 30 and the saved run: `pyokka export --pr` writes the HTML plus a
Markdown comment with the summary and links `step N` → `#step-N` anchors; a `gh pr comment
--body-file` example in the docs. No GitHub integration in the extension.
**Acceptance**: the comment renders the summary and the anchors resolve.

## 33. Several agents on one live session

**Design.** The bridge already accepts many clients; add `who: "claude-code"` on the token
line, log it, show the last mover's name in the Time Machine toolbar ("moved by
claude-code"), and stream `{"event":"step", "by": …}` so agents can ignore their own
moves.
**Steps.** Bridge + CLI `--who` + toolbar chip (rendered test) + e2e with two clients.

## 34. pytest integration

**Design.** `pyokka pytest tests/test_x.py::test_y` runs pytest in the runtime child with
the test file as the main file (pytest invoked via `pytest.main` inside the instrumented
process; the test module and the code under test are project files and get instrumented),
records the run, and opens the Time Machine at the failing assertion (the uncaught
`AssertionError` step). Extension: a code lens "Run under Pyokka" on test functions.
**Steps.** Runtime entry point; test discovery of the failing step; code lens; e2e with
a small test file.
**Acceptance**: a failing test lands on its `assert` line with the compared values.

## 35. Notebook support

**Design.** For `.ipynb`, concatenate code cells with `# %%` markers into a virtual file
(cell boundaries recorded), run it with item 29's cell mode, and map values and steps
back to cells (VS Code notebook cell URIs). Later; depends on 29.

## 36. PyPI release of the runtime and CLI

**Design.** Bump `__version__`, `uv build` in `python/`, publish `pyokka` (runtime + CLI)
so `uvx pyokka run file.py --save` works without the extension; the extension keeps
shipping its own copy and the `hello` handshake already reports the runtime version.
**Steps.** Version, changelog, `uv publish`, README install section, a smoke test in CI.

## 37. Windows

**Design.** The bridge and the keeper use Unix sockets; on Windows use named pipes
(`\\.\pipe\pyokka-<pid>-<n>`; Node `net` and Python `multiprocessing.connection` both
support them). The runtime's spawn mode already exists (`PYOKKA_SPAWN=1`). Untested
overall: run the suites on a Windows machine first.

## 38. MCP server mirroring the CLI

**Design.** Once the CLI has shown which commands agents use, a stdio MCP server with
those (five, not twenty), stdlib JSON-RPC, registered by the extension through
`vscode.lm.registerMcpServerDefinitionProvider`; the tool descriptions come from the
CLI's help text so the two stay in sync.

---

## Also open (carried over)

- Decision: quiet library calls made while a class body is being defined (pydantic
  metaclass work makes `agent.py`'s call line step 2111 with all packages on).
- `story --live` / `find --live` refused; either a `trace` bridge request returning the
  saved-run shape, or keep the hint.
- The live acceptance demo (Claude Code sidebar narrating while the editor follows) has
  not been run by a person; `cli-live.test.js` proves the mechanics.
- `uvx --from ./python pyokka` caches the path package by version: bump `__version__`
  before publishing or use `--no-cache`.
- `tracer.py` is over the 500-line ceiling (567). (The uncaught exception used to be emitted
  twice, `handled: true` from the function's `finally` then `handled: false`; item 5 fixed
  it, and `agent/context.py` and `agent/moments.py` still dedupe for the twin, harmlessly.)
- Library stepping remainder: `imports` run event + quick pick to fill `libraryPackages`;
  a "trace truncated" indicator; a UI-pass capture with library code on; `Tracer.step_for`
  scans 5000 steps back for a rid that never stepped; the cache has no size bound, only a
  30-day sweep. Performance (warm cache): off 0.6 s; `["openai"]` 0.7 s; all packages
  0.8 s, 2.5 s cold.
- Publisher id, icon, repository field; a `CLAUDE.md` with the Commands and Quirks.
