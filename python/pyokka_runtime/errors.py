"""Exception tracking for the tracer via ``sys.monitoring`` (tool id 3).

Exception events are global-only in ``sys.monitoring`` (they cannot be set
per code object and ``DISABLE`` is refused for RAISE), so the callbacks
filter on ``code.co_filename``. RAISE fires in every frame an exception
propagates into: the first sighting of an exception object is its origin
(step flag 2), later sightings are the unwinding path (flag 16).

Where an exception was caught is only known at the end: every ``finally``,
every ``with`` cleanup (``__exit__`` returning false), the instrumenter's own
try/finally around function bodies and a non-matching ``except`` block all fire
EXCEPTION_HANDLED, then RERAISE as the exception keeps unwinding (a bare
``raise`` is a RERAISE too, ``raise e`` a RAISE of the same object). So
EXCEPTION_HANDLED sets a tentative handler on the record and a later RERAISE or
RAISE sighting of the same object clears it; the handler standing at the end
is the real one. Caught exceptions are folded into groups per (type, origin,
handler) and emitted by ``finish``; the uncaught one keeps its own event.
Library-internal exceptions are dropped: those caught in a library file, and
those raised in one and swallowed outside instrumented code (``hasattr``,
``getattr(x, y, default)``, a stdlib frame: openai and pydantic do this
constantly). One raised in a library and caught in user code is reported.

A debug run hangs its exception pauses on the same sightings: ``Debugger.on_raise`` at the
first one (mode ``raised``), ``Debugger.on_uncaught`` from ``execute.py`` on the exception
that ends the run.
"""

from __future__ import annotations

import sys
import traceback
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from .protocol import COV_ERROR_PATH, COV_ERROR_SOURCE, FLAG_ERROR, FLAG_UNWINDING

TOOL_ID = 3
_IGNORED = (StopIteration, StopAsyncIteration, GeneratorExit, SystemExit, KeyboardInterrupt)
MAX_RECORDS = 500  # pending records; the oldest is folded into its group when exceeded
MAX_HANDLED_EVENTS = 50  # caught-exception groups per run
MAX_STACK = 64
# Without a recording nothing is kept per exception but its identity, so "first sighting" still
# works while a server raises for an hour. The objects are held so an id cannot be reused.
MAX_SEEN = 256


@dataclass
class Handler:
    """The block EXCEPTION_HANDLED landed in: tentative until the run ends without a RERAISE."""

    info: Any  # InstrumentedFile
    function: str  # the handling frame's `co_name`
    line: int  # the block's first located line: a try's first except clause, a with, a finally body
    next_step: int  # index of the first step recorded after the block starts (the matching clause's body)


@dataclass
class ErrorRecord:
    exc: BaseException  # kept alive so `id(exc)` is not reused while the record is pending
    file_id: int
    rid: int
    step: int
    message: str
    type_name: str
    stack: list[dict]
    path: list[int] = field(default_factory=list)
    handler: Handler | None = None
    emitted: bool = False

    def event(self, handled: bool) -> dict:
        return {
            "type": "error",
            "fileId": self.file_id,
            "rid": self.rid,
            "step": self.step,
            "message": self.message,
            "errorType": self.type_name,
            "stack": self.stack,
            "handled": handled,
        }


def _message(exc: BaseException) -> str:
    try:
        return str(exc)
    except BaseException:  # noqa: BLE001
        return "<unprintable %s>" % type(exc).__name__


class ErrorMixin:
    """Mixed into ``Tracer``."""

    def _errors_init(self) -> None:
        self.records: OrderedDict[int, ErrorRecord] = OrderedDict()  # id(exc) -> pending record
        self.seen: OrderedDict[int, BaseException] = OrderedDict()  # id(exc) -> exc, with no recording: first sightings
        self.groups: OrderedDict[tuple, dict] = OrderedDict()  # (type, origin rid, handler rid) -> event
        self.error_states: dict[int, int] = {}  # global rid -> 3/4
        self.monitoring_active = False
        self.snaps_mode = False  # set by execute; the snap guard reports via `report_snap_error`, nothing reads this now
        self.quiet = 0  # set by the tracer while a library module body runs
        self._handler_lines: dict[tuple[int, int], tuple[Any, int | None]] = {}

    # -- monitoring lifecycle ------------------------------------------------
    def _callbacks(self) -> dict[int, Any]:
        events = sys.monitoring.events
        return {events.RAISE: self._on_raise, events.RERAISE: self._on_reraise, events.EXCEPTION_HANDLED: self._on_handled}

    def _tracking_exceptions(self) -> bool:
        """Whether this run wants RAISE / RERAISE / EXCEPTION_HANDLED at all.

        A recording always does: caught exceptions are part of it. A debug run without one only
        needs them to pause, so ``breakOnException: "off"`` pays nothing, which matters for a
        server. The ``exceptions`` action installs and removes the callbacks when it changes that.
        """
        if self.record:
            return True
        dbg = self.dbg
        mode = dbg.break_on_exception if dbg is not None else self.config.break_on_exception
        return mode != "off"

    def _monitoring_start(self) -> None:
        if self.monitoring_active or not self._tracking_exceptions():
            return
        mon = sys.monitoring
        try:
            mon.use_tool_id(TOOL_ID, "pyokka")
        except ValueError:
            # Somebody else holds tool 3 (very unlikely); exception events are lost.
            self.monitoring_active = False
            return
        mask = 0
        for event, callback in self._callbacks().items():
            mon.register_callback(TOOL_ID, event, callback)
            mask |= event
        mon.set_events(TOOL_ID, mask)
        self.monitoring_active = True

    def _monitoring_stop(self) -> None:
        if not self.monitoring_active:
            return
        mon = sys.monitoring
        try:
            mon.set_events(TOOL_ID, 0)
            for event in self._callbacks():
                mon.register_callback(TOOL_ID, event, None)
            mon.free_tool_id(TOOL_ID)
        except Exception:  # noqa: BLE001
            pass
        self.monitoring_active = False

    # -- callbacks ------------------------------------------------------------
    def _on_raise(self, code: Any, offset: int, exc: BaseException) -> None:
        try:
            if self.quiet:
                return  # a library module is importing: pydantic alone raises 30k KeyErrors building its models
            info = self.files.get(code.co_filename)
            if info is None or isinstance(exc, _IGNORED):
                return
            if code.co_name == "__annotate__" and isinstance(exc, NotImplementedError):
                return  # 3.14's annotation protocol: the generated function refuses a format (STRING, asked by pydantic) and annotationlib catches it
            frame = sys._getframe(1)
            if not self.record:
                self._debug_raise(info, exc, frame)
                return
            rid = self.rid_at(info, frame.f_lineno)
            rec = self.records.get(id(exc))
            if rec is None:
                new = self._new_record(info, rid, exc, frame)
                if self.dbg is not None:
                    self.dbg.on_raise(exc, frame, new)  # `breakOnException: "raised"` pauses here, before it unwinds
                return
            step = self.step_for(rid)
            if step != rec.step:
                self._flag_step(step, FLAG_UNWINDING)
            rec.path.append(rid)
            rec.handler = None  # still unwinding: `raise e`, or propagating into a caller
        except Exception as e:  # noqa: BLE001
            self.hook_error(e, "monitoring")

    def _debug_raise(self, info: Any, exc: BaseException, frame: Any) -> None:
        """No recording: the first sighting of an exception may pause, and nothing else happens.

        ``records`` would grow for the life of a server, so the only memory is ``seen``: the ids of
        the last ``MAX_SEEN`` exception objects. The record handed to the debugger is transient.
        """
        dbg = self.dbg
        if dbg is None or dbg.break_on_exception != "raised":
            return
        key = id(exc)
        if key in self.seen:
            return  # RAISE fires in every frame it propagates into; only the first is the origin
        self.seen[key] = exc
        if len(self.seen) > MAX_SEEN:
            self.seen.popitem(last=False)
        rid = self.rid_at(info, frame.f_lineno)
        rec = ErrorRecord(exc, info.file_id, rid, self.step_count(), _message(exc), type(exc).__name__, self._stack(frame))
        dbg.on_raise(exc, frame, rec)

    def _new_record(self, info: Any, rid: int, exc: BaseException, frame: Any) -> ErrorRecord:
        step = self.step_for(rid)
        self._flag_step(step, FLAG_ERROR)
        rec = ErrorRecord(exc, info.file_id, rid, step, _message(exc), type(exc).__name__, self._stack(frame))
        self.records[id(exc)] = rec
        if len(self.records) > MAX_RECORDS:
            _, oldest = self.records.popitem(last=False)
            self._fold(oldest)
        return rec

    def _on_reraise(self, code: Any, offset: int, exc: BaseException) -> None:
        if not self.record:
            return  # there is no record to unsettle and no `handledAt` to report
        rec = self.records.get(id(exc))
        if rec is not None:
            rec.handler = None  # the end of a finally, a with cleanup, a non-matching except block, a bare `raise`

    def _on_handled(self, code: Any, offset: int, exc: BaseException) -> None:
        try:
            if self.quiet or not self.record:
                return
            info = self.files.get(code.co_filename)
            if info is None:
                return  # caught outside instrumented code (the stdlib, C code): reported without a handler
            rec = self.records.get(id(exc))
            if rec is None:
                return
            line = self._handler_line(code, offset)
            if line is None:
                line = sys._getframe(1).f_lineno  # a trailing cleanup block without locations; it re-raises
            rec.handler = Handler(info, code.co_name, line, self.n_steps)
        except Exception as e:  # noqa: BLE001
            self.hook_error(e, "monitoring")

    def _handler_line(self, code: Any, offset: int) -> int | None:
        """The line of the first located instruction of the handler block starting at ``offset``.

        ``PUSH_EXC_INFO`` carries no location and ``f_lineno`` still reports the raising line, so
        the block's line comes from ``co_lines()``: a try's first except clause (whichever clause
        matches), the with statement, the first statement of a finally body.
        """
        key = (id(code), offset)
        cached = self._handler_lines.get(key)
        if cached is not None and cached[0] is code:
            return cached[1]
        line = next((ln for _start, end, ln in code.co_lines() if end > offset and ln is not None), None)
        self._handler_lines[key] = (code, line)
        return line

    # -- helpers ------------------------------------------------------------------
    def _stack(self, frame: Any) -> list[dict]:
        out: list[dict] = []
        f = frame
        while f is not None and len(out) < MAX_STACK:
            info = self.files.get(f.f_code.co_filename)
            entry: dict[str, Any] = {
                "fileId": info.file_id if info else 0,
                "line": f.f_lineno,
                "col": 0,
                "function": f.f_code.co_name,
                "path": f.f_code.co_filename,
            }
            if info is not None:
                entry["rid"] = self.rid_at(info, f.f_lineno)
            out.append(entry)
            if f.f_code is self.stop_code:
                break
            f = f.f_back
        return out

    def _stack_from_traceback(self, exc: BaseException) -> list[dict]:
        out: list[dict] = []
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename not in self.files:
            tb = tb.tb_next  # our own exec() frame and the like
        while tb is not None and len(out) < MAX_STACK:
            code = tb.tb_frame.f_code
            info = self.files.get(code.co_filename)
            entry: dict[str, Any] = {"fileId": info.file_id if info else 0, "line": tb.tb_lineno, "col": 0, "function": code.co_name, "path": code.co_filename}
            if info is not None:
                entry["rid"] = self.rid_at(info, tb.tb_lineno)
            out.append(entry)
            tb = tb.tb_next
        out.reverse()  # innermost first, like the live stack
        return out

    # -- folding caught exceptions --------------------------------------------------
    def _handled_at(self, h: Handler) -> dict:
        """Where the exception was caught: the except clause (rid of its try statement), else the block's line."""
        line, owner_line, broad = h.line, h.line, False
        entry = h.info.except_clauses.get(h.line)
        if entry is not None:
            owner_line, clauses = entry
            line, broad = self._matching_clause(h.info, clauses, h.next_step)
        return {"fileId": h.info.file_id, "line": line, "rid": self.rid_at(h.info, owner_line), "function": h.function, "broad": broad}

    def _matching_clause(self, info: Any, clauses: list[tuple], step: int) -> tuple[int, bool]:
        """The clause whose body the first step after the handled event fell in, else the first.

        EXCEPTION_HANDLED lands on the block's first clause whichever clause matches; what runs
        next is the first statement of the matching clause's body.
        """
        pos = step * 4
        if pos < len(self.steps):
            local = self.steps[pos] - info.range_base
            if 0 <= local < len(info.ranges):
                line = info.ranges[local][0]
                for clause_line, first, last, broad in clauses:
                    if first <= line <= last:
                        return clause_line, broad
        return clauses[0][0], clauses[0][3]

    def _fold(self, rec: ErrorRecord) -> None:
        """Fold a settled record into its group. The uncaught exception is already emitted."""
        if rec.emitted:
            return
        rec.emitted = True
        handler = rec.handler
        # Library-internal noise, never reported: caught by a library handler, or raised in a library
        # and swallowed outside instrumented code (`hasattr`, `getattr(x, y, default)`, a stdlib frame).
        where = handler.info if handler is not None else self.files_by_id.get(rec.file_id)
        if where is not None and where.library:
            return
        at = self._handled_at(handler) if handler is not None else None
        key = (rec.type_name, rec.rid, at["rid"] if at is not None else None)
        group = self.groups.get(key)
        if group is not None:
            group["count"] += 1
            group["lastStep"] = max(group["lastStep"], rec.step)
            return
        if len(self.groups) >= MAX_HANDLED_EVENTS:
            return
        event = rec.event(handled=True)
        if at is not None:
            event["handledAt"] = at
        event["count"] = 1
        event["lastStep"] = rec.step
        self.groups[key] = event

    # -- finalisation ---------------------------------------------------------------
    def report_uncaught(self, exc: BaseException) -> dict | None:
        """Record the exception that ended the run; sets coverage states 3/4."""
        if isinstance(exc, (SystemExit, KeyboardInterrupt, GeneratorExit)):
            return None
        if not self.record:
            return self._report_uncaught_plain(exc)
        rec = self.records.get(id(exc))
        stack = self._stack_from_traceback(exc)
        if rec is None:
            origin = next((s for s in stack if s.get("rid") is not None), None)
            if origin is None:
                return None
            rec = ErrorRecord(exc, origin["fileId"], origin["rid"], self.step_for(origin["rid"]), _message(exc), type(exc).__name__, stack)
            self._flag_step(rec.step, FLAG_ERROR)
            self.records[id(exc)] = rec
        elif len(stack) > len(rec.stack):
            rec.stack = stack
        rec.handler = None
        rec.emitted = True  # never folded into a caught group
        self.error_states[rec.rid] = COV_ERROR_SOURCE
        for frame in stack:
            rid = frame.get("rid")
            if rid is not None and rid != rec.rid and self.error_states.get(rid) != COV_ERROR_SOURCE:
                self.error_states[rid] = COV_ERROR_PATH
        for rid in rec.path:
            if self.error_states.get(rid) != COV_ERROR_SOURCE:
                self.error_states[rid] = COV_ERROR_PATH
        event = rec.event(handled=False)
        event["traceback"] = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-4000:]
        self.emit(event)
        return event

    def _report_uncaught_plain(self, exc: BaseException) -> dict | None:
        """The program's crash with no recording: the ``error`` event from the traceback alone.

        No coverage event is emitted, so the coverage states have no reader and none are written;
        ``step`` is the statement counter, which is what every other event of the run reports.
        """
        stack = self._stack_from_traceback(exc)
        origin = next((s for s in stack if s.get("rid") is not None), None)
        if origin is None:
            return None
        rec = ErrorRecord(exc, origin["fileId"], origin["rid"], self.step_count(), _message(exc), type(exc).__name__, stack)
        event = rec.event(handled=False)
        event["traceback"] = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-4000:]
        self.emit(event)
        return event

    def report_snap_error(self, exc_or_text: Any, rid: int) -> None:
        if isinstance(exc_or_text, BaseException):
            if isinstance(exc_or_text, (SystemExit, KeyboardInterrupt)):
                raise exc_or_text
            self.report_uncaught(exc_or_text)
            return
        self.emit({"type": "error", "fileId": self.file_id_for(rid), "rid": rid, "step": self.cur_step, "message": str(exc_or_text), "errorType": "SyntaxError", "stack": [], "handled": False})
        self.error_states[rid] = COV_ERROR_SOURCE

    def flush_unemitted_errors(self) -> None:
        """Fold the pending records and emit the caught-exception groups, oldest first (``finish``)."""
        if not self.record:
            return  # caught-exception groups are aggregated over a whole run, which is a recording
        for rec in list(self.records.values()):
            self._fold(rec)
        for event in sorted(self.groups.values(), key=lambda e: e["step"]):
            self.emit(event)
        self.groups.clear()
