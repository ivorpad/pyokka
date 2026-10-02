"""The tour's signals: each proposes steps worth a stop, with the reason it proposes them.

- ``spine``: ``why`` backwards from the goal (the program's output, or ``--goal``), then from the
  return of every project callee on the way; ``def`` lines and pass-through returns are dropped.
- ``crossing``: a callback a library made into the project directly (its entry and its return;
  a callback made from inside another callback is left out), and every statement of the project
  that calls into a library.
- ``io``: HTTP requests (the recording's ``http.exchange`` rows), file writes and subprocess calls
  (found in the statement's source: the recording has no event for them).
- ``exception``: every raise, handled or not, and a branch arm taken in at most 20% of 3 or more
  passes. Arms never taken and loops that ran zero times are not signals.
- ``narrative``: statements of an orchestrating frame (own steps spanning max(40, 2% of the run))
  that keep a call's result, first pass per line.
- ``chapter``: the step each chapter starts at.

The ablation behind these rules: ``docs/TOUR.md``.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from ..provenance import ProvenanceBuilder
from .astinfo import binds_call, classify_call, is_definition, is_forward, own_calls
from .chapters import is_anon

if TYPE_CHECKING:
    from .model import TourRun

SPINE_BUDGET = 25  # `why` trees per tour
RARE_SHARE = 0.2
RARE_MIN_HITS = 3
RARE_FIRST = 3  # passes of a rare arm proposed
DECISION = re.compile(r" took (True|False)$")
CONTROL_FLOW = {"StopIteration", "StopAsyncIteration", "GeneratorExit", "CancelledError"}
EVIDENCE_TOP = 12
PROSE_MIN = 300


class Pool:
    """Candidates by step: ``{step, subs: {(signal, sub)}, reasons: [str]}``."""

    def __init__(self, t: "TourRun") -> None:
        self.t = t
        self.by_step: dict[int, dict] = {}

    def add(self, step: int, signal: str, sub: str, reason: str, values_from: tuple[int, ...] = ()) -> None:
        """``values_from``: other steps whose values belong on this candidate (the call whose result lands here)."""
        if not 0 <= step < self.t.n:
            return
        c = self.by_step.setdefault(step, {"step": step, "subs": set(), "reasons": {}, "valuesFrom": []})
        c["subs"].add((signal, sub))
        c["reasons"].setdefault("%s:%s" % (signal, sub), reason)
        c["valuesFrom"].extend(s for s in values_from if s not in c["valuesFrom"] and s != step)


def _why_nodes(node: Any, out: list[dict]) -> None:
    if not isinstance(node, dict):
        return
    if node.get("step") is not None:
        out.append(node)
    for r in node.get("reads") or []:
        _why_nodes(r, out)


def spine(t: "TourRun", pool: Pool, seeds: list[int], budget: int = SPINE_BUDGET) -> dict:
    """Walk ``why`` from each seed (the first is the goal); returns ``{goal, whyCalls}``."""
    builder = ProvenanceBuilder(t.run)
    queue = list(seeds)
    seen: set[int] = set()
    calls = 0
    while queue and calls < budget:
        st = queue.pop(0)
        if st in seen or not 0 <= st < t.n:
            continue
        seen.add(st)
        tree = builder.build("", st, 5, 60)
        calls += 1
        nodes: list[dict] = []
        _why_nodes(tree.get("root"), nodes)
        for node in nodes:
            s = int(node["step"])
            text = t.text(s)
            if not is_definition(t.stmt(s), text):
                pool.add(s, "spine", "why", "%s = %s" % (node.get("name") or "statement", _short(node.get("text"))) if node.get("name") else "on the way to the goal")
            for call in node.get("calls") or []:
                rs = call.get("returnStep")
                if rs is None or is_anon(str(call.get("name") or "")):
                    continue
                rs = int(rs)
                if not is_forward(t.stmt(rs)) and not is_definition(t.stmt(rs), t.text(rs)):
                    pool.add(rs, "spine", "return", "%s returns the value the goal is built from" % call.get("name"))
                queue.append(rs)
    return {"whyCalls": calls}


def crossings(t: "TourRun", pool: Pool) -> None:
    tools = {int(m["scopeId"]): m for m in t.calls if m["kind"] == "tool"}

    def nested(m: dict) -> bool:
        """Called back from inside a callback of the same function (recursion through a library helper)."""
        fn = m["callee"]["function"]
        s = int(m.get("callerScopeId", -1))
        for _ in range(64):
            if s < 0:
                return False
            if s in tools and tools[s]["callee"]["function"] == fn:
                return True
            s = t.parent(s)
        return False

    for sid, m in tools.items():
        fn = m["callee"]["function"]
        short = fn.rsplit(".", 1)[-1]
        if is_anon(fn) or (short.startswith("__") and short.endswith("__")) or nested(m):
            continue
        entry = int(m["entryStep"])
        pool.add(entry, "crossing", "callback-in", "a library calls %s" % fn)
        last = t.scope_last(sid)
        if last > entry:
            pool.add(last, "crossing", "callback-out", "%s returns to the library" % fn)
    for i in range(t.n):
        fid = t.fid[i]
        if fid < 0 or not t.user(fid):
            continue
        stmt = t.stmt(i)
        if stmt is None:
            continue
        info = t.info(fid)
        nxt = t.function(i + 1) if i + 1 < t.n and t.entry[i + 1] else None
        for call in own_calls(stmt):
            kind, label = classify_call(call, info, t.roots, t.defs, nxt)
            if kind == "lib":
                pool.add(i, "crossing", "lib-call", "calls %s" % label)
                break
            if kind in ("io-write", "subprocess"):
                pool.add(i, "io", "file-write" if kind == "io-write" else "subprocess", "%s %s" % ("writes with" if kind == "io-write" else "runs", label))
                break


def io(t: "TourRun", pool: Pool) -> None:
    """Each HTTP request at the statement that made it, and its response where the reply lands."""
    for r in t.http:
        st = int(r["step"])
        what = "%s %s %s%s" % (r.get("method"), r.get("name"), r.get("status"), " (model call)" if r.get("llm") else "")
        pool.add(st, "io", "http", what)
        sid = t.scope[st]
        if t.parent(sid) >= 0:
            pool.add(t.landing(sid), "io", "response", "the response of %s lands" % what, (t.scope_last(sid),))


def exceptions(t: "TourRun", pool: Pool) -> None:
    by_line: dict[tuple, list[tuple[int, str]]] = {}
    for m in t.moments:
        if m["kind"] == "error":
            etype = m["text"].split(" ", 2)[1].rstrip(":") if m["text"].startswith("raised ") else ""
            if etype not in CONTROL_FLOW:
                pool.add(int(m["step"]), "exception", "handled" if ", handled" in m["text"] or "(handled)" in m["text"] else "raised", m["text"])
        elif m["kind"] == "decision":
            hit = DECISION.search(m["text"])
            if hit:
                key = (m["location"].get("fileId"), m["location"].get("line"))
                by_line.setdefault(key, []).append((int(m["step"]), hit.group(1)))
    for hits in by_line.values():
        if len(hits) < RARE_MIN_HITS:
            continue
        arms: dict[str, list[int]] = {}
        for st, arm in hits:
            arms.setdefault(arm, []).append(st)
        if len(arms) != 2:
            continue
        for arm, steps in arms.items():
            if len(steps) / len(hits) <= RARE_SHARE:
                for st in steps[:RARE_FIRST]:
                    pool.add(st, "exception", "rare-arm", "took %s in %d of %d passes" % (arm, len(steps), len(hits)))


def narrative(t: "TourRun", pool: Pool) -> None:
    span_min = max(40, 0.02 * t.n)
    for sid, steps in t.by_scope.items():
        if steps[-1] - steps[0] < span_min:
            continue
        seen: set[int] = set()
        for st in steps:
            line = t.line[st]
            if line in seen or not t.user(t.fid[st]):
                continue
            if binds_call(t.stmt(st)):
                seen.add(line)
                pool.add(st, "narrative", "binds", "%s keeps a call's result" % t.function(st))


def evidence(t: "TourRun", pool: Pool, goal_text: str, top: int = EVIDENCE_TOP) -> None:
    """The values that share the most words and numbers with the goal (a number counts 3), first
    step of each distinct text, the best ``top`` of them: where the answer's facts were before
    they were the answer. A value that holds the goal's own text is the answer, not evidence."""
    from .values import tokens

    goal = tokens(goal_text)
    if not goal:
        return
    flat = " ".join(goal_text.split())
    probe = flat[len(flat) // 2 - 12: len(flat) // 2 + 12] if len(flat) >= 40 else None
    best: dict[str, tuple[int, int, str, list[str]]] = {}
    for step, rows in t.changes.items():
        if not t.user(t.fid[step]):
            continue
        for _, name, text in rows:
            if len(text) < 40 or text in best or (probe and probe in " ".join(text.split())):
                continue
            found = tokens(text) & goal
            score = sum(3 if w[0].isdigit() else 1 for w in found)
            if score >= 4 and len(found) >= 2:
                best[text] = (score, step, name, sorted(found))
    ranked = sorted(best.values(), key=lambda x: (-x[0], x[1]))[:top]
    for score, step, name, found in ranked:
        pool.add(step, "evidence", "goal-words", "%s shares %s with the goal" % (name, ", ".join(found[:6])))


def prose_in(t: "TourRun", pool: Pool) -> None:
    """A call that receives a long text (a prompt, instructions, a page), the first time that text goes into a call."""
    seen: set[str] = set()
    for step, rows in t.changes.items():
        for role, name, text in rows:
            if role != "in" or len(text) < PROSE_MIN or text in seen or text[:1] not in "'\"":
                continue
            seen.add(text)
            letters = sum(ch.isalpha() or ch == " " for ch in text)
            if letters >= 0.7 * len(text) and t.user(t.fid[step]):
                pool.add(step, "narrative", "text-in", "%s receives %s, %d characters of text" % (t.function(step), name, len(text)))


def _short(text: Any, limit: int = 60) -> str:
    s = " ".join(str(text if text is not None else "?").split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


__all__ = ["Pool", "spine", "crossings", "io", "exceptions", "narrative"]
