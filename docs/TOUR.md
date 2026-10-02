# `pyokka tour` and `tour.json`

`pyokka tour RUN|--live [--session NAME] [--goal NAME|FILE:LINE] [--budget TOKENS] [--prose PATH] [--out PATH] [--json]`
splits a recorded run into chapters and lists, per chapter, the steps worth a stop, each with
the signals that proposed it and the values the program held there. Nothing in it is written by
a model: every value is read from the recording. It is the input a tour is picked and narrated
from (one model call, or the agent reading it), and `tour.json` is the contract that the prose
validator and the Tour view read. `--prose` checks and merges what was written from it
("tour.prose.json" below); `--out` writes the tour, merged or not, to a file.

Code: `python/pyokka_runtime/agent/tour/`. The rules come from the ablation of 2026-10-01
(session e499ce3c, `scratchpad/ablation/REPORT.md` and `poc/`); the corpus it used is the test
fixture set (`python/tests/fixtures/tour/`, `python/tests/test_tour.py`).

## tour.json

```
{
  "tour": 1,
  "run": {file, steps, exitCode, durationMs, http, llm, io: {http, fileWrites, subprocess}, recording?},
  "goal": {kind: "output" | "name" | "line" | "end", step, text, name?, line?},
  "small": bool,
  "budget": {tokens, estimate, found, kept, dropped},
  "chapters": [{id, title, opens: [str], kind, steps: [first, last], share, http, llm, candidates}],
  "candidates": [{
    id, key, step, chapter, file, line, function, scopeId,
    signals: [{signal, reason}],
    statement, score, setup?, repeat?,
    values: [{id, role, name, length, text?, cut?, evidence?: [{from, to, text}],
              sameAs?, like?, from?, to?}]
  }],
  "timing": {ms, whyCalls}
}
```

- `run.http` counts the HTTP requests, `run.llm` those to a model API (a URL ending in
  `/chat/completions`, `/completions`, `/v1/messages`, `/responses`, `/embeddings`, Gemini's
  `:generateContent`, Ollama's `/api/chat` or `/api/generate`). `run.io` says where each kind
  of I/O comes from: HTTP is recorded; file writes and subprocess calls are read from the
  statements' source, because the recording has no event for them. `run.recording` is the step
  cap's note when the recording was cut.
- `goal` is what the spine explains: by default the program's last output line in the frame
  that orchestrates the run (`kind: "output"`), else the run's last step (`end`). `--goal NAME`
  takes the variable's last recorded change, `--goal FILE:LINE` the line's last pass.
- `small` is true when the walkthrough has under 60 moments: then the walkthrough's moments are
  the candidates and there is one chapter (`kind: "walkthrough"`).
- `budget.estimate` is the JSON's length in characters divided by 4; `found` is how many
  candidates the signals proposed, `kept` how many fit.
- A chapter: `id` is `c1`, `c2`, … in run order; `title` is the function that opens it and
  `opens` every function whose call or phase was merged into it; `kind` is `call` (a call the
  top-level frame made), `statements`, `phase` (a phase of a long call) or `walkthrough`;
  `steps` are inclusive and cover the run without gaps; `share` is the chapter's part of the
  run; `http` and `llm` count the requests whose step falls inside.
- A candidate's `id` is `s<step>-<key>`. `key` is six hex characters of a hash of the file's
  display path, the line and the statement's text with whitespace collapsed: the same statement
  hashes the same in another recording of the program, so a pick or a text keyed by `key` (and
  the order of passes) survives a re-record whose step numbers moved. `file` is the display path
  (workspace-relative, or from `site-packages/` on), `function` the qualified name, `statement`
  the whole statement (a compound statement's header), cut at 240 characters.
- `signals[].signal` is `group:kind`, from the table below; `reason` says why in a few words.
  `score` is what the budget ranks by; `setup` marks a candidate the setup rule demoted;
  `repeat` is how many earlier passes of the same line (reached from the same two callers) were
  kept.
- A value: `id` is `<candidate id>.v<n>`; `role` is `in` (an argument at a function's entry),
  `set` (a name the statement bound), `value` (a logged value), `printed`, `call` (what a call
  the statement made returned, `name` is `f()`), `returned` / `raised` (what the function
  returned or raised at this step), `took` (the arm a branch took), `http` (the request line);
  `length` is the full recorded length.
  - `text` holds the value whole up to 300 characters; a longer value is cut there with
    `cut: true` and carries up to two `evidence` windows: sentences of the full text, starting at
    character 250 or later, that share the most words and numbers with the goal's text
    (a number weighs 3, a sentence needs a score of 4 from two words or more), with `from` and
    `to` offsets into the full value.
  - `sameAs: "<value id>"` replaces the text of a value of 40 characters or more that equals an
    earlier one (not for values the recording itself cut, which may differ past the cut).
  - `like: "<value id>"` with `from`, `to` and `text`: a value of 200 characters or more that
    shares its start and end with the previous value of the same name (a message list that grew
    by one turn); `text` is the part that differs, 40 characters of context either side, and
    the offsets are into the full value.
  - A value the recording itself cut (`…(+N chars)`, see `--max-value-chars`) gets, under
    `--json`, `truncated: true` and `length` set to the original's length, as in every verb.
  - Left out: `self` and `cls`, bound methods, `<function … at 0x…>`, modules, classes, a value
    that repeats the statement (`k = 60` on `k = 60`), a string the statement spells out
    (`print("RESULTS")`).

The text form prints the run line, the goal, the chapters with their step ranges, then one line
per candidate: `id  #step  file:line  signals  statement  → name = value`.

## tour.prose.json

What a model (or an agent) writes from `tour.json`, and the only part of a tour it writes. The
prompt is `skills/pyokka/references/tour-prompt.md`: the skill's `show` mode and the
extension's Narrate Tour both send its text, a blank line, then the compact `tour.json`.

```
{
  "intro": str,                                   // at most 3 sentences
  "chapters": {"c2": {"title": str, "text": str}},
  "pick": ["s12-3fa9c1", ...],                    // candidate ids
  "stops": {"s12-3fa9c1": {"title": str, "text": str,
                           "quote"?: {"field": "<value id>", "from": int, "to": int}}}
}
```

`field` is a value id of that stop: the whole id (`s12-3fa9c1.v2`), its last part (`v2`), or the
value's `name` when only one value has it. `value` is read as `field` (the prototype's name).
`from` and `to` are offsets into the value's full recorded text, not the 300 characters the tour
shows.

`pyokka tour RUN|--live --prose tour.prose.json [--out tour.json]` builds the tour again (give
it the same `--goal` and `--budget`; the ids and value numbering come from them), checks the
prose and merges it. Code: `python/pyokka_runtime/agent/tour/prose.py`.

Rejected, with every problem listed, exit status 2 (`--json`: `{ok: false, error, hint,
violations: [str]}`); each line names the place (`s12-3fa9c1.text`, `c2.title`, `intro`):

- a chapter or stop id the tour does not have; a pick listed twice; a picked stop with no title
  or text; a stop written but not picked; a field the contract does not have;
- a quote on a field the stop does not have, a range outside the value, or a range past where
  the recording itself cut the value (`…(+N chars)`; the line says to rerun with
  `--max-value-chars 0`);
- a number in a title or text that is not in that stop's values (their whole recorded text,
  `sameAs` resolved), its statement or its quote. A chapter may also use the numbers of its
  picked stops, its step range and its `http` and `llm` counts; the intro the numbers of every
  pick and the run's step, request and chapter counts. Thousands separators are removed and
  trailing decimal zeros dropped before comparing (`1,234,567` = `1234567`, `0.50` = `0.5`). A
  digit glued to a name (`s3`, `v2`, the 4 of `gpt-4o`) is not a number;
- a name in backticks (an identifier, dotted or with a call's parentheses) that does not occur,
  as a whole word, in the tour's statements, functions, files, value names or values; a dotted
  name passes when each part does. Backticked expressions are not names, and their numbers are
  checked like any others;
- text in 'single quotes' (two characters or more) that is not in the stop's recorded values;
  for a chapter, in its picked stops' values; for the intro, in any pick's.

Warnings, which a merge survives: a chapter that holds a pick but has no title, an empty intro,
a stop text over 3 sentences, and pick counts outside the prompt's: 6 to 10 in all when the tour
has under 60 candidates (or one chapter), else 3 to 6 in each chapter that has 3 candidates or
more. Picks are put in run order, not rejected for being out of it.

The merged tour is `tour.json` unchanged plus:

```
{
  "intro": str,
  "pick": [ids in run order],
  "prose": {"stops": int, "chapters": int, "warnings": [str]},
  "chapters": [{..., "prose"?: {"title", "text"}}],
  "candidates": [{..., "prose"?: {"title", "text", "order",
                                  "quote"?: {"field", "name", "from", "to", "text", "length", "recordingCut"?}}}]
}
```

`quote.text` is cut by Pyokka from the recorded value, `length` is the length the recording
holds, and `recordingCut: true` says the recording had cut the value itself, so the original was
longer. The rule `title` of a chapter stays; the prose title rides in `prose`.

`skills/pyokka/scripts/render-tour.cjs tour.json page.html [--title TEXT]` renders a merged tour
as one page with no scripts: intro, a chapter map (title, step range, LLM call count), chapters
as `<details>` sections, a card per pick (title, text, `file:line`, `#step`, the quoted slice)
with the statement and values folded behind a toggle, a repeated value as "same as `name` at
#step". It is separate from `render-code-history.cjs`, which renders a two-panel, script-driven,
dark-only source viewer through Handlebars and Shiki; the tour is a document that reads at 400px
in light and dark with nothing but HTML and CSS. `skills/pyokka/templates/tour.example.json` is
the RRF fixture merged with `python/tests/fixtures/tour/rrf.prose.json`.

The PageIndex proof (2026-10-01, `learn.json`): one `claude -p` call (claude-opus-5-5, 79,584
input and 6,970 output tokens, $0.77, 69 s) over the 159,792-character tour; the first reply
passed with no violations and no warnings, 25 stops across the 6 chapters.

## Chapters

1. Top level. From the module, descend while one call holds 80% of the frame's steps and the
   frame's other calls hold under max(3%, 25 steps) together (`<module>` to `main`). Each call
   that frame makes is a chapter; calls in a row from one line to one function are one chapter
   (`parse x300`) sized together, and a group under 8 steps is not one. Statements between calls
   glue onto the next chapter when they are under 12 steps.
2. Phases. Inside a chapter over 25% of the run, an orchestrator is a function called once there
   whose own steps span over 25% of the chapter. Each of its statements that keeps the result of
   a call to a project function opens a phase at the first call to each callee.
3. No phase starts while concurrent work runs: instances of one function whose lifetimes overlap
   without one descending from the other (recorded scope parents) mark a span with no cut.
4. A phase under 2% of the run merges into the previous one unless it makes an HTTP request; a
   chapter under 2.5% folds into the next one (the last into the previous).

On the PageIndex run (23,567 steps) this gives the six phases of the published tour exactly:
`#0-1867` (client setup and parsing), `complexity` `#1868-8674`, `merge` `#8675-13747`,
`expand` `#13748-20599` (14 model calls), `generate_doc_description` `#20600-21626`, and
`get_tree` + `chat` `#21627-23566` (4 model calls).

## Signals

| signal | proposes | weight |
|---|---|---|
| `spine:goal` | the goal step | 5 |
| `spine:why` | each statement of the `why` trees from the goal and from the first pass of the frame's other output lines (25 trees at most); `def` lines left out | 1 (3 in the script) |
| `spine:return` | the return of each project callee on the way, unless it hands a callee's value on (`return f(...)`) | 1.5 |
| `crossing:callback-in`, `crossing:callback-out` | a function of the project called by unrecorded library code (the walkthrough's `tool` moments), at its entry and its last step; a callback from inside a callback of the same function is left out | 3 |
| `crossing:lib-call` | a statement of the project that calls a library | 1 |
| `io:http` | the statement that made an HTTP request | 4 |
| `io:response` | where the response lands: the caller's next step after the requesting function returns (`if reply:`), or that function's last step when its caller is not recorded | 4 |
| `io:file-write`, `io:subprocess` | `open(..., "w")`, `.write*`, `writerow(s)`, `json.dump`, `subprocess.*`, `os.system` in the statement | 3 |
| `exception:raised`, `exception:handled` | every raise; `StopIteration`, `StopAsyncIteration`, `GeneratorExit` and `CancelledError` are not | 3 |
| `exception:rare-arm` | a branch arm taken in at most 20% of 3 or more passes, its first 3 passes | 2 |
| `narrative:binds` | in a frame whose own steps span max(40, 2% of the run): each statement that keeps a call's result, first pass per line | 3 |
| `narrative:text-in` | a call that receives a string of 300 characters or more, 70% letters and spaces, the first time that text goes into a call | 2 |
| `evidence:goal-words` | the 12 values that share the most words and numbers with the goal's text, each at the first step it was bound; a value that holds the goal's own text is the answer and not evidence | 3 |
| `chapter:start` | the step each chapter starts at | 4 |
| `chapter:result` | where the value of a chapter's opening statement lands (its frame's next step) | 3 |
| `walkthrough:<kind>` | small runs: every walkthrough moment (a callback at its own entry) | 1 |

Not signals: a branch arm never taken and a loop that ran zero times (in the ablation, 1,969
PageIndex candidates of which none was worth a stop).

Novelty. A line that runs again is a candidate again only when the call it makes (or the call a
return comes back from) has arguments not seen on that line, at most 4 argument sets per line;
HTTP requests and responses are always candidates. Score: the strongest signal's weight, +0.5 per
further signal group, -0.25 per earlier kept pass of the same line from the same two callers (at
most -1.5), so the first of 13 concurrent requests outranks the twelfth.

Setup weighs 40% of its score: a function named like `__init__`, `validate*`, `check*`,
`ensure*`, `sanitize*`, `normalize*`, `*_config`, `*_options`, `*_settings`, `*_kwargs`, `*cache_key*`,
`defaults`; a statement that builds a `SimpleNamespace(...)` or a `*Config(...)`/`*Settings(...)`/`*Options(...)`,
reads `os.environ`/`getenv`, asserts, or checks `isinstance`.

Module-level statements of a module other than the script (import time) and steps in library
files (except HTTP) are not candidates. A candidate proposed by `spine:why` alone with no value
is dropped.

## Budget

The JSON must stay under `--budget` tokens (default 40,000), estimated at 4 characters a token.
When it does not, each chapter gets an equal share, filled smallest chapter first so what a
small chapter leaves goes to the others; inside a share the candidates go by score, and every
chapter keeps its best 3 whatever they weigh. Values are shaped again after each cut, since a
`sameAs` target may have gone.

## Recall

Measured with the ablation's hit rule (a candidate within 3 steps of a reference stop, or on its
line in the same scope when that line ran once there), at the default budget, against the
ablation's "all four" union of signals (REPORT.md):

| run | steps | references | `pyokka tour` | ablation "all four" | candidates kept / found |
|---|---:|---|---:|---:|---|
| rrf | 243 | 8, written from source | 7 | 2 | 35 / 35 |
| logscan | 4,886 | 10, written from source | 10 | 10 | 32 / 32 |
| lg_fake | 144 | 12, written from source | 12 | 12 | 32 (small run) |
| lg_llm | 105 | 10, written from source | 10 | 10 | 29 (small run) |
| PageIndex | 23,567 | 14 cards of `history.json` | 13 | 14 | 217 / 340 |
| PageIndex chat | (same run) | 8 cards of `chat-tour.json` | 6 | 8 | |
| PageIndex chat | (same run) | 11, written after the cards | 10 | 11 | |

The three PageIndex stops below "all four", and what reached them there:

- `#20181` ("the parent summary"): the response of the 13th concurrent leaf summary, `if reply:`.
  The tour has it unbudgeted; at 40,000 tokens it is a seventh repeat of the line and goes.
  "All four" reached it through `if reply: took True 14/14, other arm never`, a never-taken-arm
  signal the ablation found noise and dropped. The parent summary's own response lands at
  `#20210`, which the tour keeps.
- `#22410` ("the model's instructions"): `_refuse_skeleton(extra_body)`, the step after
  `_openai_agent` was entered with the 2,578-character instructions. "All four" reached it with
  the pre-0.1.7 walkthrough, which filed `_openai_agent` as a callback; it is a plain call. The
  instructions first go into a call at `#22402` (`_conversation_cache_key`), which is where
  `narrative:text-in` puts them.
- `#22889` ("one entry of that tree"): the 7th of 14 recursive `_format_structure` calls; "all
  four" reached it the same way, as a callback.

Runtime on the PageIndex run (10.8 MB `run.json`, 23,567 steps): 0.8 s for the whole command,
0.7 s of it building the tour (25 `why` trees). `tour.json` is 159,584 characters of compact JSON
(39,874 estimated tokens) at the default budget and 234,449 without one; `--json` prints it
indented, 202,364 characters. The estimate is on the compact form, which is what a prompt should
carry.

## Live

`--live` asks the bridge for `recording`: the session's run in the saved-run shape
(`docs/PROTOCOL.md`, "Bridge"), and runs the same code over it. A Debugger session that records
nothing refuses it, as it refuses `walkthrough`.

## Tour view

The panel's TOUR section runs this same command. While the section is open, `src/views/tourPane.ts`
writes each finished run of the bound session (the bridge's `recording` document, built by
`sessionRecording` in `src/agent/bridgeSupport.ts`) to a temporary `run.json` and spawns
`python -m pyokka_runtime tour RUN --json` with the session's interpreter in the runtime directory
(`src/agent/tourRun.ts`). A one-shot child rather than a request to the running runtime: the
runner is the session's program host and may be executing a run; the CLI already reads a saved run,
and a 10 MB recording parsed in a child that exits leaves nothing behind in the runner. 83 ms on the
243-step rrf run. Nothing about chapters or signals is computed in TypeScript; `src/session/tourPanel.ts`
only picks a row's title and one short value.

Narrate Tour sends the prompt file (`dist/prompts/tour-prompt.md`, copied by esbuild from
`skills/pyokka/references/tour-prompt.md`), a blank line, and the compact `tour.json` with every
string redacted, through Narrate's backends. The answer's JSON object goes to `prose.json` beside
the run file and back through `tour RUN --prose prose.json --json` with the same `--goal` and
`--budget`; exit 2 with `{ok: false, violations}` is shown once. The click on a stop is stored in
the workspace state under `pyokka.tour.resume`, per file: `{runId, stopId, key, pass, step}`; a
later run reopens at the same `key`'s same pass.
