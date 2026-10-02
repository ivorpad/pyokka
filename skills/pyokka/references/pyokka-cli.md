# The `pyokka` CLI over a recording

Every verb takes `RUN` (a `run.json`) or `--live` (an open VS Code session with
`pyokka.agentAccess` on). Every verb takes `--json` for the raw shape; the text form is the one
to read. Errors go to stderr as `error: <what>` plus a line saying what to do next, exit 2; with
`--json` the same thing arrives as `{"ok": false, "error", "hint"}` on stdout.

Contents: [Recording a run](#recording-a-run) · [Mapping](#mapping-a-run-you-do-not-know) ·
[Stepping](#stepping) · [Following a value](#following-a-value) ·
[Comparing two runs](#comparing-two-runs-after-an-edit) ·
[Reports](#reports-exceptions-http-graph) · [Tours](#tours-of-a-large-run) · [The page](#the-page) ·
[Shapes](#the-shapes-worth-knowing) · [Live only](#live-only)

## Recording a run

```
pyokka run FILE [--save RUN.JSON] [--library-code] [--keep] [--no-locals]
                [--http off|record|replay] [--timeout MS] [--watch EXPR] [--auto-log]
                [--max-steps N] [--exclude GLOB]... [--only GLOB]... [--max-value-chars N]
                [--python PATH] -- ARGS
```

`--save` is what writes the recording; without it the command prints the event stream.

- `--library-code` instruments third-party packages too, never the stdlib. Without it `--into` on
  a library call steps over it. Ask for it when the question is what a library did with an
  argument; it is slower and the run is bigger.
- `--keep` leaves the runner alive so `eval` and `expand` can reach the finished values.
  `pyokka release run.json` shuts it down.
- `--no-locals` skips recording locals at every step, which is what `var` and `why` read. Leave
  it on unless the run is enormous.
- `--http record` writes every HTTP exchange to `.pyokka/replay/<hash>.jsonl` next to the file;
  `--http replay` answers later runs from it, so a program that calls an API runs again with no
  network and no tokens and returns the same values.

```sh
pyokka run demo.py --save run.json
# python: /work/.venv/bin/python 3.12.4 (.venv in /work)
# saved run.json: 243 steps, 1 files, exit 0
```

**Which Python runs the program.** The first match: `--python PATH` (an interpreter or a venv
directory), `$PYOKKA_PYTHON`, `$VIRTUAL_ENV`, a `.venv` in the file's directory or a parent up to
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
`EXPR` (a name or a subscript of one, `items[0]["price"]`); without it the statement's reads are
listed. `--depth` caps the links (default 20, at most 60).

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
saved with `--no-locals` has no chain: save it again with `--record-locals`.

JSON: `{step, file, line, function, statement, error?: {type, message, caught}, value?: {expr, text, type, chosen}, need?, links: [{step, file, fileId, line, function, scopeId, expr, how, certainty, text?, type?, note?, statement?, inputs?, root?}], root: {index, step, reason, evidence: "siblings"|"first"} | null, rootUnknown?, end, truncated, recordedLocals, reads?, hint?}`.
`links` runs newest first; `root.index` points into it.

## Comparing two runs after an edit

**`diff BEFORE.json AFTER.json [--limit K]`** or **`diff BEFORE.json --live`** answers "what did my
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

## Reports: exceptions, HTTP, graph

**`exceptions RUN`** answers "what did this program swallow": one row per exception type, raise
site and handler, uncaught first. `broad handler` is a bare `except:` or an `except Exception`,
which is the place to look when a program runs to the end and did nothing.
`caught outside stepped code` means C code or the stdlib swallowed it.

**`http RUN`** is every HTTP request: method, status, the statement that made it, size, time,
and whether it was live, recorded, replayed or a miss. URLs print with query values stripped;
bodies stay in the recording file.

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
stores it in the saved run. Never automatic, and the result is a gloss, not an observation.

**`cache [--clear]`** is the instrumented-library-file cache (`$PYOKKA_HOME/cache`).

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
