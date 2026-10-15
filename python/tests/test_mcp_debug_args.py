"""``pyokka_debug start`` with ``args``: the words reach the real parser and the launch carries them."""

from __future__ import annotations

from pyokka_runtime.agent.commands import debug_launch
from pyokka_runtime.agent.mcp import words_debug
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
