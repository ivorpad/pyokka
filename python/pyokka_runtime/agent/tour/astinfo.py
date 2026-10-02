"""What a statement is, for the tour's signals: its own calls, what each call reaches, whether it binds one.

Pure functions over a file's source (``ast``), cached per file by ``SourceIndex``. A call is
classified by its dotted name: a file write or a subprocess (``io-write``, ``subprocess``), the
project's own code (``user``), the standard library (``stdlib``), a builtin or a method of a
builtin type (``builtin``), else a library (``lib``). Port of the ablation's ``astutil.py``
(``docs/TOUR.md``, "Signals").
"""

from __future__ import annotations

import ast
import builtins
import os
import sys
from typing import Iterable

STDLIB = set(sys.stdlib_module_names)
BUILTIN_NAMES = set(dir(builtins))
# methods of builtin types (str, list, dict, set, bytes): a call to one is never a library boundary
BUILTIN_METHODS = {
    "append", "extend", "insert", "pop", "remove", "clear", "copy", "index", "count", "sort", "reverse",
    "get", "items", "keys", "values", "update", "setdefault", "popitem", "fromkeys",
    "add", "discard", "union", "intersection", "difference", "issubset", "issuperset",
    "join", "split", "rsplit", "splitlines", "strip", "lstrip", "rstrip", "lower", "upper", "title",
    "startswith", "endswith", "format", "replace", "encode", "decode", "find", "rfind", "zfill",
    "removesuffix", "removeprefix", "partition", "rpartition", "isdigit", "isalpha", "isspace",
    "casefold", "center", "ljust", "rjust", "expandtabs", "format_map", "isidentifier", "capitalize",
}
WRITE_METHODS = {"write", "writelines", "writerow", "writerows", "write_text", "write_bytes", "to_csv", "to_json", "savefig", "dump", "save"}
SUBPROCESS = {"run", "Popen", "call", "check_call", "check_output", "system", "popen"}
COMPOUND = (ast.If, ast.While, ast.For, ast.AsyncFor, ast.With, ast.AsyncWith, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Try, ast.Match)


class FileInfo:
    """One file's parse: statements by first line, imports, the names it defines."""

    def __init__(self, lines: list[str]) -> None:
        self.lines = lines
        self.source = "\n".join(lines)
        try:
            self.tree: ast.Module | None = ast.parse(self.source)
        except (SyntaxError, ValueError):
            self.tree = None
        self.statements: dict[int, ast.stmt] = {}
        self.imports: dict[str, str] = {}
        self.defs: set[str] = set()
        if self.tree is None:
            return
        for node in ast.walk(self.tree):
            if isinstance(node, ast.stmt):
                self.statements.setdefault(node.lineno, node)
            if isinstance(node, ast.Import):
                for a in node.names:
                    self.imports[(a.asname or a.name).split(".")[0]] = a.name
            elif isinstance(node, ast.ImportFrom):
                mod = "." * node.level + (node.module or "")
                for a in node.names:
                    self.imports[a.asname or a.name] = mod
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.defs.add(node.name)

    def line_text(self, line: int) -> str:
        return self.lines[line - 1].strip() if 0 < line <= len(self.lines) else ""

    def statement_text(self, line: int) -> str:
        """The whole statement starting on ``line``; a compound statement's header line only."""
        stmt = self.statements.get(line)
        if stmt is None or isinstance(stmt, COMPOUND):
            return self.line_text(line)
        end = int(getattr(stmt, "end_lineno", line) or line)
        return "\n".join(l.rstrip() for l in self.lines[line - 1:end]).strip()


def own_calls(stmt: ast.stmt) -> list[ast.Call]:
    """The call nodes a statement makes itself: a compound statement's header only, never a nested def or lambda."""
    if isinstance(stmt, (ast.If, ast.While)):
        roots: list[ast.AST] = [stmt.test]
    elif isinstance(stmt, (ast.For, ast.AsyncFor)):
        roots = [stmt.iter]
    elif isinstance(stmt, (ast.With, ast.AsyncWith)):
        roots = [i.context_expr for i in stmt.items]
    elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Try, ast.Match)):
        roots = []
    else:
        roots = [stmt]
    out: list[ast.Call] = []
    stack = list(roots)
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if isinstance(n, ast.Call):
            out.append(n)
        stack.extend(ast.iter_child_nodes(n))
    out.sort(key=lambda c: (c.lineno, c.col_offset))
    return out


def dotted(func: ast.AST) -> list[str]:
    parts: list[str] = []
    while isinstance(func, ast.Attribute):
        parts.append(func.attr)
        func = func.value
    if isinstance(func, ast.Name):
        parts.append(func.id)
    elif isinstance(func, ast.Call):
        parts.append("<call>")
    else:
        parts.append("<expr>")
    return list(reversed(parts))


def binds_call(stmt: ast.stmt | None) -> bool:
    """``x = f(...)``, ``x += f(...)``, ``await f(...)``: a statement that keeps (or awaits) a call's result."""
    if isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        value = stmt.value
    elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Await):
        value = stmt.value
    else:
        return False
    return value is not None and any(isinstance(n, ast.Call) for n in ast.walk(value))


def is_definition(stmt: ast.stmt | None, text: str) -> bool:
    return isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) or text.lstrip().startswith(("def ", "async def ", "class "))


def is_forward(stmt: ast.stmt | None) -> bool:
    """``return f(...)``, ``return await f(...)``, ``await f(...)``, ``return name``: a statement that hands
    a callee's value on as it came; the callee's own return is the stop."""
    if isinstance(stmt, ast.Return) and stmt.value is not None:
        v: ast.AST = stmt.value
    elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Await):
        v = stmt.value
    else:
        return False
    if isinstance(v, ast.Await):
        v = v.value
    if isinstance(v, ast.Name) and isinstance(stmt, ast.Return):
        return True
    return isinstance(v, ast.Call) and isinstance(v.func, (ast.Name, ast.Attribute))


def module_roots(paths: Iterable[str]) -> set[str]:
    """Names a project import can start with: each recorded file's stem and its directory's name."""
    roots: set[str] = set()
    for p in paths:
        parts = p.split(os.sep)
        roots.add(os.path.splitext(parts[-1])[0])
        if len(parts) > 1:
            roots.add(parts[-2])
    return roots


def classify_call(call: ast.Call, info: FileInfo, roots: set[str], defs: set[str], next_entry: str | None) -> tuple[str, str]:
    """``(kind, label)`` for one call; ``next_entry`` is the function the next step entered, when it entered one."""
    parts = dotted(call.func)
    root, last = parts[0], parts[-1]
    label = ".".join(parts)
    if root == "open" and len(parts) == 1:
        mode = call.args[1].value if len(call.args) > 1 and isinstance(call.args[1], ast.Constant) else None
        for kw in call.keywords:
            if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                mode = kw.value.value
        return ("io-write" if isinstance(mode, str) and any(c in mode for c in "wax") else "builtin"), label
    if (root == "subprocess" or (root == "os" and last in ("system", "popen"))) and last in SUBPROCESS:
        return "subprocess", label
    if len(parts) > 1 and last in WRITE_METHODS and root != "self":
        return "io-write", label
    if root in info.imports:
        mod = info.imports[root]
        top = mod.lstrip(".").split(".")[0]
        if mod.startswith(".") or top in roots:
            return "user", label
        return ("stdlib" if top in STDLIB else "lib"), label
    if root == "self" or (root in defs and len(parts) == 1):
        return "user", label
    if len(parts) == 1 and root in BUILTIN_NAMES:
        return "builtin", label
    if len(parts) > 1 and last in BUILTIN_METHODS:
        return "builtin", label
    if last in defs:
        return "user", label
    if next_entry is not None and next_entry.rsplit(".", 1)[-1] == last:
        return "user", label  # an opaque call on a local object that entered a recorded frame
    return "lib", label


__all__ = ["FileInfo", "own_calls", "dotted", "binds_call", "is_definition", "is_forward", "module_roots", "classify_call"]
