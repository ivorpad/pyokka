# Recovery: a refusal, nothing paused, or a pause where you set nothing

Each entry is a signature as the tool prints it, what it means, and the one command it asks for.
Find the entry, run the command, go on. None of them needs a question to the person except
where it says so.

## Nothing paused

- `finished: exit 0, N steps` right after `pyokka debug FILE --at NAME` or a review `start`: the
  program ran to its end without reaching the breakpoint. Either NAME never ran (another entry
  calls it, or the test does not reach it: read the call site, pick another `--at` or another
  test), or an extension older than 0.5.4 launched a test or a `--module` on a repository that is
  not an open folder and instrumented nothing. `pyokka state --live` says what is live; the Pyokka
  output log's first line, `Pyokka activating (build …)`, names the build that answered.
- A `--test` entry: pytest catches the test's own exceptions, so a pause on one comes only from
  `pyokka break --live --on-exception raised`; a failing test ends with `finished: exit 1, N steps`.

## A pause where you set nothing

- `paused at FILE:LINE (breakpoint)` on a line you did not add: VS Code keeps every breakpoint an
  agent adds, across sessions and restarts. `pyokka break --live` lists them. `pyokka break --live
  --clear` removes them all, yours included; a review then needs `review view vscode` to set its
  own again. Breakpoints the person set before you belong to them: when you can tell them apart,
  remove only yours, `pyokka break --live --remove FILE:LINE`.

## The session is gone

- `error: no live session for …` after the program ended: a finished program takes its session
  with it and leaves its breakpoints in the window. To remove yours, start the session again with
  the same `pyokka debug …`, then `break --live --remove …`, then `stop --live`. `stopped: exit
  None, N steps` is a run you ended; `exit None` is right.
- `the VS Code debug session of this review is gone (the window closed, or the program was
  stopped)`, or `the program ended (exit N); no pause to record`: `review view vscode` runs the
  entry again with a breakpoint on each remaining item, and what was shown stays shown. When the
  agenda is done, go on to the findings instead.
- ``cannot find the `code` command`` on a cold start: [setup.md](setup.md).

## The answer looks older than the build

- A local cut at 200 characters with no `hint:` line, no `python:` and `session:` lines after a
  review `start`, or no `change:` section at a `review stop`: the window runs an older extension
  host. `code --install-extension` does not restart a running host, and `code --open-url` lands in
  the running window. Ask the person to quit VS Code or run "Developer: Reload Window"; your next
  command relaunches it. The output log's first line says which build answered.

## A value or an answer was cut

- `…(+N chars)` on a local at a live pause: its fields follow it, and the `hint:` line names the
  way to more, `pyokka locals --live --name NAME --text-len N` (0 for all of it), or a slice such
  as `pyokka eval --live 'NAME[2000:4000]'` for the rest of a long string. Recorded values keep
  200 characters; `pyokka run FILE --save run.json --max-value-chars 0` records them whole
  ([sessions.md](sessions.md)).
- `[… K of N lines left out (A to B); the whole result, M characters, is in PATH]` in an MCP
  answer: the result passed 8,000 characters and went to a file; `sed -n 'A,Bp' PATH`, or your
  file tool, prints the part you need. A PATH under the temp directory means the Pyokka home was
  not writable, as in a sandbox.

## A refusal

- `refused: …` or `error: …` followed by `next:`: nothing changed. Run the `next:` command as it is
  written. The common ones: `--test` without `::NAME` (`review start --base REF --test
  FILE::NAME`); a `stop` without `--say` (continue in the debugger first, and name a value of the
  frame); `skip` with a number not in the plan (`items 9, 12 are not in the plan; nothing was
  skipped`, the plan follows); `--only` with `--full` or a page or chat surface (leave `--only`
  out, or start without `--full`).
- `the person has not spoken since stop N; pass --go-on only after they said next`: wait. A shown
  stop is theirs to move past, and `--go-on` is your word for their next.
