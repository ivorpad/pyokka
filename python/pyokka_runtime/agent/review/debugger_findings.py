"""``finding add`` when the debugger runs the review: the place is a recorded pause near the line, or a step of the debugger's recording.

The rules are a full review's (``findings.py``): within three lines of the finding's line or in the same
function, a reproduction that is a try id or a command with ``--expect``, the same file, line and title
replacing the earlier finding. A changed line the run never paused at, once the program ended, is filed
without a place, with a try as its reproduction, as an unreached line is in a full review.
"""

from __future__ import annotations

import os
from typing import Any

from ..source import AgentError
from .actions import TRY_ID, _function_at
from .debugger import abs_file, connect, recorded, run_over
from .render import finding_lines, unreached_span
from .state import FINDING_ADD, SEVERITIES, Review, next_id, now, result


def _same_file(given: str, candidate: Any) -> bool:
    c = str(candidate or "")
    return bool(c) and (c == given or c.endswith("/" + given) or given.endswith("/" + c) or os.path.basename(c) == os.path.basename(given))


def _source_function(review: Review, file: str, line: int) -> str | None:
    try:
        with open(abs_file(review, file), encoding="utf-8", errors="replace") as fh:
            return _function_at(fh.read(), line)
    except OSError:
        return None


def _pause_near(review: Review, file: str, line: int) -> dict | None:
    """The last pause recorded (``stop``) in ``file`` within three lines of ``line`` or in the same function."""
    fn = _source_function(review, file, line)
    for entry in reversed(review.conversation):
        if entry.get("kind") != "stop" or entry.get("line") is None or not _same_file(file, entry.get("file")):
            continue
        at = int(entry["line"])
        if abs(at - line) <= 3 or (fn is not None and _source_function(review, file, at) == fn):
            return entry
    return None


def _never_paused(review: Review, file: str, line: int) -> bool:
    """A changed line the run never paused at: the program is over and the line is in an item that was never recorded."""
    if not run_over(review):
        return False
    for u in review.plan.get("unreached") or []:
        if isinstance(u, dict) and _same_file(file, u.get("file")):
            lo, hi = unreached_span(u)
            if lo is not None and lo <= line <= (hi if hi is not None else lo):
                return True
    return False


def _recorded_step_place(review: Review, file: str, line: int, step: int) -> tuple[dict, list[list]]:
    if not recorded(review):
        raise review.refuse("--step needs the debugger's recording, and this review has none (a test runs through its runner)", ["leave --step out: a pause recorded with `review stop` within 3 lines of %s:%d is the finding's place" % (file, line)], FINDING_ADD)
    live = connect(review)
    try:
        try:
            ctx = live.context(step=step, scope=True)
        except AgentError as exc:
            raise review.refuse("no step %d in the recording: %s" % (step, exc.message), None, FINDING_ADD) from None
    finally:
        live.close()
    loc = ctx.get("location") if isinstance(ctx.get("location"), dict) else {}
    at_line = int(loc.get("line") or 0)
    if not _same_file(file, loc.get("file")):
        raise review.refuse("step %d is in %s, not in %s" % (step, loc.get("file"), file), None, FINDING_ADD)
    if abs(at_line - line) > 3 and (_source_function(review, file, at_line) is None or _source_function(review, file, at_line) != _source_function(review, file, line)):
        raise review.refuse("step %d is at %s:%d, not within 3 lines of %s:%d nor in the same function" % (step, os.path.basename(str(loc.get("file"))), at_line, file, line), None, FINDING_ADD)
    place = {"file": file, "line": at_line, "function": str(loc.get("function") or "")}
    values = [[str(v.get("context") or v.get("name") or "value"), str(v["text"])] for v in ctx.get("values") or [] if isinstance(v, dict) and v.get("text") is not None]
    return place, values


def finding_in_debugger(review: Review, f: dict) -> dict:
    from .findings import _reproduction

    wanted = (("--file", "file"), ("--line", "line"), ("--severity", "severity"), ("--title", "title"), ("--repro", "repro"), ("--fix", "fix"))
    missing = [flag for flag, key in wanted if f.get(key) in (None, "")]
    if missing:
        raise review.refuse("finding add needs %s" % ", ".join(missing), ["a finding is a place (--file F --line L), a severity, a title, a pause recorded with `review stop` near L (or --step N of the recording), a reproduction (--repro: a try id, or a command with --expect) and the fix in words"], FINDING_ADD)
    severity = str(f["severity"])
    if severity not in SEVERITIES:
        raise review.refuse("unknown severity %r" % severity, ["one of " + ", ".join(SEVERITIES)], FINDING_ADD)
    try:
        line = int(f["line"])
        step = int(f["step"]) if f.get("step") not in (None, "") else None
    except (TypeError, ValueError):
        raise review.refuse("--line and --step want numbers", next_command=FINDING_ADD) from None
    file = str(f["file"])
    repro_text = str(f["repro"]).strip()
    place: dict | None = None
    values: list[list] = []
    unreached = False
    if step is not None:
        place, values = _recorded_step_place(review, file, line, step)
    else:
        entry = _pause_near(review, file, line)
        if entry is not None:
            step = entry.get("step") if isinstance(entry.get("step"), int) else None
            place = {"file": file, "line": int(entry["line"]), "function": _source_function(review, file, int(entry["line"])) or ""}
            values = [list(v) for v in entry.get("values") or [] if isinstance(v, (list, tuple)) and len(v) == 2]
        elif _never_paused(review, file, line):
            if not TRY_ID.match(repro_text):
                raise review.refuse("a finding on a line the run never paused at needs a try as its reproduction (--repro tN)", ["`review try --code FILE` can call the function and reach %s:%d" % (file, line)], FINDING_ADD)
            unreached = True
        else:
            raise review.refuse("no pause was recorded within 3 lines of %s:%d" % (file, line),
                                ["run to it in the debugger and record the pause with `review stop --say TEXT`, then add the finding", "a changed line the run never paused at (once the program ended) takes a try as its reproduction"], FINDING_ADD)
    repro = _reproduction(review, repro_text, f.get("expect"))
    title = str(f["title"])
    same = next((x for x in review.findings if x.get("file") == file and x.get("line") == line and x.get("title") == title), None)
    entry_ = {
        "id": same["id"] if same else next_id(review.findings, "f"),
        "file": file, "line": line, "severity": severity, "title": title, "step": step, "unreached": unreached,
        "pause": {"file": place["file"], "line": place["line"], "function": place.get("function")} if place else None,
        "step_at": place, "values": [{"name": k, "text": v} for k, v in values][:12],
        "repro": repro, "expect": str(f["expect"]) if f.get("expect") else None, "fix": str(f["fix"]), "at": now(),
    }
    if same:
        review.findings[review.findings.index(same)] = entry_
    else:
        review.findings.append(entry_)
    review.reopen()
    review.save()
    lines = [*finding_lines(entry_)]
    if same:
        lines.append("  (replaces the earlier %s with the same place and title)" % entry_["id"])
    return result(review, lines, finding=entry_)


__all__ = ["finding_in_debugger"]
