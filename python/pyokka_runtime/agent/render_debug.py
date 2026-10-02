"""Text forms of a debug session without a recording (docs/design/debugger-product.md, 4.9).

``render.py`` keeps the dispatch table and sends the debug entries here when the reply carries no
``moves`` (a ``record: false`` stop has no trace to move through). What an agent reads at a stop:
where it paused and why, the frame chain, the enclosing function's source with the paused line
marked, the frame's variables, and what the program printed so far.
"""

from __future__ import annotations

from typing import Any

from .live import stop_reason
from .recording import cut_line

OUTPUT_LINES = 20
OUTPUT_LINES_SCOPE = 200
STACK_FRAMES = 8


def _loc(source: Any, file: Any, line: Any) -> str:
    name = source.display_path(file) if hasattr(source, "display_path") else (file or "<unknown>")
    return "%s:%s" % (name, line) if line else str(name)


def _one_line(text: Any, limit: int = 160) -> str:
    return cut_line(text, limit, strip=True)


RECORDING_STARTED = "; recording starts here, step 0"
NOT_RECORDING_YET = "not recording yet: the recording starts at the --record-from pause; `record --live` starts it here"


def recording_suffix(paused: Any) -> str:
    """After the reason of the pause a ``--record-from`` run started recording at."""
    return RECORDING_STARTED if isinstance(paused, dict) and paused.get("recordingStarted") else ""


def recording_start_lines(result: dict) -> list[str]:
    """Under the step line of step 0 of a ``--record-from`` recording: why there is nothing before it."""
    return ["recording started here: what ran before step 0 was not recorded"] if result.get("recordingStart") else []


def render_record(result: dict, source: Any, args: Any) -> list[str]:
    """``record --live``: the pause again, now step 0 of the recording; or that the run already records."""
    from .render import render_stop

    head = ["already recording: `step --live --back` and `why --live` read what was recorded so far"] if result.get("already") else []
    return head + render_stop(result, source, args)


def is_debug_reply(result: dict) -> bool:
    """A ``record: false`` reply: a stop slice with no trace behind it, or a debug ``state``."""
    if result.get("kind") == "debug":
        return True
    return "block" in result and "moves" not in result and "count" not in result


def render_debug_stop(result: dict, source: Any, args: Any) -> list[str]:
    """A stop of a debug session: ``paused at file:line (reason)`` and everything the pause carries."""
    fin = result.get("finished")
    if isinstance(fin, dict):
        head = "finished: exit %s, %s steps" % (fin.get("exitCode"), fin.get("stepCount"))
        stepped = result.get("stepped")
        return [head] if stepped is None else [head, "%s step%s were taken before it ended" % (stepped, "" if stepped == 1 else "s")]
    if result.get("resumed"):
        return ["resumed"]
    if result.get("requested"):
        return ["pause requested: the program pauses at its next statement"]
    if result.get("stopped"):
        ended = result.get("finished") or {}
        return ["stopped: exit %s, %s steps" % (ended.get("exitCode"), ended.get("stepCount"))]
    loc = result.get("location") or {}
    paused = result.get("paused") if isinstance(result.get("paused"), dict) else {}
    head = "paused at %s (%s%s)" % (_loc(source, loc.get("file") or paused.get("file"), loc.get("line") or paused.get("line")), stop_reason(paused), recording_suffix(paused))
    if result.get("modified"):
        head += " (values modified from the console)"
    out = [head]
    if result.get("recording") is False:
        out.append(NOT_RECORDING_YET)
    early = result.get("stoppedEarly")
    if isinstance(early, dict):
        out.append("stopped early after %s step%s: %s" % (early.get("after"), "" if early.get("after") == 1 else "s", early.get("reason")))
    out.extend(_thread_and_below(result, source, args))
    return out


def exec_error(result: dict) -> str | None:
    """``ZeroDivisionError: division by zero`` when the statement raised, else None.

    A statement that raised is not a failed command: the session is still paused and the next
    ``continue`` works. So the line goes on stderr, the exit code stays 0, and stdout says where
    the program still is (``dispatch`` writes both).
    """
    exc = result.get("exception")
    if not isinstance(exc, dict):
        return None
    return "%s: %s" % (exc.get("type"), _one_line(exc.get("message")))


def render_debug_exec(result: dict, source: Any, args: Any) -> list[str]:
    """``exec --live``: the value on one line, ``ok`` for a statement, where it still is on an error."""
    if exec_error(result) is not None:
        loc = result.get("location") if isinstance(result.get("location"), dict) else None
        return ["still paused at %s" % _loc(source, loc.get("file"), loc.get("line"))] if loc else ["still paused"]
    text = result.get("text")
    out = [_one_line(text, 2000)] if text else ["ok"]
    if result.get("modified"):
        out.append("values modified from the console: they are no longer the program's own")
    return out


def _thread_and_below(result: dict, source: Any, args: Any) -> list[str]:
    out: list[str] = []
    thread = result.get("thread")
    if isinstance(thread, dict) and thread.get("name") not in (None, "MainThread"):
        out.append("thread %s" % thread["name"])
    out.extend(_stack_lines(result, source))
    out.extend(_block_lines(result, source))
    out.extend(_locals_lines(result))
    out.extend(_output_lines(result.get("output"), bool(getattr(args, "scope", False))))
    out.extend(_error_lines(result, source))
    return out


def _frame_text(entry: dict, source: Any) -> str:
    """One entry of the chain: a frame, or the marker for the frames the slice could not show."""
    if entry.get("elided"):
        count = int(entry["elided"])
        where = ", ".join(str(f) for f in entry.get("in") or [])
        kind = "library frame" if entry.get("where") == "library" else "frame"
        return "… %d %s%s%s …" % (count, kind, "" if count == 1 else "s", " in %s" % where if where else "")
    return "%s %s" % (entry.get("function"), _loc(source, entry.get("file"), entry.get("line")))


def _stack_lines(result: dict, source: Any) -> list[str]:
    """The chain, innermost first. Over ``STACK_FRAMES`` it keeps both ends, not the top alone.

    The outermost frame is where the program was started, which is worth as much as the frames
    next to the pause; cutting the tail off threw it away and left the chain looking as if it
    stopped in the middle of nowhere.
    """
    stack = [f for f in result.get("stack") or [] if isinstance(f, dict)]
    if len(stack) < 2:
        return []
    shown: list[dict] = stack
    if len(stack) > STACK_FRAMES:
        shown = [*stack[: STACK_FRAMES - 2], {"elided": len(stack) - (STACK_FRAMES - 1)}, stack[-1]]
    return ["stack: " + " ← ".join(_frame_text(f, source) for f in shown)]


def _block_lines(result: dict, source: Any) -> list[str]:
    """The enclosing function, with every gap the cut left counted where it falls.

    A cut block is the signature plus the suite the pause is in, so the shown lines are not one
    run. ``… 128 lines`` at each jump is what keeps that readable: a reader knows exactly how much
    of the function is between the two pieces, instead of an ellipsis that could stand for three
    lines or three hundred.
    """
    b = result.get("block") if isinstance(result.get("block"), dict) else None
    if not b:
        return []
    lines = [l for l in b.get("lines") or [] if isinstance(l, dict)]
    total = b.get("totalLines")
    cap = (" (%d of %d lines; --scope for all)" % (len(lines), total) if total else " (%d lines; --scope for all)" % len(lines)) if b.get("capped") else ""
    out = ["block %s  %s%s" % (b.get("function"), _loc(source, b.get("file"), None), cap)]
    if not lines:
        out.append("   (no source available)")
        return out
    width = max(len(str(l["line"])) for l in lines)
    prev: int | None = None
    for l in lines:
        if prev is not None and l["line"] - prev > 1:
            gap = l["line"] - prev - 1
            out.append("%s  … %d line%s" % (" " * width, gap, "" if gap == 1 else "s"))
        out.append("%s%s  %s" % (">" if l.get("current") else " ", str(l["line"]).rjust(width), str(l.get("text") or "").rstrip()))
        prev = l["line"]
    return out


def _locals_lines(result: dict) -> list[str]:
    variables = result.get("locals")
    if not isinstance(variables, list):
        return []
    rows = [v for v in variables if isinstance(v, dict)]
    if not rows:
        return ["locals: (none)"]
    return ["locals:", *["  %s = %s" % (v.get("name"), _one_line(v.get("text"))) for v in rows]]


def _output_lines(output: Any, scope: bool = False) -> list[str]:
    """What the program printed, indented, with what it is a piece of said in the header.

    A stop carries what the program printed **since the previous stop** (``since: "stop"``), not
    the tail of the whole run: an agent that steps ten times used to read the same 4 KB ten times
    and could never tell which line its own step produced. ``earlier`` is how many lines are behind
    the ones shown, so nothing goes missing quietly; ``--scope`` asks for the window instead.
    """
    if not isinstance(output, dict):
        return []
    lines = str(output.get("text") or "").splitlines()
    earlier = int(output.get("earlier") or 0)
    delta = output.get("since") == "stop"
    behind = "; %d earlier" % earlier if earlier else ""
    if not lines:
        if not delta:
            return []
        return ["output: nothing new since the last stop%s" % (" (%d line%s earlier; --scope for the window)" % (earlier, "" if earlier == 1 else "s") if earlier else "")]
    shown = lines[-(OUTPUT_LINES_SCOPE if scope else OUTPUT_LINES) :]
    if delta:
        head = "output (%d new line%s%s" % (len(lines), "" if len(lines) == 1 else "s", ", the last %d shown" % len(shown) if len(shown) < len(lines) else "")
    else:
        head = "output (last %d line%s%s" % (len(shown), "" if len(shown) == 1 else "s", " of %d" % len(lines) if len(shown) < len(lines) else "")
    return ["%s%s):" % (head, behind), *["  " + line for line in shown]]


def _error_lines(result: dict, source: Any) -> list[str]:
    errors = [e for e in result.get("errors") or [] if isinstance(e, dict)]
    if not errors:
        return []
    out = ["errors:"]
    for e in errors:
        out.append("  %s %s: %s" % (_loc(source, e.get("file"), e.get("line")), e.get("type"), _one_line(e.get("message"))))
    return out


def render_debug_state(result: dict, source: Any, args: Any) -> list[str]:
    """``state --live`` on a debug socket: both kinds listed, debug first, then this session."""
    out = _listing(result)
    launch = result.get("launch") if isinstance(result.get("launch"), dict) else {}
    dbg = result.get("debug") if isinstance(result.get("debug"), dict) else {}
    paused = dbg.get("paused") if isinstance(dbg.get("paused"), dict) else None
    where = "paused at %s (%s)" % (_loc(source, paused.get("file"), paused.get("line")), stop_reason(paused)) if paused else "running (`pause --live` stops it at its next statement)"
    out.append("")
    out.append("%s  %s" % (result.get("displayName") or source.display_path(result.get("file")), where))
    out.append("  launch: %s" % _launch_line(launch))
    out.append("  record: %s" % ("on" if launch.get("record") else "off"))
    # only when it is on: the default is off and a line saying so on every stop is noise
    if launch.get("libraryCode"):
        out.append("  library code: on")
    out.append("  exceptions: %s" % (dbg.get("exceptions") or "uncaught"))
    if result.get("modified"):
        out.append("  values were modified from the console")
    out.extend("  " + line for line in _output_lines(result.get("output"), bool(getattr(args, "scope", False))))
    return out


def _launch_line(launch: dict) -> str:
    """``/abs/.venv/bin/python -m app.server --port 8000   (cwd /abs)``.

    The interpreter is printed only when the launch names one: the host fills it in from the
    session once it resolved it, and printing ``python3`` for a session that runs a venv would be
    a guess the reader cannot tell from a fact.
    """
    python = launch.get("python")
    target = "-m %s" % launch["module"] if launch.get("module") else str(launch.get("program") or "")
    head = "%s %s" % (python, target) if python else target
    command = " ".join([head, *[str(a) for a in launch.get("args") or []]])
    return "%s   (cwd %s)" % (command, launch.get("cwd")) if launch.get("cwd") else command


def _listing(result: dict) -> list[str]:
    """One line per session on the file, the connected one marked ``[this]``; debug first."""
    rows: list[tuple[str, str, str, bool]] = [(str(result.get("kind") or "debug"), str(result.get("displayName") or ""), _this_state(result), True)]
    for other in result.get("others") or []:
        if not isinstance(other, dict):
            continue
        rows.append((str(other.get("kind") or "run"), str(other.get("displayName") or ""), _other_state(other), False))
    rows.sort(key=lambda r: 0 if r[0] == "debug" else 1)
    return ["%-6s %-14s %s%s" % (kind, name, state, "   [this]" if mine else "") for kind, name, state, mine in rows]


def _this_state(result: dict) -> str:
    if result.get("paused"):
        dbg = result.get("debug") if isinstance(result.get("debug"), dict) else {}
        paused = dbg.get("paused") if isinstance(dbg.get("paused"), dict) else {}
        return "running, paused at %s:%s (%s)" % (paused.get("file") and str(paused["file"]).rsplit("/", 1)[-1] or "?", paused.get("line"), stop_reason(paused))
    return "running" if result.get("running") else "ended"


def _other_state(other: dict) -> str:
    if other.get("paused"):
        return "running, paused"
    if other.get("running"):
        return "running"
    steps = other.get("steps")
    return "finished, %s steps" % steps if steps else "no finished run yet"


__all__ = ["exec_error", "is_debug_reply", "render_debug_exec", "render_debug_state", "render_debug_stop"]
