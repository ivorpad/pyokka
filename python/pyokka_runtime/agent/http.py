"""The HTTP table of a run and its text form (``docs/PROTOCOL.md``, "HTTP record and replay", HTTP table).

Built from the ``http.exchange`` rows and ``run.finished.http`` by one pure function per
language: the host's builder reads the same rows for the panel's HTTP view and the bridge's
``http`` reply, and ``test/unit/fixtures/http-table-run.json`` / ``http-table.json`` pin both
to one table. Rows are listed in ``n`` (request) order: an httpx row is emitted when its
stream is exhausted, so the event order is completion order.
"""

from __future__ import annotations

import math
import os
from typing import Any, Callable
from urllib.parse import urlsplit

from .walkthrough import format_duration

CAP = 500
NAME_MAX = 60
LINE_MAX = 100


def _cut(text: Any, limit: int) -> str:
    s = str(text if text is not None else "")
    return s if len(s) <= limit else s[: limit - 1] + "…"


def request_name(url: str) -> str:
    """The URL's last non-empty path segment, else its host; cut at 60 characters."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return _cut(url, NAME_MAX)
    segments = [s for s in parts.path.split("/") if s]
    return _cut(segments[-1] if segments else (parts.hostname or parts.netloc or url), NAME_MAX)


def http_table(events: list[dict], finished: dict | None, *, running: bool = False, locate: Callable[[int], dict | None], run_id: Any = None) -> dict:
    """The table: the rows of ``events`` (at most ``CAP``), their totals, ``run.finished.http`` as ``finished``.

    ``locate(rid)`` gives a row's initiator as ``{file, line, col, fileId}`` (None when the
    statement is unknown); it is never asked about ``rid: -1``. ``totals.misses`` counts keys
    (``finished.misses``); while the run is in flight it counts distinct method+URL pairs
    among the miss rows instead, ``missAttempts`` every miss row.
    """
    rows = sorted((e for e in events if isinstance(e, dict) and e.get("type") == "http.exchange"), key=lambda e: int(e.get("n") or 0))
    miss_rows = [r for r in rows if r.get("source") == "miss"]
    if isinstance(finished, dict) and isinstance(finished.get("misses"), int):
        misses = int(finished["misses"])
    else:
        misses = len({(r.get("method"), r.get("url")) for r in miss_rows})
    if run_id is None:
        run_id = next((r.get("runId") for r in rows if r.get("runId") is not None), None)
    return {
        "runId": run_id,
        "running": bool(running),
        "count": len(rows),
        "truncated": len(rows) > CAP,
        "totals": {
            "requests": len(rows),
            "bytes": sum(int(r["bytes"]) for r in rows if isinstance(r.get("bytes"), (int, float))),
            "ms": sum(int(r["ms"]) for r in rows if isinstance(r.get("ms"), (int, float))),
            "misses": misses,
            "missAttempts": len(miss_rows),
        },
        "finished": finished if isinstance(finished, dict) else None,
        "requests": [_request(r, locate) for r in rows[:CAP]],
    }


def _request(row: dict, locate: Callable[[int], dict | None]) -> dict:
    rid = row.get("rid")
    location = locate(int(rid)) if isinstance(rid, int) and rid >= 0 else None
    return {
        "n": row.get("n"),
        "client": row.get("client"),
        "method": row.get("method"),
        "url": row.get("url"),
        "name": request_name(str(row.get("url") or "")),
        "status": row.get("status"),
        "reason": row.get("reason"),
        "bytes": row.get("bytes"),
        "ms": row.get("ms"),
        "recordedMs": row.get("recordedMs"),
        "source": row.get("source"),
        "step": row.get("step"),
        "location": location if isinstance(location, dict) else None,
    }


# -- text -----------------------------------------------------------------------------------------------------

def format_bytes(n: Any) -> str:
    """``18 B`` / ``6.8 kB`` / ``68 kB``: one decimal under 10 of a unit, none above."""
    if not isinstance(n, (int, float)):
        return "—"
    n = int(n)
    if n < 1000:
        return "%d B" % n
    for unit, div in (("kB", 1e3), ("MB", 1e6), ("GB", 1e9)):
        v = n / div
        if v < 1000 or unit == "GB":
            return "%.1f %s" % (math.floor(v * 10 + 0.5) / 10, unit) if v < 10 else "%d %s" % (math.floor(v + 0.5), unit)
    return "%d B" % n


def recording_label(finished: dict) -> str:
    """``3f2a….jsonl (2026-09-11 10:12Z)``: the recording's name cut to its first hex digits, and its header's date."""
    name = os.path.basename(str(finished.get("file") or "")) or "?"
    stem, ext = os.path.splitext(name)
    if len(stem) > 8:
        name = stem[:4] + "…" + ext
    when = finished.get("recordedAt")
    if isinstance(when, str) and len(when) >= 16:
        name += " (%s %sZ)" % (when[:10], when[11:16])
    return name


def _mode_text(result: dict) -> str:
    finished = result.get("finished")
    if not isinstance(finished, dict):
        return " · running" if result.get("running") else ""
    mode = finished.get("mode")
    if mode == "record":
        return " · recorded to %s" % recording_label(finished) if finished.get("recorded") else " · HTTP record, nothing written"
    if mode == "replay":
        text = " · replayed from %s" % recording_label(finished)
        misses = int(finished.get("misses") or 0)
        if misses:
            attempts = int((result.get("totals") or {}).get("missAttempts") or 0)
            text += ", %d missing (%d attempt%s)" % (misses, attempts, "" if attempts == 1 else "s")
        return text
    return " · HTTP off"


def _where(row: dict, source: Any) -> str:
    loc = row.get("location")
    if not isinstance(loc, dict) or not loc.get("file"):
        return "—"
    name = source.display_path(loc["file"]) if hasattr(source, "display_path") else os.path.basename(str(loc["file"]))
    return "%s:%s" % (name, loc.get("line"))


def render_http(result: dict, source: Any = None, args: Any = None) -> list[str]:
    """The contract's text form: a header with the totals and the recording, then one line per row, each cut at 100."""
    totals = result.get("totals") or {}
    n = int(totals.get("requests") or 0)
    out = ["%d request%s · %s · %s%s" % (n, "" if n == 1 else "s", format_bytes(totals.get("bytes") or 0), format_duration(totals.get("ms") or 0), _mode_text(result))]
    rows = result.get("requests") or []
    if not rows:
        out.append("no request was observed: the program made none, or the run had httpObserve off")
        return out
    for r in rows:
        miss = r.get("source") == "miss"
        status = "MISS" if miss else (str(r["status"]) if r.get("status") is not None else "—")
        size = "—" if r.get("bytes") is None else format_bytes(r["bytes"])
        line = "#%s  %s  %s  %s  %s  %s  %s  %s  %s" % (r.get("n"), r.get("method"), status, r.get("name"), _where(r, source), size, format_duration(r.get("ms")), r.get("source"), r.get("url"))
        out.append(_cut(line, LINE_MAX))
    if result.get("truncated"):
        out.append("… %d more requests not listed (the table keeps the first %d)" % (int(result.get("count") or 0) - len(rows), len(rows)))
    return out


__all__ = ["http_table", "render_http", "request_name", "format_bytes", "recording_label", "CAP"]
