# Setup: the runtime, the editor's launcher and the MCP server

Read this when `pyokka -h` fails, when a cold `pyokka debug` says ``cannot find the `code`
command``, or before you register the MCP server.

## Find the runtime

Find the runtime fresh on this machine, each session. Extension folders carry a version
(`ivor.pyokka-0.1.3`), so a path saved in a note or another session goes stale on the next update
and fails as `No module named pyokka_runtime`. Look in this order:

1. `pyokka` on PATH (`command -v pyokka`), else `~/.local/bin/pyokka` by its full path. With
   `pyokka.agentAccess` on, the extension keeps that file pointing at its current runtime and
   setting `PYOKKA_CODE`. A stock macOS PATH does not include `~/.local/bin`, so call it by that
   full path; the user's shell profile stays as it is.
2. `scripts/pyokka.sh` in the skill's directory (the one SKILL.md is in) does the same search, and
   inside a Pyokka checkout runs the checkout's own source.
3. The installed extension ships the runtime under `dist/python`. Look in the editor's extensions
   directory (`~/.vscode/extensions`, `~/.vscode-insiders/extensions`, `~/.cursor/extensions`,
   `~/.vscode-server/extensions`, or `%USERPROFILE%\.vscode\extensions` on Windows) for
   `ivor.pyokka-*`, take the highest version, and set `PYTHONPATH` to its `dist/python`.

Verify before going on: `pyokka -h` (or `python -m pyokka_runtime -h`) must print the usage line
with `debug` and `history` in it, and ends with a first command per job (`start here:`). If none
of the three gives that, stop there and tell the user which step failed.

## The editor's launcher

The debugger may also need the editor's launcher. A cold `pyokka debug` opens a URI through `code`
on PATH, or through `$PYOKKA_CODE` when that is set. If `code` is missing, the CLI says
``cannot find the `code` command``. Find the launcher this editor ships (VS Code on macOS keeps it
at `<app>/Contents/Resources/app/bin/code`; Cursor's is `cursor`; on Linux it is usually on PATH
already), and set `PYOKKA_CODE` for this shell. Or ask the user to run "Shell Command: Install
'code' command in PATH". Commands you leave behind use `~`, `$HOME` and globs, so they work for
any user and any version.

## Registering the MCP server

To register it, first check that `~/.local/bin/pyokka -h` prints the usage. No such file means
`pyokka.agentAccess` is off: ask the user to turn it on in VS Code's settings, which writes the file
at once, rather than registering a `python3 -m pyokka_runtime` command of your own. Then `mcporter
config add pyokka --command ~/.local/bin/pyokka --arg mcp --scope home`; the full path works
whatever PATH mcporter starts with. [mcp.md](mcp.md) has the commands for Claude Code and Codex,
the configuration for a checkout without the extension, and how to read and call the tools through
mcporter.
