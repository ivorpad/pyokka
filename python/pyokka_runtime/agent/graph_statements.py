"""The statement nodes of the execution graph (``docs/PROTOCOL.md``, "statement"), for ``graph.py``.

One node per simple statement a step ran in a user-code scope: its source (comments gone),
the names it assigns and reads (``names.py``), its hits, then its rows (the logged value, the
print, the raise) and the data edges from the statement that last assigned a name to the
statements and decisions that read it. The functions take the builder of ``graph.py`` and
fill its tables; ``src/session/executionGraph.ts`` does the same in the same order.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from .decisions import collapse
from .names import names_of, strip_comments

STATEMENTS_MAX = 60
LABEL_MAX = 60
TEXT_MAX = 200

_DOCSTRING = re.compile(r"^[A-Za-z]{0,2}['\"]")
_NOT_STATEMENTS = ("pass", "break", "continue")
NODE_RANK = {"module": 0, "function": 1, "package": 1, "decision": 2, "statement": 2}


# -- rows -----------------------------------------------------------------------------------------------------

def row(kind: str, name: str, text: str, step: int) -> dict:
    return {"kind": kind, "name": name, "text": text, "step": step}


def raised(text: str) -> tuple[str, str]:
    """``ValueError: too small: 6`` -> ``("ValueError", "too small: 6")``; no message -> ``""``."""
    name, _, rest = text.partition(": ")
    return name, rest


def error_row(text: str, step: int) -> dict:
    """An error moment's sentence (``raised X: m, handled at f:l`` / ``… (handled)`` / ``… uncaught``) as a row."""
    s = text[len("raised "):] if text.startswith("raised ") else text
    if s.endswith(" uncaught"):
        s = s[: -len(" uncaught")]
    elif s.endswith(" (handled)"):
        s = s[: -len(" (handled)")]
    else:
        i = s.rfind(", handled at ")
        if i >= 0:
            s = s[:i]
    name, message = raised(s)
    return row("raised", name, message, step)


def print_row(text: str, step: int) -> dict:
    """A print moment's sentence (``prints x`` / ``prints to stderr x``) as a row."""
    if text.startswith("prints to stderr "):
        return row("print", "stderr", text[len("prints to stderr "):], step)
    return row("print", "stdout", text[len("prints "):] if text.startswith("prints ") else text, step)


# -- the source of a statement --------------------------------------------------------------------------------

def range_lines(lines: list[str], r: list[int]) -> list[str]:
    """The raw lines of a range: the first from its column, the last to its end column (``rangeText`` in ``decisions.ts``)."""
    a, ca, b, cb = int(r[0]), int(r[1]), int(r[2]), int(r[3])
    if a < 1 or b < a or b > len(lines):
        return []
    if a == b:
        return [lines[a - 1][ca:cb]]
    return [lines[a - 1][ca:]] + lines[a : b - 1] + [lines[b - 1][:cb]]


def not_a_statement(lines: list[str], rng: list[int]) -> bool:
    """Compound headers (the first code line ends with ``:``, or a ``:`` follows the range, closing
    parentheses skipped: a header range stops at its test), imports, ``pass``/``break``/``continue``/
    ``global``/``nonlocal`` and docstrings make no node."""
    first = strip_comments([lines[int(rng[0]) - 1][int(rng[1]):]])[0].strip()
    after = strip_comments([lines[int(rng[2]) - 1][int(rng[3]):]])[0].lstrip(") \t")
    if not first or first.endswith(":") or after.startswith(":"):
        return True
    if first.startswith("import ") or first.startswith("from ") or first.startswith("global ") or first.startswith("nonlocal "):
        return True
    return first in _NOT_STATEMENTS or bool(_DOCSTRING.match(first))


# -- the passes over the builder ------------------------------------------------------------------------------

def collect_statements(b: Any) -> None:
    """S1, S2, S7: one record per (fileId, line) a user-code step ran, at most STATEMENTS_MAX per parent."""
    trace = b.trace
    hits = Counter(trace.rid(i) for i in range(trace.count))
    statement_rids: dict[int, set[int]] = {}
    per_parent: dict[str, int] = {}
    for i in range(trace.count):
        if not b.in_window(i):
            continue
        rid = trace.rid(i)
        loc = b.run.locate(rid)
        if loc is None:
            continue
        fid = int(loc["fileId"])
        if not b.mb.user(fid):
            continue
        if fid not in statement_rids:
            f = b.run.files.get(fid) or {}
            statement_rids[fid] = set(int(r) for r in f.get("statements") or [])
        if int(loc["localRid"]) not in statement_rids[fid]:
            continue
        rng = loc["range"]
        sk = (fid, int(rng[0]))
        if sk in b.statements:
            continue
        scope = trace.scope(trace.scope_id(i))
        if scope is None or not b.user_scope(scope):
            continue
        parent = b.scope_key(scope)
        if parent is None or parent not in b.nodes:
            continue
        lines = b.run.source_lines(fid)
        raw = range_lines(lines, rng)
        if not raw or not_a_statement(lines, rng):
            continue
        if per_parent.get(parent, 0) >= STATEMENTS_MAX:
            b.truncated = True
            continue
        per_parent[parent] = per_parent.get(parent, 0) + 1
        code = " ".join(strip_comments(raw))
        targets, reads = names_of(raw)
        b.statements[sk] = {"key": ("s",) + sk, "kind": "statement", "parent": parent, "label": collapse(code, LABEL_MAX), "file": b.run.file_path(fid), "line": sk[1], "fileId": fid, "text": collapse(code, TEXT_MAX), "targets": targets, "reads": reads, "firstStep": i, "hits": int(hits[rid]), "rows": []}


def statement_rows(b: Any) -> None:
    """S4: the first value moment of a statement is its ``out`` row, the first print its ``print`` row,
    every error moment located on it a ``raised`` row (else the raise lands on the function node)."""
    seen: set[tuple] = set()
    for m in b.moments:
        kind = m["kind"]
        if kind not in ("value", "print", "error"):
            continue
        sk = b.statement_key(m)
        if sk is None:
            if kind == "error":
                node = b.nodes.get(b.location_key(m))
                if node is not None:
                    node["rows"].append(error_row(m["text"], int(m["step"])))
            continue
        stmt = b.statements[sk[1:]]
        if kind == "error":
            stmt["rows"].append(error_row(m["text"], int(m["step"])))
        elif (sk, kind) not in seen:
            seen.add((sk, kind))
            if kind == "value" and m["values"]:
                v = m["values"][0]
                stmt["rows"].append(row("out", v["name"], v["text"], int(m["step"])))
            elif kind == "print":
                stmt["rows"].append(print_row(m["text"], int(m["step"])))


def statement_data_edges(b: Any) -> None:
    """S6: for every name a statement or decision reads, the latest statement or loop under the same
    parent that assigned it, else the parent function when the name is one of its ``in`` rows."""
    consumers = sorted(list(b.statements.values()) + list(b.decisions.values()), key=lambda n: (n["firstStep"], NODE_RANK[n["kind"]], n["label"]))
    producers = [n for n in consumers if n["kind"] == "statement" or n["loop"]]
    for c in consumers:
        for name in c["reads"]:
            best: dict | None = None
            for p in producers:
                if p["parent"] == c["parent"] and p["firstStep"] < c["firstStep"] and name in p["targets"] and (best is None or p["firstStep"] > best["firstStep"]):
                    best = p
            if best is not None:
                src: Any = best["key"]
            else:
                parent = b.nodes.get(c["parent"])
                if parent is None or parent["kind"] != "function" or not any(r["kind"] == "in" and r["name"] == name for r in parent["rows"]):
                    continue
                src = parent["key"]
            b.data_edges.setdefault((src, c["key"], name), {"from": src, "to": c["key"], "kind": "data", "label": name, "firstStep": c["firstStep"]})


__all__ = ["collect_statements", "statement_rows", "statement_data_edges", "range_lines", "not_a_statement", "row", "raised", "error_row", "print_row", "STATEMENTS_MAX", "LABEL_MAX", "TEXT_MAX", "NODE_RANK"]
