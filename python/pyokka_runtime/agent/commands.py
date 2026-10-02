"""The ``pyokka`` subcommands over a run: argparse wiring, dispatch, ``--json``.

The text form of every result is rendered by ``render.py`` (bounded listings an agent reads:
``file:line``, step numbers, values inline, moves listed; never a range id, never base64).
``--json`` prints the contract shapes raw. Errors go to stderr as ``error: <what>`` plus a line
that says what to do next; exit status 2.

Every command takes ``RUN`` (a saved run) or ``--live`` (the bridge of an open VS Code
session, ``live.py``); the replies have the same shape and go through the same renderer.
The debugging commands (``debug``, ``continue``, ``pause``, ``stop``, ``restart``, ``break``,
``watches``, ``locals``) are live only: they drive the session's program at its frontier and
print every stop the way ``step`` prints one; a saved run refuses them.

``shell`` (``shell.py``) is the same commands over one connection: it reads a command line per
stdin line and prints each result as the one-shot command would, which saves the ~70 ms every
new process spends starting Python.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from ..protocol import PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH
from .origin.walk import ORIGIN_DEPTH, ORIGIN_MAX_DEPTH
from ..redact import redact
from .live import watch_line
from .tour.cli import add_tour_parser, run_tour
from .recording import annotate_cut, note_line
from .render import _one_line, exec_error, render
from .sessions import NO_SESSION
from .source import AgentError, RunSource, SavedRun

_MISSING = object()
MOVE_FLAGS = [("--into", "into"), ("--over", "over"), ("--out", "out"), ("--back", "back"), ("--back-over", "backOver"), ("--back-out", "backOut")]
DEBUG_COMMANDS = ("debug", "continue", "pause", "stop", "restart", "break", "watches", "locals", "exec", "record")
LIVE_HINT = "debugging needs a live session (`--live`)"


def add_commands(sub: argparse._SubParsersAction) -> None:
    from .codehistory import Checkpoint

    def run_arg(p: argparse.ArgumentParser) -> None:
        p.add_argument("run", metavar="RUN", nargs="?", help="a run.json written by `pyokka run FILE --save run.json` (omit with --live)")
        p.add_argument("--json", action="store_true", help="print the raw JSON shape")
        p.add_argument("--live", action="store_true", help="the open VS Code session instead of a saved run (setting pyokka.agentAccess)")
        p.add_argument("--session", metavar="NAME|PATH", help="with --live: the session's file name or descriptor path, when more than one is open")

    p = sub.add_parser("story", help="the Code Story: the lines that ran, in order, one block per scope")
    run_arg(p)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--file", metavar="F", help="only blocks in this file (path suffix or basename)")
    g.add_argument("--scope", metavar="NAME", help="only blocks of this function")
    g.add_argument("--line", metavar="F:L", help="only blocks that ran this line")
    p.add_argument("--limit", type=int, default=150, metavar="LINES", help="text: stop after this many lines (default 150)")

    p = sub.add_parser("steps", help="list steps: number, file:line, function")
    run_arg(p)
    p.add_argument("--from", dest="start", type=int, default=0, metavar="N")
    p.add_argument("--count", type=int, default=40, metavar="K")
    p.add_argument("--line", metavar="F:L", help="every step on this line")

    p = sub.add_parser("step", help="move from step N and show the context at the new step (live at a debug pause: --into/--over/--out run the program to the next stop)")
    run_arg(p)
    p.add_argument("step", type=int, nargs="?", metavar="N", help="the step to move from (omit with --live: the current step; the first --into starts the Time Machine)")
    g = p.add_mutually_exclusive_group(required=True)
    for flag, _kind in MOVE_FLAGS:
        g.add_argument(flag, action="store_true")
    g.add_argument("--to", type=int, metavar="M", help="jump to step M")
    p.add_argument("--count", type=int, default=None, metavar="N", help="live at a pause: take N steps in a row and print the last stop (1..1000); a breakpoint or an exception on the way wins and is reported")
    p.add_argument("--scope", action="store_true", help="the whole block and every value (lifts the 60-line / 20-value caps)")

    p = sub.add_parser("context", help="the context slice at step N (or at the first step of --line F:L)")
    run_arg(p)
    p.add_argument("step", type=int, nargs="?", metavar="N")
    p.add_argument("--line", metavar="F:L")
    p.add_argument("--scope", action="store_true", help="lift the 60-line / 20-value caps")

    p = sub.add_parser("values", help="every value logged on a line, by hit")
    run_arg(p)
    p.add_argument("--line", required=True, metavar="F:L")

    p = sub.add_parser("find", help="search values, errors, output and the lines that ran")
    run_arg(p)
    p.add_argument("text")
    p.add_argument("--limit", type=int, default=50)

    p = sub.add_parser("var", help="every recorded change of a variable: step, file:line, function, the new value, what the statement read")
    run_arg(p)
    p.add_argument("name", metavar="NAME", help="a name or attribute path (dt, self.balance, r.output_parsed.date); paths under it match too")
    p.add_argument("--file", metavar="F", help="only changes in this file (path suffix or basename)")
    p.add_argument("--scope", metavar="NAME", help="only changes inside this function")
    p.add_argument("--limit", type=int, default=200, metavar="K", help="at most this many changes (default 200)")

    p = sub.add_parser("why", help="why a value is what it is: the statement that made it, what it read with values, the calls it made, five levels back")
    run_arg(p)
    p.add_argument("step", nargs="?", metavar="STEP", help="the step whose statement made the value (omit with --live: the Time Machine's step)")
    p.add_argument("name", nargs="?", metavar="NAME", help="a name or attribute path (label, self.balance); omit it to explain the statement at STEP")
    p.add_argument("--depth", type=int, default=PROVENANCE_DEPTH, metavar="N", help="levels below the value to expand (default %d, at most %d)" % (PROVENANCE_DEPTH, PROVENANCE_MAX_DEPTH))

    p = sub.add_parser("origin", help="where a bad value was made: the chain of steps from the failing statement back across calls and containers, its root marked")
    run_arg(p)
    p.add_argument("step", nargs="?", metavar="STEP", help="the step of the failing statement, e.g. an exception's step (omit with --live: the Time Machine's step)")
    p.add_argument("name", nargs="?", metavar="EXPR", help="the value to follow: a name or a subscript of one (items[0][\"price\"]); omit it to take the value the exception at STEP is about")
    p.add_argument("--depth", type=int, default=ORIGIN_DEPTH, metavar="N", help="at most this many links (default %d, at most %d)" % (ORIGIN_DEPTH, ORIGIN_MAX_DEPTH))

    p = sub.add_parser("eval", help="evaluate a pure expression against the finished run: names, attributes, operators and calls that cannot change it, never a function of the program (needs --keep)")
    run_arg(p)
    p.add_argument("expression")
    p.add_argument("--frame", type=int, default=None, metavar="N", help="with --live at a pause: which frame to evaluate in, innermost 0")

    p = sub.add_parser("expand", help="expand a value node of the finished run (needs --keep)")
    run_arg(p)
    p.add_argument("value_id", metavar="VALUE_ID")
    p.add_argument("--path", action="append", default=[], metavar="SEGMENT", help="queryPath segment (repeatable)")

    p = sub.add_parser("release", help="shut down the runner kept by `run --keep`")
    run_arg(p)

    p = sub.add_parser("state", help="what the run is: file, steps, exit code, staleness")
    run_arg(p)

    p = sub.add_parser("watch", help="--live: print one line per stop while the user steps in VS Code, until Ctrl-C")
    run_arg(p)

    p = sub.add_parser("walkthrough", help="what happened, in order: one moment per line with the step number and the values that mattered")
    run_arg(p)
    p.add_argument("--file", metavar="F", help="only moments in this file (path suffix or basename)")
    p.add_argument("--scope", metavar="NAME", help="only moments inside calls of this function")
    p.add_argument("--from", dest="start", type=int, default=None, metavar="N", help="first step of the window (with --to: no cap)")
    p.add_argument("--to", dest="end", type=int, default=None, metavar="M", help="last step of the window")
    p.add_argument("--all", action="store_true", help="one moment per library call instead of one per user-code call site")

    p = sub.add_parser("graph", help="the execution graph: modules, functions, packages, decisions and statements as nodes; calls, callbacks and data flow as edges")
    run_arg(p)
    p.add_argument("--all", action="store_true", help="one node per library function instead of one per package")
    p.add_argument("--scope", metavar="NAME", help="only the moments inside calls of this function")
    p.add_argument("--expand", action="append", default=[], metavar="PKG", help="unroll this package into its functions (repeatable)")
    p.add_argument("--no-statements", dest="statements", action="store_false", help="no statement nodes: only modules, functions, packages and decisions")
    p.add_argument("--dot", action="store_true", help="print a Graphviz digraph instead of the text form")

    p = sub.add_parser("exceptions", help="every exception the run raised: where, where it was caught, how often; broad handlers flagged")
    run_arg(p)
    p = sub.add_parser("http", help="every HTTP request of the run: method, status, the statement that made it (file:line, step), size, time, live / recorded / replayed / miss")
    run_arg(p)

    p = sub.add_parser("diff", help="what an edit changed: two runs compared statement by statement (values, branches, loops, calls, prints, raises), with each side's step numbers")
    p.add_argument("runs", metavar="RUN", nargs="*", help="the before and the after run.json; with --live only the before, and the open VS Code session is the after")
    p.add_argument("--json", action="store_true", help="print the raw JSON shape")
    p.add_argument("--live", action="store_true", help="the open VS Code session is the after (setting pyokka.agentAccess)")
    p.add_argument("--session", metavar="NAME|PATH", help="with --live: the session's file name or descriptor path, when more than one is open")
    p.add_argument("--limit", type=int, default=40, metavar="K", help="at most this many statements (default 40)")
    p.set_defaults(run=None)

    add_tour_parser(sub, run_arg)

    p = sub.add_parser("narrate", help="ask a model for one sentence of gloss per walkthrough moment and store it in the saved run (never automatic)")
    run_arg(p)
    p.add_argument("--command", dest="model_command", metavar="CMD", default=None, help="the model command (prompt on stdin, answer on stdout); default: claude -p, else codex exec")
    p.add_argument("--dry-run", action="store_true", help="print the prompt instead of running the command")

    # -- debugging: live only, no RUN positional ---------------------------------------------------------
    def live_arg(p: argparse.ArgumentParser) -> None:
        p.set_defaults(run=None)
        p.add_argument("--json", action="store_true", help="print the raw JSON shape")
        p.add_argument("--live", action="store_true", help="the open VS Code session (setting pyokka.agentAccess); these commands have no saved-run form")
        p.add_argument("--session", metavar="NAME|PATH", help="the session's file name or descriptor path, when more than one is open")

    def entry_arg(p: argparse.ArgumentParser) -> None:
        p.add_argument("--stop-on-entry", dest="stop_on_entry", action="store_true", help="pause before the first statement even when a breakpoint is set, so break-when watches and breakpoints can be placed before anything runs")

    p = sub.add_parser("debug", help="start the debugger on a file (or a module) in VS Code and print the first stop: the first breakpoint, or the first statement when none is set. A file or --module implies --live. With a debug session already paused it prints that pause instead of starting anything")
    p.add_argument("--no-focus", dest="no_focus", action="store_true", help="on a cold start, do not bring the VS Code window to the front at the first stop (also PYOKKA_NO_FOCUS=1)")
    live_arg(p)
    entry_arg(p)
    p.add_argument("program", metavar="FILE", nargs="?", help="the Python file to run (implies --live); omit it to debug the open session's file")
    p.add_argument("--module", metavar="M", help="run a dotted module like `python -m` instead of a file (implies --live)")
    p.add_argument("--cwd", metavar="DIR", help="working directory the program runs in (default: the file's directory)")
    p.add_argument("--env", action="append", default=[], metavar="K=V", help="an environment variable for the program (repeatable)")
    p.add_argument("--python", metavar="PATH", help="interpreter to run with (default: the window's)")
    p.add_argument("--at", action="append", metavar="FILE:LINE|NAME", help="stop here: a line, or a function name whose entry pauses; repeat it for one stop per stage (`continue` goes from one to the next). Every one is set before the program starts and shows in the Breakpoints view")
    p.add_argument("--record", action="store_true", help="also record the run, so the Time Machine, the Code Story and `why` open over it at every pause (slower; needs a file, not --module)")
    p.add_argument("--record-from", dest="record_from", metavar="NAME|FILE:LINE", help="run at the debugger's speed up to here, pause, and record from this pause on: the Time Machine, `why`, `var` and `history` cover what runs after it (needs a file, not --module). It is also an --at")
    p.add_argument("--library-code", dest="library_code", action="store_true", help="step into and pause inside third-party packages too (never the standard library); off by default, so a breakpoint in a library function and `step --into` on a library call both need it")
    p.add_argument("--args", nargs=argparse.REMAINDER, default=[], metavar="...", help="everything after this goes to the program (sys.argv[1:]); must come last")
    p = sub.add_parser("continue", help="--live: resume the paused program; prints the next stop, or `finished: exit N`")
    p.add_argument("--no-start", dest="no_start", action="store_true", help="with no debug session, fail instead of starting the last `pyokka debug` launch from this directory again")
    live_arg(p)
    p.add_argument("--no-wait", dest="no_wait", action="store_true", help="answer `resumed` at once instead of waiting for the next stop (a server may not stop again for a while)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--until", metavar="EXPR", help="run until EXPR is true, then stop there (a watch that lives for this one resume)")
    g.add_argument("--to", metavar="FILE:LINE", help="run to this line and stop there (a breakpoint that lives for this one resume)")
    p = sub.add_parser("pause", help="--live: pause the running program at its next statement and print the stop")
    live_arg(p)
    p.add_argument("--no-wait", dest="no_wait", action="store_true", help="answer `pause requested` at once: a program blocked in accept() pauses only when the next request arrives")
    p = sub.add_parser("stop", help="--live: end the debug run and leave debug mode; the session and its recording stay; prints `stopped: exit N, K steps`")
    live_arg(p)
    p = sub.add_parser("restart", help="--live: stop the debug run and start it again; prints the first stop like `debug`")
    p.add_argument("--no-start", dest="no_start", action="store_true", help="with no debug session, fail instead of starting the last `pyokka debug` launch from this directory again")
    live_arg(p)
    entry_arg(p)
    p = sub.add_parser("break", help="--live: breakpoints: list them; FILE:LINE adds one (--when EXPR: only when true there); --remove FILE:LINE; --on-exception sets where an exception pauses the run")
    p.add_argument("--no-start", dest="no_start", action="store_true", help="with no debug session, fail instead of starting the last `pyokka debug` launch from this directory again")
    live_arg(p)
    p.add_argument("positions", nargs="*", metavar="FILE:LINE", help="add a breakpoint here (a def line pauses at every call; a blank line moves to the next statement)")
    p.add_argument("--when", metavar="EXPR", help="only pause when EXPR is true there (applies to the FILE:LINE given)")
    p.add_argument("--at", action="append", metavar="NAME|FILE:LINE", help="break at a function's entry by name (`--at rrf`, `--at Ranker.rank`), repeatable; the runtime resolves it, so a module imported later gets it too")
    p.add_argument("--remove", action="append", default=[], metavar="FILE:LINE|NAME", help="remove this breakpoint (repeatable): FILE:LINE for a line, NAME for the function breakpoint `--at NAME` set")
    p.add_argument("--list", action="store_true", help="list the breakpoints (the default with nothing else)")
    p.add_argument("--on-exception", dest="on_exception", choices=["off", "uncaught", "raised"], default=None, help="when the debugger pauses on an exception: uncaught (the default) stops where an exception nobody caught was raised, raised stops at every raise in your code, off never")
    p = sub.add_parser("watches", help="--live: watch expressions: --add EXPR shows its value at every stop in the panel; with --break-when change|true it pauses the run instead; --remove ID; list")
    live_arg(p)
    p.add_argument("--add", action="append", default=[], metavar="EXPR", help="add a watch expression (repeatable): displayed at every stop, or pausing with --break-when")
    p.add_argument("--break-when", dest="break_when", choices=["change", "true"], default=None, help="make the added watches pause the run: on every change of the value, or when it turns true")
    p.add_argument("--remove", action="append", default=[], metavar="ID", help="remove this watch (repeatable)")
    p.add_argument("--list", action="store_true", help="list the watches (the default with nothing else)")
    p = sub.add_parser("locals", help="--live: the paused frame's variables, one `name = value` per line")
    live_arg(p)
    p.add_argument("--frame", type=int, default=None, metavar="N", help="which frame of the pause, innermost 0 (the stop's `stack` numbers them)")
    p = sub.add_parser("record", help="--live: record from the current pause on, in a run started with --record-from that has not reached that point yet; prints the pause as step 0")
    live_arg(p)
    p = sub.add_parser("exec", help="--live: run a statement in the paused frame: an assignment, a call, an import, a block. The program sees the new value when it continues; `eval` reads without writing")
    live_arg(p)
    p.add_argument("source", metavar="SOURCE", help="the statement to run, e.g. 'rank = 3' (quote it)")
    p.add_argument("--frame", type=int, default=None, metavar="N", help="which frame of the pause to run in, innermost 0 (the stop's `stack` numbers them)")

    p = sub.add_parser("shell", help="--live: read one command per stdin line, the same words as the one-shot commands without --live, over one bridge connection; each result prints as the one-shot command would, a blank line after it; --json prints one JSON line per result")
    live_arg(p)

    p = sub.add_parser("history", help="the data behind a code-history page: the source each checkpoint needs, the values as of it, and the command that reproduces them")
    run_arg(p)
    p.add_argument("--at", action=Checkpoint, dest="checkpoints", metavar="STEP|FILE:LINE", help="a checkpoint at this step, or at the first step on this line (repeatable)")
    p.add_argument("--var", action=Checkpoint, dest="checkpoints", metavar="NAME", help="a checkpoint per recorded change of NAME, in step order (repeatable)")
    p.add_argument("--why", action=Checkpoint, dest="checkpoints", nargs=2, metavar=("STEP", "NAME"), help="a checkpoint for the provenance chain of NAME after STEP (repeatable)")
    p.add_argument("--pause", action=Checkpoint, dest="checkpoints", nargs=0, help="with --live: a checkpoint from the debug session's current pause, read without moving it")
    p.add_argument("--out", required=True, metavar="PATH", help="where the data JSON goes")
    p.add_argument("--prose", metavar="PATH", help="a JSON file whose prose fields are merged in; it may not set a generated field")
    p.add_argument("--pad", type=int, default=2, metavar="N", help="source lines of dim context above and below each block (default 2)")
    p.add_argument("--limit", type=int, default=20, metavar="K", help="most checkpoints one --var may produce (default 20)")
    p.add_argument("--lang", default="en", metavar="L", help="the page's language: its lang attribute and the words the page draws, en or es (default en)")
    p.add_argument("--scope", action="store_true", help="lift the 60-line block cap on every checkpoint")
    p.add_argument("--append", action="store_true", help="add these checkpoints to the page at --out instead of replacing it, for a second live pause")
    p.add_argument("--value-chars", type=int, default=None, metavar="N", help="characters of one value on a card (default: what the run kept, its --max-value-chars, 200 when it does not say; 0 shows every value whole)")


COMMANDS = ("story", "steps", "step", "context", "values", "find", "var", "why", "origin", "eval", "expand", "release", "state", "watch", "shell", "walkthrough", "graph", "exceptions", "narrate", "http", "history", "diff", "tour", *DEBUG_COMMANDS)


def parse_line(spec: str, flag: str = "--line") -> tuple[str, int]:
    example = "e.g. %s agent.py:16" % flag if flag.startswith("--") else "e.g. `%s --live agent.py:16`" % flag
    if ":" not in spec:
        raise AgentError("%s wants FILE:LINE, got %r" % (flag, spec), example)
    file, _, line = spec.rpartition(":")
    try:
        return file, int(line)
    except ValueError:
        raise AgentError("%s wants FILE:LINE, got %r" % (flag, spec), example) from None


def _remove_item(spec: str) -> dict:
    """`break --remove`: `FILE:LINE` is a line breakpoint, a bare name the function breakpoint `--at NAME` made."""
    if ":" in spec:
        f, l = parse_line(spec, "break --remove")
        return {"file": f, "line": l}
    if not spec.replace(".", "").replace("_", "").isalnum():
        raise AgentError("break --remove wants FILE:LINE or a function name, got %r" % spec, "e.g. `--remove demo.py:82`, or `--remove rrf` for what `--at rrf` set")
    return {"function": spec}


def is_live(args: Any) -> bool:
    if getattr(args, "command", None) == "debug" and (getattr(args, "program", None) or getattr(args, "module", None)):
        return True  # `pyokka debug app.py` needs no flag: a file (or a module) is always live
    return bool(getattr(args, "live", False) or getattr(args, "session", None))


def _fix_live_positionals(args: Any) -> None:
    """`step --live 5 --into`: argparse handed the number to RUN; it is the step.

    `why --live [STEP] [NAME]` has two optional words, so argparse shifts both: a leading number is
    the step, the next word the name; a run file among them stays RUN for `open_source` to refuse.
    """
    if getattr(args, "command", None) in ("why", "origin"):
        words = [str(v) for v in (args.run, args.step, args.name) if v is not None]
        args.run = args.step = args.name = None
        files = [w for w in words if w.endswith(".json") or os.sep in w]
        if files:
            args.run = files[0]
            words = [w for w in words if w not in files]
        if words and words[0].lstrip("-").isdigit():
            args.step = words.pop(0)
        if words:
            args.name = words.pop(0)
        if words:
            args.run = args.run or words.pop(0)
        return
    run = getattr(args, "run", None)
    if run is not None and hasattr(args, "step") and args.step is None and str(run).lstrip("-").isdigit():
        args.step = int(run)
        args.run = None


def _move_kind(args: Any) -> str | None:
    """`step`'s direction: only into, over and out can execute, so only they prefer a debug session."""
    if getattr(args, "command", None) != "step":
        return None
    return next((k for flag, k in MOVE_FLAGS if getattr(args, flag[2:].replace("-", "_"), False)), None)


def _parse_env(items: list) -> dict:
    out = {}
    for item in items or []:
        key, sep, value = str(item).partition("=")
        if not sep or not key:
            raise AgentError("--env wants K=V, got %r" % item, "e.g. `--env PORT=8000`; repeat it for more")
        out[key] = value
    return out


def debug_launch(args: Any) -> dict | None:
    """The launch `pyokka debug FILE|--module M` asks for; None when it names neither."""
    from .debug_start import build_launch, parse_at

    if not (getattr(args, "program", None) or getattr(args, "module", None)):
        return None
    _split_at(args)
    at = getattr(args, "at", None)
    for one in [at, *getattr(args, "also_at", [])]:
        if one:
            parse_at(one)  # a line or a function name; anything else is an error before anything starts
        # the file it names is checked by `resolve_at` in the two places that send it, not here:
        # `build_launch` does not check that `program` exists either, and this builds a launch
    record = bool(getattr(args, "record", False))
    record_from = getattr(args, "record_from", None)
    if record_from:
        parse_at(record_from)  # the `--at` grammar
    if (record or record_from) and getattr(args, "module", None):
        raise AgentError(
            '%s runs the file as a Pyokka run-all session, which has no module launch' % ("--record-from" if record_from else "--record"),
            "drop it for a module, or give a file: `pyokka debug app.py --record-from NAME`",
        )
    return build_launch(
        program=getattr(args, "program", None),
        module=getattr(args, "module", None),
        args=list(getattr(args, "args", []) or []),
        cwd=getattr(args, "cwd", None),
        env=_parse_env(getattr(args, "env", [])),
        python=getattr(args, "python", None),
        stop_on_entry=bool(getattr(args, "stop_on_entry", False)),
        library_code=bool(getattr(args, "library_code", False)),
        record=record,
        record_from=record_from,
    )


def _open_debug_start(args: Any) -> RunSource:
    """`pyokka debug FILE|--module M`: the three routes of 3.10, then the connection to drive."""
    from .debug_start import at_text, open_debug_session, resolve_at

    launch = debug_launch(args)
    assert launch is not None
    if launch.get("recordFrom"):
        # the resolved text, as `--at` travels; and a pause there, since the recording starts at a pause
        launch["recordFrom"] = at_text(resolve_at(launch["recordFrom"]))
        if launch["recordFrom"] not in [getattr(args, "at", None), *getattr(args, "also_at", [])]:
            if getattr(args, "at", None):
                args.also_at = [*getattr(args, "also_at", []), launch["recordFrom"]]
            else:
                args.at = launch["recordFrom"]
    at = getattr(args, "at", None)
    # the resolved text, so the URI and the socket both carry a path the other end cannot re-root
    if at:
        args.at = at = at_text(resolve_at(at))
    args.also_at = also = [at_text(resolve_at(a)) for a in getattr(args, "also_at", [])]
    source, send, route = open_debug_session(launch, [a for a in [at, *also] if a])
    from .relaunch import remember

    remember(launch, at, also)
    args._route = route
    args._launch = send
    # the URI carries `--at` so the breakpoint is set before the program starts; on the other two
    # routes the window is already answering, so the breakpoint goes over the socket first
    args._at_over_socket = bool(at) and route != "uri"
    return source


def _file_hint(args: Any) -> str | None:
    """The file the command names (`--line F:L`, story `--file F`): it picks the live session."""
    if getattr(args, "command", None) == "debug":
        program = getattr(args, "program", None)
        if isinstance(program, str) and program:
            return program
    line = getattr(args, "line", None)
    if isinstance(line, str) and ":" in line:
        return line.rpartition(":")[0]
    file = getattr(args, "file", None)
    return file if isinstance(file, str) else None


NO_DEBUG_HINT = "start one with `pyokka debug FILE --at NAME` (or `--module M`); it opens the session and prints the first stop"


def _idle_recording(args: Any, descriptor: dict, source: Any) -> bool:
    """`break` or `continue` landed on a recording session with no debug run in it."""
    from .live import descriptor_kind
    from .relaunch import recall

    if args.command not in ("break", "continue") or getattr(args, "session", None) or descriptor_kind(descriptor) == "debug":
        return False
    if recall() is None:
        return False  # nothing to start instead, so the host's own answer is the one to give
    try:
        return source.request({"type": "state"}).get("debug") is None
    except AgentError:
        return False


def _relaunch(args: Any, sessions: list) -> RunSource | None:
    """`break`, `continue`, `restart` with no debug session: start the last launch from this directory again.

    The first stop is the answer: the `break` position or `continue --to` line when one was given,
    else the launch's own `--at`. Returns None when this verb does not relaunch or there is a session.
    """
    from .debug_start import at_text, open_debug_session, resolve_at
    from .relaunch import RELAUNCH_VERBS, command_line, has_debug_session, recall, remember

    if args.command not in RELAUNCH_VERBS or getattr(args, "session", None) or has_debug_session(sessions):
        return None
    entry = recall()
    if entry is None:
        return None
    if getattr(args, "no_start", False):
        raise AgentError(NO_SESSION, "the last launch here was `%s`; run it, or drop --no-start to let this command start it" % command_line(entry["launch"], entry.get("at"), entry.get("also")))
    positions = list(getattr(args, "positions", None) or [])
    break_at = getattr(args, "at", None) if args.command == "break" else None
    if args.command == "break" and not positions and not break_at:
        # listing or removing breakpoints of a program that is not running starts nothing
        raise AgentError(NO_SESSION, NO_DEBUG_HINT)
    extra = []
    at = entry.get("at")
    if break_at:
        at, extra = break_at, positions
    elif positions:
        at, extra = positions[0], positions[1:]
    elif args.command == "continue" and getattr(args, "to", None):
        at = args.to
    if at:
        at = at_text(resolve_at(at))
    launch = entry["launch"]
    also = [] if (break_at or positions or args.command == "continue" and getattr(args, "to", None)) else list(entry.get("also") or [])
    source, send, route = open_debug_session(launch, [a for a in [at, *also] if a])
    remember(launch, at, also)
    args._relaunched = command_line(launch, at, also)
    args.also_at = also
    args._route = route
    args._launch = send
    args._at_over_socket = bool(at) and route != "uri"
    args._extra_breaks = extra
    args.at = at
    args.stop_on_entry = False
    args.command = "debug"
    return source


def _split_at(args: Any) -> None:
    """`--at` repeats on `debug` and `break`: the first stays `args.at`, the rest go to `args.also_at`."""
    at = getattr(args, "at", None)
    if isinstance(at, list):
        args.at = at[0] if at else None
        args.also_at = at[1:]
    elif not hasattr(args, "also_at"):
        args.also_at = []


def open_source(args: Any) -> RunSource:
    """The seam: ``RUN`` opens a saved run, ``--live`` connects to the VS Code session's bridge."""
    if args.command == "diff":
        from .diff import open_pair

        return open_pair(args)
    if args.command in ("debug", "break"):
        _split_at(args)
    if args.command == "shell" and not is_live(args):
        args.live = True  # the shell has no saved-run form, so `pyokka shell` and `pyokka shell --session demo.py` are live
    if args.command in DEBUG_COMMANDS and not is_live(args):
        raise AgentError("%s drives the open VS Code session, not a saved run" % args.command, LIVE_HINT)
    if args.command == "debug" and (getattr(args, "program", None) or getattr(args, "module", None)):
        return _open_debug_start(args)
    if is_live(args):
        from .live import LiveRun, list_sessions, pick_session, prefer_kind

        _fix_live_positionals(args)
        if args.run is not None:
            raise AgentError("--live reads the open VS Code session, not %s" % args.run, "drop --live to read the saved run, or drop the file")
        prefer = prefer_kind(args.command, _move_kind(args))
        sessions = list_sessions()
        try:
            picked = pick_session(sessions, session=getattr(args, "session", None), file_hint=_file_hint(args), prefer=prefer)
        except AgentError as exc:
            if args.command not in DEBUG_COMMANDS or exc.message != NO_SESSION:
                raise
            # a debugger verb with nothing to drive: start the last launch again, or say how to start one
            relaunched = _relaunch(args, sessions)
            if relaunched is not None:
                return relaunched
            raise AgentError(NO_SESSION, NO_DEBUG_HINT) from None
        source = LiveRun(picked)
        if _idle_recording(args, picked, source):
            # the debug session ended and only a recording of some file is left: it would answer
            # `no debug run in progress`, so the remembered launch is the better answer
            relaunched = _relaunch(args, sessions)
            if relaunched is not None:
                source.close()
                return relaunched
        return source
    if args.run is None:
        raise AgentError("%s needs a saved run, or --live for the open VS Code session" % args.command, "save one with `pyokka run FILE --save run.json`, or turn on pyokka.agentAccess and add --live")
    return SavedRun(args.run)


def dispatch(args: Any, out: Any = None) -> int:
    out = out or sys.stdout
    err = sys.stderr
    try:
        source = open_source(args)
        try:
            if args.command == "watch":
                return _watch(args, source, out)
            if args.command == "shell":
                from .shell import run_shell

                return run_shell(args, source, out)
            result = _run_command(args, source)
        finally:
            source.close()
    except AgentError as exc:
        if args.json:
            out.write(json.dumps(exc.to_json(), ensure_ascii=False) + "\n")
        else:
            err.write("error: %s\n" % redact(exc.message))
            if exc.hint:
                err.write("%s\n" % redact(exc.hint))
        return 2
    notes = recording_notes(source)
    live_cap = result.get("recording") if isinstance(result, dict) else None
    if not notes and isinstance(live_cap, dict) and live_cap.get("truncated") and "kept" in live_cap:
        notes = [(None, live_cap)]  # a live session's `state` carries it (bridge.ts)
    if args.json:
        if isinstance(result, dict):
            annotate_cut(result)
            if notes:
                result["recording"] = notes[0][1] if len(notes) == 1 and notes[0][0] is None else {label: info for label, info in notes}
        out.write(json.dumps(result, ensure_ascii=False, indent=1) + "\n")
    else:
        for label, info in notes:
            line = note_line(info)
            out.write(("note: %s: %s" % (label, line[len("note: "):]) if label else line) + "\n")
        # a statement that raised is still a served request: the error goes on stderr, exit stays 0
        raised = exec_error(result) if args.command == "exec" else None
        if raised:
            err.write("%s\n" % redact(raised))
        if getattr(args, "_relaunched", None):
            out.write("no debug session was running: started the last launch from this directory again, `%s`\n" % args._relaunched)
        out.write(render(args.command, result, source, args))
    return 0


def recording_notes(source: Any) -> list[tuple[str | None, dict]]:
    """What the step cap cut from the run(s) behind ``source``: ``(label, info)`` per capped run; the label names the side of a diff."""
    sides = [(None, source)]
    if hasattr(source, "a") and hasattr(source, "b"):  # diff's pair
        sides = [("a", getattr(source.a, "source", None)), ("b", getattr(source.b, "source", None))]
    out = []
    for label, src in sides:
        info = getattr(src, "recording", None)
        if isinstance(info, dict) and info.get("truncated"):
            out.append((label, info))
    return out


def _watch(args: Any, source: Any, out: Any) -> int:
    if not hasattr(source, "watch"):
        raise AgentError("watch follows the user's stepping in VS Code, so it needs --live", "`pyokka watch --live`; a saved run does not move")

    def on_event(ev: dict) -> None:
        out.write((json.dumps(ev, ensure_ascii=False) if args.json else redact(watch_line(ev, source, _one_line))) + "\n")
        out.flush()

    try:
        source.watch(on_event)
    except KeyboardInterrupt:
        pass
    return 0


def _run_command(args: Any, source: RunSource) -> dict:
    cmd = args.command
    if cmd == "story":
        return source.story(file=args.file, scope=args.scope, line=parse_line(args.line) if args.line else None, limit=max(1, args.limit))
    if cmd == "steps":
        return source.steps(start=args.start, count=args.count, line=parse_line(args.line) if args.line else None)
    if cmd == "step":
        kind = next((k for flag, k in MOVE_FLAGS if getattr(args, flag[2:].replace("-", "_"))), None)
        if args.step is None and not is_live(args):
            raise AgentError("step needs N, the step to move from", "e.g. `step run.json 12 --into`; with --live the current step is implied")
        # `--count N` is a live-only move: a saved run is navigated one step at a time
        extra = {"count": args.count} if getattr(args, "count", None) and is_live(args) else {}
        return source.step(args.step, kind=kind, to=args.to, scope=args.scope, **extra)
    if cmd == "context":
        if args.step is None and not args.line and not is_live(args):
            raise AgentError("context needs a step number or --line FILE:LINE", "e.g. `context 12` or `context --line agent.py:16`; with --live the current step is implied")
        file, line = parse_line(args.line) if args.line else (None, None)
        return source.context(step=args.step, file=file, line=line, scope=args.scope)
    if cmd == "values":
        file, line = parse_line(args.line)
        return source.values(file, line)
    if cmd == "find":
        return source.find(args.text, limit=args.limit)
    if cmd == "var":
        return source.var(args.name, file=args.file, scope=args.scope, limit=max(1, args.limit))
    if cmd == "why":
        if args.step is None and not is_live(args):
            raise AgentError("why needs STEP, the step whose statement made the value", "e.g. `why run.json 24 label`; `var run.json label` lists the steps where it changed, `steps --line F:L` the steps on a line")
        if args.step is not None and not str(args.step).lstrip("-").isdigit():
            raise AgentError("STEP must be a step number, got %r" % args.step, "e.g. `why run.json 24 label`: the step first, then the name")
        depth = max(1, min(PROVENANCE_MAX_DEPTH, int(args.depth)))
        return source.why(int(args.step) if args.step is not None else None, (args.name or "").strip(), depth=depth)
    if cmd == "origin":
        if args.step is None and not is_live(args):
            raise AgentError("origin needs STEP, the step of the failing statement", "e.g. `origin run.json 64`; `exceptions run.json` lists the steps where exceptions were raised")
        if args.step is not None and not str(args.step).lstrip("-").isdigit():
            raise AgentError("STEP must be a step number, got %r" % args.step, "e.g. `origin run.json 64 items`: the step first, then the expression")
        depth = max(2, min(ORIGIN_MAX_DEPTH, int(args.depth)))
        return source.origin(int(args.step) if args.step is not None else None, (args.name or "").strip(), depth=depth)  # type: ignore[attr-defined]
    if cmd == "eval":
        frame = getattr(args, "frame", None)
        return source.eval(args.expression, frame=frame) if frame else source.eval(args.expression)
    if cmd == "expand":
        return source.expand(args.value_id, list(args.path))
    if cmd == "release":
        return source.release()  # type: ignore[attr-defined]
    if cmd == "state":
        return source.state()
    if cmd == "walkthrough":
        return source.walkthrough(file=args.file, scope=args.scope, start=args.start, end=args.end, all_scopes=args.all)
    if cmd == "graph":
        return source.graph(all_scopes=args.all, scope=args.scope, expand=list(args.expand or []), statements=args.statements)
    if cmd == "tour":
        return run_tour(args, source)
    if cmd == "exceptions":
        return source.exceptions()
    if cmd == "http":
        return source.http()
    if cmd == "history":
        from .codehistory import write_history

        return write_history(source, args, "--live%s" % (" --session %s" % args.session if args.session else "") if is_live(args) else str(args.run))
    if cmd == "debug":
        # route (b) of 3.10 answers on a run socket, so the launch goes with the request; a debug
        # socket ignores it and answers the pause it already holds
        launch = getattr(args, "_launch", _MISSING)
        if launch is _MISSING:
            launch = debug_launch(args)
        at = getattr(args, "at", None)
        if at and getattr(args, "_at_over_socket", launch is not None):
            from .debug_start import resolve_at

            spec = resolve_at(at)
            # a function name is resolved in the runtime, so it goes over as `at`, not as a line
            if "function" in spec:
                source.breakpoints(at=spec["function"])  # type: ignore[attr-defined]
            else:
                source.breakpoints(add=[{"file": spec["file"], "line": spec["line"]}])  # type: ignore[attr-defined]
        if getattr(args, "_route", "uri") != "uri":
            from .debug_start import resolve_at

            # the URI carried every `--at`; on a socket the ones after the first go here
            for extra in getattr(args, "also_at", []) or []:
                spec = resolve_at(extra)
                if "function" in spec:
                    source.breakpoints(at=spec["function"])  # type: ignore[attr-defined]
                else:
                    source.breakpoints(add=[{"file": spec["file"], "line": spec["line"]}])  # type: ignore[attr-defined]
        for spec in getattr(args, "_extra_breaks", []):
            f, l = parse_line(spec, "break")
            source.breakpoints(add=[{"file": f, "line": l}])  # type: ignore[attr-defined]
        result = source.debug(stop_on_entry=args.stop_on_entry, launch=launch)  # type: ignore[attr-defined]
        # a cold start paused behind the terminal: bring the window up at the stop, once
        paused = result.get("paused") if isinstance(result, dict) else None
        if getattr(args, "_route", None) in ("uri", "run") and isinstance(paused, dict) and not getattr(args, "no_focus", False):
            from .debug_start import focus_editor

            focus_editor(str(paused.get("file") or ""), paused.get("line") or 0)
        if getattr(args, "_relaunched", None) and isinstance(result, dict):
            result["relaunched"] = args._relaunched
        return result
    if cmd == "continue":
        to = parse_line(args.to, "continue --to") if getattr(args, "to", None) else None
        return source.continue_(no_wait=bool(getattr(args, "no_wait", False)), until=getattr(args, "until", None), to=to)  # type: ignore[attr-defined]
    if cmd == "pause":
        return source.pause(no_wait=bool(getattr(args, "no_wait", False)))  # type: ignore[attr-defined]
    if cmd == "stop":
        return source.stop()  # type: ignore[attr-defined]
    if cmd == "restart":
        return source.restart(stop_on_entry=args.stop_on_entry)  # type: ignore[attr-defined]
    if cmd == "break":
        add = [{"file": f, "line": l, **({"condition": args.when} if args.when else {})} for f, l in (parse_line(spec, "break") for spec in args.positions)]
        if args.when and not add:
            raise AgentError("--when needs a FILE:LINE to apply to", "e.g. `break --live demo.py:12 --when 'payload is None'`")
        remove = [_remove_item(spec) for spec in args.remove]
        for extra in getattr(args, "also_at", []) or []:
            source.breakpoints(at=extra)  # type: ignore[attr-defined]
        return source.breakpoints(add=add, remove=remove, exceptions=args.on_exception, at=getattr(args, "at", None))  # type: ignore[attr-defined]
    if cmd == "watches":
        return source.watches(add=[{"exp": exp, **({"breakWhen": args.break_when} if args.break_when else {})} for exp in args.add], remove=list(args.remove))  # type: ignore[attr-defined]
    if cmd == "locals":
        return source.locals(value_bag=bool(args.json), frame=getattr(args, "frame", None))  # type: ignore[attr-defined]
    if cmd == "exec":
        return source.exec(args.source, frame=getattr(args, "frame", None))  # type: ignore[attr-defined]
    if cmd == "diff":
        from .diff import diff_command

        return diff_command(args, source)
    if cmd == "record":
        return source.record()  # type: ignore[attr-defined]
    if cmd == "narrate":
        from .narrate import narrate_saved

        if not hasattr(source, "path"):
            raise AgentError("narrate writes the glosses into a saved run", "save one with `pyokka run FILE --save run.json`; the panel's Narrate button does the same for a live session")
        return narrate_saved(source, command=args.model_command, dry_run=args.dry_run)  # type: ignore[arg-type]
    raise AgentError("unknown command %s" % cmd)


__all__ = ["add_commands", "dispatch", "COMMANDS", "DEBUG_COMMANDS", "debug_launch", "parse_line", "open_source", "render"]
