"""``pyokka origin`` as text: the error, the value, one line per link newest first, the root and where the chain ends."""

from __future__ import annotations

from typing import Any

from ..recording import cut_line

VALUE_MAX = 60
EXPR_MAX = 70


def _loc(source: Any, file: str | None, line: int | None) -> str:
    name = source.display_path(file) if hasattr(source, "display_path") else (file or "<unknown>")
    return "%s:%s" % (name, line) if line else name


def _value(text: Any) -> str:
    return cut_line(text, VALUE_MAX, strip=True)


def render_origin(result: dict, source: Any, args: Any) -> list[str]:
    where = "#%s %s %s" % (result.get("step"), _loc(source, result.get("file"), result.get("line")), result.get("function") or "<module>")
    error = result.get("error")
    out: list[str] = []
    if error:
        out.append("%s at %s: %s%s" % (error.get("type"), where, error.get("message"), " (caught)" if error.get("caught") else ""))
    else:
        value = result.get("value") or {}
        out.append("origin of %s at %s" % (value.get("expr") or "?", where) if value else "origin at %s" % where)
    if result.get("statement"):
        out.append("  %s" % cut_line(result["statement"], 100, strip=True))
    value = result.get("value")
    if value:
        line = "the value: %s = %s" % (value.get("expr"), _value(value.get("text")))
        if result.get("need"):
            line += ", where the statement needs %s" % result["need"]
        out.append(line)
    links = result.get("links") or []
    if links:
        out.append("where from, newest first:")
        locs = ["#%s %s %s" % (l.get("step"), _loc(source, l.get("file"), l.get("line")), l.get("function") or "<module>") for l in links]
        width = min(48, max(len(s) for s in locs))
        prev_text: Any = object()
        for l, loc in zip(links, locs):
            expr = cut_line(l.get("expr") or "", EXPR_MAX, strip=True)
            text = l.get("text")
            if l.get("how") == "literal":
                shown = expr if l.get("certainty") == "text match" or not l.get("statement") else cut_line(l["statement"], EXPR_MAX, strip=True)
            elif l.get("how") == "assigned" and l.get("statement"):
                stmt = cut_line(l["statement"], EXPR_MAX, strip=True)
                shown = stmt if text is None or text == prev_text else "%s   → %s" % (stmt, _value(text))
            else:
                shown = expr if text is None or text == prev_text else "%s = %s" % (expr, _value(text))
            prev_text = text
            how = str(l.get("how"))
            if l.get("certainty") and l["certainty"] != "recorded":
                how += ", " + str(l["certainty"])
            if l.get("note"):
                how += ": " + str(l["note"])
            mark = "▶ " if l.get("root") else "  "
            out.append("%s%s   %s   (%s)%s" % (mark, loc.ljust(width), shown, how, "   ◀ root" if l.get("root") else ""))
            for i in l.get("inputs") or []:
                out.append("  %s     ← %s = %s" % (" " * width, i.get("name"), _value(i.get("text"))))
    reads = result.get("reads")
    if reads:
        out.append("the statement read:")
        for r in reads:
            out.append("  %s = %s%s" % (r.get("name"), _value(r.get("text")) if r.get("text") is not None else "?", "   #%s" % r["step"] if r.get("step") is not None else ""))
    root = result.get("root")
    if root:
        link = links[root["index"]] if 0 <= int(root.get("index", -1)) < len(links) else {}
        out.append("root: #%s %s %s: %s" % (root.get("step"), _loc(source, link.get("file"), link.get("line")), link.get("function") or "<module>", root.get("reason")))
    if result.get("rootUnknown"):
        out.append("root: not known; %s" % result["rootUnknown"].split(", so ")[0])
    if result.get("end"):
        out.append("chain ends: %s" % result["end"])
    if result.get("hint"):
        out.append(str(result["hint"]))
    if links and any(l.get("certainty") != "recorded" for l in links):
        out.append("inferred: picked by value among the statement's candidates; text match: by text only. The recording keeps values as text, not object identity.")
    return out


__all__ = ["render_origin"]
