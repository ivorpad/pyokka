"""What an MCP client reads with no skill loaded: pyokka_session's readiness, seek's misses, the investigation and page refusals."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pyokka_runtime.agent import mcp_page, mcp_session
from pyokka_runtime.agent.mcp_session import agent_access, closed_sessions, extension_version, readiness_note, seek_recorded, session_state, vscode_readiness
from pyokka_runtime.agent.saved_investigation import open_investigation, save_investigation
from pyokka_runtime.agent.source import AgentError
from tests.test_agent_live import FakeBridge, bridge, sessions  # noqa: F401 - fixtures
from tests.test_mcp_session_seek import record


def dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def test_readiness_reads_extension_settings_and_closed_descriptors(tmp_path):
    ext = tmp_path / "ext"
    for name in ("ivor.pyokka-0.4.0", "ivor.pyokka-0.10.1", "ms-python.python-1.0.0"):
        (ext / name).mkdir(parents=True)
    settings = tmp_path / "settings.json"
    settings.write_text('{\n  // "pyokka.agentAccess": false,\n  "pyokka.agentAccess": true,\n  "x": 1,\n}\n', encoding="utf-8")
    descs = tmp_path / "sessions"
    descs.mkdir()
    (descs / "1-1.json").write_text(json.dumps({"pid": dead_pid(), "socket": "s", "token": "t", "file": "f"}), encoding="utf-8")
    (descs / "2-1.json").write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
    got = vscode_readiness(str(descs), str(ext), str(settings), code="/bin/code")
    assert got == {"code": "/bin/code", "extension": "0.10.1", "agentAccess": True, "closedSessions": 1}
    assert extension_version(str(tmp_path / "none")) is None and agent_access(str(tmp_path / "none.json")) is None
    assert closed_sessions(str(tmp_path / "none")) == 0


@pytest.mark.parametrize("state, says", [
    ({"code": None, "extension": "0.5.0", "agentAccess": True}, "VS Code was not found"),
    ({"code": "/c", "extension": None, "agentAccess": True}, "extension is not installed"),
    ({"code": "/c", "extension": "0.5.0", "agentAccess": None}, "not set (default off)"),
    ({"code": "/c", "extension": "0.5.0", "agentAccess": False}, "agentAccess is off"),
    ({"code": "/c", "extension": "0.5.0", "agentAccess": True}, "VS Code is not running"),
])
def test_the_first_note_names_the_state_and_the_start_call(state, says):
    note = readiness_note({**state, "closedSessions": 2})
    assert says in note and "2 published session(s)" in note
    assert "pyokka debug FILE --record" in note and '{"action": "start", "file": "FILE", "record": true}' in note


def test_list_with_no_session_is_not_ready_and_says_why(sessions: Path, monkeypatch, tmp_path):  # noqa: F811
    monkeypatch.setattr(mcp_session, "find_code", lambda: None)
    state = session_state({})
    assert state["ready"] is False and state["sessions"] == [] and state["vscode"]["code"] is None
    assert state["notes"][0].startswith("No live session, and VS Code was not found")


def test_list_with_a_session_marks_recording(sessions: Path, bridge: FakeBridge):  # noqa: F811
    state = session_state({})
    assert state["ready"] is True and "vscode" in state
    assert [s["recording"] for s in state["sessions"]] == [s["kind"] == "run" for s in state["sessions"]]
    assert not state["notes"][0].startswith("No live session")


def test_seek_says_why_nothing_matched(tmp_path):
    run = record(tmp_path)
    wrong = seek_recorded({"run": run, "value": "total", "equals": "'6'"})
    assert wrong["found"] is False and "0" in wrong["recordedTexts"] and any("recordedTexts" in n for n in wrong["notes"])
    misspelt = seek_recorded({"run": run, "value": "totl", "equals": "6"})
    assert any("never changed" in n and '"action": "var"' in n for n in misspelt["notes"])
    line = seek_recorded({"run": run, "file": "seek_app.py", "line": 9999})
    assert any("never ran" in n and "pyokka_coverage" in n for n in line["notes"])
    with pytest.raises(AgentError) as exc:
        seek_recorded({"live": True})
    assert '"file": "/abs/app.py"' in exc.value.hint


def test_investigation_refusals_name_the_next_call(tmp_path):
    run = record(tmp_path)
    with pytest.raises(AgentError) as exc:
        save_investigation({"path": str(tmp_path / "a.json"), "run": run, "question": "q", "checkpoints": [{"name": "far", "step": 10_000}]})
    assert "far" in exc.value.message and '"action": "steps"' in exc.value.hint
    with pytest.raises(AgentError) as exc:
        save_investigation({"path": str(tmp_path / "a.json"), "live": True, "question": "q", "checkpoints": [{"name": "a", "step": 1}]})
    assert "pyokka_run" in exc.value.hint

    with pytest.raises(AgentError) as exc:
        open_investigation({"path": run})
    assert "is not an investigation" in exc.value.message and "pyokka_map" in exc.value.hint

    inv = tmp_path / "inv.json"
    save_investigation({"path": str(inv), "run": run, "question": "why 6?", "checkpoints": [{"name": "a", "step": 1}]})
    moved = tmp_path / "moved"
    moved.mkdir()
    (moved / "inv.json").write_text(inv.read_text(), encoding="utf-8")
    with pytest.raises(AgentError) as exc:
        open_investigation({"path": str(moved / "inv.json")})
    assert "relative to its own folder" in exc.value.message and "pyokka_save_investigation" in exc.value.hint

    with open(run, "a", encoding="utf-8") as fh:
        fh.write(" ")
    with pytest.raises(AgentError) as exc:
        open_investigation({"path": str(inv)})
    assert os.path.realpath(run) in exc.value.message and "changed" in exc.value.message
    assert '"action": "walkthrough"' in exc.value.hint and "why 6?" in exc.value.hint


def test_no_page_hint_keeps_the_port_and_names_the_tab(monkeypatch):
    monkeypatch.setattr(mcp_page, "listening", lambda port, *a, **k: False)
    for call in (lambda: mcp_page.call_page({"action": "state", "port": 4799}), lambda: mcp_page.call_scratchpad({"op": "state", "port": 4799})):
        with pytest.raises(AgentError) as exc:
            call()
        assert '"port": 4799' in exc.value.hint and "browser tab" in exc.value.hint
    monkeypatch.setattr(mcp_page, "STARTED", {})
    body, failed = mcp_page.call_page({"action": "list"})
    assert not failed and "hint" in json.loads(body)
