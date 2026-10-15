"""``run --mode profile`` names its profile and says it recorded no steps."""

from __future__ import annotations

import os
import subprocess
import sys

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(os.path.dirname(PY_DIR), "examples", "demo.py")


def test_profile_run_prints_the_path_and_no_steps():
    out = subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", DEMO, "--mode", "profile"], capture_output=True, text=True, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=120)
    lines = out.stdout.splitlines()
    profile = [l for l in lines if l.startswith("profile: ")]
    assert len(profile) == 1, out.stdout[-2000:]
    path = profile[0][len("profile: "):]
    assert path.endswith(".cpuprofile") and os.path.isfile(path), path
    assert any(l.startswith("profiled, no steps recorded") for l in lines), out.stdout[-2000:]
    os.unlink(path)


def test_a_normal_run_prints_neither():
    out = subprocess.run([sys.executable, "-m", "pyokka_runtime", "run", DEMO], capture_output=True, text=True, env={**os.environ, "PYTHONPATH": PY_DIR}, timeout=120)
    assert "profile: " not in out.stdout and "profiled, no steps recorded" not in out.stdout
