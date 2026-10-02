# debug: pause a running program and look

The user wants real pauses in their editor: start the program, stop where the question is, step,
read the frame, maybe change a value, continue. Answer in chat with the stops you saw (file, line,
the values that matter). The answer lives in chat; offer the page in one line when the finding is
worth keeping, and build it with [show.md](show.md).

The full contract (the three start routes, `exec`, servers, threads, limits, what a stop leaves
out) is [live-debugger.md](live-debugger.md). This file is the workflow.

## Start

```
pyokka debug FILE [--at NAME | --at FILE:LINE] [--args ...] [--stop-on-entry] [--library-code]
                  [--record | --record-from NAME | --record-from FILE:LINE]
pyokka debug --module app.server --args --port 8000 [--cwd DIR] [--env K=V]
pyokka debug --module pytest --args --assert=plain -x tests/test_x.py::test_name
```

A file or `--module` implies `--live`. The reply is the first stop: the breakpoint `--at` named,
the first gutter breakpoint, or the first statement when nothing is set. The window comes to the
front at that stop, and the paused function's lines show their values in the editor, read from
the frame.

**Start with `pyokka debug`.** `state --live`, `break --live` and `continue --live` drive a session
that exists. `debug ... --at` creates the session and the breakpoint in one command. Once you have
run `pyokka debug` from a directory, those verbs start it again by themselves after the program
exits, and their first output line says so; tell the user, because the program ran again.

Add `--record` when the user wants to watch the program's history in the editor (every line's
values, the Time Machine, `why`), the target is a file, and it is small enough to record: every
statement is kept, so a request that runs a million steps is slow to record. Without it the
editor shows the paused function's values only. `pyokka debug FILE --record` from a terminal opens
the file in an editor and attaches at the first pause. See "History while debugging" below.

When the question is about one function of a long run, use `--record-from NAME` (or
`FILE:LINE`) instead of `--record`. The program runs at the debugger's speed up to that pause and
records from there on, so the Time Machine, `why --live`, `var --live` and `history --live` cover
everything that runs after it. The stop line ends with `recording starts here, step 0`. A `why`
chain that reaches a value made earlier ends with `made before #0, where the recording started`:
read that value from the stop's `locals:` instead. At an earlier pause of the same run (another
`--at`, a step), `pyokka record --live` starts the recording right there.

Pick a breakpoint the run will reach:

- Prefer `--at FUNCTION` (the entry of the function the question is about) over a line number.
- With a line, read the source around it first. A `raise`, an error branch, an `except` body or
  an early `return` does not run on the success path. Break on the `def` or the first statement
  of the path you expect to run.
- If the user named a line, use it, and say so if it sits on a path the run may not take.

Reach the code through an existing test or the program's own entry point.

**Following a pipeline: one `--at` per stage.** `--at` repeats, and every one is set before the
program starts, so `pyokka debug app.py --at load --at clean --at score` stops at the first stage
that runs, and each `continue --live` goes to the next breakpoint, in whatever file it is, until
the program finishes. This is the PyCharm loop: break, look, resume to the next one. Add a stage
while paused with `break --live --at NAME` or `break --live FILE:LINE`; the run picks it up at
once. Name stages by function where you can, since a function name survives edits that move
lines.

**Under pytest, launch with `--assert=plain`.** Pytest's assertion rewriting installs its own
import hook ahead of Pyokka's, and the modules it compiles may never get instrumented, so
breakpoints in them never resolve. That is the likely cause, not a proven one. `--assert=plain`
changes nothing about which tests pass.

## Ready means paused where you meant

Three things can each succeed or fail on their own: the launch, the breakpoint, the program. A
launch whose breakpoint never runs finishes without pausing, the program exits 0, tests pass, and
`stop` reports `0 steps`. None of that means the debugger worked. Before you say it is ready, read
the first stop's `paused at FILE:LINE` and check it is the file and function you asked for. If it
is somewhere else, or there was no stop, say so, and fix the launch before going on.

**Breakpoints outlive the launch.** Gutter breakpoints belong to the VS Code window, so one added
by `--at`, `break --live` or an earlier session is still there next time, and the run stops at it
first. After the first stop, run `break --live --list` and compare it with what you asked for.
Keep a list of the breakpoints you added; those are the ones you remove at the end, with
`break --live --remove F:L` for a line and `--remove NAME` for the function breakpoint `--at NAME`
made. Remove them before `stop --live`: with no session the CLI cannot reach the window.

**The window answers only with `pyokka.agentAccess` on.** With it off, VS Code asks the user to
allow agent access, and **Allow** starts the launch; tell them to look for the question. The first
URI also needs a click.
`pyokka debug` tries an existing debug session, then a recording session on the file, then
`vscode://ivor.pyokka/debug`. That last one makes VS Code ask the user to allow it, and the CLI
can time out after 20 s while the question is still on screen. That is not a failure: the next
command is `pyokka state --live`, not a second `pyokka debug`.

The URI goes to the **focused** window, and a window with a different project open accepts it and
instruments nothing: the program runs, no breakpoint resolves, `stop --live` says `0 steps`.
Check `workspace` in `$PYOKKA_HOME/sessions/*.json` before blaming anything else.

## When it did not pause

Change one thing at a time, and try only a few. In order: check the session's `workspace`, check
the breakpoint line runs, add `--assert=plain` under pytest, try `--stop-on-entry` to see whether
anything is instrumented at all. Make one of these changes before each re-run, and note the result.
If all four fail, stop and tell the user what you tried and what each showed.

## At a pause

Every stop already carries the frame (`locals:`) and what the program printed (`output:`), so
`locals --live` right after a stop is a wasted round trip. One command per sentence the human
said: "step over twice and tell me what `total` is" is `step --live --over --count 2`, and the
answer is in that stop's `locals:`.

**`exec --live 'rank = 3'` writes to the paused frame, and the program sees it.** Every stop after
that says `(values modified from the console)` and a bug report built on it is worth less. Say what
you changed.

## History while debugging

A plain `pyokka debug` records nothing, ever: not while it runs and not after it finishes. When the
program exits the session is gone and there is no history to look at. So `why`, `var`, `story`,
`walkthrough`, `graph`, `exceptions`, `http`, `values` and `step --back` answer `<verb> needs a
recording`, and waiting for the program to finish does not change that. Pick by what the user
wants, and say which you used:

| the user wants | run |
|---|---|
| history and live pauses together (Time Machine, `why --live`, `var --live`, `step --live --back`) | `pyokka debug FILE --record ...`: slower, a file only, not `--module`, so not pytest |
| the same, from one function on, in a run that is long before it | `pyokka debug FILE --record-from NAME`: debugger speed up to NAME, recording from its first call on; a file only |
| a code-history page of what they saw while debugging | `pyokka history --live --pause --out h.json` at each pause, `--append` for the next; each card is a live pause with the frame's values and no `why` chain |
| the whole run's history, no pausing | `pyokka run FILE --save run.json`, then `why`, `var`, `walkthrough`, `history` on it (see [show.md](show.md)) |
| only what is in scope now | answer from the stop's `locals:` and the values shown in the editor |

Under pytest (`--module pytest`) a recording is not available, because both `--record` and
`pyokka run` need a file: use the page of live pauses or the stop's values, and tell the user that
history is the part that is missing.

In Claude Code, the band follows a debug session: call the `band` tool with `{"action": "show"}`
after the first stop, and pass `--session NAME` on every `--live` command (SKILL.md, "In Claude
Code: the band"). With `--record` it shows the Time Machine: the step, the recorded values, bugs,
where from and fix plans. With a plain `pyokka debug FILE --at NAME` it shows the pause: the place,
the code, the paused frame's variables with their shape (`list[2]`), the call stack, an uncaught
exception as `⚠ KeyError: 'Ben'`, and the prose. There `/pk n`, `i` and `o` step the program;
back, step numbers, bugs, where from and fix plans answer in one line that they need a recording,
and `/pk r` records from the paused line: it stops the plain run and starts
`pyokka debug FILE --record-from FILE:LINE`, which runs the program again from the top and pauses
the first time it reaches that line. Tell the person the program runs again before they press it. On a step with a finding, `{"action": "fix"}` leaves a fix
plan in `.pyokka/findings/` next to the program, a local file outside commits. Give the person its
path, and point them to `/pk a` to apply the edit and `/pk u` to undo it; the choice to apply is
theirs.

A long session of stops is cheaper through `pyokka shell --live`: one command per stdin line, the
same words without `--live`, about 0.5 ms a command instead of 70 ms.

## What the human says, and what you run

| the human says | the command |
|---|---|
| "start the debugger at `rrf`" | `pyokka debug demo.py --at rrf` |
| "break at line 82" | `pyokka debug demo.py --at demo.py:82` |
| "stop at each stage of the pipeline" | `pyokka debug app.py --at load --at clean --at score`, then `continue --live` per stage |
| "add a breakpoint in the other file" | `pyokka break --live other.py:12` (or `--at fn`), then `continue --live` |
| "resume to the next breakpoint" | `pyokka continue --live` |
| "remove that breakpoint" | `pyokka break --live --remove other.py:12` / `--remove fn` |
| "debug this test" | `pyokka debug --module pytest --args --assert=plain -x tests/test_x.py::test_name` |
| "start the server under the debugger" | `pyokka debug --module app.server --args --port 8000` (no `--reload`) |
| "run to line 82" | `pyokka continue --live --to demo.py:82` |
| "step over until `rank == 3`" | `pyokka continue --live --until 'rank == 3'` |
| "step into that" / "step out" | `pyokka step --live --into` / `--out` |
| "what is in scope" | read `locals:` off the stop you already have |
| "set `rank` to 3 and carry on" | `pyokka exec --live 'rank = 3'` then `pyokka continue --live` |
| "break when `payload` is None" | `pyokka watches --live --add 'payload is None' --break-when true` |
| "stop on every exception" | `pyokka break --live --on-exception raised` |
| "where did this bad value come from" | on a recording, `pyokka origin --live STEP` (or `origin run.json STEP`) with the exception's step from `exceptions`; fix the line marked root, not the line that raised |
| "let it run, do not wait" | `pyokka continue --live --no-wait` |
| "start over" / "stop" | `pyokka restart --live` / `pyokka stop --live` |

## After an edit

When the fix is a code change, compare runs with `pyokka diff`. Save a run before the edit
(`pyokka run FILE --save before.json`), edit, then save `after.json` the same way and run
`pyokka diff before.json after.json`. With a recording session open on the file (Run-all, or
`pyokka debug FILE --record`), `pyokka diff before.json --live` takes its re-run as the after. It lists the statements that
did something different (values, branch arms, calls, raises) with each side's step numbers, so
`pyokka step before.json N --into` opens either side. Report the facts that show the fix took and
anything else that changed with it. The flags and the matching rule:
[pyokka-cli.md](pyokka-cli.md#comparing-two-runs-after-an-edit).

## Done

Finish clean (SKILL.md): remove your breakpoints, `stop --live` unless the user wants the pause,
confirm with `break --live --list` and `state --live`. Then report: where it paused, the values
that answer the question, what you changed with `exec` if anything, and what is still open.
