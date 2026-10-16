"""`pyokka origin` through attribute paths (`lines[1].unit_cents`): a dataclass field read from its repr.

`tests/fixtures/origin/dataclass.py` is the review smoke's shopkit in small: `parse_cents` keeps one
price as text, the `Line` dataclass carries it, `Cart` (a dataclass) holds the lines, `Shop` (a plain
class, so its repr prints no fields) holds the cart, and `line_total` fails on the text.
"""

from __future__ import annotations

from pathlib import Path

from pyokka_runtime.agent.origin import origin
from pyokka_runtime.agent.reprs import UNKNOWN, Attr, Record, parse, path_text, project, text_of, type_of_value
from pyokka_runtime.agent.source import SavedRun

from test_origin import FIXTURES, error_step, root_link, run_of
from test_walkthrough import pyokka

SOURCE = (FIXTURES / "dataclass.py").read_text(encoding="utf-8").splitlines()


def step_at(run: SavedRun, text: str, before: int) -> int:
    """The last step before ``before`` whose statement is the fixture line holding ``text``."""
    line = next(i + 1 for i, l in enumerate(SOURCE) if text in l)
    return max(s for s in range(before) if (run.trace.location(s) or (0, (0, 0)))[1][0] == line)


def test_the_str_field_is_picked_and_traced_through_two_constructors_to_the_parse(tmp_path: Path):
    run = run_of(tmp_path, "dataclass.py", maxValueChars=400)
    step = error_step(run)
    result = origin(run, step)
    assert result["value"] == {"expr": "line.unit_cents", "text": "'1,249.00'", "type": "str", "chosen": "the str operand"}
    assert result["need"] == "a number"
    root = root_link(result)
    assert (root["function"], root["how"], root["expr"]) == ("parse_cents", "return", "return t")
    assert result["root"]["evidence"] == "siblings"
    assert result["root"]["reason"] == "parse_cents returned a str here; its other 2 calls returned a int"
    notes = [l.get("note", "") for l in result["links"]]
    # the loop variable to the element of cart.lines whose field carries the text
    assert any(n.startswith("loop variable over cart.lines; the element whose .unit_cents has this text") for n in notes)
    # the plain class's stepped __init__, and the dataclass's generated one (its field order from the class statement)
    assert "set in Shop.__init__" in notes and "field lines of Cart" in notes and "field unit_cents of Line" in notes
    # the append that put the Line in, matched through its constructor's argument text
    element = next(l for l in result["links"] if l["how"] == "element" and l["certainty"] == "inferred" and "put as an element" in l.get("note", ""))
    assert element["expr"] == "Line(sku, qty, parse_cents(price))"
    assert result["end"] == "a literal in the source" and not result["truncated"]


def test_an_attribute_path_is_an_expr(tmp_path: Path):
    run = run_of(tmp_path, "dataclass.py", maxValueChars=400)
    step = error_step(run)
    at = step_at(run, "shop = Shop(", step)
    result = origin(run, at, "lines[1].unit_cents")
    assert result["value"] == {"expr": "lines[1].unit_cents", "text": "'1,249.00'", "type": "str", "chosen": "named"}
    assert [l["how"] for l in result["links"]][:4] == ["read", "element", "argument", "return"]
    assert root_link(result)["function"] == "parse_cents"
    code, text = pyokka("origin", run.path, str(at), "lines[1].unit_cents")
    assert code == 0 and text.startswith("origin of lines[1].unit_cents at #%d" % at)
    assert "(argument: field unit_cents of Line)" in text and "root: #%d" % root_link(result)["step"] in text
    # a field path from a comprehension-free loop body, named at the loop statement
    loop = step_at(run, "for line in cart.lines", step)
    named = origin(run, loop, "cart.lines[1].unit_cents")
    assert named["value"]["text"] == "'1,249.00'" and root_link(named)["function"] == "parse_cents"


def test_what_the_recording_does_not_print_is_said(tmp_path: Path):
    run = run_of(tmp_path, "dataclass.py", maxValueChars=400)
    step = error_step(run)
    loop = step_at(run, "for line in cart.lines", step)
    opaque = origin(run, loop, "shop.name")
    assert not opaque["links"]
    assert opaque["end"].startswith("shop is recorded as <Shop object>, a repr that prints no fields, so .name is not in the recording")
    assert origin(run, step, "line.price")["end"] == "line is recorded as Line(…) without a field price"
    assert origin(run, step, "line.sku.x")["end"] == "line.sku is a str at #%d, whose attributes the recording does not print" % step
    assert origin(run, loop, "cart.lines[7]")["end"] == "cart.lines is a list of length 3 at #%d, so [7] is past its end" % loop
    assert origin(run, loop, "cart['lines']")["end"] == "cart is a Cart at #%d, not a container; its fields read as cart.owner" % loop
    assert origin(run, step, "nothing.here")["end"].startswith("nothing has no recorded value at #%d; give a name the statement read" % step)
    # the default budget cuts the cart's repr before its lines: the end says so instead of calling the field absent
    (tmp_path / "short").mkdir()
    short = run_of(tmp_path / "short", "dataclass.py")
    cut = origin(short, step_at(short, "for line in cart.lines", error_step(short)), "cart.lines[1].unit_cents")
    assert cut["end"] == "the recording cut cart at maxValueChars before cart.lines was whole; record again with --max-value-chars 0 to keep it"


def test_reprs_read_records_and_attribute_paths():
    lines = parse("[Line(sku='a', qty=2, unit_price=3.5), Line(sku='b', qty=1, unit_price='4.0')]")
    assert lines == [Record("Line", {"sku": "a", "qty": 2, "unit_price": 3.5}), Record("Line", {"sku": "b", "qty": 1, "unit_price": "4.0"})]
    assert project(lines, [1, Attr("unit_price")]) == "4.0" and type_of_value(lines[0]) == "Line"
    assert text_of(lines[0]) == "Line(sku='a', qty=2, unit_price=3.5)"  # the recorded text, back
    assert project(lines, [0, Attr("nope")]) is UNKNOWN and project(lines, [0, "unit_price"]) is UNKNOWN and project({"a": 1}, [Attr("a")]) is UNKNOWN
    assert path_text("lines", [0, Attr("unit_price")]) == "lines[0].unit_price" and path_text("order", [Attr("lines"), 0, "k"]) == 'order.lines[0]["k"]'
    assert type_of_value(parse("Decimal('1.5')")) == "Decimal" and text_of(parse("Decimal('1.5')")) is None  # positional arguments: the type only
    assert parse("Outer.Line(x=-1, y=(1+2j))") == Record("Outer.Line", {"x": -1, "y": 1 + 2j}) and type_of_value(parse("Outer.Line(x=1)")) == "Line"
    cut = parse("Line(sku='MON-27', qty=1, unit_pri…(+19 chars)")
    assert cut == Record("Line", {"sku": "MON-27", "qty": 1}) and project(cut, [Attr("unit_price")]) is UNKNOWN
    nested = parse("Order(customer='Ana', lines=[<Line object at 0x1>])")
    assert type_of_value(nested) == "Order" and text_of(nested) is None and type_of_value(project(nested, [Attr("lines"), 0])) == "Line"
    assert parse("{'a': [{...}, {...}]}") == {"a": [UNKNOWN, UNKNOWN]}  # unchanged for the texts the serializer cuts
