"""The hook set a debugger with no recording installs: count the statement, pause if asked, else go.

The instrumented code is identical in both modes; only what the hooks do differs. Nothing here
records: no coverage, no steps, no scopes, no logs, no timings, no locals. Per statement there is
one integer increment, one list read and, while a reason is armed, one dict lookup. No list append,
no tuple, no dict write, no frame fetch, no attribute lookup on the tracer, no clock read and no
call into the debugger unless a breakpoint matched or a non-breakpoint reason is armed.

``count`` is the statement counter the pause, ``output`` and ``run.finished`` report. ``cell`` is
the debugger's two-flag arming cell: ``cell[0]`` while any reason can fire, ``cell[1]`` while a
reason that is not a breakpoint is armed. ``by_rid`` is the breakpoint index, mutated in place by
``set_breakpoints`` so this closure keeps the same dict. Closure cells beat attribute lookups, and
a list cell is readable from the debugger.

Step Over and Step Out need no scope table: ``_pk_f`` hands out a per-call id from a counter and
``_pk_x``, which the instrumenter already calls from a ``finally``, tells the debugger when the
frame it is stepping in has returned (``Debugger.on_leave``). A server running for an hour holds
one integer, one pending tuple and the breakpoint index.

A run that records from a pause on (``config.recordFrom``, ``record_from.py``) also counts hits
here, one list increment per statement, so its coverage covers the code before the pause too.
Its per-call ids start at ``FOREIGN``, which the recording hooks tell apart from their own.
"""

from __future__ import annotations

import sys
import time
from typing import Any, Callable

from .returns import END, UNSET
from .tracer import LIB_MODULE, NO_SCOPE


def make_debug_hooks(tracer: Any, dbg: Any) -> dict[str, Callable]:
    count = dbg.count
    cell = dbg.cell
    by_rid = dbg.by_rid
    next_sid = dbg.next_sid
    library_modules = tracer.library_modules
    getframe = sys._getframe

    def step(rid: int, scope: int = 0) -> None:
        try:
            count[0] += 1
            if cell[0]:
                bp = by_rid.get(rid)
                if bp is not None or cell[1]:
                    dbg.on_step(count[0] - 1, rid, scope, bp)
        except Exception as exc:  # noqa: BLE001 - a bug in the debugger must not break the program
            tracer.hook_error(exc, "step")

    def cov(rid: int) -> None:
        return None  # coverage is a recording

    if tracer.config.records_later:
        # A run that records from a pause on counts hits from the start, so its coverage covers the
        # whole run. The recording hooks keep counting in the same list after the switch.
        hits = tracer.hits

        def step(rid: int, scope: int = 0) -> None:  # noqa: F811
            try:
                hits[rid] += 1
                count[0] += 1
                if cell[0]:
                    bp = by_rid.get(rid)
                    if bp is not None or cell[1]:
                        dbg.on_step(count[0] - 1, rid, scope, bp)
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "step")

        def cov(rid: int) -> None:  # noqa: F811
            try:
                hits[rid] += 1
            except Exception as exc:  # noqa: BLE001
                tracer.hook_error(exc, "coverage")

    def enter(rid: int) -> int:
        try:
            if rid in library_modules:
                tracer.quiet += 1
                dbg.rearm()  # a library module body is not steppable: cell[0] = 0 until the import ends
                return LIB_MODULE
            if tracer.quiet:
                return NO_SCOPE
            sid = next_sid[0] = next_sid[0] + 1
            if cell[0]:
                bp = by_rid.get(rid)  # a breakpoint on a `def` line pauses at every entry
                if bp is not None or cell[1]:
                    dbg.on_step(count[0], rid, sid, bp)
                    count[0] += 1
                    return sid
            count[0] += 1
            return sid
        except Exception as exc:  # noqa: BLE001
            tracer.hook_error(exc, "scope")
            return NO_SCOPE

    def leave(sid: int, rv: Any = None) -> None:  # `rv`: the return value, unused without a recording
        try:
            if sid == LIB_MODULE:
                tracer.quiet = max(0, tracer.quiet - 1)
                dbg.rearm()
            elif dbg.pending_sid == sid:
                dbg.on_leave(getframe(1))  # the frame we are stepping in has returned
        except Exception as exc:  # noqa: BLE001
            tracer.hook_error(exc, "scope")

    def value(rid: int, ctx: Any, val: Any, kind: str, marker_id: Any = None, change_id: Any = None, fn: Any = None, discard: bool = False) -> Any:
        return val

    def timed(rid: int, ctx: Any, t0: float, val: Any, kind: str, marker_id: Any = None, change_id: Any = None) -> Any:
        return val

    def pk_print(rid: int, *args: Any, **kwargs: Any) -> None:
        # The program's print reaches sys.stdout, which is the StepStream, which emits `output`.
        tracer.real_print(*args, **kwargs)

    def logpoint(rid: int, kind: str, template: str, ctx: Any, marker_id: Any, change_id: Any, is_expr: bool = False) -> None:
        return None  # logpoints are markers and never pause

    def snap_error(exc_or_text: Any, rid: int) -> None:
        try:
            tracer.report_snap_error(exc_or_text, rid)
        except (SystemExit, KeyboardInterrupt):
            raise
        except Exception as exc:  # noqa: BLE001
            tracer.hook_error(exc, "snap")

    return {
        "_pk_s": step,
        "_pk_c": cov,
        "_pk_f": enter,
        "_pk_x": leave,
        "_pk_u": UNSET,
        "_pk_end": END,
        "_pk_v": value,
        "_pk_t": timed,
        "_pk_print": pk_print,
        "_pk_logpoint": logpoint,
        "_pk_time": time.perf_counter,
        "_pk_snap_error": snap_error,
        "print": tracer.real_print,  # not patched: in debugger mode `print` is Python's own print
    }
