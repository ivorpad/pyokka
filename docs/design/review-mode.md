# Review mode: `pyokka review` and the `pyokka_review` MCP tool (contract, 2026-10-16)

A code review as a guided debug session: the person reads the change while the agent steps and
explains, the person asks, and the two reach conclusions together. The tool owns the sequence so an
agent cannot run the agenda alone, pause off-plan, or hand in a finding without evidence; the report
is the record of what was concluded, not the goal. One mode for every surface: the browser page, a
VS Code session, or chat alone. This document is the contract four implementation
streams build to; names and fields here are fixed, internals are not.

## Why a state machine

A skill text is feedforward and fades with every tool result. The review's contract lives in the
tool's refusals: each action is allowed only in its phase, required fields are required by the
schema, an explanation at a stop must name a value the tool knows is there, a finding needs a step
and a reproduction, and the report re-runs every reproduction before it prints. Every result starts
with one header line and ends with one `next:` line, so the agent is steered at the moment it
matters.

## Files and state

`--dir DIR` names the review directory; the default is `$PYOKKA_HOME/reviews/<repo-name>-<base7>/`.
It holds `review.json` (the state), `base/` (the base tree, from `git worktree add`, falling back to
`git archive`), `base.json` and `head.json` (the recordings), `tries/<id>.json`, `fixed/` (a copy of
head with the patch applied), `report.md`. Nothing is ever written inside the repository. The MCP
tool keeps the current review in `$PYOKKA_HOME/reviews/current` so `dir` can be omitted after
`start`.

`review.json`: `{id, repo, base, head, entry, test, dir, created, phase, tree_hash, plan: {stops: [...],
unreached: [...], edges: [...]}, shown: [n...], asked: [...], tries: [...], findings: [...], fix: {...},
summary: {...}}`.

## Actions (CLI words; MCP: `pyokka_review` with `action` and the same names as fields)

### `start --base REF [--repo DIR] [--entry FILE | --test NODEID] [--pr FILE] [--python P] [--dir DIR] [-- ARGS]`

1. Resolve REF in the repo (default cwd). Head is the working tree as it stands, uncommitted
   changes and the entry included (until 2026-10-19 an uncommitted entry was refused; nothing
   needed it committed: head records the working tree, `fix` copies it, `tree_hash` pins it).
   Materialise the base tree in `DIR/base`.
2. Record head: the entry file (default `main.py` at the repo root when it exists, else required) through
   the recorder as `pyokka run ENTRY --cwd REPO --save DIR/head.json` would; `--test` runs one test.
   Record base the same way from `DIR/base`.
3. Compare: `diff` of the two runs (every statement, no limit), `exceptions` of both, `coverage` of
   head joined to the diff's added lines, and the PR text (`--pr FILE`, default `pr.md` or the
   commit messages base..head) for the functions and files it names.
4. Sweep: ranked anomalies over every step, one line each (the rules of `harness/sweep.py` in the
   ablation scratchpad, ported): `raise` (raised or caught only in head), `type` (a value's runtime
   type changed, also across edited statements by name), `sign` (same magnitude, opposite sign),
   `none` (None, nan or inf appearing), `unreached` (changed lines never run, as spans, not in
   tests), `partial`, `branch`/`loop` (changed or only-in-head, in functions the PR text does not
   name, grouped per statement with a hit count), `value` (differs in an unnamed function), `print`.
5. Edges: candidates from the added lines (the rules of `harness/edges.py`, ported): comparison
   boundaries, missing keys, except paths with their fallback, new parameters, empty loops, zero
   divisors, slice bounds, orderings, attributes no class in the project defines (not method calls,
   not imported modules, not test files). `E1..En`, each with what to try.
6. Plan: `stops` = anomalies that have a head step (raise, type, sign, none, print, value), one per
   statement, in rank order, numbered 1..N with `{n, kind, file, line, function, fact, step_a, step_b}`;
   `unreached` and `edges` listed beside them.
7. Hash the repo tree (`git rev-parse HEAD` plus a hash of `git status --porcelain` and the diff of
   the working tree) into `tree_hash`. Write `review.json`. Phase becomes `stops`.

Output: header; one paragraph of what changed in behaviour (statement counts, raises, types, signs,
prints, exit codes); the stops list; the unreached lines; the edge candidates; `next: review stop 1
--say TEXT`.

### `stop N --say TEXT [--go-on] [--surface auto|page|vscode|chat] [--port P] [--session NAME]`

One stop per call. After a stop was shown, the next `stop` is refused unless it carries `--go-on`
(MCP `go_on: true`): "the person has not spoken since stop N; pass --go-on only after they said next,
or answer them with ask/try/look". `ask` never needs it. Any unshown N may be asked for: the plan is
an agenda the person reorders. The result's last line after a stop is `next: wait for the person;
when they say next, review stop N+1 --say TEXT --go-on`.

Refuse: no plan (`next: review start`), N not in the plan (list the plan; `ask FILE:LINE` for an
unplanned line), empty `--say`, or a `--say` that names none of the stop's values. A value is named
when the text contains the rendered text of one of the stop's locals at `step_b` (string containment,
whitespace-insensitive, quotes optional), the fact's `a` or `b` text, or the step number. The
refusal lists the values of the stop so the next attempt can name one.

Move the person's view (`--surface auto` picks the first that answers): page (a bridge answers on
`--port`, default `$PYOKKA_PORT` or 4777, and its file is the review's entry): `goto step_b` with
`say`; VS Code: a live debug session → `break FILE:LINE --when COND` then `continue`, where COND is
synthesised from up to two locals of the stop whose text is a literal (`name == <text>`), none when
there is none; a live recording session → `step --live --to step_b`; chat: nothing moves. Print the header first, as on every result, then the stop as `pyokka
context head.json step_b` prints it, then the `say` text, then `next:` (wait for the person; the next
unshown stop with `--go-on` once they said next, else `finding add`).

### `ask FILE:LINE --say TEXT`

An unplanned stop at the first head step on that line (the person's question), validated and moved
like `stop`, recorded under `asked`. Its `next:` is `wait for the person`.

### `skip N --why TEXT`

Marks agenda item N skipped with the reason; `state` lists shown, skipped and remaining.

### `look --expr EXPR [--step N]`

Answers "what is X here" without moving anything: a pure expression evaluated against `head.json`
at the current or given step through the `eval` code path when the run can answer from recorded
values, else the recorded locals the expression names. Its `next:` is `wait for the person`.

### `try --code FILE | --expr EXPR [--inputs FILE] [--mocks FILE] [--edge E3] [--title T]`

A reproduction in the Scratchpad's sandbox (`pyokka_runtime/scratchpad.py`: a separate `python -I`
with the head tree on `sys.path`, network denied on macOS, 5 s). When a page is open on the review's
entry, run it as the page's Scratchpad experiment so the person sees it; else headless. Store
`tries/<id>.json` with code, inputs, mocks, result, output, error, the edge id; print them and the
id. `--edge` marks the edge candidate tried.

### `finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD [--expect TEXT] --fix TEXT`

Refuse without `--step` or `--repro`. `--step` must be a step of `head.json` whose file is F
(basename match) and whose line is within 3 of L or inside the same function. `--repro` is a try id,
or a shell command run from the repo root whose output must contain `--expect` (required for a
command). Store; print the finding and the header.

### `fix --patch FILE.diff [--tests CMD]`

Apply the unified diff to `DIR/fixed` (a fresh copy of head; refuse if a hunk fails), run `CMD`
there when given, record `fixed/ENTRY` to `DIR/fixed.json`, print the test result, the `diff`
summary head → fixed, and for each finding whose `--expect` is a `NAME=VALUE`, PASS or FAIL as
`verify` prints them.

### `report [--out FILE] [--page [FILE]]`

`--page` (2026-10-16): the review as a code-history page, `history.json` for the skill's
`render-code-history.cjs`, written at FILE or `DIR/page.json` and refused inside the repository.
One recorded-step checkpoint of head.json per stop shown or line asked, in conversation order, plus a
`why` checkpoint for a stop whose fact names a value; the say is the card's text, the fact with base's
value beside head's starts its note, the `look`s that followed it finish the note, a finding within
three lines sets its tag; the tries follow as `try` cards (a fifth evidence kind: a sandbox run with
its code as the pseudo-file `tries/<id>.py`). The sentence rules run over every field and come back
as warnings.

`--tour` (2026-10-16): the review as a tour of head.json for `render-tour.cjs`, written at FILE or
`DIR/tour.json`. `build_tour(force=<the steps of the stops shown and lines asked>)` guarantees a
candidate per stop (`pyokka tour --at STEP`); the says are the prose, `pick` in run order, the title
the stop's kind and function. `apply_prose` checks the says as it checks a model's prose; a rejected
say falls back to base's value beside head's, then to nothing, each rejection a warning.


Refuse when the repo's `tree_hash` differs from `start` (the review no longer describes the tree),
when a finding lacks a reproduction, or when a reproduction no longer reproduces (re-run each try or
command and compare). Print markdown: "What we looked at together" (the stops shown and asked, in order, each with its
`say`), what the change does in behaviour, findings by severity (file:line,
step, values, how reproduced, fix, fix status from `fix`), stops shown and asked, edge candidates
tried with results and skipped, unreached changed lines not tried, what was not verified. Write it to
`--out` or `DIR/report.md`.

### `state`

The header, the plan with shown stops marked, findings, tries, and `next:`.

## Header and `next:`

Every result's first line: `review <id> · <phase> · stops K/N shown · findings F · tries T`. Every
result's last line: `next: <one command>`.

## MCP

`pyokka_review`: `action` (enum of the words above, including `skip` and `look`), then the fields
with the CLI's names (`base`, `repo`, `entry`, `test`, `pr`, `python`, `dir`, `n`, `say`, `go_on`,
`why`, `surface`, `port`, `session`, `line` (FILE:LINE for ask), `code`, `expr`, `inputs`, `mocks`,
`edge`, `title`, `file`, `severity`, `step`, `repro`, `expect`, `fix`, `patch`, `tests`, `out`). Required by the schema: `action`; `say` for
`stop` and `ask`; `step` and `repro` for `finding`. A refusal is `isError` with the same text the CLI
prints. The server also answers `prompts/list` with one prompt, `review` (the method in about fifteen
lines, from `skills/pyokka/references/review.md`'s first section), and `prompts/get`.

## Streams

- **A1 state machine and wiring:** `python/pyokka_runtime/agent/review/` (`__init__.py`, `state.py`,
  `actions.py`, `render.py`), the `review` subparser in `agent/shell.py`, `pyokka_review` in
  `agent/mcp_tools.py` and `agent/mcp.py`, `prompts/list` and `prompts/get` in `agent/mcp.py`,
  tests in `python/tests/test_review_*.py`. Imports `plan.build_plan` and `surfaces.move_to` from A2.
- **A2 plan and surfaces:** `agent/review/sweep.py`, `agent/review/edges.py`, `agent/review/plan.py`
  (`build_plan(base_run, head_run, diff_json, exceptions_a, exceptions_b, coverage_b, diff_text,
  pr_text, repo) -> dict`), `agent/review/surfaces.py` (`detect(port, session) -> str`,
  `move_to(stop, say, surface, port, session, head_json) -> dict`), `agent/review/tryrun.py`
  (`run_try(code, inputs, mocks, repo, page_port) -> dict`), tests beside them.
- **B fixes:** `verify` prints `PASS`/`FAIL` (or `no expectations given; the runs differ in N
  statements`) even without `--expect`; `break --remove FILE:LINE` removes a breakpoint that was
  resolved to another line when FILE:LINE is the line asked for; `origin` accepts attribute paths
  (`lines[0].unit_price`) when the recorder kept the attribute; tests for each.
- **C text:** `skills/pyokka/references/review.md` (the method, about forty lines, every command named),
  the `review` row and description in `skills/pyokka/SKILL.md`, the `pyokka_review` row in
  `references/mcp.md`, the `review` section in `references/pyokka-cli.md`, a README paragraph, and
  CHANGELOG entries under Unreleased.

## Fixtures for tests

The ablation's cases, read-only, at
`<scratchpad>/abl2/cases/{shop,ledger,inventory}/`
(`repo/`, `base/`, `pr.diff`, `shas.txt`, `GROUND_TRUTH.md`, `runs/base.json`, `runs/head.json`,
`runs/sweep.txt`, `runs/edges.txt`). Copy `shop/repo` (without `.git`) and `shop/base` into
`python/tests/fixtures/review/shop_head/` and `shop_base/` for the committed tests; the expected
plan for shop is: a `raise` stop at `shopkit/pricing.py:12` (caught TypeError), a `type` stop at
`shopkit/orders.py:30` (`unit_price` float → str), `shopkit/discounts.py:8` unreached, edge
candidates for `spend > threshold` (boundary) and `settings.platinum_rate` (attribute).

## As built (2026-10-16)

Departures from the contract above, each with its reason, from the implementation streams:

- Refusals print the header first, then `refused: <why>`, details and `next:`, on stderr with exit 2;
  the MCP `isError` text is identical. `stop` prints header, context, say, view line, `next:`.
- The base tree is a `git archive` extraction (a worktree registers itself in the repository's
  `.git` and collides on a second start). The patch applier is pure Python.
- One stop per call: after a shown stop the next `stop` needs `--go-on`; `ask`, `look` and `try`
  never do. `skip N --why`, `look --expr [--step]`. `state` lists shown, skipped, remaining and
  "waiting for the person since stop N". `report` opens with "What we looked at together" (stops,
  asks, skips and looks in order, each with its text) and lists the agenda items not looked at;
  `finding add`, `fix` and `report` work at any time after `start`, and the agenda stays open after
  a report.
- `finding add` may omit `--step` when the line never ran in head (the plan's unreached list, or a
  changed line coverage marks not run) and `--repro` is a try id; the finding records
  `unreached: true` and prints "never ran in head; reproduced by tN". A finding with the same file,
  line and title replaces the earlier one.
- Additions: `args` on start, `--port` on try, `--json` after the action word, `json` on the tool;
  MCP `code` on `try` is the Python text itself (the CLI's `--code` reads a file). The MCP schema
  requires `repro` for finding and lets the action check `step`.
- `ask` on a never-run line inside a function is refused with the function named. The tree hash
  ignores `__pycache__` and `.pyokka` and hashes untracked content. Recordings run with
  `PYTHONDONTWRITEBYTECODE=1`; the Scratchpad child runs with `-B`, so neither leaves bytecode in
  the repository.
- `pyokka_review`'s `next:` lines use the CLI words on both surfaces.
- VS Code sessions are narrowed to the review's entry unless `--session` names one: a session paused
  on another file is never read or moved. The view line of a stop that found no surface names the
  command that opens one (`pyokka debug ENTRY --record --cwd REPO`, `pyokka web ENTRY --cwd REPO`),
  and a debug session that ended before the stop's line says what reaches it (`restart --live
  --stop-on-entry` without a recording; the next `stop` moves the Time Machine with one). The first
  VS Code acceptance run showed the need: told "no live VS Code session; nothing to move", the agent
  reviewed in chat while the person watched an empty editor.
- A hint names only a review command. A review of one `--test` gets no start command at all: a
  VS Code session or a page runs a file as a program and not a test, and a debug session of the test
  is another run, so `start` says it stays in chat whatever surface was asked (and to tell the person
  before the first stop), `stop` and `ask` probe no session or page for it, and an asked `vscode` or
  `page` is refused with `next:` the same stop in chat. For an entry, `review view vscode|page|chat`
  opens the view after `start`, and every hint that used to name `pyokka debug ENTRY --record` or
  `pyokka web ENTRY` names it; the `pyokka_debug` description and the `pyokka_session` notes say the
  review opens and moves its view itself. A recording session on the entry whose step count differs
  from head's is refused before it is moved: the review's step numbers belong to another run. A test
  file as `--entry` is refused with the tests it defines, and a run that recorded no statement (a test
  runner that is not installed) is refused with the runner's words instead of compared. Two field
  reviews showed the need. 2026-10-16: on a test review the refusal's `next:` named `pyokka debug
  tests/test_x.py --record`, the agent recorded the file (217 steps against the review's 507), and the
  stops moved that Time Machine until one fell out of range. 2026-10-17, on 0.5.3: the agent read "a
  review of one test stays in chat" and started a debug session of the test to get the VS Code view
  the person had asked for; `pyokka_debug start` with `test` and no `file` then answered with
  yesterday's finished recording. The agent's part, both times, was to work around a limit the person
  should have been told about; the tool's part was to name the debugger as the way to a view, to
  accept a start with nothing to start, and to compare two empty runs when the test runner was
  missing.
- Measured with Codex (gpt-6.1-sol, medium) as the agent on 2026-10-17, against a VS Code that is
  installed and never answers, with the field prompt "review in vscode HEAD against its prev commit"
  on a tests-only copy of the shop fixture: on the 0.5.3 text, 1 run in 3 started a debug session of
  the test (two calls) and 1 reviewed a test file as a program through `--entry`; on the new text, 0
  of 8 called the debugger, 0 reviewed the file as a program, every final message told the person the
  review stays in chat or asked them to choose, and 2 of 8 showed a stop in chat and waited (3 of
  the 8 ran before the review interpreter had pytest, so their test reviews recorded nothing and the
  agents stopped short; the debugger count is unaffected, the stop count is partly that). On the
  shop fixture with `main.py`, 0 of 3 before and 0 of 3 after started a debug session; all waited for
  the person to accept the VS Code prompt. The control, "pause main.py at subtotal and show me the
  frame", used `pyokka_debug start` in 3 of 3. A plain "review HEAD against HEAD^" asked where to
  watch in 2 of 2, and one went on to a chat review that found the planted `subtotal` bug with a
  reproduction. Runs took 30 to 90 s and 150k to 550k tokens each. The harness: a scratch HOME per
  run with Codex's auth linked, Pyokka as a native MCP server with its tools approved by config, the
  skill copied with implicit invocation allowed (`codex exec` has no `$pyokka` mention), a `code`
  shim that lists the extension and answers nothing else, a venv with pytest as the review
  interpreter, and a scorer over the `--json` events; its scripts were not kept in the repository.

## Before start: understand, ask, plan (contract, 2026-10-19)

The plan `start` builds is an execution diff of one entry: a stop is a head step where one run of
head did something anomalous against one run of base, so the plan is as wide as that run's
footprint. A repository without `main.py` has no program both trees run, which leaves one test as
the only runnable unit, and a changed file the test never imports appears in neither the stops nor
the unreached list (the coverage report lists the files the recording loaded); it survives only as
an edge candidate. On a range of many commits or many files that is omission with no trace of it.
Head is always `HEAD`, so a range A..B needs B checked out. A field review on 2026-10-19 also met
the uncommitted-entry refusal (removed the same day) on in-progress work. The person's statement
of the flow they want: understand the change, ask them what it is for, plan over the whole change,
then go through it with Pyokka in one session or several, their choice. The skill text carries
the first three today; this section is the contract for the tool's part. There is no size
threshold: every review plans, and a small change is a one-item plan and one session.

### The sequence

1. Understand (the agent, no tool): `git diff --stat BASE..HEAD`, `git log --format=%s BASE..HEAD`,
   then the hunks; one paragraph of what the change does, by area.
2. Ask (the agent, the harness's question tool): one call, four questions at most, options drawn
   from the diff. What the change is for and which outcome matters most; a PR text that answers it
   is confirmed in one line, not asked. Which areas first, or left out, the areas of step 1 as the
   options. Where to watch: VS Code, the page or chat. Whether a finding ends the review or a fix in the repository does. Claude Code has
   `AskUserQuestion` (up to four questions, two to four options each); a harness without a
   question tool gets the questions in the conversation and the turn ends there.
3. Plan (`plan`, below): the items and the sessions, from the source diff and the answers. The
   plan is shown with its proposed split, and the person's word on one session or several, and
   how long they have, comes before the first `start`: the turn ends a second time.
4. Sessions (`start --session K`): one recording pair per session through its exerciser, stops
   attached to items, findings and tries shared across sessions.
5. `state` across sessions, `report` over all of them.

### `plan --base REF [--head REF] [--repo DIR] [--pr FILE] [--dir DIR]`

Source diff only, no recording. `--head REF` (new, also on `start`) names a head other than the
working tree; the tool materialises it as it does base, into `DIR/head/`, and the review then
describes that tree and not the checkout. Items are the changed functions of `git diff BASE HEAD`,
grouped by file and by area (the first path component below the repository root), each
`{n, file, function, lines: [[lo, hi], ...], size, edges: [E...], exercisers: [...], rank, session}`.
An exerciser is `{kind: test | program | none, entry, test}`: a test file whose source imports the
item's module or names the function (one `FILE::NAME` per test that names the function, else the
file's first test), `main.py` when it imports the module, else none; an item with none is read and
`try` only, its edges the agenda. Rank: the person's priorities first (the areas they named), then
an except path, a new parameter, a comparison boundary, size. Items that share an exerciser form a
session; an item with none joins the session of its area. `plan` writes `review.json` with `phase:
plan`, `plan.items` and `plan.sessions: [{k, exerciser, items: [n...], status}]`, and `plan.md`,
the items by session, one line each, for the person; `_prepare` keeps a directory that holds a
plan. Output: the header, the paragraph of step 1, the sessions with their items, `next: wait for
the person; then review start --session 1`.

### `start --session K`, and `start` without a plan

`start --session K` records base and head through session K's exerciser into
`DIR/sessions/K/base.json` and `head.json`, compares them as today, and attaches each stop to the
item whose file and lines hold it; a stop outside every item is listed under "outside the plan".
An item of the session with no stop keeps its edges as the agenda. `tries/`, `findings` and
`fixed/` stay at the root, shared. `start` without `--session` on a planned review refuses and
lists the sessions. `start` on a directory with no plan behaves as today: one session and an
implied plan with one item per changed function, so a small change costs no extra call. A second
`start --session K` re-records K and keeps every other session; today a second `start` on the
same base in the same directory removes the first review's recordings, tries and findings
(`_prepare`).

### `state`, `report`, the tree hash

`state` lists the sessions with their items done (a stop shown, an edge tried, or skipped with a
reason) and remaining. `report` covers every session: what we looked at together, in order across
sessions, then the findings, then per session the items not looked at. The tree hash is per
session: a fix in the repository between sessions is allowed, the next `start --session` hashes
the tree it records, and the report names the tree each session ran against. `report` refuses
only a finding without a reproduction or one that no longer reproduces; "the tree changed since
start" becomes a line of the report, not a refusal.

### Until it is built

The skill text says: the plan lives in your message and your scratch directory, never in the
repository or the review directory (a directory with content and no `review.json` is refused by
`start`); one `--dir` per session, since a second `start` on the same base in the same directory
removes the first session's work; `--head` has no equivalent, so a range A..B is reviewed with B
checked out.

### As built the same day: the debugger runs the review

The person's word on 2026-10-19, after the morning's contract: "pyokka review with debug mode is much
better, meaning not full exec", then "we wanted to use pyokka debug as part of it; I don't know why we
have all this separation", and "pyokka review is just a workflow to help me debug or review code". The
separation of 0.5.3 ("a session you start with the debugger is another run, which the review does not
move") protected the recorded review from the debugger; it was never a decision that the debugger
should stay out of reviewing. So the default moved, and the plan phase above stays as written with
one change of meaning for `start`:

- `review start --base REF` (`mode: debugger`) plans from the diff alone, one item per changed
  function (`debugger.plan_items`: hunks grouped by function, a breakpoint at the first statement of
  the first span, a changed `def` header breaking at the body's first statement), and starts the entry
  under the debugger in VS Code through `debug_start.open_debug_session`, stopped on entry, a
  breakpoint per item, the debugger's recording on for a program (a test runs through its runner as a
  module launch, which has no recording). Nothing of base is run or materialised. The page and chat
  need the recording of both trees, so `--surface page|chat` implies `--full`, and `start` without a
  reachable VS Code refuses and names `--full`.
- The debugger is driven as always, through `pyokka_debug` and the `--live` verbs; the review does not
  wrap `continue`, `break` or `eval`. `review stop [N] --say TEXT` reads the pause the session is at
  (`state`), matches it to an item (a pause outside every item, an uncaught exception or the person's
  own breakpoint, becomes an item of kind `pause`), checks the text names a value of the frame's
  locals, records it with those values, and hands the floor to the person; the next `stop` needs
  `--go-on`. `ask` and `look` are refused with the debugger's own commands. `skip` removes the
  breakpoint. `view vscode` starts the program again with the remaining items' breakpoints when the
  run ended or the session is gone; `view page|chat` is refused with `--full`.
- `finding add` takes the pause recorded within three lines of the line (or in the same function) as
  the place, with the values read there; `--step N` is a step of the debugger's recording; a changed
  line the run never paused at, once the program ended, takes a try as its reproduction, as an
  unreached line does. `report --page` and `--tour` save the session's recording as `head.json` first
  and are refused when there is none. `fix` compares against that recording when it exists.
- The first build of the day wrapped `continue`, `break` and `eval` inside `review stop`, `ask` and
  `look` (a two-step stop that continued, then explained); the person saw the duplication and it was
  cut the same afternoon. `--full` keeps the recorded review of 0.5.x unchanged, with its tests.
- Not built: `plan` as an action, `start --session K`, `--head REF`, the per-session tree hash, an
  aggregated `report`. The 0.5.3 rule that the review does not move a debugger session stays true of
  the recorded review only.
