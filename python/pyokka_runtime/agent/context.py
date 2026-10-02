"""The context slice and the ``pyokka story`` blocks over a ``SavedRun``.

Pure functions; ``block_lines`` mirrors ``buildBlock`` in ``src/session/contextSlice.ts``: the
lines a block ran, its function header, and a single blank or comment line between two of them.
This listing is deliberately narrower than the editor's Code Story document, which shows two
lines of source either side of what ran and dims them (``docs/design/code-story.md``): an agent
reads the lines that ran in a context window, not a rendering. Shapes are the ones in
``docs/PROTOCOL.md`` ("Context slice").
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

from ..protocol import COV_NOT_RUN, FLAG_ERROR, FLAG_LOG, FLAG_SCOPE_ENTRY, FLAG_UNWINDING

if TYPE_CHECKING:
    from .source import SavedRun

BLOCK_LINES = 60
VALUE_CAP = 20
STORY_LINE_CAP = 150
STEPS_DEFAULT = 40
FIND_CAP = 50
CALLS_CAP = 20  # calls listed for one statement in `context`


def _blank_or_comment(line: str) -> bool:
    t = line.strip()
    return t == "" or t.startswith("#")


# -- blocks -----------------------------------------------------------------------------------------------

def block_lines(run: "SavedRun", scope_id: int, first: int, last: int, file_id: int) -> list[dict]:
    """``[{line, text, step}]`` for one block: the lines that ran (first step each), the header, one-line context."""
    trace = run.trace
    src = run.source_lines(file_id)
    first_step_of_line: dict[int, int] = {}
    for k in range(first, last + 1):
        loc = trace.location(k)
        if loc is None or loc[0] != file_id:
            continue
        rng = loc[1]
        for l in range(rng[0], min(rng[2], rng[0] + 1) + 1):
            first_step_of_line.setdefault(l, k)
        first_step_of_line.setdefault(rng[0], k)
    if not first_step_of_line or not src:
        return []
    scope = trace.scope(scope_id)
    scope_loc = run.locate(int(scope["rid"])) if scope else None
    wanted = set(first_step_of_line)
    if scope_loc and scope_loc["fileId"] == file_id and scope and int(scope["parent"]) >= 0:
        header = int(scope_loc["range"][0])
        wanted.add(header)
        l = header - 1
        while l >= 1 and (src[l - 1] if l - 1 < len(src) else "").strip().startswith("#") and header - l <= 3:
            wanted.add(l)
            l -= 1
    ordered = sorted(l for l in wanted if 1 <= l <= len(src))
    out: list[dict] = []
    prev: int | None = None
    for cur in ordered:
        if prev is not None and cur - prev - 1 == 1 and _blank_or_comment(src[prev] if prev < len(src) else ""):
            out.append({"line": prev + 1, "text": src[prev], "step": None})
        out.append({"line": cur, "text": src[cur - 1], "step": first_step_of_line.get(cur)})
        prev = cur
    return out


def _step_location(run: "SavedRun", step: int) -> dict:
    loc = run.locate(run.trace.rid(step))
    scope = run.trace.scope(run.trace.scope_id(step))
    if loc is None:
        return {"file": None, "line": 0, "col": 0, "function": scope["name"] if scope else "<module>", "fileId": -1}
    return {"file": loc["path"], "line": int(loc["range"][0]), "col": int(loc["range"][1]), "function": scope["name"] if scope else "<module>", "fileId": loc["fileId"]}


def _log_value(run: "SavedRun", ev: dict) -> dict:
    loc = run.locate(int(ev.get("rid", -1)))
    return {
        "line": int(loc["range"][0]) if loc else 0,
        "file": loc["path"] if loc else None,
        "context": ev.get("context"),
        "text": ev.get("text"),
        "step": ev.get("step"),
        "hit": ev.get("hit"),
        "kind": ev.get("kind"),
        "runtimeKey": ev.get("runtimeKey"),
    }


def _local_values(run: "SavedRun", step: int) -> list[dict]:
    out = []
    loc = run.trace.location(step)
    for entry in run.locals_by_step.get(step, ()):
        for ch in entry.get("changes") or []:
            out.append({"line": int(loc[1][0]) if loc else 0, "file": run.file_path(loc[0]) if loc else None, "context": ch.get("name"), "text": ch.get("text"), "step": step, "hit": None, "kind": "local", "runtimeKey": None})
    return out


def block_values(run: "SavedRun", first: int, last: int, file_id: int) -> list[dict]:
    """Log entries and recorded locals of the block's steps, by step."""
    out: list[dict] = []
    for ev in run.logs:
        st = ev.get("step")
        if st is not None and first <= int(st) <= last and int(ev.get("fileId", -1)) == file_id:
            out.append(_log_value(run, ev))
    for step in range(first, last + 1):
        if step in run.locals_by_step:
            out.extend(_local_values(run, step))
    out.sort(key=lambda v: (v["step"] if v["step"] is not None else -1, v["line"]))
    return out


def _window(items: list, current_index: int, cap: int) -> tuple[list, bool]:
    if len(items) <= cap:
        return items, False
    start = max(0, min(current_index - cap // 2, len(items) - cap))
    return items[start : start + cap], True


def block_not_run(run: "SavedRun", scope_id: int, file_id: int, cap: int = BLOCK_LINES) -> list[int]:
    """Statement lines inside the block's function (or module) that never ran, when coverage knows."""
    f = run.files.get(file_id)
    cov = run.coverage.get(file_id)
    if not f or not cov:
        return []
    states = cov.get("states") or []
    ranges = f.get("ranges") or []
    scope = run.trace.scope(scope_id)
    body = None
    if scope and int(scope["parent"]) >= 0:
        loc = run.locate(int(scope["rid"]))
        if loc and loc["fileId"] == file_id:
            local = loc["localRid"]
            body = next((fn.get("bodyRange") for fn in f.get("functions") or [] if int(fn.get("rid", -1)) == local), None) or loc["range"]
    lines: set[int] = set()
    for local in f.get("statements") or []:
        if local >= len(states) or local >= len(ranges) or states[local] != COV_NOT_RUN:
            continue
        r = ranges[local]
        if body is not None and not (body[0] <= r[0] <= body[2]):
            continue
        lines.add(int(r[0]))
    return sorted(lines)[:cap]


def block_errors(run: "SavedRun", first: int, last: int, file_id: int, lines: set[int]) -> list[dict]:
    out: list[dict] = []
    seen: dict[tuple, dict] = {}
    # the uncaught exception is emitted twice (handled at a finally, then uncaught at the end): one entry, unhandled
    for ev in sorted(run.errors, key=lambda e: bool(e.get("handled"))):
        step = ev.get("step")
        hit_line: int | None = None
        if int(ev.get("fileId", -1)) == file_id:
            loc = run.locate(int(ev.get("rid", -1)))
            if loc and int(loc["range"][0]) in lines:
                hit_line = int(loc["range"][0])
        if hit_line is None:
            for frame in ev.get("stack") or []:
                if int(frame.get("fileId", -1)) == file_id and int(frame.get("line", 0)) in lines:
                    hit_line = int(frame["line"])
                    break
        if hit_line is None and not (step is not None and first <= int(step) <= last):
            continue
        key = (ev.get("errorType"), ev.get("message"), hit_line, step)
        if key in seen:
            continue
        seen[key] = {"line": hit_line, "type": ev.get("errorType"), "message": ev.get("message"), "step": step, "handled": bool(ev.get("handled"))}
    out = list(seen.values())
    out.sort(key=lambda e: (e["step"] if e["step"] is not None else -1))
    return out


def context_slice(run: "SavedRun", step: int, *, scope: bool = False) -> dict:
    trace = run.trace
    block = trace.block_at(step)
    assert block is not None
    scope_id, first, last = block
    loc = trace.location(step)
    file_id = loc[0] if loc else -1
    location = _step_location(run, step)
    lines = block_lines(run, scope_id, first, last, file_id)
    cur_line = location["line"]
    for entry in lines:
        if entry["line"] == cur_line:
            entry["current"] = True
    cur_index = next((i for i, e in enumerate(lines) if e.get("current")), 0)
    shown, capped = (lines, False) if scope else _window(lines, cur_index, BLOCK_LINES)
    values = block_values(run, first, last, file_id)
    v_index = next((i for i, v in enumerate(values) if v["step"] is not None and v["step"] >= step), len(values) - 1)
    values_shown, values_capped = (values, False) if scope else _window(values, max(v_index, 0), VALUE_CAP)
    scope_info = trace.scope(scope_id)
    stack = [{"file": run.file_path(f.file_id), "line": f.line, "function": f.function, "step": f.step} for f in trace.call_stack(step)]
    block_line_set = {e["line"] for e in lines}
    block_out: dict[str, Any] = {
        "file": run.file_path(file_id),
        "function": scope_info["name"] if scope_info else "<module>",
        "scopeId": scope_id,
        "firstStep": first,
        "lastStep": last,
        "lines": shown,
        "totalLines": len(lines),
        "capped": capped,
    }
    if scope_info and last == int(scope_info.get("last", -1)):  # the function left in this block
        block_out.update(_exit(scope_info))
    return {
        "step": step,
        "count": trace.count,
        "location": location,
        "stale": bool(run.stale_files()),
        "staleFiles": run.stale_files(),
        "stack": stack,
        "block": block_out,
        "calls": step_calls(run, step, scope_id),
        "values": values_shown,
        "valuesTotal": len(values),
        "valuesCapped": values_capped,
        "coverage": {"notRun": block_not_run(run, scope_id, file_id)},
        "moves": trace.moves(step),
        "errors": block_errors(run, first, last, file_id, block_line_set),
        "flags": _flags(trace.flags(step)),
    }


def _flags(bits: int) -> list[str]:
    out = []
    if bits & FLAG_SCOPE_ENTRY:
        out.append("entry")
    if bits & FLAG_LOG:
        out.append("log")
    if bits & FLAG_ERROR:
        out.append("error")
    if bits & FLAG_UNWINDING:
        out.append("unwinding")
    return out


# -- values on a line ----------------------------------------------------------------------------------------

def values_on_line(run: "SavedRun", file_id: int, line: int) -> list[dict]:
    out: list[dict] = []
    for ev in run.logs:
        if int(ev.get("fileId", -1)) != file_id:
            continue
        loc = run.locate(int(ev.get("rid", -1)))
        if loc and int(loc["range"][0]) == line:
            out.append(_log_value(run, ev))
    for step in run.trace.steps_on_line(file_id, line):
        out.extend(_local_values(run, step))
    out.sort(key=lambda v: (v["step"] if v["step"] is not None else -1, v["hit"] or 0))
    return out


def _exit(scope: dict) -> dict:
    """``returned`` (the value as text) or ``raised`` (the exception type) a scope recorded at its exit; empty for older runs."""
    if "returned" in scope:
        out = {"returned": scope["returned"]}
        for key in ("returnedTruncated", "returnedLength"):  # the recording cut the text (`…(+N chars)`)
            if key in scope:
                out[key] = scope[key]
        return out
    if "raised" in scope:
        return {"raised": scope["raised"]}
    return {}


def step_calls(run: "SavedRun", step: int, scope_id: int) -> list[dict]:
    """The calls the statement at ``step`` made, in order, each with what it returned or raised."""
    trace = run.trace
    over = trace.step_over(step)
    end = over if over >= 0 else trace.count
    out = []
    for s in trace.scopes:
        if int(s.get("parent", -1)) == scope_id and step < int(s["first"]) < end and str(s.get("name")) != "<module>":
            out.append({"function": str(s["name"]), "scopeId": int(s["scopeId"]), "step": int(s["first"]), **_exit(s)})
            if len(out) >= CALLS_CAP:
                break
    return out


# -- story ------------------------------------------------------------------------------------------------------

def story(run: "SavedRun", *, file_id: int | None = None, scope: str | None = None, line: tuple[int, int] | None = None, line_cap: int = STORY_LINE_CAP) -> dict:
    trace = run.trace
    blocks_out: list[dict] = []
    total = 0
    matched = 0
    shown_lines = 0
    truncated = False
    filtered = file_id is not None or scope is not None or line is not None
    for index, (scope_id, first, last) in enumerate(trace.blocks()):
        total += 1
        loc = trace.location(first)
        fid = loc[0] if loc else -1
        name = run.scope_name(scope_id)
        if file_id is not None and fid != file_id:
            continue
        if scope is not None and name != scope:
            continue
        lines = block_lines(run, scope_id, first, last, fid)
        if line is not None and not (fid == line[0] and any(e["line"] == line[1] for e in lines)):
            continue
        matched += 1
        if truncated:
            continue
        if shown_lines + len(lines) > line_cap and blocks_out:
            truncated = True
            continue
        shown_lines += len(lines)
        blocks_out.append({"index": index, "scopeId": scope_id, "function": name, "file": run.file_path(fid), "fileId": fid, "firstStep": first, "lastStep": last, "lines": lines, "noSource": not lines})
    return {"blocks": blocks_out, "total": total, "matched": matched, "filtered": filtered, "shown": len(blocks_out), "count": trace.count, "truncated": truncated, "stale": bool(run.stale_files()), "staleFiles": run.stale_files()}


# -- steps -------------------------------------------------------------------------------------------------------

def _step_row(run: "SavedRun", i: int) -> dict:
    loc = run.trace.location(i)
    return {
        "step": i,
        "file": run.file_path(loc[0]) if loc else None,
        "line": int(loc[1][0]) if loc else 0,
        "function": run.scope_name(run.trace.scope_id(i)),
        "depth": run.trace.depth(i),
        "scopeId": run.trace.scope_id(i),
        "flags": _flags(run.trace.flags(i)),
    }


def list_steps(run: "SavedRun", *, start: int = 0, count: int = STEPS_DEFAULT, line: tuple[int, int] | None = None) -> dict:
    trace = run.trace
    count = max(1, count)
    if line is not None:
        on = trace.steps_on_line(line[0], line[1])
        rows = [_step_row(run, i) for i in on[:count]]
        return {"steps": rows, "count": trace.count, "total": len(on), "next": on[count] if len(on) > count else None, "line": {"file": run.file_path(line[0]), "line": line[1]}}
    start = max(0, start)
    end = min(trace.count, start + count)
    rows = [_step_row(run, i) for i in range(start, end)]
    return {"steps": rows, "count": trace.count, "from": start, "next": end if end < trace.count else None}


# -- find --------------------------------------------------------------------------------------------------------

def find(run: "SavedRun", text: str, limit: int = FIND_CAP) -> dict:
    needle = text.lower()
    hits: list[dict] = []
    total = 0

    def add(hit: dict) -> None:
        nonlocal total
        total += 1
        if len(hits) < limit:
            hits.append(hit)

    for ev in run.logs:
        blob = "%s %s" % (ev.get("context") or "", ev.get("text") or "")
        if needle in blob.lower():
            v = _log_value(run, ev)
            add({"kind": "value", "file": v["file"], "line": v["line"], "step": v["step"], "context": v["context"], "text": v["text"]})
    for entry in run.locals_entries:
        step = int(entry.get("step", -1))
        loc = run.trace.location(step)
        for ch in entry.get("changes") or []:
            if needle in ("%s %s" % (ch.get("name") or "", ch.get("text") or "")).lower():
                add({"kind": "local", "file": run.file_path(loc[0]) if loc else None, "line": int(loc[1][0]) if loc else 0, "step": step, "context": ch.get("name"), "text": ch.get("text")})
    for ev in run.errors:
        if needle in ("%s %s" % (ev.get("errorType") or "", ev.get("message") or "")).lower():
            loc = run.locate(int(ev.get("rid", -1)))
            add({"kind": "error", "file": loc["path"] if loc else None, "line": int(loc["range"][0]) if loc else 0, "step": ev.get("step"), "context": ev.get("errorType"), "text": ev.get("message")})
    for ev in run.output:
        if needle in str(ev.get("text") or "").lower():
            add({"kind": "output", "file": None, "line": 0, "step": ev.get("step"), "context": ev.get("stream"), "text": str(ev.get("text") or "").rstrip("\n")})
    # executed statement lines (any file that ran)
    first_step_by_line: dict[tuple[int, int], int] = {}
    for i in range(run.trace.count):
        loc = run.trace.location(i)
        if loc is not None:
            first_step_by_line.setdefault((loc[0], int(loc[1][0])), i)
    for (fid, ln), step in sorted(first_step_by_line.items(), key=lambda kv: kv[1]):
        src = run.source_lines(fid)
        if 1 <= ln <= len(src) and needle in src[ln - 1].lower():
            add({"kind": "line", "file": run.file_path(fid), "line": ln, "step": step, "context": run.scope_name(run.trace.scope_id(step)), "text": src[ln - 1].strip()})
    return {"text": text, "hits": hits, "total": total, "truncated": total > len(hits)}


__all__ = ["context_slice", "block_lines", "block_values", "values_on_line", "story", "list_steps", "find", "BLOCK_LINES", "VALUE_CAP", "STORY_LINE_CAP"]
