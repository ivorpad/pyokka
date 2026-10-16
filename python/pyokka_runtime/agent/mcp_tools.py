"""The MCP tools' definitions for ``pyokka mcp`` (``mcp.py``): names, descriptions and input schemas.

The actions' descriptions are the commands' own help text, read from the parser the CLI uses.
"""

from __future__ import annotations

def _source_props() -> dict:
    return {
        "run": {"type": "string", "description": "path of a saved run.json (from pyokka_run); omit with live"},
        "live": {"type": "boolean", "description": "read the open VS Code session instead of a saved run (setting pyokka.agentAccess)"},
        "session": {"type": "string", "description": "with live: the session's file name, when more than one window session is open"},
        "json": {"type": "boolean", "description": "the raw JSON shape instead of the text form"},
    }


MAP_ACTIONS = ("state", "walkthrough", "story", "steps", "find", "graph", "exceptions", "http", "tour", "diff")
VALUE_ACTIONS = ("var", "why", "origin", "values", "eval", "expand", "release")
MOVES = ("into", "over", "out", "back", "back-over", "back-out")
DEBUG_ACTIONS = ("start", "continue", "pause", "stop", "restart", "break", "watches", "locals", "exec", "record", "status")
#: the command each action runs, where the names differ
DEBUG_COMMAND = {"start": "debug"}


def _helps() -> dict[str, str]:
    """Each command's one-line help, from the parser the CLI uses."""
    from .shell import build_parser

    parser = build_parser()
    sub = parser._subparsers._group_actions[0]  # type: ignore[union-attr]
    return {a.dest: (a.help or "") for a in sub._choices_actions}  # type: ignore[attr-defined]


def _action_list(actions: tuple[str, ...], helps: dict[str, str], rename: dict[str, str] | None = None) -> str:
    rename = rename or {}
    return "\n".join("- %s: %s" % (a, helps.get(rename.get(a, a), "")) for a in actions)


def tool_definitions() -> list[dict]:
    from .review.tool import tool_definition as review_tool

    helps = _helps()
    src = _source_props()
    line_prop = {"type": "string", "description": "FILE:LINE, e.g. demo.py:57 (path suffix or basename)"}
    read_only = {"readOnlyHint": True, "openWorldHint": False}
    return [
        {
            "name": "pyokka_run",
            "title": "Record a Python run",
            "description": "Run a Python file under Pyokka's tracer and save the recording (run.json) that every other tool reads. Prints the interpreter it picked, the step count and the exit code; a program that raises is still recorded. Returns the run path to pass as `run`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "the Python file to run"},
                    "save": {"type": "string", "description": "where to write the run.json (default: .pyokka/runs/<file name>.json next to the file)"},
                    "args": {"type": "array", "items": {"type": "string"}, "description": "arguments for the program (sys.argv[1:])"},
                    "python": {"type": "string", "description": "interpreter or venv directory (default: $PYOKKA_PYTHON, $VIRTUAL_ENV, a .venv beside the file or up to the git root, else pyokka's own)"},
                    "library_code": {"type": "boolean", "description": "instrument third-party packages too (never the stdlib); slower, bigger run"},
                    "keep": {"type": "boolean", "description": "keep the runner alive so pyokka_value eval/expand can read the finished values; release it with pyokka_value release"},
                    "no_locals": {"type": "boolean", "description": "do not record locals at every step (var, why and origin need them)"},
                    "http": {"type": "string", "enum": ["off", "record", "replay"], "description": "record every HTTP exchange next to the file, or replay from that recording without the network"},
                    "timeout_ms": {"type": "integer", "description": "stop the program after this many milliseconds (0: no limit)"},
                    "max_steps": {"type": "integer", "description": "record at most this many steps (default 999,999); a cut run says so"},
                    "exclude": {"type": "array", "items": {"type": "string"}, "description": "leave this code out of the recording: a dotted module or a path glob relative to the file"},
                    "only": {"type": "array", "items": {"type": "string"}, "description": "record only these modules or paths; the program file is always recorded"},
                    "max_value_chars": {"type": "integer", "description": "characters one recorded value keeps (default 120 for a local); 0 keeps it whole"},
                    "mode": {"type": "string", "enum": ["normal", "snaps", "profile"], "description": "normal records steps; snaps records value snapshots only; profile runs under cProfile and writes a .cpuprofile instead of steps"},
                    "auto_log": {"type": "boolean", "description": "log the value of every assignment and call, as the editor does with auto-log on"},
                    "cwd": {"type": "string", "description": "the program's working directory (default: the file's directory); a directory that holds the file is also the project root"},
                    "test": {"type": "string", "description": "run only this test of the file under its runner: a pytest node id (test_b, TestCart::test_total), a unittest name (Cart.test_total), else a pytest -k expression"},
                },
                "required": ["file"],
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        },
        {
            "name": "pyokka_map",
            "title": "Map a run",
            "description": "What a recorded or live run did, with step numbers to step to. Start with walkthrough.\n" + _action_list(MAP_ACTIONS, helps),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": list(MAP_ACTIONS)},
                    **src,
                    "file": {"type": "string", "description": "walkthrough, story: only this file (path suffix or basename)"},
                    "scope": {"type": "string", "description": "walkthrough, story, graph: only inside calls of this function"},
                    "line": {**line_prop, "description": "story: blocks that ran this line; steps: every step on this line (FILE:LINE)"},
                    "from": {"type": "integer", "description": "walkthrough: first step of the window; steps: first step"},
                    "to": {"type": "integer", "description": "walkthrough: last step of the window"},
                    "count": {"type": "integer", "description": "steps: how many (default 40)"},
                    "all": {"type": "boolean", "description": "walkthrough, graph: one entry per library call instead of one per call site"},
                    "text": {"type": "string", "description": "find: the text to search values, locals, errors, output and source for"},
                    "limit": {"type": "integer", "description": "find: most matches; story: most lines; diff: most statements"},
                    "goal": {"type": "string", "description": "tour: explain this variable's last value (NAME) or this line's last pass (FILE:LINE)"},
                    "budget": {"type": "integer", "description": "tour: token budget (default 40,000)"},
                    "expand": {"type": "array", "items": {"type": "string"}, "description": "graph: unroll these packages into their functions"},
                    "no_statements": {"type": "boolean", "description": "graph: no statement nodes, only modules, functions, packages and decisions"},
                    "dot": {"type": "boolean", "description": "graph: print a Graphviz digraph instead of the text form"},
                    "before": {"type": "string", "description": "diff: the run.json from before the edit"},
                    "after": {"type": "string", "description": "diff: the run.json from after the edit (or live: true for the open session)"},
                },
                "required": ["action"],
            },
            "annotations": read_only,
        },
        {
            "name": "pyokka_step",
            "title": "Time Machine",
            "description": "The Time Machine: the code, values, call stack and available moves at one step of a run, or after a move from it. Without move or to, the context at `step` (or at the first step of `line`). Moves: into a call (lands in the callee with its arguments), over, out, back, back-over, back-out; `to` jumps. Live at a debug pause, into/over/out run the program to the next stop and `count` takes several steps.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    **src,
                    "step": {"type": "integer", "description": "the step to read or move from (with live: omit for the current step)"},
                    "move": {"type": "string", "enum": list(MOVES)},
                    "to": {"type": "integer", "description": "jump to this step"},
                    "line": {**line_prop, "description": "without step: the context at the first step on this FILE:LINE"},
                    "count": {"type": "integer", "description": "live at a pause: take this many steps in a row (1..1000)"},
                    "whole_block": {"type": "boolean", "description": "the whole block and every value (lifts the 60-line / 20-value caps)"},
                },
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "pyokka_value",
            "title": "Read values",
            "description": "Values of a run and where they came from.\n" + _action_list(VALUE_ACTIONS, helps),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": list(VALUE_ACTIONS)},
                    **src,
                    "name": {"type": "string", "description": "var, why: a name or attribute path (total, self.balance); origin: the expression to follow (items[0][\"price\"]), omit to take the value the exception is about"},
                    "step": {"type": "integer", "description": "why: the step whose statement made the value; origin: the failing statement's step (an exception's step)"},
                    "line": {**line_prop, "description": "values: every value logged on this FILE:LINE, by hit"},
                    "expression": {"type": "string", "description": "eval: a pure expression (names, attributes, subscripts, non-mutating calls)"},
                    "frame": {"type": "integer", "description": "eval, live at a pause: which frame, innermost 0"},
                    "value_id": {"type": "string", "description": "expand: valueBag.data.id from eval with json: true"},
                    "path": {"type": "array", "items": {"type": "string"}, "description": "expand: query path segments"},
                    "depth": {"type": "integer", "description": "why: levels to expand (default 5); origin: most links (default 20)"},
                    "file": {"type": "string", "description": "var: only changes in this file"},
                    "scope": {"type": "string", "description": "var: only changes inside this function"},
                    "limit": {"type": "integer", "description": "var: most changes (default 200)"},
                },
                "required": ["action"],
            },
            "annotations": read_only,
        },
        {
            "name": "pyokka_coverage",
            "title": "Coverage",
            "description": helps.get("coverage", "") + ". Lines are statement lines; a line marked partial ran only in part (a branch arm or a short-circuit that never ran), raised is where an exception came from.",
            "inputSchema": {
                "type": "object",
                "properties": {**src, "file": {"type": "string", "description": "also list this file line by line with hit counts"}},
            },
            "annotations": read_only,
        },
        {
            "name": "pyokka_debug",
            "title": "Live debugger",
            "description": "Drive Pyokka's debugger in VS Code (the extension must be installed; the window opens on start). Every action that runs the program returns the next stop the way pyokka_step prints one.\n" + _action_list(tuple(a for a in DEBUG_ACTIONS if a != "status"), helps, DEBUG_COMMAND) + "\n- status: the live session's state without moving it; with wait_seconds, first wait up to that long for the running program to pause (a breakpoint, or the person stepping in VS Code) or finish",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": list(DEBUG_ACTIONS)},
                    "session": src["session"],
                    "json": src["json"],
                    "file": {"type": "string", "description": "start: the Python file to debug (omit to debug the open session's file)"},
                    "module": {"type": "string", "description": "start: a dotted module to run like python -m"},
                    "args": {"type": "array", "items": {"type": "string"}, "description": "start: arguments for the program"},
                    "cwd": {"type": "string", "description": "start: working directory (default: the file's directory)"},
                    "env": {"type": "object", "additionalProperties": {"type": "string"}, "description": "start: environment variables for the program"},
                    "python": {"type": "string", "description": "start: interpreter (default: the window's)"},
                    "at": {"type": "array", "items": {"type": "string"}, "description": "start, break: stop at these FILE:LINEs or function names (rrf, Ranker.rank)"},
                    "record": {"type": "boolean", "description": "start: also record the run, so pyokka_step back moves and why work at every pause"},
                    "record_from": {"type": "string", "description": "start: run at full speed to this NAME or FILE:LINE, then record from there"},
                    "library_code": {"type": "boolean", "description": "start: step into and pause inside third-party packages too"},
                    "stop_on_entry": {"type": "boolean", "description": "start, restart: pause before the first statement"},
                    "no_focus": {"type": "boolean", "description": "start: do not bring the VS Code window to the front at the first stop"},
                    "until": {"type": "string", "description": "continue: run until this expression is true"},
                    "to": {"type": "string", "description": "continue: run to this FILE:LINE"},
                    "no_wait": {"type": "boolean", "description": "continue, pause: answer at once instead of waiting for the stop"},
                    "add": {"type": "array", "items": {"type": "string"}, "description": "break: FILE:LINE breakpoints to add; watches: expressions to add"},
                    "when": {"type": "string", "description": "break: only pause when this expression is true at the added line"},
                    "remove": {"type": "array", "items": {"type": "string"}, "description": "break: FILE:LINE or function names to remove; watches: watch ids to remove"},
                    "on_exception": {"type": "string", "enum": ["off", "uncaught", "raised"], "description": "break: when an exception pauses the run"},
                    "break_when": {"type": "string", "enum": ["change", "true"], "description": "watches: make the added watches pause the run on change, or when true"},
                    "frame": {"type": "integer", "description": "locals, exec: which frame of the pause, innermost 0"},
                    "source": {"type": "string", "description": "exec: the statement to run in the paused frame (it changes the program's state)"},
                    "configuration": {"type": "string", "description": "start: take program or module, args, cwd, env, envFile, python, stopOnEntry and justMyCode from this debugpy/python configuration of the nearest .vscode/launch.json above file or cwd; arguments given here win"},
                    "test": {"type": "string", "description": "start: run only this test of file under its runner (pytest node id, unittest Class.test, or a pytest -k expression)"},
                    "scope": {"type": "string", "enum": ["local", "global", "all"], "description": "locals: local is the function's own names, global the module-level values the program bound, all the frame's variables plus those globals (default: the frame's variables)"},
                    "names_only": {"type": "boolean", "description": "locals: one name: type per line, without reading the values"},
                    "names": {"type": "array", "items": {"type": "string"}, "description": "locals: only these variables"},
                    "wait_seconds": {"type": "integer", "minimum": 0, "maximum": 600, "description": "status: wait up to this many seconds for a running program to pause or finish; returns at once when it is paused already"},
                },
                "required": ["action"],
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        },
        {
            "name": "pyokka_history",
            "title": "Code-history data",
            "description": helps.get("history", "") + ". Writes the JSON to `out`; every value in it comes from the run. Checkpoints: `at` steps or FILE:LINEs, one per change of each `var`, the provenance chain of each `why`, or the live pause.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    **src,
                    "out": {"type": "string", "description": "where the data JSON goes (required)"},
                    "at": {"type": "array", "items": {"type": "string"}, "description": "checkpoints at these steps or at the first step on these FILE:LINEs"},
                    "var": {"type": "array", "items": {"type": "string"}, "description": "a checkpoint per recorded change of each name, in step order"},
                    "why": {"type": "array", "items": {"type": "object", "properties": {"step": {"type": "integer"}, "name": {"type": "string"}}, "required": ["step", "name"]}, "description": "checkpoints for the provenance chain of name after step"},
                    "pause": {"type": "boolean", "description": "with live: a checkpoint from the debug session's current pause, read without moving it"},
                    "prose": {"type": "string", "description": "a JSON file whose prose fields are merged in (it may not set a generated field)"},
                    "pad": {"type": "integer", "description": "source lines of context above and below each block (default 2)"},
                    "limit": {"type": "integer", "description": "most checkpoints one var may produce (default 20)"},
                    "lang": {"type": "string", "description": "the page's language, en or es (default en)"},
                    "scope": {"type": "boolean", "description": "lift the 60-line block cap on every checkpoint"},
                    "append": {"type": "boolean", "description": "add these checkpoints to the page at out instead of replacing it"},
                    "value_chars": {"type": "integer", "description": "characters of one value on a card (0 shows every value whole)"},
                },
                "required": ["out"],
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "pyokka_narrate",
            "title": "Narrate a walkthrough",
            "description": helps.get("narrate", "") + ". It runs a model command (claude -p, else codex exec) and writes the gloss into the run; dry_run prints the prompt instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    **src,
                    "command": {"type": "string", "description": "the model command: prompt on stdin, answer on stdout (default: claude -p, else codex exec)"},
                    "dry_run": {"type": "boolean", "description": "print the prompt instead of running the command"},
                },
            },
        },
        {
            "name": "pyokka_investigate",
            "title": "Investigate a value",
            "description": helps.get("investigate", "") + ". The notes first say where the recording has gaps.",
            "inputSchema": {"type": "object", "properties": {"run": src["run"], "json": src["json"], "value": {"type": "string", "description": "the name or attribute path to follow (scores, self.total); omit it to start at the run's first exception"}, "at": {"type": "integer", "description": "the step to explain (default: the first nan/inf/None value, else the last change)"}}, "required": ["run"]},
            "annotations": read_only,
        },
        {
            "name": "pyokka_learn",
            "title": "Practice on a run",
            "description": helps.get("learn", "") + ". Without reveal the values stay hidden.",
            "inputSchema": {"type": "object", "properties": {"run": src["run"], "json": src["json"], "at": {"type": "integer", "description": "the checkpoint's step"}, "prediction": {"type": "string", "description": "what you expect the value to be"}, "reveal": {"type": "boolean", "description": "show the recorded value and whether the prediction matches"}}, "required": ["run"]},
            "annotations": read_only,
        },
        {
            "name": "pyokka_pin",
            "title": "Pin a baseline",
            "description": helps.get("pin", ""),
            "inputSchema": {"type": "object", "properties": {"run": src["run"], "json": src["json"], "out": {"type": "string", "description": "the new baseline file; an existing file is refused"}}, "required": ["run", "out"]},
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "pyokka_verify",
            "title": "Verify a fix",
            "description": helps.get("verify", "") + ". A failed expectation is an error result with the same text.",
            "inputSchema": {"type": "object", "properties": {
                "run": src["run"], "json": src["json"],
                "after": {"type": "string", "description": "the run saved after the fix"},
                "rerun": {"type": "boolean", "description": "run the baseline's file again instead (recorded HTTP is replayed)"},
                "out": {"type": "string", "description": "with rerun: save the new run here"},
                "ignore": {"type": "array", "items": {"type": "string"}, "description": "names left out of the comparison"},
                "expect": {"type": "array", "items": {"type": "string"}, "description": "NAME=VALUE final recorded values, as repr text: total=22"},
                "test_out": {"type": "string", "description": "write a pytest file that reruns the file and checks the expectations"},
            }, "required": ["run"]},
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        },
        review_tool(),
        {
            "name": "pyokka_session",
            "title": "Where a run is",
            "description": "Read where a run stands, as JSON, without moving anything. With `run`: a saved run's read position (`step`, default 0), its context and the gaps in the recording. With `live: true` or `session`: the open VS Code session, with the program's actual pause (`livePause`) kept apart from the Time Machine's position in the recording (`recordedSelection`), which can sit behind it, and the actions that apply now. With neither: the published sessions.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run": src["run"],
                    "step": {"type": "integer", "description": "with run: the step to read (default 0)"},
                    "live": src["live"],
                    "session": src["session"],
                },
            },
            "annotations": read_only,
        },
        {
            "name": "pyokka_seek",
            "title": "Find where it happened",
            "description": "Find a step in a saved run, as JSON: the first or last step where `value` (a name) took the value `equals` (its recorded text, e.g. \"6\" or \"'done'\"), or the first or last run of `file`:`line`. Answers the step, its context and the pyokka_step call that opens it; for a value, `selection.changeStep` is the statement that made it and `observedStep` the first step that can read it. Says when the recording is incomplete, since no match then proves nothing.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run": src["run"],
                    "value": {"type": "string", "description": "a variable name, with equals"},
                    "equals": {"type": "string", "description": "the value's recorded text, as `var` prints it"},
                    "file": {"type": "string", "description": "with line: a file of the run (path suffix or basename)"},
                    "line": {"type": "integer", "description": "with file: the line"},
                    "occurrence": {"type": "string", "enum": ["first", "last"], "description": "which match (default first)"},
                },
                "required": ["run"],
            },
            "annotations": read_only,
        },
        {
            "name": "pyokka_save_investigation",
            "title": "Save investigation checkpoints",
            "description": "Save a question and named steps of a saved run to a new JSON file at `path` (never overwritten). It keeps the run's path, relative to the file, and the sha256 of the run, so keep both files. Answers each checkpoint's context. Runs no code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "the new investigation file"},
                    "run": src["run"],
                    "question": {"type": "string", "description": "what the investigation is about"},
                    "checkpoints": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "step": {"type": "integer"}}, "required": ["name", "step"]}, "description": "1 to 20 named steps"},
                },
                "required": ["path", "run", "question", "checkpoints"],
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "pyokka_open_investigation",
            "title": "Reopen an investigation",
            "description": "Reopen an investigation file: its question and each checkpoint's context, after checking that the run's sha256 is still the one saved (a changed run is refused, since its steps may be other moments). Runs no code.",
            "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "the investigation file"}}, "required": ["path"]},
            "annotations": read_only,
        },
        {
            "name": "pyokka_page",
            "title": "The browser page",
            "description": "Drive Pyokka's browser page (docs/WEB.md; its bridge runs on node, else on the Node inside VS Code). open starts the page's bridge on `file` and returns its URL: the person opens it in exactly one browser tab. Every other action is one `pyokka web ctl` command sent to that tab, answered with the bridge's JSON: state, goto, step (next/into/over/out/back/backOver/backOut), line, say, clear, start, stop, run, eval, var, why, peek, watch, breakpoint, debug (op start/continue/step/pause/stop/state), story, profile, values (the live pause's values beside the source), definition (where the name at line/column is defined), and wait_pause for the person's next step (up to 25 s). close stops a page this server started, list names them. expect (source, runId, step, frame, file from state.context) refuses a command once the page has moved on.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["open", "close", "list", "state", "goto", "step", "line", "say", "clear", "start", "stop", "run", "eval", "var", "why", "watch", "breakpoint", "debug", "story", "profile", "peek", "wait_pause", "values", "definition"]},
                    "port": {"type": "integer", "description": "the page's port (default $PYOKKA_PORT, else 4777)"},
                    "file": {"type": "string", "description": "open: the absolute path of the Python file; line: a file of the run"},
                    "python": {"type": "string", "description": "open: the interpreter the page runs the file with"},
                    "no_watch": {"type": "boolean", "description": "open: do not rerun the file when it changes on disk"},
                    "cwd": {"type": "string", "description": "open: the run's working directory, and its project root when it holds `file`, so the debugger stops and steps in the project's own modules (without it the file's folder is the root, and code outside it is library code)"},
                    "step": {"type": "integer", "description": "goto: the recorded step; say, why: the step it is about"},
                    "kind": {"type": "string", "description": "step: next, into, over, out, back, backOver, backOut; debug step: into, over, out"},
                    "line": {"type": "integer", "description": "line: run to this line; say: put the bubble here; breakpoint: the line"},
                    "say": {"type": "string", "description": "goto, step, line, debug: a narration bubble at the new position"},
                    "text": {"type": "string", "description": "say: the bubble's text"},
                    "expression": {"type": "string", "description": "eval: a pure expression (the paused frame while the page's debugger is paused); watch: the watch expression"},
                    "name": {"type": "string", "description": "var, why: a variable; peek: a binding of the paused frame, NAME.KEY to walk into it"},
                    "remove": {"type": "boolean", "description": "watch: drop the watch with this expression"},
                    "on": {"type": "boolean", "description": "breakpoint: set (true) or clear (false); omitted toggles"},
                    "condition": {"type": "string", "description": "breakpoint: pause only when this is true"},
                    "op": {"type": "string", "enum": ["start", "continue", "step", "pause", "stop", "state"], "description": "debug: what to do with the page's live debugger"},
                    "column": {"type": "integer", "description": "definition: the column of the name on `line` (with line, what Cmd/Ctrl-click opens)"},
                    "after": {"type": "integer", "description": "wait_pause: the cursor from the previous wait_pause; omitted, it reads the cursor"},
                    "timeout_ms": {"type": "integer", "description": "wait_pause: at most 25000"},
                    "expect": {"type": "object", "description": "refuse the command unless the page is still here: source (live|recording), runId, step, frame, file, as state.context has them"},
                },
                "required": ["action"],
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        },
        {
            "name": "pyokka_scratchpad",
            "title": "The page's Scratchpad",
            "description": "Experiment beside the browser page's live debugger (open the page with pyokka_page, pause with breakpoint and debug start). op open copies the function around the paused line (or `line`) and the pause's values into the Scratchpad and runs it once: Inputs hold each value as a Python literal the runtime checked rebuilds exactly; a value a fresh process cannot rebuild (an object, a function, a cut string, a capped list) is listed in `unavailable` with the reason, and using it raises UnavailableValue. experiment does the same with your `code` (formatted, then run once). The experiment runs in a separate `python -I` with the source file's imports, functions, classes and assignments it names copied in (not its __main__ block), a 5 s limit and, on macOS, sandbox-exec denying all network (the result's sandbox says whether the network was denied). It shares no state or credentials with the paused program and never moves it. create starts one without a pause; update changes code, inputs, mocks, title or auto_run; run, restore (the copy as made), close, state. save adds a version, list names saved scratchpads, history lists one's versions (with `version`, that version's entry), load reopens a version without running it. say shows `text` in a bubble under `line` of the scratchpad's code for the person watching (empty text clears it). inputs: Python assignments, or {name: expression}; mocks: one Python dict, or {target: expression}, applied with unittest.mock (a value is the return value, an exception the side effect, a function the implementation). A run's result has values (name, line, repr), result, output, error, missing and mocks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["open", "experiment", "create", "state", "update", "run", "restore", "close", "save", "list", "load", "history", "say"]},
                    "port": {"type": "integer", "description": "the page's port (default $PYOKKA_PORT, else 4777)"},
                    "id": {"type": "string", "description": "load, history: a saved scratchpad (list names them)"},
                    "title": {"type": "string", "description": "open, experiment, create, update, save: the scratchpad's name"},
                    "version": {"type": "integer", "description": "load, history: a saved version; omitted, the latest"},
                    "line": {"type": "integer", "description": "open, experiment: copy the function around this line of the paused file (default: the paused line); say: the line of the scratchpad's code the bubble goes under (default: its cursor line)"},
                    "code": {"type": "string", "description": "experiment, create, update: the experiment's Python code; a `result` variable is shown"},
                    "inputs": {"type": ["object", "string"], "description": "experiment, create, update: Python assignments, or {name: Python expression}; replaces the copied Inputs"},
                    "mocks": {"type": ["object", "string"], "description": "experiment, create, update: one Python dict, or {target: Python expression}, e.g. {\"shop.fetch_price\": \"9.5\", \"urllib.request.urlopen\": \"OSError('offline')\"}"},
                    "auto_run": {"type": "boolean", "description": "run after each edit (open and create default to on, experiment to off)"},
                    "text": {"type": "string", "description": "say: the explanation shown in a bubble under `line` of the scratchpad's code; empty clears it"},
                    "expect": {"type": "object", "description": "refuse the command unless the page is still here: source, runId, step, frame, file, as state.context has them"},
                },
                "required": ["op"],
            },
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
        },
    ]



__all__ = ["tool_definitions", "MAP_ACTIONS", "VALUE_ACTIONS", "MOVES", "DEBUG_ACTIONS", "DEBUG_COMMAND"]
