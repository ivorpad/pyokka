"""What `pyokka debug` makes of its start fields before anything opens.

Two things an agent sends that the launch grammar did not foresee. ``--test tests/test_x.py::test_b``
with no FILE: the review's ``--test`` takes that ``FILE::NAME`` form, an agent carries it over, and
the node id names the file, so it is the program. And fields that say how to run something with
nothing that says what (``--test NAME``, ``--cwd``, ``--python``, ``--args``, ``--env``,
``--record-from``, with neither FILE nor ``--module``): a bare ``debug`` drives the session that is
open, so letting these through answered a start with another program's run, a finished recording of
yesterday's test file reported as if the test had just run (the field review of 2026-10-16). Refused
instead, with the form that starts one. ``--stop-on-entry`` and ``--record`` are not in the list: a
bare ``debug --live --stop-on-entry`` restarts the open session's program paused on entry.
"""

from __future__ import annotations

from typing import Any

from .source import AgentError


def test_names_file(args: Any) -> None:
    """``debug --test tests/test_x.py::test_b`` with no FILE: the node id's file becomes the program; ``runner_for`` strips it again."""
    test = getattr(args, "test", None)
    if not test or getattr(args, "program", None) or getattr(args, "module", None):
        return
    head, sep, _ = str(test).partition("::")
    if sep and head.endswith(".py"):
        args.program = head


#: the fields that say how to run something: (attribute, CLI flag)
HOW_TO_RUN = (("test", "--test"), ("cwd", "--cwd"), ("python", "--python"), ("args", "--args"), ("env", "--env"), ("record_from", "--record-from"), ("library_code", "--library-code"))


def start_without_launch(args: Any) -> None:
    """Refuse the fields that say how to run something when nothing says what: no FILE, no ``--module``, no ``--configuration``."""
    if getattr(args, "program", None) or getattr(args, "module", None) or getattr(args, "configuration", None):
        return
    given = [flag for attr, flag in HOW_TO_RUN if getattr(args, attr, None)]
    if not given:
        return
    raise AgentError(
        "start needs a file or --module (MCP: file or module): %s say%s how to run it, not what" % (", ".join(given), "s" if len(given) == 1 else ""),
        'e.g. `pyokka debug tests/test_x.py --test test_name` (MCP: pyokka_debug {"action": "start", "file": "tests/test_x.py", "test": "test_name"}); '
        "a `debug` with neither prints the current pause and starts nothing",
    )


__all__ = ["HOW_TO_RUN", "start_without_launch", "test_names_file"]
