"""`pyokka mcp`: the stdio JSON-RPC server, driven as a subprocess the way an MCP client drives it.

One server session runs the whole conversation (initialize, tools/list, a recording, the map, a
step, why, coverage, bad calls), and every line it writes to stdout must parse as JSON-RPC, even
though the recorded program prints. The argument-to-words translation of the live debugger tool
is checked without VS Code, since the cloud has none.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from pyokka_runtime.agent import mcp
from pyokka_runtime.agent.shell import build_parser
from pyokka_runtime.agent.mcp_tools import DEBUG_ACTIONS, MAP_ACTIONS, VALUE_ACTIONS, tool_definitions

PY_DIR = Path(__file__).resolve().parents[1]

PROGRAM = """
def sign(n):
    if n < 0:
        return "negative"
    return "positive"

def parse(raw):
    try:
        return int(raw)
    except ValueError:
        return 0

total = 0
for raw in ["3", "x", "4"]:
    total += parse(raw)
    print("running total", total)
print(sign(total))
"""


def _request(id_: int, method: str, params: dict | None = None) -> dict:
    msg = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def _call(id_: int, tool: str, **arguments) -> dict:
    return _request(id_, "tools/call", {"name": tool, "arguments": arguments})


def serve(messages: list, cwd: Path) -> tuple[dict, list[str], str]:
    """Pipe ``messages`` (dicts, or raw strings sent as they are) to one server; ``({id: reply}, stdout lines, stderr)``."""
    lines = [m if isinstance(m, str) else json.dumps(m) for m in messages]
    proc = subprocess.run(
        [sys.executable, "-m", "pyokka_runtime", "mcp"],
        input="\n".join(lines) + "\n", capture_output=True, text=True, cwd=cwd, timeout=120,
        env={**_env(), "PYTHONPATH": str(PY_DIR)},
    )
    assert proc.returncode == 0, proc.stderr
    out = [l for l in proc.stdout.splitlines() if l.strip()]
    replies = {}
    for l in out:
        msg = json.loads(l)  # nothing but JSON-RPC on the wire
        for m in msg if isinstance(msg, list) else [msg]:
            assert m["jsonrpc"] == "2.0"
            replies[m.get("id")] = m
    return replies, out, proc.stderr


def _env() -> dict:
    import os

    return {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYOKKA_PYTHON")}


def text(reply: dict) -> str:
    return reply["result"]["content"][0]["text"]


@pytest.fixture(scope="module")
def session(tmp_path_factory) -> tuple[dict, Path, str]:
    """One server conversation over a recording of ``PROGRAM``."""
    root = tmp_path_factory.mktemp("mcp")
    (root / "prog.py").write_text(textwrap.dedent(PROGRAM).lstrip())
    run = root / ".pyokka" / "runs" / "prog.json"
    msgs = [
        _request(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}),
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        _request(2, "tools/list"),
        _call(3, "pyokka_run", file="prog.py"),
        _call(4, "pyokka_map", action="walkthrough", run=str(run)),
        _call(5, "pyokka_value", action="var", run=str(run), name="total"),
        _call(6, "pyokka_coverage", run=str(run)),
        _call(7, "pyokka_coverage", run=str(run), file="prog.py"),
        _call(8, "pyokka_coverage", run=str(run), json=True),
        _call(9, "pyokka_map", action="exceptions", run=str(run)),
        _call(10, "pyokka_map", action="find", run=str(run), text="ValueError"),
        _call(11, "pyokka_step", run=str(run), step=1),
        _call(12, "pyokka_step", run=str(run), step=1, move="over"),
        # errors: a missing run, an unknown action, a missing argument, a wrong type, an unknown tool
        _call(20, "pyokka_map", action="walkthrough", run=str(root / "missing.json")),
        _call(21, "pyokka_map", action="nonsense", run=str(run)),
        _call(22, "pyokka_value", action="why", run=str(run), name="total"),
        _call(23, "pyokka_step", run=str(run), step="abc"),
        _call(24, "pyokka_run", file="nope.py"),
        _call(25, "pyokka_map", action="walkthrough"),
        _call(26, "no_such_tool"),
        _request(27, "no/such/method"),
        "{not json",
        _request(28, "ping"),
        [_request(29, "ping"), {"jsonrpc": "2.0", "method": "notifications/cancelled"}],
    ]
    replies, out, err = serve(msgs, root)
    return replies, run, err


def test_initialize_answers_the_asked_version(session):
    replies, _, _ = session
    result = replies[1]["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert result["serverInfo"]["name"] == "pyokka"
    assert "tools" in result["capabilities"]
    assert "pyokka_run" in result["instructions"]


def test_unknown_protocol_version_gets_the_newest():
    reply = mcp.handle(_request(1, "initialize", {"protocolVersion": "1999-01-01"}))
    assert reply["result"]["protocolVersion"] == mcp.PROTOCOL_VERSIONS[0]


def test_tools_list_has_the_eight_tools_with_schemas(session):
    replies, _, _ = session
    tools = {t["name"]: t for t in replies[2]["result"]["tools"]}
    assert set(tools) == {"pyokka_run", "pyokka_map", "pyokka_step", "pyokka_value", "pyokka_coverage", "pyokka_debug", "pyokka_history", "pyokka_narrate", "pyokka_session", "pyokka_seek", "pyokka_save_investigation", "pyokka_open_investigation", "pyokka_investigate", "pyokka_learn", "pyokka_pin", "pyokka_verify", "pyokka_page", "pyokka_scratchpad"}
    for t in tools.values():
        assert t["description"]
        assert t["inputSchema"]["type"] == "object"
    assert tools["pyokka_run"]["inputSchema"]["required"] == ["file"]
    assert set(tools["pyokka_map"]["inputSchema"]["properties"]["action"]["enum"]) == set(MAP_ACTIONS)
    assert set(tools["pyokka_value"]["inputSchema"]["properties"]["action"]["enum"]) == set(VALUE_ACTIONS)
    assert set(tools["pyokka_debug"]["inputSchema"]["properties"]["action"]["enum"]) == set(DEBUG_ACTIONS)
    assert replies[2]["result"]["tools"] == tool_definitions()


def test_run_records_next_to_the_file(session):
    replies, run, _ = session
    assert replies[3]["result"]["isError"] is False
    assert run.is_file()
    assert "run: %s" % run in text(replies[3])
    assert "pyokka_map" in text(replies[3])


def test_the_program_prints_do_not_reach_the_wire(session):
    # every stdout line parsed as JSON-RPC in `serve`; the prints are in the recording instead
    replies, _, _ = session
    assert "running total" in text(replies[4])


def test_map_value_and_step(session):
    replies, _, _ = session
    assert replies[4]["result"]["isError"] is False
    assert "sign" in text(replies[4]) and "parse" in text(replies[4])
    var = text(replies[5])
    assert replies[5]["result"]["isError"] is False
    assert "change" in var and "total = 7" in var
    assert replies[9]["result"]["isError"] is False
    assert "ValueError" in text(replies[9]) and "caught" in text(replies[9])
    assert "ValueError" in text(replies[10])
    assert replies[11]["result"]["isError"] is False and "#1" in text(replies[11])
    assert replies[12]["result"]["isError"] is False


def test_coverage_lists_the_untaken_branch(session):
    replies, _, _ = session
    summary = text(replies[6])
    assert replies[6]["result"]["isError"] is False
    assert "not run: 3" in summary
    by_line = text(replies[7])
    assert any(l.strip().startswith("3") and "not run" in l for l in by_line.splitlines())
    data = json.loads(text(replies[8]))
    (f,) = data["files"]
    assert f["file"] == "prog.py" and f["notRun"] == [3] and f["ran"] == f["lines"] - 1


def test_errors_are_tool_results_with_a_hint(session):
    replies, _, _ = session
    for id_ in (20, 21, 22, 23, 24, 25):
        r = replies[id_]["result"]
        assert r["isError"] is True, (id_, r)
        assert text(replies[id_]).startswith("error:"), (id_, text(replies[id_]))
    assert "one of" in text(replies[21])
    assert "pyokka_value var" in text(replies[22])
    assert "bad argument" in text(replies[23])
    assert "pyokka_run" in text(replies[25])


def test_protocol_errors(session):
    replies, _, err = session
    assert replies[26]["error"]["code"] == -32602
    assert replies[27]["error"]["code"] == -32601
    assert replies[None]["error"]["code"] == -32700
    assert replies[28]["result"] == {}
    assert "Traceback" not in err


def test_a_batch_answers_its_requests_only():
    replies, out, _ = serve([[_request(1, "ping"), {"jsonrpc": "2.0", "method": "notifications/initialized"}]], PY_DIR)
    (line,) = out
    assert json.loads(line) == [{"jsonrpc": "2.0", "id": 1, "result": {}}]


def test_notifications_and_responses_get_no_reply():
    assert mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert mcp.handle({"jsonrpc": "2.0", "id": 5, "result": {}}) is None
    assert mcp.handle({"id": 1, "method": "ping"})["error"]["code"] == -32600


def test_live_needs_no_run_and_names_the_session():
    assert mcp.words_coverage({"live": True, "session": "s1"}) == ["coverage", "--live", "--session=s1", "--"]
    assert mcp.words_step({"live": True, "move": "into"}) == ["step", "--live", "--into", "--"]
    with pytest.raises(mcp.ToolError):
        mcp.words_step({"run": "r.json", "move": "into"})


def test_debug_words_without_vs_code():
    # the live debugger needs VS Code with the extension; here only the command words are checked
    words = mcp.words_debug({"action": "start", "file": "app.py", "at": ["main"], "env": {"A": "1"}, "args": ["--n", "2"], "stop_on_entry": True})
    assert words[:2] == ["debug", "--live"]
    assert "--at=main" in words and "--env=A=1" in words and "--stop-on-entry" in words
    assert words[-4:] == ["app.py", "--args", "--n", "2"]
    assert mcp.words_debug({"action": "exec", "source": "x = 1"})[-2:] == ["--", "x = 1"]
    assert mcp.words_debug({"action": "break", "add": ["app.py:3"], "when": "x > 1"}) == ["break", "--live", "--when=x > 1", "--", "app.py:3"]
    parser = build_parser()
    for action in DEBUG_ACTIONS:  # every action turns into words the parser accepts
        args = {"action": action, "source": "1"} if action == "exec" else {"action": action}
        parser.parse_args(mcp.words_debug(args))


def test_default_save_path(tmp_path: Path):
    assert mcp.default_save(str(tmp_path / "a" / "demo.py")) == str(tmp_path / "a" / ".pyokka" / "runs" / "demo.json")
