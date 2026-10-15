"""MCP ``pyokka_debug status`` with ``wait_seconds``: it returns the pause another call made while it waited, and times out cleanly."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from pyokka_runtime.agent.mcp import call_tool
from test_agent_live import FakeBridge, paused_at, write_descriptor, sessions  # noqa: F401 - the fixture


class WatchingBridge(FakeBridge):
    """A bridge whose ``watch`` stays open, as VS Code's does, and streams a ``paused`` event when ``pause`` arrives."""

    def __init__(self) -> None:
        self.watchers: list = []
        super().__init__()
        self.debug = {"active": True, "paused": None, "frontier": None}  # a debug run, running

    def _client(self, conn) -> None:
        reader = conn.makefile("rb")
        writer = conn.makefile("wb")
        try:
            if json.loads(reader.readline()).get("token") != self.token:
                return
            for raw in reader:
                if not raw.strip():
                    continue
                req = json.loads(raw)
                self.requests.append(req)
                reply = self.reply(req)
                writer.write((json.dumps({"id": req.get("id"), **reply}) + "\n").encode())
                writer.flush()
                if req.get("type") == "watch":
                    self.watchers.append(writer)
                if req.get("type") == "pause":
                    for w in list(self.watchers):
                        try:
                            w.write((json.dumps({"event": "paused", **paused_at(7, "pause")}) + "\n").encode())
                            w.flush()
                        except OSError:
                            pass
        except (OSError, ValueError):
            pass
        finally:
            conn.close()


@pytest.fixture
def watching(sessions: Path):
    b = WatchingBridge()
    write_descriptor(sessions, "1", b.descriptor())
    try:
        yield b
    finally:
        b.close()


def text_of(result: dict) -> str:
    return result["content"][0]["text"]


def test_status_returns_the_pause_a_second_call_made(watching: WatchingBridge):
    out: dict = {}
    waiter = threading.Thread(target=lambda: out.update(call_tool("pyokka_debug", {"action": "status", "wait_seconds": 10})))
    started = time.monotonic()
    waiter.start()
    deadline = time.monotonic() + 5
    while not watching.watchers and time.monotonic() < deadline:
        time.sleep(0.02)
    assert watching.watchers, "status subscribed before it waited"
    paused = call_tool("pyokka_debug", {"action": "pause"})
    assert not paused["isError"], text_of(paused)
    waiter.join(10)
    assert time.monotonic() - started < 8, "the pause ended the wait, not the 10 s"
    assert not out["isError"], text_of(out)
    lines = text_of(out).splitlines()
    assert lines[0].startswith("paused after waiting ")
    assert lines[-1] == "debug: paused at demo.py:11 (pause)"


def test_status_times_out_with_the_running_state(watching: WatchingBridge):
    started = time.monotonic()
    result = call_tool("pyokka_debug", {"action": "status", "wait_seconds": 1})
    assert 0.9 < time.monotonic() - started < 5
    assert not result["isError"], text_of(result)
    lines = text_of(result).splitlines()
    assert lines[0] == "still running after 1 s"
    assert lines[-1].startswith("debug: running")


def test_status_answers_at_once_when_nothing_runs(watching: WatchingBridge):
    watching.debug = {"active": False, "paused": None, "frontier": None}
    started = time.monotonic()
    result = call_tool("pyokka_debug", {"action": "status", "wait_seconds": 30})
    assert time.monotonic() - started < 5 and not result["isError"]
    assert "still running" not in text_of(result)


def test_wait_seconds_is_bounded(watching: WatchingBridge):
    result = call_tool("pyokka_debug", {"action": "status", "wait_seconds": 601})
    assert result["isError"] and "wait_seconds must be 0 to 600" in text_of(result)
