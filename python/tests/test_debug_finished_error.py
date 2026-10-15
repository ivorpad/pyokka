"""A debug run that ended prints why: ``finished.error`` under ``finished: exit N``."""

from __future__ import annotations

import argparse

from pyokka_runtime.agent.render import render
from pyokka_runtime.agent.render_debug import render_debug_stop


class Src:
    workspace_root = "/ws"

    def display_path(self, path):
        return path[len("/ws/"):] if path and path.startswith("/ws/") else path


ERROR = {"type": "ValueError", "message": "too big: 3", "file": "/ws/raise.py", "line": 4}


def test_finished_with_error_prints_it_under_the_exit():
    lines = render_debug_stop({"finished": {"exitCode": 1, "stepCount": 7, "error": ERROR}}, Src(), argparse.Namespace())
    assert lines == ["finished: exit 1, 7 steps", "error: ValueError: too big: 3 (raise.py:4)"]


def test_finished_without_error_is_the_exit_alone():
    assert render_debug_stop({"finished": {"exitCode": 0, "stepCount": 7}}, Src(), argparse.Namespace()) == ["finished: exit 0, 7 steps"]


def test_continue_prints_the_error():
    for command in ("continue", "debug"):
        text = render(command, {"finished": {"exitCode": 1, "stepCount": 7, "durationMs": 3, "error": ERROR}}, Src(), argparse.Namespace(json=False, scope=False))
        assert text.splitlines()[:2] == ["finished: exit 1, 7 steps", "error: ValueError: too big: 3 (raise.py:4)"], text


def test_stop_prints_the_error_too():
    text = render("stop", {"stopped": True, "finished": {"exitCode": 1, "stepCount": 7, "error": ERROR}}, Src(), argparse.Namespace(json=False, scope=False))
    assert "error: ValueError: too big: 3 (raise.py:4)" in text, text
