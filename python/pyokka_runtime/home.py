"""Where Pyokka keeps its per-user state: ``$PYOKKA_HOME``, else ``~/.pyokka``.

Session descriptors (``sessions/``), the relaunch memory (``last-debug.json``) and the library
cache (``cache/``) all live under it. The extension resolves the same directory with the same
rule (``src/util/paths.ts``, ``pyokkaHome``), so a CLI started from a terminal finds the sessions
of a window that sees the same ``PYOKKA_HOME``. A leading ``~`` is expanded; an empty value counts
as unset.
"""

from __future__ import annotations

import os
from typing import Mapping

HOME_ENV = "PYOKKA_HOME"


def pyokka_home(env: Mapping[str, str] | None = None) -> str:
    value = (os.environ if env is None else env).get(HOME_ENV)
    if value:
        return os.path.abspath(os.path.expanduser(value))
    return os.path.join(os.path.expanduser("~"), ".pyokka")


__all__ = ["HOME_ENV", "pyokka_home"]
