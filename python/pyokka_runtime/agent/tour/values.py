"""What the program held at a candidate, and how it is shaped so the candidates fit a prompt.

Gathering, per step, from the recording only: the parameters a scope entered with (``in``), the
names the statement bound (``set``), values it logged (``value``), what it printed (``printed``),
what each call it made returned (``call``), what its function returned or raised there
(``returned``, ``raised``), the arm a branch took (``took``), the HTTP request it made (``http``).

Shaping, over the kept candidates in run order:

- left out: ``self``/``cls``, bound methods, ``<function … at 0x…>``, modules, and a value that
  only repeats the statement (``k = 60`` on ``k = 60``);
- a value equal to an earlier one (40 characters or more) becomes ``sameAs`` that value's id;
- a value of 200 characters or more sharing most of its text with the previous value of the same
  name (a message list that grew by one turn) shows only the window that differs, with offsets;
- a value over ``VALUE_CUT`` characters is cut there, and carries ``evidence``: up to two
  sentences of the full text that share the most words and numbers with the goal (the program's
  output, or the ``--goal`` value), with offsets into the full text.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .model import TourRun

VALUE_CUT = 300
EVIDENCE_MAX = 240
SAME_MIN = 40
NEAR_MIN = 200
NEAR_PAD = 40
MAX_VALUES = 6
WORD = re.compile(r"[A-Za-z_]{3,}|\d+(?:\.\d+)?")
NOISE = re.compile(r"^<bound method |^<function [\w.<>]+ at 0x[0-9a-f]+>$|^<module '|^<class '|^<built-in (function|method) |^<method-wrapper ")
_VALUE_KINDS = ("value", "autoLog", "logpoint")
RECORDING_CUT = re.compile(r"…\((cut|\+[\d,]+ chars)\)$")


def gather(t: "TourRun", i: int) -> list[dict]:
    """``[{role, name, text}]`` at step ``i``, in the order above, without the left-out kinds."""
    out: list[dict] = []
    for role, name, text in t.changes.get(i, ()):
        out.append({"role": role, "name": name, "text": text})
    rid = t.trace.rid(i)
    for ev in t.run.logs_by_rid.get(rid, ()):
        if ev.get("step") is None or int(ev["step"]) != i:
            continue
        if ev.get("kind") == "log":
            out.append({"role": "printed", "name": "output", "text": str(ev.get("text") or "")})
        elif ev.get("kind") in _VALUE_KINDS:
            out.append({"role": "value", "name": str(ev.get("context") or "value"), "text": str(ev.get("text") or "")})
    called: set[str] = set()
    for call in t.calls_made(i):
        fn_name = t.scope_function(int(call["scopeId"]))
        if fn_name in called:
            continue  # a comprehension calling one function per item: its first result stands for the rest
        called.add(fn_name)
        text = call.get("returned")
        if text is None:
            m = t.call_by_entry.get(int(call["first"]))
            text = next((v["text"] for v in (m or {}).get("values", []) if v.get("role") == "out" and v.get("name") == "return"), None)
        fn = "%s()" % fn_name.rsplit(".", 1)[-1]
        if text is not None:
            out.append({"role": "call", "name": fn, "text": str(text)})
        elif call.get("raised"):
            out.append({"role": "call", "name": fn, "text": "raised %s" % call["raised"]})
    sid = t.scope[i]
    s = t.scopes.get(sid)
    if s is not None and t.scope_last(sid) == i and int(s.get("parent", -1)) >= 0:
        if s.get("returned") is not None:
            out.append({"role": "returned", "name": "%s returned" % t.scope_function(sid).rsplit(".", 1)[-1], "text": str(s["returned"])})
        elif s.get("raised"):
            out.append({"role": "raised", "name": "%s raised" % t.scope_function(sid).rsplit(".", 1)[-1], "text": str(s["raised"])})
    for r in t.http:
        if int(r["step"]) == i:
            out.append({"role": "http", "name": "request %s" % r.get("n"), "text": "%s %s -> %s, %s bytes, %s ms, %s" % (r.get("method"), r.get("url"), r.get("status"), r.get("bytes"), r.get("ms"), r.get("source"))})
    for ev in t.run.errors:
        if ev.get("step") is not None and int(ev["step"]) == i:
            out.append({"role": "raised", "name": str(ev.get("errorType") or "error"), "text": "%s: %s%s" % (ev.get("errorType"), ev.get("message"), "" if not ev.get("handled") else " (handled)")})
            break
    for m in t.decisions_at(i):
        out.append({"role": "took", "name": "branch", "text": m["text"]})
    statement = " ".join(t.text(i).split())
    kept: list[dict] = []
    seen: set[str] = set()
    for v in out:
        name, text = v["name"], v["text"]
        if name in ("self", "cls") or NOISE.search(text):
            continue
        if text.strip() == statement or " ".join(("%s = %s" % (name, text)).split()) == statement:
            continue
        inner = " ".join((text[1:-1] if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"" else text).split())
        if len(inner) >= 3 and (v["role"] == "printed" or inner != text) and inner in statement:
            continue  # a literal the statement spells out (`print("RESULTS")`, `mode = "fast"`)
        if text in seen and len(text) >= SAME_MIN:
            continue  # `x = f()` binds what f returned: one copy
        seen.add(text)
        kept.append(v)
    return kept[:MAX_VALUES]


STOP = set("the and for with that this from are was were has have had not but its into per via use uses used than then there their they them what which when where who will would can could should may also more most such only other some any all one two out our your his her she him you".split())


def tokens(text: str) -> set[str]:
    """Words of three letters or more and numbers, lowercased, without common English words."""
    return {w.lower() for w in WORD.findall(text or "")} - STOP


def evidence(text: str, goal: set[str], n: int = 2, start_at: int = 0) -> list[dict]:
    """Up to ``n`` sentences of ``text`` starting at or after ``start_at`` that share the most goal
    words (a number counts 3; a sentence needs a score of 4 from two words or more), in text order."""
    if not goal:
        return []
    spans, start = [], 0
    for m in re.finditer(r"(?<=[.!?])\s+|\\n|\n", text):
        spans.append((start, m.start()))
        start = m.end()
    spans.append((start, len(text)))
    scored = []
    for a, b in spans:
        if b - a < 20 or a < start_at:
            continue
        found = tokens(text[a:b]) & goal
        score = sum(3 if w[0].isdigit() else 1 for w in found)
        if score >= 4 and len(found) >= 2:
            scored.append((score, a, min(b, a + EVIDENCE_MAX)))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [{"from": a, "to": b, "text": text[a:b]} for _, a, b in sorted(scored[:n], key=lambda x: x[1])]


def shape(candidates: list[dict], goal: set[str]) -> None:
    """Number each candidate's values ``v1..`` and apply the repeat, near-repeat and cut rules in place."""
    first_of: dict[str, str] = {}
    last_by_name: dict[str, tuple[str, str]] = {}
    for c in sorted(candidates, key=lambda c: c["step"]):
        shaped = []
        for k, v in enumerate(c.pop("_values", c.get("values") or []), 1):
            vid = "%s.v%d" % (c["id"], k)
            text = v["text"]
            out: dict[str, Any] = {"id": vid, "role": v["role"], "name": v["name"], "length": len(text)}
            whole = not RECORDING_CUT.search(text)  # two values cut by the recording may differ past the cut
            if whole and len(text) >= SAME_MIN and text in first_of:
                out["sameAs"] = first_of[text]
                shaped.append(out)
                continue
            if whole and len(text) >= SAME_MIN:
                first_of[text] = vid
            prev = last_by_name.get(v["name"])
            last_by_name[v["name"]] = (vid, text)
            if prev is not None and len(text) >= NEAR_MIN and len(prev[1]) >= NEAR_MIN:
                p = _common_prefix(prev[1], text)
                q = _common_suffix(prev[1][p:], text[p:])
                if p + q >= 0.5 * len(text):
                    a, b = max(0, p - NEAR_PAD), min(len(text), len(text) - q + NEAR_PAD)
                    out.update({"like": prev[0], "from": a, "to": b, "text": text[a:b]})
                    if b - a > VALUE_CUT:
                        out["text"] = text[a:a + VALUE_CUT]
                        out["to"] = a + VALUE_CUT
                        out["cut"] = True
                    shaped.append(out)
                    continue
            if len(text) > VALUE_CUT:
                out["text"] = text[:VALUE_CUT]
                out["cut"] = True
                ev = evidence(text, goal, start_at=VALUE_CUT - 50)
                if ev:
                    out["evidence"] = ev
            else:
                out["text"] = text
            shaped.append(out)
        c["values"] = shaped


def _common_prefix(a: str, b: str) -> int:
    n = min(len(a), len(b))
    k = 0
    while k < n and a[k] == b[k]:
        k += 1
    return k


def _common_suffix(a: str, b: str) -> int:
    n = min(len(a), len(b))
    k = 0
    while k < n and a[-1 - k] == b[-1 - k]:
        k += 1
    return k


__all__ = ["gather", "shape", "evidence", "tokens", "VALUE_CUT"]
