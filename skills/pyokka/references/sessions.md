# Sessions: the saved run, the debug session and the recording session

Read this before the first `--live` command, and when `pyokka run` reports `0 steps` and `exit
None`, or `Operation not permitted`.

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
--at NAME` (or `--module M`; through MCP, `pyokka_debug` with `action: "start"`, `file` and `at`):
it starts the session in the user's VS Code window and prints the first stop. Make it your first
command: nothing is running until it starts the session, so a `--live` command sent before it
answers `no live session`. Every `--live` command after the first stop drives that session.

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
to pick (`history --live` does). `debug` ends its first stop with the name (`session: pass
--session NAME ...`); an older one does not, and `state --live` lists the names. Pass `--session
NAME` on every `--live` command from then on. An older version names a session started with
`--test` after its launch, `-m pytest`, and only that name finds it.

**Breakpoints outlive the session.** They belong to the VS Code window, so an `--at` from an
earlier start still pauses the next run. When you change targets, run `break --live --list` at the
first stop and remove the ones you no longer want ([debug.md](debug.md)).

**Look with reads, move with `step`.** `step` moves the user's editor, so use it only to go
somewhere. To find out where a recording session is, use the reads, which move nothing: `state`,
`context`, `values`, `var`, `why`, `origin`, `walkthrough`, `graph`, `http`, `exceptions`, `history`.

**Under a sandbox (Codex).** The CLI reaches VS Code through `$PYOKKA_HOME/sessions/*.sock`. If a
command fails with `Operation not permitted` or `stopped answering` right after connecting, your
sandbox blocked the socket or the runner: ask to run that command outside the sandbox. It is not a
missing session. The browser page is a server on 127.0.0.1, and a sandbox without network access
makes `pyokka web ctl` and `pyokka_page` say the system refused the connection (an older version
says `no Pyokka page is served on 127.0.0.1:PORT`) while the page is open; check outside the
sandbox before you believe either.
