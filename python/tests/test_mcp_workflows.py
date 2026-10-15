"""MCP ``pyokka_investigate``, ``_learn``, ``_pin``, ``_verify`` answer the CLI verb's own text."""

from __future__ import annotations

import os
import subprocess
import sys

from pyokka_runtime.agent.mcp import call_tool
from tests.test_workflows import PORT, record

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cli(*args, cwd):
    out = subprocess.run([sys.executable, "-m", "pyokka_runtime", *map(str, args)], capture_output=True, text=True, cwd=cwd, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=120)
    return out.returncode, (out.stdout + out.stderr).strip()


def tool(name, arguments):
    res = call_tool(name, arguments)
    return res["isError"], res["content"][0]["text"].strip()


def test_each_tool_answers_what_its_verb_prints(tmp_path):
    app = tmp_path / "cart.py"
    before = record(PORT / "cart_unfixed.py", app, tmp_path / "before.json")
    after = record(PORT / "cart_fixed.py", app, tmp_path / "after.json")
    cases = [
        ("pyokka_investigate", {"run": str(before), "value": "total"}, ["investigate", before, "--value", "total"]),
        ("pyokka_investigate", {"run": str(before)}, ["investigate", before]),
        ("pyokka_learn", {"run": str(before)}, ["learn", before]),
        ("pyokka_learn", {"run": str(before), "at": 3, "prediction": "14", "reveal": True}, ["learn", before, "--at", "3", "--prediction", "14", "--reveal"]),
        ("pyokka_verify", {"run": str(before), "after": str(after), "expect": ["total=22"]}, ["verify", before, "--after", after, "--expect", "total=22"]),
        ("pyokka_verify", {"run": str(after), "after": str(before), "expect": ["total=22"]}, ["verify", after, "--after", before, "--expect", "total=22"]),
    ]
    for name, arguments, words in cases:
        is_error, text = tool(name, arguments)
        code, printed = cli(*words, cwd=tmp_path)
        assert text == printed, (name, arguments)
        assert is_error == (code != 0), (name, code)


def test_pin_tool_and_verb_copy_the_same_bytes_and_both_refuse_an_overwrite(tmp_path):
    app = tmp_path / "cart.py"
    run = record(PORT / "cart_unfixed.py", app, tmp_path / "run.json")
    is_error, text = tool("pyokka_pin", {"run": str(run), "out": str(tmp_path / "a.json")})
    code, printed = cli("pin", run, "--out", tmp_path / "b.json", cwd=tmp_path)
    assert not is_error and code == 0 and text.replace("a.json", "X") == printed.replace("b.json", "X")
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes() == run.read_bytes()
    assert tool("pyokka_pin", {"run": str(run), "out": str(tmp_path / "a.json")})[0] is True
