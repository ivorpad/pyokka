"""The CLI's side of recording from a pause: ``pyokka debug FILE --record-from X`` and ``pyokka record --live``.

The launch carries ``recordFrom`` (and implies ``record``), the URI carries it, the value is also a
pause (``--at``), and ``record --live`` asks the bridge for ``{type: "record"}`` and prints the pause
as step 0. The why leaf of a mid-run recording says where the chain ends.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pytest

from pyokka_runtime.agent import debug_start
from pyokka_runtime.agent.commands import add_commands, debug_launch
from pyokka_runtime.agent.relaunch import command_line
from pyokka_runtime.agent.render import _why_node
from pyokka_runtime.agent.source import AgentError
from tests.test_agent_live import FILE, FakeBridge, paused_at, pyokka, pyokka_json, sessions, slice_at, write_descriptor  # noqa: F401 - the fixture


def parser():
    p = argparse.ArgumentParser(prog="pyokka")
    add_commands(p.add_subparsers(dest="command", required=True))
    return p


def test_record_from_builds_a_recording_launch_and_rides_the_uri():
    launch = debug_launch(parser().parse_args(["debug", "app.py", "--record-from", "rank"]))
    assert launch["record"] is True and launch["recordFrom"] == "rank"
    uri = debug_start.build_uri(launch, "rank")
    assert "record=1" in uri and "recordFrom=rank" in uri
    assert "recordFrom" not in debug_start.build_uri(debug_launch(parser().parse_args(["debug", "app.py", "--record"])))
    assert command_line(launch, "rank") == "pyokka debug %s --at rank --record-from rank" % os.path.relpath(os.path.abspath("app.py"))


def test_record_from_refuses_a_module_and_a_bad_value():
    with pytest.raises(AgentError) as exc:
        debug_launch(parser().parse_args(["debug", "--module", "app.server", "--record-from", "rank"]))
    assert "--record-from" in exc.value.message and "module" in exc.value.message
    with pytest.raises(AgentError):
        debug_launch(parser().parse_args(["debug", "app.py", "--record-from", "9lives"]))


def test_record_from_is_also_a_pause(monkeypatch, tmp_path):
    """`--record-from X` with no `--at` pauses at X: the recording starts at a pause, so there must be one."""
    from pyokka_runtime.agent import commands, relaunch

    sent: list = []

    class Source:
        def close(self) -> None:
            pass

    def fake_open(launch, ats):
        sent.append((launch, list(ats)))
        return Source(), launch, "uri"

    monkeypatch.setattr(debug_start, "open_debug_session", fake_open)
    monkeypatch.setattr(relaunch, "remember", lambda *a, **k: None)
    args = parser().parse_args(["debug", str(tmp_path / "app.py"), "--record-from", "rank"])
    commands._open_debug_start(args)
    (launch, ats), = sent
    assert ats == ["rank"] and launch["recordFrom"] == "rank"
    sent.clear()
    args = parser().parse_args(["debug", str(tmp_path / "app.py"), "--at", "load", "--record-from", "rank"])
    commands._open_debug_start(args)
    (launch, ats), = sent
    assert ats == ["load", "rank"], "an earlier --at stays first; the record-from pause is one more"


class RecordBridge(FakeBridge):
    """The fake bridge plus `record`: the pause again as step 0, or `already`."""

    def __init__(self) -> None:
        super().__init__()
        self.recording = False

    def reply(self, req: dict) -> dict:
        if req.get("type") == "record":
            if self.recording:
                return {"ok": True, "already": True, **slice_at(5), "paused": paused_at(5, "breakpoint"), "locals": [], "output": {"text": "", "truncated": False}}
            self.recording = True
            return {"ok": True, "already": False, **slice_at(0, count=1), "paused": paused_at(0, "breakpoint", recordingStarted=True), "locals": [], "output": {"text": "", "truncated": False}}
        return super().reply(req)


def test_record_live_sends_record_and_prints_step_zero(sessions: Path):
    b = RecordBridge()
    write_descriptor(sessions, "1", b.descriptor())
    try:
        code, out = pyokka("record", "--live")
        assert code == 0
        assert b.requests[-1]["type"] == "record"
        assert "paused at demo.py:11 (breakpoint; recording starts here, step 0)" in out
        assert "step 0/1" in out
        code, out = pyokka("record", "--live")
        assert out.startswith("already recording")
        assert pyokka_json("record", "--live")["already"] is True
    finally:
        b.close()


def test_a_stop_before_the_recording_says_how_to_start_it():
    from pyokka_runtime.agent.render_debug import NOT_RECORDING_YET, render_debug_stop

    class Src:
        def display_path(self, p):
            return os.path.basename(p or "")

    result = {"step": 7, "location": {"file": FILE, "line": 3}, "block": {"lines": []}, "stack": [], "paused": paused_at(7, "breakpoint", line=3, stack=[]), "recording": False}
    lines = render_debug_stop(result, Src(), argparse.Namespace(scope=False))
    assert lines[0].startswith("paused at demo.py:3 (breakpoint)") and NOT_RECORDING_YET in lines


def test_step_zero_and_the_history_chain_say_where_the_recording_started():
    from pyokka_runtime.agent.checkpoint import flatten_chain
    from pyokka_runtime.agent.render_debug import recording_start_lines

    assert recording_start_lines({"recordingStart": True}) == ["recording started here: what ran before step 0 was not recorded"]
    assert recording_start_lines({}) == []
    (leaf,) = flatten_chain({"name": "payload", "beforeRecording": True})
    assert leaf["text"] == "?" and leaf["statement"] == "made before #0, where the recording started"


def test_why_leaf_before_the_recording_says_so():
    assert _why_node({"name": "x", "beforeRecording": True}, "", None) == "x = ?   made before #0, where the recording started"
    assert _why_node({"name": "x"}, "", None) == "x = ?"
    from types import SimpleNamespace

    from pyokka_runtime.agent.provenance import ProvenanceBuilder

    builder = ProvenanceBuilder.__new__(ProvenanceBuilder)  # only `run.mid_run` is read by `leaf`
    builder.run = SimpleNamespace(mid_run=True)
    assert builder.leaf("x") == {"name": "x", "beforeRecording": True}
    builder.run = SimpleNamespace(mid_run=False)
    assert builder.leaf("x") == {"name": "x"}
