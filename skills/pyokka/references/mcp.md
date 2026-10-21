# Pyokka as an MCP server

`pyokka mcp` serves the CLI's commands over stdin/stdout to any MCP client. Use it where an agent
has MCP tools but no shell, or where tool calls are easier to allow than shell commands.

```
claude mcp add pyokka -- ~/.local/bin/pyokka mcp                                 # Claude Code
codex mcp add pyokka -- ~/.local/bin/pyokka mcp                                  # Codex
mcporter config add pyokka --command ~/.local/bin/pyokka --arg mcp --scope home   # mcporter, for any agent with a shell
```

`~/.local/bin/pyokka` is written by the VS Code extension once `pyokka.agentAccess` is on. The full
path works whatever PATH the client starts with; the shell expands `~` before the client stores it.
Check that `~/.local/bin/pyokka -h` prints the usage before registering: a client takes a missing
file without complaint and fails only when it starts the server.

From a checkout without the extension:

```json
{"mcpServers": {"pyokka": {"command": "python3", "args": ["-m", "pyokka_runtime", "mcp"],
  "env": {"PYTHONPATH": "<repo>/python"}}}}
```

Codex's `~/.codex/config.toml`: `[mcp_servers.pyokka]` with `command = "/Users/YOU/.local/bin/pyokka"`
(TOML does not expand `~`), `args = ["mcp"]`. Codex waits `startup_timeout_sec` (10 by default) for
the server to start and `tool_timeout_sec` (60 by default) for each tool call; set `tool_timeout_sec`
past the longest `timeout_ms` or `wait_seconds` you pass.

Registered in mcporter, an agent with a shell reads the tools a piece at a time:
`mcporter list pyokka --brief` (one signature per tool, about 3 KB; the listing without `--brief`
is every tool's docs at once, about 30 KB), `mcporter list pyokka.pyokka_debug` (one tool), then
`mcporter call pyokka.pyokka_debug action=start file=/abs/app.py 'at=["main"]'`: `key=value`
arguments, arrays as JSON, or the whole object as `--args '{...}'`. The paths, the timeout and the
process model differ from the shell; [What differs from the shell](#what-differs-from-the-shell)
says how.

## The tools

The references write commands in CLI form. Each maps to one tool, and its flags to the arguments of
the same name (`--auto-log` is `auto_log`):

| Tool | Command | Arguments |
|---|---|---|
| `pyokka_run` | `run FILE --save R` | `file`, `save` (default `.pyokka/runs/<name>.json` next to the file), `args`, `python`, `library_code`, `keep`, `no_locals`, `http`, `timeout_ms`, `max_steps`, `exclude`, `only`, `max_value_chars`, `mode` (`normal`, `snaps`, `profile`), `auto_log`, `cwd`, `test` |
| `pyokka_map` | `state`, `walkthrough`, `story`, `steps`, `find`, `graph`, `exceptions`, `http`, `tour`, `diff` | `action`, `run` or `live`, then the command's options: `file`, `scope`, `line`, `from`, `to`, `count`, `all`, `text` (find), `limit`, `goal` and `budget` (tour), `expand`, `no_statements` and `dot` (graph), `before` and `after` (diff) |
| `pyokka_step` | `context R N`, or `step R N --into` as `step` with a `move` (`into`, `over`, `out`, `back`, `back-over`, `back-out`) or `to` | `run`, `step`, `move`, `to`, `line`, `count` (live: several steps), `whole_block` |
| `pyokka_value` | `var`, `why`, `origin`, `values`, `eval`, `expand`, `release`; `why` with `live` and `rerun: true` is `why --live STEP NAME --rerun`, the rerun value under the tree, copied whole by running the program again in a separate process (files it writes are written again, network answers come from the HTTP recording), so the tool is not marked read-only | `action`, `run`, `name`, `step`, `line`, `expression`, `frame`, `value_id`, `path`, `depth`, `rerun`, `file`, `scope`, `limit` |
| `pyokka_coverage` | `coverage` | `run`, `file` |
| `pyokka_debug` | the live debugger. `debug FILE --at NAME --args ...` is `start` with `file`, `at: [NAME]`, `args: [...]`; `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`, `exec` and `record` with `--live` are that `action`; `state --live` after the person steps in VS Code is `status` | `action`; start: `file`, `module`, `args`, `cwd`, `env`, `python`, `at`, `record`, `record_from`, `library_code`, `stop_on_entry`, `no_focus`, `configuration`, `test`; continue: `until`, `to`, `no_wait`, `whole_block` (`--scope`; pause takes `no_wait` and `whole_block` too); break: `add`, `at`, `when`, `remove`, `on_exception`; watches: `add`, `remove`, `break_when`; locals: `frame`, `scope`, `names_only`, `names`, `text_len` (characters of each value, default 2,000, 0 for all of it; pyokka_value eval with live takes it too); exec: `source`, `frame`; status: `wait_seconds` (VS Code with `pyokka.agentAccess`) |
| `pyokka_history` | `history` | `run` or `live`, `out`, `at`, `var`, `why` (`[{step, name}]`), `pause`, `prose`, `pad`, `limit`, `lang`, `scope`, `append`, `value_chars` |
| `pyokka_narrate` | `narrate`: writes the gloss into the saved run | `run` (a saved run.json), `command`, `dry_run` |
| `pyokka_investigate` | `investigate R --value NAME` | `run` or `live` (+ `session`), `value`, `at` |
| `pyokka_learn` | `learn R --at N --reveal`: call once with `at` and `prediction`, then again with the same `prediction` and `reveal: true` | `run` or `live` (+ `session`), `at`, `prediction`, `reveal` |
| `pyokka_pin` | `pin R --out P` | `run` or `live` (+ `session`), `out` |
| `pyokka_verify` | `verify R --after R2 --expect N=V` (a failed expectation is an error result; `rerun` runs the program again) | `run` or `live` (+ `session`), `after` or `rerun` (+ `out`), `expect`, `ignore`, `test_out` |
| `pyokka_session` | no command: where a run stands, as JSON | `run` (+ `step`), or `live`/`session` for the open session (its live pause and the Time Machine's position, kept apart), or nothing to list the sessions, each with `recording` (true: a Time Machine run you can step back in), plus `ready` (a session is open) and `vscode`: `code` (the launcher path or null), `extension` (installed ivor.pyokka version or null), `agentAccess` (from user settings.json, null when unset), `closedSessions` (descriptors left by closed windows); with none open, the first note says what is missing and gives the start call |
| `pyokka_seek` | no command: the first or last step where a name took a value, or a line ran, as JSON | `run`, then `value` + `equals` or `file` + `line`, `occurrence` |
| `pyokka_save_investigation` | no command: a question and named steps of a run, saved to a new file with the run's sha256 | `path`, `run`, `question`, `checkpoints` (`[{name, step}]`) |
| `pyokka_open_investigation` | no command: the saved checkpoints' contexts, refused when the run changed | `path` |
| `pyokka_page` | `pyokka web FILE` and `pyokka web ctl ...`: the browser page | `action` (`open`, `close`, `list`, then any ctl command: `state`, `goto`, `step`, `line`, `say`, `clear`, `start`, `stop`, `run`, `eval`, `var`, `why`, `peek`, `watch`, `breakpoint`, `debug`, `story`, `profile`, `wait_pause`, `values`, `definition`), `port`, `file`, `python`, `no_watch`, `cwd` (open: the project root), `step`, `kind`, `line`, `say`, `text`, `expression`, `name`, `remove`, `on`, `condition`, `op`, `column`, `after`, `timeout_ms`, `expect` |
| `pyokka_scratchpad` | `pyokka web ctl scratchpad ...`: the page's Scratchpad, an experiment seeded from the live pause in a separate `python -I` | `op` (`open`, `experiment`, `create`, `state`, `update`, `run`, `restore`, `close`, `save`, `list`, `load`, `history`, `say`), `port`, `id`, `title`, `version`, `line`, `code`, `inputs`, `mocks`, `auto_run`, `text` (`say`: a bubble under `line` of the scratchpad's code, empty clears it), `expect` |
| `pyokka_review` | `review start`, `view`, `stop`, `ask`, `skip`, `look`, `try`, `finding add`, `fix`, `report`, `state`: a change reviewed as a guided debug session ([review.md](review.md)) | `action` (`start`, `view`, `stop`, `ask`, `skip`, `look`, `try`, `finding`, `fix`, `report`, `state`, `close`), then the CLI's flags by name. start: `base`, `repo`, `entry`, `test`, `full` (the recorded review of both trees; without it the entry starts under the debugger in VS Code, paused on entry with a breakpoint per changed function, and `stop --say` records the pauses `pyokka_debug continue` reaches; the answer names the interpreter in a `python:` line and the debug session in a `session:` line, the file `pyokka_debug` takes as `session`), `only` (files, directories or globs relative to the repository: the changed functions outside every one, and their edge candidates, are set aside before numbering; refused with `full`), `pr`, `python`, `dir`, `args`, `surface` (`vscode` is the default; in a `full` review it records the entry in the editor, needing `pyokka.agentAccess` on and the `code` command, and an explicit `vscode` with neither a live session nor `code` is refused before recording; `page` serves the browser page and is refused before recording when `port` is taken; `chat`; a review of one `test` stays in chat whatever was asked, since both views run files and not tests), `port`; view: `surface` (`vscode`, `page` or `chat`: opens the person's view after start, when it opened none or they moved; without `full`, `vscode` starts the debug session again with the remaining items' breakpoints and `page` or `chat` is refused; in a `full` review it opens and moves its own view and needs no `pyokka_debug` session), `port`; stop: `n`, `say`, `go_on` (required for the stop after a shown one, once the person said next), `surface` (`vscode` or `page` is refused when nothing answers, or when the session on the entry recorded another run, and `next:` names what starts one; on a review of one `test` either is refused with `next:` the same stop in chat; `auto`, the default, takes what answers and says chat, not moved, when none does), `port`, `session`; ask: `line` (`FILE:LINE`), `say`; skip: `n`, or `ns` for several in one call (a number not in the plan or shown already refuses them all), `why`; look: `expr`, `step`; try: `code` (the Python text itself), `expr`, `inputs`, `mocks`, `edge`, `title`, `port`; finding: `file`, `line`, `severity`, `title`, `step`, `repro`, `expect`, `fix`; fix: `patch`, `tests`; report: `out`, `page` (a path, or true for DIR/page.json: the review as a code-history page), `tour` (a path, or true for DIR/tour.json: the review as a tour of head.json); every action: `dir`, `json`. The schema requires `say` for `stop` and `ask`, `step` and `repro` for `finding` |

The tools over a run take `json` (`true` for the `--json` shape) and `live` (`true`, plus `session`)
for the open VS Code session instead of `run`; `pyokka_debug` is always live. `pyokka_narrate`,
`pyokka_seek` and `pyokka_save_investigation` read a saved run: record one with `pyokka_run` first.
Call `pyokka_session` with no arguments before `pyokka_debug` or a review in VS Code: it lists the
sessions VS Code publishes, `kind: "run"` for a recording you can step back in, `kind: "debug"` for
a forward-only pause.

Each tool's description says where its result lands. Most answer as text in the reply.
`pyokka_run`, `pyokka_history`, `pyokka_pin`, `pyokka_verify` (`out`, `test_out`) and
`pyokka_save_investigation` write files; `pyokka_history` writes JSON and the page is a separate
`node` render step its result prints. `pyokka_debug` and a live `pyokka_step` move run the program
in the VS Code window, where the person sees the pause. `pyokka_page` and `pyokka_scratchpad` drive a
browser tab: hand the person the URL from `open`, since the tool opens no browser, and their bubbles
show only in that tab. A result is the command's own text; a command's `error:`
and its hint come back as `isError`, so the method in `SKILL.md` and `pyokka-cli.md` applies
unchanged: record, map with the walkthrough, step into, ask why.

A result over 8,000 characters (`PYOKKA_MCP_MAX_CHARS` sets another limit) is written whole to
`$PYOKKA_HOME/tool-results/<yyyymmdd-HHMMSS>-<tool>-<action>.txt`, or to `pyokka-tool-results` in
the system temp directory when the home cannot be written, and the 200 newest files are kept. The
reply keeps the first lines and the last ones, `next:` among them, with two lines between them that
name the lines left out, the file and the `sed -n 'A,Bp' FILE` that prints them. A file tool reads
the same line numbers. A review `start` on a large change, 65,050 characters on 2026-10-19, comes
back as about 7,500. A JSON answer (`json: true`, `pyokka_session`, `pyokka_page`, …) comes back as
a small JSON object instead: `spilled`, `path`, `characters`, `lines`, `head` (its first lines as a
string) and `read`. The CLI prints every result whole.

`pyokka_debug` `status` has no CLI verb of its own: it prints `state --live`, and with
`wait_seconds` (up to 600) it first waits for the running program to pause or finish, then heads
the state with `paused after waiting N s` or `still running after N s`.

## What differs from the shell

- **Absolute paths.** The server resolves `file`, `run`, `save`, `out` and `cwd` against its own
  working directory, the one its client started it in. Pass absolute paths.
- **Timeouts.** `mcporter call` gives up after 60 seconds. Pass `--timeout MS` with
  `pyokka_debug` `status` and a long `wait_seconds`, a `pyokka_run` whose `timeout_ms` is over
  60000, and a cold `pyokka_debug` start that has to open VS Code.
- **State lives outside the server.** Each `mcporter call` starts its own `pyokka mcp` process.
  The debug session lives in VS Code, a kept runner in its own process and a recording in its
  `run.json`, so the next call finds them.
- **Hints give both forms.** An error comes back as the CLI's `error:` line and a hint that names
  the next step as the CLI command and as the MCP call, e.g. `pyokka debug FILE --record` (MCP:
  pyokka_debug {"action": "start", "file": "FILE", "record": true}). Send the MCP call as given.

The server also answers `prompts/list` with one prompt, `review`, and serves it on `prompts/get`:
the method of [review.md](review.md)'s first section, about fifteen lines. In Claude Code it is
`/mcp__pyokka__review`. A `pyokka_review` refusal is an error result with the text the CLI prints,
and the tool keeps the current review in `$PYOKKA_HOME/reviews/current`, so `dir` can be left out
after `start`.

`watch`, `shell`, `cache`, `serve` and `run` without `--save` (`--json`, `--instrumented`,
`--trace-context`, `--watch`, `--record-locals`) have no tool; use the CLI for them. To finish
clean through tools: `pyokka_debug` `break` with `remove`, then `break` alone lists what is left,
then `stop`; `pyokka_value` `release` for a kept runner.
