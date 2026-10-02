"""The run child's control channel: requests from the runner, served against the run.

Requests arrive as NDJSON lines on the control descriptor and are answered on the event pipe
with the request's ``id`` (``expand.result``, ``evaluate.result``, ``debug.result``, or the
``.error`` twin). Without a debugger they are read once the program has finished, as they
always were: ``expand``, ``evaluate``, ``shadow`` and ``source`` against the finished run,
``exit`` to leave. With a debugger (``config.debug`` or ``breakpoints`` in the run request) a
reader thread feeds a queue from the moment the run starts, so a pause request or a breakpoint
change lands while the program runs; the program thread drains the queue while paused
(``serve_paused``, entered from the tracer hook) and after the run. While the program runs,
``expand`` and ``source`` are served by the reader thread, ``evaluate`` and ``complete`` are
refused (there is no frame to evaluate in), and ``debug`` control actions apply at once.
``complete`` (``complete.py``) lists the names or attributes a watch expression could continue
with, in the paused frame or the finished module.

``exec`` (``dbgexec``) is the one request that writes: it runs a statement in the paused frame and
is served only while one is being served, which is why it is refused while the program runs and
after the run has ended rather than falling back to the module namespace the way ``evaluate``
does. Everything else that reads the frame stays pure (``pure.py``).

``evaluate``, ``complete``, ``exec`` and the ``locals`` action take an optional ``frameId``: the
index into the pause's frame chain (``dbgframes``), ``0`` (the default) being the paused frame
itself. A ``frameId`` the pause does not have is a ``LookupError`` and comes back as the matching
``.error``.
"""

from __future__ import annotations

import json
import os
import queue
import threading
from typing import Any, Callable

STEP_KINDS = ("into", "over", "out")
# Refused while the program runs (no frame to work in), and the reply type each is refused with.
_REFUSED_WHILE_RUNNING = {"evaluate": "evaluate", "shadow": "evaluate", "complete": "complete", "exec": "exec"}


def _fields(req: dict) -> dict:
    return {k: v for k, v in req.items() if k not in ("type", "id", "runId")}


def _frame_for(req: dict, frame: Any, debugger: Any) -> Any:
    """The frame a request addresses: its ``frameId`` into the pause's chain, the paused frame by default."""
    if req.get("frameId") is None or debugger is None:
        return frame
    from .dbgframes import frame_at

    return frame_at(debugger.frames, req.get("frameId"))


def _run_globals(execution: Any) -> dict:
    """The finished run's namespace: the module dict of a file launch, the module's for a ``-m`` one."""
    namespace = getattr(execution, "main_globals", None) if execution is not None else None
    if namespace is None:
        raise LookupError("no run data")
    return namespace


def handle_request(req: dict, execution: Any, emit: Callable[[dict], None], frame: Any, debugger: Any) -> dict | None:
    """Serve one request. Returns the resume action (``{"action", "kind"}``) when it ends a pause."""
    kind = req.get("type")
    rid = req.get("id")
    tracer = debugger.tracer if debugger is not None else (execution.tracer if execution is not None else None)
    try:
        if kind == "expand":
            if tracer is None:
                raise LookupError("no run data")
            node = tracer.expand(req.get("valueId"), req.get("queryPath"), req.get("limits"))
            emit({"type": "expand.result", "id": rid, "node": node})
        elif kind == "source":
            if execution is None:
                raise LookupError("no run data")
            text = execution.instrumented_source(int(req.get("fileId")))
            emit({"type": "source.result", "id": rid, "fileId": int(req.get("fileId")), "instrumentedSource": text})
        elif kind in ("evaluate", "shadow"):
            if tracer is None:
                raise LookupError("no run data")
            if frame is not None:
                if kind != "evaluate":
                    raise ValueError("shadow values need a finished run")
                target = _frame_for(req, frame, debugger)
                result = debugger.evaluate(str(req.get("expression") or ""), target, req.get("limits"))
            else:
                namespace = _run_globals(execution)
                if kind == "evaluate":
                    result = tracer.evaluate(str(req.get("expression") or ""), namespace, req.get("limits"))
                else:
                    result = tracer.shadow(str(req.get("source") or ""), namespace, req.get("limits"))
            emit({"type": "evaluate.result", "id": rid, **result})
        elif kind == "complete":
            from .complete import complete

            if frame is not None:
                target = _frame_for(req, frame, debugger)
                namespaces = (target.f_globals, target.f_locals)
            else:
                namespaces = (_run_globals(execution), None)
            limit = req.get("limit")
            result = complete(str(req.get("expression") or ""), namespaces[0], namespaces[1], int(limit) if limit else 100)
            emit({"type": "complete.result", "id": rid, **result})
        elif kind == "exec":
            from .dbgexec import FrameWriteUnsupported, exec_in_frame

            if frame is None or debugger is None:
                emit({"type": "exec.error", "id": rid, "message": "the run has ended; there is no frame to execute in"})
            else:
                try:
                    reply = exec_in_frame(debugger, str(req.get("source") or ""), _frame_for(req, frame, debugger))
                except FrameWriteUnsupported as exc:
                    emit({"type": "exec.error", "id": rid, "message": str(exc)})
                else:
                    emit({"type": "exec.result", "id": rid, **reply})
        elif kind == "debug":
            return debug_action(req, frame, debugger, emit)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "%s.error" % ("evaluate" if kind == "shadow" else kind), "id": rid, "message": "%s: %s" % (type(exc).__name__, exc)})
    return None


def debug_action(req: dict, frame: Any, debugger: Any, emit: Callable[[dict], None]) -> dict | None:
    rid = req.get("id")
    action = req.get("action")

    def error(message: str) -> None:
        emit({"type": "debug.error", "id": rid, "message": message})

    if debugger is None:
        error("this run has no debugger: start it with config.debug or breakpoints in the run request")
        return None
    if action == "breakpoints":
        emit({"type": "debug.result", "id": rid, **debugger.set_breakpoints(list(req.get("set") or []))})
    elif action == "watches":
        emit({"type": "debug.result", "id": rid, **debugger.set_watches(list(req.get("set") or []))})
    elif action == "exceptions":
        mode = debugger.set_exception_mode(str(req.get("mode") or ""))
        if mode is None:
            error("unknown exception mode %r (off, uncaught, raised)" % req.get("mode"))
        else:
            emit({"type": "debug.result", "id": rid, **mode})
    elif action == "pause":
        if frame is None:
            debugger.request_pause()
        emit({"type": "debug.result", "id": rid, "ok": True, "paused": frame is not None})
    elif action == "locals":
        if frame is None:
            error("the program is running; pause it first")
        else:
            reply = {"type": "debug.result", "id": rid, "locals": debugger.locals(_frame_for(req, frame, debugger))}
            if debugger.modified:
                reply["modified"] = True  # an `exec` has written in this run: these are not only the program's values
            emit(reply)
    elif action == "record":
        if frame is None:
            error("the program is running; pause it first")
        else:
            try:
                emit({"type": "debug.result", "id": rid, **debugger.record_here(frame)})
            except ValueError as exc:
                error(str(exc))
    elif action in ("continue", "step"):
        if frame is None:
            error("the program is running; it resumes only from a pause")
            return None
        kind = str(req.get("kind") or "into")
        if action == "step" and kind not in STEP_KINDS:
            error("unknown step kind %r (into, over, out)" % kind)
            return None
        emit({"type": "debug.result", "id": rid, "ok": True})
        return {"action": action, "kind": kind if action == "step" else None}
    else:
        error("unknown debug action %r" % action)
    return None


class ControlChannel:
    def __init__(self, ctl_fd: int, emit: Callable[[dict], None]) -> None:
        self.fd = ctl_fd
        self.emit = emit
        self.execution: Any = None
        self.debugger: Any = None
        self.queue: queue.Queue | None = None
        self.reader: threading.Thread | None = None
        self.paused = False
        self.finished = False

    # -- setup -------------------------------------------------------------------------------------
    def attach_debugger(self, execution: Any, tracer: Any, request: dict) -> None:
        """Called as soon as the run has a tracer; a debugger only when the run asked for one."""
        if not (tracer.config.debug or request.get("breakpoints")):
            return
        from .debugger import Debugger

        tracer.dbg = Debugger(tracer, self, request)
        self.execution = execution
        self.debugger = tracer.dbg
        self.queue = queue.Queue()
        self.reader = threading.Thread(target=self._read_loop, name="pyokka-control", daemon=True)
        self.reader.start()

    def mark_finished(self) -> None:
        """The program has ended: every request from here on is served by the program thread."""
        self.finished = True

    def begin_pause(self) -> None:
        """The debugger is about to emit ``debug.paused``: queue requests from here, do not serve them.

        Without this the reader thread would refuse a ``continue`` that a host sent the moment it
        saw the stop, because the pause only became visible when ``serve_paused`` was entered.
        """
        self.paused = True

    # -- reading -----------------------------------------------------------------------------------
    def _requests(self):
        try:
            ctl = os.fdopen(self.fd, "r", encoding="utf-8")
        except OSError:
            return
        for line in ctl:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue

    def _read_loop(self) -> None:
        assert self.queue is not None
        for req in self._requests():
            if req.get("type") == "exit" or self.paused or self.finished:
                self.queue.put(req)
                if req.get("type") == "exit":
                    return
            else:
                self._while_running(req)
        self.queue.put({"type": "exit"})  # EOF: the runner is gone

    def _while_running(self, req: dict) -> None:
        kind = req.get("type")
        if kind in _REFUSED_WHILE_RUNNING:
            self.emit({"type": "%s.error" % _REFUSED_WHILE_RUNNING[kind], "id": req.get("id"), "message": "the program is running; pause it first"})
        else:
            handle_request(req, self.execution, self.emit, None, self.debugger)

    # -- serving -----------------------------------------------------------------------------------
    def serve_paused(self, debugger: Any, frame: Any) -> dict:
        """Block the program thread on the paused frame until a request resumes it."""
        assert self.queue is not None
        self.paused = True
        try:
            while True:
                try:
                    req = self.queue.get(timeout=0.5)
                except queue.Empty:
                    continue
                if req.get("type") == "exit":
                    self.queue.put(req)  # the after-run loop needs it too
                    return {"action": "continue", "kind": None}
                action = handle_request(req, self.execution, self.emit, frame, debugger)
                if action is not None:
                    return action
        finally:
            self.paused = False

    def serve_after_run(self, execution: Any) -> None:
        if self.queue is None:
            for req in self._requests():
                if req.get("type") == "exit":
                    break
                handle_request(req, execution, self.emit, None, None)
            return
        while True:
            req = self.queue.get()
            if req.get("type") == "exit":
                break
            handle_request(req, execution, self.emit, None, self.debugger)
