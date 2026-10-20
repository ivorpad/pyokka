"""`pyokka debug` start fields without a launch, and the line a run that never paused gets (debug_fields.py, render_debug.py).

The field review of 2026-10-16: `pyokka_debug {action: start, test: "tests/x.py::test_b", cwd, python}` with no `file` went
down the read-the-current-pause path and answered with a finished recording of another file, `finished: exit 0, 217 steps`,
as if the test had just run; and a pytest module launch that hit no breakpoint answered `finished: exit 0, 0 steps` with no
word on why there was no stop.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from pyokka_runtime.__main__ import build_parser
from pyokka_runtime.agent.commands import debug_launch
from pyokka_runtime.agent.debug_fields import start_without_launch
from pyokka_runtime.agent.debug_fields import test_names_file as file_from_test  # not a test, whatever its name says
from pyokka_runtime.agent.mcp import words_debug
from pyokka_runtime.agent.render import render_stop
from pyokka_runtime.agent.render_debug import UNSEEN_RUN
from pyokka_runtime.agent.source import AgentError


def _parse(*words: str):
    return build_parser().parse_args(["debug", *words])


def test_a_test_node_id_with_no_file_names_the_file(tmp_path):
    test_file = tmp_path / "tests" / "test_x.py"
    test_file.parent.mkdir()
    test_file.write_text("def test_b():\n    assert 1\n")
    words = words_debug({"action": "start", "test": "%s::test_b" % test_file, "cwd": str(tmp_path)})
    assert any(w.startswith("--test=") for w in words) and str(test_file) not in words  # the MCP words carry the node id and no file
    args = build_parser().parse_args(words)
    assert args.program is None
    file_from_test(args)
    assert args.program == str(test_file)
    launch = debug_launch(args)
    assert launch["module"] == "pytest" and launch["cwd"] == str(tmp_path)
    assert any(a.endswith("test_x.py::test_b") for a in launch["args"]), launch["args"]


def test_a_bare_test_name_without_a_file_is_refused():
    args = _parse("--live", "--test", "test_b")
    file_from_test(args)
    assert args.program is None
    with pytest.raises(AgentError) as caught:
        start_without_launch(args)
    assert caught.value.message.startswith("start needs a file or --module (MCP: file or module): --test says how to run it")
    assert "pyokka_debug" in caught.value.hint and '"file": "tests/test_x.py"' in caught.value.hint
    assert "starts nothing" in caught.value.hint


def test_cwd_and_python_without_a_launch_are_refused_together():
    args = _parse("--live", "--cwd", "/w", "--python", "/usr/bin/python3")
    with pytest.raises(AgentError) as caught:
        start_without_launch(args)
    assert "--cwd, --python say how to run it, not what" in caught.value.message


def test_a_plain_debug_or_a_session_alone_still_reads_the_pause():
    start_without_launch(_parse("--live"))  # a bare debug prints the current pause; nothing to refuse
    start_without_launch(_parse("--live", "--session", "demo.py"))
    start_without_launch(_parse("app.py", "--test", "test_b"))  # a file: a launch


def test_stop_on_entry_and_record_ride_on_the_open_session():
    start_without_launch(_parse("--live", "--stop-on-entry"))  # restarts the open session's program paused on entry (test_agent_live)
    start_without_launch(_parse("--live", "--record"))


def test_a_module_launch_with_start_fields_is_a_launch():
    start_without_launch(_parse("--live", "--module", "pytest", "--cwd", "/w"))


def test_a_finished_start_with_nothing_to_pause_it_says_so():
    args = _parse("app.py")
    args._route = "uri"
    lines = render_stop({"finished": {"exitCode": 0, "stepCount": 0}}, None, args)
    assert lines == ["finished: exit 0, 0 steps", UNSEEN_RUN]
    assert UNSEEN_RUN.startswith("no stop: nothing was set to pause it") and "--record" in UNSEEN_RUN


@pytest.mark.parametrize("words", [["app.py", "--at", "main"], ["app.py", "--record"], ["app.py", "--record-from", "main"], ["app.py", "--stop-on-entry"]])
def test_a_finished_start_that_had_a_pause_set_gets_no_note(words):
    args = _parse(*words)
    args._route = "uri"
    assert render_stop({"finished": {"exitCode": 0, "stepCount": 0}}, None, args) == ["finished: exit 0, 0 steps"]


def test_other_verbs_and_a_debug_that_started_nothing_get_no_note():
    assert render_stop({"finished": {"exitCode": 0, "stepCount": 40}}, None, SimpleNamespace(command="continue")) == ["finished: exit 0, 40 steps"]
    assert render_stop({"finished": {"exitCode": 0, "stepCount": 40}}, None, _parse("--live")) == ["finished: exit 0, 40 steps"]  # read the pause, no launch
