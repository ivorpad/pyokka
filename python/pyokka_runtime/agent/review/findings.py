"""``finding add``: what the two concluded, recorded with the head step that shows it and a reproduction.

The step must be a step of ``head.json`` in the finding's file, within three lines of its line or in
the same function. A changed line head never ran has no step: it is filed without one, with a try
that reaches it as the reproduction, and the report says "never ran in head; reproduced by tN". A
reproduction is a try id, or a shell command run from the repo root whose output must contain
``--expect``; the same file, line and title replace the earlier finding.
"""

from __future__ import annotations

import os
from importlib import import_module
from typing import Any

from ..context import _step_location
from ..source import AgentError, SavedRun
from .actions import TRY_ID, _function_at, head_run, run_command, tail, values_at
from .render import finding_lines, try_lines
from .state import FINDING_ADD, SEVERITIES, Review, git, next_id, now, result


# -- finding -----------------------------------------------------------------------------------------------------------

def _check_step_place(review: Review, run_: SavedRun, at: dict, file: str, line: int, step: int) -> None:
    path = str(at.get("file") or "")
    shown = run_.display_path(path)
    if not (os.path.basename(path) == os.path.basename(file) or shown == file or path.endswith(os.sep + file)):
        raise review.refuse("step %d is in %s, not in %s" % (step, shown, file), ["`pyokka steps %s --line %s:%d` lists the steps on that line" % (run_.path, file, line)], FINDING_ADD)
    if abs(int(at.get("line") or 0) - line) <= 3:
        return
    fid = int(at.get("fileId", -1))
    source = "\n".join(run_.source_lines(fid)) if fid >= 0 else ""
    here, there = _function_at(source, int(at["line"])), _function_at(source, line)
    if here is not None and here == there:
        return
    on = run_.trace.steps_on_line(fid, line) if fid >= 0 else []
    raise review.refuse("step %d is at %s:%s (%s), not within 3 lines of %s:%d nor in the same function" % (step, shown, at.get("line"), at.get("function"), file, line), ["steps on %s:%d: %s" % (file, line, ", ".join("#%d" % s for s in on[:8]) or "none ran")], FINDING_ADD)


def _same_file(given: str, candidate: Any) -> bool:
    c = str(candidate or "")
    if not c:
        return False
    return c == given or c.endswith("/" + given) or given.endswith("/" + c) or ("/" not in c and "/" not in given and os.path.basename(c) == os.path.basename(given))


def never_ran(review: Review, run_: SavedRun, file: str, line: int) -> bool:
    """Whether ``file:line`` is a changed line head never ran: in the plan's unreached list, or a line the
    coverage marks not run inside the PR's changed lines."""
    from ..coverage import coverage_report
    from .render import unreached_span

    for u in review.plan.get("unreached") or []:
        if isinstance(u, dict) and _same_file(file, u.get("file")):
            lo, hi = unreached_span(u)
            if lo is not None and lo <= line <= (hi if hi is not None else lo):
                return True
    try:
        cov = coverage_report(run_)
    except AgentError:
        return False
    if not any(_same_file(file, c.get("file")) and line in (c.get("notRun") or []) for c in cov.get("files") or []):
        return False
    try:
        changed = import_module(".edges", __package__).changed_lines(git(review.repo, "diff", str(review.data.get("base")), "--no-ext-diff", "--no-color"))
    except Exception:  # noqa: BLE001  no edges module, no git: the plan's own list decided above
        return False
    return any(_same_file(file, name) and line in lines for name, lines in changed.items())


def _check_unreached_place(review: Review, run_: SavedRun, file: str, line: int, repro: str) -> None:
    """A finding without a step: only on a changed line head never ran, and only with a try as its reproduction."""
    if not never_ran(review, run_, file, line):
        on: list[int] = []
        try:
            on = run_.trace.steps_on_line(int(run_.resolve_file(file)["fileId"]), line)
        except AgentError:
            pass
        ran = (" (steps %s)" % ", ".join("#%d" % s for s in on[:6])) if on else ""
        raise review.refuse("finding add needs --step N, the head step that shows it; %s:%d ran in head%s" % (file, line, ran), ["only a changed line that never ran in head (the plan's unreached lines) may be filed without a step, with a try as its reproduction"], FINDING_ADD)
    if not TRY_ID.match(repro):
        raise review.refuse("a finding on a line that never ran in head needs a try as its reproduction (--repro tN)", ["`review try --code FILE` can call the function and reach %s:%d; a command is not tied to that line" % (file, line)], FINDING_ADD)


def _reproduction(review: Review, repro: str, expect: Any) -> dict:
    if TRY_ID.match(repro):
        t = next((t for t in review.tries if t.get("id") == repro), None)
        if t is None:
            raise review.refuse("no try %s in this review" % repro, [try_lines(t)[0] for t in review.tries] or ["no tries yet: `review try --expr EXPR` runs one"], FINDING_ADD)
        return {"kind": "try", "id": repro, "result": t.get("result"), "error": t.get("error"), "expect": str(expect) if expect else None}
    if not expect:
        raise review.refuse("a command reproduction needs --expect TEXT, the output it must contain", ["--repro %r is run from the repo root as a shell command" % repro], FINDING_ADD)
    out, code = run_command(repro, review.repo)
    if str(expect) not in out:
        raise review.refuse("the command's output does not contain %r" % str(expect), ["command: %s (exit %s)" % (repro, code), "output (tail):", *("  " + l for l in tail(out).split("\n"))], FINDING_ADD)
    return {"kind": "command", "command": repro, "expect": str(expect), "exit": code, "output_tail": tail(out)}


def finding(review: Review, f: dict) -> dict:
    what = str(f.get("what") or "add")
    if what != "add":
        raise review.refuse("finding %s is not an action; `finding add` records one" % what, next_command=FINDING_ADD)
    wanted = (("--file", "file"), ("--line", "line"), ("--severity", "severity"), ("--title", "title"), ("--repro", "repro"), ("--fix", "fix"))
    missing = [flag for flag, key in wanted if f.get(key) in (None, "")]
    if f.get("step") in (None, "") and not (f.get("file") and f.get("line")):
        missing.append("--step")
    if missing:
        raise review.refuse("finding add needs %s" % ", ".join(missing), ["a finding is a place (--file F --line L), a severity, a title, the step of head.json that shows it (--step N; a line that never ran in head takes a try instead), a reproduction (--repro: a try id, or a command with --expect) and the fix in words"], FINDING_ADD)
    severity = str(f["severity"])
    if severity not in SEVERITIES:
        raise review.refuse("unknown severity %r" % severity, ["one of " + ", ".join(SEVERITIES)], FINDING_ADD)
    try:
        line = int(f["line"])
        step = int(f["step"]) if f.get("step") not in (None, "") else None
    except (TypeError, ValueError):
        raise review.refuse("--line and --step want numbers", next_command=FINDING_ADD) from None
    run_ = head_run(review)
    file = str(f["file"])
    repro_text = str(f["repro"]).strip()
    at: dict | None = None
    if step is None:
        _check_unreached_place(review, run_, file, line, repro_text)
    else:
        step = run_.check_step(step)
        at = _step_location(run_, step)
        _check_step_place(review, run_, at, file, line, step)
    repro = _reproduction(review, repro_text, f.get("expect"))
    title = str(f["title"])
    same = next((x for x in review.findings if x.get("file") == file and x.get("line") == line and x.get("title") == title), None)
    entry = {
        "id": same["id"] if same else next_id(review.findings, "f"),
        "file": file, "line": line, "severity": severity, "title": title, "step": step, "unreached": step is None,
        "step_at": {"file": run_.display_path(at["file"]), "line": at["line"], "function": at["function"]} if at else None,
        "values": [{"name": k, "text": v} for k, v in values_at(run_, step)][:12] if step is not None else [],
        "repro": repro, "expect": str(f["expect"]) if f.get("expect") else None, "fix": str(f["fix"]), "at": now(),
    }
    if same:
        review.findings[review.findings.index(same)] = entry
    else:
        review.findings.append(entry)
    review.reopen()
    review.save()
    lines = [*finding_lines(entry)]
    if same:
        lines.append("  (replaces the earlier %s with the same place and title)" % entry["id"])
    return result(review, lines, finding=entry)


__all__ = ["finding", "never_ran"]
