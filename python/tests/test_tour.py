"""`pyokka tour`: chapters, candidates, value shaping and the budget, gated on the ablation corpus.

The fixtures are the ablation's recordings (2026-10-01, runtime 0.1.6), xz-compressed: the RRF
demo, logscan (a 300-line loop with two bad lines, a subprocess, a CSV write), a LangGraph agent
with a fake model and with gpt-6-luna over recorded HTTP, and PageIndex indexing attention.pdf
and answering one question (23,567 steps). `refs.json` holds the reference stops the ablation
scored against (`docs/TOUR.md`, "Recall").
"""

from __future__ import annotations

import json
import lzma
import time
from pathlib import Path

import pytest

from pyokka_runtime.agent.source import AgentError, SavedRun
from pyokka_runtime.agent.tour.build import build_tour, stable_key
from pyokka_runtime.agent.tour.model import TourRun
from pyokka_runtime.agent.tour.text import render_tour
from pyokka_runtime.agent.tour.values import NOISE, evidence, shape, tokens

FIXTURES = Path(__file__).parent / "fixtures" / "tour"
REFS = json.loads((FIXTURES / "refs.json").read_text(encoding="utf-8"))
_RUNS: dict[str, SavedRun] = {}
_TOURS: dict[str, dict] = {}

# Recall at the default budget, against the ablation's "all four" union (REPORT.md). The three
# PageIndex stops below "all four" are docs/TOUR.md's "Recall" section: each was reached there
# only by a signal the ablation itself dropped as noise.
GATES = {
    ("rrf", "rrf"): (7, 2),
    ("logscan", "logscan"): (10, 10),
    ("lg_fake", "lg_fake"): (12, 12),
    ("lg_llm", "lg_llm"): (10, 10),
    ("pageindex", "pi_all"): (13, 14),
    ("pageindex", "pi_ch6_cards"): (6, 8),
    ("pageindex", "pi_ch6"): (10, 11),
}
PAGEINDEX_PHASES = [(0, 1867), (1868, 8674), (8675, 13747), (13748, 20599), (20600, 21626), (21627, 23566)]


def saved(name: str, tmp_root: Path | None = None) -> SavedRun:
    if name not in _RUNS:
        doc = json.loads(lzma.decompress((FIXTURES / ("%s.json.xz" % name)).read_bytes()))
        _RUNS[name] = SavedRun(str(FIXTURES / ("%s.json" % name)), doc=doc)
    return _RUNS[name]


def tour(name: str) -> dict:
    if name not in _TOURS:
        _TOURS[name] = build_tour(saved(name))
    return _TOURS[name]


def hits(run: SavedRun, cands: list[dict], ref: str) -> tuple[int, list[int]]:
    """The ablation's hit rule: within 3 steps, or the same line in the same scope when that line ran once there."""
    t = TourRun(run)
    count: dict[tuple, int] = {}
    for i in range(t.n):
        key = (t.fid[i], t.line[i], t.scope[i])
        count[key] = count.get(key, 0) + 1
    got, missed = 0, []
    for st, _ in REFS[ref]["stops"]:
        key = (t.fid[st], t.line[st], t.scope[st])
        if any(abs(c["step"] - st) <= 3 or ((t.fid[c["step"]], t.line[c["step"]], t.scope[c["step"]]) == key and count[key] == 1) for c in cands):
            got += 1
        else:
            missed.append(st)
    return got, missed


@pytest.mark.parametrize("name,ref", list(GATES))
def test_recall_meets_the_gate(name: str, ref: str):
    doc = tour(name)
    got, missed = hits(saved(name), doc["candidates"], ref)
    gate, all_four = GATES[(name, ref)]
    assert got >= gate, "%s vs %s: %d of %d (gate %d, ablation all-four %d), missed %s" % (name, ref, got, len(REFS[ref]["stops"]), gate, all_four, missed)


def test_pageindex_chapters_are_the_six_phases():
    doc = tour("pageindex")
    n = doc["run"]["steps"]
    got = [tuple(c["steps"]) for c in doc["chapters"]]
    assert len(got) == len(PAGEINDEX_PHASES)
    for (a, b), (ra, rb) in zip(got, PAGEINDEX_PHASES):
        assert abs(a - ra) <= 0.01 * n and abs(b - rb) <= 0.01 * n, (got, PAGEINDEX_PHASES)
    assert [c["title"] for c in doc["chapters"]][1:5] == ["complexity", "merge", "expand", "generate_doc_description"]
    assert [c["llm"] for c in doc["chapters"]] == [0, 0, 0, 14, 1, 4]
    assert doc["run"]["http"] == 19 and doc["run"]["llm"] == 19


def test_pageindex_runtime_and_size():
    run = saved("pageindex")
    started = time.perf_counter()
    doc = build_tour(run)
    secs = time.perf_counter() - started
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    assert secs < 15, secs
    assert len(text) / 4 <= doc["budget"]["tokens"]
    assert doc["budget"]["found"] > doc["budget"]["kept"] > 100


def test_concurrent_requests_get_the_step_of_their_own_statement():
    t = TourRun(saved("pageindex"))
    steps = [int(r["step"]) for r in t.http]
    assert len(set(steps)) == 19  # the 0.1.6 recording gave 13 of them the gather's step, #15050
    for r in t.http:
        assert t.trace.rid(int(r["step"])) == r["rid"]


def test_a_tight_budget_keeps_the_best_of_every_chapter():
    doc = build_tour(saved("pageindex"), budget=8000)
    assert doc["budget"]["estimate"] <= 8000 * 1.25  # each chapter keeps its best three whatever they weigh
    per = {c["id"]: c["candidates"] for c in doc["chapters"]}
    assert all(n >= 3 for n in per.values()), per


def test_small_run_is_its_walkthrough_in_one_chapter():
    doc = tour("lg_fake")
    assert doc["small"] is True
    assert [c["id"] for c in doc["chapters"]] == ["c1"] and doc["chapters"][0]["kind"] == "walkthrough"
    kinds = {s["signal"].split(":")[0] for c in doc["candidates"] for s in c["signals"]}
    assert "walkthrough" in kinds and "crossing" in kinds
    assert tour("rrf")["small"] is False  # 110 moments


def test_candidate_shape_and_stable_ids():
    doc = tour("rrf")
    c = next(c for c in doc["candidates"] if c["step"] == 104)
    assert c["id"] == "s104-%s" % c["key"] and len(c["key"]) == 6
    assert c["file"] == "rrf.py" and c["line"] == 124 and c["function"] == "main"
    assert c["statement"].startswith("fused_ranking = sorted(")
    assert {"chapter:start", "spine:why"} <= {s["signal"] for s in c["signals"]}
    assert c["values"][0]["name"] == "fused_ranking" and c["values"][0]["text"].startswith("[('C', 0.0325")
    t = TourRun(saved("rrf"))
    passes = [i for i in range(t.n) if t.line[i] == 73 and t.function(i) == "rrf"]
    assert len(passes) > 1 and len({stable_key(t, i) for i in passes}) == 1  # the key names the statement, not the pass


def test_values_leave_out_self_methods_and_literals():
    for name in ("rrf", "lg_llm", "pageindex"):
        for c in tour(name)["candidates"]:
            for v in c["values"]:
                assert v["name"] not in ("self", "cls")
                assert not NOISE.search(v.get("text", "")), v
    banners = [c for c in tour("rrf")["candidates"] if c["statement"] == 'print("RECIPROCAL RANK FUSION")']
    assert banners == []  # its output is the statement's own literal


def test_shape_repeats_near_repeats_and_evidence():
    long_a = "intro. " + "The model uses 8 attention heads with d_k = 64 per head. " + "x" * 600
    grown = "[" + ", ".join("'turn %d: %s'" % (i, "a" * 40) for i in range(8)) + "]"
    grown2 = grown[:-1] + ", 'turn 8: the new tool result'" + "]"
    cands = [
        {"id": "s1-aaaaaa", "step": 1, "_values": [{"role": "set", "name": "page", "text": long_a}, {"role": "set", "name": "messages", "text": grown}]},
        {"id": "s5-bbbbbb", "step": 5, "_values": [{"role": "set", "name": "copy", "text": long_a}, {"role": "set", "name": "messages", "text": grown2}]},
    ]
    shape(cands, tokens("The base Transformer uses 8 attention heads, with d_k = 64 per head."))
    first, second = cands[0]["values"], cands[1]["values"]
    assert first[0]["cut"] and len(first[0]["text"]) == 300 and first[0]["length"] == len(long_a)
    assert second[0] == {"id": "s5-bbbbbb.v1", "role": "set", "name": "copy", "length": len(long_a), "sameAs": "s1-aaaaaa.v1"}
    near = second[1]
    assert near["like"] == "s1-aaaaaa.v2" and grown2[near["from"]:near["to"]] == near["text"] and "turn 8" in near["text"]
    text = "x" * 500 + ". The model uses 8 attention heads with d_k = 64 per head. More text follows here."
    ev = evidence(text, tokens("8 heads, d_k = 64"), start_at=250)
    assert ev and text[ev[0]["from"]:ev[0]["to"]] == ev[0]["text"] and "8 attention heads" in ev[0]["text"]


def test_goal_by_name_and_by_line():
    run = saved("rrf")
    doc = build_tour(run, goal="fused_ranking")
    assert doc["goal"]["kind"] == "name" and doc["goal"]["step"] == 104
    got, _ = hits(run, doc["candidates"], "rrf")
    assert got >= 6
    doc = build_tour(run, goal="rrf.py:141")
    assert doc["goal"]["kind"] == "line" and doc["goal"]["text"].startswith("5. D")
    with pytest.raises(AgentError):
        build_tour(run, goal="no_such_name")
    with pytest.raises(AgentError):
        build_tour(run, goal="rrf.py:1")


def test_io_says_where_it_comes_from():
    doc = tour("logscan")
    io = {s["signal"] for c in doc["candidates"] for s in c["signals"] if s["signal"].startswith("io:")}
    assert {"io:file-write", "io:subprocess"} <= io
    assert "source" in doc["run"]["io"]["fileWrites"]
    llm = tour("lg_llm")
    assert llm["run"]["llm"] == 2 and llm["chapters"][0]["llm"] == 2


def test_text_form_lists_chapters_then_one_line_per_candidate():
    text = render_tour(tour("logscan"))
    lines = text.splitlines()
    assert lines[0].startswith("tour  ") and "4,886 steps" in lines[0] and "exit 0" in lines[0]
    assert lines[1].startswith("goal: the program's output at #4885")
    assert "chapters" in lines and any(l.strip().startswith("c2   #1519-4229") and "parse x300" in l for l in lines)
    rows = [l for l in lines if l.startswith("  s")]
    assert rows and all(" #" in r and ".py:" in r for r in rows)


def test_cli_tour_text_and_json(tmp_path: Path):
    import io
    from contextlib import redirect_stdout

    from pyokka_runtime.__main__ import main

    path = tmp_path / "rrf.json"
    path.write_bytes(lzma.decompress((FIXTURES / "rrf.json.xz").read_bytes()))
    buf = io.StringIO()
    with redirect_stdout(buf):
        assert main(["tour", str(path), "--json", "--budget", "20000"]) == 0
    doc = json.loads(buf.getvalue())
    assert doc["tour"] == 1 and doc["budget"]["tokens"] == 20000 and doc["candidates"]
    buf = io.StringIO()
    with redirect_stdout(buf):
        assert main(["tour", str(path), "--budget", "10"]) == 2


def test_live_tour_reads_the_session_recording(tmp_path: Path, monkeypatch):
    from test_agent_live import FakeBridge, pyokka, write_descriptor

    from pyokka_runtime.agent.live import SESSIONS_ENV

    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv(SESSIONS_ENV, str(sessions))
    monkeypatch.chdir(tmp_path)
    doc = json.loads(lzma.decompress((FIXTURES / "lg_llm.json.xz").read_bytes()))
    bridge = FakeBridge()
    try:
        bridge.canned["recording"] = doc
        write_descriptor(sessions, "1", bridge.descriptor())
        code, out = pyokka("tour", "--live", "--json")
        assert code == 0
        live = json.loads(out)
        assert bridge.requests[-1] == {"id": 1, "type": "recording"}
        offline = build_tour(SavedRun("x.json", doc=doc))
        assert [c["id"] for c in live["candidates"]] == [c["id"] for c in offline["candidates"]]
    finally:
        bridge.close()
