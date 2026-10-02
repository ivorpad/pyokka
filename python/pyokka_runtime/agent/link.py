"""NDJSON client side of a ``serve`` runner, or of the extension's bridge socket.

``PipeLink`` owns a runner subprocess (``python -m pyokka_runtime serve``); ``SocketLink``
talks to one kept alive by the keeper (``keep.py``) over its Unix socket, or to the bridge
of a live VS Code session (``live.py``). Both expose the
same three calls: ``send``, ``recv`` and ``call`` (send, then read until the reply that
carries the request id, handing every other message to ``on_event``).
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from typing import Any, Callable, IO

from ..protocol import dumps

RUNTIME_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_ROOT = os.path.dirname(RUNTIME_PARENT)


class LinkClosed(RuntimeError):
    pass


def runner_env() -> dict[str, str]:
    """The subprocess must import ``pyokka_runtime`` whatever the caller's cwd is."""
    env = dict(os.environ)
    env["PYTHONPATH"] = RUNTIME_ROOT + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


class _LineLink:
    def __init__(self, reader: IO[bytes], writer: IO[bytes]) -> None:
        self.reader = reader
        self.writer = writer
        self.next_id = 0

    def send(self, msg: dict) -> Any:
        if "id" not in msg:
            self.next_id += 1
            msg["id"] = self.next_id
        self.send_raw(msg)
        return msg["id"]

    def send_raw(self, msg: dict) -> None:
        """One line, as given: the bridge's token line carries no id."""
        try:
            self.writer.write((dumps(msg) + "\n").encode("utf-8"))
            self.writer.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            raise LinkClosed("runner is gone: %s" % exc) from exc

    def recv(self) -> dict:
        while True:
            try:
                line = self.reader.readline()
            except (OSError, ValueError) as exc:
                raise LinkClosed("runner is gone: %s" % exc) from exc
            if not line:
                raise LinkClosed("runner closed the connection")
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue

    def call(self, msg: dict, on_event: Callable[[dict], None] | None = None) -> dict:
        rid = self.send(msg)
        while True:
            reply = self.recv()
            if reply.get("id") == rid:
                return reply
            if on_event is not None:
                on_event(reply)

    def close(self) -> None:
        for f in (self.writer, self.reader):
            try:
                f.close()
            except OSError:
                pass


class PipeLink(_LineLink):
    """A runner subprocess of the current interpreter, shut down on ``close``."""

    def __init__(self, python: str | None = None, cwd: str | None = None) -> None:
        self.proc = subprocess.Popen(
            [python or sys.executable, "-m", "pyokka_runtime", "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=runner_env(),
            cwd=cwd,
        )
        assert self.proc.stdin is not None and self.proc.stdout is not None
        super().__init__(self.proc.stdout, self.proc.stdin)

    def close(self) -> None:
        try:
            self.send({"type": "shutdown"})
        except LinkClosed:
            pass
        super().close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


class SocketLink(_LineLink):
    """A connection to a Unix socket: the keeper's (``keep.py``) or the bridge's (``live.py``)."""

    def __init__(self, path: str, timeout: float | None = None) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        try:
            self.sock.connect(path)
        except OSError as exc:
            self.sock.close()
            raise LinkClosed("cannot reach %s: %s" % (path, exc)) from exc
        self.sock.settimeout(None)
        super().__init__(self.sock.makefile("rb"), self.sock.makefile("wb"))

    def close(self) -> None:
        super().close()
        try:
            self.sock.close()
        except OSError:
            pass


__all__ = ["LinkClosed", "PipeLink", "SocketLink", "runner_env"]
