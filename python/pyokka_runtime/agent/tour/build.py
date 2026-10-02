"""``pyokka tour``: chapters and candidate stops of a recorded run, every value from the recording.

``build_tour(run, goal=None, budget=40000)`` returns ``tour.json`` (``docs/TOUR.md``). A run whose
walkthrough has under ``SMALL_MOMENTS`` moments is one chapter whose candidates are the
walkthrough's moments; a larger run is split into chapters (``chapters.py``) and gets the
signals' candidates (``signals.py``), kept by novelty and score under the budget (``rank.py``),
their values shaped (``values.py``).
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import TYPE_CHECKING, Any

from ..source import AgentError
from ..walkthrough import walkthrough
from . import rank as rank_mod
from . import signals as sig
from .chapters import chapters, spine as spine_frame
from .model import TourRun
from . import values as values_mod
from .astinfo import binds_call
from .values import gather, shape, tokens

if TYPE_CHECKING:
    from ..source import SavedRun

VERSION = 1
SMALL_MOMENTS = 60
DEFAULT_BUDGET = 40_000
STATEMENT_MAX = 240


def stable_key(t: TourRun, i: int) -> str:
    """Six hex characters of ``file:line`` and the statement's text: the same statement hashes the same in a re-recorded run."""
    raw = "%s:%d\n%s" % (t.display(i), t.line[i], " ".join(t.text(i).split()))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:6]


def resolve_goal(t: TourRun, goal: str | None) -> dict:
    """``{kind, step, seeds, text, name?}``: where the spine starts and the text evidence is matched against."""
    run = t.run
    if goal:
        if ":" in goal and goal.rsplit(":", 1)[1].isdigit():
            fname, line = goal.rsplit(":", 1)
            fid = int(run.resolve_file(fname)["fileId"])
            steps = [i for i in range(t.n) if t.fid[i] == fid and t.line[i] == int(line)]
            if not steps:
                raise AgentError("no step on %s" % goal, "`pyokka story RUN --file %s` lists the lines that ran" % fname)
            st = steps[-1]
            text = " ".join(v["text"] for v in gather(t, st))
            return {"kind": "line", "step": st, "seeds": [st], "text": text, "line": goal}
        from ..history import History

        rows = [r for r in History(run).rows(goal) if r.get("text") is not None]
        if not rows:
            raise AgentError("no recorded value of %s" % goal, "`pyokka var RUN %s` lists its changes; give a FILE:LINE instead" % goal)
        row = rows[-1]
        return {"kind": "name", "name": goal, "step": int(row["step"]), "seeds": [int(row["step"])], "text": str(row["text"])}
    if t.n == 0:
        return {"kind": "none", "step": None, "seeds": [], "text": ""}
    scope, _, _, _ = spine_frame(t, 0, t.n - 1)
    prints = sorted(t.prints(), key=lambda ev: int(ev["step"]))
    top = [ev for ev in prints if t.scope[int(ev["step"])] in (scope, t.scope[0])]
    chosen = top or prints
    if not chosen:
        return {"kind": "end", "step": t.n - 1, "seeds": [t.n - 1], "text": ""}
    goal_ev = chosen[-1]
    goal_step = int(goal_ev["step"])
    first_pass: dict[tuple[int, int], int] = {}
    for ev in chosen[:-1]:  # the first pass of every other output line of that frame, latest line first
        st = int(ev["step"])
        key = (t.fid[st], t.line[st])
        if key != (t.fid[goal_step], t.line[goal_step]) and key not in first_pass and not _literal_print(t, st, str(ev.get("text") or "")):
            first_pass[key] = st
    seeds = [goal_step] + sorted(first_pass.values(), reverse=True)
    return {"kind": "output", "step": goal_step, "seeds": seeds, "text": str(goal_ev.get("text") or "")}


def _literal_print(t: TourRun, step: int, text: str) -> bool:
    """A print whose output is written out in its own statement (a banner, a separator): nothing to explain."""
    flat = " ".join(text.split())
    return not flat.strip("=-_*#~ ") or flat in " ".join(t.text(step).split())


def _signal_list(c: dict) -> list[dict]:
    """``[{signal: "io:http", reason}]``, one per signal that proposed the step."""
    return [{"signal": "%s:%s" % (s, k), "reason": _cut(c["reasons"].get("%s:%s" % (s, k), ""), 100)} for s, k in sorted(c["subs"])]


def _candidate(t: TourRun, c: dict, chapter: str) -> dict:
    i = c["step"]
    key = stable_key(t, i)
    out = {
        "id": "s%d-%s" % (i, key),
        "key": key,
        "step": i,
        "chapter": chapter,
        "file": t.display(i),
        "line": t.line[i],
        "function": t.function(i),
        "scopeId": t.scope[i],
        "signals": _signal_list(c),
        "statement": _cut(t.text(i), STATEMENT_MAX),
        "score": c.get("score", 0),
        "_values": _merge_values(gather(t, i), [v for s in c.get("valuesFrom") or () for v in gather(t, s)]),
    }
    if c.get("setup"):
        out["setup"] = True
    if c.get("repeat"):
        out["repeat"] = True
    return out


def _merge_values(own: list[dict], extra: list[dict]) -> list[dict]:
    seen = {(v["role"], v["name"], v["text"]) for v in own}
    out = list(own)
    for v in extra:
        if (v["role"], v["name"], v["text"]) not in seen and v["role"] in ("set", "returned", "call", "raised", "value"):
            seen.add((v["role"], v["name"], v["text"]))
            out.append(v)
    return out[: values_mod.MAX_VALUES]


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _chapter_of(chs: list[dict], step: int) -> str:
    for c in chs:
        if c["steps"][0] <= step <= c["steps"][1]:
            return c["id"]
    return chs[-1]["id"] if chs else "c1"


def build_tour(run: "SavedRun", *, goal: str | None = None, budget: int = DEFAULT_BUDGET, full: dict[str, str] | None = None) -> dict:
    """``tour.json``. ``full``, when given, is filled with every kept value's whole recorded text by value id (the prose validator reads it)."""
    started = time.perf_counter()
    t = TourRun(run)
    g = resolve_goal(t, goal)
    pool = sig.Pool(t)
    # the walkthrough merges library calls, so it never has more moments than the unrolled list
    # in TourRun; build it only when it can come out under the threshold
    small = walkthrough(run) if goal is None and len(t.moments) < SMALL_MOMENTS * 10 else None
    is_small = small is not None and small["total"] < SMALL_MOMENTS
    sig.io(t, pool)
    sig.exceptions(t, pool)
    sig.crossings(t, pool)
    spine_info = sig.spine(t, pool, g["seeds"]) if g["seeds"] else {"whyCalls": 0}
    if g.get("step") is not None:
        pool.add(int(g["step"]), "spine", "goal", "the goal: %s" % ("the program's output" if g["kind"] == "output" else g.get("name") or g.get("line") or "the last step"))
    if is_small and small is not None:
        chs =[{"start": 0, "end": max(0, t.n - 1), "title": t.function(0) if t.n else "<module>", "opens": [], "kind": "walkthrough"}]
        for m in small["moments"]:
            st = int(m["step"])
            if m["kind"] in ("call", "tool") and m.get("entryStep") is not None and int(m["entryStep"]) - st > 3:
                st = int(m["entryStep"])
            pool.add(st, "walkthrough", m["kind"], m["text"])
        pooled = {st: c for st, c in pool.by_step.items() if any(s == "walkthrough" for s, _ in c["subs"])}
    else:
        chs = chapters(t)
        sig.narrative(t, pool)
        sig.prose_in(t, pool)
        sig.evidence(t, pool, g["text"])
        for c in chs:
            st = c["start"]
            pool.add(st, "chapter", "start", "chapter opened by %s" % c["title"])
            nxt = t.next_in_scope(st)
            if binds_call(t.stmt(st)) and nxt is not None and nxt <= c["end"] + 1:
                pool.add(nxt, "chapter", "result", "what %s produced lands" % c["title"], (st,))
        pooled = dict(pool.by_step)
    chapters_out = []
    for k, c in enumerate(chs, 1):
        a, b = c["start"], c["end"]
        reqs = [r for r in t.http if a <= int(r["step"]) <= b]
        chapters_out.append({"id": "c%d" % k, "title": c["title"], "opens": c.get("opens") or [c["title"]], "kind": c["kind"], "steps": [a, b], "share": round((b - a + 1) / max(1, t.n), 4), "http": len(reqs), "llm": sum(1 for r in reqs if r.get("llm"))})
    kept = []
    for c in rank_mod.novel(t, pooled):
        i = c["step"]
        fid = t.fid[i]
        if not is_small:
            if fid < 0 or (not t.user(fid) and not (c["subs"] & {("io", "http")})):
                continue
            if t.function(i) == "<module>" and fid != t.main_fid:
                continue  # import time of a module other than the script
        c["setup"] = rank_mod.is_setup(t, i) and ("spine", "goal") not in c["subs"]
        c["score"] = rank_mod.score(t, c)
        cand = _candidate(t, c, _chapter_of(chapters_out, i))
        if not cand["_values"] and c["subs"] <= {("spine", "why")}:
            continue  # a statement on the way to the goal that recorded nothing (a loop header, a bare print)
        kept.append(cand)
    goal_words = tokens(g["text"])
    total_candidates = len(kept)
    raw_values = {id(c): c["_values"] for c in kept}
    doc = {
        "tour": VERSION,
        "run": _summary(t),
        "goal": {k: v for k, v in g.items() if k not in ("seeds",)} | {"text": _cut(g["text"], 400)},
        "small": is_small,
        "budget": {"tokens": budget},
        "chapters": chapters_out,
        "candidates": [],
    }
    fixed = len(json.dumps(doc, ensure_ascii=False))
    selected = kept
    for _ in range(4):
        for c in selected:
            c["_values"] = raw_values[id(c)]
        shape(selected, goal_words)
        sizes = {id(c): len(json.dumps(c, ensure_ascii=False, separators=(",", ":"))) + 2 for c in selected}
        if sum(sizes.values()) + fixed <= budget * rank_mod.CHARS_PER_TOKEN:
            break
        selected = rank_mod.fit(selected, lambda c: sizes[id(c)], budget, fixed)
    selected.sort(key=lambda c: c["step"])
    if full is not None:
        for c in selected:
            for k, v in enumerate(raw_values[id(c)], 1):
                full["%s.v%d" % (c["id"], k)] = v["text"]
    for ch in chapters_out:
        ch["candidates"] = sum(1 for c in selected if c["chapter"] == ch["id"])
    doc["candidates"] = selected
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    doc["budget"].update({"estimate": len(text) // rank_mod.CHARS_PER_TOKEN, "found": total_candidates, "kept": len(selected), "dropped": total_candidates - len(selected)})
    doc["timing"] = {"ms": round((time.perf_counter() - started) * 1000), "whyCalls": spine_info["whyCalls"]}
    return doc


def _summary(t: TourRun) -> dict:
    run = t.run
    out: dict[str, Any] = {
        "file": run.meta.get("file"),
        "steps": t.n,
        "exitCode": run.meta.get("exitCode", (run.finished or {}).get("exitCode")),
        "durationMs": run.meta.get("durationMs"),
        "http": len(t.http),
        "llm": sum(1 for r in t.http if r.get("llm")),
        "io": {"http": "recorded" if run.meta.get("config", {}).get("httpObserve", True) is not False else "not recorded (httpObserve off)", "fileWrites": "from the statements' source; the recording has no file event", "subprocess": "from the statements' source; the recording has no process event"},
    }
    if run.recording:
        out["recording"] = run.recording
    return out


__all__ = ["build_tour", "stable_key", "resolve_goal", "DEFAULT_BUDGET", "SMALL_MOMENTS", "VERSION"]
