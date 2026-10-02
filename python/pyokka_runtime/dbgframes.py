"""The paused frame chain: the stack a debug pause reports and the frame a ``frameId`` addresses.

A debugger with no recording has no scope table to read a stack from, so the stack comes from the
frames themselves: ``f_back`` from the paused frame, the runtime's own frames dropped. Each entry
carries the frame's real ``f_lineno``, so a caller frame points at the call and not at its ``def``
line, and ``fileId`` / ``rid`` / ``scopeId`` when the file is instrumented.

``frame_chain`` and ``frame_stack`` walk the same frames in the same order, so ``frameId`` is the
index into both: ``0`` is the paused frame. ``Debugger.frames`` holds the chain while a pause is
served and ``frame_at`` resolves a request's ``frameId`` against it.
"""

from __future__ import annotations

import os
import threading
from typing import Any

from .instrument import SCOPE_NAME

RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_FRAMES = 64
PARENT_FRAMES = 4  # how many `f_back` frames a leaving frame looks up for one that can take its step


def _is_runtime(filename: str) -> bool:
    return filename.startswith(RUNTIME_DIR)


def frame_chain(tracer: Any, frame: Any) -> list[Any]:
    """``frame`` and its callers, innermost first, without the runtime's own frames.

    The walk ends at the frame running the program's own top-level code (``tracer.stop_code``, as
    ``errors.py`` stops its stacks), so whatever called the run is never part of the stack. A
    thread's chain has no such frame and ends at the ``threading`` frames that started it.
    """
    out: list[Any] = []
    stop_code = tracer.stop_code
    f = frame
    while f is not None and len(out) < MAX_FRAMES:
        code = f.f_code
        if not _is_runtime(code.co_filename):
            out.append(f)
        if code is stop_code:
            break
        f = f.f_back
    return out


def scope_of(frame: Any) -> int | None:
    """The scope id the instrumented code assigned to this frame, else ``None``.

    A function's is the ``_pk_scope_`` fast local; an imported module body's is the global of the
    same name; the main file's module frame has neither and is scope 0.
    """
    code = frame.f_code
    if SCOPE_NAME in code.co_varnames:
        sid = frame.f_locals.get(SCOPE_NAME)
    elif code.co_name == "<module>":
        sid = frame.f_globals.get(SCOPE_NAME, 0)
    else:
        return None
    return sid if isinstance(sid, int) and sid >= 0 else None


def step_target(frame: Any, hops: int = PARENT_FRAMES) -> int | None:
    """The scope a step armed in ``frame`` moves to when ``frame`` exits, ``None`` when none can.

    An instrumented ancestor takes it, which is the step rule: over is the next statement in the
    paused scope or one of its ancestors. A function frame's scope is its ``_pk_scope_`` fast local,
    the per-call sid the step then waits for; a module body's is 0, or the ``_pk_scope_`` global an
    imported project module assigns, and nothing above a module body is a caller.

    ``None`` when there is no such ancestor within ``hops``: the frame was called from code that is
    not instrumented (a library calling back into the program, a thread target, a request handler
    under a web framework) or from nothing at all, so a step handed to its caller would wait for a
    scope that may never run another statement.
    """
    f = frame.f_back
    for _ in range(hops):
        if f is None:
            return None
        code = f.f_code
        # `f_locals` snapshots a function frame's locals on 3.12 (a proxy since 3.13): only touch
        # it where `_pk_scope_` can exist, an instrumented function's fast locals
        if SCOPE_NAME in code.co_varnames:
            sid = f.f_locals.get(SCOPE_NAME)
            if isinstance(sid, int) and sid >= 0:
                return sid
        if code.co_name == "<module>":
            sid = f.f_globals.get(SCOPE_NAME)
            return sid if isinstance(sid, int) and sid >= 0 else 0
        f = f.f_back
    return None


def top_line(lines: dict[int, int], frame: Any, line: int | None) -> dict[int, int]:
    """``lines`` with the paused frame pinned to the line the pause reports, if it is not already.

    Frame 0 of a stack reports the statement the pause is on. The two differ at a function entry:
    the pause is on the ``def`` line, as every debugger's is, while the frame's own ``f_lineno`` is
    the first body statement, the one about to run. An exception pause has already pinned its
    frames from the traceback, which is the more exact line, and keeps them.
    """
    if frame is None or line is None or id(frame) in lines:
        return lines
    return {**lines, id(frame): line}


def frame_stack(tracer: Any, frame: Any, lines: dict[int, int] | None = None) -> list[dict]:
    """The pause's stack: one entry per frame of ``frame_chain``, innermost first.

    ``lines`` overrides a frame's line by ``id(frame)``. An exception pause needs it: a frame that
    has unwound reports the last line it ran, and only the traceback knows where it raised.
    """
    out: list[dict] = []
    for frame_id, f in enumerate(frame_chain(tracer, frame)):
        code = f.f_code
        line = (lines or {}).get(id(f)) or f.f_lineno
        entry: dict[str, Any] = {"frameId": frame_id, "name": code.co_name, "fileId": 0, "line": line}
        info = tracer.files.get(code.co_filename)
        if info is not None:
            entry["fileId"] = info.file_id
            entry["rid"] = tracer.rid_at(info, line)
            sid = scope_of(f)
            if sid is not None:
                entry["scopeId"] = sid
        else:
            # no instrumented file to point at, so a stop slice folds this frame; its path is what
            # lets the fold say which library the chain went through instead of just dropping it
            entry["path"] = code.co_filename
        out.append(entry)
    return out


def frame_at(frames: list[Any], frame_id: Any) -> Any:
    """The frame a request addresses. ``LookupError`` when the pause has no such frame."""
    try:
        index = int(frame_id or 0)
    except (TypeError, ValueError):
        raise LookupError("no frame %r in this pause" % frame_id) from None
    if index < 0 or index >= len(frames):
        raise LookupError("no frame %d in this pause" % index)
    return frames[index]


def thread_info() -> dict:
    """Which thread is paused, on every pause in both modes."""
    return {"name": threading.current_thread().name, "ident": threading.get_ident()}
