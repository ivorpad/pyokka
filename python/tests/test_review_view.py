"""``review start`` opens the person's view, ``report`` and ``close`` stop the page server it started."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from pyokka_runtime.agent import debug_start
from pyokka_runtime.agent.review import start as start_mod
from pyokka_runtime.agent.review import view
from pyokka_runtime.agent.source import AgentError


class FakeSession:
    def __init__(self, replies: list[dict]) -> None:
        self.replies, self.calls, self.closed = list(replies), [], False

    def debug(self, **kw):
        self.calls.append(("debug", kw))
        return self.replies.pop(0)

    def continue_(self):
        self.calls.append(("continue", {}))
        return self.replies.pop(0)

    def close(self):
        self.closed = True


def data_for(tmp_path, **extra):
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    (repo / "main.py").write_text("print(1)\n")
    return {"repo": str(repo), "entry": "main.py", "argv": ["-v"], "python": sys.executable, "dir": str(tmp_path), "test": None, **extra}


def test_surface_defaults_to_vscode_and_reads_the_environment(monkeypatch):
    monkeypatch.delenv(view.ENV_SURFACE, raising=False)
    assert view.wanted({}) == "vscode" and view.wanted({"surface": "auto"}) == "vscode"
    monkeypatch.setenv(view.ENV_SURFACE, "page")
    assert view.wanted({}) == "page" and view.wanted({"surface": "chat"}) == "chat"


def test_chat_opens_nothing_and_a_test_review_stays_in_chat(tmp_path, monkeypatch):
    monkeypatch.setattr(view, "open_vscode", lambda data: pytest.fail("opened VS Code"))
    state, lines = view.open_view(data_for(tmp_path), {"surface": "chat"})
    assert state == {"kind": "chat"} and lines[0].startswith("view: chat")
    state, lines = view.open_view(data_for(tmp_path, test="test_x"), {"surface": "vscode"})
    assert state["why"] == "test" and "no recording session" in lines[0]


def test_vscode_records_the_entry_the_way_head_was_recorded_and_runs_it_to_its_end(tmp_path, monkeypatch):
    data = data_for(tmp_path)
    session = FakeSession([{"paused": {"file": data["repo"] + "/main.py", "line": 1}}, {"finished": {"exitCode": 0}}])
    seen = {}

    def open_session(launch, *a, **kw):
        seen["launch"] = launch
        return session, None, "uri"

    monkeypatch.setattr(debug_start, "open_debug_session", open_session)
    monkeypatch.setattr(debug_start, "focus_editor", lambda *a: seen.setdefault("focus", a))
    state, lines = view.open_view(data, {"surface": "vscode"})
    launch = seen["launch"]
    assert launch["record"] is True and launch["cwd"] == data["repo"] and launch["args"] == ["-v"]
    assert launch["program"] == os.path.join(data["repo"], "main.py") and launch["env"] == {"PYTHONDONTWRITEBYTECODE": "1"}
    assert [c[0] for c in session.calls] == ["debug", "continue"] and session.closed
    assert state["kind"] == "vscode" and state["exit"] == 0 and "Time Machine" in lines[0] and "focus" in seen


def test_a_view_that_will_not_open_leaves_the_review_in_chat_and_says_why(tmp_path, monkeypatch):
    def fail(launch, *a, **kw):
        raise AgentError("the VS Code window did not start a debug session for main.py", "look at the window first")

    monkeypatch.setattr(debug_start, "open_debug_session", fail)
    state, lines = view.open_view(data_for(tmp_path), {"surface": "vscode"})
    assert state["kind"] == "chat" and "Could not open VS Code: the VS Code window did not start" in lines[0] and "look at the window first" in lines[0]


def start_sleeper(tmp_path):
    """A stand-in for the page server: a process of its own whose command line carries server.js and the port."""
    script = tmp_path / "server.js"
    script.write_text("import time\ntime.sleep(60)\n")
    return subprocess.Popen([sys.executable, str(script), "--port", "4777"], start_new_session=True)


def test_close_stops_the_page_server_it_started_once(tmp_path):
    proc = start_sleeper(tmp_path)
    try:
        data = {"view": {"kind": "page", "pid": proc.pid, "port": 4777}}
        assert view.close_view(data) == "view: stopped the page server on port 4777"
        with pytest.raises(OSError):
            os.kill(proc.pid, 0)
        assert view.close_view(data) is None
    finally:
        proc.kill()


def test_close_leaves_a_process_that_is_not_the_server_alone(tmp_path):
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
    try:
        data = {"view": {"kind": "page", "pid": other.pid, "port": 4777}}
        assert "had already stopped" in view.close_view(data)
        time.sleep(0.2)
        assert other.poll() is None
    finally:
        other.kill()


def test_close_has_nothing_to_stop_for_a_vscode_or_chat_view():
    assert view.close_view({"view": {"kind": "vscode"}}) is None and view.close_view({}) is None


def test_start_keeps_the_view_it_opened_and_report_stops_the_page_server(tmp_path, monkeypatch):
    from tests.test_review_actions import install_fakes, make_repo
    from pyokka_runtime.agent.review import actions

    repo, base = make_repo(tmp_path / "shop")
    proc = start_sleeper(tmp_path)
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    install_fakes(monkeypatch)
    monkeypatch.setattr(view, "open_page", lambda data, port: ({"kind": "page", "pid": proc.pid, "port": 4777}, ["view: page at http://127.0.0.1:4777/. test"]))
    monkeypatch.setattr(start_mod, "_check_view", lambda *a, **k: None)  # the person's own pyokka web may hold 4777
    directory = tmp_path / "review"
    try:
        answer = actions.run({"action": "start", "base": base, "repo": str(repo), "dir": str(directory), "surface": "page"})
        assert "view: page at http://127.0.0.1:4777/. test" in answer["lines"]
        done = actions.run({"action": "report", "dir": str(directory)})
        assert "view: stopped the page server on port 4777" in done["lines"]
        with pytest.raises(OSError):
            os.kill(proc.pid, 0)
        assert "nothing to close" in actions.run({"action": "close", "dir": str(directory)})["lines"][0]
    finally:
        proc.kill()
