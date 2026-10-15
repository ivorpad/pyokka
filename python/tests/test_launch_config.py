"""``debug --configuration NAME``: a launch.json configuration becomes the launch, command-line flags win."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from pyokka_runtime.agent.commands import debug_launch, is_live
from pyokka_runtime.agent.shell import build_parser
from pyokka_runtime.agent.source import AgentError

LAUNCH = """{
  // comments and trailing commas, as VS Code writes it
  "version": "0.2.0",
  "configurations": [
    {
      "type": "debugpy", "request": "launch", "name": "Checkout DE",
      "program": "${workspaceFolder}/src/main.py",
      "args": ["--country", "de"],
      "cwd": "${workspaceFolder}/src",
      "env": {"MODE": "test", "HOME_DIR": "${userHome}"},
      "envFile": "${workspaceFolder}/.env",
      "python": "${command:python.interpreterPath}",
      "justMyCode": false,
      "console": "integratedTerminal",
      "subProcess": true,
    },
    {"type": "python", "request": "launch", "name": "Current file", "program": "${file}", "args": "-v --fast"},
    {"type": "debugpy", "request": "launch", "name": "Server", "module": "app.server", "cwd": "${workspaceFolder}", "stopOnEntry": true},
    {"type": "node", "request": "launch", "name": "Node"},
    {"type": "debugpy", "request": "attach", "name": "Attach", "connect": {"port": 5678}},
    /* a block comment */
  ],
}"""


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path.resolve()
    (root / "src").mkdir()
    (root / "src" / "main.py").write_text("import os, sys\nprint(sys.argv[1:], os.getcwd(), os.environ.get('MODE'))\n")
    (root / "src" / "other.py").write_text("pass\n")
    (root / ".env").write_text('# comment\nTOKEN="abc"\nexport LEVEL=3\n')
    (root / ".vscode").mkdir()
    (root / ".vscode" / "launch.json").write_text(LAUNCH)
    return root


def launch_of(*words: str) -> dict:
    args = build_parser().parse_args(["debug", *words])
    assert is_live(args)
    launch = debug_launch(args)
    assert launch is not None
    launch["_line"] = args._configuration
    return launch


def test_configuration_becomes_the_launch_and_flags_win(workspace: Path, monkeypatch):
    monkeypatch.chdir(workspace / "src")
    launch = launch_of("--configuration", "Checkout DE", "--env", "MODE=override")
    assert launch["program"] == str(workspace / "src" / "main.py")
    assert launch["args"] == ["--country", "de"]
    assert launch["cwd"] == str(workspace / "src")
    assert launch["env"]["MODE"] == "override"
    assert launch["env"]["TOKEN"] == "abc" and launch["env"]["LEVEL"] == "3"
    assert launch["env"]["HOME_DIR"] == os.path.expanduser("~")
    assert launch["libraryCode"] is True
    assert "python" not in launch, "the window's interpreter, as ${command:python.interpreterPath} says"
    assert launch["_line"]["ignored"] == ["subProcess"]

    flags = launch_of("--configuration", "Checkout DE", "--cwd", str(workspace), "--args", "--country", "fr")
    assert flags["cwd"] == str(workspace) and flags["args"] == ["--country", "fr"]


def test_file_variables_and_modules(workspace: Path, monkeypatch):
    monkeypatch.chdir(workspace)
    other = str(workspace / "src" / "other.py")
    launch = launch_of(other, "--configuration", "Current file")
    assert launch["program"] == other and launch["args"] == ["-v", "--fast"]
    with pytest.raises(AgentError, match="needs the FILE argument"):
        launch_of("--configuration", "Current file")
    server = launch_of("--configuration", "Server")
    assert server["module"] == "app.server" and "program" not in server
    assert server["cwd"] == str(workspace) and server["stopOnEntry"] is True


def test_unknown_names_list_the_configurations_and_other_types_are_refused(workspace: Path, monkeypatch):
    monkeypatch.chdir(workspace)
    with pytest.raises(AgentError) as exc:
        launch_of("--configuration", "Nope")
    assert "no configuration named \"Nope\"" in exc.value.message
    assert '"Checkout DE", "Current file", "Server", "Node", "Attach"' in (exc.value.hint or "")
    with pytest.raises(AgentError, match='type "node"'):
        launch_of("--configuration", "Node")
    with pytest.raises(AgentError, match="attaches"):
        launch_of("--configuration", "Attach")
    monkeypatch.chdir("/")
    with pytest.raises(AgentError, match="no .vscode/launch.json"):
        launch_of("--configuration", "Server")
