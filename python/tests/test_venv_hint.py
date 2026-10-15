"""A ModuleNotFoundError on an interpreter that is not the project's names the project venv."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import venv

import pytest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def project(tmp_path, *, lock: bool):
    (tmp_path / "app.py").write_text("import not_installed_pk\nprint('ok')\n")
    if lock:
        (tmp_path / "uv.lock").write_text("version = 1\n")
    venv.create(tmp_path / ".venv", with_pip=False, symlinks=True)
    return tmp_path / "app.py"


def uncaught(app, python=None):
    cmd = [sys.executable, "-m", "pyokka_runtime", "run", str(app), "--json"]
    if python:
        cmd += ["--python", python]
    out = subprocess.run(cmd, capture_output=True, text=True, cwd=str(app.parent), env={**{k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}, "PYTHONPATH": PY_DIR}, timeout=120)
    errors = [json.loads(l) for l in out.stdout.splitlines() if l.startswith("{") and '"type":"error"' in l.replace(" ", "")]
    (err,) = [e for e in errors if not e.get("handled")]
    assert err["errorType"] == "ModuleNotFoundError"
    return err, out


def test_the_hint_names_the_project_venv(tmp_path):
    app = project(tmp_path, lock=True)
    err, _ = uncaught(app, python=sys.executable)  # an interpreter that is not the project's
    assert "--python .venv/bin/python" in err.get("hint", ""), err


def test_no_hint_without_a_lock_file(tmp_path):
    app = project(tmp_path, lock=False)
    err, _ = uncaught(app, python=sys.executable)
    assert "hint" not in err, err


def test_no_hint_on_the_project_venv_itself(tmp_path):
    app = project(tmp_path, lock=True)
    err, _ = uncaught(app, python=str(tmp_path / ".venv" / "bin" / "python"))
    assert "hint" not in err, err


def test_run_prints_the_hint(tmp_path):
    app = project(tmp_path, lock=True)
    out = subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", str(app), "--python", sys.executable], capture_output=True, text=True, cwd=str(tmp_path), env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=120)
    assert "hint: " in out.stdout and "--python .venv/bin/python" in out.stdout, out.stdout
