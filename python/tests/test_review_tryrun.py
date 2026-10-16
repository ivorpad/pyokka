"""`review try`: a reproduction on the page's Scratchpad when a page shows the review's tree, else in the headless sandbox."""

from __future__ import annotations

from pathlib import Path

from pyokka_runtime.agent.review.tryrun import entry_file, inputs_source, mocks_source, run_try
from tests.test_review_surfaces import FakePage, closed_port

SHOP_HEAD = Path(__file__).resolve().parent / "fixtures" / "review" / "shop_head"
BOUNDARY = "from shopkit.config import DEFAULT\nfrom shopkit.discounts import spend_tier_rate\nresult = spend_tier_rate(500.0, DEFAULT)\nabove = spend_tier_rate(500.01, DEFAULT)\n"


def test_inputs_and_mocks_accept_source_text_or_objects():
    assert inputs_source(None) == "" and inputs_source("n = 1\n") == "n = 1\n"
    assert inputs_source({"items": "[1, 2]", "rate": "0.5"}) == "items = [1, 2]\nrate = 0.5\n"
    assert mocks_source(None) == "" and mocks_source("{'a.b': 1}") == "{'a.b': 1}" and mocks_source({}) == ""
    assert mocks_source({"shop.fetch_price": "9.5", "time.sleep": "None"}) == "{'shop.fetch_price': 9.5, 'time.sleep': None}"


def test_the_sandbox_runs_beside_the_entry_at_the_repo_root(tmp_path: Path):
    assert entry_file(str(SHOP_HEAD)) == str(SHOP_HEAD / "main.py")
    (tmp_path / "tool.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("y = 2\n", encoding="utf-8")
    assert entry_file(str(tmp_path)) == str(tmp_path / "app.py")  # no main.py: the first .py at the root
    assert entry_file(str(tmp_path / "tool.py")) == str(tmp_path / "tool.py")
    assert entry_file(str(tmp_path / "empty")) is None
    (tmp_path / "empty").mkdir()
    assert entry_file(str(tmp_path / "empty")) is None


def test_a_headless_try_imports_the_head_tree_and_reports_values():
    bytecode_before = set(SHOP_HEAD.rglob("*.pyc"))
    out = run_try(BOUNDARY, None, None, str(SHOP_HEAD), 0)
    assert set(SHOP_HEAD.rglob("*.pyc")) == bytecode_before  # the sandbox child runs with -B: nothing is written inside the tree under review
    assert (out["surface"], out["result"], out["error"], out["output"]) == ("sandbox", "0.0", None, "")
    assert [(v["name"], v["value"], v["text"]) for v in out["values"]] == [("result", "0.0", "0.0"), ("above", "0.05", "0.05")]  # the tier starts above 500, not at it
    assert out["file"] == str(SHOP_HEAD / "main.py") and out["sandbox"]["network"] in ("denied", "open")
    failed = run_try("result = parse_money('1,249.00')\n", {"n": "1"}, None, str(SHOP_HEAD), 0)
    assert failed["surface"] == "sandbox" and failed["result"] is None
    assert (failed["error"]["type"], failed["error"]["line"]) == ("NameError", 1) and "parse_money" in failed["error"]["message"]


def test_without_a_file_to_run_beside_the_try_says_so(tmp_path: Path):
    out = run_try("result = 1\n", None, None, str(tmp_path), 0)
    assert out["surface"] == "sandbox" and out["error"]["type"] == "ScratchError" and "no Python file at the root" in out["error"]["message"]


def _experiment_reply(body: dict) -> dict:
    return {"result": {"id": "s1", "title": body.get("title") or "Untitled experiment", "status": "completed", "error": None, "result": {"values": [{"name": "result", "line": 3, "value": "0.0", "type": "float"}], "result": "0.0", "output": "tier 0\n", "error": None}}}


def test_a_page_on_the_review_tree_runs_the_experiment_so_the_person_sees_it():
    page = FakePage({"url": "http://127.0.0.1/", "file": str(SHOP_HEAD / "main.py"), "pages": 1, "state": {}}, reply=_experiment_reply)
    try:
        out = run_try(BOUNDARY, {"n": "1"}, None, str(SHOP_HEAD), page.port, title="E1 boundary")
        assert (out["surface"], out["result"], out["output"], out["error"], out["status"], out["id"]) == ("page", "0.0", "tier 0\n", None, "completed", "s1")
        assert out["values"] == [{"name": "result", "line": 3, "value": "0.0", "type": "float", "text": "0.0"}]
        assert page.requests == [{"action": "scratchpad", "op": "experiment", "code": BOUNDARY, "inputs": "n = 1\n", "title": "E1 boundary"}]
    finally:
        page.close()


def test_a_page_on_another_tree_or_without_a_tab_leaves_the_try_headless():
    elsewhere = FakePage({"url": "http://127.0.0.1/", "file": "/somewhere/else/main.py", "pages": 1, "state": {}}, reply=_experiment_reply)
    try:
        out = run_try("result = 2 + 2\n", None, None, str(SHOP_HEAD), elsewhere.port)
        assert (out["surface"], out["result"]) == ("sandbox", "4") and elsewhere.requests == []
    finally:
        elsewhere.close()
    no_tab = FakePage({"url": "http://127.0.0.1/", "file": str(SHOP_HEAD / "main.py"), "pages": 0, "state": None, "error": "no page is open"}, reply=_experiment_reply)
    try:
        out = run_try("result = 2 + 2\n", None, None, str(SHOP_HEAD), no_tab.port)
        assert (out["surface"], out["result"]) == ("sandbox", "4") and no_tab.requests == []
    finally:
        no_tab.close()
    out = run_try("result = 2 + 2\n", None, None, str(SHOP_HEAD), closed_port())
    assert (out["surface"], out["result"]) == ("sandbox", "4")


def test_a_page_that_refuses_or_does_not_complete_is_reported():
    refusing = FakePage({"url": "http://127.0.0.1/", "file": str(SHOP_HEAD / "main.py"), "pages": 1, "state": {}}, reply={"result": None, "error": "a page command is still pending"}, status=409)
    try:
        out = run_try("result = 2 + 2\n", None, None, str(SHOP_HEAD), refusing.port)
        assert (out["surface"], out["result"]) == ("sandbox", "4")
        assert out["note"] == "the page on port %d refused the experiment (a page command is still pending); ran headless" % refusing.port
    finally:
        refusing.close()
    broken = FakePage({"url": "http://127.0.0.1/", "file": str(SHOP_HEAD / "main.py"), "pages": 1, "state": {}}, reply={"result": {"id": "s2", "title": "t", "status": "error", "error": "boom", "result": None}})
    try:
        out = run_try("result = 2 + 2\n", None, None, str(SHOP_HEAD), broken.port)
        assert out["surface"] == "page" and out["result"] is None
        assert out["error"] == {"type": "ScratchError", "message": "boom", "stage": "page"}
    finally:
        broken.close()
