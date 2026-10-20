"""The review's debug session as the agent sees it: its handle, and the breakpoints the review leaves behind.

``start`` in the debugger prints ``session: <descriptor path>``, and ``skip``, ``view`` and ``state`` print it again
while the session is published: the file ``pyokka_debug`` takes as ``session``, found the way ``connect`` finds it, so
the agent drives the session the review reads. A Codex smoke test (2026-10-19) called ``pyokka_session`` twice to learn
it before its first stop. ``close`` and ``report`` take the review's breakpoints out of VS Code while the session
answers, since VS Code keeps every breakpoint the review added after the review is over; a session that is gone is
left alone, silently. Both go through the ``debugger`` module's names at call time, which the tests replace.
"""

from __future__ import annotations

from ..source import AgentError
from . import debugger
from .state import Review


def session_lines(review: Review) -> list[str]:
    """``["session: PATH"]`` while the review's debug session is published; none for a recorded review or a session that is gone."""
    if review.data.get("mode") != "debugger":
        return []
    descriptor = debugger.review_descriptor(review)
    path = (descriptor or {}).get("descriptor")
    return ["session: %s" % path] if path else []


def remove_breakpoints(review: Review) -> list[str]:
    """``close`` and ``report``: every agenda item's breakpoint out of VS Code, whether shown, skipped or remaining, while the session answers.

    A shown item counts too: a review whose ``stop`` left its item's breakpoint set (any review before 2026-10-20), or
    one interrupted between a pause and its ``stop``, still has it in VS Code. An item of kind ``pause`` (an uncaught
    exception, a breakpoint of the person's own) keeps its breakpoint: the review never set it. Removing one that is no
    longer there is a no-op in the extension, so an item ``skip`` already cleared costs nothing. One line, or none when
    the session is gone.
    """
    if review.data.get("mode") != "debugger":
        return []
    bps = debugger.breakpoints_for(review, [s for s in review.stops if s.get("kind") == "change"])
    if not bps:
        return []
    try:
        live = debugger.connect(review)
    except AgentError:
        return []
    try:
        live.breakpoints(remove=bps)
    except AgentError:
        return []
    finally:
        live.close()
    return ["breakpoints: removed the review's %d from VS Code, one per item on the agenda; the debug session stays open" % len(bps)]


__all__ = ["remove_breakpoints", "session_lines"]
