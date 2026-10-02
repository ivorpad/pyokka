"""``run.module``: what ``python -m NAME`` does, for a debug session launched on a module.

A module launch and a file launch differ in three things and nothing else: which code runs
(``NAME``, or ``NAME.__main__`` when ``NAME`` is a package), what ``sys.argv[0]`` is (the module's
resolved file), and that ``sys.path[0]`` is the run's cwd rather than the file's directory. The
module still runs as ``__main__``, its imports still go through the runtime's ``_Finder``, and an
uncaught exception, a ``SystemExit`` or a ``KeyboardInterrupt`` are handled exactly as for a file.

Resolution goes through ``importlib``, so the module's own code comes from the loader the finder
installed and arrives instrumented, the same way a file launch's does. The code object is returned
alongside the globals, so the tracer can stop its stack walks at the module frame (``stop_code``)
and a stack never shows the runtime's own frames.
"""

from __future__ import annotations

import builtins
import importlib.util
import sys
import types
from typing import Any


class ResolvedModule:
    """What ``python -m NAME`` would run: the module to execute, its file and its compiled code."""

    __slots__ = ("name", "requested", "file", "code", "package")

    def __init__(self, name: str, requested: str, file: str, code: Any, package: str) -> None:
        self.name = name
        self.requested = requested
        self.file = file
        self.code = code
        self.package = package


def resolve(module: str) -> ResolvedModule:
    """Find the module and compile it. Raises ``ImportError`` when there is nothing to run.

    A package runs its ``__main__`` submodule, which is what ``python -m`` does. Finding the spec
    imports the parent packages (again as ``python -m`` does), so those are instrumented too.
    """
    name = module.strip()
    if not name:
        raise ImportError("run.module is empty")
    if name.endswith(".py"):
        raise ImportError("%s looks like a file; send it as run.file" % name)
    spec = importlib.util.find_spec(name)
    if spec is not None and spec.submodule_search_locations is not None:
        name = name + ".__main__"
        spec = importlib.util.find_spec(name)
    if spec is None or not spec.origin or spec.loader is None:
        raise ImportError("No module named %s" % module)
    code = spec.loader.get_code(spec.name)
    if code is None:
        raise ImportError("%s has no code to run" % name)
    return ResolvedModule(name, module, spec.origin, code, spec.parent or "")


def launch(execution: Any, module: str) -> Any:
    """Resolve ``module``, build its ``__main__`` and hand back its code, or ``None`` after saying why.

    A name that cannot be imported becomes one ``runner.error`` and an exit code of 1, as an
    unreadable file does. Anything else a parent package raises on the way propagates, so it is
    reported and paused on exactly as an exception in a file launch is. The cwd goes on
    ``sys.path`` first, because that is where ``python -m`` resolves the name from.
    """
    cwd = execution.spec.cwd
    if not sys.path or sys.path[0] != cwd:
        sys.path.insert(0, cwd)
    try:
        resolved = resolve(module)
    except ImportError as exc:
        execution.emit({"type": "runner.error", "message": "cannot run -m %s: %s: %s" % (module, type(exc).__name__, exc)})
        return None
    main = prepare(resolved, execution.spec.argv)
    execution.module = main
    execution.main_globals = main.__dict__
    if execution.tracer is not None:
        execution.tracer.stop_code = resolved.code  # stack walks stop at the module frame, as for a file
    return resolved.code


def prepare(resolved: ResolvedModule, argv: list[str]) -> types.ModuleType:
    """``sys.argv`` and the ``__main__`` module, as a ``-m`` launch leaves them."""
    sys.argv = [resolved.file, *argv]
    main = types.ModuleType("__main__")
    main.__dict__.update(
        __name__="__main__",
        __file__=resolved.file,
        __loader__=None,
        __spec__=None,
        __package__=resolved.package,
        __builtins__=builtins,
    )
    sys.modules["__main__"] = main
    return main
