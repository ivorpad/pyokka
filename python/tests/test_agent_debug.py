"""The CLI's side of the Debugger (docs/design/debugger-product.md, 4.7, 3.10, 4.9).

Which descriptor a verb drives, what the URI looks like, and the three routes of a cold start.
``PYOKKA_SESSIONS_DIR`` points at a ``tmp_path`` holding hand-written descriptors, so no window
and no socket are needed for most of these; ``PYOKKA_CODE`` is a stub script that records the URI
it was handed instead of opening VS Code.
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time

import pytest

from pyokka_runtime.agent import debug_start
from pyokka_runtime.agent.commands import add_commands
from pyokka_runtime.agent.live import descriptor_kind, list_sessions, pick_session, prefer_kind, substitution_note
from pyokka_runtime.agent.render_debug import render_debug_state
from pyokka_runtime.agent.source import AgentError

APP = "/ws/app.py"


def write_descriptor(directory, name, *, kind="run", file=APP, display=None, launch=None, started="2026-09-15T09:10:00.000Z", pid=None):
    doc = {
        "socket": str(directory / (name + ".sock")),
        "token": "t" * 32,
        "pid": pid or os.getpid(),
        "kind": kind,
        "workspace": "/ws",
        "file": file,
        "displayName": display or os.path.basename(file),
        "runtimeVersion": "0.1.0",
        "started": started,
    }
    if kind == "debug":
        doc["launch"] = launch or {"program": file, "module": None, "args": [], "cwd": "/ws", "python": None, "record": False}
    path = directory / (name + ".json")
    path.write_text(json.dumps(doc), encoding="utf-8")
    return str(path)


@pytest.fixture()
def sessions(tmp_path, monkeypatch):
    directory = tmp_path / "sessions"
    directory.mkdir()
    monkeypatch.setenv("PYOKKA_SESSIONS_DIR", str(directory))
    return directory


def parser():
    p = argparse.ArgumentParser(prog="pyokka")
    add_commands(p.add_subparsers(dest="command", required=True))
    return p


def test_pick_session_prefers_the_debug_descriptor_for_the_debug_verbs(sessions):
    run = write_descriptor(sessions, "1-1", kind="run")
    dbg = write_descriptor(sessions, "1-2", kind="debug")
    listed = list_sessions()
    assert {d["descriptor"] for d in listed} == {run, dbg}
    for verb in ("debug", "continue", "pause", "stop", "restart", "break", "watches", "locals", "exec"):
        chosen = pick_session(listed, prefer=prefer_kind(verb), cwd="/ws")
        assert chosen["descriptor"] == dbg, verb
    # step prefers the debug socket only for the moves that execute
    assert pick_session(listed, prefer=prefer_kind("step", "over"), cwd="/ws")["descriptor"] == dbg
    assert pick_session(listed, prefer=prefer_kind("step", "back"), cwd="/ws")["descriptor"] == run


def test_pick_session_prefers_the_run_descriptor_for_the_recording_verbs(sessions):
    run = write_descriptor(sessions, "1-1", kind="run")
    write_descriptor(sessions, "1-2", kind="debug")
    listed = list_sessions()
    for verb in ("why", "var", "walkthrough", "graph", "exceptions", "http", "values", "story", "find", "steps"):
        assert pick_session(listed, prefer=prefer_kind(verb), cwd="/ws")["descriptor"] == run, verb


def test_pick_session_prefers_the_debug_descriptor_for_the_verbs_that_fit_either(sessions):
    write_descriptor(sessions, "1-1", kind="run")
    dbg = write_descriptor(sessions, "1-2", kind="debug")
    listed = list_sessions()
    for verb in ("state", "context", "eval", "expand", "select", "watch", "shell"):
        assert pick_session(listed, prefer=prefer_kind(verb), cwd="/ws")["descriptor"] == dbg, verb


def test_pick_session_falls_back_when_the_preferred_kind_is_absent(sessions):
    run = write_descriptor(sessions, "1-1", kind="run")
    assert pick_session(list_sessions(), prefer="debug", cwd="/ws")["descriptor"] == run
    os.remove(run)
    dbg = write_descriptor(sessions, "1-2", kind="debug")
    assert pick_session(list_sessions(), prefer="run", cwd="/ws")["descriptor"] == dbg


def test_a_substituted_session_says_which_kind_was_wanted(sessions):
    """A debug verb served by a run session used to fail with the run session's own message.

    The only way to see that a different product had answered was to read `~/.pyokka/sessions` by
    hand, which is how an afternoon goes missing.
    """
    write_descriptor(sessions, "1-1", kind="run", file=APP, display="app.py")
    chosen = pick_session(list_sessions(), prefer="debug", cwd="/ws")
    note = substitution_note(chosen)
    assert note is not None
    assert "no debug session here" in note and "app.py" in note and "pyokka debug FILE" in note


def test_a_recording_verb_served_by_a_debug_session_says_so_too(sessions):
    write_descriptor(sessions, "1-1", kind="debug", file=APP, display="app.py")
    note = substitution_note(pick_session(list_sessions(), prefer="run", cwd="/ws"))
    assert note is not None and "no recording here" in note and "--record" in note


def test_the_session_a_verb_asked_for_carries_no_note(sessions):
    write_descriptor(sessions, "1-1", kind="run")
    write_descriptor(sessions, "1-2", kind="debug")
    listed = list_sessions()
    assert substitution_note(pick_session(listed, prefer="debug", cwd="/ws")) is None
    assert substitution_note(pick_session(listed, prefer="run", cwd="/ws")) is None
    # naming a descriptor outright is a choice, not a substitution, so it stays quiet
    run = [d for d in listed if d["kind"] == "run"][0]["descriptor"]
    assert substitution_note(pick_session(listed, session=run, prefer="debug", cwd="/ws")) is None


def test_pick_session_treats_a_descriptor_without_a_kind_as_a_run(sessions):
    # an older extension wrote no `kind`: it is a run-all session, and a debug verb still uses it
    path = sessions / "1-1.json"
    path.write_text(json.dumps({"socket": "/s", "token": "t", "pid": os.getpid(), "workspace": "/ws", "file": APP, "displayName": "app.py"}), encoding="utf-8")
    assert pick_session(list_sessions(), prefer="run", cwd="/ws")["descriptor"] == str(path)
    assert pick_session(list_sessions(), prefer="debug", cwd="/ws")["descriptor"] == str(path)


def test_pick_session_descriptor_path_wins_over_the_preference(sessions):
    run = write_descriptor(sessions, "1-1", kind="run")
    write_descriptor(sessions, "1-2", kind="debug")
    chosen = pick_session(list_sessions(), session=run, prefer="debug", cwd="/ws")
    assert chosen["descriptor"] == run


def test_pick_session_reports_two_of_the_same_kind(sessions):
    a = write_descriptor(sessions, "1-1", kind="debug", started="2026-09-15T09:10:00.000Z")
    b = write_descriptor(sessions, "1-2", kind="debug", started="2026-09-15T09:11:00.000Z")
    with pytest.raises(AgentError) as exc:
        pick_session(list_sessions(), prefer="debug", cwd="/ws")
    assert "2 live sessions" in exc.value.message
    assert a in exc.value.hint and b in exc.value.hint


def test_pick_session_narrows_by_name_then_prefers(sessions):
    write_descriptor(sessions, "1-1", kind="run", file="/ws/other.py", display="other.py")
    dbg = write_descriptor(sessions, "1-2", kind="debug")
    write_descriptor(sessions, "1-3", kind="run")
    assert pick_session(list_sessions(), session="app.py", prefer="debug", cwd="/ws")["descriptor"] == dbg


def test_state_lists_both_kinds_debug_first():
    reply = {
        "kind": "debug",
        "running": True,
        "paused": True,
        "record": False,
        "modified": False,
        "displayName": "app.py",
        "file": APP,
        "launch": {"program": APP, "module": None, "args": ["--port", "8000"], "cwd": "/ws", "env": {}, "python": "/ws/.venv/bin/python", "record": False},
        "debug": {"active": True, "paused": {"file": APP, "line": 42, "reason": "breakpoint"}, "frontier": None, "exceptions": "uncaught"},
        "output": {"text": "listening on 8000\n", "truncated": False},
        "others": [{"kind": "run", "displayName": "app.py", "descriptor": "/s/4711-1.json", "running": False, "steps": 1240}],
    }

    class Source:
        def display_path(self, path):
            return str(path or "").replace("/ws/", "")

    lines = render_debug_state(reply, Source(), argparse.Namespace(scope=False))
    assert lines[0].startswith("debug  app.py")
    assert "[this]" in lines[0]
    assert lines[1].startswith("run    app.py")
    assert "finished, 1240 steps" in lines[1]
    body = "\n".join(lines)
    assert "paused at app.py:42 (breakpoint)" in body
    assert "launch: /ws/.venv/bin/python /ws/app.py --port 8000   (cwd /ws)" in body
    assert "record: off" in body
    assert "exceptions: uncaught" in body
    assert "listening on 8000" in body


def test_debug_start_builds_the_uri():
    launch = debug_start.build_launch(program=APP, args=["--port", "8000"], cwd="/ws", env={"PORT": "8000"}, python="/ws/.venv/bin/python", stop_on_entry=True)
    uri = debug_start.build_uri(launch, "app.py:42")
    assert uri.startswith("vscode://ivor.pyokka/debug?")
    query = uri.split("?", 1)[1]
    assert "program=%2Fws%2Fapp.py" in query
    assert "args=%5B%22--port%22%2C%228000%22%5D" in query
    assert "env=%7B%22PORT%22%3A%228000%22%7D" in query
    assert "stopOnEntry=1" in query
    assert "at=app.py%3A42" in query
    # the flags that are off are absent, not `0`
    plain = debug_start.build_uri(debug_start.build_launch(program=APP, cwd="/ws"))
    assert "stopOnEntry" not in plain and "record" not in plain and "libraryCode" not in plain
    assert "args" not in plain and "env" not in plain


def test_parse_at_reads_a_line_and_a_function_name():
    assert debug_start.parse_at("app.py:42") == {"file": "app.py", "line": 42}
    # a bare name and a qualified method are function breakpoints the runtime resolves
    assert debug_start.parse_at("rrf") == {"function": "rrf"}
    assert debug_start.parse_at("Ranker.rank") == {"function": "Ranker.rank"}
    assert debug_start.parse_at("  rrf  ") == {"function": "rrf"}
    for junk in ("app.py:0", "app.py:x", "9lives", ""):
        with pytest.raises(AgentError) as exc:
            debug_start.parse_at(junk)
        assert debug_start.AT_UNREADABLE in exc.value.message


def test_debug_start_needs_a_program_or_a_module():
    with pytest.raises(AgentError) as exc:
        debug_start.build_launch()
    assert "--module" in exc.value.message
    with pytest.raises(AgentError):
        debug_start.build_launch(program=APP, module="app.server")


def stub_code(tmp_path, record):
    """A `code` stand-in that writes the URI it was given to `record` and exits 0."""
    script = tmp_path / "code-stub"
    script.write_text('#!/bin/sh\nprintf "%s" "$2" > "%s"\n' % ("$2", record), encoding="utf-8")
    script.chmod(0o755)
    return str(script)


def test_debug_start_polls_and_connects(sessions, tmp_path, monkeypatch):
    record = tmp_path / "uri.txt"
    monkeypatch.setenv("PYOKKA_CODE", stub_code(tmp_path, record))
    launch = debug_start.build_launch(program=APP, cwd="/ws")

    def later():
        time.sleep(0.3)
        write_descriptor(sessions, "1-9", kind="debug", started=time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 1)) + ".000Z")

    thread = threading.Thread(target=later)
    thread.start()
    try:
        found = debug_start.start_via_uri(launch, timeout=10.0)
    finally:
        thread.join()
    assert found["kind"] == "debug"
    assert found["file"] == APP
    assert record.read_text().startswith("vscode://ivor.pyokka/debug?")


def test_debug_start_ignores_a_descriptor_that_is_older_than_the_request(sessions):
    write_descriptor(sessions, "1-1", kind="debug", started="2020-01-01T00:00:00.000Z")
    launch = debug_start.build_launch(program=APP, cwd="/ws")
    assert debug_start.find_debug_descriptor(launch) is not None
    assert debug_start.find_debug_descriptor(launch, since=time.time()) is None


def test_debug_start_times_out_with_the_agent_access_hint(sessions, monkeypatch):
    monkeypatch.setenv("PYOKKA_CODE", "/usr/bin/true")
    launch = debug_start.build_launch(program=APP, cwd="/ws")
    with pytest.raises(AgentError) as exc:
        debug_start.start_via_uri(launch, timeout=1.0)
    assert "did not start a debug session for app.py" in exc.value.message
    # the URI confirmation VS Code shows the first time is the one cause nothing in the terminal reveals
    assert exc.value.hint.startswith("look at the VS Code window first")
    assert "extensions.confirmedUriHandlerExtensionIds" in exc.value.hint
    assert "`pyokka state --live` is the next command" in exc.value.hint
    assert "check `pyokka.agentAccess`" in exc.value.hint
    assert "focused window" in exc.value.hint


def test_debug_start_without_code_says_how_to_install_it(monkeypatch):
    monkeypatch.delenv("PYOKKA_CODE", raising=False)
    monkeypatch.setenv("PATH", "/nonexistent")
    with pytest.raises(AgentError) as exc:
        debug_start.code_command()
    assert exc.value.message == debug_start.CODE_MISSING
    assert "Shell Command: Install code command in PATH" in exc.value.hint
    assert "PYOKKA_CODE" in exc.value.hint


def test_debug_start_prefers_a_run_socket_over_the_uri(sessions, tmp_path, monkeypatch):
    record = tmp_path / "uri.txt"
    monkeypatch.setenv("PYOKKA_CODE", stub_code(tmp_path, record))
    run = write_descriptor(sessions, "1-1", kind="run")
    launch = debug_start.build_launch(program=APP, cwd="/ws")
    route, descriptor = debug_start.build_route(launch)
    assert route == "run"
    assert descriptor["descriptor"] == run
    assert not record.exists()


def test_debug_start_prefers_a_matching_debug_socket_over_everything(sessions):
    write_descriptor(sessions, "1-1", kind="run")
    dbg = write_descriptor(sessions, "1-2", kind="debug")
    launch = debug_start.build_launch(program=APP, cwd="/ws")
    route, descriptor = debug_start.build_route(launch)
    assert route == "debug"
    assert descriptor["descriptor"] == dbg
    # a module launch matches by its dotted name, not by a file
    module = debug_start.build_launch(module="app.server", cwd="/ws")
    assert debug_start.build_route(module)[0] == "uri"
    write_descriptor(sessions, "1-3", kind="debug", file="/ws/app/server.py", display="-m app.server", launch={"program": None, "module": "app.server", "args": [], "cwd": "/ws", "python": None, "record": False})
    assert debug_start.build_route(module)[0] == "debug"


def test_a_positional_file_or_module_implies_live():
    from pyokka_runtime.agent.commands import is_live

    p = parser()
    assert is_live(p.parse_args(["debug", "app.py"])) is True
    assert is_live(p.parse_args(["debug", "--module", "app.server"])) is True
    assert is_live(p.parse_args(["debug", "--live"])) is True
    # `debug` with nothing at all is not live: `open_source` refuses it with the --live hint
    assert is_live(p.parse_args(["debug"])) is False


def test_debug_takes_args_cwd_env_python_and_at():
    from pyokka_runtime.agent.commands import debug_launch

    args = parser().parse_args(["debug", "app.py", "--cwd", "/ws", "--env", "PORT=8000", "--env", "DEBUG=1", "--python", "/ws/.venv/bin/python", "--at", "app.py:42", "--args", "--port", "8000"])
    launch = debug_launch(args)
    assert launch["program"] == os.path.abspath("app.py")
    assert launch["args"] == ["--port", "8000"]
    assert launch["env"] == {"PORT": "8000", "DEBUG": "1"}
    assert launch["python"] == "/ws/.venv/bin/python"
    assert launch["cwd"] == "/ws"
    assert launch["record"] is False
    # a bare name for --at is a function breakpoint, and an unreadable one is an error before anything starts
    assert debug_launch(parser().parse_args(["debug", "app.py", "--at", "rrf"]))["program"] == os.path.abspath("app.py")
    with pytest.raises(AgentError):
        debug_launch(parser().parse_args(["debug", "app.py", "--at", "9lives"]))
    # --record asks the host for a recording run; a module launch has none
    assert debug_launch(parser().parse_args(["debug", "app.py", "--record"]))["record"] is True
    # --library-code steps into third-party packages; off by default, and it reaches the URI
    assert launch["libraryCode"] is False
    with_lib = debug_launch(parser().parse_args(["debug", "app.py", "--library-code"]))
    assert with_lib["libraryCode"] is True
    assert "libraryCode=1" in debug_start.build_uri(with_lib)
    assert "libraryCode" not in debug_start.build_uri(launch)
    with pytest.raises(AgentError) as exc:
        debug_launch(parser().parse_args(["debug", "--module", "app.server", "--record"]))
    assert "--record" in exc.value.message and "module" in exc.value.message


def test_debug_env_wants_key_value():
    from pyokka_runtime.agent.commands import debug_launch

    with pytest.raises(AgentError) as exc:
        debug_launch(parser().parse_args(["debug", "app.py", "--env", "PORT"]))
    assert "--env wants K=V" in exc.value.message


def test_no_wait_and_frame_reach_the_wire():
    from pyokka_runtime.agent.live import LiveRun

    sent = []

    class Fake(LiveRun):
        def __init__(self):
            self.display_name = "app.py"
            self.file = APP
            self.kind = "debug"
            self._stale = False

        def request(self, msg):
            sent.append(msg)
            return {"ok": True}

    live = Fake()
    live.continue_(no_wait=True)
    live.pause(no_wait=True)
    live.locals(frame=2)
    live.eval("payload", frame=1)
    live.debug(stop_on_entry=True, launch={"program": APP})
    assert sent == [
        {"type": "continue", "noWait": True},
        {"type": "pause", "noWait": True},
        {"type": "locals", "frameId": 2},
        {"type": "eval", "expression": "payload", "frameId": 1},
        {"type": "debug", "stopOnEntry": True, "launch": {"program": APP}},
    ]
    # the flags are absent when they are not asked for
    sent.clear()
    live.continue_()
    live.pause()
    live.locals()
    assert sent == [{"type": "continue"}, {"type": "pause"}, {"type": "locals"}]


def fake_live(replies=None):
    """A ``LiveRun`` whose requests are recorded and whose replies are canned, per request type."""
    from pyokka_runtime.agent.live import LiveRun

    sent: list[dict] = []
    canned = dict(replies or {})

    class Fake(LiveRun):
        def __init__(self):
            self.display_name = "app.py"
            self.file = APP
            self.workspace_root = "/ws"
            self.kind = "debug"
            self._stale = False

        def request(self, msg):
            sent.append(msg)
            return dict(canned.get(msg["type"], {"ok": True}))

    return Fake(), sent


def test_exec_sends_the_source_and_the_frame():
    live, sent = fake_live({"exec": {"text": "3", "modified": True, "valueBag": {"data": {"type": "number", "value": "3"}}}})
    out = live.exec("x = 3")
    assert sent == [{"type": "exec", "source": "x = 3"}]
    assert out == {"source": "x = 3", "text": "3", "modified": True, "valueBag": {"data": {"type": "number", "value": "3"}}, "exception": None}
    sent.clear()
    live.exec("items.pop()", frame=2)
    assert sent == [{"type": "exec", "source": "items.pop()", "frameId": 2}]


def test_exec_that_raised_asks_where_the_program_still_is():
    replies = {
        "exec": {"text": "", "modified": True, "exception": {"type": "ZeroDivisionError", "message": "division by zero"}},
        "state": {"debug": {"paused": {"file": "/ws/app.py", "line": 42}}},
    }
    live, sent = fake_live(replies)
    out = live.exec("1/0")
    assert [m["type"] for m in sent] == ["exec", "state"]
    assert out["exception"]["type"] == "ZeroDivisionError"
    assert out["location"] == {"file": "/ws/app.py", "line": 42}


def test_continue_until_and_to_build_their_requests():
    live, sent = fake_live()
    live.continue_(until="rank == 3")
    live.continue_(to=("app.py", 82))
    assert sent == [
        {"type": "continue", "until": "rank == 3"},
        {"type": "continue", "to": {"file": "app.py", "line": 82}},
    ]


def test_step_count_and_break_at_build_their_requests():
    live, sent = fake_live()
    live.step(kind="over", count=3)
    live.step(kind="over", count=1)  # one step needs no count on the wire
    live.breakpoints(at="rrf")
    assert sent == [
        {"type": "step", "kind": "over", "count": 3},
        {"type": "step", "kind": "over"},
        {"type": "break", "at": "rrf"},
    ]


def test_exec_text_forms():
    from pyokka_runtime.agent.render_debug import exec_error, render_debug_exec

    args = parser().parse_args(["exec", "--live", "x = 3"])
    source = type("S", (), {"display_path": staticmethod(lambda p: os.path.basename(str(p)))})()
    # a value prints as its repr, a statement prints `ok`
    assert render_debug_exec({"text": "'last'", "modified": True}, source, args)[0] == "'last'"
    assert render_debug_exec({"text": "", "modified": True}, source, args)[0] == "ok"
    assert "values modified from the console" in render_debug_exec({"text": "", "modified": True}, source, args)[1]
    assert render_debug_exec({"text": "", "modified": False}, source, args) == ["ok"]
    # a statement that raised: the error goes on stderr, stdout says where the program still is
    raised = {"text": "", "modified": True, "exception": {"type": "ZeroDivisionError", "message": "division by zero"}, "location": {"file": "/ws/app.py", "line": 42}}
    assert exec_error(raised) == "ZeroDivisionError: division by zero"
    assert render_debug_exec(raised, source, args) == ["still paused at app.py:42"]
    assert exec_error({"text": "3", "modified": True}) is None


def test_stop_text_says_the_values_were_modified_and_how_a_count_ended():
    from pyokka_runtime.agent.render_debug import render_debug_stop

    args = parser().parse_args(["step", "--live", "--over", "--count", "3"])
    source = type("S", (), {"display_path": staticmethod(lambda p: os.path.basename(str(p)))})()
    stop = {"location": {"file": "/ws/app.py", "line": 42}, "paused": {"reason": "breakpoint"}, "modified": True, "stoppedEarly": {"after": 2, "reason": "breakpoint"}}
    lines = render_debug_stop(stop, source, args)
    assert lines[0] == "paused at app.py:42 (breakpoint) (values modified from the console)"
    assert lines[1] == "stopped early after 2 steps: breakpoint"
    # the program ended mid-count: how many steps were taken before it did
    ended = render_debug_stop({"finished": {"exitCode": 0, "stepCount": 1403}, "stepped": 2}, source, args)
    assert ended == ["finished: exit 0, 1403 steps", "2 steps were taken before it ended"]


def test_stop_text_folds_the_library_frames_and_keeps_both_ends_of_the_chain():
    """A chain that went through a library says so, and a deep one keeps the frame it started in."""
    from pyokka_runtime.agent.render_debug import render_debug_stop

    args = parser().parse_args(["step", "--live", "--over"])
    source = type("S", (), {"display_path": staticmethod(lambda p: os.path.basename(str(p)))})()
    stop = {
        "location": {"file": "/ws/app.py", "line": 42},
        "paused": {"reason": "step"},
        "stack": [
            {"file": "/ws/app.py", "line": 42, "function": "do_GET", "frameId": 0},
            {"elided": 3, "where": "library", "in": ["httpx/_client.py", "openai/_base_client.py"]},
            {"file": "/ws/app.py", "line": 9, "function": "<module>", "frameId": 4},
        ],
    }
    stack = [l for l in render_debug_stop(stop, source, args) if l.startswith("stack:")][0]
    assert "do_GET app.py:42" in stack
    assert "\u2026 3 library frames in httpx/_client.py, openai/_base_client.py \u2026" in stack
    assert stack.endswith("<module> app.py:9")
    # a chain longer than the cap keeps the outermost frame: where the program was started
    deep = dict(stop, stack=[{"file": "/ws/app.py", "line": i + 1, "function": "f%d" % i, "frameId": i} for i in range(20)])
    line = [l for l in render_debug_stop(deep, source, args) if l.startswith("stack:")][0]
    assert "f0 app.py:1" in line
    assert "\u2026 13 frames \u2026" in line
    assert line.endswith("f19 app.py:20")


def test_stop_text_says_what_the_step_printed_rather_than_the_whole_tail():
    """The delta, with what is behind it counted; silence says so instead of printing nothing."""
    from pyokka_runtime.agent.render_debug import render_debug_stop

    args = parser().parse_args(["step", "--live", "--over"])
    source = type("S", (), {"display_path": staticmethod(lambda p: os.path.basename(str(p)))})()
    base = {"location": {"file": "/ws/app.py", "line": 42}, "paused": {"reason": "step"}}
    new = render_debug_stop(dict(base, output={"text": "served /\nserved /x\n", "since": "stop", "lines": 2, "earlier": 412, "truncated": False}), source, args)
    assert "output (2 new lines; 412 earlier):" in new
    assert "  served /x" in new
    # the step printed nothing: an agent needs to be told that, not left to guess
    quiet = render_debug_stop(dict(base, output={"text": "", "since": "stop", "lines": 0, "earlier": 412, "truncated": False}), source, args)
    assert "output: nothing new since the last stop (412 lines earlier; --scope for the window)" in quiet
    # the whole window (the first stop, or --scope) still reads as the tail it is
    whole = render_debug_stop(dict(base, output={"text": "listening on 8000\n", "since": "start", "lines": 1, "earlier": 0, "truncated": False}), source, args)
    assert "output (last 1 line):" in whole


def test_stop_block_counts_the_lines_in_every_gap_the_cut_left():
    """A cut block shows the signature and the suite; each jump says how much is between them."""
    from pyokka_runtime.agent.render_debug import render_debug_stop

    args = parser().parse_args(["step", "--live", "--over"])
    source = type("S", (), {"display_path": staticmethod(lambda p: os.path.basename(str(p)))})()
    stop = {
        "location": {"file": "/ws/app.py", "line": 302},
        "paused": {"reason": "step"},
        "block": {
            "file": "/ws/app.py",
            "function": "big",
            "capped": True,
            "totalLines": 400,
            "lines": [
                {"line": 1, "text": "def big(rows):"},
                {"line": 301, "text": "    for r in rows:"},
                {"line": 302, "text": "        step = r", "current": True},
            ],
        },
    }
    lines = render_debug_stop(stop, source, args)
    assert "block big  app.py (3 of 400 lines; --scope for all)" in lines
    assert any(l.strip() == "\u2026 299 lines" for l in lines)
    assert any(l.startswith(">302") for l in lines)


def test_pick_session_prefers_the_debug_descriptor_for_exec(tmp_path, monkeypatch):
    monkeypatch.setenv("PYOKKA_SESSIONS_DIR", str(tmp_path))
    write_descriptor(tmp_path, "run", kind="run")
    write_descriptor(tmp_path, "dbg", kind="debug")
    sessions = list_sessions(str(tmp_path))
    assert prefer_kind("exec") == "debug"
    assert descriptor_kind(pick_session(sessions, file_hint="app.py", prefer=prefer_kind("exec"))) == "debug"


def test_state_text_names_the_interpreter_it_has_and_library_stepping_when_on():
    """``state --live``: the launch line, and ``library code: on`` only when it is on."""
    from pyokka_runtime.agent.render_debug import render_debug_state

    args = parser().parse_args(["state", "--live"])
    source = type("S", (), {"display_path": staticmethod(lambda p: os.path.basename(str(p)) if p else "<unknown>")})()
    base = {
        "kind": "debug",
        "displayName": "app.py",
        "file": APP,
        "running": True,
        "paused": False,
        "debug": {"exceptions": "uncaught", "paused": None},
        "launch": {"program": APP, "module": None, "args": ["--port", "8000"], "cwd": "/ws", "python": "/ws/.venv/bin/python", "libraryCode": False, "record": False},
    }
    lines = render_debug_state(base, source, args)
    assert "  launch: /ws/.venv/bin/python /ws/app.py --port 8000   (cwd /ws)" in lines
    assert "  record: off" in lines
    assert not any("library code" in l for l in lines)

    # with library stepping on, one more line; the default off says nothing
    on = dict(base, launch=dict(base["launch"], libraryCode=True))
    assert "  library code: on" in render_debug_state(on, source, args)

    # a launch that names no interpreter prints none rather than guessing `python3`
    bare = dict(base, launch=dict(base["launch"], python=None, args=[]))
    assert "  launch: /ws/app.py   (cwd /ws)" in render_debug_state(bare, source, args)
