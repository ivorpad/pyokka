"""One scratchpad experiment, run as ``python -I scratchpad_child.py --result-fd N`` (see scratchpad.py).

This file imports nothing from pyokka_runtime: ``-I`` leaves PYTHONPATH, the user site and the
script's own directory off ``sys.path``, so only the standard library and the interpreter's
site-packages are importable, plus the source file's directory that the request names. The
request arrives as JSON on stdin; the result leaves as one JSON line on the result descriptor, so
whatever the experiment prints cannot be mistaken for it.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import io
import json
import os
import sys
import traceback
from unittest import mock

CAPTURE = "__pyokka_capture__"
MAX_VALUES = 200
MAX_OUTPUT = 64_000
MAX_REPR = 500


def show(value: object) -> str:
    try:
        text = repr(value)
    except BaseException as exc:  # noqa: BLE001 - user __repr__ may raise anything
        text = "<%s object, repr raised %s>" % (type(value).__name__, type(exc).__name__)
    return text if len(text) <= MAX_REPR else text[: MAX_REPR - 1] + "…"


class Output(io.TextIOBase):
    """print() and sys.stderr of the experiment, kept up to MAX_OUTPUT characters."""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self.size = 0
        self.capped = False

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        room = MAX_OUTPUT - self.size
        if room <= 0:
            self.capped = True
        else:
            self.parts.append(s[:room])
            self.size += min(len(s), room)
            self.capped = self.capped or len(s) > room
        return len(s)


class UnavailableValue(Exception):
    """The experiment used a value the pause had but a fresh process cannot rebuild."""


MISSING: list[str] = []


class Unavailable:
    """Stands for a paused value that was not copied. Using it in any way raises UnavailableValue."""

    __slots__ = ("_name", "_reason")

    def __init__(self, name: str, reason: str) -> None:
        object.__setattr__(self, "_name", name)
        object.__setattr__(self, "_reason", reason)

    def _touch(self, *_a: object, **_k: object):
        name = object.__getattribute__(self, "_name")
        if name not in MISSING:
            MISSING.append(name)
        raise UnavailableValue("%s is not available in the scratchpad: %s. Give it a value in Inputs, or mock what the code calls on it." % (name, object.__getattribute__(self, "_reason")))

    def __repr__(self) -> str:
        return "<unavailable %s: %s>" % (object.__getattribute__(self, "_name"), object.__getattribute__(self, "_reason"))

    def __getattr__(self, _attr: str):
        return self._touch()

    __setattr__ = __call__ = __iter__ = __len__ = __getitem__ = __setitem__ = __contains__ = _touch
    __bool__ = __eq__ = __ne__ = __lt__ = __le__ = __gt__ = __ge__ = __hash__ = _touch
    __add__ = __radd__ = __sub__ = __rsub__ = __mul__ = __rmul__ = __truediv__ = __int__ = __float__ = __str__ = _touch


def instrument(body: list[ast.stmt]) -> list[ast.stmt]:
    """After each assignment to a plain name (and at the top of a for loop), record the name's value."""
    out: list[ast.stmt] = []
    for stmt in body:
        for field in ("body", "orelse", "finalbody"):
            inner = getattr(stmt, field, None)
            if isinstance(inner, list) and inner and isinstance(inner[0], ast.stmt):
                setattr(stmt, field, instrument(inner))
        for handler in getattr(stmt, "handlers", None) or []:
            handler.body = instrument(handler.body)
        for case in getattr(stmt, "cases", None) or []:
            case.body = instrument(case.body)
        out.append(stmt)
        targets: list[ast.expr] = []
        if isinstance(stmt, ast.Assign):
            targets = list(stmt.targets)
        elif isinstance(stmt, (ast.AugAssign, ast.AnnAssign)) and getattr(stmt, "value", None) is not None:
            targets = [stmt.target]
        elif isinstance(stmt, (ast.For, ast.AsyncFor)):
            stmt.body[:0] = capture_names(stmt.target, stmt.lineno, stmt)
        for target in targets:
            out.extend(capture_names(target, stmt.lineno, stmt))
    return out


def capture_names(target: ast.expr, line: int, at: ast.AST) -> list[ast.stmt]:
    names = [n.id for n in ast.walk(target) if isinstance(n, ast.Name)]
    calls = [ast.Expr(ast.Call(ast.Name(CAPTURE, ast.Load()), [ast.Constant(n), ast.Constant(line), ast.Name(n, ast.Load())], [])) for n in names]
    for c in calls:
        ast.copy_location(c, at)
        ast.fix_missing_locations(c)
    return calls


def apply_mocks(ns: dict, mocks: dict) -> tuple[list, dict]:
    """Each mock target becomes a MagicMock: a value is its return value, an exception its side effect, a function its implementation."""
    patches = []
    made: dict[str, mock.MagicMock] = {}
    for target, value in mocks.items():
        if not isinstance(target, str) or not target:
            raise ValueError("a mock's target is a name or a dotted path, got %r" % (target,))
        if isinstance(value, mock.Base):
            fake = value
        elif isinstance(value, BaseException) or (isinstance(value, type) and issubclass(value, BaseException)):
            fake = mock.MagicMock(side_effect=value, name=target)
        elif callable(value) and not isinstance(value, type):
            fake = mock.MagicMock(side_effect=value, name=target)
        else:
            fake = mock.MagicMock(return_value=value, name=target)
        made[target] = fake
        first, _, rest = target.partition(".")
        if not rest:
            patches.append(mock.patch.dict(ns, {target: fake}))
        elif first in ns:
            owner = ns[first]
            *middle, last = rest.split(".")
            for part in middle:
                owner = getattr(owner, part)
            patches.append(mock.patch.object(owner, last, fake))
        else:
            patches.append(mock.patch(target, fake))
    return patches, made


def where(exc: BaseException) -> int | None:
    line = None
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == "<scratchpad>":
            line = frame.lineno
    return line


def main() -> int:
    fd = int(sys.argv[sys.argv.index("--result-fd") + 1])
    request = json.load(sys.stdin)
    values: list[dict] = []
    caps = {"values": False}
    result: dict = {"values": values}

    def capture(name: str, line: int, value: object) -> None:
        if len(values) < MAX_VALUES:
            values.append({"name": name, "line": line, "value": show(value), "type": type(value).__name__})
        else:
            caps["values"] = True

    source_dir = os.path.dirname(request["file"])
    sys.path.insert(0, source_dir)
    ns: dict = {"__name__": "__scratchpad__", "__builtins__": __builtins__, CAPTURE: capture, "Unavailable": Unavailable}
    out = Output()
    made: dict = {}
    stage = "dependencies"
    try:
        with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", out):
            if request.get("dependencies"):
                exec(compile(ast.parse(request["dependencies"]), request["file"], "exec"), ns)
            stage = "inputs"
            for name, reason in (request.get("unavailable") or {}).items():
                ns[name] = Unavailable(name, reason)
            if request.get("inputs", "").strip():
                exec(compile(request["inputs"], "<scratchpad inputs>", "exec"), ns)
            stage = "mocks"
            # Mocks may build their values with MagicMock or unittest.mock without importing them
            mocks = eval(compile(request["mocks"], "<scratchpad mocks>", "eval"), {**ns, "MagicMock": mock.MagicMock, "mock": mock}) if request.get("mocks", "").strip() else {}
            if not isinstance(mocks, dict):
                raise TypeError("Mocks is one dict: {target: value}, got %s" % type(mocks).__name__)
            patches, made = apply_mocks(ns, mocks)
            for p in patches:
                p.start()
            stage = "code"
            tree = ast.parse(request["code"], "<scratchpad>")
            tree.body = instrument(tree.body)
            code = compile(tree, "<scratchpad>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            try:
                if code.co_flags & inspect.CO_COROUTINE:
                    asyncio.run(eval(code, ns))
                else:
                    exec(code, ns)
            finally:
                for p in reversed(patches):
                    p.stop()
    except BaseException as exc:  # noqa: BLE001 - the experiment's failure is its result
        if isinstance(exc, SyntaxError) and stage == "code":
            line = exc.lineno
        else:
            line = where(exc) if stage == "code" else None
        result["error"] = {"type": type(exc).__name__, "message": str(exc), "stage": stage, **({"line": line} if line else {})}
        te = traceback.TracebackException.from_exception(exc)
        # the experiment's frames and the libraries it called, not this runner's
        te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename != __file__])
        result["traceback"] = "".join(te.format())[-4000:]
    if "result" in ns:
        result["result"] = show(ns["result"])
    result["output"] = "".join(out.parts)
    result["caps"] = {"values": caps["values"], "output": out.capped}
    result["missing"] = MISSING
    result["mocks"] = [{"target": t, "calls": m.call_count} for t, m in made.items()]
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
