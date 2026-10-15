"""``--python NAME``: a bare command is looked up on PATH, as a shell would."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

import pytest

from pyokka_runtime.agent.debug_start import build_launch
from pyokka_runtime.agent.interpreter import choose
from pyokka_runtime.agent.source import AgentError

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_run_takes_a_command_on_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # no ./python3 here: the name can only come from PATH
    interp = choose(str(tmp_path / "x.py"), "python3")
    assert interp.path == shutil.which("python3")
    assert os.path.isabs(interp.path)


def test_run_refuses_an_unknown_command_by_its_name(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(AgentError) as exc:
        choose(str(tmp_path / "x.py"), "no-such-python-pk")
    assert "no-such-python-pk" in exc.value.message
    assert "PATH" in exc.value.message


def test_debug_launch_takes_a_command_on_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    launch = build_launch(program=str(tmp_path / "x.py"), python="python3")
    assert launch["python"] == shutil.which("python3")
    assert launch["python"] != str(tmp_path / "python3")


def test_debug_launch_refuses_an_unknown_command_at_once(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(AgentError) as exc:
        build_launch(program=str(tmp_path / "x.py"), python="no-such-python-pk")
    assert "no-such-python-pk" in exc.value.message


def test_a_path_with_a_separator_stays_a_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    launch = build_launch(program=str(tmp_path / "x.py"), python="./bin/python")
    assert launch["python"] == str(tmp_path / "bin" / "python")


def test_pyokka_run_with_python3_exits_0(tmp_path):
    script = tmp_path / "x.py"
    script.write_text("print('hi')\n")
    out = subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", str(script), "--python", "python3"], cwd=str(tmp_path), capture_output=True, text=True, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=60)
    assert out.returncode == 0, out.stderr
    assert "hi" in out.stdout


def test_a_file_named_like_the_command_does_not_shadow_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "python3").write_text("not an interpreter\n")
    assert choose(str(tmp_path / "x.py"), "python3").path == shutil.which("python3")


def test_a_venv_directory_named_bare_is_still_a_path(tmp_path, monkeypatch):
    import venv

    monkeypatch.chdir(tmp_path)
    venv.create(tmp_path / ".venv", with_pip=False, symlinks=True)
    assert choose(str(tmp_path / "x.py"), ".venv").path.startswith(str(tmp_path / ".venv"))
