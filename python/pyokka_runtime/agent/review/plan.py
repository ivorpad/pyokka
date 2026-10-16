"""The review's plan: the sweep's anomalies as numbered stops, the unreached lines and the edge candidates beside them.

``build_plan`` takes what ``start`` already computed (the diff, both exception reports, head's
coverage, the PR's diff and text) and returns the dict ``review.json`` keeps under ``plan`` plus the
``summary`` the start output describes in one paragraph. A stop is an anomaly with a head step
(raise, type, sign, none, print, value), one per statement, in rank order; its ``values`` are the
rendered texts ``pyokka context head.json step_b`` prints, so a ``--say`` can be checked against
them, and ``locals`` the same values with their names, for a breakpoint condition.
"""

from __future__ import annotations

import os
from collections import Counter
from typing import Any

from ..context import context_slice
from ..source import AgentError, SavedRun
from .edges import changed_lines, edges
from .sweep import STOP_KINDS, Row, summary_line, sweep_rows, words_of


def values_at(run: SavedRun, step: int) -> dict:
    """``{values: [text], locals: [{name, text, step, line}]}`` at ``step``: every value of its block, as ``context --scope`` lists them."""
    ctx = context_slice(run, run.check_step(step), scope=True)
    locals_ = [{"name": v.get("context"), "text": str(v.get("text")), "step": v.get("step"), "line": v.get("line")} for v in ctx.get("values") or [] if v.get("text") is not None]
    return {"values": [v["text"] for v in locals_], "locals": locals_}


def _stop(row: Row, n: int, run: SavedRun | None) -> dict:
    vals = values_at(run, row.step_b) if run is not None and row.step_b is not None else {"values": [], "locals": []}
    return {
        "n": n,
        "kind": row.kind,
        "file": row.file,
        "line": row.line,
        "function": row.function,
        "fact": {"kind": row.kind, "name": row.name, "text": row.fact, "a": row.fact_a, "b": row.fact_b},
        "step_a": row.step_a,
        "step_b": row.step_b,
        "name": row.name,
        "text": row.text,
        "values": vals["values"],
        "locals": vals["locals"],
    }


def _unreached(row: Row) -> dict:
    """``{file, span: [lo, hi], lines: [lo..hi], start, end, text}`` for one span of changed lines that never ran."""
    lo = int(row.line or 0)
    tail = (row.lines or "").split("-")[-1]
    hi = int(tail) if tail.isdigit() else lo
    return {"file": row.file, "span": [lo, hi], "lines": list(range(lo, hi + 1)), "start": lo, "end": hi, "text": row.text}


def span_text(item: dict) -> str:
    """``44-48`` or ``8``."""
    lo, hi = int(item.get("start") or 0), int(item.get("end") or item.get("start") or 0)
    return "%d-%d" % (lo, hi) if hi > lo else str(lo)


def _summary(rows: list[Row], diff_json: dict, exceptions_a: dict, exceptions_b: dict, changed: dict[str, set[int]]) -> dict:
    m = diff_json.get("matching") or {}
    by_kind = Counter(r.kind for r in rows)
    a, b = diff_json.get("a") or {}, diff_json.get("b") or {}
    out = {
        "statements": sum(int(v) for v in m.values()),
        "same": m.get("same"),
        "edited": m.get("edited"),
        "added": m.get("added"),
        "removed": m.get("removed"),
        "differing": diff_json.get("total"),
        "steps_a": a.get("count"),
        "steps_b": b.get("count"),
        "exit_a": a.get("exitCode"),
        "exit_b": b.get("exitCode"),
        "exceptions_a": exceptions_a.get("total"),
        "exceptions_b": exceptions_b.get("total"),
        "raises": by_kind.get("raise", 0),
        "types": by_kind.get("type", 0),
        "signs": by_kind.get("sign", 0),
        "nones": by_kind.get("none", 0),
        "prints": by_kind.get("print", 0),
        "values": by_kind.get("value", 0),
        "branches": by_kind.get("branch", 0) + by_kind.get("loop", 0) + by_kind.get("decision", 0),
        "unreached": by_kind.get("unreached", 0),
        "partial": by_kind.get("partial", 0),
        "anomalies": len(rows),
        "by_kind": dict(by_kind),
        "changed_files": sorted(f for f, ls in changed.items() if ls),
        "sweep": summary_line(rows, diff_json),
    }
    out["text"] = describe(out)  # the paragraph `start` prints
    return out


def build_plan(base_run: str, head_run: str, diff_json: dict, exceptions_a: dict, exceptions_b: dict, coverage_b: dict, diff_text: str, pr_text: str | None, repo: str) -> dict:
    """``{summary, stops, unreached, edges, anomalies}`` for a review of ``repo`` (the head tree) whose runs are ``base_run`` and ``head_run``."""
    changed = changed_lines(diff_text or "")
    rows = sweep_rows(diff_json, exceptions_a, exceptions_b, coverage_b, changed, words_of(pr_text), str(head_run))
    try:
        run: SavedRun | None = SavedRun(str(head_run))
    except AgentError:
        run = None
    stops: list[dict] = []
    taken: set[tuple] = set()
    for row in rows:
        if row.kind not in STOP_KINDS or row.step_b is None:
            continue
        key = (row.file, row.line)
        if key in taken:
            continue
        taken.add(key)
        stops.append(_stop(row, len(stops) + 1, run))
    return {
        "summary": _summary(rows, diff_json, exceptions_a, exceptions_b, changed),
        "stops": stops,
        "unreached": [_unreached(r) for r in rows if r.kind == "unreached"],
        "edges": edges(diff_text or "", repo),
        "anomalies": [r.text for r in rows],
    }


def first_step_on(run: SavedRun, file: str, line: int) -> tuple[int, bool]:
    """``(step, exact)``: the first step whose statement starts on ``line``, else the innermost statement that ran around it
    (a compound header, a function's entry; never the module's whole-file statement); ``AgentError`` when nothing ran there."""
    f = run.resolve_file(file)
    fid = int(f["fileId"])
    on = run.trace.steps_on_line(fid, line)
    if on:
        return on[0], True
    best: tuple[tuple[int, int], int] | None = None
    for j in range(run.trace.count):
        loc = run.trace.location(j)
        if loc is None or loc[0] != fid or not (loc[1][0] <= line <= loc[1][2]):
            continue
        where = run.locate(run.trace.rid(j))
        if where is not None and int(where.get("localRid", -1)) == 0:
            continue  # the module's own range covers every line of the file
        key = (int(loc[1][0]), -int(loc[1][2]))
        if best is None or key > best[0]:
            best = (key, j)
    if best is not None:
        return best[1], False
    display = run.display_path(str(f["path"]))
    raise AgentError("no step on %s:%d" % (display, line), "neither the line nor a statement around it ran; `pyokka coverage %s --file %s` lists what did" % (run.path, os.path.basename(str(f["path"]))))


def ask_stop(head_run: str, file: str, line: int) -> dict:
    """An unplanned stop (``ask FILE:LINE``): the first head step on that line (else the statement that ran around it, with a ``note``), with its values."""
    run = SavedRun(str(head_run))
    step, exact = first_step_on(run, file, line)
    ctx = context_slice(run, step)
    loc = ctx.get("location") or {}
    vals = values_at(run, step)
    display = run.display_path(loc.get("file")) if loc.get("file") else file
    at = int(loc.get("line") or line)
    out = {"n": None, "kind": "ask", "file": display, "line": at, "function": str(loc.get("function") or ""), "fact": {"kind": "ask", "name": None, "text": "", "a": None, "b": None}, "step_a": None, "step_b": step, "name": None, "text": "%s:%s %s  asked  → pyokka context %s %s" % (display, at, loc.get("function") or "", head_run, step), "values": vals["values"], "locals": vals["locals"], "asked_line": int(line), "exact": exact}
    if not exact:
        out["note"] = "line %d never ran as a statement of its own; the stop is the statement around it at line %d (step %d)" % (line, at, step)
    return out


# -- text ------------------------------------------------------------------------------------------------------

def _count(n: Any, one: str, many: str | None = None) -> str:
    n = int(n or 0)
    return "%d %s" % (n, one if n == 1 else (many or one + "s"))


def describe(summary: dict) -> str:
    """One paragraph of what changed in behaviour: statement counts, raises, types, signs, prints, exit codes."""
    parts = ["%s compared (%s same, %s edited, %s added, %s removed)" % (_count(summary.get("statements"), "statement"), summary.get("same"), summary.get("edited"), summary.get("added"), summary.get("removed")), "%s did something different in head" % summary.get("differing")]
    parts.append("%s → %s steps" % (summary.get("steps_a"), summary.get("steps_b")))
    found = [_count(summary.get(k), one, many) for k, one, many in (("raises", "new raise", None), ("types", "type change", None), ("signs", "sign flip", None), ("nones", "None/nan appearing", "None/nan appearing"), ("prints", "print that differs", "prints that differ"), ("unreached", "unreached changed span", None), ("branches", "branch or loop change", None), ("values", "value change in an unnamed function", "value changes in unnamed functions")) if summary.get(k)]
    parts.append(("anomalies: " + ", ".join(found)) if found else "no anomalies")
    exit_a, exit_b = summary.get("exit_a"), summary.get("exit_b")
    parts.append("exit code %s → %s" % (exit_a, exit_b) if exit_a != exit_b else "exit code %s on both" % exit_b)
    return "; ".join(parts) + "."


def stop_line(stop: dict) -> str:
    """``1. [raise] shopkit/pricing.py:12 subtotal  TypeError: ... (caught at pricing.py:13, 1×)  b#197``."""
    steps = "  ".join(s for s in ("a#%s" % stop["step_a"] if stop.get("step_a") is not None else "", "b#%s" % stop["step_b"] if stop.get("step_b") is not None else "") if s)
    head = "%s. " % stop["n"] if stop.get("n") is not None else ""
    where = "%s:%s%s" % (stop["file"], stop["line"], ("  " + stop["function"]) if stop.get("function") else "")
    fact = stop.get("fact")
    return "%s[%s] %s  %s  %s" % (head, stop["kind"], where, (fact.get("text") if isinstance(fact, dict) else fact) or "", steps)


def render_plan(plan: dict) -> list[str]:
    """The start output's middle: the paragraph, the stops, the unreached lines, the edges."""
    out = [describe(plan["summary"]), ""]
    stops = plan.get("stops") or []
    out.append("stops (%d):" % len(stops) if stops else "stops: none; the runs differ in no raise, type, sign, None, print or unnamed value")
    out.extend("  " + stop_line(s) for s in stops)
    unreached = plan.get("unreached") or []
    if unreached:
        out.append("unreached changed lines (%d):" % len(unreached))
        out.extend("  %s:%s" % (u["file"], span_text(u)) for u in unreached)
    edge_rows = plan.get("edges") or []
    if edge_rows:
        out.append("edge candidates (%d):" % len(edge_rows))
        for e in edge_rows:
            out.append("  %s [%s] %s:%s %s" % (e["id"], e["kind"], e["file"], e["line"], e["function"]))
            out.append("      %s" % e["what"])
    return out


__all__ = ["ask_stop", "build_plan", "describe", "first_step_on", "render_plan", "span_text", "stop_line", "values_at"]
