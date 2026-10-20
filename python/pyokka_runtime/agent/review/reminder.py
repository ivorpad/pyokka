"""The lines a debugger answer gains when it pauses at a stop of the current review that nobody has explained yet.

A review in the debugger hands the program to ``pyokka_debug``, and from then on each pause came back as a plain
debugger answer that said nothing about the review: an agent could step past every stop and explain none
(a Codex review, 2026-10-20). ``commands.dispatch`` and the shell ask ``reminder`` after each live move. It answers
only when the current review (``$PYOKKA_HOME/reviews/current``) runs in the debugger and has not ended, its debug
session is the one that paused, and the pause is at a stop neither shown nor skipped; otherwise None, so outside a
review nothing changes. It reads files only and never moves the program: the pause is the answer's own.
"""

from __future__ import annotations

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
    directory = current_dir()
    if not file or line is None or not directory or not os.path.isfile(os.path.join(directory, STATE_FILE)):
        return None
    review = Review.load(directory)
    if review.data.get("mode") != "debugger" or isinstance(review.data.get("ended"), dict):
        return None
    from .debugger import item_at, review_descriptor

    mine, theirs = review_descriptor(review), getattr(source, "descriptor", None)
    if not (isinstance(mine, dict) and isinstance(theirs, dict) and mine.get("socket") and mine.get("socket") == theirs.get("socket")):
        return None
    item = item_at(review, str(file), int(line))
    if item is None or int(item["n"]) not in review.remaining():
        return None
    n, function = int(item["n"]), str(item.get("function") or "")
    go_on = ' --go-on' if review.waiting is not None else ""
    stop = 'pyokka review stop %d --say TEXT%s (MCP pyokka_review {"action": "stop", "n": %d, "say": TEXT%s})' % (n, go_on, n, ', "go_on": true' if go_on else "")
    skip = 'pyokka review skip %d --why TEXT (MCP pyokka_review {"action": "skip", "n": %d, "why": TEXT})' % (n, n)
    where = "%s%s:%s" % (("`%s` at " % function) if function else "", os.path.basename(str(item.get("file") or file)), line)
    lines = ["review: this is stop %d of %d, %s, and nobody has explained it yet. Say what the changed lines do with a value of the frame and why it "
             "matters, write the same words in your message, then wait for the person. When nothing here is worth a word, skip it with the "
             "reason and continue." % (n, len(review.stops), where)]
    if go_on:
        lines.append("Pass --go-on (go_on: true) only if the person said next since stop %d." % review.waiting)
    lines.append("next: %s, or %s" % (stop, skip))
    return {"stop": n, "of": len(review.stops), "function": function, "file": item.get("file"), "line": int(line), "next": lines[-1][len("next: "):], "lines": lines}


__all__ = ["MOVES", "reminder"]
