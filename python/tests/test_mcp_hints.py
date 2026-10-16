"""The hints an MCP client reads with no skill loaded: the next call in both forms, with real paths.

handoffs/2026-10-16-mcp-progressive-disclosure-review: NO_SESSION_HINT, NO_DEBUG_HINT, the
missing-run, step-range, keep and no-locals hints, the interpreter hints, the render path, and
`debug` start on a session that was already paused.
"""

from __future__ import annotations

import json
import os
import types
from pathlib import Path

import pytest

from pyokka_runtime.agent import commands
from pyokka_runtime.agent.commands import NO_DEBUG_HINT, _already_paused, dispatch
from pyokka_runtime.agent.interpreter import on_path
from pyokka_runtime.agent.mcp import call_tool
from pyokka_runtime.agent.origin import _locals_again
from pyokka_runtime.agent.render import _find_hint, _render_script
from pyokka_runtime.agent.sessions import NO_SESSION_HINT, pick_session
from pyokka_runtime.agent.shell import build_parser
from pyokka_runtime.agent.source import AgentError, SavedRun


def run_cli(*words: str, capsys) -> tuple[int, str]:
    code = dispatch(build_parser().parse_args(list(words)))
    return code, capsys.readouterr().err


def test_no_session_hint_names_the_start_in_both_forms_with_record():
    assert "`pyokka debug FILE --record`" in NO_SESSION_HINT
    assert 'pyokka_debug {"action": "start", "file": "FILE", "record": true}' in NO_SESSION_HINT
    assert "`record` keeps a recording" in NO_SESSION_HINT
    assert 'pyokka_run {"file": "FILE", "save": "/abs/run.json"}' in NO_SESSION_HINT


def test_a_session_name_that_matches_nothing_is_echoed():
    with pytest.raises(AgentError) as exc:
        pick_session([], session="nope.py")
    assert exc.value.message == "no live session for nope.py"


def test_an_executing_step_with_no_session_says_how_to_start_one(monkeypatch, capsys):
    from pyokka_runtime.agent import debug_start
    from pyokka_runtime.agent.relaunch import remember

    remember({"program": "/abs/app.py"}, None)  # a remembered launch must not be started by a step

    def never(*a, **k):
        raise AssertionError("step started a program")

    monkeypatch.setattr(debug_start, "open_debug_session", never)
    monkeypatch.setattr(commands, "_relaunch", never)
    code, err = run_cli("step", "--live", "--over", capsys=capsys)
    assert code == 2 and "error: no live session" in err
    assert NO_DEBUG_HINT in err
    code, err = run_cli("step", "--live", "--into", "--session", "nope.py", capsys=capsys)
    assert code == 2 and "no live session for nope.py" in err and NO_DEBUG_HINT in err


def test_a_backward_step_with_no_session_keeps_the_session_hint(capsys):
    code, err = run_cli("step", "--live", "--back", capsys=capsys)
    assert code == 2 and NO_SESSION_HINT in err


def test_no_debug_hint_has_the_mcp_form():
    assert 'pyokka_debug {"action": "start", "file": "FILE", "at": ["NAME"]}' in NO_DEBUG_HINT


def test_debug_status_with_no_session_says_how_to_start_one():
    reply = call_tool("pyokka_debug", {"action": "status"})
    text = reply["content"][0]["text"]
    assert reply["isError"] and text.startswith("error: no live session\n") and NO_DEBUG_HINT in text
    reply = call_tool("pyokka_debug", {"action": "status", "session": "nope.py"})
    assert reply["isError"] and "no live session for nope.py" in reply["content"][0]["text"]


def test_missing_run_hint_keeps_the_full_path_in_both_forms(tmp_path: Path):
    path = str(tmp_path / "sub" / "nope.json")
    with pytest.raises(AgentError) as exc:
        SavedRun(path)
    assert "`pyokka run FILE --save %s`" % path in exc.value.hint
    assert 'pyokka_run {"file": "FILE", "save": %s}' % json.dumps(path) in exc.value.hint


def bare_run(path: str, meta: dict | None = None) -> SavedRun:
    run = SavedRun.__new__(SavedRun)
    run.path, run.meta = path, meta or {}
    return run


def test_step_range_hint_names_pyokka_map_steps_and_find(tmp_path: Path):
    path = tmp_path / "run.json"
    path.write_text("{}")
    hint = bare_run(str(path))._pick_step_hint()
    assert '`pyokka steps %s`' % path in hint and 'pyokka_map {"action": "steps", "run": %s}' % json.dumps(str(path)) in hint
    assert 'pyokka_map {"action": "find", "run": %s, "text": "TEXT"}' % json.dumps(str(path)) in hint
    live = bare_run("live-run.json")._pick_step_hint()
    assert "`pyokka steps --live`" in live and '"live": true' in live


def test_keep_hints_give_both_forms_with_absolute_paths(tmp_path: Path):
    path = str(tmp_path / "run.json")
    with pytest.raises(AgentError) as exc:
        bare_run(path, {"file": "/abs/app.py"})._keep_link()
    assert "`pyokka run /abs/app.py --save %s --keep`" % path in exc.value.hint
    assert 'pyokka_run {"file": "/abs/app.py", "save": %s, "keep": true}' % json.dumps(path) in exc.value.hint
    assert '"live": true' in exc.value.hint


def test_origin_no_locals_hint_gives_both_forms_with_absolute_paths(tmp_path: Path):
    path = str(tmp_path / "run.json")
    hint = _locals_again(bare_run(path, {"file": "/abs/app.py"}))
    assert "`pyokka run /abs/app.py --save %s`" % path in hint
    assert 'pyokka_run {"file": "/abs/app.py", "save": %s}, without no_locals' % json.dumps(path) in hint


def test_interpreter_hints_name_the_mcp_python_field():
    with pytest.raises(AgentError) as exc:
        on_path("no-such-python-3.99", "--python")
    assert "--python" in exc.value.hint and "the `python` field" in exc.value.hint


def test_render_path_is_absolute_and_find_hint_has_the_mcp_form(tmp_path: Path):
    script = _render_script()
    assert os.path.isabs(script) and os.path.isfile(script)
    path = tmp_path / "run.json"
    path.write_text("{}")
    hint = _find_hint(types.SimpleNamespace(path=str(path)), "total")
    assert "`pyokka find %s total`" % path in hint
    assert 'pyokka_map {"action": "find", "run": %s, "text": "total"}' % json.dumps(str(path)) in hint


def start_args(**given) -> types.SimpleNamespace:
    base = {"program": "/abs/app.py", "module": None, "args": [], "env": [], "cwd": None, "python": None, "record": False, "record_from": None, "stop_on_entry": False, "library_code": False, "test": None}
    return types.SimpleNamespace(**{**base, **given})


def test_debug_start_on_a_paused_session_says_so_and_names_what_was_not_applied():
    result: dict = {"block": [], "moves": {}, "count": 3}  # a recording session's stop
    _already_paused(start_args(env=["PORT=1"], args=["-v"]), result)
    assert result["note"].startswith("a debug session on /abs/app.py was already paused: this is that pause, nothing was started")
    assert "--args (MCP: args)" in result["note"] and "--env (MCP: env)" in result["note"]
    assert 'pyokka_debug {"action": "stop"}' in result["note"]
    plain: dict = {"block": [], "moves": {}, "count": 3}
    _already_paused(start_args(), plain)
    assert "not applied" not in plain["note"]


def test_debug_start_refuses_a_record_the_paused_session_cannot_give():
    with pytest.raises(AgentError) as exc:
        _already_paused(start_args(record=True), {"kind": "debug"})
    assert "already paused and is not recording" in exc.value.message and "--record (MCP: record)" in exc.value.message
    with pytest.raises(AgentError) as exc:
        _already_paused(start_args(record_from="main"), {"kind": "debug"})
    assert "--record-from (MCP: record_from)" in exc.value.message
    recording: dict = {"block": [], "moves": {}, "count": 3}
    _already_paused(start_args(record=True), recording)  # a recording session already gives what was asked
    assert "not applied" not in recording["note"]


def test_the_suite_never_launches_vscode():
    """conftest's guard: the shipped launchers are not searched, and open_url refuses one outside pytest's temp dirs."""
    from pyokka_runtime.agent import debug_start, web

    assert web.VSCODE_APPS == () and web.CODE_BIN_DIRS == ()
    with pytest.raises(AgentError, match="tests never launch VS Code"):
        debug_start.open_url("vscode://ivor.pyokka/debug", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
    with pytest.raises(AgentError):  # the default PYOKKA_CODE stub exits 1, so a launch fails fast
        debug_start.open_url("vscode://ivor.pyokka/debug")
