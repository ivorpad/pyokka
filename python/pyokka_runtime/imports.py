"""The project files a Python file reaches through its imports, read statically (``ast``, nothing is
imported or run), for the browser page: it shows and watches them before any run instrumented them.

Names resolve as ``import`` would when the file runs as a script: absolute names on the file's
directory, the project root, then this interpreter's ``sys.path`` (so a name a package provides
resolves to that package, as at run time, even when its site-packages sits under the root in a
``.venv``), relative ones (``from .x import y``) from the importing file's
package, each dotted part through ``importlib.machinery.PathFinder`` (the finder ``find_spec``
asks, given the parent package's path so no ``__init__`` runs). Only ``.py`` files under the root
are kept; the standard library, site-packages and the runtime are left out, as they are from the
recording.
"""

from __future__ import annotations

import ast
import importlib
import os
import site
import sys
import sysconfig
from importlib.machinery import PathFinder

LIMIT = 200
RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))


def _skip_prefixes() -> list[str]:
    out = {RUNTIME_DIR, sys.prefix, sys.base_prefix, sys.exec_prefix}
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        p = sysconfig.get_paths().get(key)
        if p:
            out.add(p)
    try:
        out.update(site.getsitepackages())
    except Exception:  # noqa: BLE001
        pass
    try:
        out.add(site.getusersitepackages())
    except Exception:  # noqa: BLE001
        pass
    return [os.path.realpath(p).rstrip(os.sep) + os.sep for p in out if p]


def _resolve(parts: list[str], path: list[str]) -> tuple[list[str], list[str] | None]:
    """The files importing ``parts`` on ``path`` loads (each package's ``__init__.py``, then the module),
    and the search path of the last part when it is a package (None for a module or a name not found)."""
    files: list[str] = []
    search: list[str] | None = path
    for part in parts:
        if search is None:
            return files, None  # an attribute of a module, not a submodule
        try:
            spec = PathFinder.find_spec(part, search)
        except (ImportError, ValueError):
            return files, None
        if spec is None:
            return files, None
        if spec.origin and spec.origin.endswith(".py"):
            files.append(spec.origin)
        search = list(spec.submodule_search_locations) if spec.submodule_search_locations is not None else None
    return files, search


def _imports_of(file: str, tree: ast.AST, base_path: list[str]) -> list[str]:
    out: list[str] = []
    here = os.path.dirname(file)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out += _resolve(alias.name.split("."), base_path)[0]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                pkg_dir = here
                for _ in range(node.level - 1):
                    pkg_dir = os.path.dirname(pkg_dir)
                init = os.path.join(pkg_dir, "__init__.py")
                if os.path.isfile(init):
                    out.append(init)
                files, search = _resolve(node.module.split("."), [pkg_dir]) if node.module else ([], [pkg_dir])
            else:
                files, search = _resolve((node.module or "").split("."), base_path)
            out += files
            if search is not None:
                # `from pkg import name`: a name that is a submodule is a file too
                for alias in node.names:
                    if alias.name != "*":
                        out += _resolve([alias.name], search)[0]
    return out


def _interpreter_path() -> list[str]:
    """``sys.path`` without the current directory and the runtime's own directory (this process's, not the program's)."""
    own = os.path.dirname(RUNTIME_DIR)
    return [p for p in sys.path if p and os.path.isdir(p) and os.path.realpath(p) != os.path.realpath(own)]


def local_imports(entry: str, root: str | None = None, limit: int = LIMIT, path: list[str] | None = None) -> list[str]:
    """Breadth-first from ``entry``: every project file it reaches, at most ``limit``, entry excluded.
    ``path`` replaces the interpreter's ``sys.path`` after the file's directory and the root."""
    importlib.invalidate_caches()  # a directory's listing may be cached from before a file was added
    entry = os.path.realpath(entry)
    root_dir = os.path.realpath(root or os.path.dirname(entry)).rstrip(os.sep) + os.sep
    skip = [p for p in _skip_prefixes() if not root_dir.startswith(p)]
    base_path = list(dict.fromkeys([os.path.dirname(entry), root_dir.rstrip(os.sep), *(_interpreter_path() if path is None else path)]))
    found: list[str] = []
    seen = {entry}
    queue = [entry]
    while queue and len(found) < limit:
        current = queue.pop(0)
        try:
            with open(current, "rb") as fh:
                tree = ast.parse(fh.read(), current)
        except (OSError, SyntaxError, ValueError):
            continue
        for path in _imports_of(current, tree, base_path):
            real = os.path.realpath(path)
            if real in seen or not real.startswith(root_dir) or any(real.startswith(p) for p in skip):
                continue
            if os.sep + "site-packages" + os.sep in real or os.sep + "dist-packages" + os.sep in real:
                continue
            seen.add(real)
            found.append(real)
            queue.append(real)
            if len(found) >= limit:
                break
    return found
