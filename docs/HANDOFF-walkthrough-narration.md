# Handoff: the walkthrough ("what happened, in order") and its narration

Self-contained: a new session executes this file alone, in one run. Read
`docs/HANDOFF.md` first for decisions, commands and quirks (`command cat` /
`command grep`; absolute paths in parallel Bash calls; never read or print the example
project's `.env`; runs of `agent.py` / `run.py` cost tokens, so use `examples/demo.py`,
`python/tests` fixtures or scratches under `$TMPDIR/` for every check).
The preview the user approved on 2026-09-11 is the artifact "run.py Execution Diagram"
: the left column
"What happened, in order" is what this item builds, for real recordings.

## Status (2026-09-11): built

All three deliverables are in: `python/pyokka_runtime/agent/{decisions,walkthrough,moments,
narrate}.py` + `narrate_prompt.md`, `src/session/{decisions,walkthroughShared,moments,
walkthrough}.ts`, `src/agent/narrate.ts`, `src/features/narrator.ts`, the bridge request,
the WALKTHROUGH section (`webview/components/Walkthrough.tsx`), the Code Story block, the
settings `pyokka.explain.command` and `pyokka.story.walkthrough`, the command "Pyokka:
Narrate Walkthrough", tests on both sides against `test/unit/fixtures/walkthrough-*.json`,
`test/e2e/walkthrough.test.js`, and `docs/PROTOCOL.md` ("Walkthrough", "Narration").
Departures from the text below, all deliberate: `elif` headers are their own step in the
recording, so each `if`/`elif` is its own decision moment ("if a took False", "elif b took
True") rather than one chained sentence; loop counts are header hits minus the entry step;
`handledAt` is not recorded by the runtime, so a handled error says where execution
resumed (the step after it); per-return moments (`return` kind) are folded into the call's
`out`; library roots at the same call site merge per package, so a pydantic model class
body still shows as one "call to ModelMetaclass.__prepare__ (pydantic) …" moment anchored
at the previous module step (the class statement is not a step: the open decision from the
main handoff). Not done: nothing from this file; `durationMs` stays null as instructed.

## Objective

A reader of generated code gets a list of moments in execution order, one line each,
with the step number and the values that mattered, derived from the recording. Most of
it is deterministic and instant; a model may add one sentence of gloss per moment, in one
batched call per run, never automatically. The list drives navigation: clicking a moment
moves the Time Machine (host) or prints its context (CLI). Items 2 and 7 of
`docs/HANDOFF-understanding-generated-code.md` depend on this; do not build them here.

## Deliverable 1: deterministic walkthrough (runtime, stdlib, no model)

`pyokka walkthrough run.json [--file F] [--scope NAME] [--from N --to M] [--json]` and
`--live` (through the bridge: needs a new `walkthrough` request, see below).

**Contract** (add to `docs/PROTOCOL.md`, section "Agent access"):

```jsonc
{ "count": 4108, "moments": [
  { "id": "m12", "step": 63, "kind": "call",           // call | return | decision | value | print | tool | http | error | start | end
    "location": { "file": "/abs/run.py", "line": 47, "function": "run_session", "fileId": 1 },
    "text": "call 1 of 4 to Runner.run from run_session",   // deterministic sentence
    "values": [ { "role": "in", "name": "input", "text": "'Book me a flight to Paris next month.'" },
                { "role": "out", "name": "return", "text": "RunResult(final_output=…)" } ],
    "durationMs": 4200, "scopeId": 7, "endStep": 700,
    "gloss": null } ] }                                  // filled by deliverable 3, else null
```

**What becomes a moment**, in step order, from a `SavedRun` (`python/pyokka_runtime/agent/
source.py`) or the live session:
- `start`: step 0, the main file, "module X starts"; `end`: the last step, exit code,
  duration (`meta.durationMs` / `run.finished`).
- `call`: every scope entry (`trace.scopes`, `first` step, `name`, `rid` → location via
  the files table; parent scope → "from <function>"); merge library scopes into one
  moment per user-code call site ("Runner.run, inside openai-agents, 23 nested calls")
  unless `--all`; number repeated calls of the same function from the same site ("call 3
  of 4"). Parameters from `log` entries at the scope's first step (`def` logpoints, Auto
  Log) or from `locals` entries at that step, role `in`; the return value from the
  scope's last logged `Return` (`context` is the returned expression) or the last locals
  change, role `out`; `durationMs` from step timestamps when present (none today: leave
  null; do not add timestamps here).
- `decision`: statements whose AST node is `If`/`While`/`Match`/`IfExp` in user files
  (parse the file once, map statement rids by line through `file.instrumented.ranges`),
  when a step hit them: "if <condition text> took True/False" using the coverage of the
  arms (`states`, first statement of each arm hit or not) and the deciding value when a
  value was logged on that statement; loops: "for x in items ran 4 times".
- `value`: `log` entries of kind `value`/`autoLog` on user statements that are not
  already an `in`/`out` of a call moment, capped at one per statement per moment run.
- `print`: `log` entries of kind `log` (prints), text truncated to 120 chars.
- `tool`: a call moment whose scope name matches a function the run passed as a tool is
  the same as `call`; mark `kind: "tool"` when the caller is library code and the callee
  is user code (the SDK calling back into the program).
- `http`: reserved for the future http plugin; do not implement.
- `error`: `error` events, handled or not: "raised OpenAIError: … (handled at file:line)"
  when `handledAt` exists, else "raised … uncaught".
Bound: 400 moments by default; beyond that, collapse repeated calls from the same site
into one moment with a count, then repeated values; `--from/--to` and `--scope` select a
window without the cap.

**Text rendering** (the CLI): one moment per line, `#step  text`, values indented under
it (`in name = text`, `out …`, `took …`), `≡ 12 more calls like this` for collapsed
groups, ≤ 100 chars per line, `--json` for the raw shape.

**Files**: `python/pyokka_runtime/agent/walkthrough.py` (builder; reuse `Trace.blocks()`,
`context.py`'s `_log_value`, `_local_values`, `block_not_run`, `story()`), the AST
decision map in `python/pyokka_runtime/agent/decisions.py` (pure functions over source
text), `commands.py` for the subcommand and renderer, tests in `python/tests/
test_walkthrough.py` (a fixture program with nested calls, a loop, an `if` taking each
arm, a print, a handled and an uncaught exception, run through the `run` fixture from
`conftest.py`; assert kinds, order, counts, numbering, the cap and the window).

## Deliverable 2: the same walkthrough live, and in the panel

- Bridge request `walkthrough {from?, to?, scope?}` in `src/agent/bridge.ts` returning
  the contract shape from the session's state; builder `src/session/walkthrough.ts`
  (pure; inputs: `TraceModel`, `FileTable`, entries by rid, coverage map, errors, locals,
  a source reader), unit-tested against the same fixture as the Python builder (save the
  fixture run's JSON under `test/unit/fixtures/walkthrough-run.json` with the Python
  side and assert both builders produce the same moments). `pyokka walkthrough --live`
  uses it (`python/pyokka_runtime/agent/live.py`).
- Panel: a "WALKTHROUGH" section in the Output view (`webview/components/`), the list
  from the preview: step, sentence, values; the active moment follows the Time Machine's
  current step (`debugger` message) and clicking a moment posts `debugger.action` /
  `goto` with the step (add a `goto: step` action if missing); dimming of past moments;
  rendered test in `test/unit/webview/chrome.test.tsx`. Code Story gets the same list
  as a fenced block at the top when the setting `pyokka.story.walkthrough` (default false)
  is on.

## Deliverable 3: narration, one batched call, pluggable backend

- Setting `pyokka.explain.command` (string, default empty = auto). Auto order: `claude
  -p --output-format json` if `claude` is on the PATH, else `codex exec` (read its last
  message; check `codex exec --help` for the flag that writes the final message to a
  file, e.g. `-o`, and use it rather than parsing the log), else in VS Code
  `vscode.lm.selectChatModels({ vendor: 'copilot' })`. Verify the two CLIs' flags at
  build time; both are on this machine. No API keys in the extension.
- Prompt (one file, `python/pyokka_runtime/agent/narrate_prompt.md`, shared by the CLI
  and the host): the walkthrough JSON (values masked with `redact.py` / `redact.ts`)
  plus the source of the user functions the moments touch (≤ 200 lines each, user files
  only), the instruction to return a JSON object `{"<moment id>": "<one sentence>"}` for
  every moment, present tense, naming what the code intends ("the API-key guard
  passes"), never inventing values, ≤ 140 chars. Parse strictly; on any failure keep
  `gloss: null` and report the error once.
- CLI: `pyokka narrate run.json [--command "…"]` writes the glosses back into `run.json`
  (`walkthroughGloss: {id: text}` under `meta`) and `walkthrough` shows them when present
  (`text` stays; `gloss` printed after it in the text form). Host: a "Narrate" button on
  the WALKTHROUGH section (never automatic), progress in the status bar, glosses cached
  per `runId` in the session, shown in italics under each sentence.
- Tests: the command runner with a fake `claude`/`codex` script on a temp PATH that
  echoes a canned JSON (Python `tests/test_narrate.py`); host unit test for the parser and
  the cache; no live model calls in tests.

## Acceptance

- `pyokka walkthrough` on a saved run of `examples/demo.py` lists, in order, the prints
  with their text, the `if False` decision as "took False", the calls into `Point` and
  `Rectangle` with their arguments, and the run's end; `--json` validates against the
  contract; `--live` on the same file in the e2e (`test/e2e/walkthrough.test.js`: the
  moment list matches the saved one, clicking a moment in the panel moves the Time
  Machine, `Narrate` with `pyokka.explain.command` pointing at a fake script fills the
  glosses).
- On the `agent.py` saved run (`$TMPDIR/agent-run.json`, or make one:
  `env -u OPENROUTER_API_KEY $P -m pyokka_runtime run …/agent.py --save … --library-code`,
  no network, exit 1): the walkthrough ends with "raised OpenAIError … uncaught" at the
  `OpenAI(...)` moment, and library calls are merged into that one moment unless `--all`.
- `scripts/check.sh` and the whole e2e suite pass; the vsix is rebuilt and installed;
  CHANGELOG has an entry; `docs/PROTOCOL.md` documents the `walkthrough` shape and bridge
  request; the ranked handoff's items 2 and 7 get a line saying this exists.

## Out of scope here

The run summary paragraph (item 2), the execution diagram (item 7), HTTP capture,
per-step timestamps, explain-on-selection. If a step here needs one of those, note it
in the handoff and keep going with `null` fields.
