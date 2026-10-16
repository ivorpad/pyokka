"""A connection a sandbox blocks is not "no page", and MCP's page ``open`` passes ``cwd`` on (agent/web.py, agent/mcp_page.py).

An agent under Codex's sandbox read `no Pyokka page is served on 127.0.0.1:4777` while the person had
the page open, and started a second page on another port.
"""

from __future__ import annotations

import pytest

from pyokka_runtime.agent import mcp_page, web
from pyokka_runtime.agent.source import AgentError


def _raise(exc):
    def connect(*_a, **_k):
        raise exc

    return connect


def test_a_connection_the_system_blocks_says_sandbox_not_no_page(monkeypatch):
    monkeypatch.setattr(web.socket, "create_connection", _raise(PermissionError(1, "Operation not permitted")))
    with pytest.raises(AgentError) as exc:
        web.listening(4777)
    assert "refused by the system (Operation not permitted), not by a server" in exc.value.message
    assert "sandbox" in exc.value.message and "outside the sandbox" in (exc.value.hint or "")


def test_a_refused_connection_is_still_no_page(monkeypatch):
    monkeypatch.setattr(web.socket, "create_connection", _raise(ConnectionRefusedError(61, "Connection refused")))
    assert web.listening(4777) is False


def test_ctl_under_a_sandbox_prints_the_sandbox_error(monkeypatch, capsys):
    monkeypatch.setattr(web.socket, "create_connection", _raise(PermissionError(1, "Operation not permitted")))
    monkeypatch.setattr(web, "find_server", lambda: "/x/server.js")
    monkeypatch.setattr(web, "node_command", lambda: ("node", {}))
    assert web.web_main(["ctl", "state"]) == 2
    err = capsys.readouterr().err
    assert "sandbox" in err and "no Pyokka page is served" not in err


def test_mcp_open_passes_cwd_to_the_bridge_and_refuses_a_missing_one(tmp_path, monkeypatch):
    proj = tmp_path / "proj"
    (proj / "tests").mkdir(parents=True)
    test_file = proj / "tests" / "test_routes.py"
    test_file.write_text("pass\n")
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    probes = []

    def listening(port, timeout=1.0):
        probes.append(port)
        return len(probes) > 1  # free before the bridge starts, served once it has

    started = {}

    class Proc:
        pid = 4242

        def __init__(self, argv, **kw):
            started["argv"] = argv

        def poll(self):
            return None

        def terminate(self):
            pass

    monkeypatch.setattr(mcp_page, "listening", listening)
    monkeypatch.setattr(mcp_page, "node_command", lambda: ("node", {}))
    monkeypatch.setattr(mcp_page, "find_server", lambda: "/x/server.js")
    monkeypatch.setattr(mcp_page.subprocess, "Popen", Proc)
    try:
        _, is_error = mcp_page._open({"file": str(test_file), "cwd": str(proj), "port": 4999})
    finally:
        mcp_page.STARTED.pop(4999, None)
    assert not is_error
    argv = started["argv"]
    assert argv[argv.index("--cwd") + 1] == str(proj)
    started.clear()
    probes.clear()
    with pytest.raises(AgentError) as exc:
        mcp_page._open({"file": str(test_file), "cwd": str(proj / "nope"), "port": 4998})
    assert exc.value.message == "no directory %s" % (proj / "nope")
    assert not started and not probes
