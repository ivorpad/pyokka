# Changelog

## Unreleased

- `package-lock.json` said 0.5.4 while the release said 0.5.5, because `scripts/version.py` never
  wrote it. It now moves the lock's two copies of the number with the other four files, and the
  lock is at 0.5.5. The lock was otherwise in sync: `npm ci` on npm 11 installs it as is (npm 10
  reports it as missing vitest's nested esbuild 0.28.2, so use npm 11).
- `review start` plans the whole change. Untracked files are part of it, read as added ones
  (`git ls-files --others --exclude-standard`, so ignored files stay out), and the plan names them;
  before, a new module never reached the agenda and `--only NEWFILE` was refused, which led an agent on
  2026-10-20 to propose a temporary copy of the repository with a temporary Git baseline. Each item now
  lists the repository code its changed lines call, under `uses:` with `file:line` and a stop number
  when the callee is on the agenda, printed in the plan and at the stop; no breakpoint is set for them.
  `--only` limits the diff read to its files, by name, so a change's configuration outside them is never
  read, and lists the changed files it left out. The page server's command line is read with `ps -ww`,
  so a long path no longer makes a running server look stopped.

## 0.5.5

- The `pyokka_review` tool's `test` and `surface` descriptions and `review.md`'s Surfaces section said
  a review of one test stays in chat. That is the `--full` review's rule; the default runs the test
  under the debugger in VS Code, as the smoke of 2026-10-20 did, and the texts now say so. The skill
  gains `references/recovery.md`, each failure signature with what it means and the one command it
  asks for, read when a command refuses, nothing pauses or a pause lands where nothing was set.
  `docs/PLAYBOOK.md` is the person's checklist: nine situations with prompts for Codex and Claude
  Code, the observed lines, pass and fail, and three bare prompts run for real on 2026-10-20.

## 0.5.4

- `review stop` in the debugger prints the change at the pause: the item's removed lines with base's
  numbers and its added lines with head's, `>` on the paused one, then the frame's locals that those
  lines use before the other locals, each text as the runtime sent it. Nothing is evaluated for it;
  only plain names on the changed lines count, so a call or a property never runs. The recorded
  item's breakpoint is removed, so a function called in a loop pauses once. In the smoke test of
  2026-10-19 the agent read the source with `sed` before its first stop, and the stop record cut
  `policy` at 100 characters after the debugger had shown 200.
- `review start` plans in about 3 seconds where it took 20 on a langchain range (66 files, 7,410
  changed lines): the planner parsed each changed file once per span and the edge scan walked a file's
  whole tree once per node. Both now list a file's functions once (`review/syntax.py`), and the
  repository scan keeps no trees and skips files that can define no attribute. The agenda, the
  set-aside items and the edge candidates are unchanged, byte for byte.
- `review start` names the interpreter it chose (`python:` and its source) and the debug session file
  (`session:`), so the agent neither reads the build files nor asks `pyokka_session` for them.
  `--only PATH …` (MCP `only`) sets every changed function outside the named files, directories or
  globs aside before numbering. `skip N [N …]` (MCP `ns`) drops several items in one call, all or
  none. `close` and `report` remove the review's breakpoints from VS Code. The smoke test of
  2026-10-19 made 56 single skips and seven setup commands before its first stop.
- At a live pause the agent reads a value up to 2,000 characters instead of 200 (`--text-len N`, MCP
  `text_len`, 0 for all of it); a value still cut lists its first 20 fields under it, and a hint
  names how to read the rest. The editor's hover and Variables view keep 200. `pyokka_debug`
  `continue` and `pause` take `whole_block` (CLI `--scope`) to lift the 60-line block cap.
- An MCP tool result over 8,000 characters (`PYOKKA_MCP_MAX_CHARS`) is written whole to
  `<pyokka home>/tool-results/` (the temp directory when the home is not writable) and the reply
  keeps its first lines, its last lines with `next:`, and the path with how to read a range; a JSON
  result becomes a small JSON object with the path and a head. In the smoke test one `start` result
  of 65,050 characters was 64 percent of all tool text the model received.
- Browser scratchpads preserve edited drafts before replacement, including reopen from the
  toolbar. Failed saves keep the draft available. Requested reruns wait for their own completed
  state, and history/provenance tools wait for their panel update. The variable-history tool
  opens its populated panel from both Output and the Time Machine.
- WebMCP uses the published browser types and corrects the tools' content and mutation hints.
  Large replies now return a summary and cursor within 1,500 serialized characters. The new
  read-only `pyokka_result` retrieves retained details without repeating the action; CLI and
  HTTP result shapes are unchanged.
- WebMCP cancellation stops undispatched work and retires owned waits. Dispatched work reports
  an unknown outcome until confirmed; scratchpad cancellation does not claim Python stopped.
  Explicit save recovery uses the original version check to avoid duplicate draft versions.
- `pyokka review view --surface vscode|page|chat` (MCP `pyokka_review {action: "view"}`) opens the
  person's view after `start`, when `start` opened none or they moved: the review records the entry in
  VS Code as its own run, or serves the page. Every hint of a review that named `pyokka debug ENTRY
  --record` or `pyokka web ENTRY` names it now, and the `pyokka_debug` description, the
  `pyokka_session` notes and the skill say that the review opens and moves its view itself: a session
  started outside it is another run, which the review does not move. A field review on 0.5.3
  (2026-10-17) had the agent read "a review of one test stays in chat" and start a debug session of
  the test to get a VS Code view anyway; in a Codex harness on the 0.5.3 text, one run in three did
  the same, another reviewed a test file as a program through `--entry`.
- `review start` without `main.py` names the repository's test files and `--test FILE::NAME` as the
  next command; a test file as `--entry` is refused with the tests it defines, since run as a program
  it defines them and runs none. A review of one test says in its `view:` line to tell the person
  before the first stop, and names no command as the reason it stays in chat.
- `pyokka debug` with `--test NAME`, `--cwd`, `--python`, `--args` or `--env` and no FILE or
  `--module` is refused: it read the current pause of whatever session was open and answered a start
  with a finished recording of another file. `--test tests/test_x.py::test_b` with no FILE takes the
  file from the node id. A debug start that ran to its end with no breakpoint and no recording says so
  after `finished:`. `review stop --surface chat` says the stop prints in the conversation.
- A module launch from an agent on a repository that is not an open folder (`review start --test
  FILE::NAME`, `pyokka debug --module pytest`) ran to its end without a pause: the window named its
  first folder as the project, nothing under the repository counted as project code, and nothing was
  instrumented. The project of a launch is now the folder that holds it, else its cwd, in the
  extension and in the runtime alike. `-m pytest` with `--library-code` paused nowhere either, since
  pytest's `__main__` ran as a quiet library import that lasted the whole run; a module launch's
  target is now instrumented as the program.
- `review start` goes on when `$PYOKKA_HOME/reviews/current` cannot be written (a sandbox that allows
  the workspace and /tmp only) and says to pass `--dir`; before, it crashed with a traceback. The
  agenda is the changed functions of the program's files: changes at module level and in test files
  are set aside, listed without a breakpoint (a langchain range planned 355 items, 321 of those kinds).
- `review start` no longer refuses an entry with uncommitted changes. Head is the working tree as
  it stands: that is what head records, what `fix` copies and what `tree_hash` pins, so nothing
  needed the entry committed. A review of in-progress work, where the entry or the test named as
  `--test` is among the edited files, was refused and told to commit or stash first.
- The review method begins before `start`: read the change, ask the person in one question call
  (Claude Code's AskUserQuestion, else in the conversation) what it is for, which areas first and
  where to watch, then plan the changed functions by area with an exerciser each, show the plan
  with its split and take their word on one session or several, one `start` per session in its
  own `--dir`. The skill, its review reference and the MCP `review` prompt say so, and SKILL.md's
  "How a turn ends" lets a review's turn end on that question. `docs/design/review-mode.md`
  carries the contract for the tool's part, not yet built: `plan` from the source diff, `start
  --session K`, `--head REF`, a tree hash per session, `state` and `report` across sessions. The
  plan `start` builds today is one run's footprint: a changed file the one entry never imports is
  in neither its stops nor its unreached lines.
- The Time Machine's Timeline Guide can be hidden and shown again: the eye button in its pane's
  toolbar, or the command `Pyokka: Show/Hide Timeline Guide`. Hidden, the pane keeps its header and
  the width goes to LOGS (a details pane keeps it). The choice is per session, like the step echo
  and the code preview.
- The review runs in the debugger by default. `review start --base REF` plans one item per changed
  function from the diff and starts the entry under the debugger in the person's VS Code, paused on
  entry with a breakpoint on each item, the debugger's recording on for a program; nothing of base is
  run or materialised. The debugger is driven as always (`pyokka_debug continue`, `step`, `eval`,
  `break`), and `review stop [N] --say TEXT` records the pause it is at, refused when the text names
  none of the frame's values; a pause outside every item (an uncaught exception, the person's own
  breakpoint) becomes an item. `skip` removes the breakpoint, `view vscode` starts the program again
  with the remaining breakpoints, `ask` and `look` are refused with the debugger's own commands, and
  `finding add` takes a pause recorded near its line (or a step of the recording; a line never paused
  at takes a try once the program ended). `--full` is the recorded review of 0.5.x, unchanged, and
  `--surface page|chat` implies it, since the debugger lives in VS Code; a `start` with no VS Code to
  reach refuses and names `--full`. The 0.5.3 rule that the review does not move a debugger session
  now holds for the recorded review only. The person's word: the review is a workflow to debug or
  review code, and the debugger is part of it.

## 0.5.3

- A review of one `--test` is never told to record the test file. `stop --surface vscode` on it was
  refused with `next: pyokka debug tests/test_x.py --record`, which runs the file as a program (its
  imports and definitions, not the test); an agent that followed it recorded 217 steps against the
  review's 507 and the next stops moved that Time Machine to the review's step numbers until one
  fell out of range. Now a test review stays in chat whatever surface is asked, at `start` and at
  every `stop` and `ask`: no session or page is probed for it, an asked `vscode` or `page` is
  refused with `next:` the same stop in chat, and no hint names a file run. The `pyokka_review`
  description, its `surface` and `test` fields, `review.md`, `mcp.md` and `pyokka-cli.md` say so.
- A VS Code recording on the entry whose step count is not the head recording's is another run
  (other arguments or cwd, a changed file) and is refused before it is moved, with the command that
  records the review's run; the start hints now carry the review's `--args`. A head recording that
  was cut at the step cap is not compared.

## 0.5.2

- Hovering a value while the Time Machine replays a recording (a review stop, a step back) shows
  Pyokka's hover instead of VS Code's debug hover: the value indented one group per line when it
  does not fit (`src/shared/reprFormat.ts`), with **See value**, **Copy** and **Why**. The adapter
  answers a `hover` evaluate over a recording with no value, which is what makes VS Code fall back
  to the extension hover. See value (the old Explore value) opens the value in DETAILS; for a
  recorded local, which is no entry, it pins one. DETAILS indents a value that has no tree.
- Pyokka's debug inline values provider no longer names variables in the replay session (it skipped
  `record: true` sessions only). The gold `name = value` text at line ends stays while Pylance or the
  Python Debugger extension is installed: VS Code merges every provider's names and reads their
  values off the replayed frame.
- A recorded `ast` node prints its type and scalar fields (`Constant(value=None)`, `Name(id='x')`,
  `FunctionDef(name='f')`) instead of `<ast.Constant object at 0x…>`; `reprs.type_of` reads the type
  back. A `review try --title` reaches the page's Scratchpad, which showed every try as "Untitled
  experiment".
- The review method (the first section of `references/review.md`, which the MCP `review` prompt
  serves, and the built-in prompt) is written on triggers: what the person says decides what the
  agent does before it answers. Asked whether something is right, read the whole function and
  `pyokka review try` it; asked where a value came from, `look` or `pyokka origin`; asked why,
  blame and the PR text. Every command is written with its `pyokka` prefix. Measured on the shopkit
  fixture with Sonnet, five runs per arm, the person asking "is this enough to know the price
  parsing is right?" after stop 1: with the old text 0 of 5 runs ran a try and 3 of 5 called no
  tool; with no text at all 0 of 5 and 5 of 5; with the new text as served, 5 of 5 ran a try and
  read the function, at about twice the cost per answer.
- The review method says how to write to the person, in chat and in a `--say`: one idea per
  sentence of 20 words or fewer, active voice, present tense, the actor named, the imperative for
  what they should do, one fixed word per thing (stop, step, value, try, finding, the person), no
  -ing verb as a noun, no label with a colon, a list and never a table, the answer first and what is
  unverified last. That is the structural half of ASD-STE100; the approved dictionary is not
  applied. Scored as the share of a reply's sentences that pass every structural check, five
  Sonnet runs on the shopkit fixture went from 65% (102 of 158 sentences) to 91% (124 of 136), with
  tables, passive voice and -ing nouns the failures that disappeared.
- The same writing rule, once, in SKILL.md ("How you write to the person"), and in the two prompts a
  model reads on its own: the tour prompt (tour prose) and the narrate prompt (glosses, now also 20
  words, active, the actor named). The show and explain references point at it.
- `tour --prose` and `history --prose` check the prose against the sentence rules and warn, one line
  per sentence that breaks one (over 20 words, a passive form, an -ing verb as a noun, a filler word,
  a synonym for a fixed term, a bold label with a colon, a table row) and one line with the share of
  sentences that pass. Style never fails a merge; the page is still written. `agent/prose.py`.
- A fifth evidence kind on the code-history page, `try`: a sandbox run of code the agent wrote (a
  review's `try`), with its code as the pseudo-file `tries/<id>.py` in the source panel, its inputs
  and mocks, its result and output; no step number and no chain, since it is not a step of the
  program's run. `codehistory.try_card`, the renderer, the template's tag and the evidence tables.
- `pyokka tour RUN --at STEP` (repeatable) forces a candidate at that step: it survives the novelty
  filter, the user-code filters and the budget, carries the `forced:stop` signal and `forced: true`,
  and `budget.forced` counts them. A review passes its stops this way.
- `review report --page [FILE]` and `--tour [FILE]`: the review as a code-history page and as a tour
  of head.json, beside the review or at FILE, never inside the repository. The page has one
  recorded-step checkpoint per stop shown or line asked, in conversation order, the say as its text,
  the fact with base's value beside head's as its note, the `look`s that followed, a finding within
  three lines as its tag, a `why` checkpoint for a value that changed, then the tries as `try` cards;
  every prose field passes through the sentence rules and the warnings come back with the answer.
  The tour forces the stops as candidates and uses the says as prose; a say the tour's check rejects
  (a step number, a value from base) falls back to head's own value, then to a plain sentence, each
  rejection a warning, and an intro of counts falls back to one sentence without them.

## 0.5.1

- The MCP tools can be used without the skill. A Codex session that called `pyokka_review` with no
  skill loaded could not tell where the review would appear, got no readiness check before the
  recordings, no exact next command, a fall-back to chat when it had asked for VS Code, and no `code`
  binary; a review of all 19 tools found the same gaps nearly everywhere. Now every error names the
  next step as the CLI command and as the MCP call (`pyokka debug FILE --record` (MCP: pyokka_debug
  {"action": "start", "file": "FILE", "record": true})) with the caller's full paths; every
  description says where its result lands (a file at `save`, the VS Code window, the browser tab,
  text in the reply) and lists `live` only where the call accepts it; `run` together with `live`,
  `diff` with `after: "live"`, `history pause` without live, narrate with live, verify with both
  `after` and `rerun`, an unknown `http` and an unwritable `save` are refused instead of silently
  doing something else. `pyokka_session` with no arguments is the readiness check: `ready`, a `vscode`
  object (the `code` path, the extension version, `pyokka.agentAccess`, descriptors left by closed
  windows), `recording` per session, and with none open a first note that says what is missing and
  the start call. `review stop` and `ask` on `vscode` or `page` with nothing answering are refused
  with the stop unshown and `next:` naming the start command; `review start --surface vscode` with no
  session and no `code` is refused before recording, `page` on a taken port too. `code` is found in
  `$PYOKKA_CODE`, PATH, the VS Code app bundles, `/usr/local/bin` and `/opt/homebrew/bin`, a failing
  `--open-url` raises at once, and the extension is checked before the URI opens; narrate finds
  claude and codex in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`.
  `pyokka_seek` tells a misspelt name from a wrong `equals` format (`recordedTexts`) from a line that
  never ran; investigate refuses a `value` the run never bound instead of rendering the first
  exception as it; learn refuses `prediction` or `reveal` without `at` and a non-checkpoint `at`;
  verify refuses an existing `test_out` before the rerun and ends a failure with the next command;
  history refuses `pause` on a saved run and an `out` that would overwrite the run. The test suite can
  no longer open the person's VS Code: the review tests' module-scoped fixture ran before the per-test
  guards and launched it on a temp repo on every run; conftest's guard is now session-scoped.
- `pyokka review start` opens the person's view. Until now it moved a session or page that was already
  open on the entry and otherwise printed the stops in chat, so a review started by an agent showed
  an empty editor. The default is a recording session of the entry in VS Code, run to its end with
  the head recording's interpreter, arguments and cwd, and each stop moves its Time Machine.
  `--surface page` serves `pyokka web` on `--port` and opens the tab instead; the review keeps the
  server's pid and stops it at `report`, at the new `review close`, and when `start` runs again on the
  same directory. `--surface chat` (or `$PYOKKA_REVIEW_SURFACE=chat`) opens nothing, and a review of
  one `--test` stays in chat because VS Code records files. A view that will not open leaves the
  review running in chat with a `view:` line that says why.
- The skill was read against the Claude Opus 5.5, Claude Fable 5.1 and GPT-6 guides and not run on
  them (`docs/design/skill-model-compat.md` has the sources and six checks to run by hand). GPT-6 is
  "more sensitive to instructions contained in skills", and all three families stop early to ask or
  to report, which the reader-turn modes need them to do only at the right turns. SKILL.md gains
  "How a turn ends": run the next command instead of asking, end on the deliverable, and stop early
  in four cases (`explain` and `review` while the person watches, two modes fit, something only the
  person can supply, a change to something that is theirs). The person's explicit instruction beats
  the skill. It also says what the program did comes from a command, `explain` messages are plain
  sentences, "Read only that file up front" no longer contradicts the Read-next table, `AGENTS.md`
  lists `review`, and `mcp.md` gives Codex's `tool_timeout_sec` (60 s by default).
  `test_skill_coverage.py` fails on wording that asks a model to write out its reasoning (Claude 5
  models may decline such a skill), on a SKILL.md over 500 lines or 15,000 characters and on a
  description over 1,024.

## 0.5.0

- The Debugger view opens on the frame. Paused at `pyokka debug demo.py --at rrf`, the panel
  showed watches, breakpoints and output and not one variable, the frame's dicts being in VS
  Code's side bar only. A FRAME section now leads the view at a pause: the selected frame's
  variables as a tree (a dict opens to its keys, a dataclass to its fields; a member the runtime
  cut loads on click), the call stack (a click selects the frame), and Continue, Step Over, Step
  Into, Step Out, Restart and Stop; watches, breakpoints and output follow. The rule behind it: a
  debug session opens the panel wherever its values are, the Debugger view for a plain session,
  the Time Machine with Details on the current step for one that records (`--record`,
  `--record-from`); `pyokka.showOutputOnStart` still says whether the panel comes up at all. A
  watch added at a pause from the CLI (`pyokka watches --live --add k`) showed `no value at this
  stop` until the next stop, because only the view's own `+` evaluated; every displayed watch is
  now read at the pause it was added at, and one the frame cannot evaluate keeps that text rather
  than `not evaluable here` (`docs/HANDOFF-debugger.md`, 2026-10-16).
- The README is what Pyokka is, how to install and set it up, and every command: 412 lines, from
  1,745. It says where the `pyokka` command comes from (the extension writes `~/.local/bin/pyokka`
  once `pyokka.agentAccess` is on), how to put it on PATH, and registers Claude Code, Codex and
  mcporter by that full path, which works without the PATH edit. The feature write-ups moved as
  they were to `docs/GUIDE.md`. The skill registers mcporter by the same path, and its listing
  sizes are current (18 signatures, about 3 KB).
- The skill covers the browser page, after an agent on another machine lost a session to it: check
  `~/.local/bin/pyokka` before registering MCP, stay on the person's page and port, the file's
  folder is the run's root (a launcher in `/tmp` makes the project library code), `debug start`
  waits 10 s, every move carries `--say` so the explanation lands in the page's bubble, and a
  sandbox without network access reports no page on 127.0.0.1. `explain` runs on the page too.
- `--session test_routes.py` (and `pyokka_debug`'s `session`) finds a session started with
  `pyokka debug tests/test_routes.py --test NAME`. That launch runs `-m pytest`, so `-m pytest` was
  the session's only name and the test file answered `no live session` while the session sat
  paused. The file a pytest or unittest launch names in its arguments now matches by name, by a
  path ending in it or by its absolute path (`python/pyokka_runtime/agent/sessions.py`). The skill
  takes the name from `state --live`, and says breakpoints from an earlier `--at` still pause.
- The skill's `explain` explains from a move's reply in the same message: an agent stepped, then
  said it would look at the code the reply already held. On the browser page the reply holds one
  line of code after a recording move and none after a `debug` move, so the skill reads the
  function before stepping into it there. A `debug` move leaves the old bubble rather than
  clearing it, as the skill had said.
- The browser page's agent replies carry the enclosing function's code as `block`, the current
  line marked, as the CLI's stops do. A recording move's reply had only the line's text (`code`)
  and a `debug` move's none, so an agent read the file again before it could explain the stop.
  `ctl state`, every move, `debug` and `wait-pause` answer with it; a pause in a file other than
  the main one reads that file from the bridge first. `stopBlock` moved to `src/debug/stopBlock.ts`
  (no Node imports) so the page can build a live pause's block; `web/agentBlock.ts` builds both.
  The skill explains from `block`, and reads the function first only when a reply has none.
- The skill's `explain` no longer says text between tool calls may go unread (Claude Code and
  Codex show it): asked for several stops at once, an agent explains each stop before it moves on.
  Sonnet 5.5 runs against the page's recording, its debugger and `pyokka_step`, five stops each:
  with the 0.4.0 skill, `debug step` on the page got 0 or 1 explanations out of 5 (no bubbles);
  with this one, 5 of 5, each citing a value from the reply. No run reread the file or said it
  would look before explaining. Through `pyokka_debug` in a VS Code window, both skills explained
  every turn of five, in English and Spanish.
- The redactor no longer reaches across a line break for a value. `if not self._small_node_tokens:`
  followed by `return []` became `«redacted» []` in a saved run's copy of the source, because the
  `key: value` rule let the value start on the next line. Key, separator and value now have to
  share a line, in `python/pyokka_runtime/redact.py` and `src/util/redact.ts` alike.
- `pyokka web FILE --cwd DIR` (and `cwd` on MCP's `pyokka_page` open) runs the file in DIR and makes
  DIR the project root when it holds the file, the rule of `pyokka run --cwd`. The page used the
  file's own folder, so a test in `tests/` or a launcher in `/tmp` made the rest of the project
  library code, which the debugger neither stopped nor stepped in. Open accepts files under the
  root, and the page lists the file's imports from it.
- A connection to the page that the system refuses (a sandbox without network access) says so.
  `pyokka web ctl` and MCP's `pyokka_page` printed `no Pyokka page is served on 127.0.0.1:4777`,
  and `node server.js ctl` `fetch failed`, while the page was open; an agent read that and started
  a second page on another port.
- A live stop without a recording no longer says `the recording starts at the --record-from pause`
  when no `--record-from` was given: it says nothing before the pause was kept and that `record
  --live` records from there.
- `pyokka debug` ends its first stop with the name the commands after it take: `session: pass
  --session test_routes.py to the commands that follow (exactly this one: --session
  ~/.pyokka/sessions/41-2.json)`, and `--json` carries it as `session`. A `--test` start is named
  by its test file.
- Review mode: `pyokka review` and the `pyokka_review` MCP tool review a change as a guided debug
  session whose sequence the tool owns. `start --base REF` materialises the base tree, records base
  and head through the entry file (or one test), compares the runs (`diff`, `exceptions`,
  `coverage`, the PR text) and plans the stops: ranked anomalies with a head step (a raise, a type,
  a sign, a None, a print, a value), the changed lines no run reached, and edge candidates from the
  added lines with what to try. `stop N --say TEXT` moves the person's view (the page by `goto`, a
  VS Code debug session by a breakpoint and `continue`, a recording session by the Time Machine,
  chat by printing the stop) and refuses a text that names none of the stop's values. One stop
  per call: the next `stop` after a shown one needs `--go-on`, passed only after the person said
  next; `skip N --why` sets an agenda item aside and `look --expr` answers "what is X here" from
  the recorded values without moving anything; `ask
  FILE:LINE` is the person's question; `try` reproduces in the Scratchpad's sandbox, on the page
  when one is open on the entry; `finding add` refuses without a head step and a reproduction (a
  try id, or a command with `--expect`), except on a line that never ran in head, where a try is
  the evidence; `fix --patch` applies a diff to a copy of head and runs the
  tests there; `report` re-runs every reproduction and refuses when one fails, a finding has none,
  or the tree changed since `start`, and opens with "What we looked at together": the stops, asks,
  skips and looks in order with what was said, then the agenda items not looked at. Every result opens with `review <id> · <phase> · stops K/N
  shown · findings F · tries T` and ends with `next:` and one command. The review lives in
  `$PYOKKA_HOME/reviews/<repo-name>-<base7>/`; nothing is written inside the repository. The server
  answers `prompts/list` with the `review` prompt (`/mcp__pyokka__review` in Claude Code), the
  method from the skill's new `references/review.md`, and the skill has a `review` mode. The mode
  follows a smoke test of a text-only method on a nine-module shop package: agents recorded a
  repro script without `--cwd`, so the project counted as library code, and read `verify` without
  a verdict. `try` runs in the sandbox with the project on its path, and the entry below adds the
  verdict. A stop that finds no page and no session on the entry says which command opens one, and
  a session on another file is never moved: the mode's first VS Code run read "no live VS Code
  session; nothing to move" and went on in chat while the person watched an empty editor.
- `pyokka verify` without `--expect` ends with a verdict line instead of the comparison alone:
  `PASS: no expectations given; the after run has no behaviour difference from the baseline` when
  nothing differs, else `no expectations given; the runs differ in N statements` and the `--expect
  NAME=VALUE` that gets a real one (exit 0; only a failed `--expect` is 1). A reviewing agent read
  the diff, found no verdict and fell back to the test suite.
- `pyokka break --live --remove FILE:LINE` removes a breakpoint by the line that was asked for when
  VS Code resolved it to another line. An agent set `pricing.py:13`, an `except` line, which landed
  on the `return` at line 15; `--remove pricing.py:13` found nothing and it listed and worked around
  it.
- `pyokka origin RUN STEP EXPR` accepts an attribute path (`lines[0].unit_price`) when the recorder
  kept the attribute. It took names and subscripts only, and refused the dataclass field that held
  the bad value.
- The skill's `SKILL.md` is the method and the mode table, 116 lines from 305: setup, the live
  sessions and the band moved to `references/setup.md`, `sessions.md` and `band.md`, the two long
  references open with a table of contents, and `agents/openai.yaml` carries Codex's `interface`
  block. Codex reads skills from `~/.agents/skills` (`.agents/skills` in a repository), so the
  README's Codex step links the skill there.
- The e2e suite keeps its VS Code window minimized for the whole run (`test/e2e/minimized.mjs`,
  called from the `.vscode-test*.mjs` configs): the window opened over the person's work and took
  the focus back whenever a CLI test opened a `vscode://` URI. System Events minimizes it again
  within a second; `PYOKKA_UI_PASS=1`, which photographs the screen, is the one run that keeps it
  up.

## 0.4.0

- The README covers the browser page (`pyokka web`), the 18 MCP tools, the investigation
  commands and the new `run`, `debug`, `break` and `locals` flags. `docs/` drops what had gone
  stale: the QA plan written against the 2026-09-12 build, the demo recording script, the MCP
  server's status note of 2026-10-10 and the September screenshots.
- `pyokka tour` on a saved run whose files are gone keeps the stops in them. It reads the copy the
  run kept, where the redactor put `«redacted»` in place of a value (`max_tokens=«redacted»`); that
  copy did not parse, so the file lost every statement and the tour its stops there. The copy is
  read with `...` in those places, and a line that still does not parse as `pass`
  (`python/pyokka_runtime/agent/tour/astinfo.py` `parse_source`).
- `pyokka web` (and MCP `pyokka_page open`) runs the page's bridge on the Node inside VS Code when
  no `node` is on PATH: VS Code's Electron binary with `ELECTRON_RUN_AS_NODE=1`, found from
  `$PYOKKA_CODE`, `code` on PATH or the app folder, as VS Code's own `code` command runs. The bridge
  clears the flag so the programs it runs do not inherit it.
- A start that finds no Python 3.12+ opens the interpreter picker instead of an error, as VS Code's
  debugger asks for an interpreter. The picker lists the interpreters on the machine with their
  versions: the Python extension's environments, the workspace venv, the PATH, and Homebrew,
  python.org, pyenv, uv and conda installs. The project's `.venv` (or `venv`) is used without the
  Python extension, after the extension's own choice. Apple's `/usr/bin/python3` is never run
  while no Command Line Tools stand behind it, so it no longer opens their installer. VS Code's
  terminals get `~/.local/bin` on PATH while the `pyokka` command is installed there. The README
  has a Requirements section.
- `pyokka verify RUN --after PATH | --rerun [--out PATH] [--ignore NAME] [--expect NAME=VALUE]
  [--test-out PATH]` prints the diff against a baseline and a `PASS`/`FAIL` line per expected final
  value (exit 1 on a failure or an incomplete recording); `--test-out` writes a pytest file that
  reruns the file and checks those values. `diff --ignore NAME` leaves a name's values out.
- `pyokka learn RUN [--at STEP] [--prediction TEXT] [--reveal]` lists up to 12 checkpoints (calls,
  decisions, errors, prints) with their values hidden; `--at` keeps a prediction, and `--reveal`
  prints what the run recorded at that step plus a `match:` line naming the value that equals it.
- `pyokka investigate RUN --value NAME [--at STEP]` prints one value's `var` history, `why` and
  `origin` at its first `nan`/`inf`/`None` or last change (or at STEP), the run's exceptions and the
  project lines that did not run, after `note:` lines on where the recording has gaps (locals limit,
  step cap, `--record-from` start, no `run.finished`, no kept source, cut values).
- `pyokka pin RUN --out PATH` copies a saved run byte for byte to a new owner-only file to keep as
  a baseline (`--live`: the session's recording); an existing PATH is refused with exit 2
  (`python/pyokka_runtime/agent/workflows.py`).
- The Debug Console shows what the program prints during a debug session.
- `pyokka mcp`: the CLI as an MCP server on stdin/stdout for Claude Code, Codex and other MCP
  clients, stdlib JSON-RPC, with tools whose answers are the commands' own text: `pyokka_run`,
  `pyokka_map`, `pyokka_step`, `pyokka_value`, `pyokka_coverage` and `pyokka_debug`, and the twelve
  the entries below add. Add it with `claude mcp add pyokka -- pyokka mcp` (README, "As an MCP
  server").
- `pyokka coverage RUN|--live [--file F]`: per file the statement lines that ran, did not run, ran
  in part or raised; `--file` lists one file line by line with its hits.
- The keys for Start on Current File, New File, Stop Current, Install Missing Package and New
  Python File (⌘K Q, L, S, I, J and their Ctrl+Alt+P twins) no longer fire in JavaScript /
  TypeScript editors, so an extension for those languages can bind the same keys there.
- MCP `pyokka_debug {"action": "start", "file": F, "args": [...]}` reaches the program: the tool put
  FILE after `--`, so the parser read `--args` as an extra positional and refused the call with
  `unrecognized arguments`. FILE now goes before `--args` (`python/pyokka_runtime/agent/mcp.py`
  `words_debug`); a file whose name starts with `-` is passed as `./NAME`.
- `--python NAME` takes a command on PATH, as a shell would: `pyokka run app.py --python python3.12`
  and `pyokka debug app.py --python python3.12` look the name up with `shutil.which`
  (`python/pyokka_runtime/agent/interpreter.py` `on_path`). They used to take it as a file in the
  current directory, so `run` said "does not exist" and `debug` sent the window a path that is not
  there and waited 20 s for a session. A name that is not on PATH is refused at once: `--python
  NAME: no such command on PATH`. A value with a `/`, or one that exists from the current directory
  (`.venv`), is still a path.
- A SyntaxError in an imported module names its file and line: `pyokka run main.py` prints `[error
  @1] SyntaxError: '(' was never closed  (bad.py:2)` and `--save` prints `error: ... (bad.py:2)`,
  where both said `SyntaxError: SyntaxError: ...` with no place. The `error` event's stack starts
  with a `<module>` frame at `bad.py:2` instead of the runtime's loader
  (`python/pyokka_runtime/errors.py` `_compile_frame`), and its traceback ends in the compiler's own
  `File "bad.py", line 2`. Every `run` error line now ends in the `(file:line)` it was raised at.
- A debug run that ends says why: the debug replies carry `finished.error` {type, message, file,
  line} from the innermost frame of the uncaught exception (`src/debug/debugSessionState.ts`
  `uncaughtError`), and `pyokka debug`, `continue --live` and `stop --live` print it under
  `finished: exit N, K steps` as `error: ValueError: too big: 3 (raise_app.py:3)`. A module that did
  not compile is named the same way (`error: SyntaxError: ... (bad.py:2)`).
- A break-when watch that fails to evaluate stops once and says why instead of never firing: `pyokka
  watches --live --add '1/0' --break-when change` then `continue --live` prints `paused at
  loop_app.py:2 (watch 1/0 failed: ZeroDivisionError: division by zero)`, and the next `continue`
  runs on, since the same error does not stop again. The pause carries `watch.error`
  (`python/pyokka_runtime/debugger.py` `_watch_fires`); a name that is not bound yet stays silent as
  before.
- Breakpoint conditions, break-when watches, `continue --until` and recorded watch expressions run
  under the pure rule `eval` already used (`python/pyokka_runtime/pure.py`
  `compile_pure`/`run_pure`), so none of them can change the program. `break --live app.py:4 --when
  'lst.append(1) or True'` pauses with `condition failed: ValueError: cannot call `lst.append` here`
  and `lst` stays empty; a watch the rule refuses stops once with `watch EXP failed: ...`. Each one
  compiles once, when it is set.
- A runner whose stdin breaks (EPIPE after the child died) rejects the requests in flight with
  `Pyokka runner input failed: write EPIPE` instead of throwing in the extension host and leaving
  them to time out (`src/runtime/runnerClient.ts`).
- Bare `pyokka` prints every command and then a first command per job (`pyokka run FILE --save
  run.json`, then `pyokka story run.json --file FILE`; `pyokka walkthrough run.json`; `pyokka debug
  FILE --at NAME`; `pyokka mcp`) and `pyokka VERB --help`, and exits 2; `pyokka --help` prints the
  same and exits 0 (`python/pyokka_runtime/__main__.py` `START`). It used to print one usage line
  and "the following arguments are required".
- `pyokka run FILE --mode profile` ends with `profile: PATH` (the .cpuprofile it wrote) and
  `profiled, no steps recorded, exit N` (`python/pyokka_runtime/cli.py` `_pretty`). The path was
  only inside the `[run.finished]` dict, after a `[trace] 0 steps` line that read like a failed
  runner.
- `pyokka run FILE --cwd DIR` runs the program in DIR instead of the file's directory, with or
  without `--save`; a DIR that holds the file is also the run's workspace root, so the project's own
  imports count as user code, and a saved run records it as `meta.cwd`
  (`python/pyokka_runtime/agent/save.py` `run_dirs`). A DIR that does not exist is refused before
  anything runs.
- `pyokka locals --live` takes `--scope local|global|all` (the function's own names; the
  module-level values the program bound; both), `--names-only` (one `name: type` per line, no value
  rendered) and `--name NAME` (repeatable). Without them it lists the frame's variables as before
  (`python/pyokka_runtime/debugger.py` `Debugger.locals`; the bridges pass `scope`, `names`,
  `namesOnly`).
- `pyokka break --live FILE:LINE --log-message TEXT` makes that line a logpoint (VS Code's
  `logMessage`): it shows in the Breakpoints view and the `break` listing as `log TEXT (logpoint:
  never pauses)` and never pauses the debugger; `break --live --clear` removes every breakpoint and
  logpoint of the session and the editor. Evaluating the message in a debug run is not part of this
  change.
- A `ModuleNotFoundError` raised on an interpreter that is not the project's carries a `hint` when
  the program's project has `uv.lock`, `poetry.lock` or `pyproject.toml` and a `.venv`: `pyokka
  run`, `run --save` and a finished debug run print `hint: ... rerun with --python .venv/bin/python`
  under the error (`python/pyokka_runtime/hints.py`). A run on that `.venv`, or a project without
  those files, gets no hint; the interpreter is never switched by itself.
- On Save sessions rerun when a file they ran changes on disk outside VS Code (another editor, an
  agent, `git checkout`), files outside the workspace included: an open file reloaded from disk
  counts as a save, and an imported module that is not open is watched and reruns the sessions that
  imported it (`src/session/diskReload.ts`, `SessionManager.watchFile`). Each watched file is read
  again 250 ms and 1 s after its watch starts, for a write made while the watch was starting.
  Unsaved edits and On Demand still wait for a run.
- MCP `pyokka_debug {"action": "status", "wait_seconds": 60}` waits for the person to pause the
  program in VS Code (a breakpoint, Pause, a step), then prints `paused after waiting N s` above the
  `state --live` text. With nothing pausing it answers `still running after N s`; a run that is
  paused or over answers at once. `wait_seconds` goes up to 600 (`python/pyokka_runtime/agent/mcp_status.py`).
- MCP tools `pyokka_history` and `pyokka_narrate` wrap `pyokka history` and `pyokka narrate`:
  `pyokka_history {"run": R, "out": "/tmp/s/history.json", "var": ["total"], "why": [{"step": 40,
  "name": "total"}]}` writes the same code-history JSON the command writes and answers its text;
  `pyokka_narrate {"run": R, "dry_run": true}` prints the prompt, `command` picks the model command.
- MCP `pyokka_run` takes `mode` (`normal`, `snaps`, `profile`), `auto_log` and `cwd`, and
  `pyokka_map {"action": "graph"}` takes `expand` (a list of packages), `no_statements` and `dot`,
  the flags of `run` and `graph`. `pyokka run FILE --save R --mode profile` now profiles: `--save`
  used to send mode normal whatever was asked. A profile run's summary says `profiled, no steps
  recorded` and `profile: PATH`, and the saved meta keeps `profile`.
- `pyokka run FILE --test NAME` and `pyokka debug FILE --test NAME` run one test of a test file
  under its runner and record (or pause in) only that test's body: `--test test_b` or
  `--test TestCart::test_total` is a pytest node id, `--test Cart.test_total` a unittest name,
  anything else a pytest `-k` expression. pytest runs as `python -m pytest FILE::NAME -q -s
  --assert=plain -p no:cacheprovider`, so the project gets no `.pytest_cache`
  (`python/pyokka_runtime/agent/one_test.py`).
- `pyokka debug --configuration NAME` starts a `debugpy` or `python` configuration of the nearest
  `.vscode/launch.json` (above FILE, `--cwd` or the current directory): `program` or `module`,
  `args`, `cwd`, `env`, `envFile` (else `${workspaceFolder}/.env`, as the Python extension reads),
  `python`, `stopOnEntry`, and `justMyCode: false` as `--library-code`. `${workspaceFolder}`,
  `${file}` and the other path variables are filled in; flags given on the command line win. The
  answer starts with `configuration "NAME" from PATH (not applied: KEY, ...)`, and an unknown name
  lists the configurations there (`python/pyokka_runtime/agent/launch_config.py`).
- MCP: `pyokka_debug {"action": "start"}` takes `configuration` and `test`, `pyokka_debug
  {"action": "locals"}` takes `scope` (`local`, `global`, `all`), `names_only` and `names`, and
  `pyokka_run` takes `test`, the flags `debug --configuration`, `--test`, `locals --scope`,
  `--names-only`, `--name` and `run --test` give the CLI.
- Skill: SKILL.md tells the agent to read only its mode's file up front, then take flags from
  the job's first command and `pyokka VERB --help`; `pyokka-cli.md` and `live-debugger.md` are for
  a command that fails or a question the help leaves open.
- Skill: `debug.md` treats a debug run that ends without pausing (`finished: exit N, K steps`) as a
  setup failure: read the exit code, the `error:` line and the program's output, find why the stop's
  line did not run, fix the stop or the entry and start again before replying.
- Skill: "Finish clean" in SKILL.md covers the processes the agent started (a `run --keep` runner,
  a `pyokka mcp` server, a background `watch --live` or `shell --live`, a server it launched): note
  each PID and port, stop them and confirm with `pgrep`, or ask the person whether to keep them.
- Skill: SKILL.md's "Use the MCP tools when they answer" sends the agent to the `pyokka_*` tools
  first, then to `mcporter list pyokka --brief` / `mcporter call pyokka.TOOL`, then to the CLI,
  with a table from each CLI command to its tool and what differs (absolute paths, mcporter's
  60 s timeout, state kept in VS Code and the runner). `references/mcp.md` lists every tool's
  arguments and the `mcporter config add pyokka --command pyokka --arg mcp` line.
- Skill: `skills/pyokka/agents/openai.yaml` sets `policy.allow_implicit_invocation: false`, so
  Codex starts the skill only on `$pyokka`, as Claude Code does on `/pyokka`
  (`disable-model-invocation: true`).
- `python/tests/test_skill_coverage.py` holds the skill to the CLI: it fails when a command or one
  of its flags has no synopsis in `skills/pyokka/references`, an MCP argument or action is missing
  from `mcp.md`, a band key (`/pk d`, `/pk g`, ...) or tool action is unnamed, a `PYOKKA_` variable
  is undocumented, the frontmatter holds a plain value with `: `, or either "only when the user
  asks" key is gone. `pyokka-cli.md` gains "Every command" (one synopsis per command, `cache`,
  `serve`, `_child` and `_keep` included) and `PYOKKA_SPAWN`, `PYOKKA_FORK`, `PYOKKA_KEEP_DIR`;
  `debug.md` names `--test` and `--configuration`.
- MCP tools `pyokka_session` and `pyokka_seek` (`python/pyokka_runtime/agent/mcp_session.py`), both
  JSON and read-only. `pyokka_session {"live": true}` reports the open session with the program's
  actual pause (`livePause`) apart from the Time Machine's position (`recordedSelection`) and the
  actions that apply now; with `run` it reads a saved run at `step`. `pyokka_seek {"run", "value":
  "total", "equals": "6"}` answers the first (or `occurrence: "last"`) step where the value was made
  and the step that can read it; `{"run", "file", "line"}` the first or last run of that line. Both
  say when the recording has gaps.
- MCP tools `pyokka_save_investigation {path, run, question, checkpoints: [{name, step}]}` and
  `pyokka_open_investigation {path}` (`python/pyokka_runtime/agent/saved_investigation.py`): the
  first writes a new JSON file (never an overwrite) with the run's relative path and sha256 and
  answers each checkpoint's context; the second reopens it and refuses a run whose sha256 changed,
  since a re-recorded run's steps may be other moments.
- MCP tools `pyokka_investigate`, `pyokka_learn`, `pyokka_pin` and `pyokka_verify`: the four verbs
  as tools whose answer is the command's own text (`python/pyokka_runtime/agent/mcp.py`); a `verify`
  whose expectation fails answers its `FAIL` lines as an error result.
- Editor commands Pyokka: Investigate a Value, Learn from This Run, Pin Run as Baseline and Verify
  Fix run `investigate`, `learn`, `pin` and `verify` over the active session's run and show the
  answer in a Markdown preview (`src/features/investigation.ts`). Pin keeps the run as this file's
  baseline; Verify Fix runs the edited file once and compares it with that baseline, checking an
  optional `NAME=VALUE`. Each takes its inputs as a command argument too (`{name}`, `{step,
  prediction}`, `{expect}`).
- Pyokka in a browser (`docs/WEB.md`): `node dist/web/server.js FILE` (`npm run pyokka-web -- FILE`)
  serves the panel beside a Monaco code pane at http://127.0.0.1:4777/, re-runs the file when it is
  saved, and runs edits typed in the page. `?layout=panel` is the panel alone, for VS Code's Simple
  Browser next to the editor. An agent steps the Time Machine and explains lines in a bubble with
  `node dist/web/server.js ctl step over --say "..."`, the HTTP API behind it, or the `pyokka_*`
  WebMCP tools.
- The page has every view of the panel: Time Machine watches, Variable History and Why, the
  Execution Diagram, HTTP record/replay, Narrate and the Tour (through `claude`, `codex` or
  `PYOKKA_EXPLAIN_COMMAND`), and the live Debugger with gutter breakpoints and its controls
  under the code. Agents get `ctl var`, `why`, `watch`, `break` and `debug`, and the matching
  WebMCP tools.
- The page also has what VS Code opens as editors: the Code Story in the right panel's CODE STORY
  view, following the Time Machine while the code pane keeps the source; Profile, as a table of the hottest functions with the `.cpuprofile` at
  `/api/profile`; Show Instrumented File; Show Logs. The Settings view's run modes work (On Save,
  On Demand), and View Recent Files switches the page to another file the bridge ran. Agents get
  `ctl story` and `ctl profile`.
- The browser page's debugger starts the way VS Code's does: `ctl debug start` runs to the first
  breakpoint and pauses at the first statement only when asked or when no breakpoint can hit in the
  files the run touches (`web/debugHost.ts`, `entryPause`); `break 88 on` then `debug start` pauses
  at `demo.py:88`. `ctl eval EXPR` at a pause runs in the paused frame and answers its `at`, or the
  runtime's own error (`NameError: name 'rect1' is not defined` at line 8).
- The browser page's `ctl debug start` answers as soon as the run ends without pausing (a breakpoint
  that never hits) instead of waiting 10 s, and `debug start`/`debug state` of a run that ended
  answer `exitCode` and `errors` ({type, message, file, line} of each uncaught exception) where they
  said only `running: false` (`web/agent.ts` `debugSummary`, `web/debugHost.ts`).
- `pyokka web FILE [--port N] [--open]` serves the browser page and `pyokka web ctl [--port N]
  state|step|debug ...` drives it, from the installed extension: the vsix now ships `dist/web` and
  the CLI runs its bridge under node (`python/pyokka_runtime/agent/web.py`). It says what to do when
  the page is not built, when node is missing, when the port is taken and when nothing is served on
  the port; `pyokka web -h` names the bridge it runs.
- Page control checks: `state.context` names the live debug run or the recording an agent acts on,
  and `expect` (`ctl --expect-run|--expect-step|--expect-frame|--expect-file|--expect-source`)
  refuses a command once that context moved on. The API refuses two open pages, a second pending
  command and a page that disconnects mid-command with a 409 and the reason, and live debugger moves
  answer only at a confirmed new pause or end.
- Page Step buttons: while the Time Machine is on, the header has Step (the next recorded event) and
  Step back, and the live debugger bar has Step; `ctl step next` and the WebMCP `pyokka_step` kind
  `next` move exactly one recorded event.
- The page bridge starts no recorded run of its own (a save from any editor, a settings change)
  while the live debugger has a run, so a paused program is not executed a second time beside it;
  the page still shows the saved source, and Run or a save after the debug run runs it.
- The page shows the new text of an imported file saved on disk, atomic renames included (`mv tmp
  imported.py`), without moving the Time Machine or the paused debugger and without running
  anything; the bridge re-reads a newly watched file 250 ms and 1 s later for a write its directory
  watch missed.
- `ctl peek NAME` (HTTP `{"action":"peek","name":"cfg.opts"}`) returns a binding of the live pause
  as its ValueNode tree with run, step, frame, file and line, walking a dotted path and expanding
  levels the pause did not capture, without evaluating anything. WebMCP tools register on
  `document.modelContext`, with `navigator.modelContext` as the fallback.
- Page bridge `--no-run` starts without running the file, and the page gets the main file's local
  imports before any run (listed by `python -m pyokka_runtime _imports FILE --root DIR` with stdlib
  `ast`, standard library and site-packages left out). A tab with no unsaved edits reloads itself
  when its bridge comes back on a rebuilt page bundle.
- The browser page answers `ctl wait-pause [--after N] [--timeout MS]` (agent command `waitPause`):
  without `--after` it reads the pause cursor; with it, it returns at the next pause of the live
  debugger (with that pause's state), when the run ends, or after the timeout, at most 25 s. It may
  wait beside one other command, which is how an agent waits for the step a person or another
  command takes (`web/debugHost.ts` `waitForPause`).
- MCP tool `pyokka_page`: `{"action": "open", "file"}` starts the browser page's bridge as a child
  of the MCP server and returns the URL for one browser tab; every `pyokka web ctl` command is an
  action (`state`, `step`, `say`, `breakpoint`, `debug`, `peek`, `wait_pause` up to 25 s, ...)
  answered with the bridge's JSON, an HTTP or page error being an error result; `close` stops a page
  the server started and `list` names them (`python/pyokka_runtime/agent/mcp_page.py`).
- Page: at a debugger pause the code pane shows the frame's values as hovers on identifiers and
  shadows beside declarations (assignment targets, parameters, `for` and `with ... as` targets),
  scoped by the runtime's new `bindings` `identifiers` (ast + symtable, UTF-16 offsets); `ctl
  values` reads them back.
- Page: the shadows beside declarations keep the debug run's code history (`total = 0 → 2 → 6` over
  its pauses), and a function value's hover shows its source: the debugger's `locals` reply adds
  `functionSource` and `functionLocation` from `inspect.getsource`.
- Page: Cmd/Ctrl-click on a name opens its definition in a separate read-only tab; the
  runtime's new `definition` request resolves it with `ast` only, through imports into the project's
  own files (standard library and installed packages open nothing); `ctl definition LINE COLUMN`
  answers what a click opens.
- Page: the Debugger pane colours values, its height drags, and its variables open as a tree; a
  paused value's hover lays a long repr out like `pprint`; the Debugger view's Running header has
  Pause, Restart and Stop.
- Page: breakpoints survive a tab reload and show in a second tab, because the bridge keeps the
  last set the page sent (`debug.breakpoints`).
- Page: Show Variable History, from the code pane's context menu or the "Show history of NAME" link
  at the top of a hover, opens the right panel's Variable view. During a live debug session it
  lists the name's value at each pause and follows new pauses.
- Page: a Scratchpad (the toolbar's beaker, `ctl scratchpad ...`, MCP `pyokka_scratchpad`) runs an
  experiment seeded from the live pause in a separate `python -I`: values that rebuild exactly as
  Inputs, the rest named as unavailable, the source file's imports and definitions copied at their
  line numbers, `unittest.mock` mocks, values beside each line, and no network on macOS
  (`sandbox-exec`). Scratchpads are named, and a saved version is never overwritten.
- Page: `ctl scratchpad say TEXT [--line N]` (MCP and WebMCP `pyokka_scratchpad` `op: "say"`) shows
  an explanation in a bubble under a line of the scratchpad's code; no text clears it, and new code
  in the scratchpad clears it too. `state` answers it as `explainer`.
- Page WebMCP: a 15th tool, `pyokka_scratchpad`. On `document.modelContext` every tool resolves with
  its answer, which the browser hands the agent as JSON once, and a refused command resolves with
  `{"isError": true, "error": "..."}`. Before, the answer arrived wrapped in MCP's `content` text
  and a refusal looked like a success. Each tool has a title and the draft's `readOnlyHint`,
  `untrustedContentHint` and `consequentialHint`; the tools register with one `AbortSignal`, and a
  name the browser refuses later shows on the WebMCP chip.

## 0.3.0

- The band checks a proposed fix on a copy in `.pyokka/band-tmp/` next to the program instead of
  `/tmp/pyokka-band/`, which does not exist on Windows.
- The untrusted-workspace setting's choices and the selection toggle said Quokka; they say Pyokka.
- The repository has a `LICENSE` (MIT). Quokka's docs, screenshots and manifest copied for research
  are no longer tracked, and the README says Pyokka is inspired by Quokka.js, not a port of it.
- `examples/rrf/`: the RRF demo and its FastAPI service, used by the skill's evals.
- The Pyokka band, a Claude Code plugin in `claude-plugin/pyokka-band`: the Time Machine of a VS
  Code session above the Claude Code prompt (code, values, stack, a short explanation, the run's
  bugs), `/pk` keys, fix plans in `.pyokka/findings/`, and a `band` tool for the agent. Install with
  `claude plugin marketplace add ivorpad/pyokka` and `claude plugin install pyokka-band@pyokka`
  (README, "In Claude Code"). The skill shows it when an agent steps through a run with a person.

## 0.2.0

- `pyokka tour RUN|--live [--goal NAME|FILE:LINE] [--budget TOKENS] [--json]`: a run split into
  chapters, and per chapter the steps worth a stop, each with the signals that proposed it and the
  values the program held there, every value from the recording. Chapters are the calls the
  top-level frame makes, and inside a call over 25% of the run one phase per project function its
  orchestrator calls, never cut while concurrent tasks run: on the PageIndex run (23,567 steps)
  the six phases of the published tour, to the step. Signals: `why` back from the output (or
  `--goal`), callbacks from libraries, HTTP requests and where each response lands, file writes
  and subprocesses, raises and rare branch arms, what an orchestrating function keeps, and the
  values sharing the most words with the output. Long values are cut at 300 characters with
  `evidence` windows into the full text, a repeated value is `sameAs` an earlier one, a value
  that grew shows only the part that changed. `--budget` (default 40,000 tokens) keeps the best
  scored candidates in an equal share per chapter. A run with under 60 walkthrough moments is one
  chapter of its moments. 0.8 s on the PageIndex run; schema and rules in `docs/TOUR.md`.

- TOUR section in the panel's Output view, under WALKTHROUGH ("Pyokka: Show Tour"). While it is
  open, each finished run gets its tour from the Python `pyokka tour` (the host writes the
  session's recording to a temporary `run.json` and runs the command with the session's
  interpreter; 83 ms on a 243-step run). It shows the chapter map (title, step range, LLM calls),
  the chapters as folding groups with only the Time Machine's chapter open, and the stops as rows:
  title, `file:line · function · #step`, one value cut to 80 characters, the rest folded. A click
  moves the Time Machine to the stop; the stop nearest the current step is marked "you are here";
  the last clicked stop is remembered per file (by the candidate's `key`, so a re-run finds the
  same statement) and the section reopens there. "Narrate Tour" (the sparkle, or the command) makes
  one model call through Narrate's backends (`pyokka.explain.command`, `claude -p`, `codex exec`,
  Copilot) with `skills/pyokka/references/tour-prompt.md` and the redacted tour, then validates
  and merges the answer with `pyokka tour --prose`; never automatic, cached per run, and a refused
  answer shows its violations once. When the run recorded no variable changes (the editor's
  default) the section says so in one line: on `tour_small.py` that tour has 11 stops against 16
  with them, since repeated calls carry no arguments to tell them apart. Its link turns Record
  Variable Changes on and runs the file once.

- Bridge: a `recording` request returns the session's run as a saved run's `{meta, events}`, which
  is how `tour --live` runs the saved-run code over an open session.

- `walkthrough` and `why` are faster on long runs: a long scope no longer scans each of its steps
  for log entries, and the statement table behind `var` and `why` splits a file's source once
  instead of once per call. On the PageIndex run (23,567 steps) a walkthrough took 1.5 s and takes
  0.8 s, one `why` 0.35 s and 0.07 s; the output is byte for byte the same.

- A saved run whose files are gone reads the copy of each file it kept, so a run moved to another
  machine still shows its source.

- `history`: a value on a card is as long as the run kept it. Cards were cut at 200 characters
  whatever the run held, so a PageIndex page text recorded with `--max-value-chars 4000` showed 218
  of its 3,261 characters. `--value-chars N` cuts shorter; 0 shows every value whole. `--prose`
  accepts a checkpoint's `evidence` links, a JSON list, as `code-history.md` documents; it refused
  them as a field that comes from the run.

- `diff` prints the lines of an edited statement that changed. A multi-line call edited on its
  third line printed `- scores = rrf( …` and `+ scores = rrf( …`, the same text on both sides; it
  now prints `    scores = rrf( …`, `  - k=60,`, `  + k=1,`. A long line is shown from shortly
  before its first differing character. `--json` adds `sourceA`/`sourceB` to edited statements.

- `diff` ignores the memory address in an object's repr. `<function dataclass at 0x101d10720>`
  against `0x101908720` was reported as a changed value of `from dataclasses import dataclass`,
  and was the "first difference" of every run pair that imports a function.

- `walkthrough` and `why`: a lambda or generator expression shows no `out`. With Auto Log on (every
  VS Code session) the `<lambda>` sort keys of `ranked = sorted(..., key=lambda kv: kv[1])` took
  the value logged on that statement, the whole sorted list, as their own result. Saved runs and
  live sessions now agree.

- `walkthrough`: a call's `endStep` is the last step of the call or of anything it called, so a
  function that ends in `return f(x)` ends after `f` ran. `PageIndexClient.chat_completions`
  ended at #22293, its `return run_chat_completions(...)`, while its work ran to #23559.

- `walkthrough`: a function the program's own code did not call by name (a LangGraph node, an
  agents SDK tool, called from library code that is not recorded) is a `tool` moment at its own
  entry step, "callback into classify from ask", with `callerScopeId` naming the function that was
  running. They were filed as calls from the statement at the top of the program that started the
  library: every LangGraph node at `main()` (#18), every PageIndex tool at `client.chat(...)`
  (#22178). The execution graph draws the edge from that caller too.

- `http`: concurrent requests (an `asyncio.gather` of tasks that each make one) carry the step of
  the statement in the task that issued each one. They all carried the step of the last task to
  reach that line, so 13 PageIndex leaf summaries shared one step (#15050).

- `PYOKKA_HOME` moves everything Pyokka keeps under `~/.pyokka` (session descriptors and
  sockets, `last-debug.json`, the library cache, recent files, `config.json`). The extension and
  the CLI resolve it the same way, and the extension passes it to the runners it starts. A
  session socket whose path would exceed the 103-byte macOS limit goes to the temp directory.
  The e2e suite runs with a fresh `PYOKKA_HOME` under `/tmp`, so it no longer sees the sessions
  of an open VS Code window.
- A recording no longer loses data without saying so. A run past the step cap (999,999) prints a
  `WARNING: recording truncated` with the steps it ran, the three files that spent them and the
  `--exclude` to rerun with; `state` and every other verb over that run start with a `note:` line,
  `--json` gets `recording`, and the Time Machine says it under its timeline. `run --max-steps N`
  sets the cap (`pyokka.maxTraceSteps` in VS Code).
- `pyokka run --exclude GLOB` and `--only GLOB` (repeatable; dotted modules or path globs) leave code
  out of the recording: it runs at full speed and records nothing. VS Code:
  `pyokka.timeMachine.exclude`.
- A recorded value cut at its length limit ends in `…(+N chars)` everywhere it is printed, and
  `--json` carries `truncated: true, length: N`. `run --max-value-chars N` (or `pyokka.maxValueChars`)
  keeps more; 0 keeps the whole value up to 1,000,000 characters. A function's return value follows
  the same limit and mark (the scope gets `returnedTruncated` and `returnedLength`), so a function
  returning a 10,000-character prompt shows `returned 'xxx…(+9,882 chars)'` in `context`, the
  `out` row of `walkthrough` and `graph`, and `diff`, where it used to stop at 120 characters with
  a bare `…`.
- `pyokka run` runs the program under the project's Python: `--python PATH`, `$PYOKKA_PYTHON`,
  `$VIRTUAL_ENV`, or a `.venv` next to the file or above it up to the git root, with the runtime put
  on its `PYTHONPATH`. The first line of `run` names the interpreter.

- HTTP record, replay and the HTTP view see async clients. httpx is hooked where the client picks
  its transport, so `AsyncClient` and custom transports count, litellm's aiohttp-backed one
  included; aiohttp's `ClientSession` is hooked directly, streamed bodies reaching the program as
  they arrive. A litellm program making 1 sync and 6 async calls (5 concurrent, 1 streamed) listed
  1 request before and 7 now, and replays all 7 with no network.
- Every function exit records what it returned, on the trace's scope (`returned`, or `raised` with
  the exception type): `return f(x)` inside `try`, `return await …`, returns inside `with` and
  `finally`, a generator's return value. `walkthrough`, `graph` and the panel's call list read it,
  so a call's `out` is its own value instead of a value logged near it (with `--auto-log`,
  `return helper(x) + 1` used to give helper the caller's value). `context` ends the block line
  with `returned VALUE` and lists the statement's calls with theirs. Cost on a recorded loop of
  100,000 iterations and 300,000 returns: 0.80 s to 0.92 s returning ints, 0.81 s to 1.20 s
  returning small dicts; with locals recording on, 1.84 s to 1.94 s.
- The Pyokka panel and Show Output / Focus Output are there with no session. The empty panel has
  two buttons, Start on current file and Debug current file.
- `pyokka history --lang es` gives a page in Spanish: the buttons, legend, chips and card labels
  follow `lang` (`en` or `es`; any other language gets English).
- `pyokka diff before.json after.json` (or `diff before.json --live`) lists what an edit changed,
  statement by statement: assigned values, branch arms, loop counts, calls with their arguments,
  prints and raises, each with both runs' step numbers. Statements pair by their text, so lines
  the edit moved still match. A saved run now keeps a redacted copy of the user's files
  (`meta.files[].source`) so the run from before the edit still has the text that ran.
- `pyokka debug FILE --record-from NAME` (or `FILE:LINE`) records from a pause on: the code before
  it runs at the debugger's speed (a 1,000,000-iteration loop before the breakpoint took 1.17x to
  1.19x a `record: false` run, against about 9x with `--record`), and the pause becomes step 0 of a
  recording that the Time Machine, `why --live`, `var --live` and `history --live` read. Coverage
  covers the whole run. A `why` chain that reaches a value made before the pause ends with `made
  before #0, where the recording started`. `pyokka record --live` at an earlier pause of the same
  run starts the recording there.
- One control surface: the side bar is this moment, the bottom panel is the whole run. The Time
  Machine is a VS Code debug session in replay, so the Run and Debug side bar is no longer empty
  next to it: Call Stack and Variables show the recording at the current step, Watch and hovers
  answer recorded names, Step Back and Reverse Continue sit on the debug toolbar, and clicking a
  caller frame moves to the step that called it. Every move, from the toolbar, the panel, the Code
  Story or `pyokka step --live`, moves the same Time Machine. A `"record": true` debug session
  replays behind its frontier the same way instead of opening a second session.
- The panel drops what the side bar now shows: the Time Machine's CALL STACK and STEP VARIABLES,
  the Debugger view's CALL STACK and LOCALS, and every step, Continue, Pause and Stop button in the
  panel and its title bar. Output, watches, breakpoints, the timeline, ENTRIES and DETAILS, the
  diagram and the story stay. Why This Value moved to the Variables view's context menu.

## 0.1.6

- `--at` repeats on `pyokka debug` and `break --live`: `pyokka debug app.py --at load --at clean
  --at score` sets every stop before the program starts, and `continue --live` walks them in run
  order, across files. The relaunch memory keeps all of them.
- `break --live --remove NAME` removes the function breakpoint `--at NAME` made; before, only a
  `FILE:LINE` could be removed, so an `--at NAME` stayed in the Breakpoints view for good.
- `pyokka debug FILE --record` from a terminal no longer times out: the CLI waited for a debug
  session's descriptor, and a recording one is a run session. It now attaches at the first pause.
  The file opens in an editor too, since a recording session ends with its document.
- A `continue` that runs a recording session to its end answers `finished` instead of `stopped
  answering`: the session's socket waits for the reply it owes before closing.

## 0.1.5

- The debugger needs fewer steps from an agent. `continue --live`, `break --live FILE:LINE` and
  `restart --live` with no debug session start the last `pyokka debug` launch from that directory
  again (remembered in `~/.pyokka/last-debug.json`) and print its first stop, with a first line
  naming what they re-ran, since re-running repeats the program's side effects. `--no-start`
  refuses instead. With nothing remembered, the error now says to start one with
  `pyokka debug FILE --at NAME` rather than to open the file in VS Code.
- With `pyokka.agentAccess` off, a `pyokka debug` from an agent asks in VS Code whether to allow
  agents. Allow turns the setting on and starts that same launch; before, it showed a warning and
  the launch was lost.
- A Debugger pause shows values in the editor: each line of the paused function, up to the
  stopped one, gets `name = value` for the names the frame holds, read from the frame through VS
  Code's inline values. Nothing is recorded for it, so a run of a million steps costs nothing more.
- A cold `pyokka debug` brings the VS Code window to the front at the first stop (`code --goto`),
  because the CLI runs in a terminal and the editor otherwise moves behind it. `--no-focus` or
  `PYOKKA_NO_FOCUS=1` turns it off.
- The skill's `debug` mode starts with `pyokka debug`, never with `break --live`, says when a verb
  re-ran the program, and uses `--record` when the user wants the program's history in the editor.

- One skill, `skills/pyokka`, replaces `pyokka-show-me`, `explain-code` and the `pyokka-agent` and
  `pyokka-debug` pointers. The first argument picks the mode: `/pyokka debug` pauses and steps a
  running program and answers in chat, `/pyokka explain` walks a person through a run in their
  editor, `/pyokka show` investigates and hands over a code-history page. `SKILL.md` routes and holds
  what every mode shares (finding the runtime, sessions, staying out of the user's project,
  cleaning up); each mode's workflow is in `references/debug.md`, `explain.md` or `show.md`, so a
  mode loads only its own. Installs that symlinked the old directories need one link to
  `skills/pyokka` instead.

- `explain-code/pyokka.sh` works in a copy of the skill made by hand: with no Pyokka checkout next
  to it, it runs the `pyokka` the extension keeps on PATH or in `~/.local/bin`.
- The code-history renderer needs no `npm install`. Handlebars and Shiki (Python, the default
  theme, the JavaScript regex engine) are bundled in `skills/pyokka-show-me/scripts/render-deps.cjs`,
  346 KB, and give the same tokens as the full Shiki. The page still opens offline. Another
  `--theme` needs a full Shiki, looked for in `~/.cache/pyokka/render` as well as the working
  directory. `node scripts/build-render-deps.mjs` rebuilds the bundle.
- The show-me skill reads "step", "break" and "test the debugger" as the live debugger even under
  `$pyokka-agent`, answers a check in chat instead of building a page, never builds harnesses or
  edits config in the user's project, treats `0 steps` with `exit None` as a failed runner (a
  sandbox `PermissionError`), and cleans up its breakpoints before reporting.

## 0.1.4

- `pyokka` on PATH without knowing where the extension lives. With `pyokka.agentAccess` on, the
  extension writes `~/.local/bin/pyokka`, a shell script that runs its own `dist/python` runtime,
  and rewrites it on every activation, so a path an agent saved from an older version can no longer
  go stale (`No module named pyokka_runtime` from a `ivor.pyokka-0.0.1` path on a 0.1.3 install). The
  script picks `$PYOKKA_PYTHON`, then an activated venv, then the window's interpreter, and exports
  the editor's own launcher as `$PYOKKA_CODE` when the caller set none, which covers a machine with
  no `code` on PATH. It never touches a file it did not write: a `uv tool install` symlink at that
  path stays. It needs no admin rights. When `~/.local/bin` is not on PATH (a stock macOS), the
  extension offers once to add it to `~/.zprofile` or the bash profile, and copies the line instead
  when the profile cannot be written. Not on Windows. With several editors open, the last window to
  activate wins.
- The show-me skill finds the runtime and the launcher on the current machine, counts the debugger
  ready only at an observed pause in the intended code, tracks the breakpoints it adds, keeps
  `--session` throughout, launches pytest with `--assert=plain`, and uses `history --append`.

## 0.1.3

- The show-me skill says where a live step starts from. `pyokka step --live --into` moves from the
  window's current Time Machine step, not from wherever the previous command left the cursor, and
  the human moves that step too: the Code Story, the panel's timeline and the Time Machine controls
  all jump it. A sequence that had reached step 4 therefore landed at 19, because the window had
  gone to 18 in between, and nothing in the output said so. The skill now states the rule, names the
  tell (a landing the previous stop's `moves:` line did not offer) and documents
  `step --live 18 --into`, which goes to 18 first and moves from there. Only `--json` echoes the
  `from` it started at; the text form still does not. No extension code changed in this release, so
  the vsix is the v0.1.2 build under a new number.

## 0.1.2

- `git push` works on its own after a release. The publish step used `git push origin HEAD`, which
  sends the branch but sets no upstream, so a bare `git push` in the checkout afterwards had nothing
  to push to and had to be told the remote and branch by hand. It is `git push -u origin HEAD` now,
  and the first release sets the tracking the rest of them rely on.

## 0.1.1

- The vsix stops shipping the session notes. Packaging v0.1.0 listed its contents and `handoffs/`
  was in them, 32 KB of working notes that `.gitignore` keeps out of the repo and `.vscodeignore`
  had never been told about, alongside `.pytest_cache/` and the e2e launcher config. Every build
  back to 0.0.1 had carried them into the extension folder of whatever machine installed it. The
  four are excluded now, and `vsce ls` reports the package as `dist`, `media`, `snippets`,
  `syntaxes`, `examples` and the three top-level documents, nothing else.

## 0.1.0

- A build moves the version, and a release puts the vsix on GitHub. Four files carried the number
  0.0.1 and nothing ever moved them, so every build overwrote `pyokka-0.0.1.vsix` and an installed
  extension could not be told apart from the one before it. `scripts/version.py` is now the only
  thing that writes them and it writes all four together, `package.json` deciding and the manifest
  generator's fallback literal included, which left stale would have regenerated 0.0.1 again the
  next time anyone deleted the manifest. The level comes from a `Bump:` trailer on the commits since
  the last tag, patch when none of them says otherwise, so subject lines stay prose and the trailer
  sits where `git log --oneline` does not show it; `.githooks/commit-msg` rejects a misspelled level
  rather than letting it fall back to patch and ship the wrong number. The next version is computed
  from the tag rather than from the current number, which is what makes five builds before a commit
  land on one new number instead of walking five, while a commit that later carries `Bump: minor`
  still escalates that same pending release. A `PreToolUse(Bash)` hook,
  `.claude/hooks/bump-version.sh`, bumps ahead of any command that packages or installs, because a
  hook cannot rewrite the command and a bump after the build would stamp the artifact with the
  previous release's number. `scripts/release.sh` runs the whole pass: checks first so a failure
  leaves the tree clean, then bump, cut `## Unreleased` into a `## X.Y.Z` section, build, install,
  annotated tag, push, and `gh release create` with the vsix attached. Releases go to a private
  `ivorpad/pyokka`, and the cut changelog section is the release body, so the notes are the ones
  written while the work happened rather than a list of commit subjects assembled afterwards.

- What an agent reads at a debug stop is bounded by the code, not by three round numbers. All three
  boundaries in the stop reply were drawn by counting: the output was the last 4000 characters of
  everything the program had ever printed, the block was 60 lines centred on the pause, and the
  frame chain dropped every frame Pyokka had not instrumented. The last was the worst. The
  `http.server` fixture pauses in a handler eight frames below `serve_forever`, and the reply said
  `do_GET` and then stopped: a chain the program never had, with nothing saying frames were
  missing. Runs of frames with no source are now folded where they stand into
  `{elided: 8, where: "library", in: ["http/server.py", "socketserver.py", "threading.py"]}`, which
  can name the files because an uninstrumented frame now sends its own `path`. The block keeps the
  signature however far down the function the pause is and spends the rest of its budget on the
  suite the paused line is in (the loop body, whole) instead of a window that can open on the tail
  of one statement and close on the head of another; it carries `totalLines`, and the CLI prints
  `… 299 lines` at each gap rather than a bare ellipsis. `output` is now what the program printed
  since the previous stop: an agent stepping ten times was reading the same 4 KB ten times and
  could never tell which line its own step produced. It reads `output (2 new lines; 412 earlier)`,
  or `output: nothing new since the last stop`, with `seq` and `earlier` placing the delta in the
  run; `--scope` and `state --live` still answer with the whole 64 KB window. The cursor sits on
  the session, not the connection, because the CLI opens one per command, and re-reading a stop
  shows its delta again instead of eating it. Watched against running programs, not fixtures
  (`test/e2e/debug-live.test.js`, `test/e2e/debug-server.test.js`).

- A failed `--live` command says which session took it. When no session of the kind a verb wants is
  open, the CLI serves it from the other product, which is usually right: `debug --live` asks a
  recording session's window to launch. When the command then fails, the host answers about the
  session it landed in and never says a different one was wanted, so `continue --live` after a
  debug run has ended reports `no debug run in progress` from a window you were not asking about,
  and the only way to see the substitution was to read `~/.pyokka/sessions` by hand. The hint now
  carries it: `no debug session here: this is the run session on api/main.py. \`pyokka debug FILE\`
  starts one.` A session named outright, or one that is the kind the verb asked for, stays quiet.

- The Debugger view uses the width it is given. It was built to the shape of VS Code's Run and
  Debug sidebar, a single narrow column of 22px rows, but it is contributed to `panel`, where it is
  as wide as the editor: every row used about a quarter of that, and LOCALS truncated a long repr
  with 1500 px of empty space beside it. Past 900 px the pause context takes the left column and
  output the right. The rule is a container query, so it follows the panel the user drags rather
  than the window, and narrower the columns stack into the single column the view has always been,
  with output leading while the program runs. Clocks are printed where they change instead of on
  every row: a `print()` of ten lines arrives as one chunk with one timestamp, so ten copies of
  `1m 07s` ran down the gutter and read as noise, and where the clock does change it marks where a
  burst began. The watch add form can now make the watches it never could. It called
  `onWatchAdd(exp)` and dropped the second argument, so `+` only ever made a displayed watch
  however it was meant, and break-when was reachable from the CLI alone; a mode names the two kinds
  the way `--break-when true|change` already does.

- The Debugger view works while the program is running, not only after it stops. It was built for
  the moment after a pause: with `stack` empty unless paused, `LOCALS` gated on `paused` and every
  watch reading `no value at this stop`, four of its five sections were dead for the whole length of
  a run — and the one that was not sat last, capped at 320 px, and never scrolled, so the tail ran
  off the bottom while you watched a stale window. An agent script is almost never paused: a run of
  the travel-concierge cookbook takes forty-odd seconds, fourteen of them printing nothing at all.
  Now the sections are ordered by what is live — output leads and takes the free space while the
  program runs, stack and locals lead at a stop — the pane follows its tail and parks when you
  scroll up (the `atBottom` rule the run-all list has always had), and a watch says `at the next
  pause`, which is what is actually true. An activity row above the pane answers what a spinner
  cannot: elapsed, bytes printed, how long ago the last byte came, and a trace of characters per
  half second. Every figure is measured from what the host already had. Sampling the top frame while
  running would be the most useful line in that row and is deliberately not there — it needs the
  hook to report a frame without stopping the program, which is its own question — and watches are
  still not evaluated mid-run, because that runs program code at an arbitrary point, which is what
  run-all is for.

- Output carries the stream it came from, when it arrived, and its colour. The runtime always sent
  `stream` on every write and `appendOutput` threw it away, so httpx's INFO logs and a traceback
  were indistinguishable from the program's answer; stderr now keeps its own colour and can be
  hidden. Rows are stamped with when they arrived, a silence longer than three seconds is drawn
  between the rows either side of it, and the head the 64 KB window cut is a marker rather than a
  note in the section header. ANSI escapes were printed as literal text — nothing in the webview
  decoded them — so rich and colorama wrote `ESC[2m ESC[36m` into the pane; SGR now resolves to
  VS Code's own `terminal.ansi*` colours, and a `\r` repaint shows the last frame the way a terminal
  shows a progress bar rather than every step of it. The line the program is still writing is marked
  as open, which is what `print(delta, end="")` produces: the old tail kept the last 500 *lines*, and
  a token stream is one line however long it runs, so the window did nothing and the 64 KB cut landed
  mid-token.

- The panel is sent the output that is new, not all of it, ten times a second. `state()` put the
  whole 64 KB window in every push and `scheduleOutput` pushed every 100 ms, so the cost was
  O(buffer) per tick with a `redact()` pass over text the view already had. `debug.output.append`
  carries only what the view has not seen; when a delta does not continue where the view left off it
  asks for a full `debug.session` and the host resends, so the existing message stays the initial
  sync and the recovery path and nothing about the first paint changes.

- A secret is no longer at risk of being missed when it straddles two writes, and a long line no
  longer wedges the extension host. `redact()` matches whole tokens and `key: value` pairs, so it
  only catches a split secret if it sees both halves at once — which the old whole-buffer rescan got
  for free and a delta does not. A line is now redacted when it completes, with the end of the
  previous line as context (`password:` on one line still reaches its value on the next), and the
  incomplete trailing line is redacted afresh and sent whole every time rather than as a delta.
  Separately, `redact()` backtracks quadratically in the length of what it is handed: 64 KB on one
  line costs about 2.4 s against 0.3 ms for the same bytes as short lines, and the shipped code ran
  it over the whole buffer every 100 ms — so a program printing one very long line, which is exactly
  what token streaming is, could hang the host. It is never handed more than a kilobyte at once now,
  with the end of each redacted slice carried into the next as context.

- A command served by the other product says so when it fails. Only one kind of session may be
  open, so a debug verb is answered by a recording session (and the reverse), which is usually what
  you want: `pyokka debug FILE` asks a recording session's own window to launch. When the command
  then fails, the host's reply describes the session that took it and cannot know a different kind
  was wanted, so `continue --live` after a debug run ended reads as `no debug run in progress` from
  a window nobody asked about. The hint now carries `no debug session here: this is the run session
  on api/main.py. \`pyokka debug FILE\` starts one.` Nothing changes about which session is chosen,
  and a session named outright with `--session` is a choice rather than a substitution, so it stays
  quiet.

- `var` and `why` say `(same object)` where they said `(unchanged)`. The change marker for a
  local is `(id(value), len(value))`, so `scores[document_id] = scores.get(document_id, 0) + c`
  on a key that is already there keeps both, records no change, and the value shown is the one
  from before the statement. `(unchanged)` asserted that the program had not changed it, which
  was false; `(same object)` says what was actually observed, and for a scalar it means the same
  thing it always did. Reproduce on the RRF demo at #84, #96 and #102. Folding item identities
  into the marker fixes the detection and costs 131% more wall time on a locals-heavy loop
  (measured, 6-key dict over 20,000 iterations), so the real fix is for the instrumenter to say
  which names a statement assigns and scan only those; `docs/HANDOFF.md` has the measurement and
  the plan.

- An agent explains through a generated page, not a typed one. `pyokka history RUN --at STEP`,
  `--at FILE:LINE`, `--var NAME`, `--why STEP NAME` and `--live --pause` write the data behind a
  two-panel code-history page: numbered source left, chronological checkpoints right, dim
  context, green lines that ran, amber current line and values. Every selector is a call on the
  same `RunSource` seam `context`, `var` and `why` use, so every value on the page is what
  `pyokka context RUN N --json` prints and every checkpoint carries that command in `verify`. A
  checkpoint also carries the step number, the `in` and `out` of a call at its line, the line's
  hit count, and the arm a branch took across every pass (`took False x2, True x1`, rather than
  whichever pass the walkthrough listed last), which is what a one-frame debugger cannot show.
  Prose (`heading`, `summary`, `title`, `text`, `note`) is left empty and merged from
  `--prose PATH` keyed by checkpoint id; a prose file that names a generated field fails with
  `prose may not set "values" on step-55`, so the same file survives a re-run and only the
  numbers move. Checkpoints appear in the order the flags were written, through one shared
  argparse action, because a page is a narrative, and `--append` adds a run's checkpoints to the
  page already at `--out`, which is how one page follows a live program through several pauses
  without anyone merging two files by hand. The verb refuses a stale run outright, reports
  what a `--limit` cut in `meta.truncated` instead of dropping it silently, and redacts the
  source lines it puts in the page and names each one, because an HTML file travels further than
  the terminal `pyokka context` already redacts for. Four evidence kinds are kept apart and the
  renderer refuses anything else: `recorded step`, `live pause` (no provenance chain, because a
  `record: false` session recorded nothing behind the pause), `static source` (no values) and
  `gloss`. A live pause is read with `context` alone, which needs no new bridge verb and never
  moves a session the user is looking at. `skills/pyokka-show-me/templates/code-history.html.hbs`
  and `scripts/render-code-history.cjs` render it into one standalone file with no CDN. The
  Python is coloured by Shiki at render time and the page carries the tokens, so a theme costs
  the reader no network; `--theme` takes any bundled theme and the default is
  `github-dark-dimmed`. Handlebars and Shiki (new devDependencies) resolve from the working
  directory, then the skill's own directory, then `--handlebars-module`; without Shiki the page
  still renders, in plain monochrome. The design is `docs/design/show-me.md`.

- One skill for Pyokka. `skills/pyokka-show-me/SKILL.md` is what an agent loads to do anything:
  both products and when each applies, saved run against live and how a session is found, the
  verb table, the three routes of `pyokka debug` and the URI question, `exec` and the modified
  banner, `--library-code`, staleness, secrets, what cannot be done, and one phrase-to-command
  table merging the two that existed. It explains through the code-history page by default, on
  "show me" and without it. `skills/pyokka-agent/SKILL.md` and `skills/pyokka-debug/SKILL.md`
  keep their descriptions, which are what make them trigger, and shrink to pointers: their
  content is now `references/pyokka-cli.md` and `references/live-debugger.md`, one source of
  truth for one CLI. `skills/explain-code/SKILL.md` keeps its method, because explaining to a
  person while the editor follows the stops is a different job from handing over a page.

- The Debugger is its own product. F5, the Run menu, the panel's Debug button, "Pyokka: Debug
  Current File" and `pyokka debug FILE` create a debug session, not a run-all session: it holds
  the launch configuration (`program` or `module`, `args`, `cwd`, `env`, `python`,
  `stopOnEntry`, `breakOnException`, `libraryCode`, `record`), owns a runner child of its own,
  runs the program at full speed and stops at a breakpoint or an exception. Nothing is recorded,
  nothing re-runs, nothing is "finished": when the program exits or Stop is pressed the session
  is gone. No run timeout applies while a debugger is attached, recording or not, so a paused
  server stays paused. An edit while paused is accepted and simply not applied until the next
  start. A file may have a run-all session and a debug session at the same time; they share VS
  Code's gutter breakpoints and nothing else. `"record": true` in a launch configuration is the
  other half: today's recording debug run, with the Time Machine over the recording, reached
  explicitly and never by default. The design is `docs/design/debugger-product.md`.
- The runtime records nothing in debugger mode. `config.record: false` with `config.debug` emits
  `run.started`, `file.instrumented`, `output`, the pause and resume events, the typed replies,
  one `error` for the exception that ended the run and `run.finished`, and never a `trace`, a
  `coverage`, a `log`, a `locals`, a `time`, a `watch` or an `http.exchange`. A second hook set
  (`hooks_debug.py`) costs one integer increment and one list read per statement, a dict lookup
  while a breakpoint is armed, and touches no frame until a reason fires. Step Over and Step Out
  keep nothing per call: `_pk_f` hands out a per-call id and the `_pk_x` the instrumenter already
  calls from a `finally` tells the debugger when the frame it is stepping in has returned. A frame
  that suspends at a `yield` or an `await` lands where it resumes. A Step Over or Step Out whose
  frame exits into code that is not instrumented (a request handler returning into its framework,
  a thread target, a library callback) has no frame of ours to come back to, so it degrades to the
  next statement of the program's own code wherever it runs, the way a debugger with "just my
  code" does; a frame that returns to an instrumented caller or to the module body waits for that
  caller as before. At a function-entry pause frame 0 of the stack reports the `def` line the
  pause reports, so the Call Stack and the editor agree. Measured on a 500,000-iteration loop
  (1,000,003 statements) with one breakpoint set in a function nobody calls, so the lookup runs on
  every statement and never hits, wall time with process start, Python 3.14.6: plain python 0.05
  s, run-all through the runner 1.53 s, the debugger 0.28 s, today's recording debug run 2.59 s;
  on 3.12.9: 0.03 s, 1.01 s, 0.19 s, 2.37 s (`scripts/bench-debug.py`).
- A debug stop shows the real stack. Without a recording `debug.paused.stack` comes from the
  frames themselves, so a caller points at the call and not at its `def` line, a frame outside
  instrumented code is listed with `fileId: 0`, and `frameId` addresses each one: `evaluate`,
  `complete` and the `locals` action take it, the Call Stack view lists every frame with its own
  line and scopes Variables to the selected one, and `locals --live --frame N` / `eval --live EXPR
  --frame N` read a caller frame. Every pause in both modes names its thread as `thread: {name,
  ident}`.
- Servers pause in their handlers. A breakpoint in a request handler stops when a request
  arrives, `continue` answers it, and two requests in flight pause one after the other with a
  `debug.resumed` between them: exactly one thread is paused at a time, so no command takes a
  thread argument. `pause` while the only thread sits in `accept()` answers `{ok, paused: false}`
  and the stop arrives with the next request. `continue --live --no-wait` resumes without waiting
  for the next stop and `pause --live --no-wait` asks for a pause without waiting for it, which is
  what an agent wants against a server. Uvicorn's `--reload` and Flask's `--debug` run the code in
  a worker the debugger never sees; the README says to drop the flag.
- A run can be a module. `run.module` does what `python -m` does (`sys.argv[0]` is the module's
  file, the cwd goes on the front of `sys.path`, the module runs as `__main__`, a package runs its
  `__main__`), and `launch.json` offers three shapes: a file, a file with recording, and a module
  with arguments.
- A Debugger view in the panel, separate from the Time Machine view: laid out like VS Code's own
  debug panes. A status row names why the program paused (an icon per reason, `api/main.py:52` as
  a link that reveals the line, the reason as a chip, the thread at the right), then pane headers
  with counts: CALL STACK (the current frame highlighted, a click reveals a frame and scopes the
  variables and `eval` to it, two or more consecutive library frames folded into `3 frames in
  library code`), LOCALS with the scope in the header and a chevron that opens a value's members,
  WATCHES (a `+` reveals the input; each row shows its `break when true` or `break on change`
  badge), BREAKPOINTS with the pause-on dropdown in the header (red dot for a resolved one, hollow
  for one the runtime has not resolved, and two or more in a file the run never instrumented
  collapsed into one line, `4 in demo.py, not in this run`), and OUTPUT as the program prints. A
  write from the console shows as a warning banner, an exception as an error banner. Continue,
  Pause, Step Over, Step Into, Step Out, Restart and Stop sit in the panel's title while the view
  is showing, and a second status bar item reads `Debugger: paused at app.py:42 (breakpoint)` or
  `Debugger: running`. Starting a debug session brings the panel to the Debugger view under the
  same `pyokka.showOutputOnStart` a run obeys, with the caret left in the editor; the launch row
  shows paths relative to the workspace. The Time Machine view is untouched and still shows a
  recording debug session.
- `pyokka debug app.py` starts a debug session from a terminal and prints the first stop; a file
  or `--module M` implies `--live`. It takes `--args ...` (everything after it goes to the
  program), `--cwd DIR`, `--env K=V`, `--python PATH`, `--at FILE:LINE`, `--stop-on-entry` and
  `--library-code` (step into and pause inside third-party packages too; off by default). The
  launch line of `state --live`, the status bar tooltip and the Debugger view name the interpreter
  the session actually runs, and `library code: on` when it is. Three routes are tried in order: a
  debug session of the file that already exists (its pause is printed, so "start the debugger"
  twice never loses it), a Pyokka session on the file (that window starts the debug session, no
  URI needed), else `code --open-url` with a `vscode://ivor.pyokka/debug?…` URI the window answers
  through a URI handler (activation event `onUri`), after which the CLI polls `~/.pyokka/sessions`
  for up to 20 s. A debug session's bridge socket obeys `pyokka.agentAccess` exactly as a run-all
  session's does, and with the setting off the URI is refused with a warning naming it. The first
  URI also needs a click: VS Code asks whether to let Pyokka open it and waits, so the CLI can
  time out while the question is on screen; Open starts the session however late, `pyokka state
  --live` then finds it, and `ivor.pyokka` in `extensions.confirmedUriHandlerExtensionIds` stops
  the question. The CLI's timeout message says so first, then names the setting. `$PYOKKA_CODE`
  overrides which `code` binary is used.
- Two kinds of bridge descriptor. Run-all descriptors gain `"kind": "run"`; a debug session
  writes `"kind": "debug"` with a `launch` object. The CLI prefers by verb: `debug`, `continue`,
  `pause`, `stop`, `restart`, `break`, `watches`, `locals` and the executing `step` kinds pick the
  debug socket, `why`, `var`, `story`, `walkthrough`, `graph`, `exceptions`, `http`, `values`,
  `find` and `steps` pick the run socket, and `state --live` lists both sessions of a file with
  the debug one first and `[this]` on the one it is connected to. The verbs that read a recording
  are refused on a debug session with `<verb> needs a recording`, and so are the backward moves
  of `step`.
- Exception tracking without a recording keeps nothing. The first sighting of an exception is
  remembered by identity alone (the last 256 exception objects), and with `breakOnException:
  "off"` a non-recording run installs no `sys.monitoring` callbacks at all; the `exceptions`
  action installs and removes them in flight.
- The Debug Console runs statements. `context: "repl"` is an `exec`: `rank = 3`, `items.pop()`,
  `import json`, a `del`, a multi-line block all run in the paused frame, and the value of a last
  expression statement comes back the way a REPL shows it, masked like every other value and with
  a bag the Variables view can open. The write reaches the program's own variables: at module
  level it lands in the module dict, on Python 3.13 and later in the frame's write-through locals
  (PEP 667), on 3.12 through `PyFrame_LocalsToFast`. A name the function declares is read back by
  its code when it continues; a brand-new name stays readable through the console, `eval` and
  `locals`, but the compiled code has no slot for it. A statement that raises is not a failed
  request: its type, message and traceback come back, the console prints `ZeroDivisionError:
  division by zero`, and the program stays paused where it was. Editing a row in the Variables
  view is the same `exec` of `name = value` through `setVariable`. Hovers, the Watch pane,
  break-when watches, breakpoint conditions, `eval` and completions keep going through the pure
  evaluator and cannot write.
- Once anything has been executed the session says so until the next run: `modified: true` rides
  on every later `debug.paused` and on every `locals` reply, the CLI's stop line gains ` (values
  modified from the console)`, the Debugger view shows a banner and the status bar tooltip repeats
  it. Any attempt sets it, a statement that raised included, because one that raised halfway may
  already have written.
- `exec` needs a frame, so it is served only while the program is paused, in both modes, over the
  runner (`exec` request, `executed` reply, capability `exec`) and over both bridge sockets. While
  the program runs the answer is `the program is running; pause it first`; after it has ended,
  `the run has ended; there is no frame to execute in`, rather than the finished run's namespace
  that `evaluate` falls back to. `pyokka exec --live 'rank = 3'` is the agent's form, `--frame N`
  for a caller's frame: an expression prints its value, a statement prints `ok`, a raise prints
  the error on stderr with exit code 0 and `still paused at app.py:42` on stdout, and source that
  does not compile is a failed command (`SyntaxError`, exit 2).
- A breakpoint can name a function. `{function: NAME}` in a breakpoint spec, `--at rrf` on `pyokka
  debug` and on `break --live`, and `setFunctionBreakpoints` from VS Code's Breakpoints view (the
  CLI's function breakpoints are mirrored there too) pause at every call, before the function's
  first statement. The runtime resolves the name as each file is instrumented, so a module
  imported later gets its breakpoint when it loads, which an AST scan of the file could not do,
  and the echo reports the file and the `def` line it landed on. `Ranker.rank` matches the method
  `rank`; the class is not checked. When a second file defines the name the first keeps the
  breakpoint and the echo says `also defined in lib/rank.py:2; give FILE:LINE to pick one`.
- Three moves save an agent a round trip each. `continue --live --to demo.py:82` runs to a line
  through the run-to-line breakpoint the pause already has; `continue --live --until 'rank == 3'`
  installs a break-when watch for that one resume and removes it after the stop, or after the run
  ends instead; `step --live --over --count 3` takes three stops and prints the last, and when a
  breakpoint, a watch or an exception wins on the way the reply says after how many steps
  (`stoppedEarly`), and when the program ends mid-count how many it took (`stepped`). `count` is
  clamped to 1..1000.
- Recording is opt-in and has a door. "Pyokka: Debug Current File (Recording)" sits next to the
  Debug button in the panel's title and in the palette; `"record": true` in a launch configuration
  and `pyokka debug FILE --record` are the same start: the Time Machine, the Code Story and `why`
  open over the run at every pause. A recording launch honours `args`, `cwd`, `env` and `python`
  (when the file's run-all session already runs in another interpreter the start is refused and
  names the session to stop first), and a `module` launch with `record: true` is refused, because
  a recording session needs a file.
- `skills/pyokka-debug/SKILL.md` is the skill for driving the live debugger: the phrase-to-command
  table ("break at rrf", "run to line 82", "set rank to 3 and carry on"), the `shell --live` loop,
  what an `exec` does to a bug report, and when a question needs `--record` instead.
  `skills/pyokka-agent/SKILL.md` stays the one for reading a recording and points at it;
  `AGENTS.md` names both.
- Every debug stop an agent gets carries the paused frame and what the program printed.
  `debug`, `continue`, `pause`, `step` at the frontier, `restart` and `context` all answer with
  the slice plus `paused`, `locals` and `output`, where before only `context` added the locals
  and the program's output was invisible: reading the frame cost a second `locals` call, and a
  print that explained the pause could not be seen at all. A session now keeps what the program
  printed in arrival order, the runtime's `print` entries and the raw writes it forwards, the
  last 64 KB of it, and a stop carries the last 4000 characters as `{text, truncated}`, redacted
  like every value. The text form prints the frame under `locals:` and the tail under `output
  (last N lines):`, the last 20 lines, 200 with `--scope`, and nothing when the program printed
  nothing.
- The exception pause, host side. A debug run sends `config.breakOnException`; the mode (`off`,
  `uncaught` by default, `raised`) is kept per session across runs and across Stop. The
  Breakpoints view gets the two standard checkboxes, Uncaught Exceptions ticked, and
  `exceptionInfo` fills VS Code's banner over the paused frame with the type and the message. The
  panel's header, the status bar and the CLI say `uncaught ValueError: too big: 3` or `raised
  ValueError: too big: 3` instead of a bare reason. An agent sets the mode with `pyokka break
  --live --on-exception off|uncaught|raised`, which reaches the run in flight at once; every
  `break` reply and `state.debug` report it, and the stop carries `exception: {type, message,
  uncaught}`. VS Code reports `filters: []` for a debug type it has not shown yet, so a filter
  list that arrives during configuration is only taken when it asks for something other than the
  declared default; a click in the Breakpoints view during a session always applies, and the view
  cannot be told about a mode set elsewhere. A `disconnect` that arrives after the run it
  belonged to has ended no longer turns debug mode off under a run that started in the meantime.
- A debug run stops where an exception is raised. `config.breakOnException` and the `debug`
  action `exceptions` take `off`, `uncaught` (the default) or `raised`. `uncaught` pauses on the
  exception that ends the run, before the `error` event, with the traceback's innermost user
  frame live: a frame that has returned still answers `f_locals`, so `evaluate` and `locals`
  show the values as they were when it raised. `raised` also pauses at the first sighting of
  every exception in a user file, before it unwinds, the only moment a handled one can be
  inspected. `debug.paused` carries `reason: "exception"` and `exception: {type, message,
  uncaught}`; its `step`, `rid`, `line` and `stack` point at the user statement that raised,
  which for a raise inside a library or C call is the statement that made the call.
  `StopIteration`, `GeneratorExit`, `SystemExit` and `KeyboardInterrupt` never pause, nor does a
  library frame; the mode can change while the program runs or is paused. After the pause the
  run ends as before: exit code 1 and the traceback.
- Hovers, watches, `eval` and completions run pure calls. `len(rows)`, `type(x)`,
  `sorted(d.keys())`, `d.get("k", 0)`, `s.lower().startswith("a")` and `[x * 2 for x in items]`
  answer from the finished run or the paused frame, where every call used to be refused and an
  agent re-ran the program to count a list. One module holds the rule for the three callers
  (`python/pyokka_runtime/pure.py`): the builtins in `PURE_BUILTINS`, still bound to the real
  builtin where the expression runs, and the non-mutating methods of an exact builtin type
  (`dict.get`, `list.count`, any public method of `str`, `tuple`, `range` and the other
  immutables). A user function, a method of a user object, `list.append`, `dict.pop`, a lambda,
  an await and the walrus are refused with one line naming what was refused and what is
  allowed. The receiver of a method call is evaluated once, and a program that rebinds `len`
  gets a refusal instead of a wrong answer. An attribute still runs a property and a subscript
  `__getitem__`, as they always did.
- The panel starts and stops the debugger. Its title shows a Debug button while no debug run
  exists (the command "Pyokka: Debug Current File"), and Stop Debugging now sits next to Continue
  and Pause instead of at the end of the row, where a narrow panel folded it into the overflow
  menu and it read as "cannot stop". The status bar's menu offers the same two. Both run the
  file to the first breakpoint, and to the end when there is none, like the command and F5.
- `pyokka shell --live [--session NAME] [--json]` runs many commands in one process: it reads one
  command line per stdin line, the one-shot words without `--live`, over a single bridge
  connection, and prints each result the way the one-shot command prints it, with a blank line
  after it; `--json` prints one JSON line per result and puts errors on stdout as `{"error",
  "hint"}` documents. A one-shot command costs about 70 ms, nearly all of it starting Python and
  importing the CLI, for an answer the session gives in 1 to 4 ms; measured against the e2e host,
  `state` costs 64 ms one-shot and 0.5 ms over the shell, `locals` 0.9 ms. `exit`, `quit` or the
  end of the input close it; `watch` is refused there because it streams until Ctrl-C.
- `pyokka stop --live` and `pyokka restart --live`: an agent can end a debug run or run it again
  from the top; the CLI had no word for either. `stop` leaves debug mode and stops the run, keeps
  the session and everything it recorded, and prints `stopped: exit N, K steps`; with no debug run
  in flight it prints `nothing to stop: ...` and exits 0 instead of failing. `restart` stops the
  run and starts a fresh one of the same file inside the same VS Code debug session, breakpoints
  and watches still in place, and prints its first stop the way `debug` does; with nothing in
  flight it starts one. The debug toolbar shares both ends: the adapter now answers the DAP
  `restart` request (`supportsRestartRequest`), so the Restart button replaces the run in place
  instead of VS Code terminating the session and relaunching it, which raced the old run's
  shutdown against the new one. Bridge requests `stop` and `restart` (`docs/PROTOCOL.md`).
- `pyokka debug --live` runs to the first breakpoint of the session's files, as F5 does, and
  pauses before the first statement only when no breakpoint can hit there. It used to pause at
  the first statement always, so an agent that had just set a breakpoint spent a `continue` to
  reach it and the person watching read "paused at demo.py:10 (start)". `--stop-on-entry`, on
  `debug` and on `restart`, asks for the entry pause anyway, which is where break-when watches
  and breakpoints go in before anything runs.
- `F5` with a breakpoint in the active file starts a debug run. Both Pyokka bindings on the key,
  Re-execute and Run to Active Line, now carry `!pyokka.activeFileHasBreakpoints`, so the key
  falls through to VS Code's Start Debugging and the `pyokka` configuration provider runs the
  file under the debugger to that breakpoint. Before, as soon as a session existed on the file,
  `F5` was a plain re-run that never paused, or a Time Machine move. Logpoints do not set the
  key: they are markers and never pause. The README lists the five states of `F5` under
  "Commands and keys".
- Starting a debug run leaves the Debug Console closed (`internalConsoleOptions: neverOpen`,
  filled in for a launch configuration that says nothing about it), so the Pyokka panel keeps
  its tab instead of vanishing behind the console on every start. Open the console when you want
  it (View: Debug Console); it evaluates in the paused frame with completion as before.
- A blank expression never reaches the run: `evaluateLive` and the DAP `evaluate` answer nothing
  for it, so an emptied watch field or a bare Enter in the Debug Console stops writing
  `evaluate "": SyntaxError` to the log.
- The Time Machine's watch machinery moved from `src/timeMachine/navigator.ts` (694 lines) into
  `src/timeMachine/watches.ts`: add, remove, edit and refresh, the Evaluate action, evaluation at
  the frontier and without a run, the variable-history cache and the panel's watch rows.
  `TimeMachine` keeps the same public methods as one-line delegates, so the panel, the bridge
  and the test API call what they called before; nothing else changed.
- Code Story: the document follows Quokka's own, rule for rule. `docs/design/code-story.md` is
  the contract, written from a probe of Quokka and the vendored frames, and the story is built to
  it. The code lens row, the zero-width fences and the blank rows between blocks are gone: row 1
  is empty, the blocks follow, and two blocks are separated by one row holding `…` and nothing
  else. A block lists the lines its pass ran plus two lines of source either side of them,
  clamped to the scope, with blank lines at the edges of that window dropped and an interior
  stretch of more than four lines the pass did not run folded to one `…` row. The header rule is
  gone: a function's `def` line is listed when it falls inside the window and not otherwise, so a
  first pass through a short function shows it and a later turn deep in a long body does not.
  Brightness is per step range, the columns the step covers against the rest of the line. Only
  the step the Time Machine stands at carries values, after the end of its line in the block that
  holds it, so the earlier turns of a loop stay clean; that step is boxed on its range and the
  story's cursor and scroll follow it. Stopping the Time Machine or the session closes the story
  instead of leaving a "session stopped" text behind. Hovering a name on a story row now answers
  with Value Peek's hover for it, taken from the row's source file and line; the value is the one
  as of the Time Machine's current step, which the hover's footer names. The editor-title
  contributions Quokka declares for its story scheme are mirrored for `pyokka-code-timeline`:
  while navigating, the story's title bar holds run back to line, back out, back into, back over,
  stop, over, into, out, run to line and the two breakpoint moves. They were generated already,
  gated on Quokka's previous-generation UI flag, which Pyokka maps to false, so none of them ever
  showed. The `[pyokka-story]` defaults now also turn off the editor's line numbers (every row
  carries its own), the glyph margin, folding and the minimap.
- Details: when a value is shown as a table and the document under it is empty, the table takes
  the pane; the empty editor no longer fills the rest with a focus box. Changing a
  `pyokka.story.*` setting refreshes an open story at once. The story's painted values are
  pinned by unit tests of the placement and filter rules and by an e2e case that reads them
  through the test API, so the per-pass values cannot quietly disappear again.
- `pyokka.story.values`: which values the Code Story paints. `all` (the default) is the
  per-pass painting from before the Quokka pass, each block carrying what its own steps logged,
  with a folded statement's value on the `…` row under it; `asOf` hides what the run has not
  reached yet; `step` is Quokka's rule, the current step's value only.
- Code Story grammar: each block is its own TextMate region (opened by the empty first row or a
  `…` row, closed by the next `…` row), so a context row that is the closing line of a docstring
  no longer swallows the rest of the document as one string; a row that is only a line number
  and a triple quote is coloured as a string edge without opening one.
- `pyokka story RUN --limit N` works. It was parsed and dropped, so every listing stopped at the
  built-in 150 lines whatever it said; it is now the line cap, and the head still reads
  `(showing S)` with the trailer naming the blocks it left out.

- The debugger (`docs/HANDOFF-debugger.md`, preview `docs/design/debugger-preview.html`).
  "Pyokka: Debug Current File" runs the file paused before its first statement; the pause is
  the frontier. Behind it the recording is the Time Machine's (values as of the step, Step
  Back, Code Story, Why); at it the frame is live: hover, Value Peek and watches evaluate in
  the paused frame with no re-run, STEP VARIABLES lists the frame's variables. Step Over, Into
  and Out execute at the frontier and replay behind it; Continue, Pause and Stop Debugging are
  commands, panel title buttons and toolbar buttons; Run to Active Line at the frontier is a
  one-shot breakpoint. Gutter breakpoints are the debugger's, conditions included, pushed to a
  run in flight; a `def` line pauses at every entry, a blank line moves to the next statement,
  a module not yet imported holds once it loads. Break-when watches pause when an expression's
  text changes or turns true (from the CLI for now). The panel marks the frontier on the strips
  with the hatched "not run yet" beyond it, says where the run is paused and why, and the status
  bar says the same. A paused run is off the timeout clock; an implicit re-run while a debug run
  is in flight is refused rather than killing it; a finished debug run is a normal finished run.
  Runtime: `config.debug`, `breakpoints` in the run request, the `debug` request (breakpoints,
  watches, pause, locals, continue, step), `debug.paused` / `debug.resumed` events, capability
  `debug` (`python/pyokka_runtime/debugger.py`, `control.py`); every pause flushes the recording
  so far. Agents: `pyokka debug`, `continue`, `pause`, `break`, `watches`, `locals` over the
  bridge (`--live`), `step --live` executes at the frontier, `context` / `state` / the `watch`
  stream report the pause, `eval` and `why` work at the stop; every stop moves the editor. The
  standard debug views: every start, the command, F5 with or without a
  `{"type": "pyokka", "request": "launch", "program": "${file}"}` launch configuration, or
  `pyokka debug --live` from an agent, opens a VS Code debug session through a DAP adapter over
  the same pause, with Variables, Watch, Call Stack, the Debug Console and hovers in the paused
  frame next to the panel; a file already shown in a debug session re-runs inside it; Stop in
  the toolbar stops the run and keeps the session; caller frames point at their `def` line.
  The command and F5 run to the first breakpoint, as VS Code's other debuggers do
  (`"stopOnEntry": true` in the configuration pauses before the first statement); `pyokka debug
  --live` pauses before the first statement so an agent sets its breakpoints before anything
  runs. Runtime: `config.stopOnEntry` (default true) next to `config.debug`.
- Watch expressions typed in the panel complete as you type: names in scope for a bare prefix,
  the object's attributes after a dot (no property runs while completing), from the paused
  frame while a debug run is paused and from the finished run otherwise; Up/Down choose, Tab or
  Enter accept, Escape closes the list. The + in the Watch expressions header adds one, double-click
  or the pencil edits one in place; Tab never leaves the field (with no list it asks for one) and
  a click elsewhere keeps the text, so a value can be copied mid-typing. VS Code's Watch pane and
  Debug Console get the same list in a debug session. Runtime: the `complete` request and
  capability (`python/pyokka_runtime/complete.py`). Outside Automatic mode a watch no longer
  answers "re-execute to evaluate": at the run's last step the finished program evaluates it,
  behind that a bare name comes from the recorded variables as of the step with a note saying
  where it was recorded, and only an expression nothing recorded at an earlier step says "not
  recorded at this step", with an Evaluate action in the row that runs the file once to record
  it there (no action while a debug run is paused: the frontier answers live).
- Values as a table, and why with a conclusion. A list of at least three dicts sharing their
  keys, or of tuples of one length, renders as a sortable table with a column per key, `None`
  and empty cells counted per column in the footer, nested values collapsed to `{n keys}` /
  `[n]`, in the Details pane and in STEP VARIABLES at the frontier; a "list" toggle returns to
  the tree. Two locals with the same value and container type show `= other`. The provenance
  tree (`pyokka why`, the bridge, the why pane) ends with a deterministic sentence or two built
  from recorded values: the arm of a conditional and its test, the call that returned the value,
  the name it copies, or the key missing from a container; empty when nothing was recorded.
- Clear Library Cache. "Pyokka: Clear Library Cache" (always in the palette) removes the
  instrumented library files under `~/.pyokka/cache`, or under the `PYOKKA_CACHE_DIR` the run
  child would see, and says how many files and bytes went. Only the `*.bin` entries at the top of
  the directory are touched and the directory stays, so a cache pointed at a shared folder loses
  nothing else; a file in use or read-only is counted and reported, not an error. Plain file
  operations under the user's home: no interpreter, no shell, no privileges. The CLI has the same
  as `pyokka cache` (directory, entries, size) and `pyokka cache --clear`, both with `--json`. The
  next run with library code on rewrites what it needs. The README's "unused for 30 days" for the
  sweep now says what the code does: entries not rewritten for 30 days.
- Execution Diagram: semantic zoom. The diagram opens at the level of the scopes: one card per
  module, function and package, the call edges between them, nothing else. A card's chevron opens
  that scope's statements and decisions on the canvas and the toolbar opens or folds them all; a
  call from a folded statement leaves the card instead, and calls that then share their ends merge
  with their counts added. Data edges are off until the toolbar (or `pyokka.diagram.dataEdges`)
  turns them on: they were the noisiest layer. The left pane gains a STORY tab, the run as an
  outline: modules, then phases (consecutive statements the source separates with a blank or a
  comment line, labelled by the comment above them or the names they assign), then statements,
  with the scopes a statement calls nested under it and referenced where they are called again; a
  click selects, moves the Time Machine and opens the scope on the canvas, and the row of the
  current step is highlighted and kept in view. The inspector lists every step the selected
  statement, decision or function ran at (the first 400) with the value logged there, the current
  one marked, and previous / next hit buttons; a statement inside a folded scope still shows its
  card. The graph is no longer built after every run: with `pyokka.diagram.build` at its default
  `onOpen` the host walks the run only when the view is open or opened, so a run costs nothing
  extra while the diagram is closed; `onRun` restores the old behaviour. `pyokka.diagram.detail`
  (`scopes`), `pyokka.diagram.dataEdges` (false) and `pyokka.diagram.phases` (true) set the
  defaults; the toolbar overrides them for the open panel and a change of the settings drops the
  overrides. `pyokka graph` and the bridge are unchanged: the phases and the hits are panel-only.
  The manifest generator's default for `pyokka.story.walkthrough` now matches package.json (false).
- Value Peek on locals without a run. Hovering a parameter or a local in On Save or On Demand
  mode answered "no value … Re-execute to evaluate", and re-executing changed nothing: the hover
  had queued no marker, and a function's locals are gone from the final state the finished child
  can evaluate. Now a bare name that nothing recorded at that spot is answered from the run's
  recorded variables when "Record Variable Changes" is on: the value as of the current step while
  the Time Machine navigates (the current call's or the module's), the last change otherwise, with
  a footer naming the step and function; Copy, Why and Add watch work on it. In On Save and On
  Demand a hover that still finds nothing places a hidden marker at the spot so the next save or
  Re-execute records it (the status bar reads "run needed"), names the function the local belongs
  to, and offers "Record variables and re-run": one click turns recording on for the session and
  runs once, after which every local at every step answers a hover. Hidden hover markers are never
  listed or painted; a session keeps at most 60.
- Fixed: on macOS, every run after the first of a file whose run initialises an Apple
  framework class died with SIGABRT and showed nothing: no values, no trace, no error, only
  `exit -6, 0 steps` in the log. Building an `httpx` client is enough (its proxy lookup goes
  through SystemConfiguration: `+[NSCharacterSet initialize]`), so was
  `urllib.request.getproxies()` (`+[NSNumber initialize]`) and a TLS handshake verified by
  `truststore`; the openai SDK does the first at construction, so HTTP Replay did not avoid
  it. `demo.py` never got there, which is why the suites passed. The runner forks a warm child
  per run and has threads after run 1 (the pipe readers, the waiter, the timeout timer), which
  arms Apple's fork-safety check in every later child.
  On macOS the runner now makes a fresh interpreter per run (spawn, as on Windows) instead of
  forking: about 35 ms more per run (interpreter start plus the runtime's imports; user
  imports were cold in the fork too) and no such rule. `PYOKKA_FORK=1` brings the warm fork
  back on macOS for whoever also sets `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` for the
  runner (its own threads never enter Objective-C, so Apple's check is a false positive
  there); `PYOKKA_SPAWN=1` still forces spawn everywhere. A run child that dies from a signal
  without reporting is now a `runner.error` naming the signal ("run child killed by SIGABRT
  (exit -6) before it finished …") with a hint, instead of an empty run; it is never re-run,
  the program may have had side effects. Also fixed in spawn mode (macOS now, Windows all
  along): the runner closed a dropped child's control pipe by descriptor number and the pipe
  object closed the same number again later, sometimes on the next child's pipe, so that
  child exited right after its run and hovers got "no finished run to evaluate against".

- Code Story: one block per pass through a scope instead of one per scope entry. A block now
  ends where a line comes back around, so a loop body is listed once per turn rather than
  folded into a single block for the whole loop, which is how Quokka's Code Story reads. Steps
  that share a line (a call and its arguments, a comprehension) stay in one block: only a line
  returned to after leaving it starts a new one. `blockBounds` and the Python `Trace.blocks`
  follow the same rule, so `pyokka story`, the context slice and the editor agree.
- The Code Story shows values. Each line carries what it logged **during that block's steps**,
  so the two turns of a loop show their own value rather than both showing the run's last one.
  The decorator still skips the story document; `CodeStory.renderValues` paints it, because only
  the story knows which pass a line belongs to. Unhandled errors land the same way, and the
  story repaints as entries stream in.
- Every Code Story block opens with a `…`, so one pass reads as separate from the last instead
  of being divided by whitespace.
- Code Story blocks carry context. A block lists two lines of source either side of what its
  pass ran, dimmed, so a turn of a loop reads in place instead of as two stranded lines; a run
  of more than four lines the block did not run folds to `…` instead. The line selection is a
  pure `storyBlockLines`, and the dim is a new `storyContext` decoration that applies whether or
  not the Time Machine is running. The context slice the bridge serves keeps listing only the
  lines that ran: padding is for reading, not for an agent's context window.
- The walkthrough at the top of the Code Story is off by default
  (`pyokka.story.walkthrough: false`). The story is source now, not narration; the walkthrough
  is still in the Output view, `pyokka walkthrough` and the bridge, and the setting turns it
  back on.

- HTTP view: the requests of a run, like a browser's Network tab. A new rail button (globe)
  opens an HTTP pane listing one row per request the run made: name, method, status, the
  statement that made the call (`file:line`, a click moves the Time Machine there), size, time
  and where the answer came from (live, recorded, replayed, or a miss). Rows appear while the
  run progresses; the footer sums them (`3 requests · 68 kB · 1.2 s`) and names the recording
  and its date; the pane's toolbar holds the HTTP mode dropdown and "Open recording" (also
  "Pyokka: Open HTTP Recording"). The table is filled for every run, HTTP Off included: the
  plugin now observes the clients in every run and writes nothing unless the mode is Record
  (`pyokka.httpObserve: false` leaves the clients untouched). While the mode is Record or
  Replay the status bar says so (`· HTTP replay`, `· HTTP record, 1 recorded`) and the rail
  button carries a badge, so a mode set an hour ago is visible before the next run; with the
  mode Off and a recording on disk the pane offers to replay it. Agents get the same table:
  `pyokka http run.json` (and `--live`, bridge `http`). Runtime: one `http.exchange` event per
  request, with the calling statement found by walking the frames at request start (right
  across worker threads and inside instrumented libraries), and `run.finished.http` for every
  run with the recording found for the file.
- Why is this value here: `pyokka why run.json STEP NAME` (also `--live`, where STEP defaults
  to the Time Machine's step) walks backwards from one value: the statement that made it, the
  names that statement read with the values they had and the statements that made those, five
  levels deep (`--depth`), the functions the statement called whose body was stepped with their
  arguments and result, and the calls it made that were not stepped (builtins, a dataclass
  constructor, library code) as leaves. On `example.py`, `why` on `total` shows the generator's
  input `acct` with its balance and the `Account("guest", 5)` it built. In the panel a "Why"
  button sits on every entry and on every row of the Variable pane, the hover has a Why link
  and "Pyokka: Why This Value" takes the name under the cursor; the tree opens in the Details
  pane, a line moves the Time Machine to its step. The bridge serves it as `why`. Runtime: the
  `bindings` reply also lists the calls each statement makes; a `# ?+` value (`autoExpand`)
  now counts as a recorded value for `var` and `why`. Protocol: "Provenance".
- Values as of this step. While the Time Machine navigates, an inline value is what its
  statement had produced by the current step: the current step's values in full, earlier ones
  dimmed, nothing yet for a statement that has not run, and `×2 3` on a loop line at its second
  pass instead of the run's last hit. Hovering a value or a name (Value Peek) shows that entry
  instead of evaluating, with a footer `as of step 27; final: 6` when the run ended with a
  different value and `not run yet as of step 5; final: 6` before the statement's first hit;
  only an expression that was never logged is still evaluated, and then the hover says the
  value is not this step's. `pyokka.timeMachine.inlineValues` keeps its modes: `dimOthers` (the
  default, above), `currentStep` (only the current step's values), `all` (every value
  unchanged). `demo.py` gains a three-pass loop to step through, and the e2e API gains
  `inlineValues(editor)`: what an editor paints.
- Swallowed-exception report. Generated code catches broadly, and the panel folded caught
  exceptions into the entries list where nobody saw them. The runtime now records where each
  caught exception was finally handled (`handledAt`: the `except` clause that matched, or the
  `with` whose `__exit__` swallowed it; a `finally`, a `with` cleanup or a handler that
  re-raises does not count) and aggregates repeats: one `error` event per exception type,
  raise site and handler, with `count`, the first and the last step. `pyokka exceptions
  run.json` (and `--live`; bridge request `exceptions`) lists one row per exception: uncaught
  first, then caught, each with the raise site, the handler, how many times, the first
  message; a row caught by a bare `except:` or an `except Exception` is flagged `broad
  handler`. The Output view shows the same list as an EXCEPTIONS section under the entries;
  clicking a row moves the Time Machine to the raising step. Exceptions raised and caught
  inside libraries stay out; one raised in a library and caught by the program is in. The
  uncaught exception is no longer also reported as caught (the instrumenter's own `finally`
  handled and re-raised it, and that counted).
- Value Peek: the hover's Explore value, Show as diagram and Copy links work after the file
  re-ran (On Save re-runs on every save). Each link now names the expression, its range and
  the session; a click whose entry id belongs to a replaced run re-evaluates the expression
  against the current run (a transient run in Automatic mode, the finished child's answer
  otherwise), and when nothing comes back the status bar says so instead of the panel opening
  on nothing.
- HTTP record and replay: a run of API-driven code can be repeated without the network.
  Settings gains "HTTP" (Off, Record, Replay; also `pyokka.http` and `--http record|replay`
  on `pyokka run`). Record lets every request through and writes each exchange (method, URL,
  headers without credentials, body, status, response headers, body or the streamed chunks)
  to `.pyokka/replay/<hash>.jsonl` in the workspace, one file per source file; Replay answers
  every request from that file, in recording order for identical requests, and never opens a
  connection, so editing the `print` lines of a file that calls an LLM and re-running costs
  nothing and shows the same values. Clients covered: httpx (and the `httpx2` fork the
  example venv ships), requests, and `urllib` / `http.client` as the fallback. A request with
  no recorded response is a `runner.error` ("run once in record mode") and a
  `ConnectionError` in the program. Bodies and header values pass through the secret
  masking; `authorization`, `cookie` and other secret-named headers are never written. The
  status bar reads "replayed" (or "recorded N") after the duration and `run.finished`
  carries `replayed` and `http`; the first recording in a git workspace offers once to add
  `.pyokka/replay/` to `.gitignore`. Plugins gain an `after(config)` hook whose result is
  merged into `run.finished`, plus `execute.current` and `execute.runner_error`.
- Execution diagram: the run as a picture. `pyokka graph run.json` (and `--live`) lists the
  nodes and edges of a run: the module, one node per user function that ran with its call
  count, its first call's arguments and result (`in amount = 30 · out 55.5`) and what it
  raised, one collapsed node per library package (`--all` or `--expand PKG` unrolls it),
  every decision under the function it lives in with the arm it took and the first line of
  the arm that never ran, one call edge per caller and callee with the count and the call
  steps, tool edges for library callbacks, and data edges where a value one function
  produced went into another (labelled with the parameter). `--dot` prints Graphviz. The
  same graph is the panel's Execution Diagram view ("Pyokka: Show Execution Diagram", the
  rail's More menu, the Time Machine toolbar): the canvas, a step scrubber under it that
  moves the Time Machine (and follows it), the walkthrough list on the left, the inspector
  on the right with the selected node's rows and calls and what is running now; the call
  stack at the current step is highlighted, nodes not yet entered are dimmed, finished ones
  ticked; clicking a node jumps to its first call, clicking a package node unrolls it. The
  bridge serves it as `graph`. Deterministic, no model; 200 nodes at most.
- Execution diagram, statements: a script that calls into libraries (a module with no
  functions of its own) drew as one box. Every simple statement a step ran is now a node
  under the module or function it lives in, chained in run order: its source, how many
  times it ran, the value it logged, what it printed, what it raised, the names it assigns
  and reads. Call edges leave from the statement that made the call, and data edges join
  the statement that last assigned a name to the statements and decisions that read it,
  so `client = OpenAI(…)` ⇢ `response = client.responses.parse(…)` ⇢ `dt = parser.parse(…)`
  ⇢ the loop ⇢ the `if` reads as a pipeline. The scrubber highlights the running statement.
  `pyokka graph --no-statements` (bridge: `statements: false`) keeps the function-level picture.
- Execution diagram, layout: each module and function is one column segment (its card on
  top, its statements and decisions stacked under it, a faint frame around them that selects
  the scope when clicked), columns by call depth, a callee beside the statement that first
  calls it, call edges leaving that statement along its row, data edges as arcs on the left
  of the chain. A script with many calls no longer fans out into a strip that fits small; the
  fit keeps a readable scale and the fit button fits the width and aligns the top so a long
  script reads from its first statement.
- Walkthrough: what happened, in order. `pyokka walkthrough run.json` (and `--live`) lists
  one moment per line with its step number and the values that mattered: the module start,
  every call with its arguments and return value (library calls merged into one line per
  call site: "call to OpenAI.__init__ (openai) from <module>, 3 nested calls", `--all` for
  each), every `if`/`elif`/`match` with the arm it took, loops with their iteration count,
  logged values, prints, every exception with where it was handled, and the end with the
  exit code. Deterministic and instant, no model. `--from N --to M`, `--scope NAME` and
  `--file F` select a window; 400 moments otherwise, repeated calls collapsed. The same
  list is the WALKTHROUGH section of the Output view (clicking a moment moves the Time
  Machine there, the active moment follows the current step, past ones dim) and the top of
  the Code Story (`pyokka.story.walkthrough`). The bridge serves it as `walkthrough`.
- Narrate: one model call adds a sentence of gloss per moment, never automatically. `pyokka
  narrate run.json` writes the glosses into the saved run; the WALKTHROUGH section's Narrate
  button (and "Pyokka: Narrate Walkthrough") does the same for the open session, cached per
  run. The backend is `pyokka.explain.command` when set, else `claude -p` when it is on the
  PATH, else `codex exec`, else Copilot's models inside VS Code; values and source are
  redacted before they leave; a bad answer keeps the glosses empty and says why once.
- Coroutines and tasks: a scope's parent is now the frame that called, awaited or iterated
  it, read from the caller's frame, instead of whichever scope last recorded a step. Tasks
  gathered by `asyncio.gather` used to nest under each other as they interleaved (a `fetch`
  of one task at depth 5 under the other task's `fetch`), which put wrong frames in the call
  stack and made Step Over hop between tasks. Each task now sits under the module at depth 1
  with its own calls beneath it, and Step Over / Step Out (and their back variants, in the
  panel and in `pyokka step`) follow the scope's parent chain rather than step depth: from
  `both = await asyncio.gather(turn(2), turn(3))` Step Over lands on the next statement of
  the awaiting coroutine. The same rule stops Step Over inside `f` from landing on a sibling
  call `g` made from the same line.
- Variable history: "where does `dt` come from?" answered from the run. `pyokka var run.json
  NAME [--file F] [--scope NAME]` (also `--live`) lists every step where a name changed, with
  the statement (`file:line`, function), the new value and, after `←`, the names the statement
  read with their values at that moment, so one more `var` walks a step further back. A
  "VARIABLE" pane in the panel (rail button, or "Pyokka: Show Variable History" on the name
  under the cursor) shows the same list; a row moves the Time Machine to its step, a read name
  becomes the next query. Names match as paths: `acct` lists `acct.deposit(amount)` and
  `acct.balance`, `self.balance` lists `self`. Three sources: recorded locals (the new
  per-session "Record Variable Changes" toggle in Settings, off by default; `pyokka run --save`
  records them), logged values under the name (`# ?`, Auto Log, identifier statements), and the
  statements that assign the name from the AST when nothing recorded the value, marked
  "assigned here (value not recorded)", or "(unchanged)" with the value the statement left as
  it was when the following step observed no change. Runtime: a stateless `bindings` request
  (what each statement assigns and reads) serves the extension; the CLI parses the sources it
  has. Protocol: "Variable history" and the bridge's `var`.
- Run Timeout is a session setting in the panel (Settings view, next to the run mode: 30 s to
  10 min or no limit; "Save as defaults" writes `pyokka.runTimeout`). The timeout is wall
  time for the whole run, waiting on the network included, so an agent script that makes a
  few LLM calls dies at the default 30 s. When that happens the entries pane now says so:
  the values stop where the run was killed, nothing can be expanded or evaluated until the
  next run, and a link opens Settings. Before, the only trace was the status-bar tooltip and
  expanding a value silently did nothing.
- Time Machine: every block on the Steps strip carries its step number (`#23`, the number
  the `pyokka` CLI prints) above the `line:col` label, so a step an agent names can be found
  on the strip. The code preview hover leads with the step number and function and, for a
  step inside a call, says which step and line called it (`called from #22 <module> line
  84`): a factory lambda that runs during a constructor no longer looks like a jump. The call
  stack rows show the step of each frame too.
- The default run mode is On Save for every file, scratch files included (it was smart:
  automatic for scratch files, on save inside a project). Automatic and smart remain
  selectable per session and in `pyokka.runMode`. `examples/` pins Automatic in its workspace
  settings so the demo and the e2e suite keep running on edit.
- The run-mode dropdown in Settings opens its list instead of a clipped 2 px strip.
- The panel never writes the run mode to the user settings any more. "Save as defaults" and
  the earlier settings view wrote `pyokka.runMode: "auto"` globally, which turned every
  project file into an automatic session: a hover re-ran the file, and for a file that calls
  an API each hover was a paid run. The run mode stays per session; new files get the smart
  default. Check your user settings for a leftover `pyokka.runMode` and remove it.
- Agent access: a `pyokka` CLI (stdlib argparse, `uvx --from ./python pyokka`) lets an agent
  read a recorded run the way the Time Machine does. `pyokka run FILE --save run.json
  [--library-code] [--keep]` saves the events with file hashes; `story`, `steps`, `step N
  --into|--over|--out|--back|--back-over|--back-out|--to`, `context`, `values --line`, `find`,
  `eval`, `expand` answer from it with bounded text or `--json`, every stop as one "context
  slice" (location, call stack, the enclosing block's lines that ran, values, coverage, the
  step each move would reach). `--keep` keeps the finished process alive for `eval`/`expand`.
  Secret-looking values are redacted before anything leaves the runtime.
- Agent access in VS Code: with `pyokka.agentAccess` on (default off) each session listens on
  a local Unix socket with a token (`~/.pyokka/sessions/`); `step` moves the editor, `watch`
  streams the user's own steps, `eval`/`expand` reach the finished run. The CLI's `--live`
  talks to it so an agent can step while you watch, in the chat you already use.
- Fixed: statements of imported modules were all positioned on line 1 by the module-scope
  wrapper, so error stacks and tracebacks inside imported project or library code reported
  line 1 (the library cache format is bumped, entries are rebuilt). Fixed: recording locals
  could re-enter instrumented `__repr__`/`__getattr__` (a pydantic model produced 640 k phantom
  steps); reprs run quiet now.
- Secrets are masked in the run process (`pyokka.secrets.mask`, on by default; a "Mask Secrets"
  session toggle in Settings). No value-shape guessing: the value of any environment variable
  with a secret-looking name is replaced wherever it appears (reprs, prints, exceptions, URLs,
  hovers, watches, locals; `load_dotenv()` variables included), and a string under a
  secret-looking name (`api_key`, `password`, `token=` in a repr) is replaced whatever it is.
  `pyokka.secrets.names` adds words. The panel renders the mask blurred; the editor, the panel
  and the extension logs never receive the value. Protocol: `config.secrets`, value node `secret`.
- Rendered panel tests (`test/unit/webview/chrome.test.tsx`, via `preact-render-to-string`):
  rail icon order and tooltips per state, the running spinner, the Time Machine button while
  navigating, the toolbar stop button, the Settings view contents, the entries empty text.
- One Settings in the panel, at the bottom of the rail: the view shows the current session's
  settings and run mode, every change applies immediately, and a save button makes the
  current values the defaults for new files. The separate "Session settings" quick menu
  that duplicated the toggles is gone; View Recent Files sits in the Settings header and the
  More menu.
- "Pyokka: Start on Current File" is always in the command palette. It was hidden whenever
  VS Code had no active-editor context (focus in the panel, no editor open), and it opens a
  new Python file in that case anyway.
- The rail's Time Machine button is a clock-arrow icon that starts the Time Machine or, while
  navigating, brings its view back (it was a plain grey stop square, and the only way back from
  Output or Settings was to stop). Stopping is the red square in the Time Machine toolbar
  (or Shift+F5). The panel also forgets a previous session's Time Machine state when it
  re-binds, and stopping a session stops its Time Machine.
- Panel tooltips appear after 150 ms instead of the second a native webview tooltip takes,
  positioned next to the icon (left of the rail), so the rail's icons can be told apart.
- The rail's play button spins while a run is in flight and the entries pane says
  "RUNNING…" instead of "NO LOGS OR ERRORS" (a click while running restarts the run).
- Code Story reads project and library modules that are not open in an editor from disk,
  instead of printing "(no source available)" for every library block.
- `test/e2e/libdiag.test.js` (`./node_modules/.bin/vscode-test --config .vscode-test.libdiag.mjs`)
  replays the library-code sequence against the example venv with timings and an
  event-loop lag monitor; it skips when that venv is absent.
- Library stepping is fast enough to leave on. Importing `openai` with every package
  instrumented took 17 s (1.7 M steps, 121 MB of trace deltas, and the 30 s timeout could
  kill the child mid-write); it now takes 2.5 s on the first run and 0.8 s after that,
  `libraryPackages: ["openai"]` 0.7 s, against 0.6 s with the option off
  (`scripts/measure-library-run.py`). What changed:
  - A library module's import-time execution is coverage-only: statements it runs while
    importing, and the functions they call, count as covered but record no steps, scopes
    or handled exceptions (pydantic building its models is not code you stepped into).
    Library functions called from your code are stepped as before.
  - Instrumented library files are cached under `~/.pyokka/cache/` (`PYOKKA_CACHE_DIR`
    overrides the directory, empty disables the cache); entries are keyed by the file's
    path, mtime and size and rebased to each run's range ids.
  - `file.instrumented` no longer carries the instrumented source of library files; the
    new `source` runner request serves it on demand, and "Show Instrumented File" shows
    the active editor's file when the last run instrumented it.
  - Mid-run trace deltas send only the scopes created since the previous delta, none are
    sent past `maxTraceSteps`, and no scopes are created past the cap either.
  - Instrumentation time is added to the run's timeout deadline, the status bar counts
    files while a run instruments them, and a killed child's truncated last event line is
    dropped instead of reported as "bad event line from child".
- Step into library code, off by default: `pyokka.timeMachine.libraryCode` (or the
  session toggle "Step Into Library Code" in the panel menu and settings view)
  instruments third-party packages on import so Step Into enters them, with values,
  coverage and their own timeline colours; Step Out returns to the caller. The standard
  library is never instrumented. `pyokka.timeMachine.libraryPackages` narrows it to
  named packages or dotted globs. Takes effect on the next run. Library files report no
  handled exceptions and honour no `# ?` comments (that noise made pydantic unusable).
- Shadow values: in On Save / On Demand mode, editing a statement shows what it would
  print or evaluate to right away, computed from the data the last run captured (marked
  `≈`), without executing anything. `print(...)`, bare expressions and assignments are
  supported; anything with a call is left blank until the next run. Explore, Diagram
  and Copy work on hover values and shadow values (they are pinned into the panel).
- Inline values on lines edited since the last run are hidden until the next run (the
  old value described code that no longer exists); untouched lines keep their values.
- Hovering in On Save / On Demand mode now shows the expression's value from the last run
  without re-executing: the finished run's process stays alive and evaluates names,
  attributes, subscripts and operators against the final module state (new `evaluate`
  runner request; calls and comprehensions are refused). Explore, Show as diagram and
  Copy work on the result. Edit freely, hover to inspect captured data, save to run.
- The build timestamp is logged on activation and shown in the status bar tooltip, so a
  window still running an older extension host is easy to spot after a reinstall.
- A visible Run button: the editor title's run slot shows "Re-execute file" for a running
  Pyokka file (and "Start on Current File" for other Python files), the panel rail has a
  play button, and the "run needed" status bar item runs on click. F5 still works when
  the Time Machine is not navigating.
- Default run mode is now `smart`: scratch files run automatically, files inside a
  project (`pyproject.toml`, `requirements.txt`, `setup.py`, a lock file, ...) run on
  save. A one-time notice explains each behaviour. Set `pyokka.runMode` to `auto` for
  the old default.
- Run modes On Save and On Demand now forbid every implicit execution: Value Peek
  hovers, watch expressions, Show Value markers, logpoint changes and the Time
  Machine's Auto Log no longer re-run the file in those modes. The request is queued,
  the status bar shows "run needed", hovers explain how to record values, and the
  next explicit run (Re-execute, save, restart) serves it. Previously a hover alone
  re-executed the file, side effects included. A one-time notice explains the
  Automatic mode's behaviour.
- Time Machine: `def` and `class` definitions no longer produce steps; after the
  module-level prints the next step is the first real statement, and Step Into
  goes to the constructor. Function entry on a *call* is still a step.
- Time Machine: statements in a class body (dataclass fields, class attributes) are
  coverage-only like the `class` statement itself, so stepping goes from the statement
  before the class straight to the first statement after it. Method bodies are still
  stepped when called.
- Time Machine: Auto Log is switched on while navigating (`pyokka.timeMachine.autoLog`,
  default on) so every step shows the value its statement produced, including
  `return` values inside functions.
- New setting `pyokka.timeMachine.inlineValues` (`dimOthers` | `currentStep` | `all`).
  The default keeps every inline value on screen while navigating and dims the ones
  that belong to other steps; `currentStep` is Quokka's behaviour.
- Spawn mode (Windows, or `PYOKKA_SPAWN=1`): the run child sends events with
  `socket.sendall` instead of `os.write` on the socket's file number, which is not a
  usable descriptor on Windows.
- Interpreter: "Select Python Interpreter for Pyokka" gains a Browse entry that opens a
  file dialog in the current file's folder, validates the choice, and saves it for the
  workspace (relative to the folder when the executable lives inside it) instead of
  globally. `pyokka.python.interpreter` accepts workspace-relative paths.
- Runs load `python.envFile` (default `${workspaceFolder}/.env`) into the child's
  environment, below explicit `env` settings, as the Python extension's debugger does.
- Packaging: the panel's codicon font and stylesheet are copied into `dist/webview/codicons`
  at build time; the installed extension showed missing-glyph boxes because they were
  loaded from `node_modules`, which the package excludes.
- Panel: the Call Stack toggle now lives only in the timeline guide toolbar (it was also
  in the panel title row and the webview header).
- Profiler: after the (uninstrumented) profile run the file is re-run normally, so
  inline values and coverage no longer disappear until the next edit; frames from
  Pyokka's own runtime are left out of the `.cpuprofile`.
- End-to-end suite: watches, edit-and-continue, logpoints, profile mode and snaps,
  plus a screenshot-driven UI pass (`PYOKKA_UI_PASS=1`) covering both themes.
- The Pyokka output channel logs the untrusted-workspace decision
  (`pyokka.untrustedWorkspaceBehavior`) whenever a session start hits the gate.

## 0.0.1

First packaged build. Live values, coverage, the Output & Details panel, the Time
Machine with the interactive timeline, Code Story, recent files, snippets, quick
package install, profiler, snaps and the start view.
