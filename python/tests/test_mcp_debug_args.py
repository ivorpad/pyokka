"""``pyokka_debug start`` with ``args``: the words reach the real parser and the launch carries them.

Also ``whole_block`` on ``continue`` and ``pause``, and ``text_len`` on ``locals`` and a live ``eval``."""

from __future__ import annotations

from pyokka_runtime.agent.commands import debug_launch
from pyokka_runtime.agent.mcp import words_debug, words_value
from pyokka_runtime.agent.shell import build_parser


def parse(words):
    return build_parser().parse_args(words)


def test_start_with_args_parses_and_the_program_gets_them(tmp_path):
    app = tmp_path / "app.py"
    app.write_text("import sys\nprint(sys.argv[1:])\n")
    words = words_debug({"action": "start", "file": str(app), "at": ["main"], "args": ["-x", "1"]})
    args = parse(words)
    assert args.program == str(app)
    launch = debug_launch(args)
    assert launch["program"] == str(app)
    assert launch["args"] == ["-x", "1"]


def test_args_that_look_like_flags_stay_the_programs(tmp_path):
    app = tmp_path / "app.py"
    app.write_text("pass\n")
    args = parse(words_debug({"action": "start", "file": str(app), "args": ["--country", "de"]}))
    assert debug_launch(args)["args"] == ["--country", "de"]


def test_a_file_named_like_a_flag_is_still_the_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "-odd.py").write_text("pass\n")
    args = parse(words_debug({"action": "start", "file": "-odd.py", "args": ["y"]}))
    launch = debug_launch(args)
    assert launch["program"] == str(tmp_path / "-odd.py")
    assert launch["args"] == ["y"]


def test_start_without_args_still_parses(tmp_path):
    app = tmp_path / "app.py"
    app.write_text("pass\n")
    args = parse(words_debug({"action": "start", "file": str(app)}))
    assert debug_launch(args)["args"] == []


def test_whole_block_is_scope_on_continue_and_pause_and_nothing_on_status():
    for action in ("continue", "pause"):
        words = words_debug({"action": action, "whole_block": True})
        assert "--scope" in words and parse(words).scope is True, action
        assert parse(words_debug({"action": action})).scope is False, action
    # status prints the state, which carries no block: the whole block at a pause is pyokka_step's
    assert "--scope" not in words_debug({"action": "status", "whole_block": True})


def test_text_len_reaches_locals_and_a_live_eval():
    args = parse(words_debug({"action": "locals", "names": ["policy"], "text_len": 5000}))
    assert (args.name, args.text_len) == (["policy"], 5000)
    assert parse(words_debug({"action": "locals", "text_len": 0})).text_len == 0, "0 asks for all of it"
    assert parse(words_debug({"action": "locals"})).text_len is None, "unset: the commands send their 2,000"
    args = parse(words_value({"action": "eval", "live": True, "expression": "policy", "text_len": 4000}))
    assert (args.expression, args.text_len, args.live) == ("policy", 4000, True)
