"""Which candidates stay: novelty for repeated lines, a score per candidate, and the token budget.

Novelty: a source line that ran again is a new candidate only when the call it made (or, for a
return, the call it returns from) had arguments not seen on that line before, at most
``NEW_ARGS_MAX`` argument sets per line; an HTTP request is always new.

Score: the weight of the strongest signal, +0.5 per further signal, -0.25 for each earlier pass
of the same line (at most -1.5), so the first pass of a loop or of concurrent requests outranks
the rest. Setup (a settings object, a validation or cross-check, keyword plumbing, a cache
key) weighs ``SETUP_FACTOR`` of that, so it is the first to go when the budget cuts.

Budget: the tour's JSON is estimated at a token per 4 characters. While it is over, the lowest
scored candidate goes, except that each chapter keeps its best ``KEEP_PER_CHAPTER``.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .model import TourRun

WEIGHT = {
    ("io", "http"): 4, ("chapter", "start"): 4, ("io", "response"): 4, ("chapter", "result"): 3,
    ("exception", "raised"): 3, ("exception", "handled"): 3,
    ("crossing", "callback-in"): 3, ("crossing", "callback-out"): 3,
    ("narrative", "binds"): 3, ("io", "file-write"): 3, ("io", "subprocess"): 3,
    ("exception", "rare-arm"): 2, ("evidence", "goal-words"): 3, ("narrative", "text-in"): 2,
("spine", "return"): 1.5, ("spine", "why"): 1, ("spine", "goal"): 5,
    ("crossing", "lib-call"): 1,
}
SCRIPT_SPINE = 3  # the script's own statements on the spine
NEW_ARGS_MAX = 4
REPEAT_STEP = 0.25  # each later pass of a line weighs this much less, for at most REPEAT_STEPS passes
REPEAT_STEPS = 6
SETUP_FACTOR = 0.4
KEEP_PER_CHAPTER = 3
CHARS_PER_TOKEN = 4

_SETUP_FN = re.compile(r"^_*(__init__|__post_init__|init|setup|set_up|configure|config|settings|options|defaults?|validate\w*|check\w*|ensure\w*|verify\w*|sanitize\w*|normalize\w*|\w*_kwargs|\w*_config|\w*_options|\w*_settings|\w*cache_key\w*|make_key)$")
_SETUP_TEXT = re.compile(r"SimpleNamespace\(|\b\w*(Config|Settings|Options)\(|\w_kwargs\b|cache_key|os\.environ|getenv\(|^assert\b|isinstance\(|\.setdefault\(")


def is_setup(t: "TourRun", i: int) -> bool:
    """A step whose function or statement prepares rather than does: the rules in the module docstring."""
    fn = t.function(i).rsplit(".", 1)[-1]
    return bool(_SETUP_FN.match(fn) or _SETUP_TEXT.search(t.text(i)))


def call_args(t: "TourRun") -> dict[int, tuple]:
    """entry step -> the arguments the call entered with, as recorded texts."""
    out: dict[int, tuple] = {}
    for m in t.calls:
        out[int(m["entryStep"])] = tuple(v["text"] for v in m["values"] if v.get("role") == "in")
    return out


def novel(t: "TourRun", pooled: dict[int, dict]) -> list[dict]:
    """The pooled candidates a repeated line still earns, in step order, each with ``repeat`` set when it is a later pass."""
    args = call_args(t)
    seen: dict[tuple, list] = {}
    passes: dict[tuple, int] = {}
    out: list[dict] = []
    for st in sorted(pooled):
        c = pooled[st]
        key = (t.fid[st], t.line[st])
        a = args.get(st)
        if a is None and t.scope_last(t.scope[st]) == st:
            a = args.get(t.by_scope[t.scope[st]][0])  # a return: the call it returns from
        if a is None and st + 1 < t.n and t.entry[st + 1] and t.parent(t.scope[st + 1]) == t.scope[st]:
            a = args.get(st + 1)  # the call this statement makes
        for v in c.get("valuesFrom") or ():
            if a is None and t.scope_last(t.scope[v]) == v:
                a = args.get(t.by_scope[t.scope[v]][0])  # a response or a result landing: the call it came from
        prev = seen.setdefault(key, [])
        http = bool(c["subs"] & {("io", "http"), ("io", "response")})
        if prev and not http and (a is None or a in prev or len(prev) >= NEW_ARGS_MAX):
            continue
        prev.append(a)
        p = t.parent(t.scope[st])
        path = (key, t.scope_function(p) if p >= 0 else "", t.scope_function(t.parent(p)) if p >= 0 and t.parent(p) >= 0 else "")
        c["repeat"] = passes.get(path, 0)  # the same line reached by another caller counts as a first pass
        passes[path] = c["repeat"] + 1
        out.append(c)
    return out


def score(t: "TourRun", c: dict) -> float:
    ws = []
    for sub in c["subs"]:
        w = WEIGHT.get(sub, 1)
        if sub[0] == "spine" and t.fid[c["step"]] == t.main_fid:
            w = max(w, SCRIPT_SPINE)
        ws.append(w)
    signals = {s for s, _ in c["subs"]}
    s = max(ws) + 0.5 * (len(signals) - 1) - REPEAT_STEP * min(int(c.get("repeat") or 0), REPEAT_STEPS)
    if c.get("setup"):
        s *= SETUP_FACTOR
    return round(s, 2)


def fit(candidates: list[dict], size_of, budget_tokens: int, fixed_chars: int) -> list[dict]:
    """Keep the best scored candidates of each chapter within an equal share of the budget.

    Shares are filled smallest chapter first, so what a small chapter leaves unused goes to the
    others; inside a share the candidates go by score, and each chapter keeps its best
    ``KEEP_PER_CHAPTER`` whatever they weigh."""
    budget_chars = budget_tokens * CHARS_PER_TOKEN - fixed_chars
    sizes = {id(c): size_of(c) for c in candidates}
    if sum(sizes.values()) <= budget_chars:
        return candidates
    by_chapter: dict[str, list[dict]] = {}
    for c in candidates:
        by_chapter.setdefault(c["chapter"], []).append(c)
    groups = sorted(by_chapter.values(), key=lambda g: sum(sizes[id(c)] for c in g))
    remaining = budget_chars
    kept: set[int] = set()
    for k, group in enumerate(groups):
        share = max(0, remaining) / (len(groups) - k)
        used = 0
        for n, c in enumerate(sorted(group, key=lambda c: (-c["score"], c["step"]))):
            if n >= KEEP_PER_CHAPTER and used + sizes[id(c)] > share:
                continue
            kept.add(id(c))
            used += sizes[id(c)]
        remaining -= used
    return [c for c in candidates if id(c) in kept]


__all__ = ["novel", "score", "fit", "is_setup", "WEIGHT"]
