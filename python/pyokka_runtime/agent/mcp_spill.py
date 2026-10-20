"""A tool result too long for the model's context goes to a file: the reply keeps its first lines, its last lines
and the path, so the model reads the rest when it needs it.

The smoke test of 2026-10-19 (Codex on a langchain clone) is the case. Of the 63 results the model received, one,
``pyokka_review start``, was 65,050 characters in 301 lines, 64 % of the session's tool-result text, and every
other was under 2 KB. Claude Code saves a long Bash result or MCP result to its session's ``tool-results`` directory
and gives the model the path with a preview (its docs, 2026-10-20: a Bash result past about 30,000 characters, an MCP
result past 25,000 tokens or 50,000 characters); Codex keeps a token budget per tool output instead
(``tool_output_token_limit``) and cuts past it. ``pyokka mcp`` does what Claude Code does, at a size that fits one
answer: ``spill`` writes the whole text to
``<pyokka home>/tool-results/<yyyymmdd-HHMMSS>-<tool>[-<action>].txt`` and the reply keeps the head, where an
answer has its header, summary and view, and the tail, where it has ``next:``, with two lines between them that
name the lines left out, the file and the ``sed`` that prints them. The file holds the text the reply would have
carried, redacted already, so the marker's numbers are the file's lines and the lines shown are its first and last
lines verbatim.

A JSON answer keeps its form: the reply is a small JSON object with the path, the size and the first lines as a
string, since a head and a tail of a JSON document parse as neither. The CLI is unchanged: it prints everything,
and Claude Code's Bash tool spills a long output itself.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shlex
import sys
import tempfile
import time
import traceback
from typing import Any, Mapping

from ..home import pyokka_home

MAX_CHARS_ENV = "PYOKKA_MCP_MAX_CHARS"

#: 8,000 characters, about 2,000 tokens. The longest ordinary answer of the 2026-10-19 smoke test was 1,633
#: (``continue``) and the suite's longest is 4,203 (``review state`` as JSON), so the answer to one question stays
#: whole, while the ``start`` that made the limit, 65,050, is eight times over it.
MAX_CHARS = 8000

#: ceilings on the first and the last lines a reply keeps; on long lines the character budgets of ``cut`` bind
#: first (that ``start`` keeps 37 and 9)
HEAD_LINES = 40
TAIL_LINES = 10

#: the spilled files a directory keeps: writing one deletes the oldest beyond this many
KEEP_FILES = 200

HOME_DIR = "tool-results"
TEMP_DIR = "pyokka-tool-results"

_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]+")
_SPILLED = re.compile(r"\d{8}-\d{6}-.+\.txt")


def max_chars(env: Mapping[str, str] | None = None) -> int:
    """``$PYOKKA_MCP_MAX_CHARS`` when it is a positive integer, else ``MAX_CHARS``: ``8k`` or ``0`` keeps the default
    rather than spilling every answer."""
    raw = (os.environ if env is None else env).get(MAX_CHARS_ENV) or ""
    try:
        value = int(raw.strip())
    except ValueError:
        return MAX_CHARS
    return value if value > 0 else MAX_CHARS


def directories() -> list[str]:
    """Where a spilled result may go, in order: the Pyokka home, then the system temp directory, for a sandbox that
    lets the agent write its workspace and /tmp only (in Codex's on 2026-10-19, ``review/state.py``'s
    ``set_current`` failed under the home with PermissionError)."""
    found = [os.path.join(pyokka_home(), HOME_DIR)]
    with contextlib.suppress(OSError):  # tempfile found no usable directory at all
        found.append(os.path.join(tempfile.gettempdir(), TEMP_DIR))
    return found


def file_stem(name: str, arguments: Mapping[str, Any], now: float | None = None) -> str:
    """``<yyyymmdd-HHMMSS>-<tool>[-<action>]`` in local time. The tool and the action (``op`` for the scratchpad)
    keep only ``[A-Za-z0-9_.-]``, so no argument reaches outside the directory."""
    parts = [time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), _part(name) or "tool"]
    verb = _part(arguments.get("action") or arguments.get("op") or "")
    if verb:
        parts.append(verb)
    return "-".join(parts)


def _part(value: Any) -> str:
    return _UNSAFE.sub("_", str(value)).strip("._")[:40]


def write_new(directory: str, stem: str, text: str) -> str:
    """Write ``text`` to a file of its own in ``directory`` and return its path; OSError when the directory cannot be
    made or written. The file is created exclusively, so a link planted at its name is never followed and two
    servers that spill in the same second (mcporter starts one per call) get ``-2``, ``-3``; and privately (0600),
    since it holds the program's values."""
    os.makedirs(directory, mode=0o700, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    for n in range(1, 1000):
        path = os.path.join(directory, "%s%s.txt" % (stem, "-%d" % n if n > 1 else ""))
        try:
            fd = os.open(path, flags, 0o600)
        except FileExistsError:
            continue
        try:
            with os.fdopen(fd, "w", encoding="utf-8", errors="backslashreplace", newline="") as fh:
                fh.write(text)
        except OSError:
            with contextlib.suppress(OSError):
                os.remove(path)
            raise
        return path
    raise FileExistsError("no free name for %s in %s" % (stem, directory))


def prune(directory: str, new: str) -> None:
    """Delete the oldest spilled files beyond ``KEEP_FILES`` in ``directory``. Only the names this module writes count,
    and their leading time makes the name order the age order. ``new`` is never deleted, and a file another server
    removed first is no error."""
    try:
        names = sorted(n for n in os.listdir(directory) if _SPILLED.fullmatch(n))
    except OSError:
        return
    excess = len(names) - KEEP_FILES
    for name in names:
        if excess <= 0:
            return
        path = os.path.join(directory, name)
        if path != new:
            with contextlib.suppress(OSError):
                os.remove(path)
            excess -= 1


def cut(lines: list[str], limit: int, room: int) -> tuple[int, int]:
    """How many first and last lines a reply keeps when ``room`` of its ``limit`` characters goes to the marker. The
    tail goes first, up to ``TAIL_LINES`` within a quarter of the limit, and its last line (``next:`` in Pyokka's
    answers) is kept past that quarter when it fits half of the rest, so a small limit still shows it. The head then
    takes up to ``HEAD_LINES`` within what is left. A line too long for its budget ends that side, and at least one
    line is always left out."""
    budget = limit - room
    tail = used = 0
    while tail < min(TAIL_LINES, len(lines) - 1):
        cost = len(lines[-1 - tail]) + 1
        if used + cost > (min(limit // 4, budget) if tail else budget // 2):
            break
        tail += 1
        used += cost
    head, left = 0, budget - used
    while head < min(HEAD_LINES, len(lines) - tail - 1):
        cost = len(lines[head]) + 1
        if cost > left:
            break
        head += 1
        left -= cost
    return head, tail


def marker(left: int, first: int, last: int, total: int, chars: int, path: str) -> list[str]:
    """The two lines that stand for lines ``first`` to ``last`` of the file: how many, its path and size, the read."""
    return [
        "[… %d of %d lines left out (%d to %d); the whole result, %s characters, is in %s]" % (left, total, first, last, format(chars, ","), path),
        "[read them with sed -n '%d,%dp' %s or your file tool]" % (first, last, shlex.quote(path)),
    ]


def text_reply(text: str, lines: list[str], limit: int, path: str) -> str:
    """The head, the marker and the tail. The marker's room is an eighth of the limit, or the marker's own length when
    a long path or a small limit makes it longer, so the reply stays within the limit whenever the marker does."""
    n = len(lines)
    room = max(limit // 8, len("\n".join(marker(n, n, n, n, len(text), path))) + 1)
    head, tail = cut(lines, limit, room)
    first, last = head + 1, n - tail
    shown = lines[:head] + marker(last - first + 1, first, last, n, len(text), path) + lines[last:]
    return "\n".join(shown) + ("\n" if text.endswith("\n") else "")


def json_reply(text: str, lines: list[str], limit: int, path: str) -> str:
    """The small JSON object that stands for a spilled JSON answer: ``head`` is its first whole lines within a quarter
    of the limit (the first line cut there when it alone is longer), ``read`` the ``sed`` for the lines after them."""
    budget = limit // 4
    head = used = 0
    while head < len(lines) - 1 and used + len(lines[head]) + 1 <= budget:
        used += len(lines[head]) + 1
        head += 1
    start = "\n".join(lines[:head]) + "\n" if head else lines[0][:budget]
    reply = {
        "spilled": True, "path": path, "characters": len(text), "lines": len(lines), "head": start,
        "read": "sed -n '%d,%dp' %s or your file tool" % (head + 1, len(lines), shlex.quote(path)),
    }
    return json.dumps(reply, ensure_ascii=False, indent=1) + "\n"


def spill(text: str, name: str, arguments: Mapping[str, Any], as_json: bool = False) -> str:
    """The text a ``tools/call`` result carries. Up to ``max_chars()`` it is ``text`` itself. Past it the whole text
    goes to a new file and the reply is its head, the marker and its tail, or for a JSON answer (``as_json``, which
    the branch that produced the text decides) a small JSON object. When no directory can be written the whole text
    comes back: a text answer with one note line at its end, a JSON answer as it was, with the note in the server's
    log. Never raises: a failure prints its traceback to the log and returns ``text``, since one call must not take
    the server down."""
    try:
        limit = max_chars()
        if len(text) <= limit:
            return text
        body = text[:-1] if text.endswith("\n") else text
        lines = body.split("\n")  # sed's lines: only \n ends one, not the \x0c or   splitlines() also splits at
        stem = file_stem(name, arguments)
        tried: list[str] = []
        for directory in directories():
            try:
                path = write_new(directory, stem, text)
            except OSError:
                tried.append(directory)
                continue
            prune(directory, path)
            if as_json:
                return json_reply(text, lines, limit, path)
            return text_reply(text, lines, limit, path)
        note = "this result is %s characters, over the %s kept inline (%s), but %s could not be written, so all of it is here" % (
            format(len(text), ","), format(limit, ","), MAX_CHARS_ENV, " and ".join(tried))
        if as_json:
            print("pyokka mcp: %s" % note, file=sys.stderr)
            return text
        return "%s\n[%s]%s" % (body, note, "\n" if text.endswith("\n") else "")
    except Exception:  # noqa: BLE001 - any failure here leaves the answer as it was
        traceback.print_exc(file=sys.stderr)
        return text


__all__ = ["spill", "max_chars", "directories", "file_stem", "write_new", "prune", "cut", "MAX_CHARS", "MAX_CHARS_ENV", "HEAD_LINES", "TAIL_LINES", "KEEP_FILES"]
