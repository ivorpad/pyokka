"""Completions for watch expressions: the prefix split, names in scope, attributes after a dot,
the paused frame through the control channel, and the finished run over the runner."""

from __future__ import annotations

import os
import types

from pyokka_runtime.complete import complete, split_expression
from pyokka_runtime.control import handle_request
from tests.test_debug import CONTINUE, Scripted, attach, results
from tests.test_runner import client  # noqa: F401 - the fixture


class Point:
    kind = "pt"

    def __init__(self, x: int, y: int) -> None:
        self.x = x
        self.y = y

    @property
    def norm(self) -> int:
        raise AssertionError("a property must not run while completing")

    def move(self, dx: int) -> None:
        self.x += dx


def labels(reply: dict) -> list[str]:
    return [i["label"] for i in reply["items"]]


def kinds(reply: dict) -> dict[str, str]:
    return {i["label"]: i["kind"] for i in reply["items"]}


def test_split_expression_finds_the_object_before_the_dot_and_the_prefix():
    assert split_expression("tot") == (None, "tot")
    assert split_expression("") == (None, "")
    assert split_expression("payload.") == ("payload", "")
    assert split_expression("payload.it") == ("payload", "it")
    assert split_expression('payload["items"].app') == ('payload["items"]', "app")
    assert split_expression("1 + rows[0].sc") == ("rows[0]", "sc")
    assert split_expression("self.items.") == ("self.items", "")
    assert split_expression("f(x).re") == ("f(x)", "re")  # rejected later, by the side-effect rule
    assert split_expression("(a + b).") == ("(a + b)", "")
    assert split_expression("a + .") == (None, "")
    assert split_expression("x[1:2].") == ("x[1:2]", "")


def test_bare_prefix_lists_locals_then_globals_then_builtins_and_hides_private_names():
    g = {"total": 10, "payload": {"x": 0}, "Point": Point, "os": os, "helper": lambda: None, "_pk_s": 1, "_hidden": 2, "__name__": "__main__"}
    loc = {"total": 3, "tail": [1], "t": None}
    r = complete("t", g, loc)
    assert labels(r)[:3] == ["t", "tail", "total"], "locals first, sorted"
    assert r["prefix"] == "t"
    k = kinds(r)
    assert k["total"] == "variable" and next(i for i in r["items"] if i["label"] == "total")["type"] == "int", "the local total wins over the global"
    assert k["tuple"] == "class" and kinds(complete("pr", g))["print"] == "builtin"
    assert kinds(complete("Tr", g))["True"] == "keyword" and kinds(complete("no", g))["not"] == "keyword" and kinds(complete("N", g))["None"] == "keyword"
    assert "_hidden" not in labels(r) and "_pk_s" not in labels(complete("_", g, loc))
    assert "_hidden" in labels(complete("_h", g, loc))
    assert kinds(complete("P", g))["Point"] == "class" and kinds(complete("o", g))["os"] == "module" and kinds(complete("h", g))["helper"] == "function"
    assert "type" not in next(i for i in complete("P", g)["items"] if i["label"] == "Point")
    assert labels(complete("zzz", g, loc)) == []
    everything = complete("", g, loc, limit=500)
    assert everything["prefix"] == "" and labels(everything)[:3] == ["t", "tail", "total"] and "print" in labels(everything)
    assert all(i["kind"] != "keyword" for i in everything["items"]), "keywords only once something is typed"


def test_attributes_after_a_dot_come_from_getattr_static_and_never_run_a_property():
    g = {"p": Point(1, 2), "payload": {"x": 0, "items": []}, "os": os, "Point": Point}
    r = complete("p.", g)
    k = kinds(r)
    assert k == {"kind": "attribute", "move": "method", "norm": "property", "x": "attribute", "y": "attribute"}
    assert next(i for i in r["items"] if i["label"] == "x")["type"] == "int"
    assert next(i for i in r["items"] if i["label"] == "kind")["type"] == "str"
    assert labels(complete("p.m", g)) == ["move"] and complete("p.m", g)["prefix"] == "m"
    assert "__init__" in labels(complete("p.__", g)) and "__init__" not in labels(complete("p.", g))
    d = kinds(complete("payload.", g))
    assert d["items"] == "method" and d["get"] == "method" and "keys" in d
    assert kinds(complete("os.pa", g))["path"] == "module" and kinds(complete("os.getc", g))["getcwd"] == "function"
    assert kinds(complete("Point.", g))["move"] == "method" and kinds(complete("Point.", g))["norm"] == "property"
    assert labels(complete('payload["items"].app', g)) == ["append"]
    assert kinds(complete("types.", {"types": types}))["ModuleType"] == "class"
    # a pure call is evaluated like any other receiver (pure.py); a user function is not
    assert labels(complete("sorted(payload).co", g)) == ["copy", "count"]
    assert labels(complete("payload.get('x').bit_l", g)) == ["bit_length"]


def test_an_object_that_cannot_be_evaluated_gives_no_items_and_says_why():
    g = {"f": lambda: 1, "p": Point(1, 2)}
    r = complete("f().", g)
    assert r["items"] == [] and r["error"].startswith("ValueError") and "cannot call `f`" in r["error"]
    r = complete("missing.", g)
    assert r["items"] == [] and r["error"].startswith("NameError")
    r = complete("p.nope.", g)
    assert r["items"] == [] and r["error"].startswith("AttributeError")
    r = complete("(1 +).", g)
    assert r["items"] == [] and r["error"].startswith("SyntaxError")


def test_limit_caps_the_list():
    g = {"v%03d" % i: i for i in range(300)}
    assert len(labels(complete("v", g, limit=25))) == 25
    assert len(labels(complete("v", g))) == 100


LOOP = """
total = 0
payload = {"x": 0, "items": []}
for i in range(3):
    total += i
    payload["items"].append(i)
print(total)
"""


def test_complete_in_the_paused_frame_over_the_control_channel(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    reqs = [
        {"type": "complete", "id": "c1", "expression": "tot"},
        {"type": "complete", "id": "c2", "expression": "payload.it", "limit": 5},
        {"type": "complete", "id": "c3", "expression": "payload.nope."},
        CONTINUE,
    ]
    out = run(LOOP, on_tracer=attach(Scripted(reqs), breakpoints=[{"path": path, "line": 5}]))
    replies = {e["id"]: e for e in results(out, "complete.result")}
    assert labels(replies["c1"]) == ["total"] and replies["c1"]["prefix"] == "tot" and replies["c1"]["items"][0]["type"] == "int"
    assert labels(replies["c2"]) == ["items"] and replies["c2"]["items"][0]["kind"] == "method"
    assert replies["c3"]["items"] == [] and replies["c3"]["error"].startswith("AttributeError")
    assert out.result.exit_code == 0


def test_complete_without_run_data_is_an_error():
    events: list[dict] = []
    handle_request({"type": "complete", "id": "x", "expression": "a"}, None, events.append, None, None)
    assert events == [{"type": "complete.error", "id": "x", "message": "LookupError: no run data"}]


def test_complete_over_the_runner_against_the_finished_run(client, tmp_path):
    client.send(type="hello", version="test")
    assert "complete" in client.recv()["capabilities"]
    scratch = tmp_path / "s.py"
    scratch.write_text(LOOP, encoding="utf-8")
    client.send(type="complete", runId="none", expression="tot")
    err = client.recv()
    assert err["type"] == "error" and "no finished or paused run to complete against" in err["message"]
    client.run(scratch, runId="r1")
    client.send(type="complete", runId="r1", expression="pay")
    reply = client.recv()
    assert reply["type"] == "completed" and reply["prefix"] == "pay" and labels(reply) == ["payload"]
    client.send(type="complete", runId="r1", expression="payload.")
    reply = client.recv()
    assert reply["type"] == "completed" and {"items", "keys", "get"} <= set(labels(reply))
    client.send(type="shutdown")
