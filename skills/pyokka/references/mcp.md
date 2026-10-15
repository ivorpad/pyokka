# Pyokka as an MCP server

`pyokka mcp` serves the CLI's commands over stdin/stdout to any MCP client. Use it where an agent
has MCP tools but no shell, or where tool calls are easier to allow than shell commands.

```
claude mcp add pyokka -- pyokka mcp            # Claude Code
codex mcp add pyokka -- pyokka mcp             # Codex
mcporter config add pyokka --command pyokka --arg mcp --scope home    # mcporter, for any agent with a shell
```

From a checkout without `pyokka` on the PATH:

```json
{"mcpServers": {"pyokka": {"command": "python3", "args": ["-m", "pyokka_runtime", "mcp"],
  "env": {"PYTHONPATH": "<repo>/python"}}}}
```

Codex's `~/.codex/config.toml`: `[mcp_servers.pyokka]` with `command = "pyokka"`, `args = ["mcp"]`.

Registered in mcporter, an agent with a shell reads the tools a piece at a time:
`mcporter list pyokka --brief` (one signature per tool, about 1.8 KB), `mcporter list
pyokka.pyokka_debug` (one tool), then `mcporter call pyokka.pyokka_debug action=start
file=/abs/app.py 'at=["main"]'`. Every `mcporter call` starts its own `pyokka mcp` process; the
debug session lives in VS Code and a kept runner in its own process, so the next call finds them.
Relative paths resolve against the server's working directory, so pass absolute ones, and
`mcporter call` waits 60 seconds unless given `--timeout MS`, which `pyokka_debug` `status` with a
long `wait_seconds` needs.

## The tools

| Tool | Command | Arguments |
|---|---|---|
| `pyokka_run` | `run FILE --save` | `file`, `save` (default `.pyokka/runs/<name>.json` next to the file), `args`, `python`, `library_code`, `keep`, `no_locals`, `http`, `timeout_ms`, `max_steps`, `exclude`, `only`, `max_value_chars`, `mode` (`normal`, `snaps`, `profile`), `auto_log`, `cwd`, `test` |
| `pyokka_map` | `state`, `walkthrough`, `story`, `steps`, `find`, `graph`, `exceptions`, `http`, `tour`, `diff` | `action`, `run` or `live`, then the command's options: `file`, `scope`, `line`, `from`, `to`, `count`, `all`, `text` (find), `limit`, `goal` and `budget` (tour), `expand`, `no_statements` and `dot` (graph), `before` and `after` (diff) |
| `pyokka_step` | `context` at a step, or `step` with a `move` (`into`, `over`, `out`, `back`, `back-over`, `back-out`) or `to` | `run`, `step`, `move`, `to`, `line`, `count` (live: several steps), `whole_block` |
| `pyokka_value` | `var`, `why`, `origin`, `values`, `eval`, `expand`, `release` | `action`, `run`, `name`, `step`, `line`, `expression`, `frame`, `value_id`, `path`, `depth`, `file`, `scope`, `limit` |
| `pyokka_coverage` | `coverage` | `run`, `file` |
| `pyokka_debug` | the live debugger: `start`, `continue`, `pause`, `stop`, `restart`, `break`, `watches`, `locals`, `exec`, `record`, `status` | `action`; start: `file`, `module`, `args`, `cwd`, `env`, `python`, `at`, `record`, `record_from`, `library_code`, `stop_on_entry`, `no_focus`, `configuration`, `test`; continue: `until`, `to`, `no_wait`; break: `add`, `at`, `when`, `remove`, `on_exception`; watches: `add`, `remove`, `break_when`; locals: `frame`, `scope`, `names_only`, `names`; exec: `source`, `frame`; status: `wait_seconds` (VS Code with `pyokka.agentAccess`) |
| `pyokka_history` | `history` | `run` or `live`, `out`, `at`, `var`, `why` (`[{step, name}]`), `pause`, `prose`, `pad`, `limit`, `lang`, `scope`, `append`, `value_chars` |
| `pyokka_narrate` | `narrate` | `run`, `command`, `dry_run` |
| `pyokka_investigate` | `investigate` | `run`, `value`, `at` |
| `pyokka_learn` | `learn` | `run`, `at`, `prediction`, `reveal` |
| `pyokka_pin` | `pin` | `run`, `out` |
| `pyokka_verify` | `verify` (a failed expectation is an error result) | `run`, `after` or `rerun` (+ `out`), `expect`, `ignore`, `test_out` |
| `pyokka_session` | no command: where a run stands, as JSON | `run` (+ `step`), or `live`/`session` for the open session (its live pause and the Time Machine's position, kept apart), or nothing to list the sessions |
| `pyokka_seek` | no command: the first or last step where a name took a value, or a line ran, as JSON | `run`, then `value` + `equals` or `file` + `line`, `occurrence` |
| `pyokka_save_investigation` | no command: a question and named steps of a run, saved to a new file with the run's sha256 | `path`, `run`, `question`, `checkpoints` (`[{name, step}]`) |
| `pyokka_open_investigation` | no command: the saved checkpoints' contexts, refused when the run changed | `path` |
| `pyokka_page` | `pyokka web FILE` and `pyokka web ctl ...`: the browser page | `action` (`open`, `close`, `list`, then any ctl command: `state`, `goto`, `step`, `line`, `say`, `clear`, `start`, `stop`, `run`, `eval`, `var`, `why`, `peek`, `watch`, `breakpoint`, `debug`, `story`, `profile`, `wait_pause`, `values`, `definition`), `port`, `file`, `python`, `no_watch`, `step`, `kind`, `line`, `say`, `text`, `expression`, `name`, `remove`, `on`, `condition`, `op`, `column`, `after`, `timeout_ms`, `expect` |
| `pyokka_scratchpad` | `pyokka web ctl scratchpad ...`: the page's Scratchpad, an experiment seeded from the live pause in a separate `python -I` | `op` (`open`, `experiment`, `create`, `state`, `update`, `run`, `restore`, `close`, `save`, `list`, `load`, `history`, `say`), `port`, `id`, `title`, `version`, `line`, `code`, `inputs`, `mocks`, `auto_run`, `text` (`say`: a bubble under `line` of the scratchpad's code, empty clears it), `expect` |

The tools over a run take `json` (`true` for the `--json` shape) and `live` (`true`, plus `session`)
for the open VS Code session instead of `run`; `pyokka_debug` is always live. A result is the command's own text; a command's `error:`
and its hint come back as `isError`, so the method in `SKILL.md` and `pyokka-cli.md` applies
unchanged: record, map with the walkthrough, step into, ask why.

`pyokka_debug` `status` has no CLI verb of its own: it prints `state --live`, and with
`wait_seconds` (up to 600) it first waits for the running program to pause or finish, then heads
the state with `paused after waiting N s` or `still running after N s`.

`watch`, `shell`, `cache`, `serve` and `run` without `--save` (`--json`, `--instrumented`,
`--trace-context`, `--watch`, `--record-locals`) have no tool; use the CLI for them.
