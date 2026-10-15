"""``pyokka web`` finds the page's bridge where an install and a checkout put it."""

from __future__ import annotations

import os

import pytest

from pyokka_runtime.agent.source import AgentError
from pyokka_runtime.agent.web import find_server, port_of


def touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").close()
    return str(path)


def test_an_installed_extension_finds_dist_web_beside_dist_python(tmp_path):
    runtime = tmp_path / "ext" / "dist" / "python" / "pyokka_runtime"
    server = touch(tmp_path / "ext" / "dist" / "web" / "server.js")
    assert find_server(str(runtime)) == server


def test_a_checkout_finds_its_build(tmp_path):
    runtime = tmp_path / "repo" / "python" / "pyokka_runtime"
    server = touch(tmp_path / "repo" / "dist" / "web" / "server.js")
    assert find_server(str(runtime)) == server


def test_an_unbuilt_checkout_says_how_to_build(tmp_path):
    touch(tmp_path / "repo" / "web" / "server.ts")
    with pytest.raises(AgentError) as exc:
        find_server(str(tmp_path / "repo" / "python" / "pyokka_runtime"))
    assert "not built" in exc.value.message and "esbuild" in exc.value.hint


def test_the_port_rule_is_the_bridges():
    assert port_of(["ctl", "--port", "4790", "state"]) == 4790
    assert port_of(["demo.py"], env={"PYOKKA_PORT": "4791"}) == 4791
    assert port_of(["demo.py"], env={}) == 4777


def executable(path, text="#!/bin/sh\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    os.chmod(path, 0o755)
    return str(path)


def fake_vscode_app(root, binary="Code"):
    """A VS Code.app as far as the lookup reads it: Info.plist's CFBundleExecutable, the binary, the launcher."""
    import plistlib

    contents = root / "Visual Studio Code.app" / "Contents"
    os.makedirs(contents, exist_ok=True)
    with open(contents / "Info.plist", "wb") as fh:
        plistlib.dump({"CFBundleExecutable": binary}, fh)
    return executable(contents / "MacOS" / binary), executable(contents / "Resources" / "app" / "bin" / "code")


def test_node_on_path_runs_the_bridge(tmp_path):
    from pyokka_runtime.agent.web import node_command

    node = executable(tmp_path / "bin" / "node")
    assert node_command({"PATH": str(tmp_path / "bin")}) == (node, {})


def test_without_node_the_bridge_runs_on_vscodes_own_node(tmp_path, monkeypatch):
    from pyokka_runtime.agent import web

    monkeypatch.setattr(web, "VSCODE_APPS", ())
    binary, launcher = fake_vscode_app(tmp_path / "Apps", binary="Code - Insiders")
    # the pyokka script names the launcher in PYOKKA_CODE; no node anywhere on PATH
    assert web.node_command({"PATH": str(tmp_path / "empty"), "PYOKKA_CODE": launcher}) == (binary, {"ELECTRON_RUN_AS_NODE": "1"})
    # `code` on PATH (a symlink to the launcher, as VS Code's shell command installs it) finds the same binary
    os.makedirs(tmp_path / "bin")
    os.symlink(launcher, tmp_path / "bin" / "code")
    assert web.node_command({"PATH": str(tmp_path / "bin")}) == (binary, {"ELECTRON_RUN_AS_NODE": "1"})
    # Linux: <root>/bin/code beside the <root>/code binary
    linux = executable(tmp_path / "share" / "code" / "code")
    assert web.vscode_node({"PATH": "", "PYOKKA_CODE": executable(tmp_path / "share" / "code" / "bin" / "code")}) == linux


def test_with_neither_the_error_says_what_to_install(tmp_path, monkeypatch):
    from pyokka_runtime.agent import web

    monkeypatch.setattr(web, "VSCODE_APPS", ())
    with pytest.raises(AgentError) as exc:
        web.node_command({"PATH": str(tmp_path)})
    assert "VS Code's own Node" in exc.value.message and "Node.js 20" in exc.value.hint
