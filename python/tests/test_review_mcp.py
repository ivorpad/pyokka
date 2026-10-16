"""The ``pyokka_review`` MCP tool answers what ``pyokka review`` prints, refusals as ``isError`` with the same
lines; the server lists one prompt, ``review``, and serves it from the skill's reference or the built-in method.

The repository, the started review and the fakes come from ``test_review_actions.py``.
"""

from __future__ import annotations

import io
import json
from contextlib import redirect_stderr, redirect_stdout

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.mcp import call_tool, handle
from pyokka_runtime.agent.mcp_tools import tool_definitions
from pyokka_runtime.agent.review import tool as review_tool
from pyokka_runtime.agent.review.state import ACTIONS, Review
from tests.test_review_actions import fakes, fresh, shop, started  # noqa: F401  pytest fixtures

FIELDS = ("action", "base", "repo", "entry", "test", "pr", "python", "dir", "args", "n", "say", "go_on", "why", "surface", "port", "session", "line", "code", "expr", "inputs", "mocks", "edge", "title", "file", "severity", "step", "repro", "expect", "fix", "patch", "tests", "out", "json")


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
