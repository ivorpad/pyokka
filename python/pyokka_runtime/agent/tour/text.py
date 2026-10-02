"""The text form of ``tour.json``: the run, the goal, chapters with their step ranges, then one line per candidate."""

from __future__ import annotations

import os
from typing import Any

LINE_VALUE = 70
STATEMENT = 48


def _flat(text: Any, limit: int) -> str:
    s = " ".join(str(text if text is not None else "").split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _value(c: dict) -> str:
    """The first value worth a glance: ``name = text``, a repeat as ``name = same as <id>``."""
    for v in c.get("values") or []:
        if v.get("sameAs"):
            return "%s = same as %s" % (v["name"], v["sameAs"].split(".")[0])
        text = v.get("text", "")
        if v.get("like"):
            return "%s = …%s… (differs from %s at %d-%d)" % (v["name"], _flat(text, LINE_VALUE - 30), v["like"].split(".")[0], v["from"], v["to"])
        return "%s = %s" % (v["name"], _flat(text, LINE_VALUE))
    return ""


def render_merged(doc: dict) -> str:
    """A tour merged with its prose: what was accepted, the warnings, then the picks in order under their chapters."""
    prose = doc.get("prose") or {}
    warnings = prose.get("warnings") or []
    lines = ["prose accepted: %d stops, %d chapter texts, %d warning%s" % (prose.get("stops", 0), prose.get("chapters", 0), len(warnings), "" if len(warnings) == 1 else "s")]
    lines += ["warning: %s" % w for w in warnings]
    if doc.get("intro"):
        lines += ["", _flat(doc["intro"], 400)]
    by_id = {c["id"]: c for c in doc.get("candidates") or []}
    chapters = {ch["id"]: ch for ch in doc.get("chapters") or []}
    chapter = None
    for sid in doc.get("pick") or []:
        c = by_id[sid]
        if c["chapter"] != chapter:
            chapter = c["chapter"]
            ch = chapters.get(chapter) or {}
            a, b = ch.get("steps") or (0, 0)
            lines += ["", "%s  #%d-%d  %s" % (chapter, a, b, (ch.get("prose") or {}).get("title") or ch.get("title", ""))]
        p = c.get("prose") or {}
        q = p.get("quote")
        lines.append("  %d. %s  #%d  %s:%d  %s%s" % (p.get("order", 0), sid, c["step"], c["file"], c["line"], _flat(p.get("title"), 70), ("  [quote %s %d-%d]" % (q["name"], q["from"], q["to"])) if q else ""))
    return "\n".join(lines)


def render_tour(doc: dict, wrote: str | None = None) -> str:
    """The text form; ``wrote`` names the file ``--out`` wrote, printed last."""
    text = render_merged(doc) if doc.get("prose") is not None else _render_candidates(doc)
    return text + ("\nwrote %s" % wrote if wrote else "")


def _render_candidates(doc: dict) -> str:
    run = doc.get("run") or {}
    budget = doc.get("budget") or {}
    lines = [
        "tour  %s  %s steps  exit %s  %s HTTP (%s model calls)  %s of %s candidates, ~%s tokens (budget %s)"
        % (os.path.basename(str(run.get("file") or "")), format(run.get("steps", 0), ","), run.get("exitCode"), run.get("http", 0), run.get("llm", 0), budget.get("kept"), budget.get("found"), format(budget.get("estimate", 0), ","), format(budget.get("tokens", 0), ","))
    ]
    goal = doc.get("goal") or {}
    if goal.get("step") is not None:
        what = {"output": "the program's output", "name": goal.get("name"), "line": goal.get("line"), "end": "the last step"}.get(goal.get("kind"), goal.get("kind"))
        lines.append("goal: %s at #%s%s" % (what, goal["step"], (": " + _flat(goal.get("text"), 90)) if goal.get("text") else ""))
    if doc.get("small"):
        lines.append("small run: the walkthrough's moments are the candidates, one chapter")
    rec = run.get("recording")
    if isinstance(rec, dict) and rec.get("truncated"):
        lines.append("note: truncated recording: steps 0-%s of %s kept" % (rec.get("kept", 0) - 1, rec.get("stepsRun")))
    lines.append("")
    lines.append("chapters")
    for ch in doc.get("chapters") or []:
        a, b = ch["steps"]
        extra = "  %d HTTP (%d model)" % (ch["http"], ch["llm"]) if ch.get("http") else ""
        opens = ch.get("opens") or []
        more = ("  + " + ", ".join(opens[1:4]) + (" …" if len(opens) > 4 else "")) if len(opens) > 1 else ""
        lines.append("  %-4s #%d-%d  %4.1f%%  %s%s  %d candidates%s" % (ch["id"], a, b, 100 * ch.get("share", 0), ch["title"], more, ch.get("candidates", 0), extra))
    lines.append("")
    lines.append("candidates (id  #step  file:line  signals  statement  value)")
    chapter = None
    for c in doc.get("candidates") or []:
        if c["chapter"] != chapter:
            chapter = c["chapter"]
            lines.append("  [%s]" % chapter)
        sigs = ",".join(s["signal"] for s in c.get("signals") or [])
        value = _value(c)
        lines.append("  %s  #%d  %s:%d  %s  %s%s" % (c["id"], c["step"], c["file"], c["line"], sigs, _flat(c["statement"], STATEMENT), ("  → " + value) if value else ""))
    return "\n".join(lines)


__all__ = ["render_tour"]
