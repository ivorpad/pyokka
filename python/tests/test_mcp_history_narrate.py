"""MCP ``pyokka_history`` and ``pyokka_narrate`` answer what ``pyokka history`` and ``pyokka narrate`` print."""

from __future__ import annotations

import io
import json
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.mcp import call_tool, handle
from pyokka_runtime.agent.save import save_run

PROGRAM = """\
def add(total, n):
    return total + n

total = 0
for n in [3, 4]:
    total = add(total, n)
print(total)
"""


@pytest.fixture(scope="module")
def run_json(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("hist")
    (d / "prog.py").write_text(PROGRAM, encoding="utf-8")
    save_run(str(d / "prog.py"), str(d / "run.json"))
    return d / "run.json"


def cli(*words: str) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main(list(words))
    assert code == 0, buf.getvalue()
    return buf.getvalue()


def tool(name: str, arguments: dict) -> str:
    result = call_tool(name, arguments)
    assert not result["isError"], result["content"][0]["text"]
    return result["content"][0]["text"]


def test_both_tools_are_listed():
    names = [t["name"] for t in handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]]
    assert "pyokka_history" in names and "pyokka_narrate" in names


def test_history_answers_the_commands_text_and_writes_the_same_page(run_json: Path):
    out = run_json.parent / "history.json"
    expected = cli("history", str(run_json), "--out", str(out), "--var", "total", "--why", "6", "total", "--pad", "1")
    page = json.loads(out.read_text(encoding="utf-8"))
    out.unlink()
    got = tool("pyokka_history", {"run": str(run_json), "out": str(out), "var": ["total"], "why": [{"step": 6, "name": "total"}], "pad": 1})
    assert got == expected
    assert json.loads(out.read_text(encoding="utf-8")) == page


def test_history_needs_a_checkpoint(run_json: Path):
    result = call_tool("pyokka_history", {"run": str(run_json), "out": str(run_json.parent / "h.json")})
    assert result["isError"] and "at least one checkpoint" in result["content"][0]["text"]


def test_narrate_dry_run_answers_the_commands_prompt(run_json: Path):
    expected = cli("narrate", str(run_json), "--dry-run", "--command", "cat")
    # a tool's text ends in one newline (mcp.run_words), the prompt in a blank line
    assert tool("pyokka_narrate", {"run": str(run_json), "dry_run": True, "command": "cat"}) == expected.rstrip() + "\n"
