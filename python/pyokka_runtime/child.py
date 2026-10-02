"""Child-process side of a run: event pipe, signal handling, the control channel.

``child_main`` never returns; it is entered right after ``os.fork`` (POSIX)
or from ``python -m pyokka_runtime _child`` (spawn mode).
"""

from __future__ import annotations

import json
import os
import signal
import socket
import sys
import threading
from typing import Any, Callable

from . import secrets
from .control import ControlChannel
from .protocol import dumps, msg_runner_error


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except InterruptedError:
            continue
        view = view[n:]


class EmitPipe:
    """Child-side event writer: one JSON line per event, safe against the SIGTERM handler.

    ``write`` sends raw bytes: ``os.write`` on the fork pipe, ``socket.sendall`` in spawn
    mode (a socket's ``fileno()`` is not a CRT descriptor on Windows, so ``os.write`` on it
    would fail there).
    """

    def __init__(self, write: Callable[[bytes], None]) -> None:
        self.write = write
        self.lock = threading.Lock()
        self.abort_requested: Callable[[], None] | None = None
        self.closed = False

    def __call__(self, event: dict) -> None:
        if self.closed:
            return
        try:
            data = (dumps(secrets.current.scrub_event(event)) + "\n").encode("utf-8")
        except Exception as exc:  # noqa: BLE001
            data = (dumps(msg_runner_error("event serialisation failed: %s" % exc)) + "\n").encode("utf-8")
        with self.lock:
            try:
                self.write(data)
            except (BrokenPipeError, OSError):
                self.closed = True
        pending = self.abort_requested
        if pending is not None:
            self.abort_requested = None
            pending()


def child_main(request: dict, write: Callable[[bytes], None], ctl_fd: int) -> None:
    """Body of the run child. Never returns."""
    from .execute import Execution, RunSpec, install_step_streams

    emit = EmitPipe(write)
    spec = RunSpec.from_request(request)
    execution = Execution(spec, emit)
    control = ControlChannel(ctl_fd, emit)
    execution.on_tracer = lambda tracer: control.attach_debugger(execution, tracer, request)
    install_step_streams(emit, lambda: execution.tracer)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(0, "r", closefd=False)

    def finish_interrupted() -> None:
        try:
            execution.abort()
            emit({"type": "child.done", "exitCode": None, "interrupted": True, "stepCount": execution.tracer.step_count() if execution.tracer else 0, "logCount": execution.tracer.log_count if execution.tracer else 0})
        finally:
            os._exit(0)

    def on_term(signum: int, frame: Any) -> None:
        if emit.lock.locked():
            emit.abort_requested = finish_interrupted
            return
        finish_interrupted()

    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, on_term)
        except (ValueError, OSError):
            pass
    try:
        result = execution.run()
        control.mark_finished()
        emit({
            "type": "child.done",
            "exitCode": result.exit_code,
            "stepCount": result.step_count,
            "logCount": result.log_count,
            "profile": result.profile,
            "extra": result.extra,
        })
    except BaseException as exc:  # noqa: BLE001
        emit(msg_runner_error("child crashed: %s: %s" % (type(exc).__name__, exc)))
        emit({"type": "child.done", "exitCode": 1, "stepCount": 0, "logCount": 0})
    control.serve_after_run(execution)
    os._exit(0)


def spawned_child_main(port: int, token: str) -> None:
    """Entry point for ``python -m pyokka_runtime _child`` (spawn mode)."""
    raw = sys.stdin.buffer.readline()
    request = json.loads(raw.decode("utf-8"))
    ctl_fd = os.dup(0)
    sock = socket.create_connection(("127.0.0.1", port))
    sock.sendall((token + "\n").encode("utf-8"))
    child_main(request, sock.sendall, ctl_fd)
