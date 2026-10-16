"""Edge-case candidates from a PR's added lines (the ``harness/edges.py`` prototype, ported).

For each statement of the head tree that the diff added or edited, the constructs that have
edges: comparisons (the boundary), subscripts and ``.get`` (the missing key), except handlers
(the raising input and the fallback), new parameters (None, empty), loops over new collections
(empty), divisions (zero), slices (length at the bound), sorts (mixed or equal keys), attributes
no class in the project defines. Each candidate names the function to call and what to try; the
review lists each as tried or skipped. Test files and imported modules are left out.
"""

from __future__ import annotations

import ast
import os
import re

OPS = {ast.Gt: ">", ast.GtE: ">=", ast.Lt: "<", ast.LtE: "<=", ast.Eq: "==", ast.NotEq: "!="}
STDLIB_LIKE = {"self", "cls", "os", "sys", "re", "csv", "io", "json", "math", "ast", "path", "Path", "datetime", "time", "collections", "dataclasses", "decimal", "statistics", "itertools", "functools", "logging", "argparse", "pathlib", "typing"}
#: methods of builtin and stdlib types that no project class has to define
COMMON_METHODS = frozenset((
    "append", "items", "keys", "values", "get", "strip", "split", "join", "replace", "lstrip", "rstrip", "startswith", "endswith", "lower", "upper",
    "format", "isdigit", "match", "fullmatch", "sub", "search", "compile", "most_common", "update", "setdefault", "pop", "add", "extend", "read_text",
    "write_text", "open", "parent", "exists", "mkdir", "name", "stem", "suffix", "copy", "sort", "reverse", "index", "count", "quantize", "insert",
    "clear", "writerow", "writerows", "readline", "readlines", "write", "close", "flush", "today", "now", "isoformat", "strftime", "strptime", "date",
    "year", "month", "day", "total_seconds",
))
SKIP_DIRS = ("__pycache__", "node_modules")


def changed_lines(diff_text: str) -> dict[str, set[int]]:
    """``{file: set(lines added or edited in head)}`` from a unified diff; a deleted file (``+++ /dev/null``) has no entry."""
    files: dict[str, set[int]] = {}
    cur: str | None = None
    new_line = 0
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            name = line[4:].strip()
            name = name[2:] if name.startswith("b/") else name
            if name == "/dev/null":
                cur = None
            else:
                cur = name
                files.setdefault(cur, set())
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            new_line = int(m.group(1)) if m else 0
        elif cur is not None:
            if line.startswith("+") and not line.startswith("+++"):
                files[cur].add(new_line)
                new_line += 1
            elif line.startswith("-") and not line.startswith("---"):
                pass
            elif not line.startswith("\\"):
                new_line += 1
    return files


def is_test_file(rel: str) -> bool:
    return "/tests/" in "/" + rel.replace(os.sep, "/") or os.path.basename(rel).startswith("test_")


def _sources(tree_root: str) -> tuple[dict[str, tuple[str, ast.AST]], set[str]]:
    """Every parseable ``.py`` under the tree, by relative path, and every attribute name any class defines."""
    sources: dict[str, tuple[str, ast.AST]] = {}
    defined: set[str] = set()
    for root, dirs, names in os.walk(tree_root):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS]
        for n in names:
            if not n.endswith(".py"):
                continue
            p = os.path.join(root, n)
            try:
                with open(p, encoding="utf-8") as fh:
                    src = fh.read()
                tree = ast.parse(src)
            except (SyntaxError, UnicodeDecodeError, ValueError, OSError):
                continue
            sources[os.path.relpath(p, tree_root)] = (src, tree)
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    for item in node.body:
                        if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                            defined.add(item.target.id)
                        elif isinstance(item, ast.Assign):
                            defined.update(t.id for t in item.targets if isinstance(t, ast.Name))
                        elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            defined.add(item.name)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    for sub in ast.walk(node):
                        if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name) and sub.value.id == "self" and isinstance(sub.ctx, ast.Store):
                            defined.add(sub.attr)
                        if isinstance(sub, ast.Assign):
                            defined.update(t.attr for t in sub.targets if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self")
    return sources, defined


def enclosing(tree: ast.AST, node: ast.AST) -> str:
    """The innermost function around ``node``, else ``<module>``."""
    best = None
    for f in ast.walk(tree):
        if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)) and f.lineno <= node.lineno <= (f.end_lineno or f.lineno):  # type: ignore[attr-defined]
            if best is None or f.lineno > best.lineno:
                best = f
    return best.name if best else "<module>"


def _text(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:  # noqa: BLE001
        return "?"


def _match(sources: dict[str, tuple[str, ast.AST]], rel: str) -> str | None:
    for key in sources:
        if key == rel or key.endswith("/" + rel) or rel.endswith("/" + key):
            return key
    return None


def _candidate(node: ast.AST, fn: str, lines: set[int], callee_ids: set[int], imported: set[str], defined: set[str]) -> tuple[int, str, str] | None:
    """``(rank, kind, what)`` for one node that touches a changed line, or None."""
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in OPS:
        op = OPS[type(node.ops[0])]
        left, right = _text(node.left), _text(node.comparators[0])
        if op in (">", ">=", "<", "<="):
            return (0, "boundary", "`%s %s %s`: call %s with %s equal to %s, and just above and below it; check the arm against what the PR says (at or above? strictly above?)" % (left, op, right, fn, left, right))
        return (3, "equality", "`%s %s %s`: try a value equal and one differing only in type or case (1 vs 1.0, 'A' vs 'a')" % (left, op, right))
    if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load) and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
        return (1, "missing key", "`%s`: call %s with a row or dict that lacks %r; does a KeyError escape, get swallowed, or become a wrong default?" % (_text(node), fn, node.slice.value))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get" and node.args:
        return (1, "missing key", "`%s`: call %s with the key absent and check what the default does downstream" % (_text(node), fn))
    if isinstance(node, ast.ExceptHandler):
        types = _text(node.type) if node.type else "everything"
        returns = [_text(r.value) for r in ast.walk(node) if isinstance(r, ast.Return) and r.value is not None]
        return (0, "except path", "handler for %s%s: give %s an input that raises inside the try and check what the caller receives; a plausible fallback hides the failure" % (types, (" returning %s" % ", ".join(returns)) if returns else "", fn))
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno in lines:
        args = [a.arg for a in node.args.args if a.arg not in ("self", "cls")]
        if args:
            return (2, "new parameter", "new function %s(%s): call it with None, an empty value and a zero for each parameter the body does not guard" % (node.name, ", ".join(args)))
        return None
    if isinstance(node, ast.For):
        left_behind = ", ".join(sorted({_text(t) for s in node.body for t in getattr(s, "targets", [])})) or "none"
        return (2, "empty loop", "`for %s in %s`: call %s with %s empty and with one element; check the value the loop leaves behind (%s)" % (_text(node.target), _text(node.iter), fn, _text(node.iter), left_behind))
    if isinstance(node, ast.BinOp) and type(node.op) in (ast.Div, ast.FloorDiv, ast.Mod) and not any(isinstance(x, ast.Constant) and isinstance(x.value, str) for x in (node.left, node.right)):
        return (1, "zero divisor", "`%s`: call %s with %s == 0" % (_text(node), fn, _text(node.right)))
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice):
        return (1, "slice bound", "`%s`: call %s with a collection whose length equals the bound, one more and one fewer; count the elements that come out" % (_text(node), fn))
    if isinstance(node, ast.Call) and ((isinstance(node.func, ast.Name) and node.func.id in ("sorted", "min", "max")) or (isinstance(node.func, ast.Attribute) and node.func.attr == "sort")):
        return (2, "ordering", "`%s`: are the keys all one type (str ids sort '10' before '9'), and what happens with equal keys?" % _text(node))
    if (
        isinstance(node, ast.Attribute)
        and isinstance(node.ctx, ast.Load)
        and id(node) not in callee_ids
        and isinstance(node.value, ast.Name)
        and node.value.id not in STDLIB_LIKE
        and node.value.id not in imported
        and node.attr not in defined
        and not node.attr.startswith("__")
        and node.attr not in dir(object)
        and node.attr not in COMMON_METHODS
    ):
        return (0, "attribute", "`%s`: no class in the project defines `%s`; call %s with an object that reaches this line and see whether AttributeError escapes" % (_text(node), node.attr, fn))
    return None


def edges(diff_text: str, repo: str) -> list[dict]:
    """``[{id, kind, file, line, function, what, rank}]`` ranked, ``E1..En``; ``repo`` is the head tree."""
    changed = changed_lines(diff_text)
    sources, defined = _sources(repo)
    rows: list[tuple[int, str, str, int, str, str]] = []  # (rank, kind, file, line, function, what)
    for rel, lines in changed.items():
        hit = _match(sources, rel)
        if hit is None or not lines or is_test_file(hit):
            continue
        src, tree = sources[hit]
        callee_ids = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update((a.asname or a.name).split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.update(a.asname or a.name for a in node.names)
        for node in ast.walk(tree):
            if not hasattr(node, "lineno"):
                continue
            span = set(range(node.lineno, (getattr(node, "end_lineno", None) or node.lineno) + 1))
            if not (span & lines):
                continue
            fn = enclosing(tree, node)
            found = _candidate(node, fn, lines, callee_ids, imported, defined)
            if found is not None:
                rows.append((found[0], found[1], hit, node.lineno, fn, found[2]))
    seen: set[tuple] = set()
    out: list[dict] = []
    for rank, kind, file, line, fn, what in sorted(rows, key=lambda r: (r[0], "%s:%s %s" % (r[2], r[3], r[4]))):
        key = (kind, "%s:%s %s" % (file, line, fn), what[:60])
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": "E%d" % (len(out) + 1), "kind": kind, "file": file, "line": line, "function": fn, "what": what, "rank": rank})
    return out


def render_edges(rows: list[dict], changed_files: int | None = None) -> list[str]:
    """The prototype's listing: a head line, then ``E1 [kind] file:line function`` and the ``what`` indented."""
    head = "edges: %d candidates" % len(rows)
    if changed_files is not None:
        head += " from %d changed files" % changed_files
    out = [head + "; try each with a run, a test command or an experiment and report tried (result) or skipped (why)"]
    for r in rows:
        out.append("%s [%s] %s:%s %s" % (r["id"], r["kind"], r["file"], r["line"], r["function"]))
        out.append("    %s" % r["what"])
    return out


__all__ = ["changed_lines", "edges", "enclosing", "is_test_file", "render_edges"]
