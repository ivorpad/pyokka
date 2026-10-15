"""MCP ``configuration``, ``test``, ``scope``, ``names_only`` and ``names``: the words reach the real parser and the launch."""

from __future__ import annotations

from pathlib import Path

import pytest

from pyokka_runtime.agent import save as save_mod
from pyokka_runtime.agent.commands import debug_launch
from pyokka_runtime.agent.mcp import ToolError, call_tool, words_debug
from pyokka_runtime.agent.shell import build_parser

LAUNCH = '{"configurations": [{"type": "debugpy", "request": "launch", "name": "App", "program": "${workspaceFolder}/app.py", "args": ["--n", "2"]}]}'


def parse(words):
    return build_parser().parse_args(words)


def test_start_with_a_configuration_and_no_file(tmp_path: Path, monkeypatch):
    root = tmp_path.resolve()
    (root / ".vscode").mkdir()
    (root / ".vscode" / "launch.json").write_text(LAUNCH)
    (root / "app.py").write_text("pass\n")
    monkeypatch.chdir(root)
    launch = debug_launch(parse(words_debug({"action": "start", "configuration": "App", "at": ["main"]})))
    assert launch["program"] == str(root / "app.py") and launch["args"] == ["--n", "2"]


def test_start_with_a_test_name(tmp_path: Path):
    f = tmp_path / "test_x.py"
    f.write_text("def test_b():\n    pass\n")
    launch = debug_launch(parse(words_debug({"action": "start", "file": str(f), "test": "test_b"})))
    assert launch["module"] == "pytest" and launch["args"][0] == "%s::test_b" % f


def test_locals_scope_names_only_and_names():
    args = parse(words_debug({"action": "locals", "scope": "global", "names_only": True, "names": ["total", "items"]}))
    assert (args.scope, args.names_only, args.name) == ("global", True, ["total", "items"])
    with pytest.raises(ToolError, match="unknown scope"):
        words_debug({"action": "locals", "scope": "everything"})
    with pytest.raises(ToolError, match="names must be"):
        words_debug({"action": "locals", "names": []})


def test_run_passes_test(tmp_path: Path, monkeypatch):
    (tmp_path / "test_x.py").write_text("def test_b():\n    pass\n")
    seen: dict = {}
    monkeypatch.setattr(save_mod, "save_run", lambda file, out, **kw: seen.update(kw) or {"exitCode": 0})
    result = call_tool("pyokka_run", {"file": str(tmp_path / "test_x.py"), "save": str(tmp_path / "r.json"), "test": "test_b"})
    assert not result["isError"], result["content"][0]["text"]
    assert seen["test"] == "test_b"
