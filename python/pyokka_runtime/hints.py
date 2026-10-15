"""One line of advice on an uncaught error that says the program ran on the wrong interpreter.

A ``ModuleNotFoundError`` in a project that has a lock file or a ``pyproject.toml`` and a ``.venv``
beside it, raised on an interpreter that is not that ``.venv``'s, is the usual sign of a run on
pyokka's own Python or the system's. The hint names ``--python`` with the venv's interpreter; the
interpreter is never switched by itself. An ordinary missing module elsewhere gets no hint.
"""

from __future__ import annotations

import os
import sys

PROJECT_FILES = ("uv.lock", "poetry.lock", "pyproject.toml")


def _venv_python(venv: str) -> str | None:
    for rel in (os.path.join("bin", "python"), os.path.join("Scripts", "python.exe")):
        p = os.path.join(venv, rel)
        if os.path.isfile(p):
            return p
    return None


def project_venv(path: str) -> tuple[str, str, str] | None:
    """``(project dir, marker file, venv python)`` for the project ``path`` belongs to, or None.

    Walks up from the file's directory to the git root (or the filesystem root); the first
    directory with a marker file decides, and it needs a ``.venv`` with an interpreter in it.
    """
    d = os.path.dirname(os.path.abspath(path))
    while True:
        marker = next((f for f in PROJECT_FILES if os.path.isfile(os.path.join(d, f))), None)
        if marker:
            python = _venv_python(os.path.join(d, ".venv"))
            return (d, marker, python) if python else None
        if os.path.exists(os.path.join(d, ".git")):
            return None
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _same_env(python: str) -> bool:
    """The running interpreter is that venv's: the same ``sys.prefix``."""
    venv = os.path.dirname(os.path.dirname(python))
    try:
        return os.path.realpath(sys.prefix) == os.path.realpath(venv)
    except OSError:
        return False


def venv_hint(exc: BaseException, paths: list[str]) -> str | None:
    """The hint for an uncaught ``exc`` raised in a run of ``paths`` (the stack's files, the program first), or None."""
    if not isinstance(exc, ModuleNotFoundError):
        return None
    for path in paths:
        if not path or not os.path.isabs(path) or "site-packages" in path:
            continue
        found = project_venv(path)
        if found is None:
            continue
        root, marker, python = found
        if _same_env(python):
            return None
        rel = os.path.relpath(python, os.path.dirname(os.path.abspath(paths[0])))
        return "%s has %s and a .venv; this run used %s, so the project's packages were not importable: rerun with --python %s" % (
            root, marker, sys.executable, rel if not rel.startswith("..") else python)
    return None


__all__ = ["venv_hint", "project_venv"]
