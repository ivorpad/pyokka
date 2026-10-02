"""``pyokka graph --dot``: the execution graph of ``graph.py`` as a Graphviz digraph.

Modules and functions are records (the label and location, then one row per line), packages
are folders, decisions diamonds, statements plain boxes with a monospace label (their rows
under it), each hung from its parent by a dotted link; call edges carry ``×N``, tool edges say
so, data edges are dashed and carry the name. Labels are escaped for Graphviz; the CLI
redacts them.
"""

from __future__ import annotations

from .graph import row_text

_RECORD_SPECIALS = "{}|<>"


def escape(text: str, record: bool = False) -> str:
    s = str(text).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    if record:
        for ch in _RECORD_SPECIALS:
            s = s.replace(ch, "\\" + ch)
    return s


def _where(n: dict) -> str:
    file = n.get("file")
    if not file:
        return ""
    name = str(file).rsplit("/", 1)[-1]
    return "%s:%s" % (name, n["line"]) if n.get("line") else name


def render_dot(result: dict) -> str:
    lines = ["digraph run {", "  rankdir=TB;", '  node [fontname="Helvetica", fontsize=10];', '  edge [fontname="Helvetica", fontsize=9];']
    links: list[str] = []
    for n in result["nodes"]:
        rows = "".join(escape(row_text(r), record=True) + "\\l" for r in n["rows"])
        if n["kind"] == "decision":
            label = escape(n["text"]) + ("\\nnot run: " + ", ".join(str(l) for l in n["notRun"]) if n["notRun"] else "")
            lines.append('  %s [shape=diamond, label="%s"];' % (n["id"], label))
            links.append("  %s -> %s [style=dotted, arrowhead=none];" % (n["parent"], n["id"]))
        elif n["kind"] == "statement":
            label = escape(n["label"]) + "".join("\\n" + escape(row_text(r)) for r in n["rows"])
            lines.append('  %s [shape=box, fontname="Courier", label="%s"];' % (n["id"], label))
            links.append("  %s -> %s [style=dotted, arrowhead=none];" % (n["parent"], n["id"]))
        elif n["kind"] == "package":
            head = escape("%s ×%d" % (n["label"], n["calls"])) + ("\\n%d nested" % n["nested"] if n.get("nested") is not None else "") + ("\\n" + escape(_where(n)) if n.get("more") else "")
            lines.append('  %s [shape=folder, label="%s"];' % (n["id"], head))
        else:
            head = escape("%s ×%d" % (n["label"], n["calls"]), record=True) + "\\n" + escape(_where(n), record=True)
            lines.append('  %s [shape=record, label="{%s%s}"];' % (n["id"], head, ("|" + rows) if rows else ""))
    lines.extend(links)
    for e in result["edges"]:
        if e["kind"] == "data":
            lines.append('  %s -> %s [style=dashed, label="%s"];' % (e["from"], e["to"], escape(e["label"])))
        else:
            lines.append('  %s -> %s [label="%s×%d"];' % (e["from"], e["to"], "tool " if e["kind"] == "tool" else "", e["count"]))
    lines.append("}")
    return "\n".join(lines)


__all__ = ["render_dot", "escape"]
