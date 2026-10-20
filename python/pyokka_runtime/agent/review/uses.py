"""What each agenda item's changed lines call in the repository: the code the change relies on, as context.

A stop is a changed function, and the breakpoints stay there. The code a change relies on is often where it
breaks, though, and the plan named none of it: on 2026-10-20 the person asked for "the changed code, plus any code
in the repo outside the change that it uses". Each item now lists the repository functions and classes its changed
lines call (``uses``), with ``file:line`` and, when the callee is itself on the agenda, its stop number. No
breakpoint is set for them, so the agenda keeps its size (``scope.py`` has the 58-item review that made it matter).

A call is resolved only when its target is plain in the source: a name defined at the top level of the same file
or imported from a module of the repository (``from x import f``, relative ones included), ``mod.f`` for a module
of the repository imported as ``mod``, and ``self.f`` for a method of the class around the item. Anything else (the
standard library, installed packages, a value whose type the source does not say) is left out rather than guessed.
Only the modules a changed file imports are parsed; the repository is listed by name, never read whole.
"""

from __future__ import annotations

import ast
import os
from typing import Any

from .edges import SKIP_DIRS

#: per item, how many uses the plan keeps; ``render`` prints fewer
KEEP = 12


def _py_files(repo: str) -> list[str]:
    """Every ``.py`` under ``repo``, ``/``-separated and relative to it, by name only."""
    out: list[str] = []
    for root, dirs, names in os.walk(repo):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS]
        rel_root = os.path.relpath(root, repo).replace(os.sep, "/")
        out.extend(n if rel_root == "." else "%s/%s" % (rel_root, n) for n in names if n.endswith(".py"))
    return out


class _Repo:
    """The repository's Python files by module path, each parsed at most once."""

    def __init__(self, repo: str):
        self.repo = repo
        self.files = _py_files(repo)
        self._trees: dict[str, ast.Module | None] = {}

    def module_file(self, dotted: str, near: str | None = None) -> str | None:
        """The file of the module ``dotted`` (``a.b`` is ``a/b.py`` or ``a/b/__init__.py``), under any directory, so
        a ``src`` or ``libs/core`` layout resolves; on several matches, the one sharing most of ``near``'s directory."""
        tail = dotted.replace(".", "/")
        hits = [f for f in self.files if f in (tail + ".py", tail + "/__init__.py") or f.endswith(("/" + tail + ".py", "/" + tail + "/__init__.py"))]
        if not hits:
            return None
        if near is None or len(hits) == 1:
            return min(hits, key=len)
        base = near.split("/")[:-1]
        return max(hits, key=lambda f: (sum(1 for a, b in zip(base, f.split("/")) if a == b), -len(f)))

    def relative(self, file: str, level: int, module: str | None) -> str | None:
        """``from .x import`` in ``file``: the module's file, ``level`` packages up."""
        parts = file.split("/")[:-1]
        if level > 1:
            parts = parts[: len(parts) - (level - 1)]
        tail = "/".join([*parts, *(module.split(".") if module else [])])
        for cand in (tail + ".py", tail + "/__init__.py"):
            if cand.lstrip("/") in self.files:
                return cand.lstrip("/")
        return None

    def tree(self, file: str) -> ast.Module | None:
        if file not in self._trees:
            try:
                with open(os.path.join(self.repo, file), encoding="utf-8", errors="replace") as fh:
                    self._trees[file] = ast.parse(fh.read())
            except (OSError, SyntaxError, ValueError):
                self._trees[file] = None
        return self._trees[file]

    def defined(self, file: str, name: str) -> int | None:
        """The line of the top-level ``def`` or ``class`` ``name`` in ``file``."""
        tree = self.tree(file)
        for node in tree.body if tree is not None else []:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
                return node.lineno
        return None


def _imports(r: _Repo, file: str, tree: ast.Module) -> tuple[dict[str, tuple[str, str]], dict[str, str]]:
    """``(names, modules)``: a name imported from a repository module (``{name: (file, original name)}``), and a name
    bound to a repository module (``{alias: file}``)."""
    names: dict[str, tuple[str, str]] = {}
    modules: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                target = r.module_file(a.name, file)
                if target is not None and a.asname:
                    modules[a.asname] = target
                elif target is not None and "." not in a.name:
                    modules[a.name] = target
        elif isinstance(node, ast.ImportFrom):
            src = r.relative(file, node.level, node.module) if node.level else (r.module_file(node.module, file) if node.module else None)
            for a in node.names:
                local = a.asname or a.name
                sub = None
                if node.level:
                    sub = r.relative(file, node.level, "%s.%s" % (node.module, a.name) if node.module else a.name)
                elif node.module:
                    sub = r.module_file("%s.%s" % (node.module, a.name), file)
                if sub is not None:  # from pkg import module
                    modules[local] = sub
                elif src is not None:
                    names[local] = (src, a.name)
    return names, modules


def _enclosing_class(tree: ast.Module, line: int) -> ast.ClassDef | None:
    best = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.lineno <= line <= (node.end_lineno or node.lineno) and (best is None or node.lineno > best.lineno):
            best = node
    return best


def _resolve(r: _Repo, file: str, tree: ast.Module, call: ast.Call, names: dict, modules: dict) -> tuple[str, str, int] | None:
    """``(name, file, line)`` the call reaches in the repository, or None."""
    func = call.func
    if isinstance(func, ast.Name):
        if func.id in names:
            target, original = names[func.id]
            line = r.defined(target, original)
            return (original, target, line) if line is not None else None
        line = r.defined(file, func.id)
        return (func.id, file, line) if line is not None else None
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        owner = func.value.id
        if owner in modules:
            line = r.defined(modules[owner], func.attr)
            return (func.attr, modules[owner], line) if line is not None else None
        if owner == "self":
            cls = _enclosing_class(tree, call.lineno)
            for node in cls.body if cls is not None else []:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func.attr:
                    return ("%s.%s" % (cls.name, func.attr), file, node.lineno)
    return None


def attach_uses(items: list[dict], repo: str) -> int:
    """Give each item ``uses``: ``[{name, file, line, stop?}]``, what its changed lines call in the repository.

    Run on the numbered agenda, after ``--only`` narrowed it, so ``stop`` is the number the person sees. The
    item's own function is left out. Returns how many items use something."""
    r = _Repo(repo)
    by_place = {(str(it.get("file")), str(it.get("function"))): it.get("n") for it in items}
    count = 0
    for it in items:
        file = str(it.get("file") or "").replace(os.sep, "/")
        tree = r.tree(file)
        if tree is None:
            continue
        lines = {n for lo, hi in it.get("spans") or [] for n in range(int(lo), int(hi) + 1)}
        names, modules = _imports(r, file, tree)
        found: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for node in sorted((n for n in ast.walk(tree) if isinstance(n, ast.Call)), key=lambda n: (n.lineno, n.col_offset)):
            if not lines & set(range(node.lineno, (node.end_lineno or node.lineno) + 1)):
                continue
            hit = _resolve(r, file, tree, node, names, modules)
            if hit is None:
                continue
            name, target, line = hit
            short = name.rsplit(".", 1)[-1]
            if (target, short) == (file, str(it.get("function"))) or (target, name) in seen:
                continue
            seen.add((target, name))
            stop = by_place.get((target, short))
            found.append({"name": name, "file": target, "line": line, **({"stop": stop} if stop is not None else {})})
            if len(found) >= KEEP:
                break
        if found:
            it["uses"] = found
            count += 1
    return count


def uses_text(uses: list[dict], room: int = 5) -> str:
    """``uses: f app/x.py:3 (stop 2), …``, the first ``room`` of them."""
    shown = ["%s %s:%s%s" % (u.get("name"), u.get("file"), u.get("line"), " (stop %s)" % u["stop"] if u.get("stop") is not None else "") for u in uses[:room]]
    return "uses: %s%s" % (", ".join(shown), ", …" if len(uses) > room else "")


__all__ = ["attach_uses", "uses_text"]
