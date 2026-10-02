# The live debugger

An ordinary debugger an agent can drive. The program runs at full speed until a breakpoint or an
exception, then waits. You step, read the frame, run a statement in it, continue. Nothing is
recorded and nothing re-runs: the program you are looking at is the one the user's window is
running.

Two things before the first command.

**The window answers only with `pyokka.agentAccess` on.** With it off, a cold `pyokka debug FILE`
makes the window ask the user to allow agent access. **Allow** turns the setting on and starts
that same launch; anything else starts nothing. Tell the user to look at VS Code for the
question; you cannot answer it.

**A reloading server runs your code in a worker the debugger never sees.** `uvicorn --reload`
and `flask --debug` watch files from the parent, and the debugger runs the parent, so
breakpoints never hit and the panel shows a program doing nothing. Launch without the reload
flag, or point the launch at the worker command.

## Starting

```
pyokka debug FILE [--at NAME | --at FILE:LINE] [--args ...] [--stop-on-entry]
                  [--library-code] [--record | --record-from NAME|FILE:LINE]
pyokka debug --module app.server --args --port 8000 [--cwd DIR] [--env K=V] [--python PATH]
```

A cold start brings the VS Code window to the front at the first stop (`code --goto`), because
the CLI runs in a terminal and the editor would otherwise move behind it. `--no-focus` or
`PYOKKA_NO_FOCUS=1` turns that off.

Every `pyokka debug` is remembered per directory (`$PYOKKA_HOME/last-debug.json`). When the program
has exited, `continue --live`, `break --live FILE:LINE` and `restart --live` start that launch
again and print its first stop, with a first line saying what they re-ran: `break` stops at the
breakpoint it was given, `continue --to F:L` at that line, `continue` at the launch's own `--at`.
Re-running repeats the program's side effects (a paid API call is paid again), so say so when it
happens; `--no-start` refuses instead and names the launch.

A file or `--module` implies `--live`. `--args` takes everything after it and hands it to the
program as `sys.argv[1:]`, so it comes last. `--env` repeats. The reply is the first stop: the
breakpoint `--at` named, the first enabled gutter breakpoint, or the first statement when
nothing is set. When the program never reaches that breakpoint it runs to the end without
pausing, exits normally, and `stop --live` says `0 steps`. The launch worked; the breakpoint did
not. Only a stop whose `paused at` names the code you meant shows the debugger is ready.

Breakpoints are the window's and they outlive a launch, so the first stop may be an earlier
session's breakpoint. Run `break --live --list` after the first stop. Remove only the
breakpoints you added and leave the user's alone.

Under pytest, pass `--assert=plain` (`pyokka debug --module pytest --args --assert=plain ...`).
With assertion rewriting on, breakpoints in the code under test can go unresolved, likely because
pytest's import hook sits ahead of Pyokka's. Try this before any other way of launching the tests.

`--at NAME` breaks at a function's entry and the runtime resolves the name, so a module imported
later gets its breakpoint when it loads. `--at` repeats: every one travels with the launch and is
set before the program starts, so a pipeline gets one stop per stage and `continue` walks them in
run order. A dotted name (`--at Ranker.rank`) matches on its last
segment and the class is not checked, so it takes the first `rank` in source order; when two
files define the name the echo says `also defined in …`. Use `--at FILE:LINE` to pin one.

`--library-code` is what makes the debugger step into and pause inside third-party packages,
never the stdlib. Without it a breakpoint in a library function never hits.

`pyokka debug FILE` a second time on a session that is already paused prints that pause and
starts nothing, so asking twice never loses the frame you were reading. On one that is running
it refuses and names `pause --live` and `restart --live`.

### The three routes, and the URI question

A cold `pyokka debug FILE` tries, in order:

1. an existing `kind: "debug"` session whose launch matches;
2. a recording session on that file, which asks its own window (no URI needed);
3. `vscode://ivor.pyokka/debug?...` through `code --open-url` (`$PYOKKA_CODE` if set).

Route 3 makes VS Code ask the user to allow Pyokka to open a URI, the first time. It waits for
an answer, so the CLI can time out after 20 s while the dialog is still up: it polls
`$PYOKKA_HOME/sessions` every 100 ms for 20 s. **That timeout is not a failure.** When the human
clicks Open the session starts, however late, so the next command is `pyokka state --live`. A
second `pyokka debug` only asks another window to answer. Adding `ivor.pyokka` to VS Code's
`extensions.confirmedUriHandlerExtensionIds` stops the question coming back.

The URI handler obeys `pyokka.agentAccess` too: with the setting off it asks first (Allow above),
because a paused program nobody can continue is worse than a refusal. A click after the CLI's 20 s
is still a start: the next command is `pyokka state --live`.

With several windows open, a cold start goes to the **focused** one, and this is the failure the
timeout message does not name. If the focused window has a different project open it accepts the
launch anyway: the program starts and serves requests, but nothing is instrumented, so
`--stop-on-entry` never pauses, every breakpoint stays `(not resolved yet)` however you spell it,
`pause --live --no-wait` never lands, and `stop --live` says `0 steps`. The run looks alive while
nothing you ask for works.

Check it before you debug the debugger: the descriptor's `workspace` in
`$PYOKKA_HOME/sessions/*.json` should contain the program. When it does not, ask the user to focus
the right window, or open the file there first so the CLI finds its socket instead of going
through the URI. `$PYOKKA_HOME/sessions` staying empty for the full 20 s with no dialog on screen is
the same symptom seen earlier.

The mirror of this is a session that ended. When the debug run is over, `--live` falls back to
whatever session is left, which may be a recording on a different file, and the host answers about
*that* session: `continue --live` comes back with `no debug run in progress` from a window you were
not asking. A failed command now says which session took it (`no debug session here: this is the
run session on api/main.py`), so read the second line before concluding the debugger is broken.

## The loop

1. **Start where the question is**, not at the top.
2. **One command per sentence the human said.** "Step over twice and tell me what `total` is" is
   `step --live --over --count 2`, and the answer is already in the stop's `locals:`.
3. **Read the stop you have.** Every stop carries the location and the reason, the frame chain,
   the enclosing function's source with the paused line marked, the frame's variables, and what the
   program printed since the previous stop. Asking `locals --live` right after a stop is a wasted
   round trip.
4. **Say plainly when a question needs a recording.**
5. **Stop the run when you are done.** A paused program holds whatever it opened: a port, a
   file, a transaction.

Open `pyokka shell --live` once and keep it: one command per stdin line, the same words without
`--live`, about 0.5 ms a command instead of 64 ms. One catch: the shell splits a line itself, so
quotes inside an expression are eaten. `eval len(rankings['bm25'])` arrives as
`len(rankings[bm25])` and is refused as an unknown name. Send an expression with quotes in it as
a one-shot `eval --live` instead, where argv keeps them.

## What a stop shows, and what it leaves out

A stop is bounded, or a long function and a chatty program would bury the answer. Every boundary
it draws, it names:

```
paused at run.py:148 (step)
stack: quick_test run.py:148 ← … 7 library frames in openai/_base_client.py, httpx/_client.py ← <module> run.py:203
block quick_test  run.py (60 of 210 lines; --scope for all)
  18  def quick_test(query: str) -> Result:
      … 128 lines
 147      for doc in docs:
>148          score = rank(doc, query)
locals:
  doc = <Doc id=4>
output (2 new lines; 412 earlier):
  ranked 4 docs
  took 1.2s
```

- **`stack` folds library frames, it does not drop them.** A file Pyokka did not instrument has no
  source to show, so a run of those frames becomes one marker with a count and the files it went
  through. Without it the chain read `quick_test ← <module>`: a call the program never made.
- **`block` is cut on the code, not on a number.** The signature always stays, and the rest of the
  budget goes to the suite the paused line is in — the loop body, whole. `… 128 lines` is the exact
  size of the gap. `--scope` prints the function entire.
- **`output` is what your own move printed**, not the tail of the run. `output: nothing new since
  the last stop` means the step printed nothing; `412 earlier` is what came before it, still
  readable with `--scope` or `state --live`. Re-reading the same stop shows the same lines again,
  so nothing is lost by asking twice.

`values:` is always empty here and `count`, `moves` and `coverage` are absent: nothing was
recorded, so what a statement *produced* comes from `locals`, `eval --live` or a watch, never from
the stop alone. The editor still shows values: at every pause each line of the paused function,
up to the stopped one, gets `name = value` for the names the frame holds, read from the frame.
Lines that ran in other functions have nothing, because nothing kept them; that needs `--record`.

## Moving and reading

```
pyokka continue --live [--no-wait | --until EXPR | --to FILE:LINE]
pyokka step --live --into|--over|--out [--count N]
pyokka pause --live [--no-wait]
pyokka locals --live [--frame N]
pyokka eval --live EXPR [--frame N]
pyokka break --live [FILE:LINE ...] [--when EXPR] [--at NAME] [--remove F:L] [--list]
                    [--on-exception off|uncaught|raised]
pyokka watches --live [--add EXPR [--break-when change|true]] [--remove ID] [--list]
pyokka stop --live | pyokka restart --live [--stop-on-entry]
pyokka record --live
```

`--frame N` sends `locals`, `eval` and `exec` to a caller frame; the stop's `stack:` numbers
them, innermost 0.

`eval --live` reads without side effects: names, attributes, subscripts, operators and pure
calls (`len`, `sorted`, `isinstance`, non-mutating methods of `str`, `dict`, `list`, `tuple`,
`set`). It refuses a function of the program's own, because a hover must never change the
program.

A `def` line as a breakpoint pauses at every call of the function. `break --live --when EXPR`
pauses only when the expression is true there. `watches --live --add EXPR --break-when true`
pauses at the first statement where an expression turns true, before that statement runs, which
is how you find where a value became `None` without knowing where to look.

`break --live --on-exception raised` pauses at every raise in the program's own code, the ones a
`try` swallows included; `uncaught` (the default) only where nobody caught it; `off` never. When
a program raises with the debugger attached it pauses where it raised instead of dying, with the
frame still live.

## Writing to the frame

`exec --live SOURCE` runs a statement in the paused frame: an assignment, a call, an import, a
block. The program sees the result when it continues, which is the point.

```
$ pyokka exec --live 'rank = 3'
ok
values modified from the console: they are no longer the program's own
```

Three things to say to the user:

- **Every stop after it says so.** The stop line gains `(values modified from the console)`, the
  Debugger view shows a banner, the status bar tooltip repeats it, and a code-history checkpoint
  built from that pause carries it in its tag. What the program does from then on is not what it
  would have done on its own, and a bug report built on it is worth less. Say what you changed.
- **A statement that raised leaves the session paused**, and may have written half of what it was
  going to. The next `continue` works. Source that does not compile is a different thing: a
  failed command (`SyntaxError`, exit 2), not a statement that ran.
- **A brand-new name lives in the frame's mapping, not in the compiled code.** Later `exec`,
  `eval` and `locals` see it; the function's own statements do not, because the code object has
  no slot for it. Assign to names the function already has.

## Recording, when you need the past

`pyokka debug FILE --record` runs the debugger and records at the same time. It is slower and it
needs a file, because a module launch has no document for a run-all session to hang on. In
exchange the Time Machine opens over the recording at every pause: `step --live --back` replays,
`context --live N` reads any earlier step, and `why --live <step> NAME` walks back through the
assignments that produced a value.

Use it when the question is "how did it get this value", and the plain debugger when the
question is "what does it do next".

`pyokka debug FILE --record-from NAME` (or `FILE:LINE`) records from a pause on: the code before
it runs at the debugger's speed (about 1.2x a plain debugger run, against about 9x for
`--record`), and the pause at NAME becomes step 0 of the recording, its stop line ending in
`recording starts here, step 0`. Everything after it is recorded as with `--record`. What ran
before it is not: `step --live --back` stops at step 0, and a `why` chain reaching an earlier
value ends with `made before #0, where the recording started`. Coverage still covers the whole
run. A pause before NAME (another `--at`, a step) says `not recording yet`; `pyokka record --live`
there starts the recording at that pause instead.

## Servers

A server pauses when the next request arrives, not when you ask. `pause --live` on a program
blocked in `accept()` waits for the next statement, which may be minutes: `pause --live
--no-wait` answers `pause requested` at once and lets the pause arrive when a request does. The
same on the other side: `continue --live --no-wait` answers `resumed` without waiting, which is
what you want when a handler is holding a request open.

Two requests that hit the same breakpoint pause one after the other, never at once, and each
stop names its thread. `watch --live` streams `paused` / `resumed` / `output` / `finished` until
Ctrl-C, which is how you follow a server's log while it runs.

`pyokka.runTimeout` does not apply to a debug session: a paused server outlives any clock.

Under HTTP Replay a continue never spends a token, which is the mode to debug API-driven code
in. HTTP is only observed while a run records, so a `record: false` session leaves the clients
untouched.

## Limits

- One thread is paused at a time. `continue`, `step` and `locals` address the thread being
  served; there is no thread argument and no per-thread stop list.
- A breakpoint inside a library module's import-time body does not pause. One in a library
  *function* does, when stepped code calls it, with `--library-code`.
- An edit while the program is paused is accepted and not applied. What runs is what was on disk
  when the run started; `restart --live` picks the edit up.
- When the program exits, the debug session is gone: no finished run, nothing left to read. A
  command that arrives after it says so and names `pyokka debug FILE`.
- `why`, `var`, `story`, `walkthrough`, `graph`, `exceptions`, `http`, `values`, `find` and
  `steps` need a recording and answer `<verb> needs a recording`, and so do the backward moves of
  `step`. Restart with `--record`, or answer from the frame, and say which.

## A live pause on the page

`pyokka history --live --pause --out history.json` turns the current pause into a checkpoint of
kind `live pause`, built from the stop's `locals`, `stack` and `output`. To follow a program
through several pauses, run it at each pause with `--append` and the same `--out`: each run adds
one checkpoint with a fresh id; that is how pauses join one page. With more than one session open, pass
the same `--session NAME` you used for the debug commands, or it refuses to pick one. It reads
the pause with `context` and nothing else, so it never moves a session the user is looking at,
and it refuses when nothing is paused rather than starting anything.

The checkpoints are only data until the page is rendered. Render after the last pause
(`node <skill>/scripts/render-code-history.cjs history.json history.html`), not at the end of the
conversation, so an interruption leaves an HTML page behind and not just JSON.

That card carries no provenance chain, because a `record: false` session recorded nothing behind
the pause. That is a fact about the evidence, and the page says it rather than leaving a reader
to assume otherwise.
