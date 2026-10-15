"""MCP ``pyokka_run`` mode/auto_log/cwd and ``pyokka_map`` graph expand/no_statements/dot reach the run and the parser."""

from __future__ import annotations

import os
from pathlib import Path

from pyokka_runtime.agent import save as save_mod
from pyokka_runtime.agent.mcp import call_tool, words_map
from pyokka_runtime.agent.shell import build_parser


def test_graph_arguments_become_the_graph_flags():
    words = words_map({"action": "graph", "run": "r.json", "expand": ["requests", "httpx"], "no_statements": True, "dot": True})
    args = build_parser().parse_args(words)
    assert args.command == "graph" and args.run == "r.json"
    assert args.expand == ["requests", "httpx"]
    assert args.statements is False and args.dot is True
    plain = build_parser().parse_args(words_map({"action": "graph", "run": "r.json"}))
    assert plain.expand == [] and plain.statements is True and plain.dot is False


def test_run_passes_mode_auto_log_and_cwd(tmp_path: Path, monkeypatch):
    (tmp_path / "work").mkdir()
    (tmp_path / "app.py").write_text("x = 1\n")
    seen: dict = {}

    def fake_save_run(file, out, **kw):
        seen.update(kw)
        return {"exitCode": 0}

    monkeypatch.setattr(save_mod, "save_run", fake_save_run)
    result = call_tool("pyokka_run", {"file": str(tmp_path / "app.py"), "save": str(tmp_path / "r.json"), "mode": "snaps", "auto_log": True, "cwd": str(tmp_path / "work")})
    assert not result["isError"], result["content"][0]["text"]
    assert seen["mode"] == "snaps" and seen["auto_log"] is True and seen["cwd"] == str(tmp_path / "work")

    bad = call_tool("pyokka_run", {"file": str(tmp_path / "app.py"), "cwd": str(tmp_path / "nope")})
    assert bad["isError"] and "no directory" in bad["content"][0]["text"]
    bad = call_tool("pyokka_run", {"file": str(tmp_path / "app.py"), "mode": "fast"})
    assert bad["isError"] and "unknown mode" in bad["content"][0]["text"]


def test_profile_mode_reaches_the_runner_and_names_the_profile(tmp_path: Path):
    """`save_run` used to send mode normal whatever was asked, so a profile run recorded steps."""
    (tmp_path / "app.py").write_text("def f(n):\n    return sum(range(n))\n\nprint(f(1000))\n")
    result = call_tool("pyokka_run", {"file": str(tmp_path / "app.py"), "save": str(tmp_path / "r.json"), "mode": "profile"})
    text = result["content"][0]["text"]
    assert not result["isError"], text
    assert "profiled, no steps recorded" in text
    path = next(l.split("profile: ", 1)[1] for l in text.splitlines() if l.startswith("profile: "))
    try:
        assert os.path.isfile(path) and path.endswith(".cpuprofile")
    finally:
        if os.path.isfile(path):
            os.unlink(path)
