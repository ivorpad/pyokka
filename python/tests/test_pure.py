"""The one rule for hovers, watches and completions (``pure.py``): which calls run and which
are refused, the receiver evaluated once, a rebound builtin caught where the expression runs."""

from __future__ import annotations

import ast

import pytest

from pyokka_runtime.pure import check_pure, eval_pure


class Box:
    """A user object: its method is never called, its property runs as it always did."""

    def __init__(self, data: dict) -> None:
        self.data = data
        self.reads = 0

    @property
    def payload(self) -> dict:
        self.reads += 1
        return self.data

    def method(self) -> int:
        raise AssertionError("a user method must not be called")


def ev(expression: str, namespace: dict | None = None, locals_: dict | None = None):
    return eval_pure(ast.parse(expression, mode="eval").body, namespace if namespace is not None else {}, locals_)


def refused(expression: str, namespace: dict | None = None, locals_: dict | None = None) -> str:
    with pytest.raises(ValueError) as exc:
        ev(expression, namespace, locals_)
    return str(exc.value)


NS = {
    "rows": [{"n": 1}, {"n": 2}],
    "items": [3, 1, 2],
    "d": {"b": 2, "a": 1},
    "s": "Abc",
    "x": {"k": "v"},
    "f": lambda v: v,
    "obj": Box({"k": 1}),
}


def test_the_calls_a_hover_and_a_watch_may_run():
    assert ev("len(rows)", NS) == 2
    assert ev("sorted(d.keys())", NS) == ["a", "b"]
    assert ev("d.get('x', 0)", NS) == 0
    assert ev("[v * 2 for v in items]", NS) == [6, 2, 4]
    assert ev("s.lower().startswith('a')", NS) is True
    assert ev("isinstance(x, dict)", NS) is True
    assert ev("type(items).__name__", NS) == "list"
    assert ev("sorted(items, reverse=True)", NS) == [3, 2, 1], "keyword arguments reach the builtin"
    assert ev("sum(r['n'] for r in rows)", NS) == 3
    assert ev("items.count(1)", NS) == 1 and ev("items.index(2)", NS) == 2
    assert ev("max(len(r) for r in rows)", NS) == 1


def test_a_comprehension_sees_the_frame_variables_not_only_its_iterable():
    # the comprehension's own scope would reach globals only, so locals are merged in first
    assert ev("[v * factor for v in items]", {"items": [1, 2]}, {"factor": 10}) == [10, 20]
    assert ev("{k: len(v) for k, v in pairs.items()}", {}, {"pairs": {"a": "xy"}}) == {"a": 2}


def test_what_stays_refused():
    assert "cannot call `items.append`" in refused("items.append(1)", NS)
    assert "cannot call `d.pop`" in refused("d.pop('a')", NS)
    assert "cannot call `obj.method`" in refused("obj.method()", NS)
    assert "cannot call `f`" in refused("f(1)", NS)
    assert "cannot call `funcs[0]`" in refused("funcs[0]()", {"funcs": [len]})
    assert "cannot call `lambda: 1`" in refused("(lambda: 1)()", NS)
    assert "cannot evaluate a lambda" in refused("sorted(items, key=lambda v: -v)", NS)
    assert "cannot evaluate an await" in refused("await thing", NS)
    assert "cannot evaluate a walrus assignment" in refused("(n := 1)", NS)
    assert NS["d"] == {"b": 2, "a": 1} and NS["items"] == [3, 1, 2], "nothing refused ran"


def test_a_refused_call_says_what_is_allowed_in_one_line():
    message = refused("items.append(1)", NS)
    assert message == (
        "cannot call `items.append` here: a hover or a watch runs only names, attributes, subscripts, operators "
        "and pure calls (builtins like len, sorted, isinstance; non-mutating methods of str, dict, list, tuple, set)"
    )
    assert "\n" not in message
    long_receiver = refused("rows[0]['deeply']['nested']['path']['that']['goes']['on'].append(1)", {"rows": [{}]})
    quoted = long_receiver.split("`")[1]
    assert len(quoted) == 63 and quoted.endswith("..."), "the quoted expression is bounded"


def test_a_builtin_rebound_by_the_program_is_not_the_builtin():
    assert "`len` is rebound here" in refused("len(items)", {"items": [1], "len": lambda v: 99})
    assert "`len` is rebound here" in refused("len(items)", {"items": [1]}, {"len": lambda v: 99})
    assert ev("len(items)", {"items": [1], "len": len}) == 1, "the name bound to the real builtin is fine"


def test_only_the_exact_builtin_type_gets_its_methods():
    class Sneaky(dict):
        def get(self, key, default=None):
            raise AssertionError("an override must not run")

    assert "cannot call `d.get`" in refused("d.get('a')", {"d": Sneaky(a=1)})
    assert ev("d.get('a')", {"d": {"a": 1}}) == 1


def test_the_receiver_of_a_method_call_is_evaluated_once():
    box = Box({"k": 1})
    assert ev("obj.payload.get('k')", {"obj": box}) == 1
    assert box.reads == 1, "the property behind the receiver ran exactly once"


def test_check_pure_refuses_before_anything_runs():
    box = Box({})
    with pytest.raises(ValueError):
        check_pure(ast.parse("obj.payload.method()", mode="eval").body)
    assert box.reads == 0
    check_pure(ast.parse("len(sorted(d.items()))", mode="eval").body)


def test_neither_namespace_is_modified():
    globals_ = {"items": [1, 2]}
    locals_ = {"n": 3}
    assert ev("len(items) + n", globals_, locals_) == 5
    assert globals_ == {"items": [1, 2]} and locals_ == {"n": 3}, "the helpers went into a copy"
