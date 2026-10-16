"""Which surface the person is on (page, VS Code debug pause, VS Code recording, chat) and how a stop moves it.

The page is a small HTTP server speaking the bridge's two routes; VS Code is ``FakeBridge`` from the
live tests on a Unix socket. Nothing here needs a browser, a bridge build or an editor.
"""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable

import pytest

from pyokka_runtime.agent.live import SESSIONS_ENV
from pyokka_runtime.agent.review.surfaces import condition_for, default_port, detect, detect_vscode, entry_of, is_literal, move_to, page_state, stop_file
from tests.test_agent_live import FILE, WORKSPACE, FakeBridge, paused_at, write_descriptor


class FakePage:
    """The bridge's HTTP side: ``GET /api/state`` answers ``state``, ``POST /api/command`` records the body and answers ``reply``."""

    def __init__(self, state: dict, reply: dict | Callable[[dict], dict] | None = None, status: int = 200) -> None:
        self.state = state
        self.reply = reply if reply is not None else {"result": {"ok": True}}
        self.status = status
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _json(self, code: int, body: Any) -> None:
                data = json.dumps(body).encode("utf-8")
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                if self.path != "/api/state":
                    return self._json(404, {"error": "not found"})
                body = dict(outer.state)
                self._json(409 if body.get("error") else 200, body)

            def do_POST(self) -> None:
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                outer.requests.append(body)
                reply = outer.reply(body) if callable(outer.reply) else outer.reply
                self._json(outer.status, reply)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def no_sessions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv(SESSIONS_ENV, str(sessions))
    return sessions


HEAD = {"meta": {"file": FILE, "workspaceRoot": WORKSPACE}}
STOP = {"n": 2, "kind": "type", "file": "demo.py", "line": 11, "function": "<module>", "fact": "x: int → str (1 → '1')", "step_a": 9, "step_b": 7, "a": "1", "b": "'1'", "name": "x", "values": ["3", "'a'"], "locals": [{"name": "total", "text": "3", "step": 6, "line": 9}, {"name": "label", "text": "'a'", "step": 7, "line": 10}]}


# -- detection ----------------------------------------------------------------------------------------------

def test_default_port_is_the_bridges_rule(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("PYOKKA_PORT", raising=False)
    assert default_port(None) == 4777 and default_port(4790) == 4790 and default_port("4791") == 4791
    monkeypatch.setenv("PYOKKA_PORT", "4800")
    assert default_port(None) == 4800 and default_port(0) == 4800


def test_a_page_with_one_tab_is_the_page_surface(no_sessions: Path):
    page = FakePage({"url": "http://127.0.0.1/", "file": FILE, "pages": 1, "state": {"nav": {"step": 3}}})
    try:
        assert detect(page.port, None) == "page"
        assert page_state(page.port)["file"] == FILE
    finally:
        page.close()


def test_a_bridge_without_a_tab_or_no_bridge_falls_through_to_chat(no_sessions: Path):
    page = FakePage({"url": "http://127.0.0.1/", "file": FILE, "pages": 0, "state": None, "error": "no page is open: open http://127.0.0.1/ first"})
    try:
        assert detect(page.port, None) == "chat"
    finally:
        page.close()
    assert detect(closed_port(), None) == "chat"
    assert page_state(closed_port()) is None


def test_a_paused_debug_session_wins_over_a_recording(no_sessions: Path):
    recording = FakeBridge()
    debugger = FakeBridge()
    debugger.debug = {"active": True, "paused": paused_at(3, "breakpoint", line=11), "frontier": 3, "exceptions": "uncaught"}
    try:
        write_descriptor(no_sessions, "run", recording.descriptor())
        assert detect(closed_port(), None) == "vscode-recording"
        write_descriptor(no_sessions, "dbg", {**debugger.descriptor(), "kind": "debug", "started": "2026-09-10T11:00:00Z"})
        assert detect(closed_port(), None) == "vscode-debug"
        kind, live = detect_vscode("demo.py")
        assert kind == "vscode-debug" and live is not None
        live.close()
        assert detect_vscode("other.py") == ("chat", None)
    finally:
        recording.close()
        debugger.close()


# -- the condition --------------------------------------------------------------------------------------------

def test_literals_are_what_a_breakpoint_condition_can_compare():
    assert all(is_literal(t) for t in ("5", "-1.5", "'1,249.00'", '"x"', "None", "True", "[1, 2]", "('a', 1)", "{'k': 1}"))
    assert not any(is_literal(t) for t in ("(value not recorded)", "Order(customer='Ben')", "<function f at 0x1>", "Decimal('1.0')", "'abc…(cut)", "[1, 2, …(+4 chars)", "", None, "x" * 81))


def test_the_condition_takes_the_anomalys_name_first_then_the_latest_literal_locals():
    stop = {"name": "unit_price", "step_b": 120, "locals": [
        {"name": "row", "text": "{'customer': 'Ben', 'qty': '1'}", "step": 117},
        {"name": "order", "text": "Order(customer='Ben', tier='silver', lines=[])", "step": 119},
        {"name": "charged", "text": "'1,249.00'", "step": 120},
        {"name": "n", "text": "1", "step": 118},
        {"name": "n", "text": "2", "step": 119},
        {"name": "later", "text": "5", "step": 125},
        {"name": "unit_price", "text": "'1,249.00'", "step": 120},
        {"name": "x.area()", "text": "3", "step": 120},
    ]}
    assert condition_for(stop) == "unit_price == '1,249.00' and charged == '1,249.00'"
    assert condition_for(stop, limit=3) == "unit_price == '1,249.00' and charged == '1,249.00' and n == 2"
    assert condition_for({"step_b": 5, "locals": [{"name": "o", "text": "Order()", "step": 4}]}) is None
    assert condition_for({"step_b": 5, "locals": []}) is None and condition_for({"values": ["3"]}) is None
    assert condition_for({"step_b": 5, "locals": [{"name": "k", "text": "'v'", "step": None}]}) == "k == 'v'"


def test_entry_and_breakpoint_file_come_from_the_head_run(tmp_path: Path):
    head = tmp_path / "head.json"
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "m.py").write_text("x = 1\n", encoding="utf-8")
    head.write_text(json.dumps({"meta": {"file": str(tmp_path / "main.py"), "workspaceRoot": str(tmp_path)}, "events": []}), encoding="utf-8")
    assert entry_of(str(head)) == str(tmp_path / "main.py") and entry_of(HEAD) == FILE and entry_of(str(tmp_path / "missing.json")) == ""
    assert stop_file({"file": "pkg/m.py"}, str(head)) == str(tmp_path / "pkg" / "m.py")
    assert stop_file({"file": "pkg/gone.py"}, str(head)) == "pkg/gone.py"
    assert stop_file({"file": "/abs/x.py"}, str(head)) == "/abs/x.py"


# -- moving ------------------------------------------------------------------------------------------------

def test_the_page_gets_goto_step_b_with_the_say_text(no_sessions: Path):
    page = FakePage({"url": "http://127.0.0.1/", "file": FILE, "pages": 1, "state": {}})
    try:
        out = move_to(STOP, "unit_price is '1' here", "auto", page.port, None, HEAD)
        assert (out["surface"], out["moved"]) == ("page", True) and "step 7" in out["note"]
        assert page.requests == [{"action": "goto", "step": 7, "say": "unit_price is '1' here"}]
        out = move_to(STOP, None, "page", page.port, None, HEAD)
        assert out["moved"] and page.requests[-1] == {"action": "goto", "step": 7}
    finally:
        page.close()


def test_the_page_is_refused_when_it_shows_another_file_and_errors_are_reported(no_sessions: Path):
    page = FakePage({"url": "http://127.0.0.1/", "file": WORKSPACE + "/other.py", "pages": 1, "state": {}})
    try:
        out = move_to(STOP, "say", "page", page.port, None, HEAD)
        assert out == {"surface": "page", "moved": False, "available": False, "note": "the page on port %d shows %s/other.py, not the review's entry %s; nothing moved" % (page.port, WORKSPACE, FILE)}
        assert page.requests == []
    finally:
        page.close()
    refusing = FakePage({"url": "http://127.0.0.1/", "file": FILE, "pages": 1, "state": {}}, reply={"result": None, "error": "a page command is still pending"}, status=409)
    try:
        out = move_to(STOP, "say", "page", refusing.port, None, HEAD)
        assert not out["moved"] and out["note"] == "the page refused goto 7: a page command is still pending"
        no_step = move_to({**STOP, "step_b": None}, "say", "page", refusing.port, None, HEAD)
        assert not no_step["moved"] and "no head step" in no_step["note"]
    finally:
        refusing.close()
    out = move_to(STOP, "say", "page", closed_port(), None, HEAD)
    assert not out["moved"] and out["note"].startswith("no Pyokka page answers on 127.0.0.1:")


def test_a_debug_session_gets_a_conditional_breakpoint_then_continue(no_sessions: Path):
    bridge = FakeBridge()
    bridge.debug = {"active": True, "paused": paused_at(3, "start"), "frontier": 3, "exceptions": "uncaught"}
    try:
        write_descriptor(no_sessions, "dbg", {**bridge.descriptor(), "kind": "debug"})
        out = move_to(STOP, "label is 'a'", "auto", closed_port(), None, HEAD)
        assert (out["surface"], out["moved"], out["condition"]) == ("vscode-debug", True, "label == 'a' and total == 3")
        assert out["breakpoint"] == {"file": "demo.py", "line": 11, "condition": "label == 'a' and total == 3"}
        assert out["note"] == "paused at demo.py:11 (breakpoint if label == 'a' and total == 3)"
        types = [r["type"] for r in bridge.requests]
        assert types[-2:] == ["break", "continue"]
        assert bridge.requests[-2]["add"] == [{"file": "demo.py", "line": 11, "condition": "label == 'a' and total == 3"}]
        # without a literal local there is no condition, and a stop the program never reaches is reported
        bridge.finish_next = True
        out = move_to({**STOP, "locals": [], "file": "demo.py", "line": 30}, "say", "vscode", closed_port(), "demo.py", HEAD)
        assert (out["surface"], out["moved"], out["condition"]) == ("vscode-debug", False, None)
        assert out["note"] == "the program ended (exit 0) without reaching demo.py:30; a debug session only runs forward: pyokka restart --live --stop-on-entry, then stop 2 again"
        assert "condition" not in bridge.requests[-2]["add"][0]
    finally:
        bridge.close()


def test_a_recording_session_steps_its_time_machine_to_step_b(no_sessions: Path):
    bridge = FakeBridge()
    try:
        write_descriptor(no_sessions, "run", bridge.descriptor())
        out = move_to(STOP, "say", "auto", closed_port(), None, HEAD)
        assert out == {"surface": "vscode-recording", "moved": True, "note": "Time Machine at step 7  demo.py:11"}
        assert bridge.requests[-1] == {"id": bridge.requests[-1]["id"], "type": "step", "to": 7}
        out = move_to({**STOP, "step_b": None}, "say", "vscode-recording", closed_port(), None, HEAD)
        assert not out["moved"] and "no head step" in out["note"]
        out = move_to({**STOP, "step_b": 99}, "say", "vscode", closed_port(), None, HEAD)
        assert (out["surface"], out["moved"]) == ("vscode-recording", False) and out["note"].startswith("step 99 is out of range")
    finally:
        bridge.close()


def test_a_paused_session_on_another_file_is_neither_detected_nor_moved(no_sessions: Path):
    other = FakeBridge()
    other.debug = {"active": True, "paused": paused_at(3, "start"), "frontier": 3, "exceptions": "uncaught"}
    try:
        write_descriptor(no_sessions, "dbg", {**other.descriptor(file=WORKSPACE + "/other.py"), "kind": "debug"})
        assert detect(closed_port(), None) == "vscode-debug"  # with no entry to hold it to
        assert detect(closed_port(), None, FILE) == "chat"  # the review's entry is demo.py
        out = move_to(STOP, "label is 'a'", "auto", closed_port(), None, HEAD)
        assert (out["surface"], out["moved"]) == ("chat", False) and "no VS Code session on demo.py" in out["note"]
        out = move_to(STOP, "label is 'a'", "vscode", closed_port(), None, HEAD)
        assert out["surface"] == "chat" and out["moved"] is False and out["available"] is False and out["note"].startswith("no live VS Code session on demo.py; start one on the entry: pyokka debug %s --record --cwd %s (MCP: pyokka_debug {\"action\": \"start\", \"file\": \"%s\", \"record\": true, \"cwd\": \"%s\"})" % (FILE, WORKSPACE, FILE, WORKSPACE)) and out["note"].endswith("then stop again with the same n")
        assert not [r for r in other.requests if r["type"] in ("break", "continue")]
        out = move_to(STOP, "label is 'a'", "vscode", closed_port(), "other.py", HEAD)  # named, it is the one
        assert out["surface"] == "vscode-debug" and [r["type"] for r in other.requests][-2:] == ["break", "continue"]
    finally:
        other.close()


def test_chat_moves_nothing(no_sessions: Path):
    assert move_to(STOP, "say", "chat", closed_port(), None, HEAD) == {"surface": "chat", "moved": False, "note": "nothing to move"}
    out = move_to(STOP, "say", "auto", closed_port(), None, HEAD)
    assert (out["surface"], out["moved"]) == ("chat", False)
    assert out["note"].startswith("nothing to move: no page on 127.0.0.1:") and out["note"].endswith(
        "or pyokka web %s --cwd %s (MCP: pyokka_page {\"action\": \"open\", \"file\": \"%s\", \"cwd\": \"%s\"}), then open its URL in one browser tab)" % (FILE, WORKSPACE, FILE, WORKSPACE)) and "no VS Code session on demo.py; the person saw it only in chat (start a view where the person is: pyokka debug %s --record --cwd %s (MCP: pyokka_debug" % (FILE, WORKSPACE) in out["note"]
    out = move_to(STOP, "say", "vscode", closed_port(), None, HEAD)
    assert out["surface"] == "chat" and out["moved"] is False and out["available"] is False and out["note"].startswith("no live VS Code session on demo.py; start one on the entry: pyokka debug %s --record --cwd %s (MCP: pyokka_debug {\"action\": \"start\", \"file\": \"%s\", \"record\": true, \"cwd\": \"%s\"})" % (FILE, WORKSPACE, FILE, WORKSPACE)) and out["note"].endswith("then stop again with the same n")
    out = move_to(STOP, "say", "vscode", closed_port(), "other.py", HEAD)
    assert out["surface"] == "chat" and out["moved"] is False and out["available"] is False and out["note"].startswith("no live VS Code session matches other.py; start one on the entry: pyokka debug %s --record --cwd %s (MCP: pyokka_debug {\"action\": \"start\", \"file\": \"%s\", \"record\": true, \"cwd\": \"%s\"})" % (FILE, WORKSPACE, FILE, WORKSPACE)) and out["note"].endswith("then stop again with the same n")
    assert move_to(STOP, "say", "tv", closed_port(), None, HEAD)["note"].startswith("unknown surface 'tv'")
