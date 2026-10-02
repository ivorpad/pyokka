"""``exec``: run a statement in the paused frame, with the write reaching the program's own code.

This is the only place the runtime writes into a running program. Everything else that reads a
paused frame goes through ``pure.py`` and cannot have an effect: hovers, displayed watches,
break-when watches, breakpoint conditions, ``evaluate``, ``complete`` and ``shadow``. ``exec``
runs whatever ``compile(source, "<pyokka-exec>", "exec")`` accepts, so assignments, calls,
imports, ``del`` and multi-line blocks all work, and the Debug Console is a real console.

What comes back is a REPL's answer: when the last statement is an expression it is split off and
evaluated in the same namespaces as the statements before it, so ``x = 2; x * 3`` answers ``6``
and ``items.pop()`` shows what it returned. Its ``text`` is masked by the secret filter and comes
with a ``valueBag`` that ``expand`` can open; a block whose last statement is not an expression
answers ``text: ""`` and no bag.

Reaching the frame's own variables takes a different move per interpreter:

* module level: the frame's globals *are* the module dict, so an assignment is already visible.
* 3.13+: ``f_locals`` is the write-through proxy of PEP 667, so ``exec`` into it lands in the
  frame's fast locals directly.
* 3.12: ``f_locals`` is a snapshot dict cached on the frame, so the exec writes into the snapshot
  and ``PyFrame_LocalsToFast`` pushes it back into the fast locals. It is the one thing here that
  needs ``ctypes``, which is why the import sits inside that branch and why a build without
  ``ctypes`` refuses the request before running anything rather than after.

A name the function itself declares reaches the program's own code on both branches. A brand-new
name is kept in the frame's locals mapping, so a later ``exec``, ``evaluate`` or ``locals`` sees
it, but the function's compiled code does not, because it has no slot for it.

A statement that raises is not a failed request: the session stays paused and the raise is
reported inside the reply, with the runtime's own frames cut off the traceback. Only a request
that cannot be served at all (no frame, no ``ctypes`` on 3.12) is an ``exec.error``.
"""

from __future__ import annotations

import ast
import sys
import textwrap
import traceback
from typing import Any

from . import secrets
from .serialize import expression_name, short_repr

FILENAME = "<pyokka-exec>"
_WRITE_THROUGH = sys.version_info >= (3, 13)  # PEP 667: `f_locals` writes straight through to the frame


class FrameWriteUnsupported(Exception):
    """This interpreter cannot push a frame's locals back: the reply is ``exec.error``, plain."""


def exec_in_frame(debugger: Any, source: str, frame: Any) -> dict:
    """Run ``source`` in ``frame``. The ``exec.result`` payload, exceptions included."""
    debugger.modified = True  # any attempt: a statement that raised halfway may already have written
    tree = ast.parse(textwrap.dedent(source).strip(), mode="exec")
    scope, push = _write_back(frame)
    exception = None
    try:
        text, bag = _run(tree, frame.f_globals, scope, debugger)
    except BaseException as exc:  # noqa: BLE001 - the program's own error, reported, not raised
        text, bag, exception = "", None, _raised(exc)
    if push is not None:
        push(frame)  # also after a raise: what ran before it may have assigned
    reply: dict[str, Any] = {"text": text}
    if bag is not None:
        reply["valueBag"] = bag
    reply["modified"] = True
    if exception is not None:
        reply["exception"] = exception
    return reply


def _write_back(frame: Any) -> tuple[Any, Any]:
    """The locals mapping to exec into, and what pushes it back into the frame afterwards.

    ``None`` locals means "the globals are the namespace", which is both what module-level code
    wants and what ``exec`` and ``eval`` already do with ``locals=None``.
    """
    if frame.f_code.co_name == "<module>":
        return None, None
    if _WRITE_THROUGH:
        return frame.f_locals, None
    _require_ctypes()  # before anything runs: an exec whose write cannot land is refused, not half-done
    return frame.f_locals, _locals_to_fast


def _require_ctypes() -> Any:
    try:
        import ctypes  # noqa: PLC0415 - only the 3.12 write-back needs it
    except ImportError:
        raise FrameWriteUnsupported("cannot write to a frame on Python 3.12 without ctypes") from None
    return ctypes


def _locals_to_fast(frame: Any) -> None:
    """3.12: push the snapshot the exec wrote into back into the frame's fast locals."""
    ctypes = _require_ctypes()
    ctypes.pythonapi.PyFrame_LocalsToFast(ctypes.py_object(frame), ctypes.c_int(0))


def _run(tree: ast.Module, g: dict, scope: Any, debugger: Any) -> tuple[str, dict | None]:
    """The REPL rule: a trailing expression is evaluated and shown, everything else just runs."""
    last = tree.body[-1] if tree.body else None
    if not isinstance(last, ast.Expr):
        exec(compile(tree, FILENAME, "exec"), g, scope)  # noqa: S102 - the point of the request
        return "", None
    head = ast.Module(body=tree.body[:-1], type_ignores=[])
    if head.body:
        exec(compile(head, FILENAME, "exec"), g, scope)  # noqa: S102 - same namespaces as the expression
    shown = ast.unparse(last.value)
    value = eval(compile(ast.Expression(last.value), FILENAME, "eval"), g, scope)  # noqa: S307
    text = secrets.current.mask_text(expression_name(shown), value, short_repr(value))
    return text, debugger.tracer._bag(value, debugger.value_key(), 1, "value", shown)


def _raised(exc: BaseException) -> dict:
    """The raise as a console shows it: the traceback starts at the exec'd source, not at us."""
    tb = exc.__traceback__
    own = tb
    while own is not None and own.tb_frame.f_code.co_filename != FILENAME:
        own = own.tb_next
    return {"type": type(exc).__name__, "message": str(exc), "traceback": "".join(traceback.format_exception(type(exc), exc, own or tb))}
