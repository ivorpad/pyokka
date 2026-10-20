# The `pyokka` CLI over a recording

Every verb takes `RUN` (a `run.json`) or `--live` (an open VS Code session with
`pyokka.agentAccess` on). Every verb takes `--json` for the raw shape; the text form is the one
to read. Errors go to stderr as `error: <what>` plus a line saying what to do next, exit 2; with
`--json` the same thing arrives as `{"ok": false, "error", "hint"}` on stdout.

Bare `pyokka` prints every command, then a first command per job (a saved run, the map, a live
pause, the MCP server), and exits 2; `pyokka --help` (or `-h`) prints the same and exits 0.
`pyokka VERB --help` lists that command's flags. [Every command](#every-command) has one synopsis
per verb.

Contents:

- [Recording a run](#recording-a-run)
- [Mapping a run you do not know](#mapping-a-run-you-do-not-know)
- [Stepping](#stepping)
- [Following a value](#following-a-value)
- [Comparing two runs after an edit](#comparing-two-runs-after-an-edit)
- [Investigating one value](#investigating-one-value)
- [Practicing on a run](#practicing-on-a-run)
- [Baselines and fix checks](#baselines-and-fix-checks)
- [Reviewing a change](#reviewing-a-change)
- [Reports: exceptions, HTTP, graph](#reports-exceptions-http-graph)
- [Tours of a large run](#tours-of-a-large-run)
- [The page](#the-page)
- [The shapes worth knowing](#the-shapes-worth-knowing)
- [The browser page](#the-browser-page)
- [Live only](#live-only)
- [Every command](#every-command)
- [Environment](#environment)

## Recording a run

```
pyokka run FILE [--save RUN.JSON] [--library-code] [--keep] [--no-locals]
                [--http off|record|replay] [--timeout MS] [--watch EXPR] [--auto-log]
                [--max-steps N] [--exclude GLOB]... [--only GLOB]... [--max-value-chars N]
                [--python PATH] [--cwd DIR] [--test NAME] [--mode normal|snaps|profile]
                [--trace-context STEP] [--record-locals] [--instrumented] -- ARGS
```

`--save` is what writes the recording; without it the command prints the event stream.
`--cwd DIR` runs the program in DIR instead of the file's directory, for a script that reads
paths relative to the project root; a DIR that holds the file is also the project root.

- `--library-code` instruments third-party packages too, never the stdlib. Without it `--into` on
  a library call steps over it. Ask for it when the question is what a library did with an
  argument; it is slower and the run is bigger.
- `--keep` leaves the runner alive so `eval` and `expand` can reach the finished values.
  `pyokka release run.json` shuts it down.
- `--no-locals` skips recording locals at every step, which is what `var` and `why` read. Leave
  it on unless the run is enormous.
- `--test NAME` runs one test of a test file under its runner and records only that test's body
  (and the file's top level): `test_b`, `TestCart::test_total` or `test_b[2]` is a pytest node id,
  `Cart.test_total` a unittest name, anything else a pytest `-k` expression. pytest runs with
  `-s --assert=plain -p no:cacheprovider`, so it leaves no `.pytest_cache`; it has to be
  installed in the interpreter that runs the program.
- `--mode profile` runs the file under `cProfile` with no recording and prints `profiled, no steps
  recorded` and `profile: PATH` (a `.cpuprofile`); `--mode snaps` records value snapshots only.
- Without `--save`: `--instrumented` prints the instrumented source instead of running it,
  `--record-locals` records locals in the event stream, and `--trace-context STEP` evaluates the
  `--watch EXPR` expressions from that step on.
- `--http record` writes every HTTP exchange to `.pyokka/replay/<hash>.jsonl` next to the file;
  `--http replay` answers later runs from it, so a program that calls an API runs again with no
  network and no tokens and returns the same values.

```sh
pyokka run demo.py --save run.json
# python: /work/.venv/bin/python 3.12.4 (.venv in /work)
# saved run.json: 243 steps, 1 files, exit 0
```

**Which Python runs the program.** The first match: `--python PATH` (an interpreter, a venv
directory, or a command on PATH such as `python3.12`), `$PYOKKA_PYTHON`, `$VIRTUAL_ENV`, a `.venv` in the file's directory or a parent up to
the git root, else pyokka's own. The runtime goes on that interpreter's `PYTHONPATH`, so the
project's packages import as they do for the program. It needs Python 3.12 or newer and says so by
name when it is older. The first line of `run` names the interpreter and why it was picked; when it
says `pyokka's own` and the program imports the project's packages, pass `--python .venv/bin/python`.

**What the recording leaves out is printed.**

- `--max-steps N` (default 999,999) caps the recorded steps. A run past it prints a `WARNING:
  recording truncated` with the step count it ran, the files that spent the steps and the
  `--exclude` to rerun with. Every verb over that run then starts with one line, and `--json` gets
  `recording: {truncated, cap, kept, stepsRun, spentBy, exclude}`:

  ```sh
  pyokka run main.py --save run.json --max-steps 50
  # python: /work/.venv/bin/python 3.12.4 (.venv in /work)
  # saved run.json: 50 of 410 steps recorded, 3 files, exit 0
  # WARNING: recording truncated at step 50: the program ran 410 steps and only the first 50 are recorded; nothing after step 49 can be read
  #   most steps: pkg/heavy.py 404 · main.py 5
  #   rerun with --exclude pkg/heavy.py (that code then runs unrecorded at full speed), or raise --max-steps (now 50)
  pyokka walkthrough run.json
  # note: truncated recording: steps 0-49 of 410 kept (step cap 50); most steps in pkg/heavy.py 404 · main.py 5; rerun with --exclude pkg/heavy.py
  ```

  When a run says truncated, rerun it with the `--exclude` it names before reading it: the steps
  after the cap, often the part you were asked about, are not in the recording.
- `--exclude GLOB` (repeatable) leaves code out: a dotted module (`pageindex.flash` covers
  `pageindex.flash.*`), a path glob relative to the file's directory (`pageindex/flash`,
  `*/parser.py`), or a bare file or directory name. Excluded code runs at full speed and records no
  steps, values or coverage; calls into it show as calls whose body left no steps.
  `--only GLOB` (repeatable) records just the matching modules, library ones included without
  `--library-code`; the program file is always recorded and `--exclude` wins over `--only`.
- `--max-value-chars N` is how much of one value a recording keeps (default 120 characters for a
  local, 200 for a logged value; `0` keeps the whole value up to a ceiling of 1,000,000 characters,
  which bounds what one value costs in memory and in `run.json`). A cut value ends in
  `…(+N chars)`, N being what the full value had beyond the shown text, or `…(cut)` when its length
  is unknown (an object whose repr is not a builtin's). The verbs' own line cuts add up the same
  way, and `--json` gives the whole recorded text with `truncated: true, length: N`. When a value
  you need ends in `…(+N chars)`, rerun with `--max-value-chars 0` and read it with `--json`:

  ```sh
  pyokka var run.json prompt           # prompt = "x" * 10000
  #   #2 main.py:3  <module>  prompt = 'xxxxxxxxx...xxxxxxxxx'…(+9,882 chars)
  pyokka var run.json prompt --json    # "truncated": true, "length": 10002 (the repr, quotes included)
  pyokka run main.py --save run.json --max-value-chars 0
  pyokka var run.json prompt --json    # changes[0].text is the whole repr
  ```

## Mapping a run you do not know

Read these for yourself. They exist to give you step numbers.

**`walkthrough RUN [--file F | --scope NAME | --from N --to M] [--all]`** is the fastest map:
the module start, every call with its arguments and result, every branch with the arm it took,
loops with their counts, prints, exceptions with where they were handled, and the exit. Library
calls are merged to one line per call site; `--all` unrolls each. 400 moments at most.

```sh
pyokka walkthrough run.json
# #45  call to rrf from main
# #48  for ranking_name, ranking in rankings.items() ran 2 times
# #53  call 1 of 8 to reciprocal_rank from rrf
#         in rank = 1
#         in k = 60
```

JSON: `{count, total, moments: [{kind, step, location, text, values, count?, callee?, entryStep?, endStep?, callerScopeId?, gloss}]}`.
`kind` is `start`, `call`, `tool`, `decision`, `print`, `value`, `error` or `end`. A `tool` is a
function of the program called back by a library (a LangGraph node, an agents SDK tool): its
`step` is its own entry and `callerScopeId` the function that was running when it was called
(`callback into classify from ask`), not the statement at the top of the program that started
the library. A call's `entryStep` to `endStep` covers the steps of everything it called, so
`return f(x)` ends after `f` ran. `values` entries have
`role` of `in`, `out`, `took` or `value`. A call's `out` is what the function returned
(`return = …`), recorded at every exit: a `return` inside `try`, `except`, `finally` or `with`,
`return await …`, a generator's return value. A call that left by an exception has
`out raised = Type: message` instead. A function that ran off the end of its body has no `out`.

**`graph RUN [--all | --expand PKG] [--scope NAME] [--no-statements] [--dot]`** is the shape:
one line per node (module, function, package, decision, statement) with hit counts and what each
produced, then one line per edge (`n0 → n3  ×2  #40 #52`, and `⇢` where a value one function
produced went into another). `--dot` gives Graphviz.

JSON: `{nodes: [{id, kind, parent, label, file, line, text, hits, firstStep, taken?, notRun?}], edges, moments, scopes}`.

**`story RUN [--file F | --scope NAME | --line F:L] [--limit LINES]`** lists the lines that ran,
in order, one block per scope, with the step each first ran at and `…` where it skipped. Stops
after 150 lines.

**`find RUN TEXT [--limit K]`** searches values, locals, errors, output and source lines by
content. The way to locate something when you do not know where it is.

**`steps RUN [--from N --count K | --line F:L]`** lists step numbers with `file:line` and
function. `--line` is how you count a loop's hits.

## Stepping

**`context RUN N [--scope]`** or **`context RUN --line F:L`** is everything at one step:

```sh
pyokka context run.json 55
# step 55/243  demo.py:57  reciprocal_rank
# stack: reciprocal_rank demo.py:57 #55 ← rrf demo.py:73 #53 ← main demo.py:119 #45 ← <module> demo.py:188 #6
# block reciprocal_rank  demo.py  steps 54–55
#  49  def reciprocal_rank(rank: int, k: int = 60) -> float:   #54
#     …
# >57      return 1 / (k + rank)   #55
# values:
#   #55 demo.py:57  rank = 1
#   #55 demo.py:57  k = 60
# moves: into 56 · over 56 · out 56 · back 54 · back-over 54 · back-out 53
```

Blocks are capped at 60 lines and 20 values; `--scope` lifts both once you know you want the
whole function. The `block` line ends with `returned VALUE` (or `raised Type`) when the function
left in that block, and a `calls:` line lists the calls the current statement made with what each
returned (`calls: helper #6 → 2`), so `return f(x)` shows both values without stepping in.

**`step RUN N --into|--over|--out|--back|--back-over|--back-out|--to M [--scope]`** moves and
prints the new step in the same shape. `--into` from a call line lands in the callee with its
arguments in `values`. `--over` and `--out` follow the call chain, so `--over` on an
`await asyncio.gather(...)` skips every step of the gathered tasks. Live, `step` moves the
user's editor, so use it to go somewhere and the reads to look.

**`values RUN --line F:L`** is every value logged on a line, by hit: the way to see a loop's
passes without stepping each one.

**`eval RUN EXPR`** reads a name, attribute, subscript or pure call (`len`, `sorted`,
`isinstance`, non-mutating methods) from the finished state. It refuses a function of the
program's own, because reading must not change anything. Needs `--keep` or `--live`.
**`expand RUN VALUE_ID [--path SEGMENT ...]`** opens a value node from `eval --json`'s
`valueBag.data.id`.

## Following a value

**`var RUN NAME [--file F] [--scope NAME] [--limit K]`** lists every step where a name changed,
the new value, and after `←` the names the statement read with their values at that moment.
`NAME` can be an attribute path (`self.balance`, `r.output_parsed.date`), and paths under it
match too.

```sh
pyokka var run.json contribution
# 16 changes of contribution
#   #53 demo.py:73  rrf  contribution = 0.01639344262295082   ← rank = 1, k = 60
```

`(same object)` after a value means the statement ran and the recorder saw the same object
afterwards. For a number or a string that means it did not change. For a list or a dict it means
the object was not replaced, and a re-bind inside it (`scores[k] = ...` on a key already there)
is not visible to the recorder, so the value shown is the one from before the statement: read it
as "the container is the same one", not as "nothing happened". `assigned here (value not
recorded)` means only the source knows it assigns; turn on locals.

JSON: `{name, total, truncated, recordedLocals, changes: [{step, file, line, function, name, source, text, reads: [{name, text, step?}]}]}`.

**`why RUN STEP [NAME] [--depth N]`** walks backwards: the statement that made the value, the
names it read with their values (each expanded in turn), the calls it made with their arguments
and results, five levels down. `why RUN STEP` alone explains the statement.

```sh
pyokka why run.json 124 fused_ranking
# fused_ranking = [('C', 0.0325…), ('A', 0.0322…)]   #104 demo.py:124 main   fused_ranking = sorted( …
#   ← scores = {'A': 0.0322…, …}   #45 demo.py:119 main   scores = rrf( …
#     ← rankings = {'BM25': [...], 'Vector': [...]}   #43 demo.py:112 main
#   ↳ rrf #46–#103 demo.py:60   in rankings = {...}, k = 60
```

`= ?` is a name nothing recorded. `· ... not stepped` is a call whose body left no steps.
JSON: `{name, step, depth, nodes, root: {name, text, step, file, line, function, statement, reads: [...], calls: [{name, entryStep, returnStep, inputs}], opaque}}`, nested.

**`origin RUN STEP [EXPR] [--depth N]`** follows one bad value back to where it was made, across
calls and containers, as one chain. Use it on an exception's step (`exceptions RUN` lists them)
when `why` stops at a parameter. Without `EXPR` it takes the value the exception is about: the
odd-typed operand of a `TypeError`, the dict of a `KeyError`, the name that is `None` in an
`AttributeError`, the short sequence of an `IndexError`. At a step with no exception, give
`EXPR` (a name, a subscript or an attribute path: `items[0]["price"]`, `lines[0].unit_price`,
`self.total`; a dataclass field is read from its repr, and a value cut at `maxValueChars` says so);
without it the statement's reads are listed. `--depth` caps the links (default 20, at most 60).

```sh
pyokka origin run.json 64
# TypeError at #64 invoices.py:34 subtotal: unsupported operand type(s) for +: 'int' and 'str' (caught)
# the value: items[0]["unit_price"] = '1,299.00', where the statement needs a number
# where from, newest first:
#   #64 invoices.py:34 subtotal        items[0]["unit_price"] = '1,299.00'   (read: …)
#   #61 invoices.py:42 invoice_total   order["items"][0]["unit_price"]   (argument: items of subtotal)
#   #52 invoices.py:47 main            order["items"][0]["unit_price"]   (argument: order of invoice_total)
#   #26 invoices.py:28 parse_orders    parse_price(price)   (element, inferred: put under key 'unit_price' here; …)
# ▶ #29 invoices.py:18 parse_price     return float(text) if … else text   (return: parse_price returned it)   ◀ root
#   …
#   #0 invoices.py:6 <module>          Ben,silver,MON-27,1,"1,299.00"   (literal, text match: …)
# root: #29 invoices.py:18 parse_price: parse_price returned a str here; its other 5 calls returned a float
```

Each link says how it joins the one before: `read`, `argument` (the call site's argument for a
parameter), `return` (the callee's return statement), `assigned`, `element` (the statement that
put the value into a container, or a loop variable) or `literal`. Read the certainty next to it:
no word means `recorded` (the link is structural and the value is in the recording); `inferred`
means it was picked by value among candidates, because the recording keeps a value's text, not
its identity; `text match` means only the text says so. Check an `inferred` link with
`step RUN N --into` before you build a fix on it.

The root (`▶`) is where the value took the form that failed. When the same function or statement
gave a value that fits on its other runs, the reason says so and names the count; otherwise the
root is the earliest link that already carries the failing value. Fix the root, not the line that
raised. `root: not known` means the chain stopped before any statement that made the value (a
list filled in place by `append` is the usual case); `chain ends:` says where and why. A run
saved with `--no-locals` has no chain: save it again without that flag.

JSON: `{step, file, line, function, statement, error?: {type, message, caught}, value?: {expr, text, type, chosen}, need?, links: [{step, file, fileId, line, function, scopeId, expr, how, certainty, text?, type?, note?, statement?, inputs?, root?}], root: {index, step, reason, evidence: "siblings"|"first"} | null, rootUnknown?, end, truncated, recordedLocals, reads?, hint?}`.
`links` runs newest first; `root.index` points into it.

## Comparing two runs after an edit

**`diff BEFORE.json AFTER.json [--limit K] [--ignore NAME]`** or **`diff BEFORE.json --live`** answers "what did my
edit change": every statement that did something different, with the values it assigned, the arm
a branch took, how often a loop ran, the calls it made with their arguments, what it printed and
what it raised. Record the before, edit, then record the after (or let the open session re-run,
and pass `--live` for it).

```sh
pyokka run shop.py --save before.json
# edit shop.py
pyokka run shop.py --save after.json
pyokka diff before.json after.json
# a  before.json  shop.py  23 steps  exit 0
# b  after.json  shop.py  28 steps  exit 1
# statements: 13 same, 1 edited, 4 added, 0 removed (matched by file, function and text)
# exit code 0 → 1
# 8 statements did something different; the first at shop.py:5 (a#10  b#10)
# shop.py:5  price  edited
#   - total = qty * unit
#   + total = qty * unit + 50
#   total = 60 → 110   a#10  b#10
# shop.py:6  price  if total > LIMIT:
#   took False → True   a#11  b#11
# shop.py:20→25  <module>  print(sum(totals))
#   printed 110 → 199.0   a#22  b#23
# shop.py:26  <module>  audit(totals)  added
#   call audit(totals=[99.0, 100]) raised RuntimeError: audit failed: 2 orders   only in b   b#24
```

`a#N` is step N of the first run and `b#N` of the second, so `pyokka step before.json 10 --into`
and `pyokka why after.json 10 total` pick up from either side (with `--live`, `b#N` is a step of
the session). Statements print in the order the after run reached them, the first one being where
the runs part.

How statements are matched: each file is parsed, and the two versions are aligned statement by
statement on the enclosing function plus the statement's text with comments and whitespace
removed. A statement that kept its text pairs with itself wherever it moved, and the line shows
as `20→25`. Inside a block that changed, statements pair by position within the same function
(`edited`, with `-` and `+` lines: the lines of the statement that changed, after its first line
as context when the change is further down, and a long line from shortly before its first
differing character); the rest are `added` or `removed in a`. Hits pair the nth
against the nth when both runs ran the statement as often; otherwise they are aligned by value
and the extra ones say `only in a` or `only in b`. Five hits per name per statement, then
`… N more`.

Assigned values and call arguments come from recorded locals. A VS Code session records them
only with `pyokka.timeMachine.recordLocals` on (Record Variable Changes in the panel), and
`pyokka run` records them unless `--no-locals`. When one side has none, `diff` compares the
rest, prints calls as `audit(…)`, and says so on a `note:` line; turn locals on and re-run to
compare values too.

The memory address in a default repr (`<function dataclass at 0x101d10720>`) is left out of the
comparison, since every run puts objects somewhere else; when something else in the value changed,
both values print as recorded.

A container changed by a method call (`totals.append(x)`) shows on the statement where the
recorder next saw it, as in `var`. A call's return value is compared when the walkthrough
recorded it on both sides. Library files are not compared.

A saved run keeps a redacted copy of the user's files, so the before still has the text that
ran after the file was edited. A run saved by an older runtime has no copy, and `diff` says
`note: a: shop.py changed since this run` when its statements came from the edited file; record
it again.

JSON: `{a: {run, file, count, exitCode}, b, matching: {same, edited, added, removed}, notes,
firstDifference: {file, lineA, lineB, stepA, stepB}, total, shown, statements: [{file, fileA,
fileB, lineA, lineB, function, textA, textB, sourceA?, sourceB?, status, stepA, stepB, facts: [{kind, name, a: {text,
step} | null, b}]}]}`. `kind` is `value`, `branch`, `loop`, `call`, `return`, `print`, `log`,
`error` or `decision`; a capped group is `{kind, name, more}`. `textA`/`textB` are a statement's
first line (` …` when it goes on); an `edited` one also has `sourceA`/`sourceB`, all its lines.

## Investigating one value

**`investigate RUN --value NAME [--at STEP]`** puts the single verbs' answers about one value on
one page: its changes (`var`), `why` at the step that made it, `origin` from the step where the
new value is first visible, the run's `exceptions`, and the project lines that did not run or ran
in part. Without `--at` it picks the first `nan`, `inf` or `None` the name held, else its last
change, and the `selected:` line names that step, its `file:line` and the step where the value is
visible. `--at STEP` explains that step instead: `why` and `origin` both start there.

```sh
pyokka investigate RUN --value NAME [--at STEP]
pyokka investigate rrf.json --value fused_ranking
# investigate fused_ranking
# note: Evidence covers this input only.
# selected: #104 demo.py:124 main  fused_ranking = [('C', 0.0325…  (the last change, visible from #110)
# -- history (var)
# -- why
# -- origin
# -- exceptions
```

The `note:` lines come first and say where the recording has gaps: no locals, the locals limit
(100,000 entries) reached, a trace cut at its step cap, a recording that began at a pause
(`--record-from`), no `run.finished` event, a user file with no recorded source copy, values cut
at `--max-value-chars`. Read them before trusting a final value.

JSON: `{kind: "investigation", name, notes, history, exceptions, coverage, selection?: {changeStep,
observedStep, suspicious}, step?, context?, why?, origin?, comparisons?}`, each part in its own
verb's shape.

## Practicing on a run

**`learn RUN [--at STEP] [--prediction TEXT] [--reveal]`** turns a run into an exercise. Bare, it
lists up to 12 checkpoints (calls, decisions, errors, prints) as step, kind, `file:line` and the
source line, with no values. Pick one with `--at STEP --prediction TEXT`: the prediction is kept
and the values stay hidden. Add `--reveal` to see what the run recorded there (the moment, its
values, the arm a decision took, what a print printed) and a `match:` line that says which
recorded value equals the prediction, compared as text and also without a repr's quotes.

```sh
pyokka learn rrf.json --at 11 --prediction "BM25 ranking" --reveal
# at #11  call demo.py:109  print_ranking("BM25 ranking", bm25_ranking)
# your prediction: BM25 ranking
# recorded:
#   call to print_ranking from main
#   #11 title = 'BM25 ranking'
#   #11 ranking = ['A', 'C', 'B', 'D']
# match: yes, title = 'BM25 ranking' at #11
```

JSON: `{kind: "learning", notes, coverage, checkpoints: [{step, kind, file, line, function, source,
prompt}], step?, prediction?, prompt?, observed?, moments?, recorded?: [{name, text, step}],
match?: {matched, name?, text?, step?}}`; `observed` is the step's `context`.

## Baselines and fix checks

**`pin RUN --out PATH`** copies a saved run byte for byte to a new file readable only by you, to
keep as the before of a fix (`--live` writes the session's recording). It refuses a PATH that
exists, so a baseline stays as it was pinned: pick a new name for the next one.

```sh
pyokka pin run.json --out baseline.json
# pinned /work/run.json (243 steps) to /work/baseline.json
```

JSON: `{pinned, from, steps}`.

**`verify RUN --after PATH | --rerun [--out PATH] [--ignore NAME] [--expect NAME=VALUE]
[--test-out PATH]`** checks a fix against that baseline. It prints the `diff` of the two runs,
then one `PASS` or `FAIL` line per `--expect`: the last recorded change of NAME against VALUE,
written as the value's repr (`--expect total=22`, `--expect "name='Ada'"`). `--rerun` runs the
baseline's file again with its saved arguments, cwd and limits (recorded HTTP is replayed) and
`--out` keeps that run. `--ignore NAME` leaves a name's values out of the comparison, a timestamp
for example, and the report lists what it left out; `diff --ignore NAME` does the same.

```sh
pyokka verify RUN (--after RUN2 | --rerun [--out PATH]) [--ignore NAME]... [--expect NAME=VALUE]... [--test-out FILE]
pyokka pin before.json --out baseline.json
# fix cart.py
pyokka verify baseline.json --rerun --expect total=22 --test-out test_cart_regression.py
# ... the diff ...
# PASS total = 22 at #8 (expected 22)
# wrote test_cart_regression.py: `python -m pytest test_cart_regression.py` reruns the file and checks these values
# verified: the expected values hold for this input
```

Without `--expect` the last line is still a verdict: `PASS: no expectations given; the after run has
no behaviour difference from the baseline` when no statement differs and the exit codes match, else
`no expectations given; the runs differ in N statements (see above); pass --expect NAME=VALUE for a
verdict` (a zero-difference pair whose exit codes differ gets its own line).

The exit status is 0 when every expectation passes on a run that exited 0, and 1 when one fails.
An expectation passes only on a complete recording: an after run cut at its step cap, started
with `--record-from`, without a `run.finished` event, past the locals limit, with the value cut
at `--max-value-chars`, or whose last change was made in place (`(same object)` in `var`) gets
`FAIL` with the reason. Record the after run again without that limit. With no `--expect`,
`verify` prints the comparison and ends with a verdict line all the same: `PASS: no expectations
given; the after run has no behaviour difference from the baseline` when nothing differs, else `no
expectations given; the runs differ in N statements`, exit 0, which points at the real verdict:
name the value the fix is about with `--expect NAME=VALUE`.

`--test-out PATH` writes a pytest file for the reviewed expectations. It reruns the file through
the Pyokka runtime with the interpreter that recorded the baseline and checks each value, so
`python -m pytest PATH` keeps the fix in place. It refuses a PATH that exists.

JSON: the `diff` shape plus `checks: [{name, expected, actual, step, passed, reason?}], verified,
coverage, exceptions, test?`.

## Reviewing a change

**`review`** reviews a change as a guided debug session, the sequence owned by the tool
([review.md](review.md) is the method). `start` plans a breakpoint per changed function from the
diff and starts the entry under the debugger in VS Code, paused on entry; the debugger is driven as
always and `stop --say` records the pause it is at (`--full` records base and head and plans the
stops from the comparison, and then `stop N` moves the person's view); `try` reproduces in the Scratchpad's
sandbox; `finding add` refuses without a step and a reproduction; `fix` tries a patch on a copy;
`report` re-runs every reproduction before it prints. Every result's first line is the header,
`review <id> · <phase> · stops K/N shown · findings F · tries T`, and its last is `next:` with
one command. A refusal has the same two lines around `refused: <why>` and its detail lines
(`isError` through MCP).

```
pyokka review start --base REF [--repo DIR] [--entry FILE | --test NODEID] [--only PATH...] [--full] [--pr FILE] [--python P] [--surface vscode|page|chat] [--port P] [--dir DIR] [-- ARGS]
pyokka review view [--surface vscode|page|chat] [--port P]      # the person's view, opened after start when it opened none or they moved
pyokka review stop [N] --say TEXT [--go-on] [--surface auto|page|vscode|chat] [--port P] [--session NAME]   # records the pause the debugger is at; in a --full review moves the view to stop N
pyokka review ask FILE:LINE --say TEXT
pyokka review skip N [N...] --why TEXT
pyokka review look --expr EXPR [--step N]
pyokka review try --code FILE | --expr EXPR [--inputs FILE] [--mocks FILE] [--edge E3] [--title T] [--port P]
pyokka review finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD [--expect TEXT] --fix TEXT
pyokka review fix --patch FILE.diff [--tests CMD]
pyokka review report [--out FILE]
pyokka review close
pyokka review state
```

- Without `--full`, `start` plans from `git diff BASE` and the untracked files (read as added,
  ignored files left out) alone: one item per changed function, a breakpoint at the first statement
  of its first changed span (a changed `def` header breaks in the body), a `uses:` line of the
  repository code its changed lines call (no breakpoint), and starts the entry under the debugger in the person's VS Code, stopped on entry, with the
  debugger's recording on for a program (a test runs through its runner, which has no recording).
  Nothing of base is run. The debugger is then driven as always (`continue --live`, `step`, `eval`,
  `break`); `stop [N] --say TEXT` records the pause the session is at, refused when the text names
  none of the frame's values or when the program is running or ended; `ask` and `look` are refused
  with the debugger's commands; `skip` removes the breakpoint; `view vscode` starts the program
  again with the remaining items' breakpoints; `finding add` takes a recorded pause near its line.
  `--only PATH...` limits the diff read to those files, directories or globs; the plan lists the
  changed files outside them, which were not read.
  `--surface page|chat` implies `--full`, and a `start` with no VS Code to reach refuses and names
  `--full`.
- With `--full`, `start` opens the person's view after recording: VS Code by default (a recording session on the entry, run to its end, whose Time Machine the stops move), `--surface page` for the browser page (a `pyokka web` process the review stops at `report` or `close`), `--surface chat` for none; its `view:` line says what opened or why not. A review of one `--test` has no view and stays in chat: both commands run the test file as a program, another run than the test's, so no hint names them for it and `stop --surface vscode|page` on it is refused.
- `start` resolves REF in the repo (the current directory unless `--repo`), materialises the base
  tree in `DIR/base`, records head through the entry (`main.py` at the repo root when it exists,
  else `--entry` or `--test`, as `pyokka run ENTRY --cwd REPO --save DIR/head.json` would) and base
  the same way, then compares: `diff` of the two runs, `exceptions` of both, `coverage` of head on
  the added lines, and the PR text (`--pr FILE`, default `pr.md` or the commit messages base..head)
  for the functions and files it names. The plan: stops, one per statement in rank order, each
  `{n, kind, file, line, function, fact, step_a, step_b}` with `kind` one of `raise`, `type`,
  `sign`, `none`, `print`, `value`; the changed lines no run reached; edge candidates `E1..En` from
  the added lines (comparison boundaries, missing keys, except paths with their fallback, new
  parameters, empty loops, zero divisors, slice bounds, orderings, attributes no class in the
  project defines) with what to try. Head is the working tree as it stands, uncommitted changes
  and the entry included. `--dir DIR` is the review directory, default
  `$PYOKKA_HOME/reviews/<repo-name>-<base7>/` (`review.json`, `base/`, `base.json`, `head.json`,
  `tries/`, `fixed/`, `report.md`); every later action takes `--dir` too, else the review `start`
  last wrote, named in `$PYOKKA_HOME/reviews/current`. Nothing is written inside the repository.
- `stop N` refuses with no plan (`next: review start`), an N outside it (the plan prints; `ask
  FILE:LINE` is for an unplanned line), an empty `--say`, or a `--say` that names none of the stop's
  values: the text has to contain the rendered text of one of the stop's locals at `step_b` (quotes
  optional, whitespace ignored), the fact's `a` or `b` text, or the step number, and the refusal
  lists them. Then it moves the view, `--surface auto` taking the first that answers: a page whose
  file is the entry (`--port`, default `$PYOKKA_PORT` or 4777) gets `goto step_b` with the text; a
  live debug session in VS Code gets `break FILE:LINE --when COND` then `continue`, COND from up to
  two locals of the stop whose text is a literal; a live recording session gets `step --live --to
  step_b`, sessions on the entry only unless `--session` names one; in chat nothing moves, and the
  view line of a stop with no page and no session names the command that opens one. It prints the
  stop as `context head.json step_b` does, then the
  text, and `next:` is the first unshown stop, else `finding add`. `ask FILE:LINE` is the same at
  the first head step on that line, recorded under `asked`.
- One stop per call. The stop after a shown one is refused until it carries `--go-on`, which you
  pass only after the person said next; `ask`, `try` and `look` never need it, and a shown stop's
  `next:` is `wait for the person`.
- `skip N --why TEXT` sets agenda item N aside with the person's reason; `state` lists shown, skipped
  and remaining.
- `look --expr EXPR [--step N]` answers "what is X here" from the values recorded at the current or
  the given step, without moving anything.
- `try` runs `--code FILE` or `--expr EXPR` in the Scratchpad's sandbox, a separate `python -I` with
  the head tree on `sys.path`, network denied on macOS, 5 s; as the page's Scratchpad experiment
  when a page is open on the entry, headless otherwise. It stores `DIR/tries/<id>.json` (code,
  inputs, mocks, result, output, error, the edge id) and prints them with the id; `--edge E3` marks
  that candidate tried.
- `finding add` refuses without `--step` or `--repro`. `--step` has to be a step of `head.json` in
  file F (basename match) within 3 lines of L or in the same function; `--repro` is a try id, or a
  shell command run from the repo root whose output has to contain `--expect`, required for a
  command.
- `fix` applies the diff to `DIR/fixed`, a fresh copy of head (refused when a hunk fails), runs
  `--tests CMD` there, records `fixed/ENTRY` to `DIR/fixed.json` and prints the test result, the
  `diff` summary head → fixed, and PASS or FAIL for each finding whose `--expect` is a
  `NAME=VALUE`, as `verify` prints them.
- `report` refuses when the repo's tree differs from `start`, when a finding lacks a reproduction, It opens with "What we looked at together": the stops shown and asked in order, each with its say, then the
  stops not looked at.
  or when one no longer reproduces (every try and command is run again). It prints markdown: what
  the change does in behaviour, findings by severity (file:line, step, values, how reproduced, fix,
  fix status), stops shown and asked, edges tried and skipped, unreached lines not tried, what was
  not verified, and writes it to `--out` or `DIR/report.md`. `state` is the header, the plan with
  shown stops marked, findings, tries and `next:`.

The shop fixture of the tests (`python/tests/fixtures/review/`), base `63650f1`, as a review of it
goes. The header and `next:` lines are the contract's; the rest is abridged or illustrative:

```sh
pyokka review start --base 63650f1 --repo /work/shop
# review shop-63650f1 · stops · stops 0/2 shown · findings 0 · tries 0
# ... base 360 steps, head 435, exit 0 on both; 7 statements edited, 31 added, 4 removed, 35 did
#     something different; a TypeError raised and caught only in head; unit_price float → str ...
# stops (2):
#   1. raise  shopkit/pricing.py:12 subtotal  TypeError: unsupported operand type(s) for +: 'int' and 'str' (caught, 1×)  a –  b#197
#   2. type  shopkit/orders.py:30 parse_orders  unit_price: float → str (1249.0 → '1,249.00')  a#116  b#120
# unreached changed lines (1):
#   shopkit/discounts.py:8 changed line never ran  return settings.platinum_rate
# edge candidates (2):
#   E1 [boundary] shopkit/discounts.py:16 spend_tier_rate: `spend > threshold`: call spend_tier_rate with spend equal to threshold, and just above and below it; ...
#   E2 [attribute] shopkit/discounts.py:8 loyalty_rate: `settings.platinum_rate`: ...
# next: review stop 1 --say TEXT
pyokka review stop 1 --say "the subtotal goes wrong here"
# review shop-63650f1 · stops · stops 0/2 shown · findings 0 · tries 0
# refused: --say names none of stop 1's values
#     lines = [Line(sku='MON-27', qty=1, unit_price='1,249.00'), Line(sku='CBL-02', qty=3, unit_price=7.5)]
#     TypeError: unsupported operand type(s) for +: 'int' and 'str'
#     step 197
# next: review stop 1 --say TEXT
pyokka review stop 1 --say "line_total gives 1 * '1,249.00', the text itself; sum() starts at 0 and 0 + '1,249.00' raises TypeError. Line 13 catches it and line 15 returns 0.0: Ben's order is worth nothing."
# review shop-63650f1 · stops · stops 1/2 shown · findings 0 · tries 0
# step 197/435  shopkit/pricing.py:12  subtotal [error]
# stack: subtotal shopkit/pricing.py:12 #197 ← build_invoice shopkit/invoices.py:21 #194 ← main main.py:16 #157 ← <module> main.py:21 #48
# ... the block, calls:, values: and errors: as `context head.json 197` prints them ...
# say: line_total gives 1 * '1,249.00', the text itself; ...
# next: review stop 2 --say TEXT
# ... stop 2 at shopkit/orders.py:30, its --say naming '1,249.00' ...
pyokka review try --code /tmp/rv/t1.py --title "the export's quoted price"   # from shopkit.money import parse_money; print(parse_money('"1,249.00"'))
# review shop-63650f1 · findings · stops 2/2 shown · findings 0 · tries 1
#   t1  the export's quoted price  surface: headless
#     output: 1,249.00
# next: review finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD --fix TEXT
pyokka review finding add --file shopkit/money.py --line 14 --severity blocker \
  --title "parse_money keeps a thousands separator as text" --step 124 --repro t1 \
  --fix "t = t.replace(',', '') before the match"
# review shop-63650f1 · findings · stops 2/2 shown · findings 1 · tries 1
#   f1 blocker  shopkit/money.py:14  parse_money keeps a thousands separator as text  step #124 parse_money
#      reproduced: try t1
#      fix: t = t.replace(',', '') before the match
# next: review fix --patch FILE.diff
# ... a try at the 500.0 boundary (--edge E1), finding f2 with a command repro and its --expect ...
pyokka review report
# review shop-63650f1 · findings · stops 2/2 shown · findings 2 · tries 2
# refused: finding f2's reproduction no longer reproduces: `python3 -m unittest tests.test_discounts -v`
#     printed nothing containing 'rate 0.0 for 500.0'
# next: review fix --patch FILE.diff
```

## Reports: exceptions, HTTP, graph

**`exceptions RUN`** answers "what did this program swallow": one row per exception type, raise
site and handler, uncaught first. `broad handler` is a bare `except:` or an `except Exception`,
which is the place to look when a program runs to the end and did nothing.
`caught outside stepped code` means C code or the stdlib swallowed it.

**`http RUN`** is every HTTP request: method, status, the statement that made it, size, time,
and whether it was live, recorded, replayed or a miss. URLs print with query values stripped;
bodies stay in the recording file.

**`coverage RUN [--file F]`** lists per file the statement lines that ran and the spans that did
not (`not run: 3, 12-15`), plus lines that ran in part or raised. `--file` lists that file line by
line with hits. It is the quick check for a branch the run never took.

## Tours of a large run

**`tour RUN [--goal NAME|FILE:LINE] [--budget TOKENS]`** (or `--live`) splits a run into chapters
and lists, per chapter, the steps worth a stop with the signals that proposed each one and the
values the program held there. It is what you pick a tour from: read the chapters, then the
candidates, then step or `why` into the ones that matter. Every value comes from the recording.

```sh
pyokka tour learn.json
# tour  learn.py  23,567 steps  exit 0  19 HTTP (19 model calls)  217 of 340 candidates, ~39,874 tokens (budget 40,000)
# goal: the program's output at #23566: ANSWER: The base Transformer uses **8 attention heads**, …
# chapters
#   c1   #0-1867    7.9%  <module>  + PageIndexClient.__init__, PageIndexClient.submit_document, …  46 candidates
#   c2   #1868-8674  28.9%  complexity  16 candidates
#   c4   #13748-20599  29.1%  expand  + flash_rejection_reason  44 candidates  14 HTTP (14 model)
# candidates (id  #step  file:line  signals  statement  value)
#   s13917-d66b2b  #13917  PageIndex/pageindex/utils.py:213  crossing:lib-call,io:http,narrative:binds  response = await litellm.acompletion(**{ …  → response = ModelResponse(id='gen-…
```

- Chapters: the calls the top-level frame makes; inside a call holding over 25% of the run, a
  phase per project function its orchestrator calls (never cut while concurrent tasks run);
  phases under 2% merge unless they make an HTTP call.
- Signals (`group:kind`): `spine` (`why` back from the output, or from `--goal`), `crossing`
  (callbacks a library made into the project, calls into libraries), `io` (HTTP requests and
  where their response lands; file writes and subprocesses from the statement's source),
  `exception`, `narrative` (what an orchestrating function keeps; long texts going into a
  call), `evidence` (values sharing the most words with the output), `chapter`.
- A line that runs again is a candidate again only with new call arguments (HTTP always).
- A long value is cut at 300 characters with `evidence` windows (sentences sharing words with
  the goal, with offsets); a repeated value is `sameAs` an earlier value id; a value that grew
  (a message list) shows only the window that differs (`like`, `from`, `to`).
- `--budget` (default 40,000 tokens, at 4 characters a token) drops the lowest scored
  candidates, an equal share per chapter; setup (settings objects, validation, keyword
  plumbing) goes first.
- A run whose walkthrough has under 60 moments is one chapter whose candidates are the
  walkthrough's moments.
- `--goal NAME` explains a variable's last value; `--goal FILE:LINE` a line's last pass.

`id` is `s<step>-<key>`, `key` a hash of file, line and statement text, so it names the same
statement in a re-recorded run. JSON: `docs/TOUR.md` in the repository is the schema
(`{tour, run, goal, small, budget, chapters: [{id, title, opens, kind, steps, share, http, llm,
candidates}], candidates: [{id, key, step, chapter, file, line, function, scopeId, signals:
[{signal, reason}], statement, score, values: [{id, role, name, length, text?, cut?, evidence?,
sameAs?, like?, from?, to?}]}]}`).

**`tour RUN --prose tour.prose.json [--out tour.json]`** checks prose written from the tour
(by a model with [tour-prompt.md](tour-prompt.md), or by you) against the run and merges it.
Give it the same `--goal` and `--budget` as the tour the prose was written from. `--out` writes
the tour as compact JSON, with or without `--prose`.

```sh
pyokka tour run.json --out tour.json                                 # the input for the prose
pyokka tour run.json --at 197 --at 120 --out tour.json               # a candidate at each step whatever the ranking says (a review's stops)
pyokka tour run.json --prose tour.prose.json --out tour.merged.json  # check and merge
# prose accepted: 8 stops, 4 chapter texts, 1 warning
# warning: c3 holds a picked stop but has no title; the page uses the function that opens it
# c4  #53-103  Scoring each rank
#   3. s53-189112  #53  rrf.py:73  The top rank is worth 0.01639344262295082
```

A rejection exits 2 and lists every problem, one per line (`--json`: `{ok: false, error, hint,
violations: [...]}`): unknown chapter or stop ids, a picked stop with no text, a quote on a field
the stop lacks or out of range, a number that is not in that stop's recorded values, statement
or quote (`1,024` matches `1024`, `0.50` matches `0.5`), a backticked name that is not in the
tour, a 'single-quoted' string that is not in the stop's values. The merged tour adds `intro`,
`pick`, `prose: {stops, chapters, warnings}`, `chapters[].prose: {title, text}` and, on picked
candidates, `prose: {title, text, order, quote?: {field, name, from, to, text, length,
recordingCut?}}`, where `quote.text` is cut by Pyokka from the recorded value.
`node <skill>/scripts/render-tour.cjs tour.merged.json tour.html` renders it.

## The page

**`history RUN --at STEP|FILE:LINE --var NAME --why STEP NAME [--pause] --out PATH`** writes the
data behind the code-history page. Also `--prose PATH`, `--pad N` (default 2), `--limit K`
(default 20 checkpoints per `--var`), `--lang L` (`en` or `es`: the page's buttons, legend and chips), `--scope`, and `--append` to add these
checkpoints to the page already at `--out` rather than replacing it, which is how a page follows
a live program through more than one pause. A value on a card is as long as the run kept it (its
`--max-value-chars`; 200 characters when the run does not say, which a live session does not);
`--value-chars N` cuts shorter, `0` shows every value whole.

Selectors appear on the page in the order you wrote them. See
[code-history.md](code-history.md) for the contract and the renderer.

## The shapes worth knowing

**The context slice**, which `context`, `step` and every debug stop share:

```
{step, count, location: {file, line, col, function, fileId}, stale, staleFiles,
 stack: [{file, line, function, step}],
 block: {file, function, scopeId, firstStep, lastStep, lines: [{line, text, step, current?}], totalLines, capped, returned?, raised?},
 calls: [{function, scopeId, step, returned?, raised?}],
 values: [{line, file, context, text, step, hit, kind, runtimeKey}],
 coverage: {notRun}, moves: {into, over, out, back, backOver, backOut}, errors, flags}
```

`block.lines` holds only the lines that ran, so a gap between line numbers is a gap in coverage.
`values[].context` is the name; a value with no `context` is a logged expression.

**`state`**: `{runId, running, finished, stale, staleFiles, nav: {active, step, count}, file, displayName, exitCode, keep}`,
plus `debug: {active, paused, frontier}` and `others` on a live session.

**The saved run**: `{meta, events}`. `meta` has `runtimeVersion`, `python`, `executable`,
`interpreterSource`, `file`, `workspaceRoot`, `argv`, `config`, `started`, `durationMs`,
`exitCode`, `stepCount` (the statements the program ran, recorded or not), `recording` when the step
cap cut it, and `files: [{fileId, path, sha256}]`. Read `events` through the verbs, which is what they are
for.

## The browser page

```
pyokka web FILE [--port N] [--cwd DIR] [--open] [--no-watch] [--python PATH]
pyokka web ctl [--port N] state | step over | debug start | eval EXPR | ...
```

`pyokka web FILE` serves the Pyokka panel, a code pane and the Time Machine in a browser tab
(http://127.0.0.1:4777/ by default; `--port N` or `PYOKKA_PORT` moves it) and reruns the file when
it changes on disk. It runs the bridge the extension ships under `node` (20 or newer) on PATH, else under
the Node inside VS Code (its Electron binary with `ELECTRON_RUN_AS_NODE=1`). `pyokka web ctl`
drives the open tab: `state` first, then the moves, `say` for a narration bubble, `break LINE` and
`debug start` for the page's own debugger, `scratchpad open` at a pause for an experiment with
the pause's values in a separate `python -I`, `scratchpad say TEXT --line N` for a bubble in it;
`pyokka web -h` lists every command. Exactly one tab may
be open per page. docs/WEB.md is the full reference.

When the person works in the page, drive that page with `pyokka web ctl --port PORT` or
`pyokka_page`. `pyokka debug` and `pyokka_debug` drive VS Code, another window.

- `state` first. `pages: 0` or `no page is open` means no tab is connected to that server: ask
  them to open or reload `http://127.0.0.1:PORT/`. Do not open a browser yourself or start a
  second server on another port; one tab per server.
- To show another file, stop their server and start `pyokka web FILE --port PORT` on the same
  port. The tab reconnects with the breakpoints it had, shown in its gutter, and they still decide
  where `debug start` stops; `break LINE off` removes one in the main file.
- The file's folder is the run's root and working directory. Code outside the root is library
  code, which the Time Machine and the page's debugger neither stop in nor step into, so a
  launcher in `/tmp` makes the whole project library code. `pyokka web FILE --cwd DIR` (`cwd` on
  `pyokka_page` open) makes a DIR that holds the file both root and working directory (a DIR
  elsewhere moves only the working directory): `pyokka web tests/test_routes.py --cwd .` from the
  project root lets a test step into the code it calls. An older `pyokka web` answers `unexpected
  argument --cwd`; then open a file whose folder holds the code, or ask the person: a launcher at
  the project root that you delete afterwards, or Step Into Library Code ticked in the panel's
  Settings (the gear), which takes effect on the next run and instruments every installed package.
- `debug start` goes to the first breakpoint that can hit, else to the first statement, and
  waits 10 s for it. A server or a slow test answers `debug start reached neither a pause nor the
  end in 10 s` and keeps running; `debug state` says whether it still is. Read `wait-pause` (it
  prints a cursor N), send the request that reaches the breakpoint if it is a server, then
  `wait-pause --after N --timeout 25000`.
- Explanations go on the page, in the bubble under the line, not in chat: `--say TEXT` on a move,
  or `say TEXT --line N` once you have read the values the move returned. A recording move without
  `--say` clears the bubble and a `debug` move leaves the old one. `state` shows it as `narration`.
  Each reply carries the enclosing function as `block`, the current line marked `current`:
  explain from it in the same message as the move. A reply without `block` comes from an older
  page, which sends only the line's text as `code` and no code after a `debug` move; there, read
  the function once before you step into it.

## Live only

**`state --live`** is how you find out what exists. It never moves anything.

**`watch --live`** prints one line per stop while the user steps in VS Code, until Ctrl-C:
`paused at file:line (reason)`, `resumed`, `output`, `finished: exit N`. Also `stopped` (the
user closed the Time Machine) and `rerun` (the file was saved and ran again, so earlier step
numbers are void; re-read `state` and re-map).

**`shell --live`** reads one command per stdin line, the same words without `--live`, over one
connection: about 0.5 ms a command instead of the 70 ms a new process spends starting Python.
Every live command works there except `watch`. `exit` or end of input closes it.

**`record --live`** at a pause of a `pyokka debug FILE --record-from NAME` run that has not reached
NAME yet records from that pause on and prints it again as step 0. On a run that records already
it says `already recording` and prints the current stop.

Live has no `story`, `find` or `steps --line`: those need the whole trace and the bridge serves
one step at a time. The error names the saved-run command instead. `diff BEFORE.json --live`
works, with the session as the after; in `shell --live` it is `diff BEFORE.json`.

**`narrate RUN [--command CMD]`** asks a model for one sentence per walkthrough moment and
stores it in the saved run. The model is `--command` when given, else claude, else codex, found on PATH or in
~/.local/bin, ~/.claude/local, /opt/homebrew/bin, /usr/local/bin. Never automatic, and the result is a gloss, not
an observation.

**`cache [--clear]`** is the instrumented-library-file cache (`$PYOKKA_HOME/cache`).

## Every command

One synopsis per command. `--json`, `--live` and `--session NAME|PATH` are on every command
that reads a run or a session and are left out below; `RUN` is a saved `run.json`, omitted with
`--live`.

```
pyokka run FILE [--save RUN.JSON] ... -- ARGS          (Recording a run, above)
pyokka story RUN [--file F | --scope NAME | --line F:L] [--limit LINES]
pyokka walkthrough RUN [--file F] [--scope NAME] [--from N] [--to M] [--all]
pyokka steps RUN [--from N] [--count K] [--line F:L]
pyokka find RUN TEXT [--limit LIMIT]
pyokka context RUN N [--line F:L] [--scope]
pyokka step RUN N --into|--over|--out|--back|--back-over|--back-out|--to M [--count N] [--scope]
pyokka values RUN --line F:L
pyokka var RUN NAME [--file F] [--scope NAME] [--limit K]
pyokka why RUN STEP [NAME] [--depth N]
pyokka origin RUN STEP [EXPR] [--depth N]
pyokka eval RUN EXPRESSION [--frame N] [--text-len N]
pyokka expand RUN VALUE_ID [--path SEGMENT]...
pyokka release RUN
pyokka state RUN
pyokka graph RUN [--all] [--scope NAME] [--expand PKG]... [--no-statements] [--dot]
pyokka exceptions RUN
pyokka http RUN
pyokka coverage RUN [--file F]
pyokka diff BEFORE.json AFTER.json [--limit K] [--ignore NAME]...
pyokka tour RUN [--goal NAME|FILE:LINE] [--budget TOKENS] [--at STEP]... [--prose PATH] [--out PATH]
pyokka narrate RUN [--command CMD] [--dry-run]
pyokka history RUN --out PATH [--at STEP|FILE:LINE]... [--var NAME]... [--why STEP NAME]...
        [--pause] [--prose PATH] [--pad N] [--limit K] [--lang L] [--scope] [--append] [--value-chars N]
pyokka review start --base REF [--repo DIR] [--entry FILE | --test NODEID] [--only PATH...] [--full] [--pr FILE] [--python P] [--dir DIR] [-- ARGS]
pyokka review stop [N] --say TEXT [--go-on] [--surface auto|page|vscode|chat] [--port P] [--session NAME]   # records the pause the debugger is at; in a --full review moves the view to stop N
pyokka review ask FILE:LINE --say TEXT
pyokka review skip N [N...] --why TEXT
pyokka review look --expr EXPR [--step N]
pyokka review try --code FILE | --expr EXPR [--inputs FILE] [--mocks FILE] [--edge E3] [--title T] [--port P]
pyokka review finding add --file F --line L --severity blocker|major|minor --title T --step N --repro ID|CMD
        [--expect TEXT] --fix TEXT
pyokka review fix --patch FILE.diff [--tests CMD]
pyokka review report [--out FILE]
pyokka review state
pyokka watch --live
pyokka shell --live
pyokka debug FILE [--at FILE:LINE|NAME]... [--module M] [--cwd DIR] [--env K=V]... [--python PATH]
        [--stop-on-entry] [--record | --record-from NAME|FILE:LINE] [--library-code] [--no-focus]
        [--configuration NAME] [--test NAME] [--args ...]
pyokka continue --live [--no-wait] [--until EXPR | --to FILE:LINE] [--scope] [--no-start]
pyokka pause --live [--no-wait] [--scope]
pyokka stop --live
pyokka restart --live [--stop-on-entry] [--no-start]
pyokka break --live [FILE:LINE...] [--when EXPR] [--at NAME|FILE:LINE]... [--remove FILE:LINE|NAME]...
        [--list] [--on-exception off|uncaught|raised] [--no-start]
pyokka watches --live [--add EXPR]... [--break-when change|true] [--remove ID]... [--list]
pyokka locals --live [--frame N] [--scope local|global|all] [--names-only] [--name NAME]... [--text-len N]
pyokka exec --live SOURCE [--frame N]
pyokka record --live
pyokka mcp
pyokka cache [--clear] [--json]
pyokka serve
pyokka _child --port PORT --token TOKEN
pyokka _keep --socket SOCKET [--idle SECONDS]
pyokka _imports FILE [--root DIR]
pyokka _scratch
```

`debug --configuration NAME` takes program or module, args, cwd, env, envFile, python,
stopOnEntry and `justMyCode: false` (as `--library-code`) from a `debugpy` or `python`
configuration of the nearest `.vscode/launch.json` above FILE, `--cwd` or the current directory;
flags given on the command line win, and the answer's first line names the keys it did not apply.
`debug --test NAME` launches the test runner on FILE the way `run --test` does. `exec --frame N`
runs the statement in frame N of the pause. `continue`, `restart` and `break` with no debug
session start the last `pyokka debug` launch from this directory again; `--no-start` makes them
fail instead.

`cache` prints the instrumented-library-file cache's directory, entry count and size; `--clear`
empties it. `serve` is the NDJSON runner the extension and `run --save` talk to, `_child` the
process a runner spawns for one run when it does not fork, and `_keep` the process `run --keep`
leaves behind (it exits after `--idle` seconds with no connection, or on `release`); the CLI starts these three itself. `_imports` and `_scratch` are the browser page's: the project files
a file imports, and the Scratchpad's prepare, seed, format and run, one JSON request on stdin.

## Environment

- `PYOKKA_HOME` is the directory for Pyokka's per-user state, `~/.pyokka` when unset or empty
  (a leading `~` is expanded). It holds `sessions/` (one descriptor and socket per live window
  session), `last-debug.json` (the launch `break`, `continue` and `restart` start again),
  `cache/`, `recentFiles.json` and `config.json`. The CLI finds a window's sessions when both see
  the same value, so set it in the shell the same way it is set for VS Code. The extension passes
  its value to every runner it starts. A socket whose path would pass 103 bytes goes to the temp
  directory instead; its descriptor names it.
- `PYOKKA_SESSIONS_DIR` moves only `sessions/` (`last-debug.json` then sits beside it), and
  `PYOKKA_CACHE_DIR` moves only the cache (empty turns it off). Both take precedence over
  `PYOKKA_HOME`.
- `PYOKKA_CODE` is the `code` binary `pyokka debug` opens the window with, and
  `PYOKKA_NO_FOCUS=1` leaves window focus alone.
- `PYOKKA_SPAWN=1` makes the runner start each run in a fresh interpreter, and `PYOKKA_FORK=1`
  makes it fork on macOS too (it forks on Linux and spawns on macOS by default).
- `PYOKKA_KEEP_DIR` is where `run --keep` puts the kept runner's socket (default: the temp
  directory).
