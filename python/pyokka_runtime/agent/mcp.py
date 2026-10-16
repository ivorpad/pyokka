"""``pyokka mcp``: the CLI's commands as an MCP server on stdin/stdout, for Claude Code, Codex and other MCP clients.

Stdlib JSON-RPC 2.0, one message per line (the MCP stdio transport), no SDK. Eight tools, one per
question an agent asks, each with an ``action`` where it covers several verbs:

- ``pyokka_run``: record a file to a ``run.json`` (``pyokka run FILE --save``).
- ``pyokka_map``: what happened (``state``, ``walkthrough``, ``story``, ``steps``, ``find``,
  ``graph``, ``exceptions``, ``http``, ``tour``, ``diff``).
- ``pyokka_step``: the Time Machine (``context`` at a step, ``step`` into/over/out/back/to).
- ``pyokka_value``: values (``var``, ``why``, ``origin``, ``values``, ``eval``, ``expand``, ``release``).
- ``pyokka_coverage``: which lines ran (``coverage``).
- ``pyokka_debug``: the live debugger in VS Code (``debug``, ``continue``, ``pause``, ``stop``,
  ``restart``, ``break``, ``watches``, ``locals``, ``exec``, ``record``; ``status`` waits for a
  pause the person causes, ``mcp_status.py``).
- ``pyokka_history``: the data behind a code-history page (``history``).
- ``pyokka_narrate``: one sentence of gloss per walkthrough moment, from a model (``narrate``).

A call becomes the words of the one-shot command, goes through the same parser (``shell.py``'s,
whose errors raise instead of exiting) and through ``commands.dispatch``, so a tool answers exactly
what the command prints: the same text, the same ``note:`` lines, the same ``error:`` and hint
(as ``isError``), or the ``--json`` shape with ``json: true``. The action descriptions are the
commands' help text, so the two cannot drift.

stdout is the wire: at start the server keeps a duplicate of fd 1 for its replies and points fd 1
at stderr, so a ``print``, a progress line or a child process that inherits stdout lands in the
client's log instead of corrupting the stream.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback
from typing import Any, Callable

from .. import __version__
from .source import AgentError

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

INSTRUCTIONS = """\
Pyokka records a Python program and answers questions from the recording, so you read what the
program did instead of guessing from the source. Every value comes from the run.

1. pyokka_run {file} records it and prints the run.json path (default .pyokka/runs/<name>.json next to the file).
2. pyokka_map {action: "walkthrough", run} is the map: calls with arguments and results, branches, loops, prints, exceptions, each with a step number.
3. pyokka_step {run, step, move: "into"} is the Time Machine: code, values, stack and moves at a step; move back and forward freely.
4. pyokka_value {action: "why", run, step, name} explains where a value came from; "var" lists every change of a name; "origin" follows a bad value from an exception back to its root.
5. pyokka_coverage {run} lists the lines that never ran.
For a program running now in VS Code (setting pyokka.agentAccess), pass live: true instead of run; pyokka_debug {action: "start", file, at: ["func"]} starts the debugger and returns the first stop, then "continue", "locals", pyokka_step with a move.
pyokka_history {run, out, var: ["total"]} writes code-history data; pyokka_narrate is the narrate command.
pyokka_debug {action: "status", wait_seconds: 60} waits for the person to hit a breakpoint or step in VS Code, then prints the state.
To teach in a browser: pyokka_page {action: "open", file} returns a URL for the person to open in one tab; then breakpoint, debug {op: "start"}, say for narration bubbles, wait_pause for their next step; close stops a page this server started.
At a page's pause, pyokka_scratchpad {op: "open"} copies the paused function and its values into a separate python -I (network denied on macOS) and runs it; experiment runs your own code; save, list, history, load keep named versions; say puts a bubble under a line of it for the person watching.
pyokka_review {action: "start", base: REF, repo} reviews a change as a guided debug session: it records base and head, plans the stops, and every answer ends with next:, the action to take; prompts/get review is the method.
The text results are the form to read; json: true gives the raw shape."""


from .mcp_tools import DEBUG_ACTIONS, DEBUG_COMMAND, MAP_ACTIONS, MOVES, VALUE_ACTIONS, tool_definitions


# -- arguments to command words -----------------------------------------------------------------

class ToolError(Exception):
    """A call the tool cannot turn into a command: reported as an ``isError`` result, like a command's error."""

    def __init__(self, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


def _source_words(a: dict, *, positional: bool = True) -> tuple[list[str], list[str]]:
    """``(options, positionals)`` naming the run: ``RUN`` or ``--live [--session S]``."""
    opts: list[str] = []
    pos: list[str] = []
    if a.get("json"):
        opts.append("--json")
    if a.get("run") and (a.get("live") or a.get("session")):
        raise ToolError("give `run` or `live: true`, not both", "run reads the saved %s; live reads the open VS Code session" % a["run"])
    if a.get("live") or a.get("session"):
        opts.append("--live")
        if a.get("session"):
            opts.append("--session=%s" % a["session"])
    elif a.get("run") and positional:
        pos.append(str(a["run"]))
    elif positional:
        raise ToolError("give `run` (a run.json from pyokka_run) or `live: true`", "record one with pyokka_run {file}; live reads the open VS Code session (setting pyokka.agentAccess)")
    return opts, pos


def _opt(words: list[str], a: dict, key: str, flag: str) -> None:
    v = a.get(key)
    if v is None or v == "":
        return
    if isinstance(v, bool):
        if v:
            words.append(flag)
        return
    words.append("%s=%s" % (flag, v))


def _need(a: dict, key: str, action: str, example: str) -> Any:
    v = a.get(key)
    if v is None or v == "":
        raise ToolError("%s needs `%s`" % (action, key), "e.g. %s" % example)
    return v


def words_map(a: dict) -> list[str]:
    action = _need(a, "action", "pyokka_map", '{"action": "walkthrough", "run": "run.json"}')
    if action not in MAP_ACTIONS:
        raise ToolError("unknown action %r" % action, "one of " + ", ".join(MAP_ACTIONS))
    if action == "diff":
        before = _need(a, "before", "diff", '{"action": "diff", "before": "before.json", "after": "after.json"}')
        live = a.get("live") or a.get("session")
        if a.get("after") == "live":
            raise ToolError("`after` is a run.json path", 'for the open session pass live: true instead: {"action": "diff", "before": %s, "live": true}' % json.dumps(str(before)))
        if a.get("after") and live:
            raise ToolError("give `after` or `live: true`, not both", "after reads the saved %s; live reads the open VS Code session" % a["after"])
        words = ["diff"]
        if a.get("json"):
            words.append("--json")
        if a.get("live") or a.get("session"):
            words.append("--live")
            _opt(words, a, "session", "--session")
        _opt(words, a, "limit", "--limit")
        words += ["--", str(before)]
        if not (a.get("live") or a.get("session")):
            words.append(str(_need(a, "after", "diff", '{"action": "diff", "before": "before.json", "after": "after.json"} or live: true')))
        return words
    opts, pos = _source_words(a)
    words = [action, *opts]
    if action in ("walkthrough", "story"):
        _opt(words, a, "file", "--file")
        _opt(words, a, "scope", "--scope")
    if action == "walkthrough":
        _opt(words, a, "from", "--from")
        _opt(words, a, "to", "--to")
        _opt(words, a, "all", "--all")
    if action == "story":
        _opt(words, a, "line", "--line")
        _opt(words, a, "limit", "--limit")
    if action == "steps":
        _opt(words, a, "from", "--from")
        _opt(words, a, "count", "--count")
        _opt(words, a, "line", "--line")
    if action == "graph":
        _opt(words, a, "scope", "--scope")
        _opt(words, a, "all", "--all")
        for pkg in a.get("expand") or []:
            words.append("--expand=%s" % pkg)
        _opt(words, a, "no_statements", "--no-statements")
        _opt(words, a, "dot", "--dot")
    if action == "tour":
        _opt(words, a, "goal", "--goal")
        _opt(words, a, "budget", "--budget")
    if action == "find":
        _opt(words, a, "limit", "--limit")
        return words + ["--", *pos, str(_need(a, "text", "find", '{"action": "find", "run": "run.json", "text": "KeyError"}'))]
    return words + ["--", *pos] if pos else words


def words_step(a: dict) -> list[str]:
    opts, pos = _source_words(a)
    live = "--live" in opts
    step = a.get("step")
    move = a.get("move")
    if move is not None and move not in MOVES:
        raise ToolError("unknown move %r" % move, "one of " + ", ".join(MOVES))
    if move or a.get("to") is not None:
        words = ["step", *opts]
        words.append("--%s" % move if move else "--to=%d" % int(a["to"]))
        _opt(words, a, "count", "--count")
        _opt(words, a, "whole_block", "--scope")
        if step is None and not live:
            raise ToolError("a move needs `step`, the step to move from", 'e.g. {"run": "run.json", "step": 12, "move": "into"}; with live the current step is implied')
    else:
        words = ["context", *opts]
        _opt(words, a, "line", "--line")
        _opt(words, a, "whole_block", "--scope")
        if step is None and not a.get("line") and not live:
            raise ToolError("give `step` or `line`", 'e.g. {"run": "run.json", "step": 12} or {"run": "run.json", "line": "demo.py:57"}')
    return words + ["--", *pos, *([str(int(step))] if step is not None else [])]


def words_value(a: dict) -> list[str]:
    action = _need(a, "action", "pyokka_value", '{"action": "var", "run": "run.json", "name": "total"}')
    if action not in VALUE_ACTIONS:
        raise ToolError("unknown action %r" % action, "one of " + ", ".join(VALUE_ACTIONS))
    opts, pos = _source_words(a)
    words = [action, *opts]
    if action == "var":
        _opt(words, a, "file", "--file")
        _opt(words, a, "scope", "--scope")
        _opt(words, a, "limit", "--limit")
        return words + ["--", *pos, str(_need(a, "name", "var", '{"action": "var", "run": "run.json", "name": "total"}'))]
    if action in ("why", "origin"):
        _opt(words, a, "depth", "--depth")
        step = a.get("step")
        if step is None and "--live" not in opts:
            raise ToolError("%s needs `step`" % action, "pyokka_value var lists the steps where a name changed; pyokka_map exceptions lists the steps that raised")
        return words + ["--", *pos, *([str(int(step))] if step is not None else []), *([str(a["name"])] if a.get("name") else [])]
    if action == "values":
        _opt(words, a, "line", "--line")
        _need(a, "line", "values", '{"action": "values", "run": "run.json", "line": "demo.py:57"}')
        return words + ["--", *pos]
    if action == "eval":
        _opt(words, a, "frame", "--frame")
        return words + ["--", *pos, str(_need(a, "expression", "eval", '{"action": "eval", "run": "run.json", "expression": "len(scores)"}'))]
    if action == "expand":
        for seg in a.get("path") or []:
            words.append("--path=%s" % seg)
        return words + ["--", *pos, str(_need(a, "value_id", "expand", '{"action": "expand", "run": "run.json", "value_id": "v12"}'))]
    return words + ["--", *pos]  # release


def words_coverage(a: dict) -> list[str]:
    opts, pos = _source_words(a)
    words = ["coverage", *opts]
    _opt(words, a, "file", "--file")
    return words + ["--", *pos]


def words_debug(a: dict) -> list[str]:
    action = _need(a, "action", "pyokka_debug", '{"action": "start", "file": "app.py", "at": ["main"]}')
    if action not in DEBUG_ACTIONS:
        raise ToolError("unknown action %r" % action, "one of " + ", ".join(DEBUG_ACTIONS))
    if action == "status":
        action = "state"  # what status prints; its wait is call_status's (mcp_status.py)
    words = [DEBUG_COMMAND.get(action, action), "--live"]
    _opt(words, a, "json", "--json")
    _opt(words, a, "session", "--session")
    if action == "start":
        for flag in ("module", "cwd", "python", "record_from", "configuration", "test"):
            _opt(words, a, flag, "--" + flag.replace("_", "-"))
        for flag in ("record", "library_code", "stop_on_entry", "no_focus"):
            _opt(words, a, flag, "--" + flag.replace("_", "-"))
        for k, v in (a.get("env") or {}).items():
            words.append("--env=%s=%s" % (k, v))
        for at in a.get("at") or []:
            words.append("--at=%s" % at)
        if a.get("file"):
            # FILE goes before `--args`, not after `--`: there argparse would read `--args` as a positional
            file = str(a["file"])
            words.append("./" + file if file.startswith("-") else file)
        if a.get("args"):
            # `--args` takes the rest of the line, so it goes last
            words += ["--args", *[str(x) for x in a["args"]]]
        return words
    if action == "restart":
        _opt(words, a, "stop_on_entry", "--stop-on-entry")
    if action == "continue":
        _opt(words, a, "until", "--until")
        _opt(words, a, "to", "--to")
        _opt(words, a, "no_wait", "--no-wait")
    if action == "pause":
        _opt(words, a, "no_wait", "--no-wait")
    if action == "break":
        _opt(words, a, "when", "--when")
        _opt(words, a, "on_exception", "--on-exception")
        for at in a.get("at") or []:
            words.append("--at=%s" % at)
        for r in a.get("remove") or []:
            words.append("--remove=%s" % r)
        return words + ["--", *[str(x) for x in a.get("add") or []]]
    if action == "watches":
        _opt(words, a, "break_when", "--break-when")
        for e in a.get("add") or []:
            words.append("--add=%s" % e)
        for r in a.get("remove") or []:
            words.append("--remove=%s" % r)
    if action == "locals":
        _opt(words, a, "frame", "--frame")
        scope = a.get("scope")
        if scope is not None and scope not in ("local", "global", "all"):
            raise ToolError("unknown scope %r" % scope, "one of local, global, all")
        _opt(words, a, "scope", "--scope")
        _opt(words, a, "names_only", "--names-only")
        names = a.get("names")
        if names is not None and (not isinstance(names, list) or not names or any(not isinstance(n, str) or not n.strip() for n in names)):
            raise ToolError("names must be a list of variable names", 'e.g. {"action": "locals", "names": ["total", "items"]}')
        for n in names or []:
            words.append("--name=%s" % n)
    if action == "exec":
        _opt(words, a, "frame", "--frame")
        return words + ["--", str(_need(a, "source", "exec", '{"action": "exec", "source": "rank = 3"}'))]
    return words


def words_history(a: dict) -> list[str]:
    opts, pos = _source_words(a)
    words = ["history", *opts, "--out=%s" % _need(a, "out", "pyokka_history", '{"run": "run.json", "out": "/tmp/s/history.json", "var": ["total"]}')]
    for at in a.get("at") or []:
        words.append("--at=%s" % at)
    for v in a.get("var") or []:
        words.append("--var=%s" % v)
    why = a.get("why") or []
    if not isinstance(why, list) or any(not isinstance(w, dict) or not isinstance(w.get("step"), int) or not w.get("name") for w in why):
        raise ToolError("why must be a list of {step, name} objects", 'e.g. [{"step": 40, "name": "total"}]')
    for w in why:
        words += ["--why", str(w["step"]), str(w["name"])]
    if a.get("pause"):
        if not (a.get("live") or a.get("session")):
            raise ToolError("`pause` reads a live debug pause; it needs `live: true`", 'e.g. {"live": true, "pause": true, "out": "history.json"}; pause first with pyokka_debug {"action": "break", ...} then {"action": "continue"}')
        words.append("--pause")
    for flag in ("prose", "pad", "limit", "lang", "value_chars"):
        _opt(words, a, flag, "--" + flag.replace("_", "-"))
    for flag in ("scope", "append"):
        _opt(words, a, flag, "--" + flag)
    if not (a.get("at") or a.get("var") or why or a.get("pause")):
        raise ToolError("a history needs at least one checkpoint: `at`, `var`, `why` or `pause`", 'e.g. {"run": "run.json", "out": "history.json", "var": ["total"]}')
    return words + ["--", *pos]


def words_narrate(a: dict) -> list[str]:
    if a.get("live") or a.get("session"):
        raise ToolError("pyokka_narrate writes into a saved run; live is not accepted", 'save one with pyokka_run {"file": "FILE", "save": "run.json"}, then pyokka_narrate {"run": "run.json"}')
    opts, pos = _source_words(a)
    words = ["narrate", *opts]
    _opt(words, a, "command", "--command")
    _opt(words, a, "dry_run", "--dry-run")
    return words + ["--", *pos]


def words_investigate(a: dict) -> list[str]:
    opts, pos = _source_words(a)
    words = ["investigate", *opts]
    _opt(words, a, "value", "--value")  # without it the verb starts at the run's first exception
    _opt(words, a, "at", "--at")
    return words + ["--", *pos]


def words_learn(a: dict) -> list[str]:
    opts, pos = _source_words(a)
    words = ["learn", *opts]
    _opt(words, a, "at", "--at")
    _opt(words, a, "prediction", "--prediction")
    _opt(words, a, "reveal", "--reveal")
    return words + ["--", *pos]


def words_pin(a: dict) -> list[str]:
    opts, pos = _source_words(a)
    words = ["pin", *opts, "--out=%s" % _need(a, "out", "pyokka_pin", '{"run": "run.json", "out": "baseline.json"}')]
    return words + ["--", *pos]


def words_verify(a: dict) -> list[str]:
    opts, pos = _source_words(a)
    words = ["verify", *opts]
    if a.get("after") and a.get("rerun"):
        raise ToolError("give `after` or `rerun: true`, not both", '{"run": "before.json", "rerun": true, "expect": ["total=22"]}')
    if not a.get("after") and not a.get("rerun"):
        raise ToolError("verify needs `after` (a run saved after the fix) or `rerun: true`", '{"run": "before.json", "after": "after.json", "expect": ["total=22"]}')
    _opt(words, a, "after", "--after")
    _opt(words, a, "rerun", "--rerun")
    _opt(words, a, "out", "--out")
    _opt(words, a, "test_out", "--test-out")
    for name in a.get("ignore") or []:
        words.append("--ignore=%s" % name)
    for exp in a.get("expect") or []:
        words.append("--expect=%s" % exp)
    return words + ["--", *pos]


# -- running a call -----------------------------------------------------------------------------

def run_words(words: list[str]) -> tuple[str, bool]:
    """Run one command the way the CLI would; ``(text, is_error)``."""
    from .commands import dispatch
    from .shell import build_parser

    parser = build_parser()
    try:
        args = parser.parse_args(words)
    except SystemExit:
        raise ToolError("cannot read the arguments: %s" % " ".join(words))
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stderr(err):
        code = dispatch(args, out=out)
    text = out.getvalue()
    extra = err.getvalue()
    if code != 0:
        return (text + extra).strip() or "error: the command failed (exit %d)" % code, True
    return (text + ("\n" + extra if extra else "")).rstrip() + "\n", False


def default_save(file: str) -> str:
    path = os.path.abspath(file)
    stem = os.path.splitext(os.path.basename(path))[0] or "run"
    return os.path.join(os.path.dirname(path), ".pyokka", "runs", stem + ".json")


def call_run(a: dict) -> tuple[str, bool]:
    from .interpreter import choose, probe
    from .save import save_run

    file = str(_need(a, "file", "pyokka_run", '{"file": "demo.py"}'))
    if not os.path.isfile(file):
        raise ToolError("no file %s" % os.path.abspath(file), "give the path of a Python file, relative to %s or absolute" % os.getcwd())
    save = str(a.get("save") or default_save(file))
    max_steps = a.get("max_steps")
    if max_steps is not None and int(max_steps) < 1:
        raise ToolError("max_steps must be 1 or more, got %s" % max_steps)
    mode = str(a.get("mode") or "normal")
    if mode not in ("normal", "snaps", "profile"):
        raise ToolError("unknown mode %r" % mode, "one of normal, snaps, profile")
    http = str(a.get("http") or "off")
    if http not in ("off", "record", "replay"):
        raise ToolError("unknown http %r" % http, "one of off, record, replay")
    cwd = str(a["cwd"]) if a.get("cwd") else None
    if cwd and not os.path.isdir(cwd):
        raise ToolError("no directory %s" % os.path.abspath(cwd), "give an existing directory, relative to %s or absolute" % os.getcwd())
    try:
        interp = probe(choose(file, a.get("python") or None))
    except AgentError as exc:
        raise ToolError(exc.message.replace("--python", "`python`"), "pass `python`, the interpreter's path, e.g. %s" % json.dumps({"file": os.path.abspath(file), "python": ".venv/bin/python"})) from None
    lines = [interp.line()]
    recording = {
        "maxTraceSteps": int(max_steps) if max_steps is not None else None,
        "exclude": [str(x) for x in a.get("exclude") or []],
        "only": [str(x) for x in a.get("only") or []],
        "maxValueChars": a.get("max_value_chars"),
    }
    try:
        os.makedirs(os.path.dirname(os.path.abspath(save)) or ".", exist_ok=True)
    except OSError as exc:
        raise ToolError("cannot write %s: %s" % (os.path.abspath(save), exc.strerror or exc), "give `save` a writable path, e.g. %s" % json.dumps({"file": os.path.abspath(file), "save": default_save(file)})) from None
    try:
        meta = save_run(
            file, save,
            library_code=bool(a.get("library_code")), keep=bool(a.get("keep")), record_locals=not a.get("no_locals"), auto_log=bool(a.get("auto_log")),
            timeout_ms=int(a.get("timeout_ms") or 0), argv=[str(x) for x in a.get("args") or []], http=http,
            progress=lines.append, recording=recording, python=interp, cwd=cwd, mode=mode, test=str(a["test"]) if a.get("test") else None,
        )
    except (RuntimeError, OSError) as exc:
        raise ToolError(str(exc)) from None
    lines.append("run: %s" % os.path.abspath(save))
    if meta.get("profile"):
        profile = meta["profile"].get("path") if isinstance(meta["profile"], dict) else meta["profile"]
        lines.append("profile: %s" % os.path.abspath(str(profile)))
        lines.append("next: open the .cpuprofile in VS Code; a profile run has no steps to map")
    else:
        lines.append("next: pyokka_map {\"action\": \"walkthrough\", \"run\": %s}" % json.dumps(os.path.abspath(save)))
    if meta.get("keep"):
        lines.append("the runner is kept for eval/expand; pyokka_value {\"action\": \"release\", \"run\": %s} shuts it down" % json.dumps(os.path.abspath(save)))
    from ..redact import redact

    return "\n".join(redact(l) for l in lines) + "\n", False


def call_json(fn: Callable[[dict], dict], a: dict) -> tuple[str, bool]:
    """A tool whose answer is a JSON object (``pyokka_session``, ``pyokka_seek``), redacted like every other answer."""
    from ..redact import redact

    return redact(json.dumps(fn(a), ensure_ascii=False, indent=1)) + "\n", False


def _json_tools() -> dict[str, Callable[[dict], dict]]:
    from .mcp_session import seek_recorded, session_state
    from .saved_investigation import open_investigation, save_investigation

    return {"pyokka_session": session_state, "pyokka_seek": seek_recorded, "pyokka_save_investigation": save_investigation, "pyokka_open_investigation": open_investigation}


JSON_TOOLS = ("pyokka_session", "pyokka_seek", "pyokka_save_investigation", "pyokka_open_investigation")

TOOLS: dict[str, Callable[[dict], list[str]]] = {
    "pyokka_map": words_map,
    "pyokka_step": words_step,
    "pyokka_value": words_value,
    "pyokka_coverage": words_coverage,
    "pyokka_debug": words_debug,
    "pyokka_history": words_history,
    "pyokka_narrate": words_narrate,
    "pyokka_investigate": words_investigate,
    "pyokka_learn": words_learn,
    "pyokka_pin": words_pin,
    "pyokka_verify": words_verify,
}


def call_tool(name: str, arguments: dict) -> dict:
    """A ``tools/call`` result: the command's text, ``isError`` when it failed."""
    try:
        if name == "pyokka_run":
            text, is_error = call_run(arguments)
        elif name == "pyokka_debug" and arguments.get("action") == "status":
            from .mcp_status import call_status

            text, is_error = call_status(arguments, run_words, ToolError)
        elif name in JSON_TOOLS:
            text, is_error = call_json(_json_tools()[name], arguments)
        elif name == "pyokka_page":
            from .mcp_page import call_page

            text, is_error = call_page(arguments)
        elif name == "pyokka_scratchpad":
            from .mcp_page import call_scratchpad

            text, is_error = call_scratchpad(arguments)
        elif name == "pyokka_review":
            from .review.tool import call_review

            text, is_error = call_review(arguments)
        elif name in TOOLS:
            text, is_error = run_words(TOOLS[name](arguments))
        else:
            raise ToolError("unknown tool %s" % name, "tools: pyokka_run, pyokka_page, pyokka_scratchpad, pyokka_review, " + ", ".join([*TOOLS, *JSON_TOOLS]))
    except (ToolError, AgentError) as exc:
        text, is_error = "error: %s%s" % (exc.message, "\n" + exc.hint if exc.hint else ""), True
    except (TypeError, ValueError) as exc:  # an argument of the wrong type: int("abc")
        text, is_error = "error: bad argument: %s" % exc, True
    except Exception as exc:  # never take the server down with one call
        traceback.print_exc(file=sys.stderr)
        text, is_error = "error: %s: %s (a bug in pyokka; the traceback is in the server's log)" % (type(exc).__name__, exc), True
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


# -- JSON-RPC over stdio ------------------------------------------------------------------------

def _error(id_: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def handle(msg: Any) -> dict | None:
    """The reply to one message, or None for a notification."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        if isinstance(msg, dict) and ("result" in msg or "error" in msg):
            return None  # a response to a request the server never sends
        return _error(msg.get("id") if isinstance(msg, dict) else None, -32600, "invalid request")
    method = msg["method"]
    if "id" not in msg:
        return None  # notifications/initialized, notifications/cancelled, …: nothing to answer
    id_ = msg["id"]
    params = msg.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion") if isinstance(params, dict) else None
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return {"jsonrpc": "2.0", "id": id_, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}},
            "serverInfo": {"name": "pyokka", "title": "Pyokka", "version": __version__},
            "instructions": INSTRUCTIONS,
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": id_, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": id_, "result": {"tools": tool_definitions()}}
    if method == "tools/call":
        if not isinstance(params, dict) or not isinstance(params.get("name"), str):
            return _error(id_, -32602, "tools/call needs params.name")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return _error(id_, -32602, "tools/call params.arguments must be an object")
        if params["name"] not in ("pyokka_run", "pyokka_page", "pyokka_scratchpad", "pyokka_review") and params["name"] not in TOOLS and params["name"] not in JSON_TOOLS:
            return _error(id_, -32602, "unknown tool %s" % params["name"])
        return {"jsonrpc": "2.0", "id": id_, "result": call_tool(params["name"], arguments)}
    if method == "resources/list":
        return {"jsonrpc": "2.0", "id": id_, "result": {"resources": []}}
    if method in ("prompts/list", "prompts/get"):
        from .review.tool import prompts_get, prompts_list

        if method == "prompts/list":
            return {"jsonrpc": "2.0", "id": id_, "result": {"prompts": prompts_list()}}
        prompt = prompts_get(params)
        return {"jsonrpc": "2.0", "id": id_, "result": prompt} if prompt is not None else _error(id_, -32602, "unknown prompt %s" % (params.get("name") if isinstance(params, dict) else None))
    return _error(id_, -32601, "method not found: %s" % method)


def serve(stdin: Any = None, wire: Any = None) -> int:
    """Read one JSON-RPC message per line until EOF and answer each on ``wire``."""
    if wire is None:
        # keep fd 1 for the replies and send everything else written to it (prints, children) to stderr
        sys.stdout.flush()
        wire = os.fdopen(os.dup(1), "w", encoding="utf-8")
        os.dup2(2, 1)
    stdin = stdin or sys.stdin
    for raw in stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError as exc:
            reply: Any = _error(None, -32700, "parse error: %s" % exc)
        else:
            if isinstance(msg, list):  # a batch (protocol 2025-03-26)
                replies = [r for r in (handle(m) for m in msg) if r is not None]
                reply = replies or None
            else:
                reply = handle(msg)
        if reply is not None:
            wire.write(json.dumps(reply, ensure_ascii=False) + "\n")
            wire.flush()
    return 0


__all__ = ["serve", "handle", "call_tool", "tool_definitions", "default_save"]
