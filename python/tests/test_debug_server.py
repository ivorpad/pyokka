"""A server under the debugger: a breakpoint in a request handler, two request threads, no timeout.

These run against a real runner (the ``client`` fixture, fork and spawn), because a server only
pauses while something else drives it: the test sends the HTTP requests from threads of its own and
reads the runner's events with a deadline on every wait. The fixture program runs
``ThreadingHTTPServer`` on the main thread, so the only Python frames that can pause are the
handlers' and ``debug pause`` really does land at the next statement rather than in a polling loop.

Nothing here uses ``client.recv``: one reader thread owns the runner's stdout so no wait can block
the suite. The runner is shut down by the fixture whatever the test does, which kills the server.
"""

from __future__ import annotations

import json
import queue
import re
import threading
import time
import urllib.request
from pathlib import Path

from tests.test_runner import Client, client  # noqa: F401 - the fixture

WAIT = 25.0  # generous: a spawned child plus an interpreter start on a loaded machine

SERVER = '''import http.server

HITS = []


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        seen = len(HITS)
        HITS.append(self.path)
        body = ("hit %d %s" % (seen, self.path)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print("port", server.server_address[1], flush=True)
server.serve_forever()
'''

HANDLER_LINE = SERVER.splitlines().index("        seen = len(HITS)") + 1  # do_GET's first statement
DEF_LINE = SERVER.splitlines().index("    def do_GET(self):") + 1


class Events:
    """The runner's event stream, read on a thread so every wait has a deadline."""

    def __init__(self, client: Client) -> None:
        self.client = client
        self.queue: queue.Queue = queue.Queue()
        self.seen: list[dict] = []
        self.output = ""
        threading.Thread(target=self._read, name="bench-events", daemon=True).start()

    def _read(self) -> None:
        for line in self.client.p.stdout:
            line = line.strip()
            if line:
                try:
                    self.queue.put(json.loads(line))
                except ValueError:
                    pass
        self.queue.put(None)

    def _next(self, timeout: float) -> dict:
        event = self.queue.get(timeout=timeout)
        if event is None:
            raise AssertionError("the runner closed its output; saw %s" % self._tail())
        self.seen.append(event)
        if event.get("type") == "output":
            self.output += event.get("text") or ""
        return event

    def _tail(self) -> list[str]:
        return [str(e.get("type")) for e in self.seen[-25:]]

    def until(self, kind: str, *, timeout: float = WAIT, forbid: tuple[str, ...] = ()) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError("no %s within %.0fs; saw %s" % (kind, timeout, self._tail()))
            try:
                event = self._next(left)
            except queue.Empty:
                continue
            if event.get("type") == kind:
                return event
            assert event.get("type") not in forbid, "unexpected %r while waiting for %s" % (event, kind)

    def port(self) -> int:
        """The port the program printed, from the ``output`` events."""
        deadline = time.monotonic() + WAIT
        while True:
            match = re.search(r"port (\d+)", self.output)
            if match is not None:
                return int(match.group(1))
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError("the program never printed its port; output was %r" % self.output)
            try:
                self._next(left)
            except queue.Empty:
                continue

    def quiet_for(self, seconds: float) -> list[dict]:
        """Every event that arrives in the next ``seconds``."""
        deadline = time.monotonic() + seconds
        out = []
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return out
            try:
                out.append(self._next(left))
            except queue.Empty:
                return out


class Getter:
    """One GET on a thread of its own, so the test can go on while the handler is paused."""

    def __init__(self, port: int, path: str) -> None:
        self.path = path
        self.body: str | None = None
        self.error: BaseException | None = None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._run, args=("http://127.0.0.1:%d%s" % (port, path),), daemon=True)
        self.thread.start()

    def _run(self, url: str) -> None:
        try:
            with urllib.request.urlopen(url, timeout=WAIT) as response:
                self.body = response.read().decode("utf-8")
        except BaseException as exc:  # noqa: BLE001 - reported by the assertion that waits for it
            self.error = exc
        finally:
            self.done.set()

    def answered(self, timeout: float = WAIT) -> str:
        assert self.done.wait(timeout), "GET %s was never answered" % self.path
        assert self.error is None, "GET %s failed: %r" % (self.path, self.error)
        return self.body or ""

    def pending(self) -> bool:
        return not self.done.is_set()


def start(client: Client, tmp_path: Path, *, breakpoints=(), timeout_ms: int = 0) -> Events:
    """Start the server program under the debugger and wait for its first ``output``."""
    program = tmp_path / "server_target.py"
    program.write_text(SERVER, encoding="utf-8")
    events = Events(client)
    client.send(type="hello", version="test")
    ready = events.until("ready")
    assert "record" in ready["capabilities"], "this runtime cannot run a debug session without a recording"
    client.send(
        type="run",
        runId="s1",
        file={"path": str(program), "displayName": program.name},
        workspaceRoot=str(tmp_path),
        cwd=str(tmp_path),
        argv=[],
        env={},
        projectFiles=[],
        config={"debug": True, "record": False, "stopOnEntry": False, "timeoutMs": timeout_ms},
        markers=[],
        expressionsToEvaluate={},
        watch=[],
        mode="normal",
        breakpoints=[{"path": str(program), "line": line} for line in breakpoints],
    )
    events.until("run.started", forbid=("run.finished",))
    return events


def stop(client: Client, events: Events) -> dict:
    client.send(type="stop", runId="s1")
    return events.until("run.finished")


def test_breakpoint_in_a_handler_pauses_when_a_request_arrives(client, tmp_path):
    events = start(client, tmp_path, breakpoints=[HANDLER_LINE])
    port = events.port()
    assert events.quiet_for(0.4) == [], "the server runs at full speed until a request arrives"
    get = Getter(port, "/one")
    paused = events.until("debug.paused", forbid=("run.finished",))
    assert (paused["reason"], paused["line"]) == ("breakpoint", HANDLER_LINE)
    assert paused["breakpoint"]["resolvedLine"] == HANDLER_LINE and paused["stack"][0]["name"] == "do_GET"
    assert paused["thread"]["name"] != "MainThread" and paused["thread"]["ident"] > 0
    assert get.pending(), "the request is still in flight while its handler is paused"
    client.send(type="debug", runId="s1", action="locals")
    assert [v["name"] for v in events.until("debug.result")["locals"]] == ["self"], "paused before the first statement ran"
    client.send(type="evaluate", runId="s1", expression="self.path")
    assert events.until("evaluated")["text"] == "'/one'"
    client.send(type="evaluate", runId="s1", expression="len(HITS)", frameId=0)
    assert events.until("evaluated")["text"] == "0"
    client.send(type="debug", runId="s1", action="continue")
    events.until("debug.resumed")
    assert get.answered() == "hit 0 /one"
    assert stop(client, events)["stopped"] is True


def test_two_request_threads_queue_and_nothing_is_corrupted(client, tmp_path):
    events = start(client, tmp_path, breakpoints=[HANDLER_LINE])
    port = events.port()
    first = Getter(port, "/a")
    one = events.until("debug.paused", forbid=("run.finished",))
    second = Getter(port, "/b")
    # the second handler blocks before emitting anything: one stop at a time
    assert [e for e in events.quiet_for(0.6) if e.get("type") == "debug.paused"] == []
    client.send(type="debug", runId="s1", action="continue")
    events.until("debug.resumed")
    two = events.until("debug.paused", forbid=("run.finished",))
    assert first.answered() == "hit 0 /a"
    assert second.pending(), "the second handler is paused, so its request is not answered yet"
    client.send(type="debug", runId="s1", action="continue")
    events.until("debug.resumed")
    assert second.answered() == "hit 1 /b"
    assert one["thread"]["ident"] != two["thread"]["ident"], "two different handler threads"
    assert one["reason"] == two["reason"] == "breakpoint" and one["seq"] < two["seq"]
    kinds = [e["type"] for e in events.seen if e["type"] in ("debug.paused", "debug.resumed")]
    assert kinds == ["debug.paused", "debug.resumed", "debug.paused", "debug.resumed"], "strictly sequential"
    assert stop(client, events)["stopped"] is True


def test_continue_does_not_wait_for_the_next_request(client, tmp_path):
    events = start(client, tmp_path, breakpoints=[HANDLER_LINE])
    port = events.port()
    first = Getter(port, "/first")
    events.until("debug.paused", forbid=("run.finished",))
    started = time.monotonic()
    client.send(type="debug", runId="s1", action="continue")
    events.until("debug.result")
    events.until("debug.resumed")
    assert first.answered() == "hit 0 /first"
    assert time.monotonic() - started < WAIT, "continue returned without waiting for another request"
    second = Getter(port, "/second")
    again = events.until("debug.paused", forbid=("run.finished",))
    assert again["line"] == HANDLER_LINE and second.pending()
    client.send(type="debug", runId="s1", action="continue")
    events.until("debug.resumed")
    assert second.answered() == "hit 1 /second"
    assert stop(client, events)["stopped"] is True


def test_pause_while_blocked_in_accept_lands_at_the_next_statement(client, tmp_path):
    events = start(client, tmp_path)
    port = events.port()
    client.send(type="debug", runId="s1", action="pause")
    reply = events.until("debug.result")
    assert (reply["ok"], reply["paused"]) == (True, False), "nothing to pause: the only thread is inside accept()"
    assert [e for e in events.quiet_for(0.6) if e.get("type") == "debug.paused"] == [], "no statement ran, so nothing paused"
    get = Getter(port, "/wake")
    paused = events.until("debug.paused", forbid=("run.finished",))
    assert paused["reason"] == "pause" and paused["thread"]["name"] != "MainThread"
    assert (paused["stack"][0]["name"], paused["line"]) == ("do_GET", DEF_LINE), "the pause landed where the handler was entered"
    client.send(type="debug", runId="s1", action="continue")
    events.until("debug.resumed")
    assert get.answered() == "hit 0 /wake"
    assert stop(client, events)["stopped"] is True


def test_the_server_run_is_off_the_timeout_clock(client, tmp_path):
    events = start(client, tmp_path, breakpoints=[HANDLER_LINE], timeout_ms=800)
    port = events.port()
    idle = events.quiet_for(2.0)
    assert [e for e in idle if e.get("type") == "run.finished"] == [], "a debug run is never on the timeout clock"
    get = Getter(port, "/late")
    events.until("debug.paused", forbid=("run.finished",))
    client.send(type="debug", runId="s1", action="continue")
    events.until("debug.resumed")
    assert get.answered() == "hit 0 /late", "the run was still alive two seconds past its timeout"
    finished = stop(client, events)
    assert finished["stopped"] is True and finished["timedOut"] is False
