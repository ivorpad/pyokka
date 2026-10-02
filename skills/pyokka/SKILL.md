---
name: pyokka
description: See what Python code does with the `pyokka` CLI and the user's VS Code window, in one of three modes given as the first argument. `debug` pauses a running program at a function or line, steps it and reads the frame. `explain` walks a person through a run in their editor, one line per message. `show` investigates a recording or a pause and delivers a page where every value comes from a command: a tour of the whole run, or a code-history page around chosen steps. Use when asked to debug, step, break, pause, explain, walk through, or "show me" what a Python program did, why a value is what it is, or what a library did with an argument.
argument-hint: debug | explain | show [what to look at]
disable-model-invocation: true
---

# Pyokka

## Pick the mode

The first word after the skill name is the mode: `/pyokka debug create_design`,
`$pyokka explain demo.py`. Load that mode's file and follow it; it says what to deliver.

| mode | for | what you hand back | read |
|---|---|---|---|
| `debug` | pause a running program, step it, read or set the frame, check a breakpoint | the stops you saw, in chat, then clean up | [references/debug.md](references/debug.md) |
| `explain` | teach a person a file while they watch their editor | one line and a few sentences per message, their turn after each | [references/explain.md](references/explain.md) |
| `show` | answer how or why with evidence someone will read or keep | a tour or a code-history page, plus a short finding in chat | [references/show.md](references/show.md) |

With no mode, pick by the verb the user used. "Step", "break", "pause", "run to", "does it stop
in" is `debug`. "Walk me through", "teach me", "explain as we go" with the user at the editor is
`explain`. "Show me", "why is", "how does", "what did the library do" is `show`. A request to see
stepping gets real pauses in the editor, through `debug`. If two fit, ask which.

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

Every command takes `--json` for the raw shape; the text form is for you. The flags, JSON shapes
and an example of each verb: [references/pyokka-cli.md](references/pyokka-cli.md).

## Before the first command: find the runtime and the editor

Find the runtime fresh on this machine, each session. Extension folders carry a version
(`ivor.pyokka-0.1.3`), so a path saved in a note or another session goes stale on the next update
and fails as `No module named pyokka_runtime`. Look in this order:

1. `pyokka` on PATH (`command -v pyokka`), else `~/.local/bin/pyokka` by its full path. With
   `pyokka.agentAccess` on, the extension keeps that file pointing at its current runtime and
   setting `PYOKKA_CODE`. A stock macOS PATH does not include `~/.local/bin`, so call it by that
   full path; the user's shell profile stays as it is.
2. `scripts/pyokka.sh` next to this file does the same search, and inside a Pyokka checkout runs
   the checkout's own source.
3. The installed extension ships the runtime under `dist/python`. Look in the editor's extensions
   directory (`~/.vscode/extensions`, `~/.vscode-insiders/extensions`, `~/.cursor/extensions`,
   `~/.vscode-server/extensions`, or `%USERPROFILE%\.vscode\extensions` on Windows) for
   `ivor.pyokka-*`, take the highest version, and set `PYTHONPATH` to its `dist/python`.

Verify before going on: `pyokka -h` (or `python -m pyokka_runtime -h`) must print the usage line
with `debug` and `history` in it. If none of the three gives that, stop there and tell the user
which step failed.

The debugger may also need the editor's launcher. A cold `pyokka debug` opens a URI through `code`
on PATH, or through `$PYOKKA_CODE` when that is set. If `code` is missing, the CLI says
``cannot find the `code` command``. Find the launcher this editor ships (VS Code on macOS keeps it
at `<app>/Contents/Resources/app/bin/code`; Cursor's is `cursor`; on Linux it is usually on PATH
already), and set `PYOKKA_CODE` for this shell. Or ask the user to run "Shell Command: Install
'code' command in PATH". Commands you leave behind use `~`, `$HOME` and globs, so they work for
any user and any version.

## Sessions

**Saved run.** `pyokka run FILE --save run.json` executes the file once; every command then
takes `run.json` first. A run that reports `0 steps` and `exit None` did not run the program: the
runner failed. Read its error first. `PermissionError: Operation not permitted` means your own
sandbox blocked the child process or its socket; ask to run the command outside the sandbox, and
leave the program and its config as they are.

Read the lines `run` prints before anything else. The first names the Python that ran the program;
when it says `pyokka's own` and the program needs its project's packages, rerun with `--python
.venv/bin/python`. A `WARNING: recording truncated` means the steps after the cap are missing: rerun
with the `--exclude` it names (or a higher `--max-steps`) before you read the run. A value ending in
`…(+N chars)` was cut; when you need all of it, rerun with `--max-value-chars 0` and read it with
`--json`. Every verb over a truncated run starts with a `note: truncated recording` line; pass it
on to the user when your answer depends on what came after the cap.

**A debug session is made, not found.** In `debug` mode the first command is `pyokka debug FILE
--at NAME` (or `--module M`): it starts the session in the user's VS Code window and prints the
first stop. Make it your first command: nothing is running until it starts the session, so a
`--live` command sent before it answers `no live session`. Every `--live` command after the first
stop drives that session.

**A recording session (`show`, `explain`) is the user's.** It exists only when the user started
Pyokka on the file in VS Code ("Start on Current File", or a smart-start rule); having the file open
is not enough, and `pyokka.agentAccess` only lets you reach a session, it starts none. Check with
`state --live`, which moves nothing. On `no live session`, move on at once: record it yourself with
`pyokka run FILE --save run.json` and use `run.json` instead of `--live`, or ask the user to start
Pyokka on the file if they want the editor to follow along.

The CLI finds a live session by the file the command names, by the current directory's workspace,
or by `--session demo.py`; when two windows show the same file, `--session
$PYOKKA_HOME/sessions/<pid>-<n>.json` picks one and the error lists them (`PYOKKA_HOME` is
`~/.pyokka` unless set; give the CLI the same value as the window). A file can have a recording
session and a debug session at once, and the CLI routes by verb.

**Keep the session you chose.** Once more than one exists, commands that read the past may refuse
to pick (`history --live` does). Note the session name off the first stop or `state --live` and
pass `--session NAME` on every `--live` command from then on.

**Look with reads, move with `step`.** `step` moves the user's editor, so use it only to go
somewhere. To find out where a recording session is, use the reads, which move nothing: `state`,
`context`, `values`, `var`, `why`, `origin`, `walkthrough`, `graph`, `http`, `exceptions`, `history`.

**Under a sandbox (Codex).** The CLI reaches VS Code through `$PYOKKA_HOME/sessions/*.sock`. If a
command fails with `Operation not permitted` or `stopped answering` right after connecting, your
sandbox blocked the socket or the runner: ask to run that command outside the sandbox. It is not a
missing session.

## In Claude Code: the band

When `printenv CLAUDECODE` prints `1`, you run inside Claude Code, and the Pyokka band can show
the person what the Time Machine shows: the code around the current step, its recorded values, the
call stack, a two-sentence explanation and the bugs found in the run, above their prompt. It reads
the same `--live` session your commands drive.

- Call the `band` tool (`mcp__pyokka-band__band`) with `{"action": "show"}` when you start to step
  through a run with the person, and with `{"action": "hide"}` when the work moves on (planning,
  editing other code).
- Pass `--session NAME` on every `--live` command. The band follows the session the last command
  named; give the tool the same `session` when several are live.
- On a step with a bug, call the tool with `{"action": "origin"}` to show where the bad value came
  from. It runs `pyokka origin` on that step, draws the chain under the bug (newest step first, the
  root marked `▶`, each step a button that moves the Time Machine there), and returns the same
  chain to you. Fix the root, not the line that raised, and check a link marked `inferred` with
  `step --into` before a fix rests on it.
- To leave a fix plan for a bug on the current step, call the tool with `{"action": "fix"}`. The
  plan aims at the root of the origin chain. It
  writes `<program dir>/.pyokka/findings/<file>-<finding>-<where>.md` with the reproduce commands,
  the diff and a check on a patched copy, and marks it `status: fixed` once a fresh run no longer
  shows the finding. The plan is a local file for the person and stays out of commits
  (`.pyokka/findings/` is gitignored). Give the person the plan's path.
- Applying a fix is the person's choice. Point them to `/pk a` to write the planned edit to the
  file (it records the run again) and `/pk u` to put the original back, and leave the source file
  as it is yourself.
- Tell the person the keys once: `/pk n` next step, `/pk w` where from, `/pk f` plan a fix,
  `/pk x` the bugs, and bare `/pk` for the rest.
- At a plain `pyokka debug FILE --at NAME` pause, show the band too. It reads the pause from the
  debugger: the place, the code, the frame's variables with their shape, the stack and the prose,
  marked `paused · no recording`. `/pk n`, `i` and `o` step the program. For history (back, bugs,
  where from, fix plans) point the person to `/pk r`, which runs the program again and records from
  the paused line ([references/debug.md](references/debug.md)).

When the `band` tool is not in your tool list, the band is not installed. Say once that
`claude plugin marketplace add ivorpad/pyokka` and `claude plugin install pyokka-band@pyokka` add
it (README, "In Claude Code"), and carry on with the CLI.

## Stay out of the user's project

Pyokka needs no harness. Use what the project already has: an existing test, the entry point, a
module the user named. Leave their repository exactly as you found it: its files, its config
(`pytest.ini`, `pyproject.toml`) and its directories. If the code needs a database or an external
service to run and no test covers that path, say so and ask the user how they want to reach it. `run.json`, `history.json`, prose and pages go in a scratch
directory outside the repository.

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
user; leave them. If you were interrupted before this, say which of it is still undone.
