"""`pyokka debug` names the session it started, for the `--session` of the commands after it.

An agent started `debug tests/test_routes.py --test NAME`, passed `--session test_routes.py` to
`continue` and got `no live session`: the session was named `-m pytest`, and the first stop never
said so.
"""

from __future__ import annotations

import argparse

from pyokka_runtime.agent.commands import started_session
from pyokka_runtime.agent.render import render

DEBUG = {"kind": "debug", "displayName": "-m pytest", "descriptor": "/h/.pyokka/sessions/41-2.json", "file": "/ws/tests"}


class Live:
    workspace_root = "/ws"

    def __init__(self, descriptor):
        self.descriptor = descriptor

    def display_path(self, path):
        return path[len("/ws/"):] if path and path.startswith("/ws/") else path


def test_a_test_start_is_named_by_its_test_file_with_the_exact_descriptor():
    args = argparse.Namespace(program="tests/test_routes.py", module=None)
    assert started_session(args, Live(DEBUG)) == {"name": "test_routes.py", "descriptor": "/h/.pyokka/sessions/41-2.json"}


def test_a_module_start_through_a_run_socket_names_no_descriptor():
    # the run session's socket relayed the launch: its descriptor is not the debug session's
    run = {"kind": "run", "displayName": "app.py", "descriptor": "/h/.pyokka/sessions/41-1.json"}
    assert started_session(argparse.Namespace(program=None, module="app.server"), Live(run)) == {"name": "-m app.server"}


def test_a_configuration_start_takes_the_descriptors_own_name():
    args = argparse.Namespace(program=None, module=None)
    assert started_session(args, Live({**DEBUG, "displayName": "Server"})) == {"name": "Server", "descriptor": DEBUG["descriptor"]}


def test_the_first_stop_ends_with_the_session_line_quoted_for_a_shell():
    result = {"kind": "debug", "paused": {"file": "/ws/tests/test_routes.py", "line": 3, "reason": "breakpoint"}, "location": {"file": "/ws/tests/test_routes.py", "line": 3}, "session": {"name": "-m pytest", "descriptor": "/h/s.json"}}
    lines = render("debug", result, Live(DEBUG), argparse.Namespace()).splitlines()
    assert lines[0].startswith("paused at tests/test_routes.py:3")
    assert lines[-1] == "session: pass --session '-m pytest' to the commands that follow (exactly this one: --session /h/s.json)"
    # continue's stop carries no session, so it prints none
    del result["session"]
    assert not render("continue", result, Live(DEBUG), argparse.Namespace()).splitlines()[-1].startswith("session:")


def test_a_plain_debug_stop_does_not_speak_of_a_record_from_it_never_had():
    """Every `record: false` stop said `the recording starts at the --record-from pause`, with or without --record-from."""
    result = {"kind": "debug", "recording": False, "paused": {"file": "/ws/app.py", "line": 3, "reason": "breakpoint"}, "location": {"file": "/ws/app.py", "line": 3}}
    line = render("continue", result, Live(DEBUG), argparse.Namespace()).splitlines()[1]
    assert line == "not recording yet: nothing before this pause was kept; `record --live` records from here (a `--record-from` run starts by itself at its pause)"
