"""The Scratchpad's runner: a separate ``python -I`` process, seeds that never approximate, and the network sandbox."""

from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

from pyokka_runtime.protocol import LogLimitSet
from pyokka_runtime.scratchpad import rebuild, run, seed
from pyokka_runtime.serialize import serialize

LIMITS = LogLimitSet(4, 50, 40)


def write_source(tmp_path: Path) -> Path:
    marker = tmp_path / "main-ran"
    src = tmp_path / "prog.py"
    src.write_text(
        "LIMIT = 10\n"
        "STATE = {'calls': 0}\n\n\n"
        "def clamp(x):\n"
        "    STATE['calls'] += 1\n"
        "    return min(x, LIMIT)\n\n\n"
        "if __name__ == '__main__':\n"
        "    open(%r, 'w').write('ran')\n" % str(marker),
        encoding="utf-8",
    )
    return src


def test_experiment_runs_in_a_separate_isolated_process(tmp_path, monkeypatch):
    src = write_source(tmp_path)
    monkeypatch.setenv("PYOKKA_SCRATCH_SECRET", "s3cr3t")
    code = (
        "import os, sys\n"
        "result = (clamp(n), STATE['calls'], os.getpid(), sys.flags.isolated, os.environ.get('PYOKKA_SCRATCH_SECRET'))\n"
    )
    out = run({"file": str(src), "code": code, "inputs": "n = 42\n"})
    assert "error" not in out, out
    clamped, calls, pid, isolated, secret = ast.literal_eval(out["result"])
    assert clamped == 10 and calls == 1
    assert pid != os.getpid()
    assert isolated == 1
    assert secret is None
    # the source's top level was copied, not run: its __main__ block never ran
    assert not (tmp_path / "main-ran").exists()


def test_seed_rebuilds_literals_exactly_and_refuses_the_rest():
    class Point:
        def __init__(self) -> None:
            self.x = 1

    rebuildable = {"n": 3, "f": 2.5, "s": "héllo", "b": b"\x00ab", "items": [("a", 2), ("b", None)], "d": {1: {"k": True}, "z": frozenset({1})}, "e": set()}
    refused = {"p": Point(), "fn": len, "long": "x" * 100, "many": list(range(80)), "inf": float("inf")}
    nodes = {name: serialize(value, LIMITS, root_key=name) for name, value in {**rebuildable, **refused}.items()}
    out = seed(nodes)
    namespace: dict = {}
    for line in out["inputs"].splitlines():
        if line and not line.startswith("#"):
            name, _, text = line.partition(" = ")
            namespace[name] = rebuild(text)
    assert namespace == rebuildable
    assert sorted(out["unavailable"]) == sorted(refused)
    assert "Point object" in out["unavailable"]["p"]
    assert "cut at 40 of 100" in out["unavailable"]["long"]
    assert "80 items and 50 were captured" in out["unavailable"]["many"]


def test_an_unavailable_value_fails_where_it_is_used(tmp_path):
    src = write_source(tmp_path)
    out = run({"file": str(src), "code": "before = 1\nresult = cart.total()\n", "unavailable": {"cart": "cart is a Cart object"}})
    assert out["error"]["type"] == "UnavailableValue"
    assert out["error"]["line"] == 2
    assert out["missing"] == ["cart"]
    assert out["values"][0]["name"] == "before"


def test_the_network_sandbox_refuses_a_connection(tmp_path):
    src = write_source(tmp_path)
    code = "import socket\nresult = socket.create_connection(('1.1.1.1', 80), timeout=3)\n"
    out = run({"file": str(src), "code": code})
    if sys.platform == "darwin":
        assert out["sandbox"]["network"] == "denied"
        assert out["error"]["type"] == "PermissionError", out
    else:
        # no sandbox here, and the result says so rather than claiming one
        assert out["sandbox"]["network"] == "open"
        assert "no network sandbox" in out["sandbox"]["how"]


def test_a_try_except_import_fallback_is_copied_whole(tmp_path):
    # api/main.py's shape: a relative import for `python -m`, a plain one when it runs as a script
    (tmp_path / "ranking.py").write_text("def rrf(xs):\n    return sorted(xs)\n", encoding="utf-8")
    src = tmp_path / "main.py"
    src.write_text(
        "from __future__ import annotations\n\n"
        "try:\n"
        "    from .ranking import rrf\n"
        "except ImportError:\n"
        "    from ranking import rrf\n\n\n"
        "def rank(xs):\n"
        "    return rrf(xs)\n",
        encoding="utf-8",
    )
    out = run({"file": str(src), "code": "result = rank(xs)\n", "inputs": "xs = [3, 1, 2]\n"})
    assert "error" not in out, out
    assert ast.literal_eval(out["result"]) == [1, 2, 3]


def test_mcp_scratchpad_say_carries_its_text_and_line():
    import pytest

    from pyokka_runtime.agent.mcp_page import scratchpad_command
    from pyokka_runtime.agent.source import AgentError

    assert scratchpad_command({"op": "say", "text": "reads the cart", "line": 3}) == {"action": "scratchpad", "op": "say", "line": 3, "text": "reads the cart"}
    # no text clears the bubble
    assert scratchpad_command({"op": "say"}) == {"action": "scratchpad", "op": "say", "text": ""}
    with pytest.raises(AgentError, match="say's text is a string"):
        scratchpad_command({"op": "say", "text": 3})
    with pytest.raises(AgentError, match="scratchpad op is one of"):
        scratchpad_command({"op": "shout"})
