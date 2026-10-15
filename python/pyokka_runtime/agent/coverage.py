"""``pyokka coverage``: which statements of each file ran, from the run's ``coverage`` events.

One ``coverage`` event per file (``docs/PROTOCOL.md``, "Events"): ``states[localRid]`` (0 not run,
1 covered, 2 partial, 3 error source, 4 error path, 5 ignored) and ``hits[localRid]``. A file's
statements are ``file.instrumented.statements``; this folds them to source lines, since a line is
what a reader acts on. A line with several statements takes the worst state among them that ran
or did not (not run over partial over covered), and the most hits.
"""

from __future__ import annotations

from typing import Any

from ..protocol import COV_COVERED, COV_ERROR_PATH, COV_ERROR_SOURCE, COV_IGNORED, COV_NOT_RUN, COV_PARTIAL
from .source import AgentError, SavedRun

STATE_NAME = {COV_NOT_RUN: "not run", COV_COVERED: "covered", COV_PARTIAL: "partial", COV_ERROR_SOURCE: "raised", COV_ERROR_PATH: "error path", COV_IGNORED: "ignored"}
#: which state a line shows when its statements disagree: the one a reader has to look at first
_RANK = {COV_NOT_RUN: 5, COV_ERROR_SOURCE: 4, COV_PARTIAL: 3, COV_ERROR_PATH: 2, COV_COVERED: 1, COV_IGNORED: 0}
FILES_CAP = 40
LINES_CAP = 400


def _lines_of(run: SavedRun, file_id: int) -> list[dict]:
    """``[{line, state, hits}]`` in line order for one file, ignored statements left out."""
    f = run.files.get(file_id) or {}
    cov = run.coverage.get(file_id) or {}
    states = cov.get("states") or []
    hits = cov.get("hits") or []
    ranges = f.get("ranges") or []
    by_line: dict[int, dict] = {}
    for local in f.get("statements") or []:
        if local >= len(states) or local >= len(ranges):
            continue
        state = int(states[local])
        if state == COV_IGNORED:
            continue
        line = int(ranges[local][0])
        n = int(hits[local]) if local < len(hits) else 0
        cur = by_line.get(line)
        if cur is None:
            by_line[line] = {"line": line, "state": state, "hits": n}
            continue
        if _RANK.get(state, 0) > _RANK.get(cur["state"], 0):
            cur["state"] = state
        cur["hits"] = max(cur["hits"], n)
    return [by_line[k] for k in sorted(by_line)]


def _spans(lines: list[int]) -> list[list[int]]:
    """``[[first, last], ...]`` runs of consecutive statement lines, e.g. 12, 13, 14, 20 → [[12, 14], [20, 20]]; ``lines`` is sorted."""
    out: list[list[int]] = []
    for n in lines:
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return out


def _file_summary(run: SavedRun, file_id: int, lines: list[dict]) -> dict:
    path = run.file_path(file_id)
    not_run = [l["line"] for l in lines if l["state"] == COV_NOT_RUN]
    statement_lines = [l["line"] for l in lines]
    return {
        "file": run.display_path(path),
        "path": path,
        "fileId": file_id,
        "lines": len(lines),
        "ran": len(lines) - len(not_run),
        "percent": round(100.0 * (len(lines) - len(not_run)) / len(lines), 1) if lines else None,
        "notRun": not_run,
        "notRunSpans": _spans(not_run),
        "partial": [l["line"] for l in lines if l["state"] == COV_PARTIAL],
        "raised": [l["line"] for l in lines if l["state"] == COV_ERROR_SOURCE],
        "library": "site-packages" in str(path) or "dist-packages" in str(path),
        "statementLines": statement_lines,
    }


def coverage_report(source: Any, *, file: str | None = None) -> dict:
    """``{files: [summary], total, detail?}``: a summary per file, project files first; ``detail`` is ``file``'s lines with source."""
    if isinstance(source, SavedRun):
        run = source
    elif hasattr(source, "recording"):
        doc = source.recording()
        run = SavedRun(str(doc.get("meta", {}).get("file") or "live-session.json"), doc=doc)
    else:
        raise AgentError("coverage needs a saved run or a live session", "`pyokka coverage run.json`, or `pyokka coverage --live`")
    if not run.coverage:
        raise AgentError("the run has no coverage", "it did not finish recording; run it again with `pyokka run FILE --save run.json`")
    main = run.main_file_id()
    summaries = []
    per_file: dict[int, list[dict]] = {}
    for f in run.sorted_files:
        fid = int(f["fileId"])
        if fid not in run.coverage:
            continue
        per_file[fid] = _lines_of(run, fid)
        summaries.append(_file_summary(run, fid, per_file[fid]))
    summaries.sort(key=lambda s: (s["fileId"] != main, s["library"], s["file"]))
    project = [s for s in summaries if not s["library"]]
    total_lines = sum(s["lines"] for s in project)
    total_ran = sum(s["ran"] for s in project)
    out: dict = {
        "files": [{k: v for k, v in s.items() if k != "statementLines"} for s in summaries],
        "total": {"files": len(project), "lines": total_lines, "ran": total_ran, "percent": round(100.0 * total_ran / total_lines, 1) if total_lines else None, "libraryFiles": len(summaries) - len(project)},
    }
    if file:
        picked = run.resolve_file(file)
        fid = int(picked["fileId"])
        src = run.source_lines(fid)
        detail = []
        for l in per_file.get(fid, []):
            text = src[l["line"] - 1] if 0 < l["line"] <= len(src) else ""
            detail.append({"line": l["line"], "state": STATE_NAME.get(l["state"], str(l["state"])), "hits": l["hits"], "text": text})
        out["detail"] = {"file": run.display_path(run.file_path(fid)), "lines": detail}
    return out


def _span_text(spans: list[list[int]], cap: int = 12) -> str:
    parts = ["%d" % a if a == b else "%d-%d" % (a, b) for a, b in spans[:cap]]
    if len(spans) > cap:
        parts.append("… %d more" % (len(spans) - cap))
    return ", ".join(parts)


def render_coverage(result: dict, source: Any, args: Any) -> list[str]:
    total = result.get("total") or {}
    lines: list[str] = []
    if total.get("lines"):
        lib = total.get("libraryFiles") or 0
        lines.append("%d of %d statement lines ran (%s%%) in %d project file%s%s" % (total["ran"], total["lines"], total["percent"], total["files"], "" if total["files"] == 1 else "s", ", %d library files below" % lib if lib else ""))
    files = result.get("files") or []
    for s in files[:FILES_CAP]:
        bits = ["%s  %d of %d ran" % (s["file"], s["ran"], s["lines"])]
        if s["percent"] is not None:
            bits[0] += " (%s%%)" % s["percent"]
        if s["notRunSpans"]:
            bits.append("not run: " + _span_text(s["notRunSpans"]))
        if s["partial"]:
            bits.append("partial: " + ", ".join(str(n) for n in s["partial"][:12]))
        if s["raised"]:
            bits.append("raised: " + ", ".join(str(n) for n in s["raised"][:12]))
        lines.append("  ".join(bits))
    if len(files) > FILES_CAP:
        lines.append("… %d more files; `--file F` reads one" % (len(files) - FILES_CAP))
    detail = result.get("detail")
    if detail:
        lines.append("")
        lines.append("%s, line by line (hits; not run, partial and raised marked):" % detail["file"])
        rows = detail["lines"]
        for row in rows[:LINES_CAP]:
            mark = "" if row["state"] == "covered" else "   " + row["state"]
            hits = "--" if row["state"] == "not run" else "×%d" % row["hits"]
            text = row["text"].rstrip()
            if len(text) > 100:
                text = text[:99] + "…"
            lines.append("%5d %6s  %s%s" % (row["line"], hits, text, mark))
        if len(rows) > LINES_CAP:
            lines.append("… %d more lines" % (len(rows) - LINES_CAP))
    return lines


__all__ = ["coverage_report", "render_coverage", "STATE_NAME"]
