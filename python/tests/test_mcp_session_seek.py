"""MCP ``pyokka_session`` and ``pyokka_seek``: on a saved run and a live pause."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from pyokka_runtime.agent.mcp_session import seek_recorded, session_state
from pyokka_runtime.agent.source import AgentError
from tests.test_agent_live import FakeBridge, bridge, paused_at, sessions  # noqa: F401 - fixtures

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(PY_DIR, "tests", "fixtures", "port", "seek_app.py")


def record(tmp_path, *extra) -> str:
    out = str(tmp_path / "run.json")
    r = subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", APP, "--save", out, *extra], capture_output=True, text=True, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=120)
    assert r.returncode == 0, r.stderr
    return out


def test_seek_a_value_first_and_last(tmp_path):
    run = record(tmp_path)
    first = seek_recorded({"run": run, "value": "total", "equals": "0"})
    assert first["found"] and first["matches"] == 2  # `total = 0`, then `total += 0`
    assert first["evidence"]["line"] == 1
    assert first["selection"]["observedStep"] == first["selection"]["changeStep"] + 1 == first["step"]
    last = seek_recorded({"run": run, "value": "total", "equals": "0", "occurrence": "last"})
    assert last["evidence"]["line"] == 3 and last["step"] > first["step"]
    assert seek_recorded({"run": run, "value": "total", "equals": "99"})["found"] is False


def test_seek_a_line_first_and_last(tmp_path):
    run = record(tmp_path)
    first = seek_recorded({"run": run, "file": "seek_app.py", "line": 3})
    last = seek_recorded({"run": run, "file": "seek_app.py", "line": 3, "occurrence": "last"})
    assert first["matches"] == last["matches"] == 4
    assert first["context"]["location"]["line"] == 3 and last["step"] > first["step"]
    assert first["next"] == {"tool": "pyokka_step", "arguments": {"run": first["run"], "step": first["step"]}}


def test_a_truncated_run_says_no_match_proves_nothing(tmp_path):
    run = record(tmp_path, "--max-steps", "3")
    res = seek_recorded({"run": run, "value": "label", "equals": "'done'"})
    assert res["found"] is False
    assert any("incomplete" in n for n in res["notes"]), res["notes"]
    assert any("truncated" in n for n in session_state({"run": run})["notes"])


def test_seek_refuses_a_mixed_query(tmp_path):
    with pytest.raises(AgentError):
        seek_recorded({"run": record(tmp_path), "value": "total", "equals": "0", "line": 3})


def test_session_of_a_saved_run_is_a_read_position(tmp_path):
    state = session_state({"run": record(tmp_path), "step": 2})
    assert state["mode"] == "recorded" and state["livePause"] is None
    assert state["recordedSelection"]["step"] == 2 and state["capabilities"]["liveControl"] is False


def test_live_pause_is_kept_apart_from_the_recorded_selection(sessions: Path, bridge: FakeBridge):
    bridge.nav = {"active": True, "step": 5, "count": 40}
    bridge.debug = {"active": True, "paused": paused_at(12, "breakpoint"), "frontier": 12}
    state = session_state({"live": True})
    assert state["mode"] == "live"
    assert state["livePause"]["step"] == 12 and state["recordedSelection"]["step"] == 5
    assert any("behind the live pause" in n for n in state["notes"])
    assert {"locals", "continue", "step"} <= set(state["allowedActions"])
    assert "token" not in str(state["session"]) and bridge.token not in str(state)


def test_without_run_or_live_it_lists_the_sessions(sessions: Path, bridge: FakeBridge):
    state = session_state({})
    assert state["mode"] == "list" and len(state["sessions"]) == 1
