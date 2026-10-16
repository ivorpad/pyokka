"""The MCP tools' definitions for ``pyokka mcp`` (``mcp.py``): names, descriptions and input schemas.

The actions' descriptions are the commands' own help text, read from the parser the CLI uses.
"""

from __future__ import annotations

import re

def _source_props() -> dict:
    return {
        "run": {"type": "string", "description": "path of a saved run.json (from pyokka_run); omit with live"},
        "live": {"type": "boolean", "description": "read the open VS Code session instead of a saved run (setting pyokka.agentAccess): the session on `session`, else the one whose workspace holds the cwd, else the newest; errors with \"no live session\" when no window publishes one"},
        "session": {"type": "string", "description": "with live: the session's file name, when more than one window session is open"},
        "json": {"type": "boolean", "description": "the raw JSON shape instead of the text form"},
    }


MAP_ACTIONS = ("state", "walkthrough", "story", "steps", "find", "graph", "exceptions", "http", "tour", "diff")
VALUE_ACTIONS = ("var", "why", "origin", "values", "eval", "expand", "release")
MOVES = ("into", "over", "out", "back", "back-over", "back-out")
DEBUG_ACTIONS = ("start", "continue", "pause", "stop", "restart", "break", "watches", "locals", "exec", "record", "status")
#: the command each action runs, where the names differ
DEBUG_COMMAND = {"start": "debug"}


#: CLI wording in the commands' help that reads differently as tool arguments
_MCP_PHRASES = (
    ("(needs --keep)", "(needs a run recorded with pyokka_run keep: true)"),
    ("`run --keep`", "pyokka_run keep: true"),
    (" A file or --module implies --live.", ""),
    ("list them; FILE:LINE adds one", "list them; `add` FILE:LINEs adds them"),
    ("; exit 1 when an expectation fails", ""),
)


def _mcp_words(text: str) -> str:
    """A command's help in the tools' terms: arguments by name (`record_from`), no --live prefix (the tool says it)."""
    if text.startswith("--live: "):
        text = text[len("--live: "):]
    for cli, mcp in _MCP_PHRASES:
        text = text.replace(cli, mcp)
    return re.sub(r"(?<![\w-])--([a-z][\w-]*)", lambda m: "`%s`" % m.group(1).replace("-", "_"), text)


def _helps() -> dict[str, str]:
    """Each command's one-line help, from the parser the CLI uses, in the tools' terms."""
    from .shell import build_parser

    parser = build_parser()
    sub = parser._subparsers._group_actions[0]  # type: ignore[union-attr]
    return {a.dest: _mcp_words(a.help or "") for a in sub._choices_actions}  # type: ignore[attr-defined]


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
            "description": "Run a Python file under Pyokka's tracer and save the recording (run.json) that every other tool reads. Prints the interpreter it picked, the step count and the exit code; a program that raises is still recorded. Returns the run path to pass as `run`. The recording is a file on disk at `save` (default .pyokka/runs/<file name>.json next to the file); nothing opens in VS Code or a browser. Read it with pyokka_map {\"action\": \"walkthrough\", \"run\": PATH}; mode profile writes a .cpuprofile instead and prints its path.",
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
            "description": "The Time Machine: the code, values, call stack and available moves at one step of a run, or after a move from it. Without move or to, the context at `step` (or at the first step of `line`). Moves: into a call (lands in the callee with its arguments), over, out, back, back-over, back-out; `to` jumps. `count` takes several steps at a live pause. With `live: true` (VS Code with pyokka.agentAccess, a session started by pyokka_debug {\"action\": \"start\", \"file\": FILE, \"at\": [NAME]}), into/over/out execute the real program in the VS Code window and print the next stop; live back, back-over, back-out and `to` need a recording (record: true). Without live every move reads the saved run and runs nothing.",
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
            "description": "Line coverage of a recorded run, returned as text in this reply (json: true for the JSON shape): per file the lines that ran, the ones that never ran and the partial ones; `file` also lists that file line by line with hit counts. Reads `run` (a run.json from pyokka_run) or, with live: true, the open VS Code session. Lines are statement lines; a line marked partial ran only in part (a branch arm or a short-circuit that never ran), raised is where an exception came from.",
            "inputSchema": {
                "type": "object",
                "properties": {**src, "file": {"type": "string", "description": "also list this file line by line with hit counts"}},
            },
            "annotations": read_only,
        },
        {
            "name": "pyokka_debug",
            "title": "Live debugger",
            "description": "Drive Pyokka's debugger in a VS Code window (the ivor.pyokka extension must be installed and the setting pyokka.agentAccess on; start opens the file in that window and brings it to the front at the first stop, where the person sees the pause; every reply here is also returned as text). Every action that runs the program returns the next stop the way pyokka_step prints one.\n" + _action_list(tuple(a for a in DEBUG_ACTIONS if a != "status"), helps, DEBUG_COMMAND) + "\n- status: the live session's state without moving it; with wait_seconds, first wait up to that long for the running program to pause (a breakpoint, or the person stepping in VS Code) or finish",
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
            "description": helps.get("history", "") + ". Every value in it comes from the run. Writes a JSON file to `out` (required, no default) and returns text naming it. Nothing renders or opens it: the page is `node <repo>/skills/pyokka/scripts/render-code-history.cjs OUT OUT.html`, which the result prints. Checkpoints: `at` steps or FILE:LINEs, one per change of each `var`, the provenance chain of each `why`, or `pause` (needs `live: true` and a paused debug session). `append` adds to an existing history file and refuses any other file.",
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
            "description": helps.get("narrate", "") + ". It runs a local model CLI as a subprocess with that CLI's own login (no API key): `command` when given, else `claude -p`, else `codex exec` (each found on PATH or in ~/.local/bin, ~/.claude/local, /opt/homebrew/bin, /usr/local/bin), with prompt on stdin and answer on stdout, a 180 s limit, and redacted source and values sent to that model. It writes the gloss into run.json and returns 'N of M moments glossed by BACKEND, written to PATH'. dry_run returns the prompt as text and writes nothing. It reads a saved run only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run": {**src["run"], "description": "path of a saved run.json (from pyokka_run); the gloss is written into it"},
                    "json": src["json"],
                    "command": {"type": "string", "description": "the model command: prompt on stdin, answer on stdout (default: claude -p, else codex exec)"},
                    "dry_run": {"type": "boolean", "description": "print the prompt instead of running the command"},
                },
            },
        },
        {
            "name": "pyokka_investigate",
            "title": "Investigate a value",
            "description": "Follow one value through a saved run (or the open VS Code session with live: true) and return the answer as text in this reply (json: true for the raw shape); nothing opens in an editor or browser. Sections: notes on where the recording has gaps, the value's changes (var), why and origin at the selected step, the run's exceptions, and the lines that did not run.",
            "inputSchema": {"type": "object", "properties": {**src, "value": {"type": "string", "description": "the name or attribute path to follow (scores, self.total); omit it to start at the run's first exception"}, "at": {"type": "integer", "description": "the step to explain (default: the first nan/inf/None value, else the last change)"}}},
            "annotations": read_only,
        },
        {
            "name": "pyokka_learn",
            "title": "Practice on a run",
            "description": helps.get("learn", "") + ". Returns text in this reply only. Without `at` it lists the checkpoint steps. Call 1: {run, at, prediction} keeps the values hidden. Call 2: {run, at, prediction, reveal: true} shows the recorded values and whether they match. Send `prediction` again on call 2: nothing is stored between calls. `reveal` without `prediction` shows the values with no match.",
            "inputSchema": {"type": "object", "properties": {**src, "at": {"type": "integer", "description": "the checkpoint's step"}, "prediction": {"type": "string", "description": "what you expect the value to be"}, "reveal": {"type": "boolean", "description": "show the recorded value and whether the prediction matches"}}},
            "annotations": read_only,
        },
        {
            "name": "pyokka_pin",
            "title": "Pin a baseline",
            "description": helps.get("pin", "") + ". Writes the copy to the file at `out` and returns text naming it; nothing runs or opens. Reads `run`, or with live: true the open VS Code session's recording.",
            "inputSchema": {"type": "object", "properties": {**src, "out": {"type": "string", "description": "path of the new baseline file, relative to the server's working directory or absolute; its directory must exist; an existing file is refused"}}, "required": ["out"]},
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
        },
        {
            "name": "pyokka_verify",
            "title": "Verify a fix",
            "description": helps.get("verify", "") + ". Returns the comparison and PASS/FAIL lines as text. rerun: true runs the baseline's file again with its saved interpreter, arguments and cwd (HTTP replayed only if the baseline recorded it with http record, otherwise real calls). out and test_out write new files and refuse existing ones. A failed expectation is an error result with the same text.",
            "inputSchema": {"type": "object", "properties": {
                **src,
                "run": {**src["run"], "description": "path of the baseline run.json (from pyokka_run or pyokka_pin); omit with live"},
                "after": {"type": "string", "description": "the run saved after the fix"},
                "rerun": {"type": "boolean", "description": "run the baseline's file again with its saved interpreter, arguments and cwd; HTTP is replayed only if the baseline was recorded with http record"},
                "out": {"type": "string", "description": "with rerun: save the new run here"},
                "ignore": {"type": "array", "items": {"type": "string"}, "description": "names left out of the comparison"},
                "expect": {"type": "array", "items": {"type": "string"}, "description": "NAME=VALUE final recorded values, as repr text: total=22"},
                "test_out": {"type": "string", "description": "write a pytest file that reruns the file and checks the expectations"},
            }},
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        },
        review_tool(),
        {
            "name": "pyokka_session",
            "title": "Where a run is",
            "description": "Read where a run stands, as JSON, without moving anything. With `run`: a saved run's read position (`step`, default 0), its context and the gaps in the recording. With `live: true` or `session`: the open VS Code session, with the program's actual pause (`livePause`) kept apart from the Time Machine's position in the recording (`recordedSelection`), which can sit behind it, and the actions that apply now. With neither: the published sessions. Call it with no arguments before pyokka_debug or a review in VS Code: it says whether VS Code is ready (the `code` binary, the installed extension, `pyokka.agentAccess`) and lists the sessions VS Code publishes, where `kind: \"run\"` is a Time Machine recording you can step back in and `kind: \"debug\"` a forward-only debug pause. With none open it says why and the call that opens one.",
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
                    "run": {"type": "string", "description": "path of a saved run.json (from pyokka_run); reads saved runs only, no live session"},
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
            "description": "Save a question and named steps of a saved run to a new JSON file at `path` (never overwritten). It keeps the run's path, relative to the file, and the sha256 of the run, so keep both files. Answers each checkpoint's context as JSON text in this reply. Runs no code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "the new investigation file; give an absolute path (a relative one resolves against the MCP server's working directory)"},
                    "run": {"type": "string", "description": "path of a saved run.json (from pyokka_run); a live session cannot be saved, record one with pyokka_run first"},
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
            "description": "Reopen an investigation file: its question and each checkpoint's context, after checking that the run's sha256 is still the one saved (a changed run is refused, since its steps may be other moments), as JSON text in this reply. Runs no code. The file stores its run's path relative to itself: keep the two files together, and after the run is re-recorded, save a new investigation over the new run.",
            "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "the investigation file pyokka_save_investigation wrote (absolute; a relative path resolves against the server's working directory)"}}, "required": ["path"]},
            "annotations": read_only,
        },
        {
            "name": "pyokka_page",
            "title": "The browser page",
            "description": "Drive Pyokka's browser page (docs/WEB.md; its bridge runs on node, else on the Node inside VS Code). open starts the page's bridge on `file` and returns its URL: the person opens it in exactly one browser tab. This tool opens no browser: hand the person the URL; until their tab is open, every other action fails with \"no page is open\". Say bubbles and the page's moves show only in that tab; the JSON comes back here. Every other action is one `pyokka web ctl` command sent to that tab, answered with the bridge's JSON: state, goto, step (next/into/over/out/back/backOver/backOut), line, say, clear, start, stop, run, eval, var, why, peek, watch, breakpoint, debug (op start/continue/step/pause/stop/state), story, profile, values (the live pause's values beside the source), definition (where the name at line/column is defined), and wait_pause for the person's next step (up to 25 s). close stops a page this server started, list names them. expect (source, runId, step, frame, file from state.context) refuses a command once the page has moved on.",
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
            "description": "Experiment beside the browser page's live debugger (open the page with pyokka_page, pause with breakpoint and debug start). op open copies the function around the paused line (or `line`) and the pause's values into the Scratchpad and runs it once: Inputs hold each value as a Python literal the runtime checked rebuilds exactly; a value a fresh process cannot rebuild (an object, a function, a cut string, a capped list) is listed in `unavailable` with the reason, and using it raises UnavailableValue. experiment does the same with your `code` (formatted, then run once). The experiment runs in a separate `python -I` with the source file's imports, functions, classes and assignments it names copied in (not its __main__ block), a 5 s limit and, on macOS, sandbox-exec denying all network (the result's sandbox says whether the network was denied). It shares no state or credentials with the paused program and never moves it. create starts one without a pause; update changes code, inputs, mocks, title or auto_run; run, restore (the copy as made), close, state. save adds a version, list names saved scratchpads, history lists one's versions (with `version`, that version's entry), load reopens a version without running it. say shows `text` in a bubble under `line` of the scratchpad's code for the person watching (empty text clears it). inputs: Python assignments, or {name: expression}; mocks: one Python dict, or {target: expression}, applied with unittest.mock (a value is the return value, an exception the side effect, a function the implementation). A run's result has values (name, line, repr), result, output, error, missing and mocks. Every op needs a page from pyokka_page open on `port` with its browser tab open (list and history need only the page server). Only open needs a pause. Results come back here as JSON. The Scratchpad pane and say's bubble show only in that browser tab (nothing is shown in chat); this tool opens no browser.",
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
