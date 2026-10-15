"""Go to definition for the browser page's Cmd/Ctrl-click, from the AST alone (no import is executed).

``definitions(source, path, offset)`` finds the name under ``offset`` (UTF-16, as the page counts)
and answers where it is defined: a ``def``, ``class``, assignment or parameter in the same file
(the binding the name resolves to, by ``identifiers.py``'s scopes), or, when that binding is an
import, the module or the ``def`` / ``class`` / assignment it names in a project file, following
re-exports (``from .core import Agent`` in a package's ``__init__``) a few hops. ``mod.func`` and
``Class.method`` resolve the attribute in the module or the class body.

Modules are looked up as files next to the importing file, at the project root (the nearest
directory above it with ``pyproject.toml``, ``setup.py``, ``setup.cfg`` or ``.git``) and in its
``src/``, never through ``sys.path`` or ``importlib`` (``find_spec`` imports parent packages, which
runs their code). The standard library and installed packages are not resolved: such a name
answers no location.
"""

from __future__ import annotations

import ast
import os
import sysconfig

from .identifiers import _Walker, _utf16_len, walk_source

MAX_HOPS = 8
_PROJECT_MARKERS = ("pyproject.toml", "setup.py", "setup.cfg", ".git")
_PREFERRED = ("def", "class", "import")


def definitions(source: str, path: str, offset: int) -> list[dict]:
    """``[{path, line, column}]`` (1-based, the column in UTF-16 units) of the definition under ``offset``; ``[]`` when there is none in the project.

    Raises ``SyntaxError`` when ``source`` does not parse.
    """
    walker = walk_source(source)
    target = _target_at(walker, offset)
    if target is None:
        return []
    name, scope, attrs = target
    return _resolve(walker, os.path.abspath(path), name, scope, attrs, _roots(path), MAX_HOPS)


# -- what was clicked ------------------------------------------------------------------------------------

def _target_at(walker: _Walker, offset: int) -> tuple[str, int, list[str]] | None:
    """``(name, scope, attributes)``: a name (``attributes`` empty) or an attribute read off one (``mod.f`` on ``f``)."""
    for r in walker.references:
        if r["start"] <= offset <= r["end"]:
            return r["name"], r["scope"], []
    for node in ast.walk(walker.tree):
        if not isinstance(node, ast.Attribute) or node.end_lineno is None or node.end_col_offset is None:
            continue
        end = walker.offsets.at(node.end_lineno, node.end_col_offset)
        if not end - _utf16_len(node.attr) <= offset <= end:
            continue
        attrs: list[str] = []
        base: ast.AST = node
        while isinstance(base, ast.Attribute):
            attrs.insert(0, base.attr)
            base = base.value
        if not isinstance(base, ast.Name):
            return None
        start = walker.offsets.at(base.lineno, base.col_offset)
        ref = next((r for r in walker.references if r["start"] == start and r["name"] == base.id), None)
        return (base.id, ref["scope"], attrs) if ref else None
    return None


# -- where it is defined ---------------------------------------------------------------------------------

def _location(walker: _Walker, path: str, site: dict) -> dict:
    line = site["line"]
    return {"path": path, "line": line, "column": site["start"] - walker.offsets.starts[line - 1] + 1}


def _site(walker: _Walker, name: str, scope: int) -> dict | None:
    """The binding to go to: the first ``def``, ``class`` or import of the name in its scope, else its first assignment or parameter."""
    sites = [s for s in walker.sites if s["name"] == name and s["scope"] == scope]
    return next((s for s in sites if s["kind"] in _PREFERRED), sites[0] if sites else None)


def _resolve(walker: _Walker, path: str, name: str, scope: int, attrs: list[str], roots: list[str], hops: int) -> list[dict]:
    if scope < 0 or hops <= 0:
        return []  # a builtin or an undefined name
    site = _site(walker, name, scope)
    if site is None:
        return []
    if site["kind"] == "import":
        stmt, alias = site["node"], site["alias"]
        if isinstance(stmt, ast.ImportFrom):
            module = _module_path(stmt.module or "", stmt.level, path, roots)
            return _in_module(module, [alias.name, *attrs], roots, hops - 1) if module else []
        dotted = alias.name if alias.asname else alias.name.split(".")[0]
        module = _module_path(dotted, 0, path, roots)
        return _in_module(module, attrs, roots, hops - 1) if module else []
    if attrs and site["kind"] == "class":
        # `Class.method`: the class body's own binding of the attribute
        body = next((i for i, s in enumerate(walker.scopes) if s.get("class") and walker.offsets.at(site["node"].lineno, site["node"].col_offset) == s["start"]), None)
        member = _site(walker, attrs[0], body) if body is not None else None
        if member:
            return [_location(walker, path, member)]
    return [_location(walker, path, site)]


def _in_module(module: str, names: list[str], roots: list[str], hops: int) -> list[dict]:
    """``names[0]`` (then the rest as attributes) in a module file, or a package directory's submodule; the module itself when ``names`` is empty."""
    is_dir = os.path.isdir(module)
    init = os.path.join(module, "__init__.py") if is_dir else module
    if not names:
        return [{"path": init, "line": 1, "column": 1}] if os.path.isfile(init) else []
    if os.path.isfile(init):
        try:
            with open(init, encoding="utf-8") as f:
                walker = walk_source(f.read())
        except (OSError, SyntaxError, ValueError, UnicodeDecodeError):
            walker = None
        if walker is not None and _site(walker, names[0], 0):
            return _resolve(walker, init, names[0], 0, names[1:], roots, hops)
    if is_dir or os.path.basename(module) == "__init__.py":
        package = module if is_dir else os.path.dirname(module)
        sub = _existing(os.path.join(package, names[0]))
        if sub:
            return _in_module(sub, names[1:], roots, hops - 1)
    return []


# -- module files ----------------------------------------------------------------------------------------

def _roots(path: str) -> list[str]:
    """The importing file's directory, the project root above it and its ``src/``."""
    here = os.path.dirname(os.path.abspath(path))
    out = [here]
    d = here
    while True:
        if any(os.path.exists(os.path.join(d, m)) for m in _PROJECT_MARKERS):
            out += [d, os.path.join(d, "src")]
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return [r for i, r in enumerate(out) if r not in out[:i] and os.path.isdir(r)]


def _library(path: str) -> bool:
    """Installed packages and the standard library are out of scope."""
    parts = path.replace("\\", "/").split("/")
    if "site-packages" in parts or "dist-packages" in parts:
        return True
    stdlib = sysconfig.get_paths().get("stdlib")
    return bool(stdlib) and os.path.abspath(path).startswith(os.path.abspath(stdlib) + os.sep)


def _existing(base: str) -> str | None:
    """``base.py``, or the package directory ``base/`` (with or without ``__init__.py``)."""
    if os.path.isfile(base + ".py") and not _library(base):
        return base + ".py"
    if os.path.isdir(base) and not _library(base):
        return base
    return None


def _module_path(dotted: str, level: int, path: str, roots: list[str]) -> str | None:
    parts = [p for p in dotted.split(".") if p]
    if level:
        base = os.path.dirname(os.path.abspath(path))
        for _ in range(level - 1):
            base = os.path.dirname(base)
        bases = [base]
    else:
        bases = roots
    for base in bases:
        if not parts:
            return base if os.path.isfile(os.path.join(base, "__init__.py")) else None
        found = _existing(os.path.join(base, *parts))
        if found:
            return found
    return None


__all__ = ["definitions", "MAX_HOPS"]
