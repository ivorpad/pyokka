"""The workflow and history verbs refuse what they cannot do, before the work, and name the next call.

Each refusal reads the same over MCP and the CLI, so the hint carries both forms with the run's
real path.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pyokka_runtime.agent.mcp import call_tool
from tests.test_workflows import PORT, pyokka, record


def tool(name: str, arguments: dict) -> tuple[bool, str]:
    res = call_tool(name, arguments)
    return res["isError"], res["content"][0]["text"].strip()


@pytest.fixture
def cart(tmp_path: Path) -> dict[str, Path]:
    (tmp_path / ".git").mkdir()
    app = tmp_path / "cart.py"
    return {"app": app, "before": record(PORT / "cart_unfixed.py", app, tmp_path / "before.json")}


def test_investigate_refuses_a_value_the_run_never_bound(tmp_path: Path):
    app = tmp_path / "boom.py"
    app.write_text("total = 1\nratio = total / 0\n")
    run = tmp_path / "run.json"
    pyokka("run", app, "--save", run)
    is_error, text = tool("pyokka_investigate", {"run": str(run), "value": "totl"})
    assert is_error and "nothing recorded for totl" in text
    assert '"action": "find", "run": %s, "text": "totl"' % json.dumps(str(run)) in text
    assert "ZeroDivisionError" not in text
    is_error, text = tool("pyokka_investigate", {"run": str(run)})  # no value: the first exception, as before
    assert not is_error and "ZeroDivisionError" in text


def test_learn_refuses_prediction_without_at_and_a_step_that_is_no_checkpoint(cart: dict[str, Path]):
    run = str(cart["before"])
    is_error, text = tool("pyokka_learn", {"run": run, "prediction": "14"})
    assert is_error and "need --at STEP" in text and '"at": STEP' in text and "#" in text
    is_error, text = tool("pyokka_learn", {"run": run, "reveal": True})
    assert is_error and "need --at STEP" in text
    is_error, text = tool("pyokka_learn", {"run": run, "at": 99999})
    assert is_error and "is not a checkpoint" in text and "checkpoints: #" in text
    is_error, listing = tool("pyokka_learn", {"run": run})
    assert not is_error and "reveal: true" in listing
    first = json.loads(call_tool("pyokka_learn", {"run": run, "json": True})["content"][0]["text"])["checkpoints"][0]["step"]
    is_error, hidden = tool("pyokka_learn", {"run": run, "at": first, "prediction": "1"})
    assert not is_error and '"reveal": true' in hidden


def test_learn_reveal_without_prediction_shows_values_and_names_a_print(cart: dict[str, Path]):
    code, out = pyokka("learn", cart["before"], "--json")
    printed = next(c for c in json.loads(out)["checkpoints"] if c["kind"] == "print")
    code, text = pyokka("learn", cart["before"], "--at", printed["step"], "--reveal")
    assert code == 0 and "printed = 14" in text and " None = " not in text


def test_verify_refuses_an_existing_test_out_before_the_rerun(cart: dict[str, Path], tmp_path: Path):
    existing = tmp_path / "test_kept.py"
    existing.write_text("kept\n")
    out = tmp_path / "rerun.json"
    is_error, text = tool("pyokka_verify", {"run": str(cart["before"]), "rerun": True, "out": str(out), "expect": ["total=22"], "test_out": str(existing)})
    assert is_error and "%s already exists" % existing in text
    assert not out.exists() and existing.read_text() == "kept\n"


def test_verify_missing_after_names_the_baseline_file_and_offers_rerun(cart: dict[str, Path], tmp_path: Path):
    missing = tmp_path / "nope.json"
    is_error, text = tool("pyokka_verify", {"run": str(cart["before"]), "after": str(missing)})
    assert is_error and "pyokka run %s --save %s" % (cart["app"], missing) in text and '"rerun": true' in text


def test_verify_failure_names_the_next_command_and_the_real_http(cart: dict[str, Path], tmp_path: Path):
    test_out = tmp_path / "test_reg.py"
    is_error, text = tool("pyokka_verify", {"run": str(cart["before"]), "rerun": True, "expect": ["total=22"], "test_out": str(test_out)})
    assert is_error and "FAIL total = 14" in text
    assert "HTTP was not replayed" in text
    assert "it fails until they hold" in text and test_out.exists()
    last = text.splitlines()[-1]
    assert last.startswith("not verified: fix the code") and "pyokka verify %s --rerun --expect total=22" % cart["before"] in last
    assert '"expect": ["total=22"]' in last


def test_pin_into_a_missing_directory_names_it(cart: dict[str, Path], tmp_path: Path):
    is_error, text = tool("pyokka_pin", {"run": str(cart["before"]), "out": str(tmp_path / "gone" / "b.json")})
    assert is_error and "(%s is not)" % (tmp_path / "gone") in text


def test_history_refuses_pause_on_a_saved_run_and_an_out_that_is_not_a_page(cart: dict[str, Path], tmp_path: Path):
    run = cart["before"]
    original = run.read_bytes()
    code, _ = pyokka("history", run, "--pause", "--out", tmp_path / "h.json")
    assert code == 2 and not (tmp_path / "h.json").exists()
    is_error, text = tool("pyokka_history", {"run": str(run), "at": ["0"], "out": str(run)})
    assert is_error and "the run this page reads" in text and run.read_bytes() == original
    other = tmp_path / "other.json"
    other.write_text('{"not": "a page"}\n')
    is_error, text = tool("pyokka_history", {"run": str(run), "at": ["0"], "out": str(other)})
    assert is_error and "not a code-history page" in text and "other.history.json" in text
    page = tmp_path / "page.json"
    assert not tool("pyokka_history", {"run": str(run), "at": ["0"], "out": str(page)})[0]
    assert not tool("pyokka_history", {"run": str(run), "at": ["0"], "out": str(page)})[0]  # a page is rewritten as before


def test_history_pause_hint_names_the_mcp_form():
    from pyokka_runtime.agent.codehistory import Builder

    class Unpaused:
        def context(self, **_):
            return {}

    builder = Builder.__new__(Builder)
    builder.source, builder.scope = Unpaused(), False
    from pyokka_runtime.agent.source import AgentError

    with pytest.raises(AgentError) as exc:
        builder.pause()
    assert 'pyokka_debug {"action": "break", "at": ["FILE:LINE"]}' in exc.value.hint
