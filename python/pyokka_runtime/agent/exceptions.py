"""The exceptions report: every exception a run raised, where, where it was caught, how often (``docs/PROTOCOL.md``, "Exceptions report").

Deterministic and instant: one row per (kind, error type, raise site, handler) over the run's
``error`` events, the uncaught one first, the broad handlers flagged. The runtime already
aggregates repeats per site; the builder folds again so older saved runs give the same rows.
``src/session/exceptionReport.ts`` is the same builder over a live session;
``test/unit/fixtures/exceptions.json`` pins both to identical output over ``exceptions-run.json``.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from .walkthrough import cut

if TYPE_CHECKING:
    from .source import SavedRun

MESSAGE_MAX = 200
LINE_MAX = 100
_KIND_ORDER = {"uncaught": 0, "caught": 1}


# -- the rows ------------------------------------------------------------------------------------------------------

def _kind(ev: dict) -> str:
    return "caught" if ev.get("handled") else "uncaught"


def _handler(ev: dict) -> dict | None:
    """The event's ``handledAt``: only a caught exception has one, and none when C code or the stdlib swallowed it."""
    at = ev.get("handledAt")
    return at if ev.get("handled") and isinstance(at, dict) else None


def _step(ev: dict) -> int:
    return int(ev["step"]) if ev.get("step") is not None else 0


def _raised_at(run: "SavedRun", ev: dict) -> dict:
    """The statement that raised (its first line; the calling statement when the raise was not stepped) and the frame's function."""
    fid = int(ev.get("fileId", -1))
    rid = int(ev.get("rid", -1))
    loc = run.locate(rid)
    stack = [f for f in ev.get("stack") or [] if isinstance(f, dict)]
    frame = next((f for f in stack if f.get("rid") == rid), stack[0] if stack else None)
    function = frame.get("function") if frame is not None else None
    return {"file": run.file_path(fid), "line": int(loc["range"][0]) if loc else 0, "function": str(function) if function is not None else "<module>", "fileId": fid, "rid": rid}


def _handled_at(run: "SavedRun", at: dict | None) -> dict | None:
    if at is None:
        return None
    fid = int(at.get("fileId", -1))
    return {"file": run.file_path(fid), "line": int(at.get("line") or 0), "function": str(at.get("function") or "<module>"), "fileId": fid, "rid": int(at.get("rid", -1)), "broad": bool(at.get("broad"))}


def exceptions(run: "SavedRun") -> dict:
    groups: dict[tuple, dict] = {}  # (kind, errorType, origin rid, handler rid or None) -> the row being folded
    for ev in run.errors:
        kind = _kind(ev)
        at = _handler(ev)
        key = (kind, str(ev.get("errorType")), int(ev.get("rid", -1)), int(at["rid"]) if at is not None and at.get("rid") is not None else None)
        step = _step(ev)
        count = int(ev["count"]) if ev.get("count") is not None else 1
        last = int(ev["lastStep"]) if ev.get("lastStep") is not None else step
        g = groups.get(key)
        if g is None:
            groups[key] = {"kind": kind, "first": ev, "count": count, "step": step, "lastStep": last}
            continue
        g["count"] += count
        g["lastStep"] = max(g["lastStep"], last)
        if step < g["step"]:  # the first raise describes the row: its message, stack and handler
            g["step"] = step
            g["first"] = ev
    rows: list[dict] = []
    for n, g in enumerate(sorted(groups.values(), key=lambda g: (_KIND_ORDER[g["kind"]], g["step"], str(g["first"].get("errorType"))))):
        ev = g["first"]
        rows.append({
            "id": "x%d" % n,
            "kind": g["kind"],
            "errorType": str(ev.get("errorType")),
            "message": cut(ev.get("message"), MESSAGE_MAX),
            "count": g["count"],
            "step": g["step"],
            "lastStep": g["lastStep"],
            "raisedAt": _raised_at(run, ev),
            "handledAt": _handled_at(run, _handler(ev)),
        })
    return {
        "count": run.trace.count,
        "file": run.meta.get("file"),
        "exitCode": run.meta.get("exitCode"),
        "stale": bool(run.stale_files()),
        "staleFiles": run.stale_files(),
        "total": len(rows),
        "raises": sum(int(r["count"]) for r in rows),
        "uncaught": sum(1 for r in rows if r["kind"] == "uncaught"),
        "caught": sum(1 for r in rows if r["kind"] == "caught"),
        "broad": sum(1 for r in rows if r["handledAt"] is not None and r["handledAt"]["broad"]),
        "rows": rows,
    }


# -- text form -----------------------------------------------------------------------------------------------------

def _fit(text: str, limit: int = LINE_MAX) -> str:
    s = re.sub(r"\s*\n\s*", " ", text)  # like the TypeScript renderer's `fit`
    return s if len(s) <= limit else s[: limit - 1] + "…"


def summary(result: dict) -> str:
    """``8 exceptions over 412 steps: 1 uncaught, 7 caught (10 raises), 2 by a broad handler``.

    ``(N raises)`` only when the caught rows stand for more raises than there are rows, the broad
    count only when there is one; ``src/session/exceptionReport.ts`` words it the same way.
    """
    total = int(result.get("total") or 0)
    steps = int(result.get("count") or 0)
    if not total:
        return "no exceptions over %d steps" % steps
    caught = int(result.get("caught") or 0)
    caught_raises = sum(int(r.get("count") or 0) for r in result.get("rows") or [] if r.get("kind") == "caught")
    text = "%d exception%s over %d steps: %d uncaught, %d caught" % (total, "" if total == 1 else "s", steps, int(result.get("uncaught") or 0), caught)
    if caught_raises != caught:
        text += " (%d raises)" % caught_raises
    if result.get("broad"):
        text += ", %d by a broad handler" % int(result["broad"])
    return text


def render_exceptions(result: dict, source: Any, args: Any) -> list[str]:
    """The summary, then two lines per row: ``#step  kind [×count] errorType: message`` and where it was raised and caught."""

    def at(site: dict) -> str:
        return "%s:%s %s" % (source.display_path(site.get("file")), site.get("line"), site.get("function"))

    out = [summary(result)]
    for r in result.get("rows") or []:
        times = (" ×%d" % int(r["count"])) if int(r.get("count") or 0) > 1 else ""
        message = r.get("message")
        out.append(_fit("#%d  %s%s %s%s" % (int(r["step"]), r["kind"], times, r["errorType"], (": %s" % message) if message else "")))
        where = "      raised %s" % at(r["raisedAt"])
        if r["kind"] == "caught":
            handler = r.get("handledAt")
            where += (" · caught %s%s" % (at(handler), " broad handler" if handler.get("broad") else "")) if handler else " · caught outside stepped code"
        if r.get("lastStep") != r.get("step"):
            where += " · last #%d" % int(r["lastStep"])
        out.append(_fit(where))
    return out


__all__ = ["exceptions", "render_exceptions", "summary", "MESSAGE_MAX", "LINE_MAX"]
