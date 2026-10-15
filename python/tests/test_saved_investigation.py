"""MCP ``pyokka_save_investigation`` / ``pyokka_open_investigation``."""

from __future__ import annotations

import json
import os

import pytest

from pyokka_runtime.agent.saved_investigation import open_investigation, save_investigation
from pyokka_runtime.agent.source import AgentError
from tests.test_mcp_session_seek import record


def test_save_then_reopen_answers_the_checkpoints(tmp_path):
    run = record(tmp_path)
    inv = str(tmp_path / "inv.json")
    saved = save_investigation({"path": inv, "run": run, "question": "why is total 6?", "checkpoints": [{"name": "start", "step": 1}, {"name": "loop", "step": 4}]})
    doc = json.loads(open(inv).read())
    assert doc["run"] == "run.json" and len(doc["sha256"]) == 64
    reopened = open_investigation({"path": inv})
    assert [c["context"]["step"] for c in reopened["checkpoints"]] == [1, 4]
    assert reopened["checkpoints"] == saved["checkpoints"]


def test_reopening_after_the_run_file_changes_is_refused(tmp_path):
    run = record(tmp_path)
    inv = str(tmp_path / "inv.json")
    save_investigation({"path": inv, "run": run, "question": "q", "checkpoints": [{"name": "a", "step": 1}]})
    with open(run, "a", encoding="utf-8") as fh:
        fh.write(" ")  # same JSON, other bytes: the digest is of the file as saved
    with pytest.raises(AgentError) as exc:
        open_investigation({"path": inv})
    assert "changed" in exc.value.message


def test_it_never_overwrites_and_checks_steps_before_writing(tmp_path):
    run = record(tmp_path)
    inv = str(tmp_path / "inv.json")
    with pytest.raises(AgentError):
        save_investigation({"path": inv, "run": run, "question": "q", "checkpoints": [{"name": "far", "step": 10_000}]})
    assert not os.path.exists(inv), "a bad checkpoint writes nothing"
    save_investigation({"path": inv, "run": run, "question": "q", "checkpoints": [{"name": "a", "step": 1}]})
    with pytest.raises(AgentError) as exc:
        save_investigation({"path": inv, "run": run, "question": "q2", "checkpoints": [{"name": "a", "step": 1}]})
    assert "never overwritten" in exc.value.message
