"""``pyokka shell --live``: many commands over one bridge connection.

A one-shot command costs about 70 ms, of which the session's answer is 1 to 4 ms; the rest is
starting Python and importing the CLI. The shell pays that once: it reads one command line per
stdin line, keeps the ``LiveRun`` of ``commands.dispatch`` open and prints every result the way
the one-shot command would (a blank line after each, or one JSON line with ``--json``), so a
long session of stops costs the answers and nothing else.

The words of a line are the one-shot words without ``--live``: ``state``, ``debug
--stop-on-entry``, ``locals``, ``why 412 payload``. ``watch`` is refused (it streams until
Ctrl-C and would block the loop); ``exit``, ``quit`` or EOF end the shell.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from typing import Any, NoReturn

from ..redact import redact
from .commands import _fix_live_positionals, _run_command, add_commands
from .render import render
from .source import AgentError

LINE_HINT = "one command per line, the words of the one-shot command without --live; `exit` ends the shell"


class LineParser(argparse.ArgumentParser):
    """``error`` raises instead of ending the process: a bad line is one error, not the end of the shell."""

    def error(self, message: str) -> NoReturn:  # type: ignore[override]
        raise AgentError(message, LINE_HINT)


def build_parser() -> LineParser:
    """The one-shot parser without the runner commands (``run``, ``serve``, ``cache``), built once."""
    parser = LineParser(prog="pyokka", description="One command per line over the live session's bridge.")
    add_commands(parser.add_subparsers(dest="command", required=True))
    return parser


def run_shell(args: Any, source: Any, out: Any = None) -> int:
    """Read stdin line by line and answer each one over ``source``; 0 on ``exit``, ``quit`` or EOF."""
    out = out or sys.stdout
    err = sys.stderr
    parser = build_parser()
    json_mode = bool(getattr(args, "json", False))
    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            return 0
        if not line:  # EOF: the pipe closed
            return 0
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        as_json = json_mode
        try:
            words = shlex.split(text)
        except ValueError as exc:  # an unbalanced quote
            _write_error(AgentError("cannot read the line: %s" % exc, "quote as a shell does: `eval 'payload[\"x\"]'`"), out, err, as_json)
            continue
        if not words:
            continue
        if words[0] in ("exit", "quit"):
            return 0
        try:
            line_args = _prepare(parser, words, json_mode)
            if line_args is None:  # `--help` on the line printed the help; close it like a result
                if not as_json:
                    out.write("\n")
                out.flush()
                continue
            as_json = bool(line_args.json)
            result = _run_command(line_args, source)
        except AgentError as exc:
            _write_error(exc, out, err, as_json)
            continue
        if as_json:
            from .recording import annotate_cut

            out.write(json.dumps(annotate_cut(result), ensure_ascii=False) + "\n")
        else:
            out.write(render(line_args.command, result, source, line_args) + "\n")
        out.flush()


def _prepare(parser: LineParser, words: list[str], json_mode: bool) -> Any:
    """The line's arguments, live like the shell itself; ``None`` when the line only printed help."""
    try:
        line_args = parser.parse_args(words)
    except SystemExit:  # `--help` on a line; the shell goes on
        return None
    if getattr(line_args, "session", None):
        raise AgentError("the shell already has a session", "start a second `pyokka shell --live --session NAME` for another one")
    if line_args.command == "watch":
        raise AgentError("watch streams every stop until Ctrl-C, so it would block the shell", "run `pyokka watch --live` in another terminal")
    if line_args.command == "shell":
        raise AgentError("the shell is already running", LINE_HINT)
    line_args.live = True  # a --live on the line is accepted and ignored: every line is live
    if json_mode:
        line_args.json = True
    _fix_live_positionals(line_args)
    if getattr(line_args, "run", None) is not None:
        raise AgentError("the shell reads the live session, not %s" % line_args.run, "leave the file out; `pyokka %s %s ...` reads the saved run in its own process" % (line_args.command, line_args.run))
    return line_args


def _write_error(exc: AgentError, out: Any, err: Any, as_json: bool) -> None:
    """As ``dispatch`` reports one: JSON on stdout, else ``error:`` and the hint on stderr."""
    if as_json:
        out.write(json.dumps(exc.to_json(), ensure_ascii=False) + "\n")
        out.flush()
        return
    err.write("error: %s\n" % redact(exc.message))
    if exc.hint:
        err.write("%s\n" % redact(exc.hint))
    err.flush()


__all__ = ["run_shell", "build_parser", "LineParser"]
