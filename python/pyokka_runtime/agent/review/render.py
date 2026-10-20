"""Text of a review answer: the header line first, the body, the ``next:`` line last; and the one-line
forms of a stop, an edge candidate, an unreached span, a try and a finding that several actions print."""

from __future__ import annotations

from typing import Any

from ..render import _one_line

VALUE_WIDTH = 100
CODE_LINES = 40
#: the reason ``start --only`` gives the items and edge candidates it sets aside (``scope.narrow``)
ONLY_REASON = "outside --only"


def render_review(result: dict, source: Any, args: Any) -> list[str]:
    lines = [str(result.get("header") or "")]
    lines.extend(str(l) for l in result.get("lines") or [])
    lines.append("next: %s" % result.get("next"))
    return lines


def text(result: dict) -> str:
    return "\n".join(render_review(result, None, None)) + "\n"


# -- pieces --------------------------------------------------------------------------------------------------------

def side_text(value: Any) -> str | None:
    """A fact side: the text itself, or the ``text`` of a ``{text, step}`` dict."""
    if value is None:
        return None
    if isinstance(value, dict):
        t = value.get("text")
        return None if t is None else str(t)
    return str(value)


def fact_text(fact: Any) -> str:
    if fact is None:
        return ""
    if not isinstance(fact, dict):
        return str(fact)
    if fact.get("text"):
        return str(fact["text"])
    name = fact.get("name")
    a, b = side_text(fact.get("a")), side_text(fact.get("b"))
    label = ("%s = " % name) if name else ""
    if a is not None and b is not None:
        return "%s%s → %s" % (label, a, b)
    if b is not None:
        return "%s%s (only in head)" % (label, b)
    if a is not None:
        return "%s%s (only in base)" % (label, a)
    return str(fact.get("kind") or "")


def stop_values(stop: dict, limit: int | None = None) -> list[tuple[str, str]]:
    """A stop's values as ``(name, text)`` pairs: its ``locals`` (named) when the plan has them, else its ``values`` (texts).

    ``limit`` is the last step whose recorded values count (the block's step after ``step_b``, where what
    the stop's statement assigned becomes visible); without it, ``step_b`` itself."""
    cutoff = limit if limit is not None else stop.get("step_b")
    entries = [v for v in stop.get("locals") or [] if not (isinstance(v, dict) and cutoff is not None and v.get("step") is not None and int(v["step"]) > int(cutoff))]
    named = value_pairs(entries)  # the block's values as of the stop, not the ones assigned later
    if named:
        latest: dict[str, str] = {}
        for name, text_ in named:
            latest[name] = text_  # the last recorded text of each name wins, as `values_at` keeps it
        return list(latest.items())
    return value_pairs(stop.get("values"))


def value_pairs(values: Any) -> list[tuple[str, str]]:
    """A stop's ``values`` as ``(name, text)`` pairs, whether they came as strings or as ``{name, text}`` dicts."""
    out: list[tuple[str, str]] = []
    for v in values or []:
        if isinstance(v, dict):
            if v.get("text") is None:
                continue
            out.append((str(v.get("name") or v.get("context") or "value"), str(v["text"])))
        elif isinstance(v, (list, tuple)) and len(v) == 2:
            out.append((str(v[0]), str(v[1])))
        elif v is not None:
            out.append(("value", str(v)))
    return out


def steps_text(stop: dict) -> str:
    a, b = stop.get("step_a"), stop.get("step_b")
    return "  ".join(["a#%s" % a if a is not None else "a –", "b#%s" % b if b is not None else "b –"])


def where(item: dict) -> str:
    loc = "%s:%s" % (item.get("file"), item.get("line")) if item.get("line") is not None else str(item.get("file") or "")
    return ("%s %s" % (loc, item["function"])) if item.get("function") else loc


def item_status(n: Any, shown: set[int], skipped: dict[int, str] | None, ended: bool = False) -> str:
    if n in shown:
        return "shown"
    if skipped and n in skipped:
        return "skipped: %s" % _one_line(skipped[n], 80)
    return "never paused at" if ended else "pending"


def stop_line(stop: dict, shown: set[int], skipped: dict[int, str] | None = None, ended: bool = False) -> str:
    n = stop.get("n")
    if stop.get("spans") is not None:  # a debugger item: a breakpoint, not a recorded step
        return "  %s. %s  %s  %s  (%s)" % (n, stop.get("kind"), where(stop), _one_line(fact_text(stop.get("fact")), VALUE_WIDTH), item_status(n, shown, skipped, ended))
    mark = "  (shown)" if n in shown else ("  (skipped: %s)" % _one_line(skipped[n], 80) if skipped and n in skipped else "")
    return "  %s. %s  %s  %s  %s%s" % (n, stop.get("kind"), where(stop), _one_line(fact_text(stop.get("fact")), VALUE_WIDTH), steps_text(stop), mark)


def value_lines(pairs: list[tuple[str, str]], indent: str = "    ") -> list[str]:
    return ["%s%s = %s" % (indent, name, _one_line(text, VALUE_WIDTH)) for name, text in pairs]


def edge_line(edge: Any) -> str:
    if not isinstance(edge, dict):
        return "  %s" % edge
    what = edge.get("what") or edge.get("text") or edge.get("try") or edge.get("hint") or ""
    tried = edge.get("tried")
    tail = "  (tried %s)" % tried if tried else ""
    return "  %s [%s] %s: %s%s" % (edge.get("id") or "E?", edge.get("kind") or "edge", edge.get("where") or where(edge), _one_line(what, 160), tail)


def unreached_span(item: Any) -> tuple[int | None, int | None]:
    """``(first, last)`` line of an unreached entry, whatever shape it came in: ``start``/``end``, ``span``, ``lines`` (a list or ``"8-10"``), ``line``."""
    if not isinstance(item, dict):
        return None, None
    try:
        if item.get("start") is not None:
            return int(item["start"]), int(item.get("end") if item.get("end") is not None else item["start"])
        span = item.get("span")
        if isinstance(span, (list, tuple)) and span:
            return int(span[0]), int(span[-1])
        lines = item.get("lines")
        if isinstance(lines, str) and lines.strip():
            lo, _, hi = lines.strip().partition("-")
            return int(lo), int(hi or lo)
        if isinstance(lines, (list, tuple)) and lines:
            ls = sorted(int(x) for x in lines)
            return ls[0], ls[-1]
        if item.get("line") is not None:
            return int(item["line"]), int(item["line"])
    except (TypeError, ValueError):
        pass
    return None, None


def unreached_line(item: Any) -> str:
    if not isinstance(item, dict):
        return "  %s" % item
    lo, hi = unreached_span(item)
    lines = ("%d-%d changed lines never ran" % (lo, hi)) if lo is not None and hi != lo else ("%s changed line never ran" % lo if lo is not None else "changed lines never ran")
    text_ = str(item.get("text") or "")
    if "never ran" in text_ or text_.startswith(str(item.get("file") or "\0")):
        text_ = ""  # the sweep's own sentence says what this line says
    return "  %s:%s%s" % (item.get("file"), lines, ("  %s" % _one_line(text_, 80)) if text_ else "")


def try_lines(t: dict, with_code: bool = False) -> list[str]:
    head = "  %s  %s  surface: %s%s" % (t.get("id"), t.get("title") or _one_line((t.get("code") or "").strip().split("\n")[0], 80), t.get("surface") or "headless", ("  edge: %s" % t["edge"]) if t.get("edge") else "")
    out = [head]
    if with_code:
        code = (t.get("code") or "").rstrip("\n").split("\n")
        out.append("    code:")
        out.extend("      " + l for l in code[:CODE_LINES])
        if len(code) > CODE_LINES:
            out.append("      … %d more lines" % (len(code) - CODE_LINES))
        for key in ("inputs", "mocks"):
            if t.get(key):
                out.append("    %s: %s" % (key, _one_line(t[key], 160)))
    if t.get("result") is not None:
        out.append("    result: %s" % _one_line(t["result"], 200))
    for v in t.get("values") or []:
        if isinstance(v, dict) and not (v.get("name") == "result" and t.get("result") is not None):
            out.append("    %s = %s" % (v.get("name"), _one_line(v.get("repr", v.get("text")), VALUE_WIDTH)))
    if t.get("output"):
        out.append("    output: %s" % _one_line(t["output"], 300))
    if t.get("error"):
        out.append("    error: %s" % _one_line(t["error"], 300))
    return out


def repro_text(repro: Any) -> str:
    if not isinstance(repro, dict):
        return str(repro or "none")
    if repro.get("kind") == "try":
        return "try %s%s" % (repro.get("id"), (" (result %s)" % _one_line(repro["result"], 80)) if repro.get("result") is not None else "")
    return "command `%s` → output contains %r" % (repro.get("command"), repro.get("expect"))


def finding_place(f: dict) -> str:
    """``step #57 parse_money``, ``at the pause on orders.py:30 parse_orders`` (the debugger), or for a changed line head never ran, ``never ran in head; reproduced by t3``."""
    pause = f.get("pause")
    if isinstance(pause, dict) and f.get("step") is None:
        return "at the pause on %s:%s%s" % (pause.get("file"), pause.get("line"), (" %s" % pause["function"]) if pause.get("function") else "")
    if f.get("unreached") or f.get("step") is None:
        return "never ran in head; reproduced by %s" % ((f.get("repro") or {}).get("id") if isinstance(f.get("repro"), dict) else "?")
    at = f.get("step_at") or {}
    return "step #%s%s" % (f.get("step"), (" %s" % at["function"]) if at.get("function") else "")


def finding_lines(f: dict) -> list[str]:
    out = [
        "  %s %s  %s:%s  %s  %s" % (f.get("id"), f.get("severity"), f.get("file"), f.get("line"), _one_line(f.get("title"), 120), finding_place(f)),
        "     reproduced: %s" % repro_text(f.get("repro")),
        "     fix: %s" % _one_line(f.get("fix"), 200),
    ]
    if f.get("expect") and (not isinstance(f.get("repro"), dict) or f["repro"].get("kind") == "try"):
        out.insert(2, "     expect: %s" % _one_line(f["expect"], 120))
    return out


def only_line(plan: dict) -> str | None:
    """The filter ``start --only`` applied, as ``start``, ``state`` and ``view`` print it; None for a review without one."""
    paths = [str(p) for p in plan.get("only") or []]
    if not paths:
        return None
    left = [a for a in plan.get("aside") or [] if isinstance(a, dict) and a.get("reason") == ONLY_REASON]
    edges = [e for e in plan.get("aside_edges") or [] if isinstance(e, dict)]
    listed = " (%s%s)" % (", ".join("%s:%s" % (a.get("file"), a.get("line")) for a in left[:8]), ", …" if len(left) > 8 else "") if left else ""
    return "only: %s; outside %s, set aside with no breakpoint: %d item%s%s, %d edge candidate%s" % (
        ", ".join(paths), "it" if len(paths) == 1 else "them", len(left), "" if len(left) == 1 else "s", listed, len(edges), "" if len(edges) == 1 else "s")


def plan_lines(review: Any, with_stops: bool = True) -> list[str]:
    """The stops (shown ones marked), the unreached spans and the edge candidates, as ``start`` and ``state`` print them."""
    plan = review.plan
    shown = {int(x) for x in review.shown}
    skipped = {int(s["n"]): str(s.get("why") or "") for s in review.skipped if isinstance(s, dict) and s.get("n") is not None}
    out: list[str] = []
    if with_stops:
        stops = review.stops
        out.append("stops (%d):" % len(stops) if stops else "stops: none planned (`review ask FILE:LINE --say TEXT` stops at any line that ran)")
        ended = isinstance(review.data.get("ended"), dict)
        out.extend(stop_line(s, shown, skipped, ended) for s in stops)
        if stops:
            agenda = ["shown %s" % (", ".join(str(n) for n in sorted(shown)) or "none"), "skipped %s" % (", ".join(str(n) for n in sorted(skipped)) or "none"), "remaining %s" % (", ".join(str(n) for n in review.remaining()) or "none")]
            if review.waiting is not None:
                agenda.append("waiting for the person since stop %d" % review.waiting)
            if ended:
                agenda.append("the program ended (exit %s)" % (review.data.get("ended") or {}).get("exit"))
            out.append("agenda: " + " · ".join(agenda))
        only = only_line(plan)
        if only:
            out.append(only)
        aside = [a for a in (plan.get("aside") or []) if isinstance(a, dict) and a.get("reason") != ONLY_REASON]
        if aside:
            out.append("set aside, no breakpoint (%d): %s%s" % (len(aside), ", ".join("%s:%s" % (a.get("file"), a.get("line")) for a in aside[:8]), ", …" if len(aside) > 8 else ""))
    unreached = plan.get("unreached") or []
    out.append("unreached changed lines (%d):" % len(unreached) if unreached else "unreached changed lines: none")
    out.extend(unreached_line(u) for u in unreached)
    edges = plan.get("edges") or []
    out.append("edge candidates (%d):" % len(edges) if edges else "edge candidates: none")
    out.extend(edge_line(e) for e in edges)
    return out


def conversation_entry(entry: dict, review: Any) -> str:
    """One line of what happened: a stop shown, a line asked, a stop skipped, a look, a try."""
    kind = entry.get("kind")
    if kind == "stop":
        s = review.stop(int(entry.get("n", -1))) or {}
        return "stop %s (%s %s): %s" % (entry.get("n"), s.get("kind"), where(s), entry.get("say"))
    if kind == "ask":
        return "asked %s:%s (step #%s): %s" % (entry.get("file"), entry.get("line"), entry.get("step"), entry.get("say"))
    if kind == "skip":
        return "skipped stop %s: %s" % (entry.get("n"), entry.get("why"))
    if kind == "look":
        value = entry.get("value")
        return "looked at %s at step #%s%s" % (entry.get("expr"), entry.get("step"), (" = %s" % _one_line(value, 120)) if value is not None else " (not evaluated)")
    if kind == "try":
        what = entry.get("error") or entry.get("result")
        return "try %s%s%s" % (entry.get("id"), (" %s" % entry["title"]) if entry.get("title") else "", (": %s" % _one_line(what, 120)) if what is not None else "")
    return str(entry)


def conversation_lines(review: Any) -> list[str]:
    entries = [e for e in review.conversation if isinstance(e, dict)]
    out = ["what we looked at (%d):" % len(entries) if entries else "what we looked at: nothing yet"]
    out.extend("  " + conversation_entry(e, review) for e in entries)
    return out


__all__ = ["ONLY_REASON", "only_line", "render_review", "text", "side_text", "fact_text", "stop_values", "value_pairs", "steps_text", "where", "item_status", "stop_line", "value_lines", "edge_line", "unreached_span", "unreached_line", "try_lines", "repro_text", "finding_place", "finding_lines", "plan_lines", "conversation_entry", "conversation_lines"]
