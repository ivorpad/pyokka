"""A session started on one test answers to the test's file (``agent/sessions.py``).

``debug FILE --test NAME`` launches ``-m pytest /abs/FILE::NAME``, so the session's name is
``-m pytest``. An agent that started one on tests/test_routes.py passed ``--session
test_routes.py`` to the next ``continue`` and got ``no live session for test_routes.py`` while the
session sat paused.
"""

from __future__ import annotations

import json
import os

import pytest

from pyokka_runtime.agent.live import list_sessions, pick_session
from pyokka_runtime.agent.source import AgentError


@pytest.fixture()
def sessions(tmp_path, monkeypatch):
    directory = tmp_path / "sessions"
    directory.mkdir()
    monkeypatch.setenv("PYOKKA_SESSIONS_DIR", str(directory))
    return directory


def write_debug(directory, name, module, args, file="/ws/tests"):
    """A debug descriptor as the extension writes one for a module launch: ``file`` is the launch's cwd until the run reports its main file."""
    doc = {
        "socket": str(directory / (name + ".sock")),
        "token": "t" * 32,
        "pid": os.getpid(),
        "kind": "debug",
        "workspace": "/ws",
        "file": file,
        "displayName": "-m " + module,
        "launch": {"program": None, "module": module, "args": args, "cwd": "/ws/tests", "python": None, "record": False},
        "runtimeVersion": "0.1.0",
        "started": "2026-10-16T09:37:00.000Z",
    }
    path = directory / (name + ".json")
    path.write_text(json.dumps(doc), encoding="utf-8")
    return str(path)


def pick(name):
    return pick_session(list_sessions(), session=name, prefer="debug", cwd="/ws")["descriptor"]


def test_a_pytest_node_launch_answers_to_its_file_by_any_spelling(sessions):
    dbg = write_debug(sessions, "1-1", "pytest", ["/ws/tests/test_routes.py::test_create", "-q"])
    for name in ("test_routes.py", "tests/test_routes.py", "/ws/tests/test_routes.py", "-m pytest"):
        assert pick(name) == dbg, name


def test_a_keyword_or_unittest_launch_answers_to_its_file_too(sessions):
    k = write_debug(sessions, "1-1", "pytest", ["/ws/tests/test_cart.py", "-k", "total", "-q"])
    u = write_debug(sessions, "1-2", "unittest", ["test_shop.Cart.test_total"])
    assert pick("test_cart.py") == k
    assert pick("test_shop.py") == u


def test_another_file_still_finds_no_session(sessions):
    write_debug(sessions, "1-1", "pytest", ["/ws/tests/test_routes.py::test_create", "-q"])
    for name in ("routes.py", "test_cart.py", "/ws/routes/test_routes.py"):
        with pytest.raises(AgentError) as exc:
            pick(name)
        assert "no live session for %s" % name in exc.value.message
