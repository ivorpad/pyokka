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

1. Resolve REF in the repo (default cwd); refuse a dirty worktree only if `--entry` is uncommitted.
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

### `report [--out FILE]`

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
