"""The MCP tool definitions tell a client with no skill loaded where each effect lands, in the tools' own terms."""

from __future__ import annotations

import re

import pytest

from pyokka_runtime.agent.mcp_tools import tool_definitions

TOOLS = {t["name"]: t for t in tool_definitions()}

#: the phrase in each tool's description that says where its result or effect lands
LANDS = {
    "pyokka_run": "file on disk at `save`",
    "pyokka_map": "with step numbers",
    "pyokka_step": "execute the real program in the VS Code window",
    "pyokka_value": "Values of a run",
    "pyokka_coverage": "returned as text in this reply",
    "pyokka_debug": "where the person sees the pause",
    "pyokka_history": "Writes a JSON file to `out`",
    "pyokka_narrate": "writes the gloss into run.json",
    "pyokka_investigate": "as text in this reply",
    "pyokka_learn": "text in this reply",
    "pyokka_pin": "Writes the copy to the file at `out`",
    "pyokka_verify": "out and test_out write new files",
    "pyokka_session": "as JSON",
    "pyokka_seek": "as JSON",
    "pyokka_save_investigation": "to a new JSON file at `path`",
    "pyokka_open_investigation": "as JSON text in this reply",
    "pyokka_page": "This tool opens no browser",
    "pyokka_scratchpad": "show only in that browser tab",
}

#: review/tool.py writes its own definition and maps the CLI's flags on purpose
OWN_DEFINITION = {"pyokka_review"}


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def test_every_tool_says_where_its_result_lands():
    assert set(LANDS) | OWN_DEFINITION == set(TOOLS)
    for name, phrase in LANDS.items():
        assert phrase in TOOLS[name]["description"], name


@pytest.mark.parametrize("name", sorted(set(TOOLS) - OWN_DEFINITION))
def test_no_cli_flag_wording(name):
    for text in _strings({"d": TOOLS[name]["description"], "s": TOOLS[name]["inputSchema"]}):
        assert not re.search(r"(?<![\w-])--[a-z]", text), (name, text)


@pytest.mark.parametrize("name", sorted(TOOLS))
def test_omit_with_live_only_where_live_exists(name):
    props = TOOLS[name]["inputSchema"]["properties"]
    for key, prop in props.items():
        if "omit with live" in prop.get("description", ""):
            assert "live" in props, (name, key)


@pytest.mark.parametrize("name", sorted(TOOLS))
def test_required_fields_exist(name):
    schema = TOOLS[name]["inputSchema"]
    assert set(schema.get("required", [])) <= set(schema["properties"]), name


@pytest.mark.parametrize("name", ["pyokka_investigate", "pyokka_learn", "pyokka_pin", "pyokka_verify"])
def test_tools_that_read_live_list_it(name):
    schema = TOOLS[name]["inputSchema"]
    assert {"run", "live", "session"} <= set(schema["properties"])
    assert "run" not in schema.get("required", [])


@pytest.mark.parametrize("name", ["pyokka_narrate", "pyokka_seek", "pyokka_save_investigation"])
def test_saved_run_only_tools_offer_no_live(name):
    props = TOOLS[name]["inputSchema"]["properties"]
    assert "live" not in props and "session" not in props
    assert "omit with live" not in props["run"]["description"]


def test_learn_states_the_two_call_protocol():
    d = TOOLS["pyokka_learn"]["description"]
    assert "Call 1:" in d and "Call 2:" in d and "nothing is stored between calls" in d
    assert "`reveal` without `prediction` shows the values with no match" in d


def test_debug_actions_drop_the_live_prefix():
    d = TOOLS["pyokka_debug"]["description"]
    assert "- continue: resume the paused program" in d
    assert "pyokka.agentAccess" in d
