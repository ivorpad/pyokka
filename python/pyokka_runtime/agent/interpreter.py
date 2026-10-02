"""Which Python runs the program of ``pyokka run``: the project's, not the one pyokka is installed in.

Order: ``--python PATH``, ``$PYOKKA_PYTHON``, ``$VIRTUAL_ENV``, then a ``.venv`` in the program's
directory or a parent, up to the git root. Without any of them it is pyokka's own interpreter.
The runtime is put on that interpreter's ``PYTHONPATH`` (``link.runner_env``), so the project's
packages and pyokka's runtime import side by side; the interpreter must be 3.12 or newer.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass

from .source import AgentError

MIN_VERSION = (3, 12)


@dataclass
class Interpreter:
    path: str
    source: str  # "--python", "$PYOKKA_PYTHON", "$VIRTUAL_ENV", ".venv in DIR", "pyokka's own"
    version: str = ""

    @property
    def is_own(self) -> bool:
        """Pyokka's own interpreter: the same file in the same directory (a venv's python links to its base, so the file alone says nothing)."""
        mine = os.path.abspath(sys.executable)
        theirs = os.path.abspath(self.path)
        if theirs == mine:
            return True
        try:
            return os.path.dirname(theirs) == os.path.dirname(mine) and os.path.samefile(theirs, mine)
        except OSError:
            return False

    def line(self) -> str:
        return "python: %s%s (%s)" % (self.path, " " + self.version if self.version else "", self.source)


def venv_python(venv: str) -> str | None:
    """The interpreter inside a virtual environment directory, or None when it has none."""
    for rel in (("bin", "python3"), ("bin", "python"), ("Scripts", "python.exe")):
        candidate = os.path.join(venv, *rel)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def find_dot_venv(start: str) -> str | None:
    """A ``.venv`` in ``start`` or a parent directory, stopping at the git root (the directory holding ``.git``) or the home directory."""
    d = os.path.abspath(start)
    while True:
        candidate = os.path.join(d, ".venv")
        if os.path.isdir(candidate) and venv_python(candidate):
            return candidate
        if os.path.exists(os.path.join(d, ".git")) or d == os.path.expanduser("~"):
            return None
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def choose(program: str, python: str | None = None, env: dict[str, str] | None = None) -> Interpreter:
    env = os.environ if env is None else env
    if python:
        return Interpreter(_executable(python, "--python"), "--python")
    if env.get("PYOKKA_PYTHON"):
        return Interpreter(_executable(env["PYOKKA_PYTHON"], "$PYOKKA_PYTHON"), "$PYOKKA_PYTHON")
    if env.get("VIRTUAL_ENV"):
        found = venv_python(env["VIRTUAL_ENV"])
        if found:
            return Interpreter(found, "$VIRTUAL_ENV")
    venv = find_dot_venv(os.path.dirname(os.path.abspath(program)))
    if venv:
        return Interpreter(venv_python(venv) or "", ".venv in %s" % os.path.dirname(venv))
    return Interpreter(sys.executable, "pyokka's own; no --python, $PYOKKA_PYTHON, $VIRTUAL_ENV or .venv found")


def _executable(given: str, flag: str) -> str:
    path = os.path.expanduser(given)
    if os.path.isdir(path):
        inner = venv_python(path)
        if inner is None:
            raise AgentError("%s %s is a directory with no bin/python in it" % (flag, given), "pass the interpreter itself, e.g. %s .venv/bin/python" % flag)
        return inner
    if not os.path.isfile(path):
        raise AgentError("%s %s does not exist" % (flag, given), "pass an interpreter path, e.g. %s .venv/bin/python" % flag)
    return os.path.abspath(path)


def probe(interp: Interpreter) -> Interpreter:
    """Fill in the version, and refuse an interpreter the runtime cannot run under."""
    if interp.is_own:
        interp.version = "%d.%d.%d" % sys.version_info[:3]
        return interp
    try:
        out = subprocess.run([interp.path, "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise AgentError("cannot start %s (%s): %s" % (interp.path, interp.source, exc), "pass a working interpreter with --python PATH") from None
    version = out.stdout.strip()
    try:
        parts = tuple(int(x) for x in version.split(".")[:2])
    except ValueError:
        raise AgentError("%s (%s) did not report a version: %s" % (interp.path, interp.source, (out.stderr or out.stdout).strip()[:200]), "pass a working interpreter with --python PATH") from None
    if parts < MIN_VERSION:
        raise AgentError("%s (%s) is Python %s; the runtime needs 3.12 or newer" % (interp.path, interp.source, version), "pass a newer interpreter with --python PATH, or run with pyokka's own: --python %s" % sys.executable)
    interp.version = version
    return interp


__all__ = ["Interpreter", "choose", "probe", "venv_python", "find_dot_venv"]
