"""Statement matching and hit comparison for ``pyokka diff`` (``diff.py``): pure functions over source text and facts."""

from __future__ import annotations

import ast
import copy
import difflib
import re

from ..redact import REDACTED, redact

HITS_MAX = 5
# the address in a default repr (`<function f at 0x101d10720>`, `<Graph object at 0x108a254f0>`):
# two runs put the same object somewhere else, so it is left out of the comparison (not the text shown)
_ADDRESS = re.compile(r"(?<= at )0x[0-9a-fA-F]+")
_COMPOUND_FIELDS = ("body", "orelse", "finalbody", "handlers", "cases")


# -- statements of a file ---------------------------------------------------------------------------------------

class Stmt:
    __slots__ = ("line", "end", "function", "text", "norm", "kind", "source")

    def __init__(self, line: int, end: int, function: str, text: str, norm: str, kind: str, source: str = "") -> None:
        self.line, self.end, self.function, self.text, self.norm, self.kind = line, end, function, text, norm, kind
        self.source = source or text  # every line of the statement (a compound one: its header line)


def safe_source(text: str) -> str:
    """The text a diff parses: redacted the way a saved run's copy is, with the mark made an identifier so it still parses."""
    return redact(text).replace(REDACTED, "_redacted_")


def _first_line(text: str) -> str:
    return text.strip().split("\n", 1)[0].strip()


def _norm(node: ast.stmt) -> str:
    if any(isinstance(getattr(node, f, None), list) and getattr(node, f) and isinstance(getattr(node, f)[0], (ast.stmt, ast.excepthandler, ast.match_case)) for f in _COMPOUND_FIELDS):
        head = copy.copy(node)
        for f in _COMPOUND_FIELDS:
            if isinstance(getattr(head, f, None), list):
                setattr(head, f, [ast.Pass()] if f == "body" else [])
        if isinstance(head, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            head.decorator_list = []
        try:
            return _first_line(ast.unparse(head))
        except Exception:  # noqa: BLE001 - a node unparse cannot handle still has a line
            return ""
    try:
        return " ".join(ast.unparse(node).split())
    except Exception:  # noqa: BLE001
        return ""


def parse_statements(source: str) -> list[Stmt]:
    """Every statement of the file in line order: simple statements, compound headers, ``def``/``class`` lines."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return []
    lines = source.split("\n")
    out: list[Stmt] = []

    def visit(body: list, qual: list[str]) -> None:
        for node in body:
            if isinstance(node, ast.excepthandler):
                visit(node.body, qual)
                continue
            if isinstance(node, ast.match_case):
                visit(node.body, qual)
                continue
            if not isinstance(node, ast.stmt):
                continue
            line = int(node.lineno)
            raw = lines[line - 1].strip() if 0 < line <= len(lines) else ""
            end = int(getattr(node, "end_lineno", line) or line)
            function = ".".join(qual) or "<module>"
            norm = _norm(node) or " ".join(raw.split())
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                out.append(Stmt(line, line, function, raw, norm, "def"))
                visit(node.body, qual + [node.name])
                continue
            compound = any(isinstance(getattr(node, f, None), list) and getattr(node, f) for f in _COMPOUND_FIELDS)
            text = raw if compound or end == line else raw + " …"
            source = raw if compound else "\n".join(lines[line - 1:end])
            out.append(Stmt(line, end if not compound else line, function, text, norm, "header" if compound else "stmt", source))
            for f in _COMPOUND_FIELDS:
                child = getattr(node, f, None)
                if isinstance(child, list):
                    visit(child, qual)

    visit(tree.body, [])
    out.sort(key=lambda s: s.line)
    return out


def assigned_names(source: str) -> list[str]:
    from ..bindings import statement_bindings

    try:
        entries = statement_bindings(source)
    except (SyntaxError, ValueError):
        return []
    seen: dict[str, None] = {}
    for e in entries:
        for name in e.get("assigns") or []:
            seen.setdefault(str(name), None)
    return list(seen)


# -- pairing statements -----------------------------------------------------------------------------------------

def pair_statements(sa: list[Stmt], sb: list[Stmt]) -> tuple[list[tuple[Stmt | None, Stmt | None, str]], int]:
    """``(a, b, status)`` for every statement of the two versions; and how many statements an edit left alone."""
    ka = [(s.function, s.norm) for s in sa]
    kb = [(s.function, s.norm) for s in sb]
    out: list[tuple[Stmt | None, Stmt | None, str]] = []
    same = 0
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ka, kb, autojunk=False).get_opcodes():
        if op == "equal":
            out.extend((sa[i], sb[j], "same") for i, j in zip(range(i1, i2), range(j1, j2)))
            same += i2 - i1
            continue
        left, right = list(range(i1, i2)), list(range(j1, j2))
        while left and right and sa[left[0]].function == sb[right[0]].function:
            out.append((sa[left.pop(0)], sb[right.pop(0)], "edited"))
        out.extend((sa[i], None, "removed") for i in left)
        out.extend((None, sb[j], "added") for j in right)
    return out, same


# -- comparing hits ------------------------------------------------------------------------------------------------

def comparable_text(text: object) -> object:
    """``text`` with memory addresses in object reprs blanked, for comparing; other values unchanged."""
    return _ADDRESS.sub("0x", text) if isinstance(text, str) else text


def _hit(f: dict | None) -> dict | None:
    return {"text": f["text"], "step": f["step"]} if f else None


def compare_hits(channel: tuple, fa: list[dict], fb: list[dict]) -> list[dict]:
    kind = channel[0]
    name = channel[1] if len(channel) > 1 else None
    out: list[dict] = []
    ta, tb = [comparable_text(f["text"]) for f in fa], [comparable_text(f["text"]) for f in fb]
    if len(ta) == len(tb):  # as many hits on both sides: the nth against the nth
        ops = [("equal" if x == y else "replace", i, i + 1, i, i + 1) for i, (x, y) in enumerate(zip(ta, tb))]
    else:  # a hit came or went: align, so one inserted early does not shift every later one
        ops = difflib.SequenceMatcher(None, ta, tb, autojunk=False).get_opcodes()
    for op, i1, i2, j1, j2 in ops:
        if op == "equal":
            if kind == "call":  # a return the walkthrough saw on both sides
                for i, j in zip(range(i1, i2), range(j1, j2)):
                    ra, rb = fa[i].get("returned"), fb[j].get("returned")
                    if ra is not None and rb is not None and comparable_text(ra) != comparable_text(rb):
                        out.append({"kind": "return", "name": name, "call": fa[i]["text"], "a": {"text": ra, "step": _return_step(fa[i])}, "b": {"text": rb, "step": _return_step(fb[j])}})
            continue
        n = max(i2 - i1, j2 - j1)
        for k in range(n):
            x = fa[i1 + k] if i1 + k < i2 else None
            y = fb[j1 + k] if j1 + k < j2 else None
            out.append({"kind": kind, "name": name, "a": _hit(x), "b": _hit(y)})
    return out


def _return_step(fact: dict) -> int:
    """The callee's last step when the walkthrough knew it, else the call's own step."""
    step = fact.get("returnStep")
    return int(step) if step is not None else int(fact["step"])


def cap_facts(facts: list[dict]) -> list[dict]:
    by: dict[tuple, int] = {}
    out: list[dict] = []
    hidden: dict[tuple, int] = {}
    for f in facts:
        key = (f["kind"], f.get("name"))
        by[key] = by.get(key, 0) + 1
        if by[key] > HITS_MAX:
            hidden[key] = hidden.get(key, 0) + 1
            continue
        out.append(f)
    for (kind, name), n in hidden.items():
        out.append({"kind": kind, "name": name, "more": n})
    return out
