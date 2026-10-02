"""The keeper: keeps a ``serve`` runner alive after ``pyokka run --keep`` so ``eval``/``expand`` can reach the finished child.

Why a daemon: a runner speaks NDJSON on its own stdin/stdout, so whoever holds those pipes
must outlive the ``run`` command. ``run --keep`` starts ``python -m pyokka_runtime _keep
--socket PATH`` in its own session; the keeper spawns the runner, listens on a Unix socket,
and multiplexes any number of short-lived clients onto the one runner:

* a client sends the runner's own request lines (``hello``, ``run``, ``evaluate``, ``expand``,
  ``source``, ``shutdown``); the keeper rewrites ``id`` to ``"c<conn>:<id>"`` so ids never
  collide between clients, and restores it on the reply;
* run events (they carry ``runId`` and no ``id``) go to the connection that sent that ``run``;
* ``shutdown`` (or the runner exiting, or ``--idle`` seconds without a connection) ends the
  keeper: runner shut down, socket file removed.

``run.json`` records ``meta.keep = {"pid", "socket"}``; ``pyokka eval run.json EXPR`` connects
to ``socket`` and sends ``evaluate`` with the recorded ``runId``. ``pyokka release run.json``
sends ``shutdown``. One runner holds one finished run: a second ``run --keep`` starts a new keeper.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

from ..protocol import dumps
from .link import runner_env

DEFAULT_IDLE_S = 4 * 3600.0


def socket_path() -> str:
    """A fresh, short (macOS caps AF_UNIX paths at 104 bytes) socket path for a new keeper."""
    base = os.environ.get("PYOKKA_KEEP_DIR") or tempfile.gettempdir()
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "pyokka-keep-%d-%s.sock" % (os.getpid(), os.urandom(3).hex()))


def spawn(path: str, idle_s: float = DEFAULT_IDLE_S, python: str | None = None) -> int:
    """Start a keeper for ``path`` in its own session; returns its pid once the socket accepts."""
    proc = subprocess.Popen(
        [python or sys.executable, "-m", "pyokka_runtime", "_keep", "--socket", path, "--idle", str(idle_s)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=runner_env(),
        start_new_session=True,
        close_fds=True,
    )
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("keeper exited with %s before listening on %s" % (proc.returncode, path))
        if os.path.exists(path):
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.connect(path)
                probe.close()
                return proc.pid
            except OSError:
                probe.close()
        time.sleep(0.02)
    proc.kill()
    raise RuntimeError("keeper did not start listening on %s" % path)


class Keeper:
    def __init__(self, path: str, idle_s: float) -> None:
        self.path = path
        self.idle_s = idle_s
        self.proc = subprocess.Popen([sys.executable, "-m", "pyokka_runtime", "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=runner_env())
        self.lock = threading.Lock()
        self.pending: dict[str, tuple[socket.socket, Any]] = {}
        self.run_owner: dict[str, socket.socket] = {}
        self.conn_serial = 0
        self.connections = 0
        self.last_activity = time.monotonic()
        self.stopping = threading.Event()

    # -- runner side --------------------------------------------------------------------
    def to_runner(self, msg: dict) -> None:
        assert self.proc.stdin is not None
        with self.lock:
            try:
                self.proc.stdin.write((dumps(msg) + "\n").encode("utf-8"))
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError, ValueError):
                self.stopping.set()

    def from_runner(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            try:
                msg = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            target: socket.socket | None = None
            key = msg.get("id")
            if isinstance(key, str) and key in self.pending:
                conn, orig = self.pending.pop(key)
                msg["id"] = orig
                target = conn
            elif "runId" in msg:
                target = self.run_owner.get(str(msg.get("runId")))
            if target is not None:
                self._write(target, msg)
        self.stopping.set()

    @staticmethod
    def _write(conn: socket.socket, msg: dict) -> None:
        try:
            conn.sendall((dumps(msg) + "\n").encode("utf-8"))
        except OSError:
            pass

    # -- client side -----------------------------------------------------------------------
    def serve_client(self, conn: socket.socket, serial: int) -> None:
        self.connections += 1
        try:
            buf = b""
            while not self.stopping.is_set():
                try:
                    chunk = conn.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        self.on_request(conn, serial, line)
        finally:
            self.connections -= 1
            self.last_activity = time.monotonic()
            try:
                conn.close()
            except OSError:
                pass

    def on_request(self, conn: socket.socket, serial: int, line: bytes) -> None:
        try:
            req = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            self._write(conn, {"type": "runner.error", "message": "invalid JSON request"})
            return
        self.last_activity = time.monotonic()
        kind = req.get("type")
        orig = req.get("id")
        key = "c%d:%s" % (serial, orig)
        self.pending[key] = (conn, orig)
        req["id"] = key
        if kind == "run":
            self.run_owner[str(req.get("runId"))] = conn
        self.to_runner(req)
        if kind == "shutdown":
            self.stopping.set()

    # -- lifecycle --------------------------------------------------------------------------------
    def run(self) -> int:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        listener.bind(self.path)
        os.chmod(self.path, 0o600)
        listener.listen(8)
        listener.settimeout(0.5)
        threading.Thread(target=self.from_runner, name="pyokka-keep-runner", daemon=True).start()
        try:
            while not self.stopping.is_set():
                try:
                    conn, _ = listener.accept()
                except socket.timeout:
                    if self.proc.poll() is not None:
                        break
                    if self.connections == 0 and time.monotonic() - self.last_activity > self.idle_s:
                        break
                    continue
                except OSError:
                    break
                self.conn_serial += 1
                threading.Thread(target=self.serve_client, args=(conn, self.conn_serial), name="pyokka-keep-client", daemon=True).start()
        finally:
            listener.close()
            try:
                os.unlink(self.path)
            except OSError:
                pass
            self.shutdown_runner()
        return 0

    def shutdown_runner(self) -> None:
        if self.proc.poll() is None:
            self.to_runner({"type": "shutdown", "id": "keeper-shutdown"})
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def keep_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pyokka_runtime _keep")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--idle", type=float, default=DEFAULT_IDLE_S)
    args = parser.parse_args(argv)
    return Keeper(args.socket, args.idle).run()


__all__ = ["Keeper", "keep_main", "socket_path", "spawn", "DEFAULT_IDLE_S"]
