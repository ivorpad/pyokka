"""The ``pyokka_review`` MCP tool answers what ``pyokka review`` prints, refusals as ``isError`` with the same
lines; the server lists one prompt, ``review``, and serves it from the skill's reference or the built-in method.

The repository, the started review and the fakes come from ``test_review_actions.py``.
"""

from __future__ import annotations

import io
import json
import socket
from contextlib import redirect_stderr, redirect_stdout

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.mcp import call_tool, handle
from pyokka_runtime.agent.mcp_tools import tool_definitions
from pyokka_runtime.agent.review import start as review_start
from pyokka_runtime.agent.review import surfaces as real_surfaces
from pyokka_runtime.agent.review import tool as review_tool
from pyokka_runtime.agent.review import view as review_view
from pyokka_runtime.agent.review.state import ACTIONS, Refusal, Review
from tests.test_review_actions import fakes, fresh, shop, started  # noqa: F401  pytest fixtures

import pytest


@pytest.fixture(scope="module", autouse=True)
def _never_launch_vscode():
    """Module scope, so it is in place before the module-scoped ``started`` runs its ``start``: conftest's guards
    are function-scoped and come too late for it. A start in this file opens no editor and no page."""
    from pyokka_runtime.agent import debug_start
    from pyokka_runtime.agent.source import AgentError

    def refuse(*_a, **_k):
        raise AgentError("tests never launch VS Code")

    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("PYOKKA_REVIEW_SURFACE", "chat")
        mp.setenv("PYOKKA_CODE", "/usr/bin/false")
        mp.setattr(review_view, "open_vscode", refuse)
        mp.setattr(debug_start, "open_url", refuse)
        mp.setattr(debug_start, "open_debug_session", refuse)
        yield

FIELDS = ("action", "base", "repo", "entry", "test", "pr", "python", "dir", "args", "n", "say", "go_on", "why", "surface", "port", "session", "line", "code", "expr", "inputs", "mocks", "edge", "title", "file", "severity", "step", "repro", "expect", "fix", "patch", "tests", "out", "page", "tour", "json")


def cli(*args: object) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main([str(a) for a in args])
    return code, out.getvalue(), err.getvalue()


def test_the_tool_is_listed_with_the_contract_fields():
    tool = next(t for t in tool_definitions() if t["name"] == "pyokka_review")
    schema = tool["inputSchema"]
    assert set(schema["properties"]) == set(FIELDS)
    assert schema["properties"]["action"]["enum"] == list(ACTIONS) and schema["required"] == ["action"]
    assert schema["properties"]["severity"]["enum"] == ["blocker", "major", "minor"] and schema["properties"]["surface"]["enum"] == ["auto", "page", "vscode", "chat"]
    conditions = {json.dumps(c["if"]["properties"]["action"], sort_keys=True): c["then"]["required"] for c in schema["allOf"]}
    assert conditions[json.dumps({"enum": ["stop", "ask"]}, sort_keys=True)] == ["say"]
    assert conditions[json.dumps({"const": "finding"}, sort_keys=True)] == ["repro"]  # step is left out only for a line head never ran; the action checks it
    assert conditions[json.dumps({"const": "start"}, sort_keys=True)] == ["base"]
    assert conditions[json.dumps({"const": "skip"}, sort_keys=True)] == ["n", "why"] and conditions[json.dumps({"const": "look"}, sort_keys=True)] == ["expr"]
    assert "skip" in ACTIONS and "look" in ACTIONS and schema["properties"]["go_on"]["type"] == "boolean"
    assert "next:" in tool["description"] and tool["annotations"]["openWorldHint"] is True


def test_the_tool_answers_what_the_cli_prints(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    res = call_tool("pyokka_review", {"action": "state", "dir": str(r.dir)})
    code, out, err = cli("review", "state", "--dir", r.dir)
    assert res["isError"] is False and code == 0 and res["content"][0]["text"] == out
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "nothing named here", "dir": str(r.dir)})
    code, out, err = cli("review", "stop", "1", "--say", "nothing named here", "--dir", r.dir)
    assert res["isError"] is True and code == 2 and res["content"][0]["text"] == err
    step = Review.load(str(r.dir)).stop(1)["step_b"]
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "the raise is at step %d" % step, "surface": "chat", "dir": str(r.dir)})
    lines = res["content"][0]["text"].rstrip("\n").split("\n")
    assert res["isError"] is False and lines[0].startswith("review shop-") and "stops 1/2 shown" in lines[0] and lines[-1] == "next: wait for the person; when they say next, review stop 2 --say TEXT --go-on"
    res = call_tool("pyokka_review", {"action": "stop", "n": 2, "say": "unit_price = '1,249.00'", "surface": "chat", "dir": str(r.dir)})
    assert res["isError"] is True and "refused: the person has not spoken since stop 1" in res["content"][0]["text"]
    res = call_tool("pyokka_review", {"action": "look", "expr": "len(lines)", "dir": str(r.dir)})
    text = res["content"][0]["text"]
    assert res["isError"] is False and "look len(lines)  at step %d  shopkit/pricing.py:12 subtotal" % step in text and "recorded values it names:" in text and "lines = [Line(sku='MON-27'" in text
    res = call_tool("pyokka_review", {"action": "stop", "n": 2, "say": "unit_price = '1,249.00'", "surface": "chat", "dir": str(r.dir), "go_on": True})
    assert res["isError"] is False and "stops 2/2 shown" in res["content"][0]["text"]
    res = call_tool("pyokka_review", {"action": "skip", "n": 1, "dir": str(r.dir)})
    assert res["isError"] is True and "refused: stop 1 was shown already; nothing to skip" in res["content"][0]["text"]
    # the tool's `code` is the Python text itself, and json gives the raw shape
    res = call_tool("pyokka_review", {"action": "try", "code": "x = 2\nresult = x + 3", "title": "inline code", "dir": str(r.dir)})
    assert res["isError"] is False and "    result: 5" in res["content"][0]["text"]
    res = call_tool("pyokka_review", {"action": "state", "dir": str(r.dir), "json": True})
    doc = json.loads(res["content"][0]["text"])
    assert res["isError"] is False and doc["kind"] == "review" and doc["tries"][0]["code"] == "x = 2\nresult = x + 3\n"
    res = call_tool("pyokka_review", {"action": "stop", "n": 9, "say": "x", "dir": str(r.dir), "json": True})
    assert res["isError"] is True and json.loads(res["content"][0]["text"])["error"] == "stop 9 is not in the plan"
    # what the schema requires, the action refuses too, with the review's lines
    res = call_tool("pyokka_review", {"action": "ask", "line": "shopkit/discounts.py:16", "dir": str(r.dir)})
    assert res["isError"] is True and "refused: --say is empty" in res["content"][0]["text"]
    res = call_tool("pyokka_review", {"action": "finding", "dir": str(r.dir), "file": "shopkit/money.py", "line": 14})
    assert res["isError"] is True and "refused: finding add needs --severity, --title, --repro, --fix" in res["content"][0]["text"]
    res = call_tool("pyokka_review", {"action": "nonsense"})
    assert res["isError"] is True and res["content"][0]["text"].split("\n")[1] == "refused: unknown review action 'nonsense'"


def test_tools_call_reaches_the_tool_and_initialize_announces_prompts(tmp_path):
    missing = tmp_path / "no-review"
    reply = handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "pyokka_review", "arguments": {"action": "state", "dir": str(missing)}}})
    text = reply["result"]["content"][0]["text"]
    assert reply["result"]["isError"] is True and text.startswith("review (none) · no review started") and "refused: no review in %s" % missing in text
    assert text.rstrip("\n").endswith("next: review start --base REF")
    init = handle({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
    assert init["result"]["capabilities"]["prompts"] == {"listChanged": False} and "pyokka_review" in init["result"]["instructions"]


def test_prompts_list_and_get(tmp_path, monkeypatch):
    listed = handle({"jsonrpc": "2.0", "id": 3, "method": "prompts/list"})
    assert [p["name"] for p in listed["result"]["prompts"]] == ["review"] and listed["result"]["prompts"][0]["arguments"] == []
    got = handle({"jsonrpc": "2.0", "id": 4, "method": "prompts/get", "params": {"name": "review"}})
    message = got["result"]["messages"][0]
    assert message["role"] == "user" and message["content"]["type"] == "text" and 5 <= len(message["content"]["text"].strip().split("\n")) <= 60
    assert handle({"jsonrpc": "2.0", "id": 5, "method": "prompts/get", "params": {"name": "other"}})["error"]["code"] == -32602
    assert handle({"jsonrpc": "2.0", "id": 6, "method": "resources/list"})["result"] == {"resources": []}
    # the skill's reference, first section only: the intro when there is one, else the first heading's section
    md = tmp_path / "review.md"
    md.write_text("# Review\n\nRun it, do not only read it.\nOne stop per message.\n\n## 1. Scope\n\nlater\n")
    assert review_tool.prompt_text(str(md)) == "Run it, do not only read it.\nOne stop per message.\n"
    md.write_text("# Review\n\n## Method\n\n- a\n- b\n\n## Next\n\nc\n")
    assert review_tool.prompt_text(str(md)) == "## Method\n\n- a\n- b\n"
    # no file (an installed extension ships no skills/): the built-in method, which names every command
    monkeypatch.setattr(review_tool, "REVIEW_MD", str(tmp_path / "missing.md"))
    text = handle({"jsonrpc": "2.0", "id": 7, "method": "prompts/get", "params": {"name": "review"}})["result"]["messages"][0]["content"]["text"]
    assert text == review_tool.BUILTIN_PROMPT and 8 <= len(text.strip().split("\n")) <= 20
    for word in ("start --base REF", "stop N --say TEXT", "ask FILE:LINE", "try --expr EXPR", "finding add", "fix --patch", "report", "next:"):
        assert word in text, word


# -- surfaces: an asked view that is not there is refused, auto says it fell to chat --------------------------------------

NO_SESSION = {"surface": "chat", "moved": False, "available": False, "note": "no live VS Code session on main.py; start one on the entry"}


def test_an_asked_view_with_nothing_answering_is_refused_and_the_stop_stays_unshown(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    step = Review.load(str(r.dir)).stop(1)["step_b"]
    entry = "%s/main.py" % r.repo
    fakes.answer = NO_SESSION
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "the raise is at step %d" % step, "surface": "vscode", "dir": str(r.dir)})
    text = res["content"][0]["text"]
    assert res["isError"] is True and "stops 0/2 shown" in text.split("\n")[0]
    assert "refused: surface vscode is not available, so nothing was shown: no live VS Code session on main.py" in text
    nxt = text.rstrip("\n").split("\n")[-1]
    assert nxt.startswith("next: pyokka debug %s --record --cwd %s (MCP: pyokka_debug {\"action\": \"start\", \"file\": \"%s\", \"record\": true, \"cwd\": \"%s\"})" % (entry, r.repo, entry, r.repo))
    assert "pyokka.agentAccess" in nxt and "the code command (" in nxt and nxt.endswith("then review stop 1 --say TEXT --surface vscode")
    review = Review.load(str(r.dir))
    assert review.waiting is None and 1 in review.remaining() and not review.data["said"]
    # the page: refused the same way, and an ask leaves no trace
    fakes.answer = {"surface": "page", "moved": False, "available": False, "note": "no Pyokka page answers on 127.0.0.1:4790"}
    res = call_tool("pyokka_review", {"action": "ask", "line": "shopkit/discounts.py:16", "say": "rate starts at 0.0", "surface": "page", "port": 4790, "dir": str(r.dir)})
    text = res["content"][0]["text"]
    assert res["isError"] is True and "refused: surface page is not available, so nothing was shown: no Pyokka page answers on 127.0.0.1:4790" in text
    assert 'pyokka web %s --cwd %s (MCP: pyokka_page {"action": "open"' % (entry, r.repo) in text and text.rstrip("\n").endswith("then review ask shopkit/discounts.py:16 --say TEXT --surface page")
    assert not Review.load(str(r.dir)).asked


def test_a_view_that_answered_but_missed_the_stop_is_shown_and_auto_says_it_fell_to_chat(started, tmp_path, fakes):
    r = fresh(started, tmp_path)
    step = Review.load(str(r.dir)).stop(1)["step_b"]
    # the session was there and the program ended first: its own note says what reaches the stop, no refusal
    fakes.answer = {"surface": "vscode-debug", "moved": False, "note": "the program ended (exit 0) without reaching pricing.py:12"}
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "the raise is at step %d" % step, "surface": "vscode", "dir": str(r.dir)})
    assert res["isError"] is False and "stops 1/2 shown" in res["content"][0]["text"]
    # auto with nothing answering shows the stop in chat, and next: says so and what starts VS Code
    fakes.answer = None
    res = call_tool("pyokka_review", {"action": "stop", "n": 2, "say": "unit_price = '1,249.00'", "dir": str(r.dir), "go_on": True})
    nxt = res["content"][0]["text"].rstrip("\n").split("\n")[-1]
    assert res["isError"] is False and "the person saw this stop only in chat" in nxt and "MCP: pyokka_debug" in nxt
    res = call_tool("pyokka_review", {"action": "ask", "line": "shopkit/discounts.py:16", "say": "rate starts at 0.0 and only a spend above a threshold raises it", "dir": str(r.dir)})
    nxt = res["content"][0]["text"].rstrip("\n").split("\n")[-1]
    assert res["isError"] is False and nxt.startswith("next: wait for the person; they saw this only in chat") and "MCP: pyokka_debug" in nxt
    # surface chat is the agent's choice: next: stays plain
    r2 = fresh(started, tmp_path, "chat")
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "the raise is at step %d" % step, "surface": "chat", "dir": str(r2.dir)})
    assert "only in chat" not in res["content"][0]["text"]
    # a recording of another run: the view line names the run to start, and next: does not say it again
    r3 = fresh(started, tmp_path, "mismatch")
    fakes.answer = {"surface": "chat", "moved": False, "available": False, "note": "the VS Code recording on main.py is another run: 217 steps, the review's head run has 507; start one as the review recorded it: pyokka debug main.py --record (MCP: pyokka_debug {}); then stop again with the same n"}
    res = call_tool("pyokka_review", {"action": "ask", "line": "shopkit/discounts.py:16", "say": "rate starts at 0.0", "dir": str(r3.dir)})
    text = res["content"][0]["text"]
    assert res["isError"] is False and "view: chat (not moved): the VS Code recording on main.py is another run: 217 steps" in text
    nxt = text.rstrip("\n").split("\n")[-1]
    assert nxt == "next: wait for the person; they saw this only in chat, so answer in your message; the view line names the run to start in VS Code"


def test_a_review_of_one_test_is_never_told_to_record_the_file(started, tmp_path, fakes):
    """The field case: told "no live VS Code session on test_x.py" and given `pyokka debug FILE --record`, the agent
    recorded the test file as a program (217 steps against the review's 507) and the stops moved a Time Machine of another run."""
    r = fresh(started, tmp_path)
    data = json.loads((r.dir / "review.json").read_text())
    data["test"] = "tests/test_pricing.py::Pricing.test_subtotal"
    (r.dir / "review.json").write_text(json.dumps(data))
    step = Review.load(str(r.dir)).stop(1)["step_b"]
    fakes.answer = NO_SESSION
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "the raise is at step %d" % step, "surface": "vscode", "dir": str(r.dir)})
    text = res["content"][0]["text"]
    assert res["isError"] is True and "refused: surface vscode is not available, so nothing was shown: a review of one test (tests/test_pricing.py::Pricing.test_subtotal) has no recording session in VS Code and no page" in text
    assert "a review of one test stays in chat: pass surface chat (or auto)" in text and "--record" not in text and "--cwd" not in text and "pyokka_debug" not in text
    assert text.rstrip("\n").endswith("next: review stop 1 --say TEXT --surface chat") and not Review.load(str(r.dir)).data["said"]
    res = call_tool("pyokka_review", {"action": "ask", "line": "shopkit/discounts.py:16", "say": "rate starts at 0.0", "surface": "page", "dir": str(r.dir)})
    text = res["content"][0]["text"]
    assert res["isError"] is True and "surface page is not available, so nothing was shown: a review of one test" in text and "pyokka_page" not in text and "--cwd" not in text
    assert text.rstrip("\n").endswith("next: review ask shopkit/discounts.py:16 --say TEXT --surface chat")
    # auto shows the stop in chat, and next: does not send the agent to start VS Code on the file
    fakes.answer = None
    res = call_tool("pyokka_review", {"action": "stop", "n": 1, "say": "the raise is at step %d" % step, "dir": str(r.dir)})
    nxt = res["content"][0]["text"].rstrip("\n").split("\n")[-1]
    assert res["isError"] is False and nxt.endswith("the person saw this stop only in chat, so explain it in your message; a review of one test stays in chat")
    assert "To show the next one" not in nxt and "pyokka_debug" not in nxt
    res = call_tool("pyokka_review", {"action": "ask", "line": "shopkit/discounts.py:16", "say": "rate starts at 0.0", "dir": str(r.dir)})
    nxt = res["content"][0]["text"].rstrip("\n").split("\n")[-1]
    assert nxt == "next: wait for the person; they saw this only in chat, so answer in your message; a review of one test stays in chat"
    tool = next(t for t in tool_definitions() if t["name"] == "pyokka_review")
    assert "a review of one test has neither view and stays in chat" in tool["description"]
    assert "A review of one test has neither view" in tool["inputSchema"]["properties"]["surface"]["description"] and "stays in chat" in tool["inputSchema"]["properties"]["test"]["description"]


def test_the_notes_and_the_start_lines_name_both_forms():
    head = {"meta": {"file": "/w/demo.py", "workspaceRoot": "/w"}}
    note = real_surfaces.no_session_note(None, head)
    assert note.startswith('no live VS Code session on demo.py; start one on the entry: pyokka debug /w/demo.py --record --cwd /w (MCP: pyokka_debug {"action": "start", "file": "/w/demo.py", "record": true, "cwd": "/w"})')
    assert "pyokka.agentAccess" in note and note.endswith("then stop again with the same n")
    vs, page = review_view.start_hints("/w/demo.py", "/w")
    assert page == 'pyokka web /w/demo.py --cwd /w (MCP: pyokka_page {"action": "open", "file": "/w/demo.py", "cwd": "/w"}), then open its URL in one browser tab'
    state, lines = review_view.open_view({"repo": "/w", "entry": "demo.py"}, {"surface": "chat"})
    assert state == {"kind": "chat"} and "pyokka debug /w/demo.py --record --cwd /w (MCP: pyokka_debug" in lines[0] and "pyokka web /w/demo.py --cwd /w (MCP: pyokka_page" in lines[0]
    tool = next(t for t in tool_definitions() if t["name"] == "pyokka_review")
    assert "refused when nothing answers" in tool["inputSchema"]["properties"]["surface"]["description"] and "pyokka.agentAccess" in tool["inputSchema"]["properties"]["surface"]["description"]
    assert "surface vscode or page with nothing answering is refused" in tool["description"]


def test_start_on_a_taken_port_is_refused_before_recording(shop, tmp_path, monkeypatch):
    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    taken = socket.socket()
    taken.bind(("127.0.0.1", 0))
    taken.listen(1)
    port = taken.getsockname()[1]
    called = []
    monkeypatch.setattr(review_start, "_record", lambda *a, **k: called.append(a))
    try:
        res = call_tool("pyokka_review", {"action": "start", "base": shop.base, "repo": str(shop.repo), "dir": str(tmp_path / "review"), "surface": "page", "port": port})
    finally:
        taken.close()
    text = res["content"][0]["text"]
    assert res["isError"] is True and "refused: surface page needs a free port and %d is taken" % port in text and not called
    assert text.rstrip("\n").endswith("next: review start --base REF --surface page --port N with a free N, or --surface vscode")
    review_start._check_view({"surface": "chat", "port": port})  # chat and vscode need no port
    try:
        review_start._check_view({"surface": "page", "port": port})
    except Refusal as exc:
        raise AssertionError("the port is free again: %s" % exc.why) from None


def test_start_with_surface_vscode_and_no_vscode_to_reach_is_refused_before_recording(shop, tmp_path, monkeypatch):
    from pyokka_runtime.agent import debug_start, live
    from pyokka_runtime.agent.source import AgentError

    monkeypatch.setenv("PYOKKA_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(live, "SESSIONS_ENV", "PYOKKA_TEST_NO_SESSIONS")
    monkeypatch.setenv("PYOKKA_TEST_NO_SESSIONS", str(tmp_path / "no-sessions"))

    def missing():
        raise AgentError("no code command")

    monkeypatch.setattr(debug_start, "code_command", missing)
    called = []
    monkeypatch.setattr(review_start, "_record", lambda *a, **k: called.append(a))
    res = call_tool("pyokka_review", {"action": "start", "base": shop.base, "repo": str(shop.repo), "dir": str(tmp_path / "review"), "surface": "vscode"})
    text = res["content"][0]["text"]
    assert res["isError"] is True and not called
    assert "refused: surface vscode needs VS Code: no live Pyokka session answers and the code command was not found" in text
    assert "pyokka debug %s/main.py --record --cwd %s (MCP: pyokka_debug" % (shop.repo, shop.repo) in text and "pyokka.agentAccess" in text
    assert text.rstrip("\n").endswith("next: review start --base REF --surface page, or --surface chat")
