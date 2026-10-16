# Pyokka in a browser

The Pyokka panel, a code pane and the Time Machine in a plain browser tab, outside VS Code. A
small local bridge runs the Python runtime and relays its NDJSON protocol (`docs/PROTOCOL.md`) to
the page over a WebSocket.

```
pyokka web path/to/file.py --open                     # the installed extension's bridge, on node (20+) or VS Code's own Node
pyokka web ctl state                                  # drive it: every `ctl` command below
```

From a checkout, `node esbuild.mjs` builds the same bridge and `node dist/web/server.js
path/to/file.py --open` runs it. `pyokka web` finds it next to the runtime: `dist/web` beside
`dist/python` in the installed extension, the checkout's `dist/web` after a build. It says so
when the page is not built, when node is missing, when the port is taken (`--port N`, or
`PYOKKA_PORT`) and when `ctl` finds nothing served on the port.

Open http://127.0.0.1:4777/. The left side is the file in Monaco with values after their lines,
coverage in the gutter and the exception on its line; the right side is the same panel the
extension shows. The bridge re-runs the file whenever it changes on disk, so saving in VS Code
or any other editor updates the page. Typing in the page's code pane runs the edited buffer
without saving it, Quokka-style; Ctrl/Cmd+S writes it to disk.

Every view of the panel works as it does in VS Code:

- Entries, Details, Compare and the value diagram; Exceptions; Walkthrough.
- The Time Machine with its steps strip, timeline guide and watch expressions. A watch is recorded
  by one run of the file around the current step, as in Automatic mode.
  While it is on, the header has Step (the next recorded event, into calls as they happen) and
  Step back; the live debugger's bar has Step (the next executed statement, Step into's move).
- Variable History (the rail's variable button) and the Details pane's "why" tree.
- The Execution Diagram (the Time Machine's diagram button, or More > Show Execution Diagram).
- HTTP: the requests of the run, and record/replay from the view's mode menu. Open Recording shows
  the recording in the code pane.
- Narrate (the Walkthrough's sparkle) and the Tour with Narrate Tour. The bridge makes the one
  model call with `PYOKKA_EXPLAIN_COMMAND` when set (a command that reads the prompt on stdin),
  else `claude -p`, else `codex exec`. The tour runs `python -m pyokka_runtime tour` over the run
  with the `--python` interpreter.
- The live Debugger: the header's debug button runs the file for real, with nothing recorded, and
  pauses at breakpoints. Click the gutter or press F9 to set one. Under the code pane are the call
  stack, the variables and continue, pause, step over, into and out, restart and stop (F5, F10,
  F11, Shift+F11, Shift+F5). The panel's Debugger view keeps the watches, breakpoints, where
  exceptions pause, and the output. It runs on a second runtime process, so the recorded run and
  its Time Machine stay as they were.

  At a pause the code pane shows the selected frame's values: hover an identifier for its value,
  and read a shadow (`total = 18`) beside each declaration at or above the paused line. A
  declaration is an assignment target (`=`, `+=`, annotated with a value, `:=`, unpacking), a
  parameter, a `for` target or a `with ... as` target. Which identifier names which binding comes
  from the runtime's `bindings` request with `identifiers` (Python's scopes, from `ast` and
  `symtable`), so a parameter `x` never shows the module's `x`. Only the frame's own variables
  appear; module-level functions, classes and imports are not among them, so their hover says the
  value is not available. Shadows that do not fit the pane are cut; the hover has the full text.
  Editing the source hides them until the next pause of the edited text.

  The shadows are the code history of the debug run: each declaration keeps the values its
  binding had at this run's pauses so far (`total = 0 → 2 → 6`, the last three; hover the line for
  all of them), until the run ends. A function value's hover adds its source and where it starts
  (`inspect.getsource`, read when the Variables list is fetched at a pause, at most 2000
  characters, secrets masked); builtins and functions without a source file show the value only.

- Go to definition: Cmd-click (Ctrl-click on Linux and Windows) on a name. A definition in
  another file opens in a new read-only tab (`/web/source.html?path=&line=&column=`), so the page's
  run, pause and cursor stay put; one in the same file moves the cursor. Cmd-click in that tab
  opens the next one. The runtime resolves the name from the source alone (`ast`; no import runs):
  `def`, `class`, assignments and parameters in the file, and imports followed into the project's
  own files (next to the file, at the project root with `pyproject.toml`, `setup.py`,
  `setup.cfg` or `.git`, and its `src/`), through package re-exports, `module.name` and
  `Class.method`. Names from the standard library, installed packages and builtins open nothing;
  for those use an editor with a Python language server. The bridge serves a file's text to the
  tab only for the running file, files a run instrumented and definition targets it answered.

- Code Story (the rail's book button): the run as one document in the right panel's CODE STORY
  view, one block per pass through a scope, with the step's box and its values; the code pane
  keeps the source. It starts the Time Machine and follows it; click a row to go to the step that
  ran it, and Ctrl/Cmd+click to open the source line in the code pane. Another rail view or
  stopping the Time Machine closes it.
- Profile (the rail's pulse button): one run under the runtime's profiler on a runtime process of
  its own, shown in the code pane as a table of functions by self and total time (Ctrl/Cmd+click
  opens one). `GET /api/profile` downloads the `.cpuprofile` for Chrome DevTools or VS Code.
- Run modes from the Settings view: Automatic runs edits as you type, On Save runs on Ctrl/Cmd+S
  and saves from other editors, On Demand only on Run (a change on disk then just refreshes the text).
  While the live debugger has a run, a save from any editor and a settings change also only refresh
  the text and the settings: Run, the debugger's Restart, or a save after the debug run ends runs it.
  The files a run imported, and those the page opened, are watched as well: a save, an atomic
  rename included, shows their new text in the code pane without moving the Time Machine or the
  paused debugger, and runs nothing.
- More > Show Instrumented File, Show Logs (the bridge's log), Edit Session Settings (the Settings
  view) and View Recent Files: the files this bridge ran (kept in `~/.pyokka/recent.json`);
  picking one makes it the page's file. Only Python files under the starting file's directory can
  be opened.

Nothing is left out for being impossible in a browser; the page's limits are the bridge's: one
main file at a time.

The bridge sends the main file's local imports with its hello, before any run: the runtime lists
them (`python -m pyokka_runtime _imports FILE --root DIR`, stdlib `ast` and import resolution
from the file's directory, the root and the interpreter's `sys.path`; the standard library,
site-packages and anything outside the root are left out), so the page has their source and can
open them. The hello also names the page build (`app.js` size and mtime): after `node
esbuild.mjs` and a bridge restart, a tab with no unsaved edits reloads itself on reconnect.

| Option | |
|---|---|
| `--port N` | default 4777 (`PYOKKA_PORT`) |
| `--cwd DIR` | run the file in DIR, and make DIR the project root when it holds the file, so the debugger stops and steps in the project's own modules (by default the file's folder is both, and code outside it is library code) |
| `--runtime python` | the default: `python3 -m pyokka_runtime serve` from `dist/python` |
| `--runtime "CMD ARGS"` | another command that runs the runtime and speaks the protocol on stdio, started in the file's directory (`PYOKKA_RUNTIME`), such as `uv run python -m pyokka_runtime serve` |
| `--python PATH` | the interpreter for the Python runtime, 3.12+ (`PYOKKA_PYTHON`, default `python3`) |
| `--open` | open the page in the default browser |
| `--no-run` | start without running the file; Run runs it. The page still gets the file's local imports |
| `--no-watch` | do not re-run on save |
| `--verbose` | log the runtime's spawn, stderr and exits |

## Side by side with VS Code

Run the bridge on the file, then in VS Code run **Simple Browser: Show** with
`http://127.0.0.1:4777/?layout=panel`. `?layout=panel` drops the code pane, since VS Code's editor
is next to it; `?layout=code` shows the code pane alone. The layout button in the header cycles
through the three. A window narrower than 760px stacks the code over the panel.

## Agents: step through code while explaining

An agent (Claude Code, Codex, a script) drives the open page and reads back where it is. Every
command answers with the page's state: the step, file, line and function, the source line, the
enclosing function's code (`block`, the current line marked `current`; a live pause's comes from
the debugger), the variables of the current frame as of the step, the call stack, the values logged so far, the
output and the errors.

```
node dist/web/server.js ctl state
node dist/web/server.js ctl line 19 --say "The loop pairs each point with the next one."
node dist/web/server.js ctl step into --say "distance() gets the first pair."
node dist/web/server.js ctl step over      # next | into | over | out | back | backOver | backOut
node dist/web/server.js ctl step next      # exactly one recorded event, into calls as they happen
node dist/web/server.js ctl goto 42
node dist/web/server.js ctl say "Squaring makes the sign irrelevant." --line 13
node dist/web/server.js ctl clear          # remove the bubble
node dist/web/server.js ctl eval "len(points)"   # in the paused frame while the debugger is paused, else against the finished run
node dist/web/server.js ctl peek config.opts   # at a live pause: the binding's captured value as a ValueNode tree, nothing evaluated
node dist/web/server.js ctl run            # run again and wait for it
node dist/web/server.js ctl var total      # every recorded change of a variable
node dist/web/server.js ctl why total --step 13
node dist/web/server.js ctl watch "total * 2"   # --remove drops it
node dist/web/server.js ctl break 11       # toggles; `on` / `off`, --if "i > 2"
node dist/web/server.js ctl debug start    # the live debugger, to the first breakpoint (the first statement when none can hit): continue | step [into|over|out] | pause | stop | state
node dist/web/server.js ctl wait-pause --after N --timeout 25000   # the next pause a person makes, up to 25 s; without --after it reads the cursor
node dist/web/server.js ctl story          # open the Code Story and read it back
node dist/web/server.js ctl profile        # profile one run: the hottest functions
node dist/web/server.js ctl values         # at a debugger pause: the shadows beside declarations and each identifier's hover
node dist/web/server.js ctl definition 7 18   # what Cmd-click on line 7, column 18 opens: [{path, line, column, tab}]
node dist/web/server.js ctl scratchpad open    # at a live pause: copy the paused function and its values, run the copy once
node dist/web/server.js ctl scratchpad experiment --code exp.py --inputs in.py --mocks mocks.py
node dist/web/server.js ctl scratchpad save --title "checkout with SAVE5"   # also: update | run | restore | state | close | create
node dist/web/server.js ctl scratchpad list    # saved scratchpads; history --id ID [--version N], load --id ID [--version N]
node dist/web/server.js ctl scratchpad say "the copy reads the pause's cart" --line 3   # a bubble in the scratchpad; no text clears it
```

`--say` shows the explanation as a bubble under the new line, for the person watching; a move
without it clears the previous bubble. The same commands are the HTTP API the CLI calls:
`GET /api/state`, and `POST /api/command` with a JSON body such as
`{"action": "step", "kind": "over", "say": "..."}` (see `AgentCommand` in
`web/bridgeProtocol.ts`). A command needs a page open; without one the API answers 409.
`ctl` (and MCP's `pyokka_page`) tells a closed port (`no Pyokka page is served`) from a connection
the system refused, which is what a sandbox without network access does to a page that is open.

### Control checks

Read `state.context` before moving or explaining. It names the surface a command acts on:
`source` is `live` while the live debugger has a run (its `runId`, `step`, selected `frame`,
absolute `file`, `line`, `paused`, and the frame's `locals` with `localsReady`), else
`recording` (the Time Machine's position). The other top-level fields describe the recording, as
before, so a finished recording and a live pause can both be read. `shownFile` is the file the
code pane shows, which can differ from the paused frame's.

Pass the context back to refuse a command once another actor moved the page: `expect` in the
JSON body (`{"source": "live", "runId": "d-1", "step": 4, "frame": 0, "file": "/abs/app.py"}`),
`--expect-source`, `--expect-run`, `--expect-step`, `--expect-frame` and `--expect-file` on
`ctl` (`null` for step or file), or `expect` on any WebMCP tool. A stale one fails with
`stale context: KEY ...` before the page changes.

The API controls exactly one page and one command at a time. Two open pages, a second command
while one is pending, and a page that disconnects before answering each return 409 with the
reason, and `GET /api/state` asks the page every time (409 with no page). While the live debugger
has a run, recording commands (`goto`, `step`, `line`, `start`, `stop`, `run`, `var`, `why`,
`watch`, `story`) fail with a pointer to `debug step|state|stop`. `debug continue` and
`debug step` answer at a new pause or the run's end, and `debug stop` once the run ended; a
runtime refusal, or no new pause in 10 s, is an error rather than the old pause.

`peek NAME` reads the binding from the paused frame's captured locals; a dotted path walks dict
keys, list indexes (`items.1.id`) and attributes, and a level the pause did not capture is
expanded from the runtime's store. The answer has `node` (the ValueNode: `type`, `value`,
`length`, `props`, `expressionPath`), `text` (the same tree rendered) and `observed` (run, step,
frame, file, line).

### Scratchpad

The toolbar's beaker (or `ctl scratchpad open`) opens a Scratchpad over the panel at a live
pause. It copies the function around the paused line (`--line N` picks another line of the paused
file) as code that ends in `result = name(params)`, and the paused frame's values as **Inputs**,
one `name = literal` line each. A value is copied only when the runtime renders it as a Python
literal that rebuilds it exactly (`None`, bools, numbers, whole strings and bytes, and lists,
tuples, sets, frozensets and dicts of those; capped containers are first expanded from the
runtime's store). Everything else (an object, a function, a module, a string cut at the capture
limit, a list of more items than were captured, `nan`) is listed under `unavailable` with the
reason and bound to a stand-in that raises `UnavailableValue` when the experiment uses it; the
result's `missing` names the ones it used. Give such a value an expression in Inputs, or mock what
the code calls on it.

**Mocks** is one Python dict `{target: value}` applied with `unittest.mock`: a bare name replaces
that name for the experiment, a dotted target is patched (`"urllib.request.urlopen":
OSError("offline")`, `"cart.total": 9`). A value becomes the mock's return value, an exception
its side effect, a function its implementation, and a `MagicMock(...)` is used as it is (`MagicMock`
and `mock` need no import there); the result lists each mock's call count.

Each run is a new `python -I` the bridge starts with the interpreter the program runs under
(`python/pyokka_runtime/scratchpad.py`): no state, environment variables or credentials of the
paused program, PATH and LANG only, the source file's directory on `sys.path`, 5 s at most, its
whole process group stopped after. The source file's top-level imports, functions, classes and
assignments the experiment names are copied in at their own line numbers; its `__main__` block is
not. On macOS the process runs under `sandbox-exec` with `(deny network*)`, so a socket, DNS or
HTTP call fails with `PermissionError`; on any other system there is no network sandbox and the
result's `sandbox` says `"network": "open"` (the pane says so in its header). The paused program
never moves: every state answers `liveExecutionChanged: false`.

Each scratchpad has a name and saved versions under `~/.pyokka/scratchpads/ID/N.json`: on open
or create, after each run, on `save` and on a rename. A save names the version it builds on and is
refused when another page saved first; no version file is ever replaced. `load` reopens a version
with its results without running it, and `list` and `history` work with no page open. `ctl
scratchpad run` and `experiment` exit 1 unless the run completed. `create` starts one with no
pause beside the main file.

`say` shows an explanation in a bubble under a line of the scratchpad's code (`--line`, else the
cursor line), as `ctl say` does in the code pane; with no text it clears the bubble, and opening,
creating, loading, restoring or closing a scratchpad clears it too. `state` answers it as
`explainer`.

Left out: a lesson mode (a check that a teaching stage matches the pause) and mock labels.

An agent that works in the browser itself gets the same commands as WebMCP tools when the browser
offers `document.modelContext` (a draft spec; the older `navigator.modelContext` also works): `pyokka_state`, `pyokka_goto`, `pyokka_step`,
`pyokka_line`, `pyokka_say`, `pyokka_run`, `pyokka_eval`, `pyokka_var`, `pyokka_why`,
`pyokka_watch`, `pyokka_breakpoint`, `pyokka_story`, `pyokka_profile`, `pyokka_debug`, `pyokka_scratchpad` (the
`ctl scratchpad` ops, with `say` for a bubble under a line of the scratchpad's code). The header shows a WebMCP chip when
they registered, and says how many the browser refused (a duplicate name rejects later, so the chip
is updated then). On `document.modelContext` a tool resolves with its answer, which the browser
hands the agent as JSON; a refused command resolves with `{"isError": true, "error": "..."}`,
since Chrome hides a thrown error's message from the agent. Each tool has a title and the draft's
hints: `readOnlyHint` on state, eval, var and why, `untrustedContentHint` on every tool whose
answer carries the program's values or output, and `consequentialHint` on run and profile, which
run the whole file again. Chrome 155 offered `document.modelContext` with
`--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport` (2026-10-15). A browser-automation
agent can also call `window.pyokka` (the page host) directly.

## How it fits together

```
runtime (python -m pyokka_runtime serve)
   │ NDJSON on stdio, docs/PROTOCOL.md
web/server.ts  ── the bridge: spawns it (RunnerClient), runs the file, watches it,
   │              relays events and requests, serves the page, the agent API;
   │              a second runtime for the live debugger, a third per Profile;
   │              recent files and Open; Narrate and the tour
   │              (web/serverViews.ts) over the run it keeps (web/runState.ts)
   │ WebSocket /ws, web/bridgeProtocol.ts
web/pageHost.ts ── the page's stand-in for the extension host: keeps the run and the
   │               Time Machine position, sends the panel HostToWebview messages;
   │               web/panes.ts answers the other views with the extension's builders,
   │               web/debugHost.ts is the live debugger, web/story.ts the Code Story,
   │               web/profileSummary.ts the profile table
webview/App.tsx (unchanged) + web/codePane.ts (Monaco) + web/debugPane.tsx
```

The page reuses only vscode-free modules of the extension: FileTable, TraceModel, and the
walkthrough, exceptions, variable history, provenance, execution graph, HTTP table and tour panel
builders, and the Code Story's document rules (`src/session/storyLines.ts`). `node:path`, which the walkthrough builders import, is swapped for `web/pathShim.ts` in
the page bundle.

## Security

The bridge listens on 127.0.0.1 only. It refuses a WebSocket or an API call whose `Host` is not
`127.0.0.1`/`localhost` on its port (DNS rebinding) or whose `Origin`, when sent, is another site,
and `POST /api/command` and `/api/scratchpad/...` must be `application/json`, which a cross-site page cannot send without a
preflight the bridge never approves. The page can read only files a run instrumented and the HTTP
recording the run wrote.
Anyone with a shell on the machine can drive it, as with the runtime itself.
