"""Exception pauses: the ``breakOnException`` half of the debugger, mixed into ``Debugger``.

``config.breakOnException`` (``off`` | ``uncaught`` | ``raised``, changed in flight by the
``exceptions`` action) decides where a debug run stops on an exception. ``on_raise`` is called by
``errors.py`` at the first sighting of an exception in an instrumented file, with the raising frame
live and the exception not yet unwinding; ``on_uncaught`` is called by ``execute.py`` on the one
that ends the run, with the traceback's innermost instrumented frame, whose locals are still
readable although it has returned.

With no recording there are no error records to read: ``on_uncaught`` takes the rid from the
frame's line and the step from the statement counter, and the stack comes from the frame chain
(``dbgframes``), so the pause shows the real raise site and its callers. With ``off`` a
non-recording run installs no ``sys.monitoring`` callbacks at all, which is what a server wants;
switching the mode with the ``exceptions`` action installs or removes them mid-run.
"""

from __future__ import annotations

from typing import Any

from .errors import _message
from .protocol import EXCEPTION_MODES


class ExceptionPauseMixin:
    """Mixed into ``Debugger``; reads ``tracer``, ``serving``, ``break_on_exception`` and ``_pause``."""

    def set_exception_mode(self, mode: str) -> dict | None:
        """The ``exceptions`` action. ``None`` for an unknown mode, which ``control`` turns into an error."""
        if mode not in EXCEPTION_MODES:
            return None
        was = self.break_on_exception
        self.break_on_exception = mode
        t = self.tracer
        if not t.record and mode != was:
            # A non-recording run only tracks exceptions while a mode asks for it.
            if mode == "off":
                t._monitoring_stop()
            elif was == "off":
                t._monitoring_start()
        return {"ok": True, "mode": mode}

    def on_raise(self, exc: BaseException, frame: Any, rec: Any) -> None:
        """First sighting of an exception in an instrumented file, from ``errors.py``: ``raised`` pauses here.

        The exception has not unwound yet, so ``frame`` is the frame that raised (or made the
        library or C call that did) and its locals are the ones the user is looking at. Whether
        it will be caught is unknown at this point, so ``uncaught`` is false; one that nobody
        catches pauses again at the top of the run.
        """
        if self.break_on_exception != "raised" or self.serving.on:
            return
        info = self.tracer.files_by_id.get(rec.file_id)
        if info is None or info.library:
            return  # a library frame raising is not the user's statement
        self._pause_for_exception(exc, frame, rec.step, rec.rid, False)

    def on_uncaught(self, exc: BaseException) -> None:
        """The exception that ends the run, from ``execute.py``, before ``finish`` reports it.

        The traceback's innermost instrumented frame is handed to the control channel: a frame
        that has returned still answers ``f_locals`` and ``f_globals``, so ``evaluate`` and
        ``locals`` see the values as they were when it raised.
        """
        if self.break_on_exception == "off" or self.serving.on:
            return
        if isinstance(exc, (SystemExit, KeyboardInterrupt, GeneratorExit)):
            return
        t = self.tracer
        frame = None
        line = 0
        # The traceback's line, not the frame's: a frame that has unwound reports the last line it
        # ran, which is the instrumenter's `_pk_x` on the body's last statement, not the raise.
        lines: dict[int, int] = {}
        tb = exc.__traceback__
        while tb is not None:
            lines[id(tb.tb_frame)] = tb.tb_lineno
            if tb.tb_frame.f_code.co_filename in t.files:
                frame, line = tb.tb_frame, tb.tb_lineno
            tb = tb.tb_next
        if frame is None:
            return  # nothing of the user's in the traceback: `report_uncaught` has nowhere to point either
        self.frame_lines = lines
        if not t.record:
            info = t.files.get(frame.f_code.co_filename)
            if info is None:
                return
            self._pause_for_exception(exc, frame, t.step_count(), t.rid_at(info, line), True)
            return
        rec = t.records.get(id(exc))
        if rec is not None:
            rid, step = rec.rid, rec.step
        else:
            origin = next((s for s in t._stack_from_traceback(exc) if s.get("rid") is not None), None)
            if origin is None:
                return
            rid, step = origin["rid"], t.step_for(origin["rid"])
        self._pause_for_exception(exc, frame, step, rid, True)

    def _pause_for_exception(self, exc: BaseException, frame: Any, step: int, rid: int, uncaught: bool) -> None:
        detail = {"type": type(exc).__name__, "message": _message(exc), "uncaught": uncaught}
        self._pause(step, rid, self._scope_of(frame), frame, "exception", {"exception": detail})
