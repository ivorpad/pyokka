"""`pyokka graph`: the execution graph over the two fixture runs, `--all`, `--expand`, `--scope`, `--no-statements`, the cap, the text, dot, `--json` and `--live` forms, `examples/demo.py`.

Two fixture programs. The walkthrough's (`test/unit/fixtures/walkthrough/`): this file writes
`test/unit/fixtures/execution-graph.json` (four graphs: default, `--all`, `--scope fail`, cap 6)
under PYOKKA_WRITE_FIXTURES=1 and compares against it otherwise. The statement-node program
(`test/unit/fixtures/graph/main.py`): its run goes to `graph-run.json` and its graphs (default,
`functions` = `--no-statements`) to `execution-graph-statements.json`. The TypeScript builder
(`test/unit/executionGraph.test.ts`) reads both runs and must produce the same JSON.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pyokka_runtime.agent.graph import graph, render_graph
from pyokka_runtime.agent.graph_dot import render_dot
from pyokka_runtime.agent.live import SESSIONS_ENV
from pyokka_runtime.agent.source import SavedRun

from conftest import DEMO
from test_agent_live import FakeBridge, write_descriptor
from test_walkthrough import FIXTURES, fixture_run, normalize, pyokka, saved_run  # noqa: F401  (fixture_run is a fixture)

GRAPH_JSON = FIXTURES / "execution-graph.json"
GRAPH_PROGRAM = FIXTURES / "graph" / "main.py"
GRAPH_RUN_JSON = FIXTURES / "graph-run.json"
STATEMENTS_JSON = FIXTURES / "execution-graph-statements.json"


def pyokka_json(*args: str) -> dict:
    code, out = pyokka(*args, "--json")
    doc = json.loads(out)
    assert code == 0, doc
    return doc


def graphs(run_path: Path) -> dict:
    run = SavedRun(str(run_path))
    return {"default": graph(run), "all": graph(run, all_scopes=True), "scope": graph(run, scope="fail"), "cap": graph(run, cap=6)}


def by_label(doc: dict, label: str, kind: str | None = None) -> dict:
    return next(n for n in doc["nodes"] if n["label"] == label and (kind is None or n["kind"] == kind))


def edge(doc: dict, a: str, b: str, kind: str = "call", label: str | None = None) -> dict:
    ids = {n["id"]: n["label"] for n in doc["nodes"]}
    return next(e for e in doc["edges"] if ids[e["from"]] == a and ids[e["to"]] == b and e["kind"] == kind and (label is None or e.get("label") == label))


def labelled_edges(doc: dict) -> list[tuple]:
    """`(from label, to label, kind, count or data label)` per edge, in order."""
    ids = {n["id"]: n["label"] for n in doc["nodes"]}
    return [(ids[e["from"]], ids[e["to"]], e["kind"], e["label"] if e["kind"] == "data" else e["count"]) for e in doc["edges"]]


@pytest.fixture
def statements_run(tmp_path: Path) -> Path:
    return saved_run(tmp_path, GRAPH_PROGRAM.read_text(encoding="utf-8"))


# -- the shared fixtures -------------------------------------------------------------------------------------

def test_fixture_graphs_match_the_shared_json(fixture_run: Path, tmp_path: Path):
    root = str(tmp_path / "proj")
    docs = json.loads(normalize(json.dumps(graphs(fixture_run), ensure_ascii=False), root))
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        GRAPH_JSON.write_text(json.dumps(docs, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    expected = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
    for key in ("default", "all", "scope", "cap"):
        assert [n["label"] for n in docs[key]["nodes"]] == [n["label"] for n in expected[key]["nodes"]], key
        assert docs[key] == expected[key], key


def test_statement_fixture_graphs_match_the_shared_json(statements_run: Path, tmp_path: Path):
    root = str(tmp_path / "proj")
    run = SavedRun(str(statements_run))
    docs = json.loads(normalize(json.dumps({"default": graph(run), "functions": graph(run, statements=False)}, ensure_ascii=False), root))
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        GRAPH_RUN_JSON.write_text(normalize(statements_run.read_text(encoding="utf-8"), root) + "\n", encoding="utf-8")
        STATEMENTS_JSON.write_text(json.dumps(docs, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    expected = json.loads(STATEMENTS_JSON.read_text(encoding="utf-8"))
    for key in ("default", "functions"):
        assert [n["label"] for n in docs[key]["nodes"]] == [n["label"] for n in expected[key]["nodes"]], key
        assert docs[key] == expected[key], key


# -- statement nodes on the fixture program -------------------------------------------------------------------

def test_statement_nodes_of_the_fixture_program(statements_run: Path):
    doc = graph(SavedRun(str(statements_run)))
    kinds = [(n["kind"], n["label"]) for n in doc["nodes"]]
    assert [k for k in kinds if k[0] == "function"] == [("function", "parse_event"), ("function", "Event.__init__"), ("function", "shout")]
    assert by_label(doc, "shout")["calls"] == 2
    stmts = {n["label"]: n for n in doc["nodes"] if n["kind"] == "statement"}
    main = by_label(doc, "<module>")
    under_main = [n["label"] for n in doc["nodes"] if n["kind"] == "statement" and n["parent"] == main["id"]]
    assert under_main == ['text = "fair|Sep 16|alice,bob"', "event = parse_event(text, year=2026)", "count = 0", "count += 1", 'print(f"Participant: {person}")', "label = shout(event.name)", 'summary = f"{label} with {count} people on {event.date}"', "print(summary)", 'shout("")', "handled = True"]
    text = stmts['text = "fair|Sep 16|alice,bob"']
    assert (text["targets"], text["reads"], text["hits"], text["line"]) == (["text"], [], 1, 36)
    assert text["rows"] == [{"kind": "out", "name": "text", "text": "'fair|Sep 16|alice,bob'", "step": text["firstStep"]}]
    assert list(text.keys()) == ["id", "kind", "parent", "label", "file", "line", "fileId", "text", "targets", "reads", "firstStep", "hits", "rows"]
    ev = stmts["event = parse_event(text, year=2026)"]
    assert (ev["targets"], ev["reads"]) == (["event"], ["parse_event", "text"])
    count = stmts["count += 1"]
    assert (count["targets"], count["reads"], count["hits"]) == (["count"], ["count"], 2) and count["rows"][0]["name"] == "count"
    p = stmts['print(f"Participant: {person}")']
    assert (p["targets"], p["reads"], p["hits"]) == ([], ["print", "person"], 2)
    assert p["rows"] == [{"kind": "print", "name": "stdout", "text": "Participant: alice", "step": p["firstStep"]}]
    assert stmts["label = shout(event.name)"]["reads"] == ["shout", "event"]
    assert stmts['summary = f"{label} with {count} people on {event.date}"']["reads"] == ["label", "count", "event"]
    assert stmts["print(summary)"]["rows"][0] == {"kind": "print", "name": "stdout", "text": "FAIR with 2 people on Sep 16 2026", "step": stmts["print(summary)"]["firstStep"]}
    assert not any(l.startswith(("import", "try", "except", '"""', "summary = label")) for l in stmts)
    # decisions
    dec = {n["label"]: n for n in doc["nodes"] if n["kind"] == "decision"}
    assert dec["for person in event.participants"]["hits"] == 2 and dec["for person in event.participants"]["parent"] == main["id"]
    assert dec["if count > 1"]["taken"] == "True" and dec["if count > 1"]["notRun"] == [46]
    assert dec["if not word"]["hits"] == 2 and dec["if not word"]["taken"] == "False" and dec["if not word"]["notRun"] == [] and dec["if not word"]["parent"] == by_label(doc, "shout")["id"]
    # under parse_event and shout
    pe = by_label(doc, "parse_event")
    under_pe = [n for n in doc["nodes"] if n["kind"] == "statement" and n["parent"] == pe["id"]]
    assert [n["label"] for n in under_pe] == ['name, date, people = text.split("|")', 'participants = people.split(",")', 'event = Event( name=name, date=f"{date} {year}", participan…', "return event"]
    assert under_pe[0]["targets"] == ["name", "date", "people"] and under_pe[0]["reads"] == ["text"]
    assert under_pe[2]["text"] == 'event = Event( name=name, date=f"{date} {year}", participants=participants, )' and under_pe[2]["reads"] == ["Event", "name", "date", "year", "participants"] and under_pe[2]["line"] == 22
    sh = by_label(doc, "shout")
    under_sh = {n["label"]: n for n in doc["nodes"] if n["kind"] == "statement" and n["parent"] == sh["id"]}
    assert set(under_sh) == {'raise ValueError("empty")', "return word.upper()"}
    raise_ = under_sh['raise ValueError("empty")']
    assert raise_["hits"] == 1 and raise_["rows"] == [{"kind": "raised", "name": "ValueError", "text": "empty", "step": raise_["firstStep"]}]
    assert [r["kind"] for r in sh["rows"]] == ["in", "out"]  # the handled raise sits on the statement, not on the function
    # call edges leave from the statements
    edges = labelled_edges(doc)
    assert [e for e in edges if e[2] == "call"] == [("event = parse_event(text, year=2026)", "parse_event", "call", 1), ('event = Event( name=name, date=f"{date} {year}", participan…', "Event.__init__", "call", 1), ("label = shout(event.name)", "shout", "call", 1), ('shout("")', "shout", "call", 1)]
    # data edges: every one
    assert [e for e in edges if e[2] == "data"] == [
        ('text = "fair|Sep 16|alice,bob"', "event = parse_event(text, year=2026)", "data", "text"),
        ("parse_event", 'name, date, people = text.split("|")', "data", "text"),
        ('name, date, people = text.split("|")', 'participants = people.split(",")', "data", "people"),
        ("parse_event", 'event = Event( name=name, date=f"{date} {year}", participan…', "data", "year"),
        ('name, date, people = text.split("|")', 'event = Event( name=name, date=f"{date} {year}", participan…', "data", "date"),
        ('name, date, people = text.split("|")', 'event = Event( name=name, date=f"{date} {year}", participan…', "data", "name"),
        ('participants = people.split(",")', 'event = Event( name=name, date=f"{date} {year}", participan…', "data", "participants"),
        ("Event.__init__", "self.name = name", "data", "name"),
        ("Event.__init__", "self.date = date", "data", "date"),
        ("Event.__init__", "self.participants = participants", "data", "participants"),
        ('event = Event( name=name, date=f"{date} {year}", participan…', "return event", "data", "event"),
        ("event = parse_event(text, year=2026)", "for person in event.participants", "data", "event"),
        ("count = 0", "count += 1", "data", "count"),
        ("for person in event.participants", 'print(f"Participant: {person}")', "data", "person"),
        ("event = parse_event(text, year=2026)", "label = shout(event.name)", "data", "event"),
        ("Event.__init__", "shout", "data", "word"),  # the old rule: `in word = 'fair'` matches the text of `self.name = name` logged inside Event.__init__
        ("shout", "if not word", "data", "word"),
        ("shout", "return word.upper()", "data", "word"),
        ("count += 1", "if count > 1", "data", "count"),
        ("event = parse_event(text, year=2026)", 'summary = f"{label} with {count} people on {event.date}"', "data", "event"),
        ("count += 1", 'summary = f"{label} with {count} people on {event.date}"', "data", "count"),
        ("label = shout(event.name)", 'summary = f"{label} with {count} people on {event.date}"', "data", "label"),
        ('summary = f"{label} with {count} people on {event.date}"', "print(summary)", "data", "summary"),
    ]
    e = edge(doc, "count = 0", "count += 1", "data")
    assert e == {"id": e["id"], "from": stmts["count = 0"]["id"], "to": count["id"], "kind": "data", "label": "count", "firstStep": count["firstStep"]}
    # moments: the value of `count = 0`, the prints and the handled error map to their statements
    refs = {m["id"]: m for m in doc["moments"]}
    assert [m["nodeId"] for m in doc["moments"] if m["kind"] == "value" and m["step"] == stmts["count = 0"]["firstStep"]] == [stmts["count = 0"]["id"]]
    assert [m["nodeId"] for m in doc["moments"] if m["kind"] == "print"] == [p["id"], p["id"], stmts["print(summary)"]["id"]]
    assert [m["nodeId"] for m in doc["moments"] if m["kind"] == "error"] == [raise_["id"]]
    assert refs["m0"]["nodeId"] == main["id"] and doc["moments"][-1]["kind"] == "end"
    assert doc["capped"] is False and doc["truncated"] is False
    assert [n["id"] for n in doc["nodes"]] == ["n%d" % i for i in range(len(doc["nodes"]))]
    # node order: a function node before the statement that called it on the same step
    assert doc["nodes"].index(pe) + 1 == doc["nodes"].index(ev)


def test_statements_off_is_the_graph_without_them(statements_run: Path):
    run = SavedRun(str(statements_run))
    doc = graph(run, statements=False)
    assert [(n["kind"], n["label"]) for n in doc["nodes"]] == [("module", "<module>"), ("function", "parse_event"), ("function", "Event.__init__"), ("decision", "for person in event.participants"), ("function", "shout"), ("decision", "if not word"), ("decision", "if count > 1")]
    assert labelled_edges(doc) == [("<module>", "parse_event", "call", 1), ("parse_event", "Event.__init__", "call", 1), ("<module>", "shout", "call", 2), ("Event.__init__", "shout", "data", "word")]
    sh = by_label(doc, "shout")
    assert [r["kind"] for r in sh["rows"]] == ["in", "out", "raised"]  # the handled raise is back on the function
    refs = {m["kind"] for m in doc["moments"]}
    assert refs == {"start", "value", "call", "decision", "print", "error", "end"} and all(m["nodeId"] in {n["id"] for n in doc["nodes"]} for m in doc["moments"])
    code, text = pyokka("graph", str(statements_run), "--no-statements", "--json")
    assert code == 0 and json.loads(text) == json.loads(json.dumps(doc))
    code, text = pyokka("graph", str(statements_run), "--no-statements")
    assert code == 0 and text.splitlines()[0] == "7 nodes, 4 edges over 33 steps"


# -- the walkthrough fixture ------------------------------------------------------------------------------------

def test_default_graph_nodes_and_edges(fixture_run: Path):
    doc = graph(SavedRun(str(fixture_run)))
    labels = [(n["kind"], n["label"]) for n in doc["nodes"]]
    assert labels == [
        ("module", "<module>"), ("statement", "sys.path.insert(0, os.path.join(os.path.dirname(os.path.abs…"), ("module", "helper.py"), ("statement", "total = 0"), ("decision", "for i in range(3)"), ("function", "double"),
        ("statement", "total += helper.double(i)"), ("statement", "y = x * 2"), ("statement", "return y"), ("decision", "for j in []"), ("statement", "k = 0"), ("decision", "while k < 2"), ("statement", "k += 1"),
        ("decision", "if total > 100 and k > 0"), ("decision", "elif total > 5"), ("statement", "mid = True"), ("decision", "match total"), ("statement", "z = 1"),
        ("function", "Counter.__init__"), ("statement", "c = Counter(10)"), ("statement", "self.value = start"), ("function", "Counter.bump"), ("statement", "c.bump(5)"), ("statement", "self.value += by"), ("statement", "return self.value"),
        ("package", "libq"), ("statement", "seen = libq.run(lambda n: n * 2)"), ("function", "<lambda>"), ("function", "greet"), ("statement", 'print(greet("bob"), total)'), ("statement", 'msg = "hello " + name'), ("statement", "return msg"),
        ("function", "fail"), ("statement", "helper.fail(total)"), ("decision", "if n > 100"), ("statement", 'raise ValueError("too small: %d" % n)'), ("statement", "handled = True"), ("statement", "result = helper.fail(total)"),
    ]
    assert [n["id"] for n in doc["nodes"]] == ["n%d" % i for i in range(38)]
    main = by_label(doc, "<module>")
    assert main["id"] == "n0" and main["calls"] == 1 and main["spans"] == [[0, doc["count"] - 1]] and main["line"] == 1 and main["function"] == "<module>"
    assert main["rows"] == []
    assert list(main.keys()) == ["id", "kind", "label", "file", "line", "fileId", "function", "calls", "firstStep", "spans", "rows"]
    helper = by_label(doc, "helper.py")
    assert helper["kind"] == "module" and helper["calls"] == 1 and helper["fileId"] == 2 and helper["file"].endswith("helper.py")
    double = by_label(doc, "double")
    assert double["calls"] == 3 and double["firstStep"] == 8 and double["spans"] == [[9, 11], [14, 16], [19, 21]] and double["line"] == 1
    assert double["rows"] == [{"kind": "in", "name": "x", "text": "0", "step": 9}, {"kind": "out", "name": "return", "text": "0", "step": 11}]
    fail = by_label(doc, "fail")
    # the error moments sit on the raise statement; the function's own row says how its first call left
    assert fail["calls"] == 2 and fail["rows"] == [{"kind": "in", "name": "n", "text": "6", "step": 56}, {"kind": "raised", "name": "ValueError", "text": "too small: 6", "step": 58}]
    lib = by_label(doc, "libq")
    assert lib["kind"] == "package" and lib["package"] == "libq" and lib["calls"] == 1 and lib["spans"] == [[42, 49]] and lib["nested"] == 2
    assert list(lib.keys()) == ["id", "kind", "label", "package", "calls", "firstStep", "spans", "rows", "nested"]
    lam = by_label(doc, "<lambda>")
    assert lam["calls"] == 1 and lam["firstStep"] == 48 and "package" not in lam
    # statements
    stmts = {n["label"]: n for n in doc["nodes"] if n["kind"] == "statement"}
    first = stmts["sys.path.insert(0, os.path.join(os.path.dirname(os.path.abs…"]
    assert first["line"] == 2 and first["reads"] == ["sys", "os", "__file__"] and first["text"].startswith("sys.path.insert(0, os.path.join(") and first["firstStep"] == 1 and first["hits"] == 1
    total = stmts["total += helper.double(i)"]
    assert (total["parent"], total["targets"], total["reads"], total["hits"], total["firstStep"], total["rows"]) == ("n0", ["total"], ["total", "helper", "i"], 3, 8, [{"kind": "out", "name": "total", "text": "0", "step": 11}])
    assert stmts["y = x * 2"]["parent"] == double["id"] and stmts["y = x * 2"]["hits"] == 3 and stmts["y = x * 2"]["fileId"] == 2 and stmts["y = x * 2"]["file"].endswith("helper.py")
    assert stmts["k += 1"]["rows"] == [{"kind": "out", "name": "k", "text": "1", "step": 26}]
    assert stmts["c.bump(5)"]["rows"] == [{"kind": "out", "name": "c.bump(5)", "text": "15", "step": 40}]
    assert stmts["self.value += by"]["targets"] == [] and stmts["self.value += by"]["reads"] == ["self", "by"]
    assert stmts['print(greet("bob"), total)']["rows"] == [{"kind": "print", "name": "stdout", "text": "hello bob 6", "step": 53}]
    raise_ = stmts['raise ValueError("too small: %d" % n)']
    assert raise_["parent"] == fail["id"] and raise_["hits"] == 2 and raise_["rows"] == [{"kind": "raised", "name": "ValueError", "text": "too small: 6", "step": 58}]
    assert "if (total > 100 and k > 0" not in stmts and "import os, sys" not in stmts and "def greet(name" not in stmts
    # decisions
    dec = {n["label"]: n for n in doc["nodes"] if n["kind"] == "decision"}
    assert all(d["parent"] == "n0" for l, d in dec.items() if l != "if n > 100") and dec["if n > 100"]["parent"] == fail["id"]
    assert (dec["for i in range(3)"]["hits"], dec["for j in []"]["hits"], dec["while k < 2"]["hits"]) == (3, 0, 2)
    assert all("taken" not in dec[l] and dec[l]["notRun"] == [] for l in ("for i in range(3)", "for j in []", "while k < 2"))
    assert dec["if total > 100 and k > 0"]["taken"] == "False" and dec["if total > 100 and k > 0"]["notRun"] == [32]
    assert dec["elif total > 5"]["taken"] == "True" and dec["elif total > 5"]["notRun"] == [36]
    assert dec["match total"]["taken"] == "case _" and dec["match total"]["notRun"] == [39] and dec["match total"]["text"] == "match total took case _"
    assert dec["if n > 100"]["hits"] == 2 and dec["if n > 100"]["taken"] == "False" and dec["if n > 100"]["notRun"] == [8] and dec["if n > 100"]["line"] == 7
    assert list(dec["if n > 100"].keys()) == ["id", "kind", "parent", "label", "file", "line", "fileId", "text", "taken", "firstStep", "hits", "notRun", "rows"]
    # edges
    assert labelled_edges(doc) == [
        ("<module>", "helper.py", "call", 1), ("total += helper.double(i)", "double", "call", 3), ("total = 0", "total += helper.double(i)", "data", "total"), ("for i in range(3)", "total += helper.double(i)", "data", "i"),
        ("double", "y = x * 2", "data", "x"), ("y = x * 2", "return y", "data", "y"), ("double", "double", "data", "x"), ("k = 0", "while k < 2", "data", "k"), ("k = 0", "k += 1", "data", "k"),
        ("total += helper.double(i)", "if total > 100 and k > 0", "data", "total"), ("k += 1", "if total > 100 and k > 0", "data", "k"), ("total += helper.double(i)", "elif total > 5", "data", "total"), ("total += helper.double(i)", "match total", "data", "total"),
        ("c = Counter(10)", "Counter.__init__", "call", 1), ("Counter.__init__", "self.value = start", "data", "start"), ("c.bump(5)", "Counter.bump", "call", 1), ("c = Counter(10)", "c.bump(5)", "data", "c"), ("Counter.bump", "self.value += by", "data", "by"),
        ("seen = libq.run(lambda n: n * 2)", "libq", "call", 1), ("libq", "<lambda>", "tool", 1), ('print(greet("bob"), total)', "greet", "call", 1), ("total += helper.double(i)", 'print(greet("bob"), total)', "data", "total"),
        ("greet", 'msg = "hello " + name', "data", "name"), ('msg = "hello " + name', "return msg", "data", "msg"), ("helper.fail(total)", "fail", "call", 1), ("total += helper.double(i)", "helper.fail(total)", "data", "total"),
        ("fail", "if n > 100", "data", "n"), ("fail", 'raise ValueError("too small: %d" % n)', "data", "n"), ("result = helper.fail(total)", "fail", "call", 1), ("total += helper.double(i)", "result = helper.fail(total)", "data", "total"),
    ]
    assert [e["id"] for e in doc["edges"]] == ["e%d" % i for i in range(30)]
    # call 3 of double takes x = 2, the text of call 2's `out return = 2`: a data edge onto itself (the rule only excludes the caller's node)
    assert edge(doc, "double", "double", "data") == {"id": "e6", "from": double["id"], "to": double["id"], "kind": "data", "label": "x", "firstStep": 19}
    d = edge(doc, "total += helper.double(i)", "double")
    assert d["steps"] == [8, 13, 18] and d["momentIds"] == ["m5", "m7", "m9"] and d["firstStep"] == 8 and d["from"] == total["id"]
    assert list(d.keys()) == ["id", "from", "to", "kind", "count", "firstStep", "steps", "momentIds"]
    # fail(n=6) takes the running total, not anything double returned (0, 2, 4): no data edge from double
    assert not any(e[:3] == ("double", "fail", "data") for e in labelled_edges(doc))
    tool = edge(doc, "libq", "<lambda>", "tool")
    assert tool["steps"] == [48] and tool["momentIds"] == ["m28"]
    assert edge(doc, "helper.fail(total)", "fail")["count"] == 1 and edge(doc, "result = helper.fail(total)", "fail")["count"] == 1
    # moments and scopes
    refs = {m["id"]: m for m in doc["moments"]}
    assert refs["m0"] == {"id": "m0", "kind": "start", "step": 0, "nodeId": "n0"} and refs["m40"]["nodeId"] == "n0"
    assert refs["m5"] == {"id": "m5", "kind": "call", "step": 8, "nodeId": double["id"], "edgeId": d["id"]}
    assert refs["m28"]["edgeId"] == tool["id"] and refs["m34"]["nodeId"] == dec["if n > 100"]["id"] and refs["m35"]["nodeId"] == raise_["id"] and refs["m39"]["nodeId"] == raise_["id"]
    assert refs["m22"]["nodeId"] == stmts["self.value = start"]["id"] and refs["m32"]["nodeId"] == stmts['print(greet("bob"), total)']["id"]  # a value and a print land on their statements
    assert refs["m6"]["nodeId"] == total["id"]  # `total += …` logs its value after double's `out return`, on its own statement
    assert len(doc["moments"]) == 41
    run = SavedRun(str(fixture_run))
    assert set(doc["scopes"]) == {str(s["scopeId"]) for s in run.trace.scopes}
    assert doc["scopes"]["0"] == "n0" and doc["scopes"]["1"] == helper["id"] and doc["scopes"]["7"] == lib["id"] and doc["scopes"]["8"] == lib["id"] and doc["scopes"]["9"] == lam["id"]
    assert list(doc["scopes"]) == [str(i) for i in range(13)]
    assert doc["capped"] is False and doc["truncated"] is False
    assert list(doc.keys()) == ["count", "nodes", "edges", "moments", "scopes", "capped", "truncated"]


def test_statements_off_on_the_walkthrough_fixture(fixture_run: Path):
    doc = graph(SavedRun(str(fixture_run)), statements=False)
    assert not any(n["kind"] == "statement" for n in doc["nodes"]) and len(doc["nodes"]) == 16
    assert labelled_edges(doc) == [
        ("<module>", "helper.py", "call", 1), ("<module>", "double", "call", 3), ("double", "double", "data", "x"), ("<module>", "Counter.__init__", "call", 1), ("<module>", "Counter.bump", "call", 1),
        ("<module>", "libq", "call", 1), ("libq", "<lambda>", "tool", 1), ("<module>", "greet", "call", 1), ("<module>", "fail", "call", 2),
    ]
    assert by_label(doc, "fail")["rows"] == [{"kind": "in", "name": "n", "text": "6", "step": 56}, {"kind": "raised", "name": "ValueError", "text": "too small: 6", "step": 58}]
    assert len(doc["moments"]) == 41 and next(m for m in doc["moments"] if m["id"] == "m22")["nodeId"] == by_label(doc, "Counter.__init__")["id"]


def test_all_and_expand_unroll_the_library(fixture_run: Path):
    run = SavedRun(str(fixture_run))
    every = graph(run, all_scopes=True)
    labels = [n["label"] for n in every["nodes"]]
    assert "libq" not in labels and "run" in labels and "helper" in labels and not any(n["kind"] == "package" for n in every["nodes"])
    run_node = by_label(every, "run")
    assert run_node["package"] == "libq" and run_node["file"].endswith("libq/__init__.py") and "nested" not in run_node
    assert list(run_node.keys()) == ["id", "kind", "label", "file", "line", "fileId", "function", "package", "calls", "firstStep", "spans", "rows"]
    assert edge(every, "run", "helper")["count"] == 1 and edge(every, "run", "<lambda>", "tool")["count"] == 1 and edge(every, "seen = libq.run(lambda n: n * 2)", "run")["count"] == 1
    assert not any(n["kind"] == "statement" and n["parent"] == run_node["id"] for n in every["nodes"])  # library functions get no statements
    assert every["scopes"]["8"] == by_label(every, "helper")["id"]
    expanded = graph(run, expand=["libq"])
    assert [n["label"] for n in expanded["nodes"]] == labels
    assert expanded == every
    other = graph(run, expand=["nothing"])  # `all` moments, the package folded back
    assert [n["label"] for n in other["nodes"]] == [n["label"] for n in graph(run)["nodes"]]
    assert by_label(other, "libq")["calls"] == 1 and edge(other, "libq", "<lambda>", "tool")["count"] == 1
    assert [m["id"] for m in other["moments"]] != [m["id"] for m in graph(run)["moments"]]  # ids of the `all` walkthrough


def test_scope_window(fixture_run: Path):
    doc = graph(SavedRun(str(fixture_run)), scope="fail")
    assert [(n["kind"], n["label"]) for n in doc["nodes"]] == [("module", "<module>"), ("function", "fail"), ("decision", "if n > 100"), ("statement", 'raise ValueError("too small: %d" % n)')]
    assert by_label(doc, "<module>")["spans"] == [[0, doc["count"] - 1]] and by_label(doc, "fail")["calls"] == 2
    assert labelled_edges(doc) == [("<module>", "fail", "call", 2), ("fail", "if n > 100", "data", "n"), ("fail", 'raise ValueError("too small: %d" % n)', "data", "n")]  # the call sites are outside the window: no statement there
    assert [m["kind"] for m in doc["moments"]] == ["call", "decision", "error", "call", "decision", "error", "end"]  # the end lands on the last step of the second call
    assert [m["nodeId"] for m in doc["moments"] if m["kind"] == "error"] == ["n3", "n3"]
    assert doc["scopes"] == {"0": "n0", "11": "n1", "12": "n1"}


def test_cap_keeps_the_most_called_and_folds_the_rest(fixture_run: Path):
    doc = graph(SavedRun(str(fixture_run)), cap=6)
    assert doc["capped"] is True
    kept = [n["label"] for n in doc["nodes"] if n["kind"] not in ("decision", "statement")]
    assert kept == ["<module>", "helper.py", "double", "Counter.__init__", "3 more functions", "libq", "fail"]
    more = by_label(doc, "3 more functions")
    assert more["kind"] == "package" and more["more"] == 3 and more["calls"] == 3 and more["firstStep"] == 37 and more["spans"] == [] and more["file"].endswith("main.py") and more["fileId"] == 1
    assert list(more.keys()) == ["id", "kind", "label", "file", "fileId", "calls", "firstStep", "spans", "rows", "more"]
    assert [e for e in labelled_edges(doc) if e[2] != "data"] == [("<module>", "helper.py", "call", 1), ("total += helper.double(i)", "double", "call", 3), ("c = Counter(10)", "Counter.__init__", "call", 1), ("seen = libq.run(lambda n: n * 2)", "libq", "call", 1), ("helper.fail(total)", "fail", "call", 1), ("result = helper.fail(total)", "fail", "call", 1)]
    stmts = [n["label"] for n in doc["nodes"] if n["kind"] == "statement"]
    assert "self.value += by" not in stmts and 'msg = "hello " + name' not in stmts and "c.bump(5)" in stmts  # statements of dropped functions go with them
    assert not any(m["id"] in ("m24", "m25", "m28", "m30", "m31") for m in doc["moments"])  # bump, its value, the callback, greet, its value
    assert doc["scopes"]["6"] == more["id"] and doc["scopes"]["9"] == more["id"] and doc["scopes"]["10"] == more["id"] and doc["scopes"]["5"] == by_label(doc, "Counter.__init__")["id"]
    assert len(doc["nodes"]) == 32
    assert graph(SavedRun(str(fixture_run)), cap=9)["capped"] is False


def test_text_form(fixture_run: Path):
    code, text = pyokka("graph", str(fixture_run))
    assert code == 0
    lines = text.splitlines()
    assert lines[0] == "38 nodes, 30 edges over 64 steps"
    assert lines[1] == "n0 <module> main.py:1  ×1"
    assert lines[2] == "   n1 sys.path.insert(0, os.path.join(os.path.dirname(os.path.abs…  ×1  out sys.path.insert(0, os.p…"
    assert lines[3] == "   n3 total = 0  ×1  out total = 0" and lines[4] == "   n4 for i in range(3) ran 3 times  ×3" and lines[5] == "   n6 total += helper.double(i)  ×3  out total = 0"  # statements and decisions interleaved by step
    assert lines[10] == "   n13 if total > 100 and k > 0 took False  ×1  not run: 32" and lines[13] == "   n16 match total took case _  ×1  not run: 39"
    assert "   n29 print(greet(\"bob\"), total)  ×1  print stdout = hello bob 6" in lines
    assert lines[22] == "n2 helper.py helper.py:1  ×1"
    assert "n5 double helper.py:1  ×3  in x = 0 · out 0" in lines and lines[lines.index("n5 double helper.py:1  ×3  in x = 0 · out 0") + 1] == "   n7 y = x * 2  ×3"
    assert any(l.startswith("n25 libq  ×1  2 nested  in cb = <function <lambda> at 0x") and l.endswith("> · out 8") for l in lines)
    assert "n32 fail helper.py:6  ×2  in n = 6 · raised ValueError: too small: 6" in lines
    assert lines.index("   n34 if n > 100 took False  ×2  not run: 8") == lines.index("n32 fail helper.py:6  ×2  in n = 6 · raised ValueError: too small: 6") + 1
    assert lines.index('   n35 raise ValueError("too small: %d" % n)  ×2  raised ValueError: too small: 6') == lines.index("n32 fail helper.py:6  ×2  in n = 6 · raised ValueError: too small: 6") + 2
    assert "n6 → n5  ×3  #8 #13 #18" in lines and "n25 → n27  tool ×1  #48" in lines and "n5 ⇢ n5  x" in lines and "n3 ⇢ n6  total" in lines and lines[-1] == "n6 ⇢ n37  total"
    assert len(lines) == 1 + 38 + 30 and all(len(l) <= 100 for l in lines)
    code, text = pyokka("graph", str(fixture_run), "--scope", "fail")
    assert code == 0 and text.splitlines()[0] == "4 nodes, 3 edges over 64 steps"
    code, text = pyokka("graph", str(fixture_run), "--no-statements")
    assert code == 0 and text.splitlines()[0] == "16 nodes, 9 edges over 64 steps" and text.splitlines()[1:3] == ["n0 <module> main.py:1  ×1", "   n2 for i in range(3) ran 3 times  ×3"]


def test_dot_form(fixture_run: Path):
    doc = graph(SavedRun(str(fixture_run)))
    dot = render_dot(doc)
    assert dot.startswith("digraph run {") and dot.endswith("}")
    assert '  n13 [shape=diamond, label="if total > 100 and k > 0 took False\\nnot run: 32"];' in dot
    assert '  n5 [shape=record, label="{double ×3\\nhelper.py:1|in x = 0\\lout 0\\l}"];' in dot
    assert '  n25 [shape=folder, label="libq ×1\\n2 nested"];' in dot
    assert '  n0 [shape=record, label="{\\<module\\> ×1\\nmain.py:1}"];' in dot
    assert '  n3 [shape=box, fontname="Courier", label="total = 0\\nout total = 0"];' in dot and '  n6 [shape=box, fontname="Courier", label="total += helper.double(i)\\nout total = 0"];' in dot
    assert '  n35 [shape=box, fontname="Courier", label="raise ValueError(\\"too small: %d\\" % n)\\nraised ValueError: too small: 6"];' in dot
    assert "  n0 -> n3 [style=dotted, arrowhead=none];" in dot and "  n0 -> n13 [style=dotted, arrowhead=none];" in dot and "  n32 -> n35 [style=dotted, arrowhead=none];" in dot
    assert '  n5 -> n32 [style=dashed' not in dot and '  n25 -> n27 [label="tool ×1"];' in dot and '  n6 -> n5 [label="×3"];' in dot
    code, text = pyokka("graph", str(fixture_run), "--dot")
    assert code == 0 and text == dot + "\n"


def test_json_command_path(fixture_run: Path):
    doc = pyokka_json("graph", str(fixture_run))
    assert doc == json.loads(json.dumps(graph(SavedRun(str(fixture_run)))))
    every = pyokka_json("graph", str(fixture_run), "--all")
    assert "run" in [n["label"] for n in every["nodes"]]
    expanded = pyokka_json("graph", str(fixture_run), "--expand", "libq", "--expand", "other")
    assert expanded == every
    code, text = pyokka("graph", str(fixture_run), "--json", "--scope", "fail")
    assert code == 0 and len(json.loads(text)["nodes"]) == 4
    plain = pyokka_json("graph", str(fixture_run), "--no-statements")
    assert plain == json.loads(json.dumps(graph(SavedRun(str(fixture_run)), statements=False))) and len(plain["nodes"]) == 16


class GraphBridge(FakeBridge):
    def reply(self, req: dict) -> dict:
        if req.get("type") == "graph":
            nodes = [
                {"id": "n0", "kind": "module", "label": "<module>", "file": "/ws/proj/demo.py", "line": 1, "fileId": 1, "function": "<module>", "calls": 1, "firstStep": 0, "spans": [[0, 39]], "rows": [{"kind": "raised", "name": "ValueError", "text": "Kaboom", "step": 39}]},
                {"id": "n1", "kind": "function", "label": "Point.__init__", "file": "/ws/proj/demo.py", "line": 41, "fileId": 1, "function": "Point.__init__", "calls": 4, "firstStep": 9, "spans": [[10, 12]], "rows": [{"kind": "in", "name": "x", "text": "5", "step": 10}]},
                {"id": "n2", "kind": "statement", "parent": "n0", "label": "print(pyokka)", "file": "/ws/proj/demo.py", "line": 11, "fileId": 1, "text": "print(pyokka)", "targets": [], "reads": ["print", "pyokka"], "firstStep": 2, "hits": 1, "rows": [{"kind": "print", "name": "stdout", "text": "{'is_awesome': True}", "step": 2}]},
            ]
            return {"ok": True, "count": 40, "nodes": nodes, "edges": [{"id": "e0", "from": "n0", "to": "n1", "kind": "call", "count": 4, "firstStep": 9, "steps": [9], "momentIds": ["m3"]}], "moments": [], "scopes": {"0": "n0"}, "capped": False, "truncated": False}
        return super().reply(req)


def test_live_command_path(tmp_path: Path, monkeypatch):
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv(SESSIONS_ENV, str(sessions))
    monkeypatch.chdir(tmp_path)
    bridge = GraphBridge()
    write_descriptor(sessions, "1", bridge.descriptor())
    try:
        doc = pyokka_json("graph", "--live", "--all", "--expand", "openai", "--expand", "pydantic")
        assert bridge.requests[-1] == {"id": 1, "type": "graph", "all": True, "expand": ["openai", "pydantic"]}
        assert doc["count"] == 40 and doc["nodes"][1]["label"] == "Point.__init__" and "ok" not in doc and "id" not in doc
        code, text = pyokka("graph", "--live", "--scope", "Point.__init__")
        assert bridge.requests[-1] == {"id": 1, "type": "graph", "scope": "Point.__init__"}
        assert code == 0 and text == "3 nodes, 1 edge over 40 steps\nn0 <module> demo.py:1  ×1  raised ValueError: Kaboom\n   n2 print(pyokka)  ×1  print stdout = {'is_awesome': True}\nn1 Point.__init__ demo.py:41  ×4  in x = 5\nn0 → n1  ×4  #9\n"
        code, text = pyokka("graph", "--live", "--no-statements")
        assert bridge.requests[-1] == {"id": 1, "type": "graph", "statements": False} and code == 0
        code, text = pyokka("graph", "--live", "--dot")
        assert code == 0 and text.startswith("digraph run {") and 'n0 -> n1 [label="×4"]' in text and '  n2 [shape=box, fontname="Courier", label="print(pyokka)\\nprint stdout = {\'is_awesome\': True}"];' in text
    finally:
        bridge.close()


# -- examples/demo.py -------------------------------------------------------------------------------------------

@pytest.fixture
def demo_run(tmp_path: Path) -> Path:
    out = tmp_path / "demo-run.json"
    code, text = pyokka("run", str(DEMO), "--save", str(out))
    assert code == 1 and "exit 1" in text  # the demo raises on purpose
    return out


def test_demo_graph(demo_run: Path):
    doc = graph(SavedRun(str(demo_run)))
    calls = {n["label"]: n["calls"] for n in doc["nodes"] if n["kind"] not in ("decision", "statement")}
    assert calls == {"<module>": 1, "Point.__init__": 4, "generate_random_point": 1, "Rectangle.__init__": 2, "rectangles_overlap": 1, "Rectangle.contains": 1, "Point.distance": 1}
    dec = {n["label"]: n for n in doc["nodes"] if n["kind"] == "decision"}
    assert list(dec) == ["if False", "for n in range(1, 4)"]
    branch = dec["if False"]
    assert branch["taken"] == "False" and branch["notRun"] == [32] and branch["parent"] == "n0" and branch["line"] == 31
    loop = dec["for n in range(1, 4)"]
    assert loop["text"] == "for n in range(1, 4) ran 3 times" and loop["hits"] == 3 and loop["notRun"] == [] and loop["parent"] == "n0" and loop["line"] == 98
    main = by_label(doc, "<module>")
    stmts = {n["label"]: n for n in doc["nodes"] if n["kind"] == "statement" and n["parent"] == main["id"]}
    assert list(stmts) == ['pyokka = {"is_awesome": True, "python": sys.version.split()…', "print(pyokka)", "pyokka", "working_dir = os.getcwd()", "os.cpu_count()", "sum(i * i for i in range(10_000))", 'print("partial", False and True)', "point_a = Point(5, 10)", "point_b = generate_random_point(100, 100)", "rect1 = Rectangle(50, 20, Point(10, 10))", "rect2 = Rectangle(30, 30, Point(40, 15))", 'print({"msg": f"Do rectangles overlap? {rectangles_overlap(…', 'print({"msg": f"Is point_a inside rect1? {rect1.contains(po…', 'print({"msg": f"Distance between A and B: {point_a.distance…', "total = 0", "total += n", 'raise ValueError("Kaboom! This is just a test error.")']
    assert stmts['pyokka = {"is_awesome": True, "python": sys.version.split()…']["reads"] == ["sys"] and stmts["sum(i * i for i in range(10_000))"]["reads"] == ["sum", "i", "range"]
    assert stmts["total += n"]["hits"] == 3 and stmts["total += n"]["reads"] == ["total", "n"] and stmts["total += n"]["targets"] == ["total"]
    assert [(r["kind"], r["name"]) for r in stmts["print(pyokka)"]["rows"]] == [("print", "stdout")] and stmts["pyokka"]["rows"][0]["kind"] == "out"
    raise_ = stmts['raise ValueError("Kaboom! This is just a test error.")']
    assert raise_["rows"] == [{"kind": "raised", "name": "ValueError", "text": "Kaboom! This is just a test error.", "step": doc["count"] - 1}] and main["rows"] == []
    assert edge(doc, "point_a = Point(5, 10)", "Point.__init__")["count"] == 1 and edge(doc, "return Point(x, y)", "Point.__init__")["count"] == 1
    for r in ("rect1 = Rectangle(50, 20, Point(10, 10))", "rect2 = Rectangle(30, 30, Point(40, 15))"):
        assert edge(doc, r, "Point.__init__")["count"] == 1 and edge(doc, r, "Rectangle.__init__")["count"] == 1
    assert not any(e[0] == "<module>" for e in labelled_edges(doc) if e[2] == "call")
    assert edge(doc, "point_a = Point(5, 10)", 'print({"msg": f"Is point_a inside rect1? {rect1.contains(po…', "data", "point_a")["label"] == "point_a"
    assert edge(doc, "point_b = generate_random_point(100, 100)", 'print({"msg": f"Distance between A and B: {point_a.distance…', "data", "point_b")
    assert by_label(doc, "self.x = x")["hits"] == 4 and by_label(doc, "self.x = x")["parent"] == by_label(doc, "Point.__init__")["id"]
    point = by_label(doc, "Point.__init__")
    assert [(r["kind"], r["name"], r["text"]) for r in point["rows"]] == [("in", "x", "5"), ("in", "y", "10")]
    assert doc["capped"] is False
    code, text = pyokka("graph", str(demo_run))
    lines = text.splitlines()
    assert code == 0 and "n9 Point.__init__ demo.py:41  ×4  in x = 5 · in y = 10" in lines and "   n8 if False took False  ×1  not run: 32" in lines and "   n10 point_a = Point(5, 10)  ×1" in lines
    assert all(len(l) <= 100 for l in lines)
    # without statements: yesterday's graph
    plain = graph(SavedRun(str(demo_run)), statements=False)
    assert edge(plain, "<module>", "Point.__init__")["count"] == 3 and edge(plain, "generate_random_point", "Point.__init__")["count"] == 1 and edge(plain, "<module>", "Rectangle.__init__")["count"] == 2
    assert by_label(plain, "<module>")["rows"] == [{"kind": "raised", "name": "ValueError", "text": "Kaboom! This is just a test error.", "step": doc["count"] - 1}]
    # the one data edge: generate_random_point's return value is the `other` Point.distance takes
    assert [e for e in labelled_edges(plain) if e[2] == "data"] == [("generate_random_point", "Point.distance", "data", "other")] and len(plain["nodes"]) == 9
    code, text = pyokka("graph", str(demo_run), "--no-statements")
    assert code == 0 and "n2 Point.__init__ demo.py:41  ×4  in x = 5 · in y = 10" in text.splitlines() and "   n1 if False took False  ×1  not run: 32" in text


def test_demo_graph_with_auto_log_has_the_assignment_rows(tmp_path: Path):
    out = tmp_path / "demo-run.json"
    code, text = pyokka("run", str(DEMO), "--save", str(out), "--auto-log")
    assert code == 1
    doc = graph(SavedRun(str(out)))
    first = by_label(doc, 'pyokka = {"is_awesome": True, "python": sys.version.split()…')
    assert [(r["kind"], r["name"]) for r in first["rows"]] == [("out", "pyokka")] and first["rows"][0]["text"].startswith("{'is_awesome': True")
    assert [(r["kind"], r["name"]) for r in by_label(doc, "x = random.randrange(max_x)")["rows"]] == [("out", "x")]


def test_library_package_names_files_outside_site_packages():
    from pyokka_runtime.agent.walkthrough import library_package

    assert library_package("/v/site-packages/openai/_client.py") == "openai"
    assert library_package("/x/pylib/libdemo/__init__.py") == "libdemo"
    assert library_package("/x/pylib/libdemo/util.py") == "util"
    assert library_package(None) is None
