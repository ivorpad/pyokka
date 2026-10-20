"""The lines a debugger answer gains when it pauses at a stop of the current review that nobody has explained yet,
and the ``Stop`` hook that keeps an agent from ending its turn there.

A review in the debugger hands the program to ``pyokka_debug``, and from then on each pause came back as a plain
debugger answer that said nothing about the review: an agent could step past every stop and explain none
(a Codex review, 2026-10-20). ``commands.dispatch`` and the shell ask ``reminder`` after each live move. It answers
only when the current review (``$PYOKKA_HOME/reviews/current``) runs in the debugger and has not ended, its debug
session is the one that paused, and the pause is at a stop neither shown nor skipped; otherwise None, so outside a
review nothing changes. It reads files only and never moves the program: the pause is the answer's own.

``pyokka hook stop`` (``hook_main``) is the same test for a Codex or Claude Code ``Stop`` hook: it reads the hook's
JSON on stdin and prints ``{"decision": "block", "reason": ...}`` when the review's debug session sits at such a
stop, and nothing otherwise, once per turn (``stop_hook_active``). It reads the pause from ``state``, which moves nothing.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .state import STATE_FILE, Review, current_dir

#: the live commands whose answer can be a new pause
MOVES = ("debug", "continue", "step", "restart")


def reminder(command: str, result: Any, source: Any) -> dict | None:
    """``{stop, of, function, file, line, next, lines}`` for a pause at an unexplained stop of the current review, else None."""
    try:
        return _reminder(command, result, source)
    except Exception:  # noqa: BLE001  a review that cannot be read never breaks a debugger answer
        return None


def _reminder(command: str, result: Any, source: Any) -> dict | None:
    if command not in MOVES or not isinstance(result, dict) or not isinstance(result.get("paused"), dict):
        return None
    paused = result["paused"]
    loc = result.get("location") if isinstance(result.get("location"), dict) else {}
    file, line = loc.get("file") or paused.get("file"), loc.get("line") or paused.get("line")
    review = _review() if file and line is not None else None
    if review is None:
        return None
    from .debugger import review_descriptor

    mine, theirs = review_descriptor(review), getattr(source, "descriptor", None)
    if not (isinstance(mine, dict) and isinstance(theirs, dict) and mine.get("socket") and mine.get("socket") == theirs.get("socket")):
        return None
    item = _unexplained(review, file, line)
    return _info(review, item, file, int(line)) if item else None


def stop_hook(payload: Any) -> dict | None:
    """The ``Stop`` hook's block decision when the agent ends its turn at an unexplained stop of the current review, else None."""
    if not isinstance(payload, dict) or payload.get("stop_hook_active"):
        return None  # sent back once this turn already: let it stop
    review = _review()
    if review is None:
        return None
    from .debugger import connect, current_pause

    live = connect(review)
    try:
        pause = current_pause(live)
    finally:
        live.close()
    if not pause or pause.get("finished") is not None or not pause.get("file") or pause.get("line") is None:
        return None
    item = _unexplained(review, pause["file"], pause["line"])
    if item is None:
        return None
    info = _info(review, item, pause["file"], int(pause["line"]))
    return {"decision": "block", "reason": "You are ending your turn at a Pyokka review stop. " + " ".join(info["lines"])}


def hook_main(event: str, stdin: Any, stdout: Any) -> int:
    """``pyokka hook stop``: the hook's JSON in on stdin, a block decision or nothing out on stdout; always exit 0."""
    try:
        payload = json.loads(stdin.read() or "{}")
        out = stop_hook(payload) if event == "stop" else None
    except Exception:  # noqa: BLE001  a hook never breaks the agent's turn
        return 0
    if out:
        stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    return 0


# -- the pieces both share ------------------------------------------------------------------------------------------

def _review() -> Review | None:
    """The current review when it runs in the debugger and has not ended."""
    directory = current_dir()
    if not directory or not os.path.isfile(os.path.join(directory, STATE_FILE)):
        return None
    review = Review.load(directory)
    if review.data.get("mode") != "debugger" or isinstance(review.data.get("ended"), dict):
        return None
    return review


def _unexplained(review: Review, file: Any, line: Any) -> dict | None:
    """The stop the pause at ``file:line`` belongs to, when it is neither shown nor skipped."""
    from .debugger import item_at

    item = item_at(review, str(file), int(line))
    return item if item is not None and int(item["n"]) in review.remaining() else None


def _info(review: Review, item: dict, file: Any, line: int) -> dict:
    n, function = int(item["n"]), str(item.get("function") or "")
    go_on = " --go-on" if review.waiting is not None else ""
    stop = 'pyokka review stop %d --say TEXT%s (MCP pyokka_review {"action": "stop", "n": %d, "say": TEXT%s})' % (n, go_on, n, ', "go_on": true' if go_on else "")
    skip = 'pyokka review skip %d --why TEXT (MCP pyokka_review {"action": "skip", "n": %d, "why": TEXT})' % (n, n)
    where = "%s%s:%s" % (("`%s` at " % function) if function else "", os.path.basename(str(item.get("file") or file)), line)
    lines = ["review: this is stop %d of %d, %s, and nobody has explained it yet. Say what the changed lines do with a value of the frame and why it "
             "matters, write the same words in your message, then wait for the person. When nothing here is worth a word, skip it with the "
             "reason and continue." % (n, len(review.stops), where)]
    if go_on:
        lines.append("Pass --go-on (go_on: true) only if the person said next since stop %d." % review.waiting)
    lines.append("next: %s, or %s" % (stop, skip))
    return {"stop": n, "of": len(review.stops), "function": function, "file": item.get("file"), "line": line, "next": lines[-1][len("next: "):], "lines": lines}


__all__ = ["MOVES", "hook_main", "reminder", "stop_hook"]
