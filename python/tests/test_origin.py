"""`pyokka origin`: the chain from a failing statement back to where its bad value was made.

The programs are in `tests/fixtures/origin/`: invoices.py (a TypeError whose str comes from a
parse function that returns text for one row) and one each for KeyError, AttributeError on
None and IndexError. `docs/design/origin.md` has the rules these pin.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pyokka_runtime.agent.origin import need_from_error, origin
from pyokka_runtime.agent.reprs import UNKNOWN, parse, path_text, project, text_of, type_of
from pyokka_runtime.agent.source import SavedRun

from test_agent_live import FakeBridge, write_descriptor
from test_agent_live import bridge, sessions  # noqa: F401 - fixtures
from test_walkthrough import pyokka, saved_run

FIXTURES = Path(__file__).parent / "fixtures" / "origin"


def run_of(tmp_path: Path, name: str, **config) -> SavedRun:
    path = saved_run(tmp_path, (FIXTURES / name).read_text(encoding="utf-8"), name=name, config=config or None)
    return SavedRun(str(path))


def error_step(run: SavedRun) -> int:
    assert len(run.errors) == 1, run.errors
    return int(run.errors[0]["step"])


def root_link(result: dict) -> dict:
    roots = [l for l in result["links"] if l.get("root")]
    assert len(roots) == 1, result["links"]
    return roots[0]


# -- invoices.py: a TypeError traced across calls, a container and a return -------------------------------------------

@pytest.fixture
def invoices(tmp_path: Path) -> SavedRun:
    return run_of(tmp_path, "invoices.py")


def test_invoices_root_is_parse_price_returning_text(invoices: SavedRun):
    step = error_step(invoices)
    assert step == 64
    result = origin(invoices, step)
    assert result["error"]["type"] == "TypeError" and result["error"]["caught"]
    assert result["value"] == {"expr": 'items[0]["unit_price"]', "text": "'1,299.00'", "type": "str", "chosen": "the str operand"}
    assert result["need"] == "a number"
    root = root_link(result)
    assert (root["step"], root["line"], root["function"], root["how"]) == (29, 18, "parse_price", "return")
    assert result["root"]["step"] == 29 and result["root"]["evidence"] == "siblings"
    assert result["root"]["reason"] == "parse_price returned a str here; its other 5 calls returned a float"


def test_invoices_chain_crosses_the_caller_the_element_and_the_return(invoices: SavedRun):
    links = origin(invoices, 64)["links"]
    shape = [(l["step"], l["line"], l["how"], l["certainty"]) for l in links]
    assert shape[:5] == [
        (64, 34, "read", "recorded"),
        (61, 42, "argument", "recorded"),  # subtotal(order["items"]) in invoice_total
        (52, 47, "argument", "recorded"),  # invoice_total(order) in main
        (26, 28, "element", "inferred"),  # {"unit_price": parse_price(price)}, matched by key and text
        (29, 18, "return", "recorded"),
    ]
    assert links[3]["expr"] == "parse_price(price)" and "no object identity" in links[3]["note"]
    by_step = {(l["step"], l["how"]): l for l in links}
    assert by_step[(28, "assigned")]["text"] == "'1,299.00'"
    assert by_step[(26, "argument")]["text"] == "'\"1,299.00\"'"  # price, before the quotes were stripped
    assert by_step[(24, "assigned")]["expr"] == "price"  # row.split
    assert by_step[(23, "element")]["text"] == "'Ben,silver,MON-27,1,\"1,299.00\"'"
    last = links[-1]
    assert (last["step"], last["line"], last["how"], last["certainty"]) == (0, 6, "literal", "text match")


def test_invoices_text_output(invoices: SavedRun):
    code, out = pyokka("origin", invoices.path, "64")
    assert code == 0
    lines = out.splitlines()
    assert lines[0] == "TypeError at #64 main.py:34 subtotal: unsupported operand type(s) for +: 'int' and 'str' (caught)".replace("main.py", "invoices.py")
    assert "the value: items[0][\"unit_price\"] = '1,299.00', where the statement needs a number" in out
    root_line = next(l for l in lines if l.startswith("▶"))
    assert root_line.startswith("▶ #29 invoices.py:18 parse_price") and root_line.endswith("◀ root")
    assert "root: #29 invoices.py:18 parse_price: parse_price returned a str here; its other 5 calls returned a float" in out
    assert "chain ends: a literal in the source" in out


def test_invoices_json_shape(invoices: SavedRun):
    code, out = pyokka("origin", invoices.path, "64", "--json")
    doc = json.loads(out)
    assert code == 0
    assert {"step", "file", "line", "function", "statement", "error", "value", "need", "links", "root", "end", "truncated", "recordedLocals"} <= set(doc)
    for link in doc["links"]:
        assert {"step", "file", "line", "function", "expr", "how", "certainty"} <= set(link)
        assert link["how"] in ("read", "argument", "element", "return", "assigned", "literal")
        assert link["certainty"] in ("recorded", "inferred", "text match")
        assert "_sib" not in link and "scopeReturned" not in link


def test_depth_cuts_the_chain(invoices: SavedRun):
    result = origin(invoices, 64, depth=3)
    assert len(result["links"]) == 3 and result["truncated"]
    assert "raise --depth" in result["end"]


def test_a_named_expression_and_a_cut_container(invoices: SavedRun):
    result = origin(invoices, 64, "items")
    assert result["value"]["expr"] == "items" and "need" not in result
    # the list was filled in place by append, which the recording does not tie to a statement
    assert result["root"] is None and "rootUnknown" in result
    assert "filled in place" in result["end"]


def test_no_exception_and_no_expr_lists_the_reads(invoices: SavedRun):
    result = origin(invoices, 55)
    assert not result["links"] and "give EXPR" in result["end"]
    assert [r["name"] for r in result["reads"]] == ["order", "rate"]  # the function `subtotal` is left out
    named = origin(invoices, 55, "rate")
    assert named["links"][1]["expr"] == "rate" and named["links"][1]["how"] == "assigned"
    assert named["links"][1]["inputs"]  # DISCOUNTS.get(order["tier"], 0.0) has two inputs
    assert "ask origin for one of them" in named["end"]


def test_without_locals_it_says_so(tmp_path: Path):
    run = run_of(tmp_path, "invoices.py", recordLocals=False)
    result = origin(run, 64)
    assert not result["recordedLocals"] and not result["links"]
    assert "--record-locals" in result["hint"]
    code, out = pyokka("origin", run.path, "64")
    assert code == 0 and "recorded no locals" in out


# -- the other error kinds -----------------------------------------------------------------------------------------------

def test_keyerror_root_is_the_change_that_left_the_key_out(tmp_path: Path):
    run = run_of(tmp_path, "keyerror.py")
    result = origin(run, error_step(run))
    assert result["value"]["expr"] == "settings" and result["need"] == "a dict with key 'port'"
    hows = [l["how"] for l in result["links"]]
    assert hows == ["read", "argument", "assigned", "return", "assigned", "literal"]
    root = root_link(result)
    assert root["line"] == 8 and root["function"] == "load_settings" and "changed in place" in root["note"]
    assert result["root"]["reason"] == "the dict has no key 'port' from here on; it has 'prot'"


def test_attributeerror_on_none_root_is_the_function_that_fell_off_its_end(tmp_path: Path):
    run = run_of(tmp_path, "nonetype.py")
    result = origin(run, error_step(run))
    assert result["value"]["expr"] == "rate" and result["value"]["text"] == "None"
    root = root_link(result)
    assert root["how"] == "return" and root["function"] == "get_rate" and root["text"] == "None"
    assert result["root"]["reason"] == "get_rate returned None here; its other 2 calls returned a float"
    assert "fell off its end" in result["end"]


def test_indexerror_root_is_the_short_list(tmp_path: Path):
    run = run_of(tmp_path, "indexerror.py")
    result = origin(run, error_step(run))
    assert result["value"]["expr"] == "fields" and result["need"] == "a sequence longer than 2"
    root = root_link(result)
    assert (root["line"], root["function"], root["how"]) == (5, "parse_line", "return")
    assert result["root"]["reason"] == "parse_line returned a list of length 2 here; its other 2 calls returned a list of length 3"
    assert result["links"][-1]["how"] == "literal" and result["links"][-1]["line"] == 12


def test_none_from_an_in_place_method_ends_at_the_call(tmp_path: Path):
    run = run_of(tmp_path, "sortnone.py")
    result = origin(run, error_step(run))
    assert result["error"]["caught"] is False
    assert result["value"]["expr"] == "ranked" and result["need"] == "a value that is not None"
    assert [(l["line"], l["how"]) for l in result["links"]] == [(8, "read"), (7, "assigned")]
    assert root_link(result)["line"] == 7
    assert "the None is the call's own result" in result["end"]


# -- live ------------------------------------------------------------------------------------------------------------

def test_live_builds_over_the_session_recording(invoices: SavedRun, bridge: FakeBridge):  # noqa: F811
    bridge.canned["recording"] = json.loads(Path(invoices.path).read_text(encoding="utf-8"))
    code, out = pyokka("origin", "--live", "64", "--json")
    doc = json.loads(out)
    assert code == 0, doc
    assert doc["root"]["step"] == 29
    assert any(r.get("type") == "recording" for r in bridge.requests)


# -- the pieces --------------------------------------------------------------------------------------------------------

def test_reprs_read_types_and_cut_containers():
    assert type_of("'a'") == "str" and type_of("49.9") == "float" and type_of("3") == "int" and type_of("None") == "NoneType"
    assert type_of("<Foo object at 0x1>") == "Foo" and type_of("{'a': 1}") == "dict" and type_of("{1, 2}") == "set"
    cut = "[{'qty': 1, 'unit_price': '1,299.00'}, {'qty': 3, 'unit_…(+19 chars)"
    assert parse(cut) == [{"qty": 1, "unit_price": "1,299.00"}]  # the half-shown dict is dropped, not shown without its keys
    assert parse("{'a': [{...}, {...}]}") == {"a": [UNKNOWN, UNKNOWN]}
    assert project(parse(cut), [0, "unit_price"]) == "1,299.00"
    assert project(parse(cut), [1]) is UNKNOWN
    assert text_of(project(parse(cut), [0])) == "{'qty': 1, 'unit_price': '1,299.00'}"
    assert path_text("items", [0, "unit_price"]) == 'items[0]["unit_price"]'


def test_need_from_error_messages():
    n = need_from_error("TypeError", "unsupported operand type(s) for +: 'int' and 'str'")
    assert (n.kind, n.bad, n.fits_type) == ("type", "str", "number")
    n = need_from_error("TypeError", 'can only concatenate str (not "int") to str')
    assert (n.bad, n.fits_type) == ("int", "str")
    assert need_from_error("TypeError", "'NoneType' object is not subscriptable").bad == "NoneType"
    n = need_from_error("AttributeError", "'NoneType' object has no attribute 'hex'")
    assert (n.bad, n.attr) == ("NoneType", "hex")
    assert need_from_error("KeyError", "'port'").key == "port"
    assert need_from_error("KeyError", "3").key == 3
    assert need_from_error("IndexError", "list index out of range").kind == "index"
    assert need_from_error("ValueError", "bad") is None
