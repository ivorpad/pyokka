"""Whole values at a live pause: ``limits.textLen`` on ``locals`` and ``evaluate``, the ``fields`` of a cut value.

Smoke test 2026-10-19: a 256-character dataclass local came back cut at 200, the editor's preview
length, because the runtime read every live value at that length. An agent's request now asks for
more (``dbgtext.py``); a request without ``limits``, which is every request the editor makes, keeps
the old text exactly. The CLI then prints what the runtime sent without cutting it again, lists the
fields under a cut value, and ends an output that cut something with one hint line.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from pyokka_runtime import secrets
from pyokka_runtime.agent.render import render
from pyokka_runtime.agent.render_debug import CUT_HINT
from pyokka_runtime.agent.shell import build_parser
from pyokka_runtime.dbgtext import FIELDS_MAX, fields
from pyokka_runtime.secrets import MASK
from tests.test_debug import CONTINUE, Scripted, attach, pauses, until
from tests.test_runner import client  # noqa: F401 - the fixture test_debug needs in scope

PROGRAM = """
from dataclasses import dataclass
from typing import NamedTuple


@dataclass
class Policy:
    allowed_schemes: frozenset
    block_private_ips: bool
    allowed_hosts: tuple
    api_token: str


@dataclass(slots=True)
class Box:
    label: str
    items: list


class Pair(NamedTuple):
    left: str
    right: str


def check(policy, small, config, rows, box, pair):
    return policy.block_private_ips


hosts = tuple("h%03d.example.com" % i for i in range(150))
policy = Policy(frozenset({"https"}), True, hosts, "sk-live-0123456789abcdef")
small = Policy(frozenset({"https"}), True, hosts[:10], "x")
config = {"host": "example.com", "password": "hunter22-hunter22", "blob": "z" * 3000}
rows = list(range(1000))
box = Box("L" * 2500, [1, 2, 3])
pair = Pair("a" * 1500, "b" * 1500)
check(policy, small, config, rows, box, pair)
"""
LINE = PROGRAM.split("\n").index("    return policy.block_private_ips") + 1
HOSTS = tuple("h%03d.example.com" % i for i in range(150))
AGENT = {"limits": {"textLen": 2000}}


@dataclass
class Policy:
    """The program's dataclass, so the test knows the whole text it should see."""

    allowed_schemes: frozenset
    block_private_ips: bool
    allowed_hosts: tuple
    api_token: str


def locals_req(rid, **kw):
    return {"type": "debug", "id": rid, "action": "locals", **kw}


def eval_req(rid, expression, **kw):
    return {"type": "evaluate", "id": rid, "expression": expression, **kw}


def at_the_pause(run, tmp_path, *batch) -> dict:
    """Run PROGRAM to its pause in ``check``, serve ``batch`` there, and answer the replies by request id."""
    path = str(tmp_path / "scratch.py")
    out = run(PROGRAM, on_tracer=attach(Scripted([*batch, CONTINUE]), breakpoints=[{"path": path, "line": LINE}]))
    assert [p["line"] for p in pauses(out)] == [LINE]
    errors = [e for e in out.events if e.get("type", "").endswith(".error")]
    assert errors == []
    return {e["id"]: e for e in out.events if e.get("type") in ("debug.result", "evaluate.result")}


def by_name(reply: dict) -> dict:
    return {v["name"]: v for v in reply["locals"]}


def test_a_300_character_dataclass_is_whole_under_the_agents_limit_and_cut_under_the_default(run, tmp_path):
    replies = at_the_pause(run, tmp_path, locals_req("editor", names=["small"]), locals_req("agent", names=["small"], **AGENT))
    full = repr(Policy(frozenset({"https"}), True, HOSTS[:10], "x"))
    assert len(full) == 299
    (editor,) = replies["editor"]["locals"]
    (agent,) = replies["agent"]["locals"]
    assert editor["text"] == full[:199] + "…" and "fields" not in editor, "no limits: the editor's 200, no cut mark, no fields"
    # whole, and the secret-named keyword the longer text now reaches is still masked
    assert agent["text"] == full.replace("api_token='x'", "api_token='%s'" % MASK) and "fields" not in agent
    assert agent["valueBag"]["data"]["type"] == "Policy", "the value bag rides along as before"


def test_a_cut_value_lists_its_fields_with_the_secret_ones_masked(run, tmp_path):
    replies = at_the_pause(run, tmp_path, locals_req("agent", **AGENT), locals_req("editor"))
    agent, editor = by_name(replies["agent"]), by_name(replies["editor"])
    assert not [v for v in editor.values() if "fields" in v or "fieldsMore" in v], "the editor's request gets no fields"

    # a dataclass: its __dict__ in field order, each text at 200, the token masked by its own name
    full = repr(Policy(frozenset({"https"}), True, HOSTS, "sk-live-0123456789abcdef"))
    policy = agent["policy"]
    assert policy["text"] == "%s…(+%s chars)" % (full[:1999], format(len(full) - 1999, ","))
    assert [name for name, _ in policy["fields"]] == [".allowed_schemes", ".block_private_ips", ".allowed_hosts", ".api_token"]
    got = dict(policy["fields"])
    assert got[".allowed_schemes"] == "frozenset({'https'})" and got[".block_private_ips"] == "True"
    assert got[".api_token"] == "'%s'" % MASK and "sk-live" not in str(replies)
    assert got[".allowed_hosts"].startswith("('h000.example.com', 'h001.example.com', ") and got[".allowed_hosts"].endswith("…(+2,801 chars)")
    assert "fieldsMore" not in policy

    # a dict: its items through dict.items, the key's repr in the name, the password masked
    config = dict(agent["config"]["fields"])
    assert list(config) == ["['host']", "['password']", "['blob']"]
    assert config["['host']"] == "'example.com'" and config["['password']"] == "'%s'" % MASK
    assert config["['blob']"].startswith("'zzz") and config["['blob']"].endswith("…(+2,802 chars)")

    # a list: its first twenty items, and how many more
    rows = agent["rows"]
    assert rows["fields"] == [["[%d]" % i, str(i)] for i in range(FIELDS_MAX)] and rows["fieldsMore"] == 1000 - FIELDS_MAX

    # a slots dataclass through its member descriptors, a namedtuple by _fields
    assert [name for name, _ in agent["box"]["fields"]] == [".label", ".items"] and dict(agent["box"]["fields"])[".items"] == "[1, 2, 3]"
    assert [name for name, _ in agent["pair"]["fields"]] == [".left", ".right"]
    assert "fields" not in agent["small"], "a whole text needs no fields"


def test_evaluate_takes_the_same_limit_and_lists_no_fields(run, tmp_path):
    replies = at_the_pause(run, tmp_path, eval_req("editor", "small"), eval_req("agent", "small", **AGENT), eval_req("blob", 'config["blob"]', **AGENT))
    full = repr(Policy(frozenset({"https"}), True, HOSTS[:10], "x"))
    assert replies["editor"]["text"] == full[:199] + "…"
    assert replies["agent"]["text"] == full.replace("api_token='x'", "api_token='%s'" % MASK) and "fields" not in replies["agent"]
    blob = replies["blob"]["text"]
    assert blob.startswith("'zzz") and blob.endswith("…(+1,002 chars)") and len(blob) == 2000 + len("…(+1,002 chars)")


def test_the_limit_crosses_the_runner_on_both_requests(client, tmp_path):
    """The host's request reaches the run child whole: ``evaluate`` and the ``locals`` action both forward ``limits``."""
    client.send(type="hello", version="test")
    client.recv()
    scratch = tmp_path / "long.py"
    scratch.write_text("text = 'q' * 900\nprint(len(text))\n", encoding="utf-8")
    base = {"file": {"path": str(scratch), "displayName": scratch.name}, "workspaceRoot": str(tmp_path), "cwd": str(tmp_path), "argv": [], "env": {}, "projectFiles": [], "markers": [], "expressionsToEvaluate": {}, "watch": [], "mode": "normal"}
    client.send(type="run", runId="t1", config={"timeoutMs": 20000, "debug": True, "stopOnEntry": False}, breakpoints=[{"path": str(scratch), "line": 2}], **base)
    assert until(client, "debug.paused")["line"] == 2
    client.send(type="evaluate", runId="t1", expression="text")
    assert len(until(client, "evaluated")["text"]) == 200
    client.send(type="evaluate", runId="t1", expression="text", limits={"textLen": 2000})
    assert until(client, "evaluated")["text"] == repr("q" * 900)
    client.send(type="debug", runId="t1", action="locals", names=["text"], limits={"textLen": 2000})
    assert until(client, "debug.result")["locals"][0]["text"] == repr("q" * 900)
    client.send(type="debug", runId="t1", action="continue")
    until(client, "debug.result")
    assert until(client, "run.finished")["exitCode"] == 0


def test_fields_run_none_of_the_programs_code_but_repr():
    calls: list[str] = []

    class Loud(dict):
        def items(self):
            calls.append("items")
            raise AssertionError

        def __iter__(self):
            calls.append("iter")
            raise AssertionError

        def __len__(self):
            calls.append("len")
            raise AssertionError

    class Guarded:
        def __init__(self):
            self.a = 1
            self.b = "two"

        def __getattribute__(self, name):
            calls.append(name)
            raise AssertionError

        @property
        def c(self):
            calls.append("c")
            raise AssertionError

    assert fields(Loud(x=1, y=2)) == ([["['x']", "1"], ["['y']", "2"]], 0)
    assert fields(Guarded()) == ([[".a", "1"], [".b", "'two'"]], 0)
    assert calls == [], "no override and no property ran"
    assert fields("a long string" * 300) == ([], 0) and fields({1, 2, 3}) == ([], 0)


def test_fields_mask_a_secret_by_its_own_name():
    secrets.install(True)
    pairs, more = fields({"api_key": "sk-0123456789abcdef", "label": "plain words"})
    assert (pairs, more) == ([["['api_key']", "'%s'" % MASK], ["['label']", "'plain words'"]], 0)


# -- the CLI's text: no second cut, the fields under the value, one hint when something was cut ----------------------

SOURCE = type("S", (), {"display_path": staticmethod(lambda p: os.path.basename(str(p)))})()
#: what the runtime sends for a cut dataclass at 2,000: 1,999 characters of it and the mark
CUT = "Policy(" + "h" * 1992 + "…(+1,123 chars)"


def text_of(command: str, result: dict, *words: str) -> list[str]:
    return render(command, result, SOURCE, build_parser().parse_args([command, *words])).splitlines()


def stop_with(*local_vars: dict) -> dict:
    """A ``record: false`` stop as the debug socket sends it, with these locals."""
    return {"location": {"file": "/ws/app.py", "line": 42}, "paused": {"reason": "breakpoint"}, "recording": False, "block": {"file": "/ws/app.py", "function": "check", "lines": []}, "locals": list(local_vars)}


def test_a_cut_local_prints_whole_with_its_fields_under_it_and_one_hint_at_the_end():
    assert len(CUT) == 2014, "longer than 2,000: the old 2,000-character line limit would have cut it again"
    policy = {"name": "policy", "text": CUT, "fields": [[".allowed_schemes", "frozenset({'https'})"], [".allowed_hosts", "('h000.example.com', …(+2,801 chars)"]], "fieldsMore": 2}
    assert text_of("locals", {"locals": [policy, {"name": "n", "text": "3"}]}, "--live") == [
        "policy = " + CUT,
        "  .allowed_schemes = frozenset({'https'})",
        "  .allowed_hosts = ('h000.example.com', …(+2,801 chars)",
        "  … 2 more",
        "n = 3",
        CUT_HINT,
    ]
    # a stop: the same lines under `locals:`, and the hint once, after everything else, however many values were cut
    lines = text_of("continue", stop_with(policy, {"name": "other", "text": CUT}), "--live")
    at = lines.index("locals:")
    assert lines[at + 1 : at + 5] == ["  policy = " + CUT, "    .allowed_schemes = frozenset({'https'})", "    .allowed_hosts = ('h000.example.com', …(+2,801 chars)", "    … 2 more"]
    assert lines.count(CUT_HINT) == 1 and lines[-1] == CUT_HINT


def test_the_hint_appears_only_when_a_live_value_was_cut():
    assert CUT_HINT not in text_of("locals", {"locals": [{"name": "n", "text": "3"}, {"name": "s", "text": "'…'"}]}, "--live")
    assert CUT_HINT not in text_of("continue", stop_with({"name": "n", "text": "3"}), "--live")
    # eval: a cut text gets it, a whole one does not
    long = "'" + "z" * 1999 + "…(+1,002 chars)"
    assert text_of("eval", {"expression": "s", "text": long}, "--live", "s") == ["s = " + long, CUT_HINT]
    assert text_of("eval", {"expression": "s", "text": "'short'"}, "--live", "s") == ["s = 'short'"]
    # a recorded value keeps the length its run gave it: its mark is not this hint's business
    recorded = {"step": 3, "count": 9, "location": {"file": "/ws/app.py", "line": 4, "function": "f"}, "stack": [], "block": {"file": "/ws/app.py", "function": "f", "lines": [], "firstStep": 0},
                "values": [{"step": 3, "line": 4, "file": "/ws/app.py", "context": "s", "text": "'zzz…(+40 chars)"}], "moves": {"into": None, "over": None, "out": None, "back": 2, "backOver": 2, "backOut": None}}
    assert CUT_HINT not in text_of("context", recorded, "--live")


def test_text_len_widens_the_line_too_and_never_narrows_it():
    asked = "'" + "y" * 9999 + "…(+5 chars)"  # `--text-len 10000`: what the runtime sends
    assert text_of("locals", {"locals": [{"name": "s", "text": asked}]}, "--live", "--text-len", "10000")[0] == "s = " + asked
    assert text_of("locals", {"locals": [{"name": "s", "text": asked}]}, "--live")[0] != "s = " + asked, "without it the line is the default's"
    whole = "'" + "w" * 50_000 + "'"
    assert text_of("eval", {"expression": "s", "text": whole}, "--live", "s", "--text-len", "0") == ["s = " + whole], "0: all of it"
    # a saved run's eval answers at 200 whatever --text-len says, and the line never goes below 2,000
    assert text_of("eval", {"expression": "s", "text": "'" + "v" * 300 + "'"}, "s", "--text-len", "5")[0] == "s = '" + "v" * 300 + "'"
