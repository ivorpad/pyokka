"""`pyokka tour --prose`: the prose validator and the merge (docs/TOUR.md, "tour.prose.json").

Most cases run on a hand-made tour, so each rejection kind is one assertion; the end-to-end case
runs the CLI on the RRF fixture with python/tests/fixtures/tour/rrf.prose.json.
"""

from __future__ import annotations

import io
import json
import lzma
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.agent.tour.prose import ProseRejected, apply_prose, check_prose, norm_number

FIXTURES = Path(__file__).parent / "fixtures" / "tour"
PROMPT_TEXT = "You are a careful assistant. " * 40 + "The base model uses 8 heads with d_k = 64 per head. " + "Filler text. " * 20
REPLY = "{'answer': 'The base Transformer uses 8 attention heads', 'tokens': 1234567, 'cost': 0.50}"


def tour() -> dict:
    return {
        "tour": 1,
        "run": {"file": "ask.py", "steps": 12345, "exitCode": 0, "http": 2, "llm": 1},
        "goal": {"kind": "output", "step": 300, "text": "8 heads"},
        "small": False,
        "chapters": [
            {"id": "c1", "title": "load_rows", "opens": ["load_rows"], "kind": "call", "steps": [0, 99], "share": 0.01, "http": 0, "llm": 0, "candidates": 1},
            {"id": "c2", "title": "ask_model", "opens": ["ask_model"], "kind": "call", "steps": [100, 12344], "share": 0.99, "http": 2, "llm": 1, "candidates": 2},
        ],
        "candidates": [
            {"id": "s5-aaaaaa", "key": "aaaaaa", "step": 5, "chapter": "c1", "file": "ask.py", "line": 3, "function": "load_rows",
             "statement": "rows = read_rows(path, limit=500)", "values": [{"id": "s5-aaaaaa.v1", "role": "set", "name": "rows", "length": 12, "text": "['a', 'b', 'c']"}]},
            {"id": "s200-bbbbbb", "key": "bbbbbb", "step": 200, "chapter": "c2", "file": "ask.py", "line": 9, "function": "ask_model",
             "statement": "reply = client.chat(prompt)",
             "values": [
                 {"id": "s200-bbbbbb.v1", "role": "in", "name": "prompt", "length": len(PROMPT_TEXT), "text": PROMPT_TEXT[:300], "cut": True},
                 {"id": "s200-bbbbbb.v2", "role": "set", "name": "reply", "length": len(REPLY), "text": REPLY},
             ]},
            {"id": "s300-cccccc", "key": "cccccc", "step": 300, "chapter": "c2", "file": "ask.py", "line": 12, "function": "main",
             "statement": "print(answer)", "values": [{"id": "s300-cccccc.v1", "role": "set", "name": "copy", "length": len(REPLY), "sameAs": "s200-bbbbbb.v2"},
                                                 {"id": "s300-cccccc.v2", "role": "set", "name": "cut_reply", "length": 30, "text": "'The base Trans…(+4,000 chars)"}]},
        ],
    }


FULL = {"s5-aaaaaa.v1": "['a', 'b', 'c']", "s200-bbbbbb.v1": PROMPT_TEXT, "s200-bbbbbb.v2": REPLY,
        "s300-cccccc.v1": REPLY, "s300-cccccc.v2": "'The base Trans…(+4,000 chars)"}


def prose(**over) -> dict:
    p = {
        "intro": "The script reads rows, asks a model once over 12,345 steps, and prints the answer.",
        "chapters": {"c1": {"title": "Reading the rows", "text": "Up to 500 rows come in."},
                     "c2": {"title": "Asking the model", "text": "One model call answers the question."}},
        "pick": ["s200-bbbbbb", "s5-aaaaaa", "s300-cccccc"],
        "stops": {
            "s5-aaaaaa": {"title": "Three rows", "text": "`read_rows` returns the rows the question is about."},
            "s200-bbbbbb": {"title": "The model answers", "text": "The reply says 'The base Transformer uses 8 attention heads' and used 1,234,567 tokens at 0.5.",
                            "quote": {"field": "v1", "from": PROMPT_TEXT.index("The base model"), "to": PROMPT_TEXT.index("Filler")}},
            "s300-cccccc": {"title": "The answer printed", "text": "`print` shows the reply, `client.chat` made it."},
        },
    }
    p.update(over)
    return p


def violations(p: dict) -> list[str]:
    return check_prose(tour(), p, FULL)[0]


def test_happy_path_merges_picks_in_run_order_with_the_quote_cut_from_the_full_value():
    merged = apply_prose(tour(), prose(), FULL)
    assert merged["pick"] == ["s5-aaaaaa", "s200-bbbbbb", "s300-cccccc"]
    by = {c["id"]: c for c in merged["candidates"]}
    q = by["s200-bbbbbb"]["prose"]["quote"]
    assert q["text"] == "The base model uses 8 heads with d_k = 64 per head. "
    assert q["field"] == "s200-bbbbbb.v1" and q["name"] == "prompt" and q["length"] == len(PROMPT_TEXT)
    assert "recordingCut" not in q
    assert by["s5-aaaaaa"]["prose"]["order"] == 1 and by["s300-cccccc"]["prose"]["order"] == 3
    assert merged["chapters"][1]["prose"] == {"title": "Asking the model", "text": "One model call answers the question."}
    assert merged["intro"].startswith("The script") and merged["prose"]["stops"] == 3
    assert merged["chapters"][0]["title"] == "load_rows"  # the rule's title stays; prose rides alongside


def test_thousands_separators_and_trailing_zeros_compare_equal():
    assert norm_number("1,234,567") == "1234567" and norm_number("0.50") == "0.5" and norm_number("10.0") == "10"
    assert violations(prose()) == []  # 1,234,567 and 0.5 against 1234567 and 0.50; 12,345 against run.steps


def test_unknown_ids_and_unpicked_text():
    p = prose(chapters={"c9": {"title": "Nope"}}, pick=["s5-aaaaaa", "s1-zzzzzz", "s5-aaaaaa"])
    p["stops"]["s7-nothere"] = {"title": "x", "text": "y"}
    v = violations(p)
    assert "chapters: unknown chapter id c9" in v
    assert "pick: unknown stop id s1-zzzzzz" in v
    assert "pick: s5-aaaaaa listed twice" in v
    assert "stops: unknown stop id s7-nothere" in v
    assert "stops: s200-bbbbbb has text but is not in pick" in v


def test_a_picked_stop_needs_title_and_text_and_fields_are_closed():
    p = prose()
    del p["stops"]["s5-aaaaaa"]
    p["stops"]["s300-cccccc"] = {"title": "", "text": "ok", "score": 3}
    p["extra"] = 1
    v = violations(p)
    assert "stops: s5-aaaaaa is picked but has no title and text" in v
    assert "s300-cccccc.title: missing or empty" in v
    assert any('s300-cccccc: unknown field "score"' in x for x in v)
    assert any('unknown field "extra"' in x for x in v)


def test_quote_on_a_field_the_stop_lacks_or_out_of_range():
    p = prose()
    p["stops"]["s5-aaaaaa"]["quote"] = {"field": "v4", "from": 0, "to": 3}
    p["stops"]["s200-bbbbbb"]["quote"] = {"field": "s200-bbbbbb.v2", "from": 10, "to": 9999}
    v = violations(p)
    assert any(x.startswith("s5-aaaaaa.quote: field 'v4' is not a value of this stop; it has v1 (rows)") for x in v)
    assert any(x.startswith("s200-bbbbbb.quote: range 10-9999 is outside s200-bbbbbb.v2, which is %d characters long" % len(REPLY)) for x in v)


def test_quote_past_the_recordings_own_cut_is_refused_and_inside_it_is_marked():
    p = prose()
    p["stops"]["s300-cccccc"]["quote"] = {"field": "cut_reply", "from": 1, "to": 25}
    v = violations(p)
    assert any("runs past character 15, where the recording cut s300-cccccc.v2" in x for x in v)
    p["stops"]["s300-cccccc"]["quote"] = {"value": "v2", "from": 1, "to": 9}  # `value` is accepted for `field`
    merged = apply_prose(tour(), p, FULL)
    q = next(c for c in merged["candidates"] if c["id"] == "s300-cccccc")["prose"]["quote"]
    assert q["text"] == "The base" and q["recordingCut"] is True and q["length"] == 15


def test_a_number_not_in_the_stops_values():
    p = prose()
    p["stops"]["s5-aaaaaa"]["text"] = "Reads 3 rows of 37 percent."  # 3 is not a value either: three items is a count
    p["chapters"]["c2"]["text"] = "It spent 14 calls."
    p["intro"] = "A run of 99,999 steps."
    v = violations(p)
    assert "s5-aaaaaa.text: number 3 is not in this stop's values, statement or quote" in v
    assert "s5-aaaaaa.text: number 37 is not in this stop's values, statement or quote" in v
    assert any(x.startswith("c2.text: number 14 is not in") for x in v)
    assert any(x.startswith("intro: number 99,999 is not in") for x in v)


def test_numbers_from_the_statement_the_chapter_range_and_glued_names_pass():
    p = prose()
    p["stops"]["s5-aaaaaa"]["text"] = "`read_rows` stops at 500; ids like s3 and gpt-4o are names."
    p["chapters"]["c2"]["text"] = "Steps 100 to 12,344 make 2 HTTP requests, 1 to a model."
    v = violations(p)
    assert not [x for x in v if x.startswith(("s5-aaaaaa", "c2"))], v


def test_a_sameAs_value_counts_with_its_whole_text():
    p = prose()
    p["stops"]["s300-cccccc"]["text"] = "It prints 'The base Transformer uses 8 attention heads' again."
    assert violations(p) == []


def test_backticked_names_must_occur_in_the_tour():
    p = prose()
    p["stops"]["s5-aaaaaa"]["text"] = "`load_everything()` and `client.chat` and `rows`."
    v = violations(p)
    assert v == ["s5-aaaaaa.text: `load_everything()` does not occur in the tour's statements, functions or values"]


def test_single_quoted_strings_must_be_in_that_stops_values():
    p = prose()
    p["stops"]["s5-aaaaaa"]["text"] = "The rows are 'alpha rows', not the model's reply."
    v = violations(p)
    assert v == ["s5-aaaaaa.text: 'alpha rows' is not in this stop's values"]


def test_counts_outside_the_prompt_are_warnings():
    _, w, _ = check_prose(tour(), prose(), FULL)
    assert any("pick: 3 stops; the prompt asks for 6 to 10" in x for x in w)


def test_rejection_carries_the_list_in_json():
    with pytest.raises(ProseRejected) as exc:
        apply_prose(tour(), prose(chapters={"c9": {"title": "x"}}), FULL)
    j = exc.value.to_json()
    assert j["ok"] is False and j["error"] == "the prose has 1 problem" and j["violations"] == ["chapters: unknown chapter id c9"]
    assert "- chapters: unknown chapter id c9" in exc.value.message


def _main(*argv: str) -> tuple[int, str]:
    from pyokka_runtime.__main__ import main

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main(list(argv))
    return code, buf.getvalue()


def test_cli_end_to_end_on_the_rrf_fixture(tmp_path: Path):
    run = tmp_path / "rrf.json"
    run.write_bytes(lzma.decompress((FIXTURES / "rrf.json.xz").read_bytes()))
    out = tmp_path / "tour.json"
    code, text = _main("tour", str(run), "--prose", str(FIXTURES / "rrf.prose.json"), "--out", str(out))
    assert code == 0, text
    assert text.startswith("prose accepted: 8 stops, 4 chapter texts") and text.rstrip().endswith("wrote %s" % out)
    merged = json.loads(out.read_text(encoding="utf-8"))
    assert merged["tour"] == 1 and len(merged["pick"]) == 8
    q = next(c for c in merged["candidates"] if c["id"] == "s45-ce0cc1")["prose"]["quote"]
    assert q["text"] == "'C': 0.03252247488101534" and q["recordingCut"] is True

    bad = json.loads((FIXTURES / "rrf.prose.json").read_text(encoding="utf-8"))
    bad["stops"]["s53-189112"]["text"] = "Rank 1 is worth 0.0164."
    bad_path = tmp_path / "bad.prose.json"
    bad_path.write_text(json.dumps(bad), encoding="utf-8")
    code, text = _main("tour", str(run), "--prose", str(bad_path), "--json")
    assert code == 2
    j = json.loads(text)
    assert j["violations"] == ["s53-189112.text: number 1 is not in this stop's values, statement or quote",
                               "s53-189112.text: number 0.0164 is not in this stop's values, statement or quote"]


def test_out_without_prose_writes_the_plain_tour(tmp_path: Path):
    run = tmp_path / "rrf.json"
    run.write_bytes(lzma.decompress((FIXTURES / "rrf.json.xz").read_bytes()))
    out = tmp_path / "tour.json"
    code, _ = _main("tour", str(run), "--out", str(out))
    assert code == 0 and "prose" not in json.loads(out.read_text(encoding="utf-8"))
