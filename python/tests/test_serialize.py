"""Serializer edge cases."""

from __future__ import annotations

import enum
import json
from collections import namedtuple
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from pyokka_runtime.protocol import LogLimitSet
from pyokka_runtime.serialize import Registry, serialize, short_repr

LIMITS = LogLimitSet(5, 50, 100)


def props(node):
    return {p["name"]: p for p in node.get("props", [])}


def test_primitives_and_type_names():
    assert serialize(None, LIMITS)["type"] == "None"
    assert serialize(True, LIMITS) | {} == serialize(True, LIMITS)
    assert serialize(True, LIMITS)["value"] == "True"
    assert serialize(3, LIMITS)["type"] == "number"
    n = serialize(float("nan"), LIMITS)
    assert n["nan"] is True and n["value"] == "nan"
    assert serialize(float("inf"), LIMITS)["positiveInfinity"] is True
    assert serialize(float("-inf"), LIMITS)["negativeInfinity"] is True
    assert serialize(b"ab", LIMITS)["type"] == "bytes"
    assert serialize(frozenset({1}), LIMITS)["type"] == "frozenset"
    assert serialize(len, LIMITS)["type"] == "function"
    assert serialize(json, LIMITS)["type"] == "module"
    assert serialize(int, LIMITS)["type"] == "class"


def test_big_string_is_capped_with_prefix_and_length():
    s = "x" * 1000
    n = serialize(s, LogLimitSet(5, 50, 10))
    assert n["type"] == "str" and n["length"] == 1000
    assert n["value"] == "x" * 10
    assert n["capped"] == "x" * 10


def test_cycle_detection_marks_only_ancestors():
    d = {"a": 1}
    d["self"] = d
    shared = [1]
    outer = {"x": shared, "y": shared, "d": d}
    n = serialize(outer, LIMITS)
    p = props(n)
    assert p["x"]["props"] and p["y"]["props"]  # shared but not circular
    inner = props(p["d"])
    assert inner["self"]["circular"] is True
    assert inner["self"]["value"] == "[Circular]"


def test_dict_int_keys_keep_key_repr():
    n = serialize({1: "a", "1": "b", (1, 2): "c"}, LIMITS)
    names = [(p["name"], p["keyRepr"]) for p in n["props"]]
    assert names == [("1", "1"), ("1", "'1'"), ("(1, 2)", "(1, 2)")]
    assert n["props"][0]["queryPath"] == ["0", "_p_1"]
    assert n["props"][0]["expressionPath"] == "$[1]"


def test_dataclass_namedtuple_enum():
    @dataclass
    class P:
        x: int
        y: int = 2

    NT = namedtuple("NT", "a b")

    class Color(enum.Enum):
        RED = 1

    n = serialize(P(1), LIMITS)
    assert n["type"] == "P" and [p["name"] for p in n["props"]] == ["x", "y"]
    n = serialize(NT(1, 2), LIMITS)
    assert n["type"] == "NT" and [p["name"] for p in n["props"]] == ["a", "b"] and n["length"] == 2
    n = serialize(Color.RED, LIMITS)
    assert n["type"] == "Color" and n["value"] == "Color.RED"
    assert props(n)["value"]["value"] == "1"


def test_properties_and_getattr_never_invoked_unless_resolve_getters():
    calls = []

    class Lazy:
        __slots__ = ("stored",)

        def __init__(self):
            self.stored = 1

        @property
        def boom(self):
            calls.append("boom")
            raise RuntimeError("must not be called")

        def __getattr__(self, name):
            calls.append(name)
            raise AttributeError(name)

    n = serialize(Lazy(), LIMITS)
    assert calls == []
    assert [p["name"] for p in n["props"]] == ["stored"]
    n = serialize(Lazy(), LIMITS, resolve_getters=True)
    assert "boom" in props(n) and "getter raised" in props(n)["boom"]["value"]


def test_guarded_repr():
    class Bad:
        def __repr__(self):
            raise ValueError("no repr")

    n = serialize(Bad(), LIMITS)
    assert n["type"] == "Bad" and "Bad" in n["value"]
    assert short_repr(Bad()).startswith("<Bad")


def test_leaf_types_and_exceptions():
    assert serialize(Decimal("1.5"), LIMITS)["value"] == "Decimal('1.5')"
    assert serialize(Path("/tmp"), LIMITS)["type"].endswith("Path")
    assert "datetime" in serialize(datetime(2020, 1, 1), LIMITS)["value"]
    try:
        try:
            raise KeyError("inner")
        except KeyError as e:
            raise ValueError("outer") from e
    except ValueError as exc:
        n = serialize(exc, LIMITS)
    assert n["type"] == "ValueError"
    p = props(n)
    assert p["args"]["type"] == "tuple"
    assert p["__cause__"]["type"] == "KeyError"
    assert p["traceback"]["type"] == "list"


def test_depth_and_breadth_limits_with_load_more_node():
    deep = {"a": {"b": {"c": {"d": 1}}}}
    n = serialize(deep, LogLimitSet(2, 50, 100))
    b = props(props(n)["a"])["b"]
    assert b.get("capped") is True and b["expandable"] is True and "props" not in b
    wide = list(range(100))
    n = serialize(wide, LogLimitSet(2, 10, 100))
    assert n["cappedElements"] is True
    assert n["props"][-1]["loadActionNode"] is True
    assert n["props"][-1]["id"] == n["id"] + " +"
    assert len(n["props"]) == 11


def test_expression_tree_forces_expansion_along_path():
    deep = {"a": {"b": {"c": {"d": [1, 2]}}}}
    n = serialize(deep, LogLimitSet(1, 50, 100), expand_tree={"_p_a": {"_p_b": {"_p_c": {}}}})
    b = props(props(n)["a"])["b"]
    assert "props" in b and "d" in props(props(b)["c"])


def test_registry_resolves_ids_and_paths():
    reg = Registry()
    data = {"items": [{"k": 1}, {"k": 2}]}
    n = serialize(data, LIMITS, root_key="17", registry=reg)
    child = props(n)["items"]["props"][1]
    obj, path, more = reg.resolve(child["id"], child["queryPath"])
    assert obj == {"k": 2} and path == ["17", "_p_items", "_p_1"]
    obj, _, more = reg.resolve(None, ["17", "_p_items", "_p_0", "_p_k"])
    assert obj == 1 and more is False
    obj, _, more = reg.resolve(n["id"] + " +", ["17"])
    assert obj is data and more is True


def test_object_with_dict_and_slots_and_private_hook_names_hidden():
    class S:
        __slots__ = ("a", "b")

    s = S()
    s.a = 1
    n = serialize(s, LIMITS)
    assert [p["name"] for p in n["props"]] == ["a"]  # unset slot skipped

    class D:
        pass

    d = D()
    d.v = 1
    d._pk_scope_ = 3
    assert [p["name"] for p in serialize(d, LIMITS)["props"]] == ["v"]


def test_node_is_json_serialisable():
    class Weird:
        def __init__(self):
            self.s = {1, 2}
            self.t = (1,)

    json.dumps(serialize(Weird(), LIMITS))
