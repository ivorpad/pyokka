"""The long-lived runner: NDJSON requests on stdin, replies and run events on stdout.

Each ``run`` executes in a child process (``os.fork`` on Linux for warm
starts; a ``subprocess`` spawn on macOS and Windows, or anywhere with
``PYOKKA_SPAWN=1``; ``PYOKKA_FORK=1`` forks on macOS too, see ``forksafety.py``). The
child's fds 1/2 are pipes the runner forwards as ``output`` events; run
events travel over a dedicated pipe (or a localhost socket in spawn mode)
and get ``runId``/``seq`` here. A finished child stays alive to answer
``expand`` requests from its value registry until the next run.
"""

from __future__ import annotations

import codecs
import json
import os
import platform
import signal
import socket
import subprocess
import sys
import threading
import time
import warnings
from typing import Any, BinaryIO, Callable

from . import __version__
from .child import _write_all
from .forksafety import signal_death, use_fork
from .protocol import dumps, ev_output, ev_run_finished, msg_error, msg_ok, msg_ready, msg_runner_error

USE_FORK = use_fork(os.environ, sys.platform)  # fork on Linux, a fresh interpreter on macOS and Windows; PYOKKA_SPAWN / PYOKKA_FORK override (forksafety.py)
KILL_GRACE_S = 2.0
# What a child's typed reply is called on the way out to the host.
_REPLY_TYPE = {"evaluate.result": "evaluated", "complete.result": "completed", "exec.result": "executed"}
CAPABILITIES = ["monitoring", "expand", "evaluate", "shadow", "source", "bindings", "libraryCode", "watch", "recordLocals", "profile", "snaps", "plugins", "partialTrace", "logpoints", "markers", "debug", "complete", "record", "module", "exec", "recordFrom"]


class Writer:
    def __init__(self, out: BinaryIO) -> None:
        self.out = out
        self.lock = threading.Lock()

    def send(self, msg: dict) -> None:
        data = (dumps(msg) + "\n").encode("utf-8")
        with self.lock:
            try:
                self.out.write(data)
                self.out.flush()
            except (BrokenPipeError, ValueError, OSError):
                pass


class Child:
    def __init__(self, run_id: str, request: dict, writer: Writer) -> None:
        self.run_id = run_id
        self.request = request
        self.writer = writer
        self.seq = 0
        self.seq_lock = threading.Lock()
        self.pid: int | None = None
        self.proc: subprocess.Popen | None = None
        self.ctl_fd: int | None = None
        self.sock: socket.socket | None = None
        self.started = time.perf_counter()
        self.done = threading.Event()  # child.done received or child gone
        self.finished_sent = False
        self.timed_out = False
        self.stopped = False
        self.exit_code: int | None = None
        self.result: dict | None = None
        self.pending: dict[str, Any] = {}
        self.threads: list[threading.Thread] = []
        self.lock = threading.Lock()
        self.timer: threading.Timer | None = None
        self.deadline: float | None = None  # perf_counter time of the timeout; instrumentation time pushes it back
        self.alive = True
        self.paused = False  # a debug run stopped at its frontier (debug.paused .. debug.resumed)
        self.remaining: float | None = None  # timeout budget left when the run paused
        self.rearm: Callable[[], None] | None = None  # re-arms the timeout after a pause (set by the runner)

    # -- event forwarding --------------------------------------------------------------
    def send_event(self, event: dict) -> None:
        with self.seq_lock:
            self.seq += 1
            event["runId"] = self.run_id
            event["seq"] = self.seq
        self.writer.send(event)

    def on_child_line(self, line: str, complete: bool = True) -> None:
        try:
            event = json.loads(line)
        except ValueError:
            # A killed child (timeout, stop) leaves the line it was writing truncated: not an error.
            if complete:
                self.send_event(msg_runner_error("bad event line from child", line[:200]))
            return
        kind = event.get("type")
        if kind == "child.done":
            self.result = event
            self.exit_code = event.get("exitCode")
            self._send_finished()
            return
        if kind in ("expand.result", "expand.error", "evaluate.result", "evaluate.error", "complete.result", "complete.error", "exec.result", "exec.error", "source.result", "source.error", "debug.result", "debug.error"):
            host_id = self.pending.pop(str(event.get("id")), None)
            if host_id is None:
                return
            if kind == "expand.result":
                self.writer.send({"type": "value", "id": host_id, "node": event.get("node")})
            elif kind in ("evaluate.result", "complete.result", "exec.result"):
                reply = {k: v for k, v in event.items() if k not in ("type", "id")}
                self.writer.send({"type": _REPLY_TYPE[kind], "id": host_id, **reply})
            elif kind == "source.result":
                self.writer.send({"type": "source", "id": host_id, "fileId": event.get("fileId"), "instrumentedSource": event.get("instrumentedSource")})
            elif kind == "debug.result":
                self.writer.send({"type": "debug.result", "id": host_id, **{k: v for k, v in event.items() if k not in ("type", "id")}})
            else:
                self.writer.send(msg_error(host_id, event.get("message", "request failed")))
            return
        if kind == "debug.paused":
            self._hold_timeout()
        elif kind == "debug.resumed":
            self._release_timeout()
        if kind == "file.instrumented" and self.deadline is not None:
            # instrumenting (or loading from the cache) is our time, not the program's
            self.deadline += float(event.get("instrumentMs") or 0) / 1000.0
        self.send_event(event)

    def on_output(self, stream: str, text: str) -> None:
        if text:
            self.send_event(ev_output(stream, text))

    def _hold_timeout(self) -> None:
        """A paused run is not running: stop the clock until it resumes."""
        self.paused = True
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None
        if self.deadline is not None:
            self.remaining = max(0.0, self.deadline - time.perf_counter())

    def _release_timeout(self) -> None:
        self.paused = False
        if self.remaining is not None and self.rearm is not None:
            self.deadline = time.perf_counter() + self.remaining
            self.remaining = None
            self.rearm()

    def _send_finished(self) -> None:
        with self.lock:
            if self.finished_sent:
                return
            self.finished_sent = True
        if self.timer is not None:
            self.timer.cancel()
        res = self.result or {}
        self.send_event(
            ev_run_finished(
                exit_code=self.exit_code if not (self.timed_out or self.stopped) else None,
                duration_ms=(time.perf_counter() - self.started) * 1000.0,
                timed_out=self.timed_out,
                stopped=self.stopped,
                step_count=int(res.get("stepCount") or 0),
                log_count=int(res.get("logCount") or 0),
                profile=res.get("profile"),
                extra=res.get("extra"),
            )
        )
        self.done.set()

    # -- lifecycle ----------------------------------------------------------------------
    def write_control(self, msg: dict) -> bool:
        if self.ctl_fd is None or not self.alive:
            return False
        try:
            _write_all(self.ctl_fd, (dumps(msg) + "\n").encode("utf-8"))
            return True
        except OSError:
            return False

    def request_expand(self, host_id: Any, req: dict) -> bool:
        key = "e-%s" % host_id
        self.pending[key] = host_id
        ok = self.write_control({"type": "expand", "id": key, "valueId": req.get("valueId"), "queryPath": req.get("queryPath"), "limits": req.get("limits")})
        if not ok:
            self.pending.pop(key, None)
        return ok

    def request_evaluate(self, host_id: Any, req: dict) -> bool:
        key = "v-%s" % host_id
        self.pending[key] = host_id
        ok = self.write_control({"type": req.get("type"), "id": key, "expression": req.get("expression"), "source": req.get("source"), "limits": req.get("limits"), "limit": req.get("limit"), "frameId": req.get("frameId")})
        if not ok:
            self.pending.pop(key, None)
        return ok

    def request_debug(self, host_id: Any, req: dict) -> bool:
        key = "d-%s" % host_id
        self.pending[key] = host_id
        ok = self.write_control({**{k: v for k, v in req.items() if k != "runId"}, "id": key})
        if not ok:
            self.pending.pop(key, None)
        return ok

    def request_source(self, host_id: Any, req: dict) -> bool:
        key = "s-%s" % host_id
        self.pending[key] = host_id
        ok = self.write_control({"type": "source", "id": key, "fileId": req.get("fileId")})
        if not ok:
            self.pending.pop(key, None)
        return ok

    def terminate(self, *, timed_out: bool = False, stopped: bool = False) -> None:
        """Ask the child to flush and exit; escalate to SIGKILL after a grace period."""
        if timed_out:
            self.timed_out = True
        if stopped:
            self.stopped = True
        if not self.alive:
            return
        if self.finished_sent:
            self.write_control({"type": "exit"})
        else:
            self._signal(signal.SIGTERM)
        if not self.done.wait(KILL_GRACE_S):
            self._signal(getattr(signal, "SIGKILL", signal.SIGTERM))
            self.done.wait(KILL_GRACE_S)
        self._reap()

    def _signal(self, sig: int) -> None:
        try:
            if self.proc is not None:
                if sig == signal.SIGTERM:
                    self.proc.terminate()
                else:
                    self.proc.kill()
            elif self.pid is not None:
                os.kill(self.pid, sig)
        except (ProcessLookupError, OSError):
            pass

    def _reap(self) -> None:
        if not self.alive:
            return
        self.alive = False
        try:
            if self.proc is not None:
                self.proc.wait(timeout=KILL_GRACE_S)
                self.exit_code = self.proc.returncode if self.exit_code is None else self.exit_code
            elif self.pid is not None:
                _, status = os.waitpid(self.pid, 0)
                if self.exit_code is None:
                    self.exit_code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
        except (ChildProcessError, subprocess.TimeoutExpired, OSError):
            pass
        if self.proc is not None:
            # spawn mode: the control channel is the child's stdin *object*; closing its descriptor
            # by number would leave the object to close it again at finalisation, by which time the
            # number may belong to the next child's pipe (its control channel then hit EOF and it exited)
            try:
                if self.proc.stdin is not None:
                    self.proc.stdin.close()
            except OSError:
                pass
        elif self.ctl_fd is not None:
            try:
                os.close(self.ctl_fd)
            except OSError:
                pass
        self.ctl_fd = None
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass

    def on_streams_closed(self) -> None:
        """All reader threads hit EOF: the child is gone."""
        self._reap()
        if self.result is None and self.exit_code is not None and self.exit_code < 0 and not (self.timed_out or self.stopped):
            # died from a signal without a `child.done`: say which, and never re-run (the program may have had side effects)
            self.send_event(msg_runner_error(*signal_death(self.exit_code, use_fork=USE_FORK)))
        self._send_finished()


def _reader_thread(name: str, read: Callable[[], bytes], on_line: Callable[..., None] | None, on_chunk: Callable[[str], None] | None) -> threading.Thread:
    """Reads until EOF; ``on_line`` gets complete lines, and the unterminated tail as ``on_line(tail, False)``."""

    def run() -> None:
        buf = b""
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            try:
                chunk = read()
            except (OSError, ValueError):
                chunk = b""
            if not chunk:
                break
            if on_chunk is not None:
                text = decoder.decode(chunk)
                if text:
                    on_chunk(text)
            else:
                buf += chunk
                while True:
                    nl = buf.find(b"\n")
                    if nl < 0:
                        break
                    line = buf[:nl].decode("utf-8", "replace")
                    buf = buf[nl + 1 :]
                    if line.strip() and on_line is not None:
                        on_line(line)
        if on_chunk is not None:
            tail = decoder.decode(b"", final=True)
            if tail:
                on_chunk(tail)
        elif buf.strip() and on_line is not None:
            on_line(buf.decode("utf-8", "replace"), False)

    t = threading.Thread(target=run, name=name, daemon=True)
    t.start()
    return t


def _fd_reader(fd: int) -> Callable[[], bytes]:
    def read() -> bytes:
        try:
            return os.read(fd, 65536)
        finally:
            pass

    return read


class Runner:
    def __init__(self, stdin: BinaryIO | None = None, stdout: BinaryIO | None = None) -> None:
        self.stdin = stdin or sys.stdin.buffer
        self.writer = Writer(stdout or sys.stdout.buffer)
        self.child: Child | None = None
        self.running = True
        self.plugins_done: set[str] = set()

    # -- main loop ------------------------------------------------------------------------
    def serve(self) -> int:
        warnings.filterwarnings("ignore", message=".*multi-threaded.*fork.*", category=DeprecationWarning)
        try:
            while self.running:
                line = self.stdin.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except ValueError as exc:
                    self.writer.send(msg_runner_error("invalid JSON request: %s" % exc))
                    continue
                try:
                    self.dispatch(req)
                except Exception as exc:  # noqa: BLE001
                    self.writer.send(msg_error(req.get("id"), "%s: %s" % (type(exc).__name__, exc)))
        finally:
            self._drop_child(stopped=True)
        return 0

    def dispatch(self, req: dict) -> None:
        kind = req.get("type")
        rid = req.get("id")
        if kind == "hello":
            caps = ["fork" if USE_FORK else "spawn", *CAPABILITIES]
            ready = msg_ready(rid, python_version=platform.python_version(), executable=sys.executable, platform=sys.platform, capabilities=caps)
            ready["runtimeVersion"] = __version__
            self.writer.send(ready)
        elif kind == "run":
            self.handle_run(req)
        elif kind == "expand":
            self.handle_expand(req)
        elif kind in ("evaluate", "shadow", "complete", "exec"):
            self.handle_evaluate(req)
        elif kind == "source":
            self.handle_source(req)
        elif kind == "bindings":
            self.handle_bindings(req)
        elif kind == "debug":
            self.handle_debug(req)
        elif kind == "stop":
            child = self.child
            if child is not None and (req.get("runId") in (None, child.run_id)):
                child.terminate(stopped=True)
            self.writer.send(msg_ok(rid))
        elif kind == "shutdown":
            self.writer.send(msg_ok(rid))
            self.running = False
        else:
            self.writer.send(msg_error(rid, "unknown request type %r" % kind))

    # -- run ----------------------------------------------------------------------------------
    def _drop_child(self, *, stopped: bool) -> None:
        child = self.child
        self.child = None
        if child is not None:
            child.terminate(stopped=stopped and not child.finished_sent)

    def handle_run(self, req: dict) -> None:
        self._drop_child(stopped=True)
        run_id = str(req.get("runId") or "r-%d" % int(time.time() * 1000))
        cfg = req.get("config") or {}
        if USE_FORK:
            self._start_plugins(cfg, req)
        child = Child(run_id, req, self.writer)
        self.child = child
        self.writer.send(msg_ok(req.get("id")))
        try:
            if USE_FORK:
                self._fork_child(child)
            else:
                self._spawn_child(child)
        except Exception as exc:  # noqa: BLE001
            child.send_event(msg_runner_error("could not start run: %s: %s" % (type(exc).__name__, exc)))
            child.alive = False
            child._send_finished()
            return
        child.send_event({"type": "run.started", "pid": child.pid})
        timeout_ms = int(cfg.get("timeoutMs", 30_000) or 0)
        if cfg.get("debug"):
            timeout_ms = 0  # a run with a debugger attached is never on the clock: it may be a paused server
        if timeout_ms > 0:
            child.deadline = time.perf_counter() + timeout_ms / 1000.0
            self._arm_timeout(child)
            child.rearm = lambda: self._arm_timeout(child)

    def _arm_timeout(self, child: Child) -> None:
        delay = max(0.0, (child.deadline or 0.0) - time.perf_counter())
        child.timer = threading.Timer(delay, lambda: self._on_timeout(child))
        child.timer.daemon = True
        child.timer.start()

    def _on_timeout(self, child: Child) -> None:
        if child.finished_sent:
            return
        if child.deadline is not None and time.perf_counter() < child.deadline - 0.001:
            self._arm_timeout(child)  # pushed back by instrumentation time
            return
        child.terminate(timed_out=True)

    def _start_plugins(self, cfg: dict, req: dict) -> None:
        extra = [os.path.dirname(str((req.get("file") or {}).get("path") or "")), str(req.get("workspaceRoot") or "")]
        for name in cfg.get("plugins") or []:
            if name in self.plugins_done:
                continue
            self.plugins_done.add(name)
            try:
                import importlib

                added = [p for p in extra if p and p not in sys.path]
                sys.path[0:0] = added
                try:
                    mod = importlib.import_module(str(name))
                finally:
                    for p in added:
                        sys.path.remove(p)
                fn = getattr(mod, "before", None)
                if callable(fn):
                    fn(cfg)
                from . import execute

                execute._plugins_started.add(str(name))
            except Exception as exc:  # noqa: BLE001
                self.writer.send(msg_runner_error("plugin %s failed to start: %s: %s" % (name, type(exc).__name__, exc)))

    def _watch_streams(self, child: Child, readers: list[threading.Thread]) -> None:
        def waiter() -> None:
            for t in readers:
                t.join()
            child.on_streams_closed()

        threading.Thread(target=waiter, name="pyokka-waiter", daemon=True).start()

    def _fork_child(self, child: Child) -> None:
        ev_r, ev_w = os.pipe()
        ctl_r, ctl_w = os.pipe()
        out_r, out_w = os.pipe()
        err_r, err_w = os.pipe()
        sys.stdout.flush()
        sys.stderr.flush()
        pid = os.fork()
        if pid == 0:  # child
            try:
                for fd in (ev_r, ctl_w, out_r, err_r):
                    os.close(fd)
                os.dup2(out_w, 1)
                os.dup2(err_w, 2)
                os.close(out_w)
                os.close(err_w)
                from .child import child_main

                child_main(child.request, lambda data: _write_all(ev_w, data), ctl_r)
            finally:
                os._exit(1)
        for fd in (ev_w, ctl_r, out_w, err_w):
            os.close(fd)
        child.pid = pid
        child.ctl_fd = ctl_w
        readers = [
            _reader_thread("pyokka-events", _fd_reader(ev_r), child.on_child_line, None),
            _reader_thread("pyokka-stdout", _fd_reader(out_r), None, lambda t: child.on_output("stdout", t)),
            _reader_thread("pyokka-stderr", _fd_reader(err_r), None, lambda t: child.on_output("stderr", t)),
        ]
        child.threads = readers
        self._watch_streams(child, readers)

    def _spawn_child(self, child: Child) -> None:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(20.0)
        port = listener.getsockname()[1]
        token = os.urandom(8).hex()
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen(
            [sys.executable, "-m", "pyokka_runtime", "_child", "--port", str(port), "--token", token],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=os.getcwd(),
        )
        child.proc = proc
        child.pid = proc.pid
        assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
        proc.stdin.write((dumps(child.request) + "\n").encode("utf-8"))
        proc.stdin.flush()
        try:
            conn, _ = listener.accept()
        finally:
            listener.close()
        conn.settimeout(None)
        greeting = b""
        while not greeting.endswith(b"\n"):
            chunk = conn.recv(1)
            if not chunk:
                break
            greeting += chunk
        if greeting.strip().decode("utf-8", "replace") != token:
            conn.close()
            proc.kill()
            raise RuntimeError("child handshake failed")
        child.sock = conn
        child.ctl_fd = proc.stdin.fileno()
        readers = [
            _reader_thread("pyokka-events", lambda: conn.recv(65536), child.on_child_line, None),
            _reader_thread("pyokka-stdout", lambda: proc.stdout.read1(65536), None, lambda t: child.on_output("stdout", t)),  # type: ignore[union-attr]
            _reader_thread("pyokka-stderr", lambda: proc.stderr.read1(65536), None, lambda t: child.on_output("stderr", t)),  # type: ignore[union-attr]
        ]
        child.threads = readers
        self._watch_streams(child, readers)

    # -- expand ------------------------------------------------------------------------------------
    def handle_evaluate(self, req: dict) -> None:
        """`evaluate`, `shadow`, `complete` and `exec`: the finished run's namespace or the paused frame.

        `exec` writes in a frame, so it is served only while the run is paused, never after it.
        """
        child = self.child
        if req.get("type") == "exec" and not (child is not None and child.alive and child.paused and (req.get("runId") in (None, child.run_id))):
            running = child is not None and child.alive and not child.finished_sent
            # the same two sentences the child's control channel uses, so the host reads one wording
            self.writer.send(msg_error(req.get("id"), "the program is running; pause it first" if running else "the run has ended; there is no frame to execute in"))
            return
        if req.get("type") != "exec" and (child is None or not child.alive or not (child.finished_sent or child.paused) or (req.get("runId") not in (None, child.run_id))):
            self.writer.send(msg_error(req.get("id"), "no finished or paused run to %s against" % ("complete" if req.get("type") == "complete" else "evaluate")))
            return
        if not child.request_evaluate(req.get("id"), req):
            self.writer.send(msg_error(req.get("id"), "run child is not accepting requests"))

    def handle_source(self, req: dict) -> None:
        child = self.child
        if child is None or not child.alive or not child.finished_sent or (req.get("runId") not in (None, child.run_id)):
            self.writer.send(msg_error(req.get("id"), "no finished run to take the source from"))
            return
        if not child.request_source(req.get("id"), req):
            self.writer.send(msg_error(req.get("id"), "run child is not accepting requests"))

    def handle_bindings(self, req: dict) -> None:
        """What each statement of ``source`` assigns and reads: stateless, no child involved, any time."""
        from .bindings import statement_bindings

        source = req.get("source")
        if not isinstance(source, str):
            self.writer.send(msg_error(req.get("id"), "bindings needs source"))
            return
        try:
            statements = statement_bindings(source)
        except SyntaxError as exc:
            self.writer.send(msg_error(req.get("id"), "SyntaxError: %s" % exc))
            return
        self.writer.send({"type": "bindings", "id": req.get("id"), "statements": statements})

    def handle_debug(self, req: dict) -> None:
        """Forward a debug control action (breakpoints, watches, pause, locals, continue, step) to the run in progress."""
        child = self.child
        if child is None or not child.alive or child.finished_sent or (req.get("runId") not in (None, child.run_id)):
            self.writer.send(msg_error(req.get("id"), "no run in progress to debug"))
            return
        if not child.request_debug(req.get("id"), req):
            self.writer.send(msg_error(req.get("id"), "run child is not accepting requests"))

    def handle_expand(self, req: dict) -> None:
        child = self.child
        if child is None or not child.alive or (req.get("runId") not in (None, child.run_id)):
            self.writer.send(msg_error(req.get("id"), "no live run to expand from"))
            return
        if not child.request_expand(req.get("id"), req):
            self.writer.send(msg_error(req.get("id"), "run child is not accepting requests"))
