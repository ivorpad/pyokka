---
name: pyokka
description: 'Debug, explain, review or show what Python code does, with a recording or a live debugger the person watches (Pyokka). Use it when asked to step, break, pause, walk through, review a PR or diff, or show why a value is what it is. Modes: debug, explain, show, review. `debug` pauses a running program at a function or line, steps it and reads the frame; `explain` walks a person through a run in their editor or on the browser page, one line per message; `show` investigates a recording or a pause and delivers a page where every value comes from a command; `review` plans a breakpoint per changed function, runs the entry under the debugger, records each pause and refuses a finding without a pause and a reproduction.'
argument-hint: debug | explain | show | review [what to look at]
disable-model-invocation: true
---

# Pyokka

## Pick the mode

The first word after the skill name is the mode: `/pyokka debug create_design`,
`$pyokka explain demo.py`. Load that mode's file and follow it; it says what to deliver.
Read that file first; the Read-next table below says when to open another. The job's first
command and its `pyokka VERB --help` carry the flags (`pyokka debug FILE --at NAME` pauses a live
program, `pyokka run FILE --save run.json` records one); open
[references/pyokka-cli.md](references/pyokka-cli.md) or
[references/live-debugger.md](references/live-debugger.md) when a command fails or its help
leaves the question open.

| mode | for | what you hand back | read |
|---|---|---|---|
| `debug` | pause a running program, step it, read or set the frame, check a breakpoint | the stops you saw, in chat, then clean up | [references/debug.md](references/debug.md) |
| `explain` | teach a person a file while they watch their editor or the browser page | one line and a few sentences per message, their turn after each | [references/explain.md](references/explain.md) |
| `show` | answer how or why with evidence someone will read or keep | a tour or a code-history page, plus a short finding in chat | [references/show.md](references/show.md) |
| `review` | review a change as a guided debug session: the change read and the person asked what it is for, a plan over all of it, the entry under the debugger with a breakpoint per changed function, each pause recorded and each finding reproduced before it counts | the stops the person saw, then the report | [references/review.md](references/review.md) |

With no mode, pick by the verb the user used. "Step", "break", "pause", "run to", "does it stop
in" is `debug`. "Walk me through", "teach me", "explain as we go" with the user at the editor is
`explain`. "Show me", "how does", "what did the library do" is `show`. "Review", "PR", "diff",
"what did this change break" is `review`. A request to see stepping gets real pauses in the
editor, through `debug`; a review the person wants to watch is still `review`, whose stops move
their view.

## A vague request

The person need not know a mode, a verb or a flag. "Debug this", "why does this test fail?" or
"look at this issue with Pyokka" is enough. Find the target before you plan:

1. Look first. Read `git status` and `git diff --stat`, the file or issue text the person gave,
   and run the test suite once (`python -m pytest -q` or the project's own command) when there is
   one. A traceback or a failing test names the target.
2. Pick the mode from what you found. "Debug", "debug this" or "look at this with Pyokka" is
   `debug`, in the repository you were invoked in, whatever `git status` shows: pending changes
   do not make it a review. A failing test, a traceback or a bug report is `debug` too: reproduce
   it, then look where it goes wrong. `review` is only for a person who says review, PR or diff. A
   "how" or "why" question with nothing failing is `show`. If two still fit, take the first of
   these and say which.
3. Say the plan in one or two sentences, sized to the question. One failing test is one
   recording or one pause, the value that is wrong, and the line that makes it. Build a page only
   when the person asks for one.
4. Run it. For a test, `pyokka run tests/test_x.py --test NAME --cwd REPO --save RUN` records it
   without VS Code, and `pyokka debug tests/test_x.py --test NAME --at FUNCTION` pauses it in VS
   Code. `--cwd REPO` makes the project's own modules count as its code; without it only the test
   file's directory is recorded. A plain script runs as it is: `pyokka run SCRIPT --cwd REPO`, or `pyokka
   debug SCRIPT --cwd REPO` for pauses. To launch a server under the debugger:
   `pyokka debug --module uvicorn --args app.main:app --cwd REPO` (no `--reload`), then send it a
   request. A container launch uses `transport` and `pathMappings` in a Pyokka launch
   configuration, then `pyokka debug --configuration NAME`; its wrapper keeps authentication.
   VS Code also supports `request: "attach"` with `connect` and `pathMappings` for an existing
   debugpy listener. Attach has no Pyokka recording or CLI/MCP access. See the README's
   "Containers and attach" examples.
5. Answer with the evidence: the cause, the step or stop and the value that show it, the fix as
   a proposal, and what you did not verify. "Debug" and "why" ask for the cause, not a change:
   edit the source only when the person asked for a fix.

Ask only when the look finds no target (no failing test, no diff, nothing named) or when two
readings would run different code. Never ask the person which command or flag to use.

## How a turn ends

Run the next command instead of asking whether to. A turn ends with what was asked for, never with
a plan, a question about work already requested ("Shall I start the debugger?") or a promise of
the next step. A one-line offer of a follow-up after the deliverable is fine. A turn ends earlier
in five cases:

- The mode is `explain` or `review` and the person is watching. One stop per message, or as many
  as they ask for, each explained from what its move printed, then their turn.
- The look finds no target, or two readings of the request would run different code.
- Only the person can supply what is missing: a database or service no test reaches, the
  agent-access prompt in VS Code, which of two readings they meant, whether to keep a process you
  started.
- The next command would change something that is theirs: the paused program's state (an
  `exec --live` that assigns), a breakpoint they set, their session.
- A review begins, twice. You have read the change and ask the person, in one question call,
  what it is for, which areas first and where to watch; then their turn. You show the plan with
  its split into sessions; then their word on one or several
  ([references/review.md](references/review.md)).

The person's explicit instruction beats this skill. If they ask for what it advises against (a
`run.json` in their repository, a page committed), do it and say what it holds.

## How you write to the person

In chat, in a `--say`, in a tour's prose, in a gloss: one idea per sentence, 20 words or fewer,
active voice, present tense, the actor named ("`subtotal` returns `0.0`", not "`0.0` is
returned"). Tell them what to do in the imperative ("Say next"). The same word for the same
thing, always: stop, step, value, try, finding, the person; never breakpoint, experiment, repro,
variable or user for those. No -ing verb used as a noun, no idiom, no "simply" or "obviously". A
label with a colon is not a sentence. Numbers, names and texts as the tool printed them, in code
font. A list for parallel items, never a table. The answer first, then the step and the value that
show it, then what is not verified. A caution before the detail it concerns. Six sentences per
paragraph at most. These are the structural rules of ASD-STE100, without its dictionary;
[references/review.md](references/review.md) and [references/tour-prompt.md](references/tour-prompt.md)
repeat them, since each is also read on its own.

## The two products

**Run-all** records an execution: every statement, value and branch, in order. You navigate the
recording; nothing re-executes and nothing can be changed. It answers questions about what
already happened.

**The Debugger** runs a program at full speed and pauses at a breakpoint or an exception. You
step, read the frame, run a statement in it, continue. Nothing is recorded, and when the program
exits the session is gone. It answers what the program does next, and it is the one when the bug
needs a real port, real input or a real API. `--record` does both at one pause. A debug session
without `--record` has no history at all, even after it finishes; `references/debug.md`, "History
while debugging", says what to use instead.

Every command takes `--json` for the raw shape; the text form is for you. `pyokka VERB --help`
lists a verb's flags; [references/pyokka-cli.md](references/pyokka-cli.md) has the JSON shapes
and an example of each verb, for when a command fails or the help does not say enough.

Say what the program held or did only after a command in this session printed it. The source says
what could happen, and only a recording or a pause says what did.

When `why` ends at a line that does not explain a shared dict, list or object, record again with
`--follow-objects`; for a cut value, `why --live STEP NAME --rerun` (it runs the program again).
`references/debug.md`, "At a pause", says when to use each.

## Tools

The commands are also MCP tools: `pyokka_run`, `pyokka_map`, `pyokka_step`, `pyokka_value`,
`pyokka_coverage`, `pyokka_debug`, `pyokka_history`, `pyokka_narrate`, `pyokka_investigate`,
`pyokka_learn`, `pyokka_pin`, `pyokka_verify`, `pyokka_session`, `pyokka_seek`,
`pyokka_save_investigation`, `pyokka_open_investigation`, `pyokka_page`, `pyokka_scratchpad` and
`pyokka_review`. Check once per session and take the first route that works: the tools are in your
tool list, call them; `mcporter list pyokka --brief` prints their signatures, call them with
`mcporter call pyokka.TOOL key=value ...`; neither, use the CLI, which `pyokka -h` (else
`~/.local/bin/pyokka -h`) confirms by printing the usage. Over MCP pass absolute paths: the server
resolves `file`, `run`, `save`, `out` and `cwd` against its own working directory. The references
write commands in CLI form; [references/mcp.md](references/mcp.md) maps each to its tool and
lists every argument.

## Read next

Each file is for one situation. Open it when the situation is yours, not before.

| when | read |
|---|---|
| `pyokka -h` fails, or a cold `pyokka debug` says ``cannot find the `code` command`` | [references/setup.md](references/setup.md): the runtime, the editor's launcher, registering the MCP server |
| before the first `--live` command, or a `run` that reports `0 steps` or `Operation not permitted` | [references/sessions.md](references/sessions.md): a debug session is made, a recording session is the user's, `--session NAME`, breakpoints, sandboxes |
| the person works in the browser page (`pyokka web`, http://127.0.0.1:4777/) | [references/pyokka-cli.md](references/pyokka-cli.md#the-browser-page), "The browser page" |
| the `band` tool (`mcp__pyokka-band__band`) is in your tool list, or `printenv CLAUDECODE` prints `1` | [references/band.md](references/band.md): what the band shows, its actions and the `/pk` keys |
| a debug command fails, or its help leaves the question open | [references/live-debugger.md](references/live-debugger.md) |
| a command refuses, nothing pauses after a start, a pause lands on a line you did not set, or an answer looks older than the build | [references/recovery.md](references/recovery.md): the signature, what it means, the one command it asks for |
| a JSON shape, or an example of a verb over a recording | [references/pyokka-cli.md](references/pyokka-cli.md) |
| a tool's arguments, or the tool for a CLI command | [references/mcp.md](references/mcp.md) |

## Stay out of the user's project

Pyokka needs no harness. Use what the project already has: an existing test, the entry point, a
module the user named. It has to call the code in question: a module that only defines functions
runs its imports and `def` lines and stops. Asked about pending changes, read `git status` and
`git diff` first and run code that goes through the changed lines; `pyokka coverage RUN --file F`
shows which of them ran. Leave their repository exactly as you found it: its files, its config
(`pytest.ini`, `pyproject.toml`) and its directories; `run.json`, `history.json`, prose and pages
go in a scratch directory outside it. If the code needs a database or an external service and no
test covers that path, say so and ask the user how they want to reach it.

## Staleness and secrets

`stale: helper.py changed since the run` printed first, or `"stale": true` in JSON, means the
file on disk (saved run) or the editor buffer (live) no longer matches what ran, so line numbers
and values may be off. Save again; live, a save re-runs and re-anchors by itself. `pyokka
history` refuses outright on a stale run.

Every value, error message and eval result that leaves the runtime is redacted (`sk-…`, `AKIA…`,
`ghp_…`, bearer tokens, JWTs, and the value of any key named like `api_key`, `secret`, `token`,
`password`). A recording still holds the program's data: keep `run.json` and pages out of chat,
commits and issues.

## Finish clean

Before you write the final answer, and while the session is still running: remove the breakpoints
you added (`break --live --remove F:L` for a line, `--remove NAME` for one `--at NAME` set),
confirm with `break --live --list`, then `stop --live` unless the user wants the pause kept, and
check `state --live`. Removing needs a session to reach the window: once the program has exited,
its breakpoints stay until the next launch. Breakpoints that were there before you belong to the
user; leave them. Release a kept runner with `pyokka release run.json`.

Every process you started for the task is yours to end: the runner `run --keep` left, a `pyokka
mcp` server you spawned, a `watch --live` or `shell --live` in the background, a server you
launched yourself. Note each PID and port when it starts. When the task is done, stop them
(`pyokka release` for a kept runner, `stop --live` for a debug run, `kill PID` for the rest) and
confirm with `pgrep -fl pyokka` or the port, or ask the person whether to keep them running,
naming each PID and port. Reuse a process you already started for a file instead of starting a
second one. If you were interrupted before this, say which of it is still undone.
