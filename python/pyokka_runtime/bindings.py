"""Per-statement name bindings from the AST: what a statement assigns, reads and calls.

The variable history (``pyokka var``, the panel's Variable pane) needs two facts about a
statement that the trace does not carry: which names it binds (so a recorded change can be
attributed to the statement that made it, and so an assignment with no recorded value can
still be listed) and which names it reads (so "where did this come from" can show the values
that fed it). The provenance tree (``pyokka why``) adds a third: the source text of the calls
the statement makes, so a call whose body left no steps can still be named. All come from the
source alone, so the same function serves the CLI over a saved run and the runner's
``bindings`` request for the extension.

Positions follow the range table: a statement is identified by ``(lineno, col_offset)`` of
its AST node, which is where the instrumenter starts its range (the header for compound
statements). ``def`` statements list their parameters as assignments: the only step on a
``def`` header is a call entering the function, and that is where the parameters get bound.
"""

from __future__ import annotations

import ast
import builtins
import re

BUILTIN_NAMES = frozenset(dir(builtins))
READS_CAP = 12
CALLS_CAP = 8
CALL_TEXT_MAX = 80

_EOL = re.compile(r"\r\n|\r|\n")
_BODY_FIELDS = ("body", "orelse", "finalbody", "handlers", "cases")


def statement_bindings(source: str) -> list[dict]:
    """``[{line, col, assigns, reads, loop?, calls?}]`` for every statement that binds or reads a name or makes a call, in source order.

    Raises ``SyntaxError`` when the source does not parse.
    """
    tree = ast.parse(source)
    lines = source_lines(source)
    out: list[dict] = []
    for stmt in ast.walk(tree):
        if not isinstance(stmt, ast.stmt) or getattr(stmt, "lineno", None) is None:
            continue
        assigns = assigned_paths(stmt)
        reads = read_names(stmt)
        calls = call_texts(stmt, source, lines)
        if assigns or reads or calls:
            entry: dict = {"line": stmt.lineno, "col": stmt.col_offset, "assigns": assigns, "reads": reads}
            if isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
                # a loop header runs once before the loop and once per iteration, after the target is
                # bound; `loop` is the last line of the loop so a consumer can tell the two apart
                entry["loop"] = int(getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno)
            if calls:
                entry["calls"] = calls
            out.append(entry)
    out.sort(key=lambda e: (e["line"], e["col"]))
    return out


# -- assignments --------------------------------------------------------------------------------------------

def target_path(node: ast.expr) -> str | None:
    """``acct``, ``self.balance``; a subscript binds its container (``acct[0] = 1`` assigns ``acct``)."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = target_path(node.value)
        return "%s.%s" % (base, node.attr) if base else None
    if isinstance(node, ast.Subscript):
        return target_path(node.value)
    if isinstance(node, ast.Starred):
        return target_path(node.value)
    return None


def _target_paths(node: ast.expr) -> list[str]:
    if isinstance(node, (ast.Tuple, ast.List)):
        out: list[str] = []
        for elt in node.elts:
            out.extend(_target_paths(elt))
        return out
    path = target_path(node)
    return [path] if path else []


def assigned_paths(stmt: ast.stmt) -> list[str]:
    """Names (or attribute paths) the statement binds when it executes, in source order, deduplicated."""
    out: list[str] = []
    if isinstance(stmt, ast.Assign):
        for t in stmt.targets:
            out.extend(_target_paths(t))
    elif isinstance(stmt, ast.AugAssign):
        out.extend(_target_paths(stmt.target))
    elif isinstance(stmt, ast.AnnAssign):
        if stmt.value is not None:
            out.extend(_target_paths(stmt.target))
    elif isinstance(stmt, (ast.For, ast.AsyncFor)):
        out.extend(_target_paths(stmt.target))
    elif isinstance(stmt, (ast.With, ast.AsyncWith)):
        for item in stmt.items:
            if item.optional_vars is not None:
                out.extend(_target_paths(item.optional_vars))
    elif isinstance(stmt, ast.Import):
        for alias in stmt.names:
            out.append(alias.asname or alias.name.split(".")[0])
    elif isinstance(stmt, ast.ImportFrom):
        for alias in stmt.names:
            if alias.name != "*":
                out.append(alias.asname or alias.name)
    elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
        a = stmt.args
        out.extend(arg.arg for arg in a.posonlyargs + a.args)
        if a.vararg:
            out.append(a.vararg.arg)
        out.extend(arg.arg for arg in a.kwonlyargs)
        if a.kwarg:
            out.append(a.kwarg.arg)
    if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        for node in _header_nodes(stmt):
            if isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
                out.append(node.target.id)
    return _dedupe(out)


# -- reads -----------------------------------------------------------------------------------------------------

def _header_nodes(stmt: ast.stmt):
    """Every node of the statement outside its nested blocks (the header for compound statements)."""
    for field, value in ast.iter_fields(stmt):
        if field in _BODY_FIELDS:
            continue
        if isinstance(value, ast.AST):
            yield from ast.walk(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, ast.AST):
                    yield from ast.walk(item)


def read_names(stmt: ast.stmt) -> list[str]:
    """Names the statement loads when it executes (``ast.Name`` loads of its header), in source order.

    Builtins, comprehension variables and lambda parameters are left out: they are never a
    recorded variable of the program. ``def`` and ``class`` statements read nothing at a step
    (defaults and decorators run when the definition executes, which is never a step).
    """
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return []
    local: set[str] = set()
    for node in _header_nodes(stmt):
        if isinstance(node, ast.comprehension):
            local.update(_target_paths(node.target))
        elif isinstance(node, ast.Lambda):
            a = node.args
            local.update(arg.arg for arg in a.posonlyargs + a.args + a.kwonlyargs)
            if a.vararg:
                local.add(a.vararg.arg)
            if a.kwarg:
                local.add(a.kwarg.arg)
    names: list[tuple[tuple[int, int], str]] = []
    if isinstance(stmt, ast.AugAssign) and isinstance(stmt.target, ast.Name):
        names.append(((stmt.target.lineno, stmt.target.col_offset), stmt.target.id))  # `x += 1` reads x, though the AST stores it
    for node in _header_nodes(stmt):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in local and node.id not in BUILTIN_NAMES:
            names.append(((node.lineno, node.col_offset), node.id))
    names.sort()
    return _dedupe([n for _, n in names])[:READS_CAP]


# -- calls -----------------------------------------------------------------------------------------------------

def call_texts(stmt: ast.stmt, source: str, lines: list[str] | None = None) -> list[str]:
    """The source text of each call the statement's header makes, outermost first, in ``ast.walk`` order.

    Whitespace is collapsed (a call split over lines reads as one), duplicates dropped, at most
    ``CALLS_CAP`` texts of at most ``CALL_TEXT_MAX`` characters. ``def`` and ``class`` statements
    make none at a step, like their reads. ``lines`` is ``source_lines(source)``, passed once
    per file so a long file is not split again for every call.
    """
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return []
    if lines is None:
        lines = source_lines(source)
    out: list[str] = []
    for node in _header_nodes(stmt):
        if not isinstance(node, ast.Call):
            continue
        text = " ".join((_segment(lines, node) or ast.unparse(node)).split())
        if text and text not in out:
            out.append(text)
            if len(out) == CALLS_CAP:
                break
    return [t if len(t) <= CALL_TEXT_MAX else t[: CALL_TEXT_MAX - 1] + "…" for t in out]


def source_lines(source: str) -> list[str]:
    """Lines with their endings, split on ``\\r\\n``, ``\\r`` and ``\\n`` only (as the AST counts them; ``str.splitlines`` also splits on a form feed)."""
    out: list[str] = []
    start = 0
    for m in _EOL.finditer(source):
        out.append(source[start:m.end()])
        start = m.end()
    if start < len(source):
        out.append(source[start:])
    return out


def _segment(lines: list[str], node: ast.AST) -> str | None:
    """``ast.get_source_segment`` over lines split once (columns are UTF-8 byte offsets)."""
    a, b = getattr(node, "lineno", None), getattr(node, "end_lineno", None)
    ca, cb = getattr(node, "col_offset", None), getattr(node, "end_col_offset", None)
    if a is None or b is None or ca is None or cb is None or b > len(lines):
        return None
    if a == b:
        return lines[a - 1].encode()[ca:cb].decode(errors="replace")
    first = lines[a - 1].encode()[ca:].decode(errors="replace")
    last = lines[b - 1].encode()[:cb].decode(errors="replace")
    return "".join([first, *lines[a:b - 1], last])


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


# -- matching --------------------------------------------------------------------------------------------------

def matches_name(candidate: str | None, query: str) -> bool:
    """The variable history's name rule: exact, or one path under the other (``acct`` ~ ``acct.deposit(x)``, ``self`` ~ ``self.balance``)."""
    if not candidate or not query:
        return False
    if candidate == query:
        return True
    for sep in (".", "["):
        if candidate.startswith(query + sep) or query.startswith(candidate + sep):
            return True
    return False


def index_bindings(entries: list[dict], ranges: list[list[int]], statements: list[int], function_rids: list[int], range_base: int = 0) -> dict[int, dict]:
    """Bindings keyed by global range id, via the ``(line, col)`` the range table and the AST share.

    Statement ranges win over ``def`` headers at the same position (a bare lambda statement).
    """
    by_pos: dict[tuple[int, int], int] = {}
    for local in list(function_rids) + list(statements):
        if 0 <= local < len(ranges):
            r = ranges[local]
            by_pos[(int(r[0]), int(r[1]))] = local
    out: dict[int, dict] = {}
    for e in entries:
        local = by_pos.get((int(e["line"]), int(e["col"])))
        if local is not None:
            out[range_base + local] = e
    return out


__all__ = ["statement_bindings", "assigned_paths", "read_names", "call_texts", "target_path", "matches_name", "index_bindings", "BUILTIN_NAMES", "READS_CAP", "CALLS_CAP", "CALL_TEXT_MAX"]
