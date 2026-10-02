"""A debugger verb with no session starts the last `pyokka debug` launch from this directory again."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pyokka_runtime.agent import debug_start, relaunch
from pyokka_runtime.agent.live import LiveRun
from tests.test_agent_live import FakeBridge, paused_at, pyokka, write_descriptor


@pytest.fixture
def home(tmp_path: Path, monkeypatch) -> Path:
    d = tmp_path / "pyokka" / "sessions"
    d.mkdir(parents=True)
    monkeypatch.setenv("PYOKKA_SESSIONS_DIR", str(d))
    work = tmp_path / "work"
    (work / "pkg").mkdir(parents=True)
    (work / "demo.py").write_text("x = 1\n", encoding="utf-8")
    monkeypatch.chdir(work)
    monkeypatch.setenv("PYOKKA_NO_FOCUS", "1")
    return work


def test_the_memory_sits_beside_the_sessions_directory_and_answers_the_nearest_directory(home: Path):
    assert os.path.dirname(relaunch.memory_path()) == os.path.dirname(os.environ["PYOKKA_SESSIONS_DIR"])
    relaunch.remember({"program": str(home / "demo.py")}, "rrf", cwd=str(home))
    relaunch.remember({"module": "pytest"}, None, cwd=str(home / "pkg"))
    assert relaunch.recall(str(home))["at"] == "rrf"
    assert relaunch.recall(str(home / "pkg"))["launch"] == {"module": "pytest"}
    # a directory below one that launched gets that launch; a sibling gets nothing
    (home / "sub").mkdir()
    assert relaunch.recall(str(home / "sub"))["at"] == "rrf"
    assert relaunch.recall(str(home.parent)) is None
    # nothing in the sessions directory, where every file is read as a descriptor
    assert os.listdir(os.environ["PYOKKA_SESSIONS_DIR"]) == []


def test_command_line_names_what_it_re_ran(home: Path):
    line = relaunch.command_line({"module": "pytest", "args": ["--assert=plain", "-x"]}, "app.py:3")
    assert line == "pyokka debug --module pytest --at app.py:3 --args --assert=plain -x"


def test_no_session_and_nothing_remembered_says_to_start_one(home: Path, capsys):
    code, _ = pyokka("continue", "--live")
    err = capsys.readouterr().err
    assert code == 2 and "no live session" in err and "pyokka debug FILE --at NAME" in err


def test_continue_with_no_session_starts_the_last_launch_and_prints_its_first_stop(home: Path, monkeypatch, capsys):
    bridge = FakeBridge()
    bridge.debug = {"active": True, "paused": paused_at(7, "breakpoint"), "frontier": 7}
    calls = []

    def fake_open(launch, at=None, **_):
        calls.append((launch, at))
        write_descriptor(Path(os.environ["PYOKKA_SESSIONS_DIR"]), "d", dict(bridge.descriptor(), kind="debug"))
        return LiveRun(dict(bridge.descriptor(), kind="debug")), None, "debug"

    monkeypatch.setattr(debug_start, "open_debug_session", fake_open)
    launch = {"program": str(home / "demo.py"), "cwd": str(home)}
    relaunch.remember(launch, "rrf")
    try:
        code, out = pyokka("continue", "--live")
    finally:
        bridge.close()
    assert code == 0, capsys.readouterr().err
    assert calls == [(launch, ["rrf"])]
    assert out.startswith("no debug session was running: started the last launch from this directory again, `pyokka debug demo.py --at rrf`")
    assert "paused at" in out
    # the stop was read, not moved past: no `continue` reached the program
    assert [r["type"] for r in bridge.requests if r["type"] in ("continue", "debug")] == ["debug"]


def test_break_with_no_session_stops_at_the_new_breakpoint(home: Path, monkeypatch):
    bridge = FakeBridge()
    bridge.debug = {"active": True, "paused": paused_at(3, "breakpoint"), "frontier": 3}
    calls = []

    def fake_open(launch, at=None, **_):
        calls.append(at)
        return LiveRun(dict(bridge.descriptor(), kind="debug")), None, "debug"

    monkeypatch.setattr(debug_start, "open_debug_session", fake_open)
    relaunch.remember({"program": str(home / "demo.py"), "cwd": str(home)}, "rrf")
    try:
        code, out = pyokka("break", "--live", "demo.py:1")
    finally:
        bridge.close()
    assert code == 0
    assert calls == [["%s:1" % (home / "demo.py")]]
    # the next launch from here starts at the breakpoint just asked for
    assert relaunch.recall()["at"] == "%s:1" % (home / "demo.py")


def test_no_start_refuses_and_names_the_launch(home: Path, monkeypatch, capsys):
    monkeypatch.setattr(debug_start, "open_debug_session", lambda *a, **k: pytest.fail("started a launch"))
    relaunch.remember({"program": str(home / "demo.py"), "cwd": str(home)}, "rrf")
    code, out = pyokka("continue", "--live", "--no-start", "--json")
    doc = json.loads(out)
    assert code == 2 and doc["error"] == "no live session" and "pyokka debug demo.py --at rrf" in doc["hint"]


def test_listing_breakpoints_never_starts_a_program(home: Path, monkeypatch, capsys):
    monkeypatch.setattr(debug_start, "open_debug_session", lambda *a, **k: pytest.fail("started a launch"))
    relaunch.remember({"program": str(home / "demo.py"), "cwd": str(home)}, "rrf")
    code, _ = pyokka("break", "--live", "--list")
    assert code == 2 and "pyokka debug FILE --at NAME" in capsys.readouterr().err


def test_every_at_of_a_launch_is_remembered_and_started_again(home: Path, monkeypatch):
    bridge = FakeBridge()
    bridge.debug = {"active": True, "paused": paused_at(3, "breakpoint"), "frontier": 3}
    calls = []

    def fake_open(launch, at=None, **_):
        calls.append(at)
        return LiveRun(dict(bridge.descriptor(), kind="debug")), None, "uri"

    monkeypatch.setattr(debug_start, "open_debug_session", fake_open)
    relaunch.remember({"program": str(home / "demo.py"), "cwd": str(home)}, "load", ["clean", "score"])
    try:
        code, out = pyokka("continue", "--live")
    finally:
        bridge.close()
    assert code == 0
    # one stop per stage, all set before the program starts again
    assert calls == [["load", "clean", "score"]]
    assert "`pyokka debug demo.py --at load --at clean --at score`" in out


def test_the_uri_carries_every_at():
    uri = debug_start.build_uri({"program": "/w/app.py"}, ["load", "/w/stage.py:3"])
    assert uri.count("&at=") == 2 and "at=load" in uri and "at=%2Fw%2Fstage.py%3A3" in uri
