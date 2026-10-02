# Agents

To understand, debug or explain what a Python file did, use Pyokka instead of reading the source: `skills/pyokka/SKILL.md` is the one skill, with a mode as its first argument. `debug` pauses a running program and steps it (`references/debug.md`), `explain` walks a person through a run in their editor (`references/explain.md`), `show` investigates and hands over a code-history page whose every value `pyokka history` generated from the run (`references/show.md`).
The command reference is `skills/pyokka/references/pyokka-cli.md`, the page's contract `references/code-history.md`, the debugger's `references/live-debugger.md`.
Start with `pyokka story run.json --file FILE` (the map, one step number per line) and `pyokka step run.json N --into` (land in the callee with its arguments). For a program running now, `pyokka debug FILE --at NAME` starts it and prints the first stop.
Run the CLI as `pyokka ...` after a one-time `uv tool install --editable ./python` (it then always runs the checkout's source), or `python -m pyokka_runtime ...` from `python/`; `uvx --from ./python pyokka` keeps serving the environment it built first, so use `--no-cache` with it; `--live` instead of `run.json` drives the open VS Code session (setting `pyokka.agentAccess`).
Build, test and quirks for working on the extension itself: `docs/HANDOFF.md`; wire contract: `docs/PROTOCOL.md`.
