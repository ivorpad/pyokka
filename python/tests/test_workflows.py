"""`pin`, `investigate`, `learn` and `verify` over saved runs.

`cart_unfixed.py` adds where it should multiply (total 14); `cart_fixed.py` multiplies (total 22).
Both are recorded at the same path, the way a fix happens, so `verify` compares a before and an
after of one file.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main

PORT = Path(__file__).resolve().parent / "fixtures" / "port"


def pyokka(*args: object) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main([str(a) for a in args])
    return code, buf.getvalue()


def record(src: Path, app: Path, out: Path, *extra: str) -> Path:
    shutil.copyfile(src, app)
    code, _ = pyokka("run", app, "--save", out, *extra)
    assert code == 0
    return out


@pytest.fixture
def runs(tmp_path: Path) -> dict[str, Path]:
    (tmp_path / ".git").mkdir()
    app = tmp_path / "cart.py"
    before = record(PORT / "cart_unfixed.py", app, tmp_path / "before.json")
    return {"app": app, "before": before}


def pyokka_json(*args: object) -> tuple[int, dict]:
    code, out = pyokka(*args, "--json")
    return code, json.loads(out)


def test_investigate_names_the_assigning_step_and_its_line(tmp_path: Path):
    run = tmp_path / "rrf.json"
    assert pyokka("run", PORT.parents[3] / "examples" / "rrf" / "demo.py", "--save", run)[0] == 0
    code, result = pyokka_json("investigate", run, "--value", "fused_ranking")
    assert code == 0
    change = result["history"]["changes"][-1]
    assert (change["line"], change["function"]) == (124, "main")  # fused_ranking = sorted(
    assert result["selection"]["changeStep"] == change["step"]
    assert result["why"]["step"] == change["step"]
    # the value is visible from the scope's next step, where origin starts its chain
    assert result["step"] == result["selection"]["observedStep"] > change["step"]
    assigned = [l for l in result["origin"]["links"] if l["how"] == "assigned"]
    assert (assigned[0]["step"], assigned[0]["line"]) == (change["step"], 124)
    _, text = pyokka("investigate", run, "--value", "fused_ranking")
    assert "selected: #%d demo.py:124 main" % change["step"] in text


def test_investigate_says_where_a_cut_recording_has_gaps(tmp_path: Path):
    app = tmp_path / "cart.py"
    run = record(PORT / "cart_unfixed.py", app, tmp_path / "cut.json", "--max-steps", "6")
    doc = json.loads(run.read_text())
    doc["events"] = [e for e in doc["events"] if e.get("type") != "run.finished"]
    for e in doc["events"]:
        if e.get("type") == "trace":
            e["midRun"] = True
    for f in doc["meta"]["files"]:
        f.pop("source", None)
    run.write_text(json.dumps(doc))
    code, result = pyokka_json("investigate", run, "--value", "total")
    assert code == 0
    notes = " | ".join(result["notes"])
    assert "truncated at its step cap" in notes
    assert "began partway through execution" in notes
    assert "no run.finished event" in notes
    assert "No recorded source copy of cart.py" in notes


def test_learn_hides_the_value_until_reveal_then_shows_it_and_the_match(runs: dict[str, Path]):
    code, lesson = pyokka_json("learn", runs["before"])
    assert code == 0
    printed = next(c for c in lesson["checkpoints"] if c["kind"] == "print")  # print(total), which printed 14
    hidden_code, hidden = pyokka("learn", runs["before"], "--at", printed["step"], "--prediction", "22")
    assert hidden_code == 0 and "your prediction: 22" in hidden
    assert "recorded:" not in hidden and "match:" not in hidden
    _, hidden_json = pyokka_json("learn", runs["before"], "--at", printed["step"], "--prediction", "22")
    assert "14" not in json.dumps({k: v for k, v in hidden_json.items() if k not in ("notes", "coverage", "checkpoints")})
    _, shown = pyokka("learn", runs["before"], "--at", printed["step"], "--prediction", "22", "--reveal")
    assert "printed = 14" in shown and "match: no recorded value" in shown
    _, right = pyokka_json("learn", runs["before"], "--at", printed["step"], "--prediction", "14", "--reveal")
    assert right["match"]["matched"] and right["match"]["text"] == "14"


def test_verify_passes_on_the_fix_and_fails_without_it(runs: dict[str, Path], tmp_path: Path):
    after = record(PORT / "cart_fixed.py", runs["app"], tmp_path / "after.json")
    code, result = pyokka_json("verify", runs["before"], "--after", after, "--expect", "total=22")
    assert code == 0 and result["verified"]
    assert result["checks"][0]["actual"] == "22"
    unfixed = record(PORT / "cart_unfixed.py", runs["app"], tmp_path / "unfixed.json")
    code, text = pyokka("verify", runs["before"], "--after", unfixed, "--expect", "total=22")
    assert code == 1
    assert "FAIL total = 14" in text and "not verified" in text


def test_verify_refuses_an_incomplete_recording(runs: dict[str, Path], tmp_path: Path):
    cut = record(PORT / "cart_fixed.py", runs["app"], tmp_path / "cut.json", "--max-steps", "6")
    code, result = pyokka_json("verify", runs["before"], "--after", cut, "--expect", "total=22")
    assert code == 1 and not result["verified"]
    assert result["checks"][0]["reason"] == "the final value is not supported by a complete recording"


def test_verify_rerun_writes_a_pytest_file_that_passes(runs: dict[str, Path], tmp_path: Path):
    shutil.copyfile(PORT / "cart_fixed.py", runs["app"])
    test_file = tmp_path / "test_cart_regression.py"
    code, result = pyokka_json("verify", runs["before"], "--rerun", "--expect", "total=22", "--test-out", test_file)
    assert code == 0 and result["verified"] and result["test"] == str(test_file)
    ran = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(test_file)], cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert ran.returncode == 0, ran.stdout + ran.stderr
    assert pyokka("verify", runs["before"], "--rerun", "--expect", "total=22", "--test-out", test_file)[0] == 2


def test_pin_copies_the_run_byte_for_byte_and_refuses_to_overwrite(runs: dict[str, Path], tmp_path: Path):
    out = tmp_path / "baseline.json"
    code, text = pyokka("pin", runs["before"], "--out", out)
    assert code == 0 and str(out) in text
    assert out.read_bytes() == runs["before"].read_bytes()
    out.write_bytes(b"kept")
    code, _ = pyokka("pin", runs["before"], "--out", out)
    assert code == 2
    assert out.read_bytes() == b"kept"
