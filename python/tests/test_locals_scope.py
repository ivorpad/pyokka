"""``locals --scope local|global|all``, ``--names-only``, ``--name``."""

from __future__ import annotations

import argparse

from pyokka_runtime.agent.commands import add_commands
from pyokka_runtime.agent.render import render
from tests.test_debug import CONTINUE, Scripted, attach, pauses, results
from tests.test_runner import client  # noqa: F401 - the fixture test_debug needs in scope

CLOSURE = """
import os

config = {"mode": "x"}
top = 1


def outer():
    k = 10

    def inner(a):
        b = a + k + top
        return b

    return inner(5)


outer()
"""
# line 13 is `return b`: a pause there has a, b (own), k (free), and the module's config, top


def locals_req(rid, **kw):
    return {"type": "debug", "id": rid, "action": "locals", **kw}


def names_by_scope(run, tmp_path, **extra):
    path = str(tmp_path / "scratch.py")
    batch = [locals_req("default"), locals_req("local", scope="local"), locals_req("global", scope="global"), locals_req("all", scope="all"), locals_req("bad", scope="nope"), CONTINUE]
    out = run(CLOSURE, on_tracer=attach(Scripted(batch), breakpoints=[{"path": path, "line": 13}]))
    assert [p["line"] for p in pauses(out)] == [13]
    replies = {r["id"]: r for r in results(out, "debug.result")}
    errors = {r["id"]: r for r in out.events if r.get("type") == "debug.error"}
    return {k: sorted(v["name"] for v in replies[k]["locals"]) for k in ("default", "local", "global", "all")}, errors


def test_the_three_scopes_at_a_pause_in_a_closure(run, tmp_path):
    names, errors = names_by_scope(run, tmp_path)
    assert names["local"] == ["a", "b"], names
    assert names["global"] == ["config", "top"], names
    assert names["all"] == ["a", "b", "config", "k", "top"], names
    assert names["default"] == ["a", "b", "k"], "without --scope the frame's f_locals, as before"
    assert "scope must be local, global or all" in errors["bad"]["message"]


def test_names_only_and_name_filter(run, tmp_path):
    path = str(tmp_path / "scratch.py")
    batch = [locals_req("n", namesOnly=True, scope="all"), locals_req("one", names=["b", "config"], scope="all"), CONTINUE]
    out = run(CLOSURE, on_tracer=attach(Scripted(batch), breakpoints=[{"path": path, "line": 13}]))
    replies = {r["id"]: r for r in results(out, "debug.result")}
    only = {v["name"]: v for v in replies["n"]["locals"]}
    assert only["config"]["type"] == "dict" and only["a"]["type"] == "int"
    assert all(v["text"] == "" and "valueBag" not in v for v in only.values())
    assert sorted(v["name"] for v in replies["one"]["locals"]) == ["b", "config"]


def parser():
    p = argparse.ArgumentParser(prog="pyokka")
    add_commands(p.add_subparsers(dest="command", required=True))
    return p


def test_the_cli_flags_parse_and_names_only_prints_name_colon_type():
    args = parser().parse_args(["locals", "--live", "--scope", "global", "--names-only", "--name", "config", "--name", "top"])
    assert (args.scope, args.names_only, args.name) == ("global", True, ["config", "top"])
    text = render("locals", {"locals": [{"name": "config", "type": "dict", "text": ""}, {"name": "top", "type": "int", "text": ""}]}, None, argparse.Namespace(json=False, names_only=True))
    assert text.splitlines() == ["config: dict", "top: int"]


def test_live_run_sends_the_scope_and_names():
    from pyokka_runtime.agent.live import LiveRun

    sent = []

    class Fake(LiveRun):
        def __init__(self):
            pass

        def request(self, req):
            sent.append(req)
            return {"locals": []}

    Fake().locals(scope="local", names_only=True, names=["a"])
    assert sent == [{"type": "locals", "scope": "local", "namesOnly": True, "names": ["a"]}]
