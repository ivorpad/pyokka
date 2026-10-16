"""``review fix`` and ``review report``.

``fix`` applies a unified diff to a fresh copy of head (``DIR/fixed``), runs the tests there, records
``fixed/ENTRY`` and compares it with head the way ``pyokka diff`` does, then checks each finding's
``NAME=VALUE`` expectation the way ``verify`` does. ``report`` refuses when the tree changed since
``start``, when a finding lacks a reproduction, or when a reproduction no longer reproduces, then
writes the review as markdown.
"""

from __future__ import annotations

import json
import os
import shutil
from typing import Any

from ..diff import Side, diff_sides, render_diff
from ..render import _one_line
from ..source import SavedRun
from ..workflows import _check
from .view import close_view
from .actions import _port, run_command, run_try, tail
from .patching import PatchError, apply_patch
from .render import conversation_entry, edge_line, finding_place, repro_text, unreached_line, unreached_span
from .state import FINDING_ADD, SEVERITIES, Review, inside, now, result, tree_hash

IGNORE = shutil.ignore_patterns(".git", ".pyokka", "__pycache__", ".venv", "node_modules", ".pytest_cache", ".mypy_cache", "*.pyc")
DIFF_LINES = 30
TESTS_TIMEOUT = 600


# -- fix ---------------------------------------------------------------------------------------------------------------

def fix(review: Review, f: dict) -> dict:
    if not review.findings:
        raise review.refuse("nothing to fix yet: no finding", ["a fix answers a finding; add one first"], FINDING_ADD)
    patch_path = f.get("patch")
    if not patch_path:
        raise review.refuse("fix needs --patch FILE.diff, a unified diff against head", next_command="review fix --patch FILE.diff")
    patch_path = os.path.abspath(os.path.expanduser(str(patch_path)))
    try:
        with open(patch_path, "r", encoding="utf-8", errors="replace") as fh:
            patch_text = fh.read()
    except OSError as exc:
        raise review.refuse("cannot read %s: %s" % (patch_path, exc.strerror or exc), next_command="review fix --patch FILE.diff") from None
    fixed = review.path("fixed")
    if os.path.lexists(fixed):
        shutil.rmtree(fixed)
    shutil.copytree(review.repo, fixed, ignore=IGNORE, symlinks=True)
    try:
        changed = apply_patch(patch_text, fixed)
    except PatchError as exc:
        shutil.rmtree(fixed, ignore_errors=True)
        raise review.refuse("the patch does not apply to head: %s" % exc, ["paths lose one leading component (a/, b/), and every context line must match the file in head"], "review fix --patch FILE.diff") from None
    tests = str(f.get("tests") or "").strip() or None
    tests_result = None
    if tests:
        out, code = run_command(tests, fixed, timeout=TESTS_TIMEOUT)
        tests_result = {"command": tests, "exit": code, "output_tail": tail(out)}
    fixed_json = review.path("fixed.json")
    _record_fixed(review, fixed, fixed_json)
    head, after = SavedRun(review.path("head.json")), SavedRun(fixed_json)
    comparison = diff_sides(Side("a", "head.json", head), Side("b", "fixed.json", after), limit=100)
    checks = []
    for fd in review.findings:
        exp = fd.get("expect")
        if isinstance(exp, str) and "=" in exp and exp.partition("=")[0].strip():
            name, _, value = exp.partition("=")
            checks.append({"finding": fd["id"], **_check(after, name.strip(), value)})
    review.data["fix"] = {
        "patch": patch_path, "files": changed, "tests": tests_result, "fixed_json": fixed_json,
        "diff": {"total": comparison["total"], "matching": comparison["matching"], "a": comparison["a"], "b": comparison["b"], "firstDifference": comparison.get("firstDifference")},
        "checks": checks, "at": now(),
    }
    review.reopen()
    review.save()
    lines = ["patch %s applied to %s: %d file%s (%s)" % (patch_path, fixed, len(changed), "" if len(changed) == 1 else "s", ", ".join(changed))]
    if tests_result:
        lines.append("tests: %s → exit %s%s" % (tests, tests_result["exit"], " (passed)" if tests_result["exit"] == 0 else ""))
        lines.extend("  " + l for l in tests_result["output_tail"].split("\n") if l.strip())
    lines.append("fixed/%s recorded to %s: %s steps, exit %s" % (review.data.get("entry"), fixed_json, comparison["b"]["count"], comparison["b"]["exitCode"]))
    lines.append("head → fixed:")
    lines.extend("  " + l for l in render_diff(comparison, None, None)[:DIFF_LINES])
    lines.extend(check_line(c) for c in checks)
    if not checks:
        lines.append("no finding has a NAME=VALUE --expect, so no value is checked; the diff above is the evidence")
    return result(review, lines, fix=review.data["fix"])


def check_line(c: dict) -> str:
    """One expectation as ``verify`` prints it: ``PASS total = 22 at #40 (expected 22)``."""
    where_ = " at #%s" % c["step"] if c.get("step") is not None else ""
    actual = _one_line(c["actual"], 80) if c.get("actual") is not None else "(no recorded value)"
    reason = ("; " + c["reason"]) if c.get("reason") else ""
    return "%s %s = %s%s (expected %s)%s  [%s]" % ("PASS" if c["passed"] else "FAIL", c["name"], actual, where_, _one_line(c["expected"], 80), reason, c.get("finding"))


def _record_fixed(review: Review, fixed: str, out: str) -> None:
    from ..interpreter import choose, probe
    from ..save import save_run
    from ..source import AgentError
    from .start import test_of

    entry = os.path.join(fixed, str(review.data.get("entry")))
    try:
        interp = probe(choose(entry, review.data.get("python") or None))
        save_run(entry, out, argv=list(review.data.get("argv") or []), python=interp, cwd=fixed, test=test_of(review.data.get("test"), str(review.data.get("entry"))), record_locals=True)
    except (RuntimeError, OSError, AgentError) as exc:
        raise review.refuse("recording fixed/%s failed: %s" % (review.data.get("entry"), getattr(exc, "message", exc)), next_command="review fix --patch FILE.diff") from None


# -- report ------------------------------------------------------------------------------------------------------------

def reproduce(review: Review, fd: dict) -> tuple[bool, str]:
    """Run a finding's reproduction again: ``(still reproduces, what happened)``."""
    repro = fd.get("repro") if isinstance(fd.get("repro"), dict) else {}
    if repro.get("kind") == "command":
        out, code = run_command(str(repro.get("command")), review.repo)
        ok = str(repro.get("expect")) in out
        return ok, "command `%s` (exit %s) %s %r" % (repro.get("command"), code, "prints" if ok else "no longer prints", repro.get("expect"))
    tid = str(repro.get("id") or "")
    t = next((t for t in review.tries if t.get("id") == tid), None)
    if t is None:
        try:
            with open(review.path("tries", tid + ".json"), "r", encoding="utf-8") as fh:
                t = json.load(fh)
        except (OSError, ValueError):
            return False, "try %s is gone" % tid
    # a try reproduces when it gives what it gave: the same result and the same error (the output when it had neither);
    # a finding's NAME=VALUE expectation is about the fixed run (`fix` checks it as `verify` does), not about the try
    again = run_try(str(t.get("code") or ""), t.get("inputs"), t.get("mocks"), review.repo, _port({}))
    first = lambda e: str(e or "").split("\n")[0]  # noqa: E731
    same_result = str(again.get("result")) == str(t.get("result"))
    same_error = first(again.get("error")) == first(t.get("error"))
    if t.get("result") is None and t.get("error") is None:
        same_result = str(again.get("output") or "") == str(t.get("output") or "")
    ok = same_result and same_error
    return ok, "try %s run again %s (result %s, error %s)" % (tid, "gives the same" if ok else "differs", _one_line(again.get("result"), 60), _one_line(first(again.get("error")), 60) or "none")


def report(review: Review, f: dict) -> dict:
    current = tree_hash(review.repo)
    recorded = str(review.data.get("tree_hash") or "")
    if current != recorded:
        raise review.refuse("the tree at %s changed since start (%s → %s): the review no longer describes it" % (review.repo, recorded[:12], current[:12]), ["start again on the current tree, or put it back (git stash, git checkout) and report"], "review start --base %s" % (review.data.get("base_ref") or review.data.get("base")))
    without = [str(fd.get("id")) for fd in review.findings if not isinstance(fd.get("repro"), dict)]
    if without:
        raise review.refuse("finding %s has no reproduction" % ", ".join(without), ["every finding is reported with the reproduction that showed it"], FINDING_ADD)
    stale: list[str] = []
    for fd in review.findings:
        ok, note = reproduce(review, fd)
        fd["reproduced_at_report"] = {"ok": ok, "note": note, "at": now()}
        if not ok:
            stale.append("%s: %s" % (fd.get("id"), note))
    review.save()
    if stale:
        raise review.refuse("a reproduction no longer reproduces", [*stale, "a finding added again with the same file, line and title replaces it, with a reproduction that holds"], FINDING_ADD)
    md = markdown(review)
    out = f.get("out")
    path = os.path.abspath(os.path.expanduser(str(out))) if out else review.path("report.md")
    if inside(path, review.repo):
        raise review.refuse("--out %s is inside the repository" % path, ["nothing is written inside the repository under review"], "review report --out FILE")
    page = tour = None
    if f.get("page"):
        from .page import page_path, write_page

        page_path(review, f["page"])  # refused before anything is written
    if f.get("tour"):
        from .story import tour_path, write_tour

        tour_path(review, f["tour"])
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(md)
    review.data["report"] = {"path": path, "at": now()}
    review.phase = "reported"
    if f.get("page"):
        page = write_page(review, f["page"])  # the same review as a code-history page, for render-code-history.cjs
    if f.get("tour"):
        tour = write_tour(review, f["tour"])  # and as a tour of head.json, the stops as its picks, for render-tour.cjs
    closed = close_view(review.data)
    review.save()
    extra: dict = {}
    if page:
        extra.update(page=page["path"], pageWarnings=page["warnings"])
    if tour:
        extra.update(tour=tour["path"], tourWarnings=tour["warnings"])
    return result(review, [*md.rstrip("\n").split("\n"), "", "wrote %s" % path, *(page["lines"] if page else []), *(tour["lines"] if tour else []), *([closed] if closed else [])], report=path, markdown=md, **extra)


def _fix_status(review: Review, fd: dict) -> str:
    fx = review.data.get("fix")
    if not isinstance(fx, dict):
        return "no fix applied"
    mine = [c for c in fx.get("checks") or [] if c.get("finding") == fd.get("id")]
    if mine:
        return "; ".join(check_line(c).rsplit("  [", 1)[0] for c in mine)
    tests = fx.get("tests")
    return "patch applied to %d file%s%s" % (len(fx.get("files") or []), "" if len(fx.get("files") or []) == 1 else "s", ("; tests exit %s" % tests.get("exit")) if isinstance(tests, dict) else "; no tests run")


def markdown(review: Review) -> str:
    d = review.data
    repo = str(d.get("repo"))
    summary = d.get("summary") if isinstance(d.get("summary"), dict) else {}
    paragraph = summary.get("text") or summary.get("paragraph") or "; ".join("%s: %s" % (k, v) for k, v in summary.items()) or "(no summary)"
    out = ["# Review %s" % d.get("id"), "", "%s at %s: base %s → head %s, entry %s%s." % (os.path.basename(repo), repo, str(d.get("base"))[:7], str(d.get("head"))[:7], d.get("entry"), (" (test %s)" % d["test"]) if d.get("test") else ""), ""]
    out += ["## What we looked at together", ""]
    together = [e for e in review.conversation if isinstance(e, dict) and e.get("kind") in ("stop", "ask", "skip", "look")]
    out += ["- %s" % conversation_entry(e, review) for e in together] or ["- nothing: no stop was shown and no line asked"]
    remaining = [review.stop(n) or {"n": n} for n in review.remaining()]
    if remaining:  # the person decides when the review ends; the plan is a menu, so what stayed on it is said
        out.append("- Not looked at: %s" % ", ".join("%s. %s %s" % (s.get("n"), s.get("kind"), "%s:%s" % (s.get("file"), s.get("line"))) for s in remaining))
    out += ["", "## What the change does in behaviour", "", str(paragraph), ""]
    out += ["## Findings", ""]
    if not review.findings:
        out.append("No findings.")
    for sev in SEVERITIES:
        for fd in [x for x in review.findings if x.get("severity") == sev]:
            values = "; ".join("%s = %s" % (v.get("name"), _one_line(v.get("text"), 80)) for v in fd.get("values") or [] if isinstance(v, dict)) or "none recorded"
            again = (fd.get("reproduced_at_report") or {}).get("note")
            out += [
                "### %s: %s (%s)" % (sev, fd.get("title"), fd.get("id")), "",
                "- where: %s:%s, %s" % (fd.get("file"), fd.get("line"), finding_place(fd).replace("step #", "step #", 1) if fd.get("unreached") else finding_place(fd).replace(" ", " in ", 1) if (fd.get("step_at") or {}).get("function") else finding_place(fd)),
                "- values at the step: %s" % ("none; the line never ran in head" if fd.get("unreached") else values),
                "- reproduced: %s%s" % (repro_text(fd.get("repro")), ("; at report time: %s" % again) if again else ""),
                "- fix: %s" % fd.get("fix"),
                "- fix status: %s" % _fix_status(review, fd), "",
            ]
    tries = {t.get("id"): t for t in review.tries}
    out += ["## Edge candidates", ""]
    edges = [e for e in review.plan.get("edges") or [] if isinstance(e, dict)]
    for e in edges:
        t = tries.get(e.get("tried"))
        outcome = ("tried %s: %s" % (e.get("tried"), _one_line(t.get("error") or t.get("result") or t.get("output") or "(no result)", 120))) if t else "skipped"
        out.append("- %s — %s" % (edge_line(e).strip().rsplit("  (tried", 1)[0], outcome))
    if not edges:
        out.append("- none")
    out += ["", "## Unreached changed lines not tried", ""]
    tried_places = {(os.path.basename(str(e.get("file"))), int(e.get("line") or 0)) for e in edges if e.get("tried")}

    def tried(u: Any) -> bool:
        lo, hi = unreached_span(u)
        return isinstance(u, dict) and lo is not None and any((os.path.basename(str(u.get("file"))), line) in tried_places for line in range(lo, (hi or lo) + 1))

    listed = [unreached_line(u).strip() for u in review.plan.get("unreached") or [] if not tried(u)]
    out += ["- %s" % l for l in listed] or ["- none"]
    out += ["", "## Not verified", ""]
    not_verified = []
    skipped = [e for e in edges if not e.get("tried")]
    if skipped:
        not_verified.append("%d edge candidate%s not tried: %s" % (len(skipped), "" if len(skipped) == 1 else "s", ", ".join(str(e.get("id")) for e in skipped)))
    if listed:
        not_verified.append("%d unreached changed span%s never ran under the entry and had no try" % (len(listed), "" if len(listed) == 1 else "s"))
    if not isinstance(d.get("fix"), dict):
        not_verified.append("no fix was applied and recorded")
    elif not (d["fix"].get("checks")):
        not_verified.append("the fix was recorded but no finding gave a NAME=VALUE expectation to check")
    extra = len(review.plan.get("anomalies") or []) - len(review.stops)
    if extra > 0:
        not_verified.append("%d anomalies beyond the planned stops were not shown" % extra)
    skipped = review.skipped
    if skipped:
        not_verified.append("%d stop%s skipped at the person's request: %s" % (len(skipped), "" if len(skipped) == 1 else "s", ", ".join("%s (%s)" % (s.get("n"), s.get("why")) for s in skipped)))
    out += ["- %s" % n for n in not_verified] or ["- nothing left unverified in the plan"]
    out += ["", "Evidence: %s and %s; every value above comes from those recordings." % (review.path("base.json"), review.path("head.json")), ""]
    return "\n".join(out)


__all__ = ["fix", "report", "reproduce", "markdown", "check_line"]
