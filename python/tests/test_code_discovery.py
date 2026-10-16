"""Finding VS Code's `code` launcher and the narration CLIs without env vars, and the checks before the URI wait.

Every test points the search lists at temp dirs and strips PATH, so it passes whatever is installed here.
Nothing launches VS Code: the `code` binaries are shell scripts that print or exit.
"""

from __future__ import annotations

import os
import stat
import time
from pathlib import Path

import pytest

from pyokka_runtime.agent import debug_start, narrate, web
from pyokka_runtime.agent.source import AgentError

APP = "/ws/app.py"


def script(path: Path, body: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


@pytest.fixture
def no_code(tmp_path: Path, monkeypatch) -> Path:
    """No PYOKKA_CODE, an empty PATH, no app folders and no bin dirs: nothing to find yet."""
    monkeypatch.delenv("PYOKKA_CODE", raising=False)
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    monkeypatch.setattr(web, "VSCODE_APPS", ())
    monkeypatch.setattr(web, "CODE_BIN_DIRS", ())
    return tmp_path


def test_the_app_launcher_is_found_without_path(no_code: Path, monkeypatch):
    app = no_code / "Applications" / "Visual Studio Code.app"
    brew = no_code / "brew"
    monkeypatch.setattr(web, "VSCODE_APPS", (str(app),))
    monkeypatch.setattr(web, "CODE_BIN_DIRS", (str(brew),))
    brew_code = script(brew / "code", "exit 0")
    assert debug_start.code_command() == brew_code
    launcher = script(app / "Contents" / "Resources" / "app" / "bin" / "code", "exit 0")
    assert debug_start.code_command() == launcher  # the app comes before the bin dirs
    on_path = script(no_code / "empty" / "code", "exit 0")
    assert debug_start.code_command() == on_path  # PATH before both
    monkeypatch.setenv("PYOKKA_CODE", "/explicit/code")
    assert debug_start.code_command() == "/explicit/code"


def test_without_any_launcher_the_error_names_every_path_tried(no_code: Path, monkeypatch):
    monkeypatch.setattr(web, "VSCODE_APPS", (str(no_code / "Nope.app"),))
    monkeypatch.setattr(web, "CODE_BIN_DIRS", (str(no_code / "nobin"),))
    with pytest.raises(AgentError) as exc:
        debug_start.code_command()
    assert exc.value.message == debug_start.CODE_MISSING
    assert str(no_code / "Nope.app" / "Contents" / "Resources" / "app" / "bin" / "code") in exc.value.hint
    assert str(no_code / "nobin" / "code") in exc.value.hint
    assert "$PYOKKA_CODE" in exc.value.hint and "Shell Command: Install code command in PATH" in exc.value.hint


def test_the_shared_list_puts_the_apps_before_the_bin_dirs(monkeypatch):
    monkeypatch.setattr(web, "VSCODE_APPS", ("/Applications/Visual Studio Code.app",))
    monkeypatch.setattr(web, "CODE_BIN_DIRS", ("/usr/local/bin", "/opt/homebrew/bin"))
    assert web.code_launchers() == ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/usr/local/bin/code", "/opt/homebrew/bin/code"]


def test_the_shipped_list_holds_the_mac_app_and_the_usual_bin_dirs(real_code_lists):
    launchers = web.code_launchers()
    assert "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" in launchers
    assert "/usr/local/bin/code" in launchers and "/opt/homebrew/bin/code" in launchers


def test_a_failing_open_url_raises_at_once(no_code: Path, monkeypatch, tmp_path: Path):
    code = script(tmp_path / "bin" / "code", '[ "$1" = --list-extensions ] && { echo ivor.pyokka; exit 0; }\necho "cannot open" >&2; exit 4')
    monkeypatch.setenv("PYOKKA_CODE", code)
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    began = time.time()
    with pytest.raises(AgentError) as exc:
        debug_start.start_via_uri(debug_start.build_launch(program=APP, cwd="/ws"), timeout=5.0)
    assert time.time() - began < 2.0  # not the poll
    assert "--open-url` failed (exit 4): cannot open" in exc.value.message


def test_a_vscode_without_pyokka_is_refused_before_the_uri(no_code: Path, monkeypatch, tmp_path: Path):
    opened = tmp_path / "opened.txt"
    code = script(tmp_path / "bin" / "code", '[ "$1" = --list-extensions ] && { echo ms-python.python; exit 0; }\necho "$2" > "%s"' % opened)
    monkeypatch.setenv("PYOKKA_CODE", code)
    with pytest.raises(AgentError) as exc:
        debug_start.start_via_uri(debug_start.build_launch(program=APP, cwd="/ws"), timeout=5.0)
    assert "ivor.pyokka" in exc.value.message and "not installed" in exc.value.message
    assert "`%s --install-extension ivor.pyokka`" % code in exc.value.hint
    assert 'pyokka debug %s' % APP in exc.value.hint and '"action": "start", "file": "%s"' % APP in exc.value.hint
    assert not opened.exists()
    with pytest.raises(AgentError) as exc:
        debug_start.start_via_uri(debug_start.build_launch(module="pkg.main", cwd="/ws"), timeout=5.0)
    assert "pyokka debug --module pkg.main" in exc.value.hint and '"module": "pkg.main"' in exc.value.hint


def test_a_launcher_that_cannot_list_extensions_still_opens_the_uri(no_code: Path, monkeypatch, tmp_path: Path):
    opened = tmp_path / "opened.txt"
    code = script(tmp_path / "bin" / "code", '[ "$1" = --list-extensions ] && exit 1\necho "$2" > "%s"' % opened)
    monkeypatch.setenv("PYOKKA_CODE", code)
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    with pytest.raises(AgentError, match="did not start a debug session"):
        debug_start.start_via_uri(debug_start.build_launch(program=APP, cwd="/ws"), timeout=0.3)
    assert opened.read_text().startswith("vscode://ivor.pyokka/debug?")


# -- narrate --------------------------------------------------------------------------------------------------


@pytest.fixture
def no_backend(tmp_path: Path, monkeypatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    return home


def test_claude_and_codex_are_found_off_path(no_backend: Path, monkeypatch):
    monkeypatch.setattr(narrate, "BACKEND_DIRS", {"claude": ("~/.local/bin", "~/.claude/local"), "codex": ("~/.local/bin",)})
    assert narrate.resolve_backend(None) is None
    codex = script(no_backend / ".local" / "bin" / "codex", "exit 0")
    b = narrate.resolve_backend(None)
    assert b.name == "codex" and b.argv[0] == codex and b.argv[-1] == "-"
    claude = script(no_backend / ".claude" / "local" / "claude", "exit 0")
    b = narrate.resolve_backend(None)
    assert b.name == "claude" and b.argv[0] == claude  # claude before codex
    assert narrate.resolve_backend(None, which=lambda name: "/on/path/" + name).argv[0] == "claude"  # PATH keeps the bare name


def test_the_default_dirs_are_the_usual_installs():
    assert narrate.backend_paths("claude")[:2] == [os.path.expanduser("~/.local/bin/claude"), os.path.expanduser("~/.claude/local/claude")]
    assert "/opt/homebrew/bin/claude" in narrate.backend_paths("claude") and "/usr/local/bin/codex" in narrate.backend_paths("codex")


def test_without_a_backend_the_error_names_the_paths_and_the_mcp_form(no_backend: Path, monkeypatch):
    monkeypatch.setattr(narrate, "BACKEND_DIRS", {"claude": ("~/.local/bin", "~/.claude/local"), "codex": ("~/.local/bin",)})
    assert narrate.resolve_backend(None) is None

    class Run:
        path = "/runs/run.json"

    monkeypatch.setattr("pyokka_runtime.agent.walkthrough.walkthrough", lambda run: {"moments": [{"id": "m0"}]})
    monkeypatch.setattr(narrate, "collect_sources", lambda run, moments: {})
    monkeypatch.setattr(narrate, "build_prompt", lambda *a: "prompt")
    with pytest.raises(AgentError) as exc:
        narrate.narrate_saved(Run())  # type: ignore[arg-type]
    assert str(no_backend / ".local" / "bin" / "claude") in exc.value.message
    assert str(no_backend / ".claude" / "local" / "claude") in exc.value.message
    assert '"run": "/runs/run.json", "command":' in exc.value.hint and "--command" in exc.value.hint
    assert "pyokka.explain.command" not in exc.value.hint
