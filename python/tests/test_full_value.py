"""``why --live STEP NAME --full`` (agent/full_value.py): the request, the text of the answer, the
refusals, the hint under a value the recording cut, and the MCP form. The bridge is faked
(test_agent_live.FakeBridge); the replay itself is tested on the extension's side."""

from __future__ import annotations

import json
from pathlib import Path

from pyokka_runtime.agent.full_value import COPY_LIMITS, SAVED_RUN, VALUE_LINES, value_lines
from pyokka_runtime.agent.mcp import call_tool, words_value
from pyokka_runtime.agent.mcp_tools import tool_definitions

from test_agent_live import FILE, FakeBridge, pyokka, pyokka_json, slice_at
from test_agent_live import bridge, sessions  # noqa: F401 - fixtures

SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123"


def leaf(name: str, type_: str, value: str, **extra) -> dict:
    return {"name": name, "type": type_, "value": value, "id": "replay " + name, "queryPath": ["replay", name], **extra}


def line_item(i: int, sku: str, qty: int, price: float) -> dict:
    return {"name": str(i), "type": "dict", "value": "{...}", "id": "i%d" % i, "queryPath": [], "length": 3, "expandable": True, "props": [
        leaf("sku", "str", sku, keyRepr="'sku'", length=len(sku)),
        leaf("qty", "number", str(qty), keyRepr="'qty'"),
        leaf("unit_price", "number", str(price), keyRepr="'unit_price'"),
    ]}


#: Ana's order in invoices.py as the replay copies it: what the recording cut to {...}
ORDER = {"type": "dict", "value": "{'tier': 'gold', 'items': [{...}, {...}]}", "id": "replay 1", "queryPath": ["replay"], "length": 2, "expandable": True, "props": [
    leaf("tier", "str", "gold", keyRepr="'tier'", length=4),
    {"name": "items", "keyRepr": "'items'", "type": "list", "value": "[{...}, {...}]", "id": "items", "queryPath": [], "length": 2, "expandable": True, "props": [line_item(0, "KB-01", 2, 49.9), line_item(1, "MS-07", 1, 19.9)]},
]}

CHECKED = (
    "The replay took the same 42 steps, and all 12 values the recording kept on the way came out the same. Each was compared as far as the recording kept it "
    "(by default 120 characters, three levels deep), so a difference deeper in this copy, from a file or a database that changed since, would not show."
)


def why_reply(step: int = 41, name: str = "order", full: dict | None = None) -> dict:
    """The bridge's why: the parameter `order` of invoice_total, its text cut by the recorder, and the replay's answer."""
    out = {"name": name, "step": step, "depth": 5, "nodes": 1, "truncated": False, "recordedLocals": True, "root": {
        "name": name, "text": "{'items': [{...}, {...}], 'tier': 'gold'}", "source": "locals", "step": 38, "file": None, "fileId": 1, "line": 40, "function": "invoice_total", "scopeId": 4, "statement": "def invoice_total(order):",
    }}
    if full is not None:
        out["full"] = full
    return out


ORDER_LINES = [
    "  order = {",
    "    'tier': 'gold',",
    "    'items': [",
    "      {'sku': 'KB-01', 'qty': 2, 'unit_price': 49.9},",
    "      {'sku': 'MS-07', 'qty': 1, 'unit_price': 19.9},",
    "    ],",
    "  }",
]


# -- the request and the text ---------------------------------------------------------------------------

def test_full_asks_the_bridge_once_and_prints_label_summary_effects_and_the_value(bridge: FakeBridge):
    bridge.canned["why"] = why_reply(full={"status": "checked", "step": 42, "name": "order", "summary": CHECKED, "value": ORDER, "matched": 42, "ms": 412})
    code, text = pyokka("why", "--live", "41", "order", "--full")
    assert bridge.requests[-1] == {"id": 1, "type": "why", "step": 41, "name": "order", "depth": 5, "full": True}
    lines = text.splitlines()
    assert code == 0 and lines[0] == "why order at #41"
    at = lines.index("full value of order: Checked")
    assert lines[at - 1] == "" and lines[at + 1] == CHECKED
    assert lines[at + 2] == "replayed in 412 ms: the program ran again in a separate process, so files it writes were written again"
    assert lines[at + 3 :] == ORDER_LINES
    # the value is there: no hint pointing at --full under the tree's cut text
    assert "hint: a recorded value was cut" not in text


def test_json_gives_the_tree_and_the_view(bridge: FakeBridge):
    view = {"status": "checked", "step": 42, "name": "order", "summary": CHECKED, "value": ORDER, "matched": 42, "ms": 412}
    bridge.canned["why"] = why_reply(full=view)
    doc = pyokka_json("why", "--live", "41", "order", "--full")
    assert doc["full"] == view and doc["root"]["name"] == "order"


def test_a_secret_in_the_copy_or_the_summary_is_masked(bridge: FakeBridge):
    copy = {"type": "dict", "value": "{...}", "id": "r", "queryPath": [], "length": 1, "props": [leaf("key", "str", SECRET, keyRepr="'key'", length=len(SECRET))]}
    bridge.canned["why"] = why_reply(name="config", full={"status": "differs", "step": 42, "name": "config", "summary": "config came out different: %s" % SECRET, "value": copy, "difference": {"step": 30, "name": "config", "recorded": SECRET, "replay": "x"}, "matched": 42, "ms": 80})
    code, text = pyokka("why", "--live", "41", "config", "--full")
    assert code == 0 and SECRET not in text
    assert "full value of config: Differs" in text and "first difference, #30 config: the recording kept " in text


def test_a_refusal_reads_as_the_pane_says_it_and_shows_no_value(bridge: FakeBridge):
    network = "This run called the network (one request) and the answers were not recorded, so a replay would call it again, could get other answers and spend tokens. Switch HTTP to Record in Settings, run once, then ask again."
    bridge.canned["why"] = why_reply(full={"status": "unavailable", "step": 41, "name": "order", "summary": network})
    code, text = pyokka("why", "--live", "41", "order", "--full")
    lines = text.splitlines()
    at = lines.index("full value of order: Not available")
    assert code == 0 and lines[at + 1 :] == [network]


def test_full_needs_a_name_and_a_live_session(bridge: FakeBridge, tmp_path: Path, capsys):
    code, _ = pyokka("why", "--live", "41", "--full")
    assert code == 2 and "--full needs NAME" in capsys.readouterr().err
    assert not [r for r in bridge.requests if r.get("type") == "why"]
    script = tmp_path / "tiny.py"
    script.write_text("orders = {'Ana': [1, 2]}\ntotal = len(orders)\n", encoding="utf-8")
    run = tmp_path / "run.json"
    assert pyokka("run", str(script), "--save", str(run))[0] == 0
    capsys.readouterr()
    code, _ = pyokka("why", str(run), "1", "orders", "--full")
    err = capsys.readouterr().err
    assert code == 2 and SAVED_RUN in err and "pyokka debug FILE --record" in err


def test_an_extension_that_ignores_full_is_named(bridge: FakeBridge, capsys):
    code, _ = pyokka("why", "--live", "21", "total", "--full")  # the fake's own why: no `full` in it, as 0.7.0 answers
    assert code == 2 and "older than this CLI (its why has no full value)" in capsys.readouterr().err


# -- the value as text ----------------------------------------------------------------------------------

def test_small_values_stay_on_one_line_and_python_shapes_read_as_python():
    pair = {"type": "tuple", "value": "(1,)", "id": "t", "queryPath": [], "length": 1, "props": [leaf("0", "number", "1")]}
    tags = {"type": "frozenset", "value": "frozenset({3})", "id": "f", "queryPath": [], "length": 1, "props": [leaf("0", "number", "3")]}
    point = {"type": "Point", "value": "<demo.Point object at 0x10a>", "id": "p", "queryPath": [], "expandable": True, "props": [leaf("x", "number", "5"), leaf("y", "number", "10")]}
    empty = {"type": "dict", "value": "{}", "id": "e", "queryPath": [], "length": 0}
    assert value_lines(pair, "pair") == ["  pair = (1,)"]
    assert value_lines(tags, "tags") == ["  tags = frozenset({3})"]
    assert value_lines(point, "point_a") == ["  point_a = Point(x=5, y=10)"]
    assert value_lines(empty, "seen") == ["  seen = {}"]
    assert value_lines(leaf("s", "str", "it's"), "s") == ['  s = "it\'s"']


def test_where_the_copy_stopped_is_marked_and_said():
    long_text = leaf("note", "str", "x" * 20, length=50, capped="x" * 20)
    more = {"name": "…", "type": "…", "value": "…", "loadActionNode": True, "id": "m", "queryPath": []}
    rows = {"type": "list", "value": "[...]", "id": "l", "queryPath": [], "length": 6000, "cappedElements": True, "props": [leaf("0", "number", "0"), leaf("1", "number", "1"), more]}
    assert value_lines(long_text, "note") == ["  note = 'xxxxxxxxxxxxxxxxxxxx'…(+30 chars)", "  (… is where the copy stopped: it keeps %s)" % COPY_LIMITS]
    assert value_lines(rows, "rows") == ["  rows = [0, 1, …]", "  (… is where the copy stopped: it keeps %s)" % COPY_LIMITS]


def test_a_long_copy_prints_its_first_lines_and_points_at_json():
    big = {"type": "list", "value": "[...]", "id": "b", "queryPath": [], "length": 1000, "props": [leaf(str(i), "str", "row %04d " % i + "y" * 90, length=99) for i in range(1000)]}
    lines = value_lines(big, "rows")
    assert len(lines) == VALUE_LINES + 1 and lines[0] == "  rows = ["
    assert lines[-1] == "  … %d more lines; `--json` has the whole copy" % (1000 + 2 - VALUE_LINES)


# -- the hint under a cut value -------------------------------------------------------------------------

HINT = 'hint: a recorded value was cut: `pyokka why --live {step} {name} --full` runs the program again in a separate process up to that step: files it writes are written again, network answers come from the HTTP recording, and prints all of it (MCP: pyokka_value {{"action": "why", "live": true, "step": {step}, "name": "{name}", "full": true}})'


def test_why_with_a_cut_root_names_the_full_command(bridge: FakeBridge):
    bridge.canned["why"] = why_reply()
    code, text = pyokka("why", "--live", "41", "order")
    assert code == 0 and text.splitlines()[-1] == HINT.format(step=41, name="order")


def test_var_with_a_cut_change_names_its_step_and_name(bridge: FakeBridge):
    bridge.canned["var"] = {"name": "order", "total": 2, "truncated": False, "recordedLocals": True, "changes": [
        {"step": 9, "file": FILE, "fileId": 1, "line": 27, "function": "parse_orders", "scopeId": 2, "name": "order", "text": "{'items': [], 'tier': 'gold'}", "source": "locals"},
        {"step": 38, "file": FILE, "fileId": 1, "line": 40, "function": "invoice_total", "scopeId": 4, "name": "order", "text": "{'items': [{...}, {...}], 'tier': 'gold'}", "source": "locals"},
    ]}
    code, text = pyokka("var", "--live", "order")
    assert code == 0 and text.splitlines()[-1] == HINT.format(step=38, name="order")
    # the session the command named goes with the next one
    code, text = pyokka("var", "--live", "--session", "demo.py", "order")
    assert "`pyokka why --live --session demo.py 38 order --full`" in text and '"session": "demo.py"' in text


def test_step_with_a_cut_logged_value_names_it(bridge: FakeBridge):
    cut = slice_at(11, values=[{"line": 11, "context": "orders", "text": "{'Ana': {...}, 'Ben': {...}}", "step": 11, "hit": 1, "runtimeKey": "7"}])
    bridge.canned["context"] = cut
    code, text = pyokka("context", "--live", "11")
    assert code == 0 and text.splitlines()[-1] == HINT.format(step=11, name="orders")


def test_whole_values_and_saved_runs_get_no_hint(bridge: FakeBridge, tmp_path: Path):
    bridge.canned["why"] = {**why_reply(), "root": {**why_reply()["root"], "text": "{'tier': None}"}}
    code, text = pyokka("why", "--live", "41", "order")
    assert code == 0 and "hint:" not in text
    script = tmp_path / "wide.py"
    script.write_text("orders = {'Ana': {'items': [{'sku': 'KB-01'}]}, 'Ben': {'items': [{'sku': 'MON-27'}]}, 'Caro': {'items': []}, 'Dani': {'items': [1]}}\ntotal = len(orders)\n", encoding="utf-8")
    run = tmp_path / "run.json"
    assert pyokka("run", str(script), "--save", str(run))[0] == 0  # locals recorded, cut at 120 characters
    code, text = pyokka("var", str(run), "orders")
    assert code == 0 and "…(+" in text and "--full" not in text


# -- MCP -----------------------------------------------------------------------------------------------

def test_mcp_why_takes_full_and_says_what_a_replay_does():
    words = words_value({"action": "why", "live": True, "step": 41, "name": "order", "full": True})
    assert words[:2] == ["why", "--live"] and "--full" in words and words[-2:] == ["41", "order"]
    assert "--full" not in words_value({"action": "why", "live": True, "step": 41, "name": "order"})
    tool = next(t for t in tool_definitions() if t["name"] == "pyokka_value")
    assert "runs the program again" in tool["inputSchema"]["properties"]["full"]["description"]
    assert tool["annotations"]["readOnlyHint"] is False  # with full it runs the program


def test_mcp_why_full_returns_the_text(bridge: FakeBridge):
    bridge.canned["why"] = why_reply(full={"status": "checked", "step": 42, "name": "order", "summary": CHECKED, "value": ORDER, "matched": 42, "ms": 412})
    out = call_tool("pyokka_value", {"action": "why", "live": True, "step": 41, "name": "order", "full": True})
    text = out["content"][0]["text"]
    assert not out["isError"] and "full value of order: Checked" in text and "\n".join(ORDER_LINES) in text
    assert json.loads(json.dumps(bridge.requests[-1]))["full"] is True
