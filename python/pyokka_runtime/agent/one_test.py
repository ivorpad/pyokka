"""``run --test NAME`` and ``debug --test NAME``: one test of a test file, run by its test runner.

A test file run as a script defines its tests and runs none, so ``--test`` launches the runner as
``python -m`` does (``run.module``, ``module_run.py``) with the file's test named on its command
line. The file and whatever it imports still go through the runtime's finder, so the test's body
is recorded and the runner's own code (pytest, unittest) is not.

Which runner the name picks:

- ``test_b``, ``TestCart::test_total``, ``test_b[2]``, ``test_x.py::test_b``: a pytest node id,
  ``FILE::NAME``, so exactly that test runs.
- ``Cart.test_total``, ``test_x.Cart.test_total``: unittest's dotted name; the module part is the
  file's own when left out.
- anything else (``"total and not slow"``): pytest ``-k NAME``.

pytest runs with ``-s`` (output goes to the recording, not pytest's capture), ``--assert=plain``
(pytest's assertion rewriting imports test modules through its own loader, which would bypass the
runtime's) and ``-p no:cacheprovider`` (no ``.pytest_cache`` in the user's project).
"""

from __future__ import annotations

import os
import re

PYTEST_FLAGS = ["-q", "-s", "--assert=plain", "-p", "no:cacheprovider"]

_IDENT = r"[A-Za-z_][A-Za-z0-9_]*"
_NODE_RE = re.compile(r"^%s(::%s)*(\[.*\])?$" % (_IDENT, _IDENT))
_DOTTED_RE = re.compile(r"^%s(\.%s)+$" % (_IDENT, _IDENT))


def runner_for(file: str, name: str) -> tuple[str, list[str]]:
    """``(module, argv)`` that runs only test ``name`` of ``file``."""
    path = os.path.abspath(file)
    base = os.path.basename(path)
    stem = os.path.splitext(base)[0]
    test = name.strip()
    for prefix in (path + "::", file + "::", base + "::"):
        if test.startswith(prefix):
            test = test[len(prefix):]
            break
    if _DOTTED_RE.match(test):
        return "unittest", [test if test.split(".", 1)[0] == stem else "%s.%s" % (stem, test)]
    if _NODE_RE.match(test):
        return "pytest", ["%s::%s" % (path, test), *PYTEST_FLAGS]
    return "pytest", [path, "-k", test, *PYTEST_FLAGS]


def apply_test(request: dict, file: str, name: str, argv: list[str]) -> dict:
    """Turn a ``run`` request for ``file`` into a ``run.module`` request for one test.

    The file goes as the top-level ``path`` rather than ``file``: it stays the run's file (its
    name, its directory as the project root) without being run itself. ``argv`` (the program's
    arguments after ``--``) follow the runner's own.
    """
    module, words = runner_for(file, name)
    request.pop("file", None)
    request["path"] = os.path.abspath(file)
    request["module"] = module
    request["argv"] = [*words, *argv]
    return request


__all__ = ["runner_for", "apply_test", "PYTEST_FLAGS"]
