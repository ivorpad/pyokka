"""Chapters: consecutive step ranges that cover the run, each opened by a function call.

1. Top level. Start at the module and descend while one call holds 80% of the frame's steps and
   the frame's other calls together hold under max(3%, 25 steps) (``<module>`` to ``main``).
   Each call that frame makes (8 steps or more; one source line calling one function in a row is
   one chapter, a loop) is a chapter, and the statements between calls glue onto the next one.
2. Phases. Inside a chapter holding over 25% of the run, an orchestrator is a function called
   once there whose own steps span over 25% of the chapter. Each statement of an orchestrator that
   keeps the result of a call to a project function opens a phase at the first call to each
   distinct callee (a second ``complexity()`` stays in the phase it is in).
3. Concurrency. Instances of one function whose lifetimes overlap without one descending from the
   other (recorded scope parents) run concurrently; no phase starts inside their span.
4. Small phases. A phase under 2% of the run merges into the previous one unless it makes an HTTP
   request; then a chapter under 2.5% folds into the next (the last into the previous).

Port of the ablation's ``chapters.py`` and ``poc/phases.py`` (``docs/TOUR.md``, "Chapters").
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .astinfo import binds_call, classify_call, own_calls

if TYPE_CHECKING:
    from .model import TourRun

MIN_CALL_STEPS = 8
GLUE_STEPS = 12
BIG_SHARE = 0.25
MIN_SHARE = 0.02
FOLD_SHARE = 0.025
ANON = ("<lambda>", "<genexpr>", "<listcomp>", "<dictcomp>", "<setcomp>", "<module>")


def is_anon(fn: str) -> bool:
    return fn.rsplit(".", 1)[-1] in ANON


def calls_in_frame(t: "TourRun", scope: int, lo: int, hi: int) -> list[dict]:
    """The calls whose previous step (the statement that led to them) ran in ``scope``, with ``xEnd``."""
    out = []
    for m in t.calls:
        e = int(m["entryStep"])
        if not (lo <= e <= hi) or e == 0 or t.scope[e - 1] != scope or is_anon(m["callee"]["function"]):
            continue
        out.append(dict(m, xEnd=min(hi, t.extent(m))))
    return sorted(out, key=lambda m: int(m["entryStep"]))


def _size(m: dict) -> int:
    return int(m["xEnd"]) - int(m["entryStep"]) + 1


def spine(t: "TourRun", lo: int, hi: int) -> tuple[int, list[dict], int, int]:
    """``(scope, its calls, lo, hi)`` of the frame that orchestrates ``lo..hi``."""
    scope = t.scope[lo]
    calls = calls_in_frame(t, scope, lo, hi)
    for _ in range(8):
        span = hi - lo + 1
        big = [m for m in calls if _size(m) >= 0.8 * span]
        if len(big) != 1:
            break
        rest = sum(_size(m) for m in calls if m is not big[0])
        if rest >= max(0.03 * span, 25):
            break
        lo, hi = int(big[0]["entryStep"]), int(big[0]["xEnd"])
        scope = t.scope[lo]
        calls = calls_in_frame(t, scope, lo, hi)
    return scope, calls, lo, hi


def top_level(t: "TourRun") -> list[dict]:
    """``[{start, end, title, entry}]``: the calls the orchestrating frame makes, statements glued on."""
    lo, hi = 0, t.n - 1
    _, calls, _, _ = spine(t, lo, hi)
    # calls in a row from one source line to one function are one group (a loop), sized together
    groups: list[dict] = []
    for m in calls:
        e = int(m["entryStep"])
        site, fn = t.line[e - 1], m["callee"]["function"]
        if groups and groups[-1]["site"] == site and groups[-1]["fn"] == fn:
            groups[-1]["end"] = max(groups[-1]["end"], int(m["xEnd"]))
            groups[-1]["n"] += 1
            groups[-1]["size"] += _size(m)
            continue
        groups.append({"start": e - 1, "end": int(m["xEnd"]), "site": site, "fn": fn, "n": 1, "entry": e, "size": _size(m)})
    bounds: list[dict] = []
    for g in groups:
        if g["size"] < MIN_CALL_STEPS:
            continue
        if bounds and g["entry"] <= bounds[-1]["end"]:
            continue  # nested under the previous chapter
        bounds.append(g)
    out: list[dict] = []
    cur = lo
    for b in bounds:
        if b["start"] > cur:
            out.append({"start": cur, "end": b["start"] - 1, "title": None, "entry": None})
        title = b["fn"] + (" x%d" % b["n"] if b["n"] > 1 else "")
        out.append({"start": max(cur, b["start"]), "end": b["end"], "title": title, "entry": b["entry"]})
        cur = b["end"] + 1
    if cur <= hi:
        out.append({"start": cur, "end": hi, "title": None, "entry": None})
    merged: list[dict] = []
    for c in out:
        if merged and merged[-1]["title"] is None and merged[-1]["end"] - merged[-1]["start"] < GLUE_STEPS:
            c = dict(c, start=merged.pop()["start"])
        merged.append(c)
    if len(merged) > 1 and merged[-1]["title"] is None and merged[-1]["end"] - merged[-1]["start"] < GLUE_STEPS:
        last = merged.pop()
        merged[-1]["end"] = last["end"]
    return merged


def _called_project_fn(t: "TourRun", step: int) -> str | None:
    """The project function a statement calls and keeps the result of, else None."""
    stmt = t.stmt(step)
    if stmt is None or not binds_call(stmt):
        return None
    info = t.info(t.fid[step])
    nxt = t.function(step + 1) if step + 1 < t.n and t.entry[step + 1] else None
    for call in own_calls(stmt):
        kind, label = classify_call(call, info, t.roots, t.defs, nxt)
        if kind == "user" and not label.startswith("self._api"):
            return label.rsplit(".", 1)[-1]
    return None


def concurrent_spans(t: "TourRun", a: int, b: int) -> list[tuple[int, int, str]]:
    """Spans where two or more instances of one function ran at once (neither descends from the other)."""
    by_fn: dict[tuple[int, str], list[int]] = {}
    for sid, steps in t.by_scope.items():
        if a <= steps[0] <= b and t.parent(sid) >= 0:
            by_fn.setdefault((t.fid[steps[0]], str(t.scopes[sid]["name"])), []).append(sid)
    out: list[tuple[int, int, str]] = []
    for (_, name), sids in by_fn.items():
        if len(sids) < 2:
            continue
        spans = sorted(((t.by_scope[s][0], t.by_scope[s][-1], s) for s in sids))
        cur: list | None = None
        for s0, s1, sid in spans:
            if cur is not None and s0 <= cur[1] and not any(t.descends(sid, o) for o in cur[2]):
                cur[1] = max(cur[1], s1)
                cur[2].append(sid)
                continue
            if cur is not None and len(cur[2]) >= 2:
                out.append((cur[0], cur[1], name))
            cur = [s0, s1, [sid]]
        if cur is not None and len(cur[2]) >= 2:
            out.append((cur[0], cur[1], name))
    return out


def _talks_out(t: "TourRun", a: int, b: int) -> bool:
    return any(a <= int(r["step"]) <= b for r in t.http)


def phases(t: "TourRun", c: dict) -> list[dict]:
    a, b = c["start"], c["end"]
    span = b - a + 1
    first_of: dict[tuple, list[int]] = {}
    for sid, steps in t.by_scope.items():
        if a <= steps[0] <= b and t.parent(sid) >= 0:
            first_of.setdefault((t.fid[steps[0]], t.scope_function(sid)), []).append(sid)
    chain = {sids[0] for sids in first_of.values() if len(sids) == 1 and t.by_scope[sids[0]][-1] - t.by_scope[sids[0]][0] > BIG_SHARE * span}
    starts: list[tuple[int, str]] = [(a, c["title"] or t.function(a))]
    seen: set[str] = set()
    chain_steps = sorted(st for sid in chain for st in t.by_scope[sid])
    for st in chain_steps:
        fn = _called_project_fn(t, st)
        if fn and fn not in seen:
            seen.add(fn)
            starts.append((st, fn))
    starts.sort()
    busy = concurrent_spans(t, a, b)
    starts = [starts[0]] + [(st, fn) for st, fn in starts[1:] if not any(s0 < st <= s1 for s0, s1, _ in busy)]
    segs: list[dict] = []
    for k, (st, fn) in enumerate(starts):
        end = starts[k + 1][0] - 1 if k + 1 < len(starts) else b
        if end < st:
            continue
        if segs and (end - st + 1) < MIN_SHARE * t.n and not _talks_out(t, st, end):
            segs[-1]["end"] = end
            segs[-1]["opens"].append(fn)
        else:
            segs.append({"start": st, "end": end, "title": fn, "opens": [fn], "kind": "phase"})
    if len(segs) > 1 and (segs[0]["end"] - segs[0]["start"] + 1) < MIN_SHARE * t.n:
        first = segs.pop(0)
        segs[0] = dict(segs[0], start=first["start"], title=first["title"], opens=first["opens"] + segs[0]["opens"])
    return segs


def chapters(t: "TourRun") -> list[dict]:
    """``[{start, end, title, opens, kind}]`` covering steps 0..n-1 without gaps."""
    if t.n == 0:
        return []
    out: list[dict] = []
    for c in top_level(t):
        title = c["title"] or t.function(c["start"])
        if (c["end"] - c["start"] + 1) > BIG_SHARE * t.n and c["entry"] is not None:
            parts = phases(t, dict(c, title=title))
            if len(parts) > 1:
                for p in parts:
                    p["parent"] = title
                out.extend(parts)
                continue
        out.append({"start": c["start"], "end": c["end"], "title": title, "opens": [title], "kind": "call" if c["entry"] is not None else "statements"})
    folded: list[dict] = []
    for c in out:
        if folded and (folded[-1]["end"] - folded[-1]["start"] + 1) < FOLD_SHARE * t.n:
            prev = folded.pop()
            c = dict(c, start=prev["start"], title=prev["title"], opens=prev["opens"] + c["opens"])
        folded.append(c)
    final: list[dict] = []
    for c in folded:
        if final and (c["end"] - c["start"] + 1) < FOLD_SHARE * t.n:
            prev = final.pop()
            c = dict(prev, end=c["end"], opens=prev["opens"] + c["opens"])
        final.append(c)
    return final


__all__ = ["chapters", "top_level", "phases", "concurrent_spans", "spine", "is_anon", "calls_in_frame"]
