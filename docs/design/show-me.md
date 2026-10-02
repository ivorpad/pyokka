# Design: `pyokka-show-me`, the skill and the `history` verb

Designed 2026-09-15 on top of `ea3ea51`, from a written brief and a PyCharm debugger skill
(61-line `SKILL.md`, two references, a 29-line Handlebars
template, a 65-line renderer, a 1752-byte example).

Read with: `docs/PROTOCOL.md` (the bridge and the context slice), `docs/HANDOFF-debugger.md`
(what rounds 1 to 3 built), `docs/design/debugger-product.md` (why the two products are two),
`skills/pyokka-agent/SKILL.md`, `skills/pyokka-debug/SKILL.md`, `skills/explain-code/SKILL.md`.

This was the plan, reviewed before any code was written. Section 11 at the end lists where the
implementation departed from it and why.

## 1. What the skill is, and why it beats the PyCharm one

`pyokka-show-me` is the one skill an agent loads to do anything with Pyokka: read a recording,
drive the live debugger, and explain either one. Its default way of explaining is a rendered
artifact, the same two-panel "code history" page the PyCharm skill produces: numbered source on
the left, chronological checkpoints on the right.

The PyCharm version has a weakness the author of a skill cannot fix from inside the skill: the
agent types the values into the JSON. A DAP session holds one frame at a time, so the page is a
transcript of what the agent happened to look at, and a reader has no way to check it.

Pyokka has the whole run. So the data behind the page is **generated from `run.json` by a CLI
verb**, not written by the agent, and every checkpoint carries the command that reproduces its
values. The agent writes prose and nothing else. That is the property worth building:

- a value on the page is wrong only if `pyokka context` is wrong;
- a reader can paste the `verify` line and get the same numbers back;
- a regenerated page after a re-run differs exactly where the run differs.

The generator therefore refuses to let prose touch a generated field (section 4.4). That refusal
is the feature.

## 2. The verb

Working name `pyokka history`. It reads a saved run or a live session, selects checkpoints, and
writes the data JSON the template consumes.

```
pyokka history [RUN] [--live] [--session NAME|PATH]
               [--at STEP | --at FILE:LINE] ...
               [--var NAME] ... [--why STEP NAME] ... [--pause]
               --out PATH [--prose PATH] [--pad N] [--limit K] [--lang L] [--json]
```

| flag | what it selects |
|---|---|
| `--at STEP` | the recorded step N: one checkpoint, from `context(step=N)` |
| `--at FILE:LINE` | the first step on that line, resolved the way `context --line` resolves it |
| `--var NAME` | one checkpoint per recorded change of NAME, in step order, from `var(NAME)` |
| `--why STEP NAME` | one checkpoint for the provenance chain of NAME after STEP, from `why(STEP, NAME)` |
| `--pause` | with `--live`: one checkpoint from the debug session's current pause |

Other flags:

| flag | default | meaning |
|---|---|---|
| `--out PATH` | required | where the data JSON goes; `-` is stdout |
| `--prose PATH` | none | a JSON file whose prose fields are merged in (4.4) |
| `--pad N` | 2 | source lines of dim context above and below the block |
| `--limit K` | 20 | most checkpoints one `--var` may produce |
| `--lang L` | `en` | the page's `lang`; the navigation labels stay English unless overridden |
| `--json` | off | print the summary as JSON instead of the one-line text form |

### 2.1 Ordering

`--at`, `--var`, `--why` and `--pause` all append to **one ordered list**, in the order they
appear on the command line, through a small shared-`dest` argparse action. Argparse would
otherwise hand back three unrelated lists and lose the author's sequence.

The page is a narrative, and the author's order is the narrative. A `--var` expands in step
order inside its own slot. Nothing is re-sorted.

### 2.2 Both modes, one seam

Every selector is a call on `RunSource` (`agent/source.py`), the protocol `SavedRun` and
`LiveRun` both implement. So the verb works against `run.json` and against `--live` with no
branching except where the bridge refuses a verb (`why` and `var` need a recording, so
`--var` and `--why` against a `record: false` debug session fail with the runtime's own
`<verb> needs a recording` message and its hint, unchanged).

That seam is also what makes the reproducibility claim true by construction: the generator calls
the same method `pyokka context` calls, so the `verify` line cannot drift from the value beside
it.

### 2.3 The live pause, without touching the user's session

`--live --pause` reads the current pause with **`context()` and nothing else**. A stop reply and
`context` at the frontier are the same shape (PROTOCOL.md, "Debugging over the bridge"): the
context slice plus `paused`, `locals`, `output`, `modified` and `thread`. One round trip, no
`debug`, no `step`, no `continue`, so a session the user is reading is not moved.

If nothing is paused, the verb fails with `no debug pause to capture` and a hint naming
`pyokka break --live FILE:LINE` and `pyokka continue --live`. It never starts a session to make
a checkpoint.

**No new bridge verb, so `docs/PROTOCOL.md` needs no wire change.** The one gap is whole-file
source: nothing on the wire serves it, only `block.lines[].text`, capped at 60 lines. The
generator reads source from disk and checks it (section 3.2).

## 3. The data contract

One JSON document. Field names from the PyCharm template are kept where they mean the same
thing, so the two pages stay recognisably the same artifact.

### 3.1 Top level

| field | who writes it | content |
|---|---|---|
| `lang` | generator | the `--lang` value |
| `labels` | renderer | navigation labels; English defaults, overridable |
| `title`, `eyebrow`, `heading`, `subtitle`, `summary` | **prose, left empty** | browser title, small label, the finding, the subject, the conclusion |
| `historyLabel`, `scope`, `footer` | **prose, left empty** | evidence coverage, limits, completion status |
| `reportHref`, `reportLabel` | prose, empty | optional link |
| `meta` | generator | run identity, an object (3.3) |
| `files` | generator | `{ "<workspace-relative path>": ["line 1", "line 2", ...] }` |
| `steps` | generator | the checkpoints, in the order of 2.1 |

`meta` was a string in the PyCharm contract. Pyokka has real identity to show, so it becomes an
object and the header renders it as chips. That is the one breaking change to the contract, and
it is the one that makes a page checkable.

### 3.2 `files`

Keyed by `display_path()` (workspace-relative, or from `site-packages/` on), the key a
checkpoint's `file` field repeats. The value is an array of source lines where index 0 is line 1,
exactly as the PyCharm contract says.

Only the lines some checkpoint's range needs are filled in; every other entry is `""` and the
array stops after the highest line any range reaches. A 2000-line file therefore contributes the
few hundred lines the page shows, with original numbering intact.

Source comes from disk through `SavedRun.source_lines`. Before emitting, the generator compares
the file's sha256 with `meta.files[].sha256` in the saved run. A mismatch is the same staleness
the rest of the CLI reports: the verb refuses, prints
`stale: demo.py changed since the run`, and names `pyokka run demo.py --save run.json`. Rendering
a page whose source does not match its values would be worse than no page.

Live: `stale` on the slice says the buffer moved; the verb refuses the same way.

### 3.3 `meta`

```json
{
  "mode": "saved run",
  "run": "/tmp/rrf-run.json",
  "file": "demo.py",
  "sourceSha256": "97770016f6bd6b",
  "runSha256": "3c1f0a77b2e945",
  "python": "3.14.2",
  "runtimeVersion": "0.0.1",
  "exitCode": 0,
  "stepCount": 243,
  "recordedAt": "2026-09-15T15:03:23+00:00",
  "truncated": []
}
```

`sourceSha256` is the 14-hex prefix of `meta.files[].sha256` of the main file, already in the
saved run. `runSha256` is the prefix of the sha256 of `run.json` itself, so a page and a run can
be matched later. `mode` is `saved run` or `live session`; live fills `run` with the descriptor's
display name, `exitCode` with `null`, and adds `"paused": "demo.py:82 (breakpoint)"`.

`truncated` lists what a `--limit` cut, for example
`["--var contribution: 20 of 34 changes"]`. The header shows it. Evidence is never dropped
silently.

### 3.4 A checkpoint

```json
{
  "id": "var-contribution-3",
  "kind": "recorded step",
  "tag": "VARIABLE CHANGE 3 OF 16",
  "step": 65,
  "title": "", "text": "", "note": "",
  "file": "demo.py",
  "start": 65, "end": 87, "focus": 73,
  "bright": [65, 67, 69, 71, 73, 75, 82, 87],
  "values": "contribution = 0.015873015873015872",
  "reads": ["rank = 3   #64", "k = 60   #46"],
  "stack": ["rrf demo.py:73 #53", "main demo.py:119 #45", "<module> demo.py:188 #6"],
  "call": null,
  "hits": null,
  "arm": null,
  "chain": [],
  "exception": null,
  "http": null,
  "verify": "pyokka var /tmp/rrf-run.json contribution --json",
  "evidence": []
}
```

`id` is stable across regenerations (`step-55`, `var-contribution-3`, `why-124-scores`,
`pause-1`), which is what `--prose` keys on.

`title`, `text` and `note` are the only prose on a checkpoint, and `tag` is generated but
editable. Everything else is generated and refused to prose.

Per-kind fields, all `null` or `[]` when they do not apply:

- `call`: `{"name": "reciprocal_rank", "in": ["rank = 1", "k = 60"], "out": "return = 0.016393"}`,
  from the walkthrough moment covering the step. This is what PyCharm cannot show: the callee's
  arguments and its result, at a call site, without stepping.
- `hits`: how many times the focus line ran in the whole run, from the coverage event. A loop
  body says `8 hits` on the card.
- `arm`: `if document_id not in ranking took True`, from the decision moment on the line.
- `chain`: the `why` tree flattened, `[{depth, via, name, text, statement, location, step}]`,
  `via` one of `root`, `reads`, `calls`. Flat with a depth number renders as an indented list in
  one pass and validates in one pass; the tree shape is recoverable from `depth`.
- `exception`: `"ValueError: too small: 3   raised demo.py:21, caught demo.py:68"`, from the
  exceptions report when the step raised.
- `http`: `"POST api.example.com/rank  200  1.2 kB  340 ms  recorded"`, from the HTTP table when
  the step made a request.

`start`, `end`, `focus`, `bright` follow the PyCharm rules and keep their meaning: `focus` is
the checkpoint's line, `bright` is the lines the recording says ran inside the range, dim is
context. `start`/`end` are the block's extent widened by `--pad`, clamped to the file.

### 3.5 Evidence kinds

`kind` is one of exactly four, and the renderer rejects anything else:

| `kind` | what it means | where it comes from |
|---|---|---|
| `recorded step` | the program executed this statement and the recording holds its values | `context`, `var`, `why` over a run |
| `live pause` | the program is stopped here now; the frame is live and nothing behind it was recorded | `context --live` at a debug pause |
| `static source` | nobody ran this; it is source the explanation needs | the agent adds it by hand, with no `step` and empty `values` |
| `gloss` | a sentence a model wrote about a moment | `narrate`, carried from the walkthrough's `gloss` |

These are four different claims and a reader must be able to tell them apart. A `live pause`
card cannot carry `chain`, because a `record: false` session recorded nothing behind the pause.
A `static source` card cannot carry `values`. The renderer enforces both.

`--live --pause` also copies `modified` onto the card when the session has been written to with
`exec`: the tag becomes `LIVE PAUSE (VALUES MODIFIED FROM THE CONSOLE)`. A page built on a
modified frame has to say so on the page, not only in chat.

### 3.6 Secrets

Values in a saved run are redacted at save time and bridge replies are redacted by the host, so
`values`, `reads`, `chain` and `locals` arrive redacted. The generator runs `redact()` over them
again, which is idempotent and costs nothing.

Source lines are not redacted, by design: redacting source would corrupt the panel. So the
generator scans every source line it is about to emit against the same patterns and prints a
warning naming the line (`demo.py:14 in the emitted source matches a secret pattern`). The agent
then chooses a narrower range or tells the user. This matches the PyCharm reference's rule
("Exclude secrets ... including from the source embedded in the HTML") with a mechanism instead
of an instruction.

## 4. The generator

### 4.1 Where the code goes

`python/pyokka_runtime/agent/codehistory.py`, new, target 260 lines. Not `history.py`: that
name is taken by the implementation of `var`.

Wiring, following `narrate` as the model (a verb that writes a file and reports one line):

- `agent/commands.py`: the parser in `add_commands`, `"history"` in `COMMANDS`, one branch in
  `_run_command`. About 25 lines.
- `agent/render.py`: `render_history`, four lines, the summary text.
- No change to `live.py`, `source.py` or the protocol.

### 4.2 Shape of the module

Pure functions, so the tests can call them without a run:

```python
def source_window(lines, block, focus, pad) -> tuple[int, int, list[int]]
def values_text(values) -> str
def flatten_chain(root, depth=0) -> list[dict]
def checkpoint_from_context(slice_, ...) -> dict
def checkpoint_from_change(change, slice_, ...) -> dict
def checkpoint_from_why(result, slice_, ...) -> dict
def checkpoint_from_pause(slice_, ...) -> dict
def merge_prose(data, prose) -> None
def build(source, selectors, *, pad, limit, lang) -> dict
```

`build` is the only one that touches a `RunSource`. Everything below it takes plain dicts, which
is what makes the comparison test in 6.1 cheap to write.

### 4.3 Enrichment passes

`hits`, `arm`, `call`, `exception` and `http` come from one `walkthrough()`, one `exceptions()`
and one `http()` call, made once and indexed by step, not once per checkpoint. A page with 20
checkpoints costs four reads of the run, not eighty.

### 4.4 `--prose`

```json
{
  "heading": "C wins because it is the only document both retrievers ranked",
  "summary": "...",
  "steps": {
    "step-55": { "title": "The first contribution", "text": "...", "note": "..." },
    "why-124-scores": { "title": "Where the order comes from" }
  }
}
```

Merged into `title`, `text`, `note`, `tag` on a checkpoint and the prose fields at the top level.
Any other key is an error naming the key:
`prose may not set "values" on step-55: values come from the run`. An unknown `id` is an error
too, because a silently ignored paragraph is worse than a failed command.

The same file can be applied to a regenerated page, which is the point: re-run the program, re-run
`history`, re-apply the prose, and only the numbers move.

## 5. The template and the renderer

Both start from the PyCharm files and keep the approved design: dark slate, two panels,
proportions, monospace source with line numbers, dim context, green relevant lines, amber current
line and values, chronological cards, counter, slider, previous/next, arrow keys, stacked layout
under 850px. What changes:

1. **Labels in English**, from a `labels` object the renderer fills with defaults
   (`Previous`, `Next`, `Checkpoint`, `Source`, `Code story`, `relevant line`, `dim = context`,
   `selected checkpoint`, `navigate`). `lang` stays free, so a Spanish page only needs its own
   `labels`.
2. **Run identity in the header**: `meta` as a row of chips (file, source sha, run sha, Python,
   exit code, step count, mode). A stale or truncated run shows an amber chip.
3. **The step number on every card**: `#65` beside the tag, and `demo.py : 73  #65` in the source
   panel bar, so the left panel always says which step it is showing.
4. **`in` / `out` of a call**, as a two-line block above `values`, arrows in the gutter.
5. **Hits and the arm taken**, one small line: `8 hits · took True`.
6. **The provenance chain**, an indented list, one row per `chain` entry, indent from `depth`,
   `←` for `reads` and `↳` for `calls`, the value on the right.
7. **The verify line**, monospace, at the foot of the card: `verify: pyokka context ... --json`.
   This is the line that makes the page checkable, so it is on every card and never optional.

The renderer (`scripts/render-code-history.cjs`, target 110 lines) keeps the PyCharm structure:
validate, compile, write, print the path. Added validation:

- `meta` is an object and its keys have the right types;
- every `kind` is one of the four, and the per-kind rules of 3.5 hold;
- `verify` is a non-empty string starting `pyokka `;
- `chain` entries have an integer `depth` and a `via` from the enum;
- `id` is unique across `steps`;
- `files` values are arrays of strings, ranges inside them, `bright` inside the range (unchanged);
- `labels` defaults filled when absent.

Handlebars resolution, in order: the current working directory, then the skill's own directory
(`skills/pyokka-show-me/node_modules`), then `--handlebars-module PATH`. The PyCharm renderer
only does the first and third, and the second is what lets the skill work from a project that
has never heard of Handlebars.

Handlebars is not in this repo. `npm install --save-dev handlebars` adds it; `scripts/gen-manifest.py`
keeps non-contribution fields, so `package.json` survives a regeneration and
`test/unit/manifest.test.ts` needs no change. Binaries run from `./node_modules/.bin`.

## 6. Tests

### 6.1 `python/tests/test_agent_history.py`

The comparison test the brief asks for comes first, because it is the claim the whole artifact
rests on:

1. **`test_every_value_matches_context`**: build a page over the demo run with a spread of
   `--at` steps; for each checkpoint, run `context(step) --json` and assert that its `values`
   render to exactly the checkpoint's `values` string, its `stack` to the checkpoint's `stack`,
   and its `location.line` to `focus`.
2. `test_at_line_resolves_to_the_first_step_on_it`.
3. `test_var_expands_in_step_order_and_matches_var_json`, reads included.
4. `test_why_chain_flattens_the_provenance_tree`: depth, `via` and order against `why --json`.
5. `test_source_window_keeps_original_line_numbers`: index 0 is line 1, holes are `""`,
   `start <= focus <= end`, `bright` inside the range and a subset of the lines that ran.
6. `test_meta_identity`: `sourceSha256` is a prefix of the run's recorded sha256, `runSha256`
   is a prefix of the sha256 of the file on disk, `stepCount` equals `state()`'s count.
7. `test_prose_merge_fills_only_prose` and `test_prose_refuses_a_generated_field`.
8. `test_prose_refuses_an_unknown_id`.
9. `test_stale_run_is_refused` (edit the file after saving).
10. `test_limit_is_reported_in_meta_truncated`.
11. `test_secret_in_a_value_is_redacted` and `test_secret_in_emitted_source_warns`.
12. `test_static_source_checkpoint_carries_no_values` (the 3.5 rule, at the generator level).
13. `test_call_in_out_hits_and_arm` over the demo: the `rrf` call site carries `in`, the loop
    header carries `hits`, the `if document_id not in ranking` line carries `arm`.

Live is covered in `python/tests/test_agent_live.py`'s existing fake-bridge style: a stop reply
becomes a `live pause` checkpoint with `locals` as values, `output` kept, `modified` reflected in
the tag, and `--var` against a `record: false` session refused with the runtime's own message.

### 6.2 Node

`test/unit/codeHistory.test.ts`, run by vitest: render
`skills/pyokka-show-me/templates/code-history.example.json` to a temp file and assert the HTML
embeds the data, carries the step badges and the verify lines, references no external script or
stylesheet, and that a bad range, an unknown `kind` and a duplicate `id` are each rejected with a
message naming the checkpoint.

### 6.3 End to end, by hand, before reporting

The acceptance in the brief: record the demo, generate with
`--at <the input rankings> --var contribution --why <the fused ranking step> scores`, fill prose,
render, screenshot with headless Chrome at `--virtual-time-budget=3000`, read the PNG, and check
every number against `pyokka context /tmp/rrf-run.json N --json`. Then one live checkpoint from
the FastAPI service at `api/main.py:52`, and `stop --live`.

## 7. Files

| path | new or changed | budget |
|---|---|---|
| `skills/pyokka-show-me/SKILL.md` | new | under 300 lines |
| `skills/pyokka-show-me/references/pyokka-cli.md` | new | ~300 |
| `skills/pyokka-show-me/references/code-history.md` | new | ~150 |
| `skills/pyokka-show-me/references/live-debugger.md` | new | ~170 |
| `skills/pyokka-show-me/scripts/render-code-history.cjs` | new | ~110 |
| `skills/pyokka-show-me/templates/code-history.html.hbs` | new | ~35 |
| `skills/pyokka-show-me/templates/code-history.example.json` | new | small, synthetic |
| `python/pyokka_runtime/agent/codehistory.py` | new | ~260 |
| `python/pyokka_runtime/agent/commands.py` | changed | +25 |
| `python/pyokka_runtime/agent/render.py` | changed | +5 |
| `python/tests/test_agent_history.py` | new | ~320 |
| `python/tests/test_agent_live.py` | changed | +60 |
| `test/unit/codeHistory.test.ts` | new | ~90 |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/HANDOFF.md` | changed | prose |
| `package.json` | changed | one devDependency, through `npm` |

`docs/PROTOCOL.md` is not touched: no bridge verb is added (2.3).

## 8. The three existing skills

The brief says to decide. The new skill's references would otherwise repeat
`skills/pyokka-agent/SKILL.md` and `skills/pyokka-debug/SKILL.md` almost line for line, and two
copies of a command table drift within a week.

Recommendation:

- **`pyokka-agent` and `pyokka-debug` become pointers**, about 15 lines each: the frontmatter
  description stays (it is what makes them trigger, and the triggers are good), the body says
  what the skill is for and names
  `skills/pyokka-show-me/references/pyokka-cli.md` and `.../live-debugger.md`. Their content
  moves into those references, merged, with the phrase-to-command tables joined into one.
- **`explain-code` keeps its method.** Explaining to a person, live, one idea per stop, their turn
  after every stop, is a genuinely different job from producing an artifact, and its rules (the
  line is the unit, the run is the evidence, never queue moves) are not in the new skill. It loses
  only its command reference and points at the new one. `pyokka-show-me` names it for the case
  where the user wants to be walked through the editor instead of handed a page.
- **`AGENTS.md`** gains a row for `pyokka-show-me` as the first one, and its existing rows shorten
  to match.

The alternative, keeping all three whole and adding a fourth, is less work now and guarantees
three sources of truth for one CLI. Say if you want that instead.

## 9. Open questions

1. **The verb name.** `pyokka history` reads well next to "code history" and matches the skill's
   trigger, but `pyokka var` is already the history of a variable, so a reader might expect
   `history` to mean the run's history. Alternatives: `pyokka codehistory`, `pyokka showme`,
   `pyokka page`. Recommendation: keep `history`.
2. **Chain shape.** Flat with `depth` (recommended, renders and validates in one pass) against
   nested, which mirrors `why --json` exactly. Flat loses nothing: `depth` reconstructs the tree.
3. **`--var` default limit.** 20 per `--var`, reported in `meta.truncated`. The demo's
   `contribution` has 16 changes, so the acceptance page shows all of them.
4. **The e2e suite.** A `test/e2e/` case that drives `history --live` against a real host is
   possible but would need its own `dist/`, and the brief warns against two e2e suites against
   one build. Recommendation: cover live in `test_agent_live.py`'s fake bridge and do the real
   live checkpoint by hand as acceptance. Say if you want the e2e case too.
5. **Where a generated page should live.** The PyCharm reference says "the repository's permitted
   local investigation directory", never inside the skill. For Pyokka the natural place is the
   scratchpad, and the skill will say so. Nothing writes into `skills/`.

## 10. Order of work

Generator with tests, then template and renderer with the Node smoke test, then the skill text
and the references, then README, `AGENTS.md`, `CHANGELOG.md`, `docs/HANDOFF.md`, then the two
acceptance runs, then the report. `tsc --noEmit`, `vitest run` and `pytest -q` green at the end,
against the baselines: tsc clean, 62 files and 587 tests, 454 passed and 1 skipped.

---

## 11. What changed while building it (2026-09-15)

The design above is what was reviewed. These are the places the implementation departed from it,
each with why.

1. **`--out -` dropped.** With the data on stdout the command's own summary would follow it on
   the same stream. `--out PATH` is required; `--out /dev/stdout` still works for a pipe.
2. **`source_window` gained a span cap.** A module block runs from the first import to the last
   line, so the first page showed a 180-line left panel for a checkpoint on line 34. A block
   wider than 40 lines is now centred on the focus, and `--scope` passes 0 to take it whole.
3. **Source lines in the page are redacted, not just flagged.** Section 3.6 said warn and emit.
   Then `pyokka context`'s own text form turned out to redact source on the way to the terminal
   while `--json` does not, and an HTML file travels further than a terminal. The generator now
   redacts and names each line it changed.
4. **The module is two files.** `codehistory.py` hit the 500-line ceiling, so the pure shapers
   and `Facts` moved to `agent/checkpoint.py` (183 lines) and `codehistory.py` kept the document
   assembly (350). `commands.py` is 509 lines and every added line is parser wiring.
5. **A checkpoint has a `reason` field.** A live pause's stop reason was going into `arm`, which
   `anchor` then overwrote with the line's branch arm. A stop reason and a branch arm are
   different things and now have different fields.
6. **Source falls back to the block the bridge sent.** A live session's file can be in a
   workspace the CLI cannot read; the slice already carries `block.lines[].text`, so the page
   uses that rather than showing a blank panel. This is what made the live acceptance work: the
   window that answered was open on an unrelated project.
7. **`arm` summarises every pass.** Both the walkthrough's last decision moment and the graph's
   `taken` report one arm for a line that went both ways. `arm_text` now writes
   `if row < 0 took False x2, True x1`.
8. **Ligatures are off in the template.** SF Mono drew the `--` of `--json` in a `verify` line as
   one long dash, and that line exists to be copied.
9. **The demo regeneration test uses `examples/demo.py`.** The RRF demo lives in a sibling
   repository, and a test that reaches outside the checkout is a test that breaks on another
   machine. The comparison is the same and runs against this repository's own demo.
10. **Shiki colours the source, in the renderer.** The plan left the source panel monochrome and
   it read as a wall of grey. The colours come from `codeToTokens` while the page is being
   written, and the page carries the tokens as data, so the standalone property survives a real
   theme; the browser-side import the docs show would have cost the page its network
   independence. `--theme` takes any bundled theme and the default is `github-dark-dimmed`,
   whose background is already the panel colour. Dim context became opacity, because a grey
   text colour cannot coexist with a theme's own.

Open question 1 was settled as `pyokka history`; 2, 3, 4 and 5 were built as recommended.
Section 8's recommendation was taken: `pyokka-agent` and `pyokka-debug` are pointers and
`explain-code` keeps its method.

Numbers: tsc clean, vitest 63 files and 597 tests (from 62 and 587), pytest 487 passed and 1
skipped (from 454 and 1).
