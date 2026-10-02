"""`walkthrough` call moments: callbacks from unrecorded code, and the extent of a call that ends in a tail call.

The program is `test/unit/fixtures/walkthrough-calls/`. `runner.py` stands in for LangGraph or the
agents SDK: excluded from the recording, it calls the program's functions back from five frames
down, deeper than the tracer looks for a caller, so the recorded parent of `double` and `inc` is the
module, not `ask`. This file writes `walkthrough-calls-run.json` and `walkthrough-calls-moments.json`
under PYOKKA_WRITE_FIXTURES=1; `test/unit/walkthroughCalls.test.ts` must build the same moments.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main

from conftest import ROOT

FIXTURES = ROOT / "test" / "unit" / "fixtures"
PROGRAM = FIXTURES / "walkthrough-calls"
RUN_JSON = FIXTURES / "walkthrough-calls-run.json"
MOMENTS_JSON = FIXTURES / "walkthrough-calls-moments.json"
FIXTURE_ROOT = "/fixture"


def pyokka_json(*args: str) -> dict:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main([str(a) for a in args] + ["--json"])
    doc = json.loads(buf.getvalue())
    assert code == 0, doc
    return doc


def normalize(text: str, root: str) -> str:
    text = re.sub(r"[0-9a-f]{16}\.jsonl", "0000000000000000.jsonl", text.replace(root, FIXTURE_ROOT))
    return re.sub(r"0x[0-9a-f]+", "0x0", text)


@pytest.fixture
def doc(tmp_path: Path) -> dict:
    proj = tmp_path / "proj"
    proj.mkdir()
    for name in ("main.py", "runner.py"):
        shutil.copy(PROGRAM / name, proj / name)
    out = tmp_path / "run.json"
    buf = io.StringIO()
    with redirect_stdout(buf):
        assert main(["run", str(proj / "main.py"), "--save", str(out), "--exclude", "runner", "--auto-log"]) == 0, buf.getvalue()
    run = json.loads(out.read_text(encoding="utf-8"))
    run["meta"].update(durationMs=12.0, runtimeVersion="0.0.1", python="3.x", executable=FIXTURE_ROOT + "/bin/python", runId="fixture", started="2026-10-01T00:00:00+00:00")  # the end moment's text carries durationMs
    out.write_text(json.dumps(run), encoding="utf-8")
    result = pyokka_json("walkthrough", str(out))
    root = str(proj.resolve())
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        MOMENTS_JSON.write_text(normalize(json.dumps(result["moments"], ensure_ascii=False, indent=1), root) + "\n", encoding="utf-8")
        RUN_JSON.write_text(normalize(out.read_text(encoding="utf-8"), root) + "\n", encoding="utf-8")
    assert json.loads(normalize(json.dumps(result["moments"]), root)) == json.loads(MOMENTS_JSON.read_text(encoding="utf-8"))
    return result


def by_callee(doc: dict) -> dict[str, dict]:
    return {m["callee"]["function"]: m for m in doc["moments"] if m["kind"] in ("call", "tool")}


def test_a_callback_from_unrecorded_code_is_filed_at_its_entry_under_the_function_that_was_running(doc):
    moments = by_callee(doc)
    ask = moments["ask"]
    for name in ("double", "inc"):
        m = moments[name]
        assert m["kind"] == "tool", m
        assert m["step"] == m["entryStep"], m  # not the `main()` statement of the module
        assert (m["location"]["function"], m["location"]["line"]) == (name, 3 if name == "double" else 6)
        assert m["callerScopeId"] == ask["scopeId"], m
        assert m["text"] == "callback into %s from ask" % name, m["text"]
        assert ask["entryStep"] < m["step"] <= ask["endStep"]


def test_a_direct_call_keeps_its_call_site(doc):
    m = by_callee(doc)["ask"]
    assert m["kind"] == "call" and m["step"] < m["entryStep"] and m["location"]["function"] == "main"
    assert "callerScopeId" not in m


def test_a_call_ending_in_a_tail_call_ends_after_the_callee(doc):
    moments = by_callee(doc)
    outer, inner = moments["outer"], moments["inner"]
    assert outer["endStep"] == inner["endStep"] and inner["endStep"] > inner["entryStep"]  # `return inner(x)`
    # main's last statement is `print(rank(...))`: its extent covers rank too
    assert moments["main"]["endStep"] == moments["rank"]["endStep"] > moments["rank"]["entryStep"]


def test_a_lambda_shows_no_out_rather_than_the_value_of_the_statement_that_called_it(doc):
    """The run has Auto Log on, so `ranked = sorted(..., key=lambda kv: kv[1])` logs the sorted list on the call site."""
    lambdas = [m for m in doc["moments"] if m["kind"] == "call" and m["callee"]["function"] == "<lambda>"]
    assert len(lambdas) == 2
    assert all([v for v in m["values"] if v["role"] == "out"] == [] for m in lambdas), lambdas
    assert any(m["kind"] == "value" and m["text"].startswith("ranked = [") for m in doc["moments"])
