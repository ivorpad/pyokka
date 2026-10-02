"""`pyokka history`: the data behind a code-history page.

The first test is the one the artifact rests on: every value the generator puts on a card is
what `pyokka context RUN N --json` prints for that step. It rebuilds the expected string from
the context JSON by hand rather than calling the generator's own formatter, so the two can
actually disagree.
"""

from __future__ import annotations

import io
import json
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.checkpoint import arm_text, flatten_chain, source_window
from pyokka_runtime.redact import REDACTED

PROGRAM = """
def scale(value, factor=3):
    scaled = value * factor
    return scaled


def total_of(rows):
    total = 0
    for row in rows:
        if row < 0:
            continue
        total += scale(row)
    return total


api_key = "sk-abcdefghijklmnopqrstuvwxyz012345"
rows = [1, -2, 4]
answer = total_of(rows)
print("answer", answer)
"""


def pyokka(*args: str) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main([str(a) for a in args])
    return code, buf.getvalue()


def pyokka_json(*args: str) -> dict:
    code, out = pyokka(*args, "--json")
    doc = json.loads(out)
    assert code == 0, doc
    return doc


@pytest.fixture
def program(tmp_path: Path) -> Path:
    path = tmp_path / "main.py"
    path.write_text(textwrap.dedent(PROGRAM).lstrip(), encoding="utf-8")
    return path


@pytest.fixture
def saved(program: Path) -> Path:
    out = program.parent / "run.json"
    code, text = pyokka("run", str(program), "--save", str(out))
    assert code == 0 and "23 steps" in text
    return out


def history(saved: Path, *args: str, out: str | None = None) -> dict:
    target = out or str(saved.parent / "history.json")
    code, _ = pyokka("history", str(saved), *args, "--out", target)
    assert code == 0
    return json.loads(Path(target).read_text(encoding="utf-8"))


def expected_values(slice_: dict, step: int) -> str:
    """The card's `values`, rebuilt from `context --json` without the generator's help."""
    lines = []
    for value in slice_["values"]:
        text = " ".join(str(value["text"]).split("\n")).strip()
        if len(text) > 200:
            text = text[:199] + "…"
        line = "%s = %s" % (value["context"], text) if value.get("context") else text
        if isinstance(value.get("step"), int) and value["step"] != step:
            line += "   #%d" % value["step"]
        lines.append(line)
    return "\n".join(lines)


def test_every_value_matches_context(saved: Path):
    data = history(saved, "--at", "4", "--at", "8", "--at", "17", "--at", "22")
    assert [card["step"] for card in data["steps"]] == [4, 8, 17, 22]
    for card in data["steps"]:
        slice_ = pyokka_json("context", str(saved), str(card["step"]))
        assert card["values"] == expected_values(slice_, card["step"]), card["id"]
        assert card["focus"] == slice_["location"]["line"]
        assert len(card["stack"]) == len(slice_["stack"])
        assert card["stack"][0].startswith(slice_["stack"][0]["function"])
        assert card["verify"] == "pyokka context %s %d --json" % (saved, card["step"])


def test_at_a_line_resolves_to_the_first_step_on_it(saved: Path):
    data = history(saved, "--at", "main.py:9")
    card = data["steps"][0]
    assert card["focus"] == 9 and card["step"] == pyokka_json("context", str(saved), "--line", "main.py:9")["step"]


def test_var_expands_in_step_order_and_matches_var_json(saved: Path):
    result = pyokka_json("var", str(saved), "total")
    data = history(saved, "--var", "total")
    assert [c["step"] for c in data["steps"]] == [c["step"] for c in result["changes"]] == [4, 8, 17]
    assert [c["id"] for c in data["steps"]] == ["var-total-1", "var-total-2", "var-total-3"]
    assert [c["tag"] for c in data["steps"]] == ["CHANGE 1 OF 3", "CHANGE 2 OF 3", "CHANGE 3 OF 3"]
    for card, change in zip(data["steps"], result["changes"]):
        assert card["values"] == "total = %s" % change["text"]
        assert [r.split(" = ")[0] for r in card["reads"]] == [r["name"] for r in change.get("reads") or []]
        assert card["verify"] == "pyokka var %s total --json" % saved
    assert data["steps"][2]["values"] == "total = 15" and "total = 3" in data["steps"][2]["reads"][0]


def test_why_chain_flattens_the_provenance_tree(saved: Path):
    result = pyokka_json("why", str(saved), "22", "answer")
    data = history(saved, "--why", "22", "answer")
    card = data["steps"][0]
    assert card["id"] == "why-22-answer" and card["step"] == result["root"]["step"]
    chain = card["chain"]
    assert chain == flatten_chain(result["root"])
    assert chain[0]["depth"] == 0 and chain[0]["via"] == "root" and chain[0]["name"] == "answer"
    assert [n["via"] for n in chain[1:]] and all(n["depth"] >= 1 for n in chain[1:])
    assert any(n["via"] == "reads" and n["name"] == "rows" for n in chain)
    assert any(n["via"] == "calls" and n["name"] == "total_of" for n in chain)
    assert card["verify"] == "pyokka why %s 22 answer --json" % saved


def test_source_keeps_original_line_numbers(saved: Path, program: Path):
    data = history(saved, "--at", "8")
    lines = program.read_text(encoding="utf-8").split("\n")
    card = data["steps"][0]
    rows = data["files"]["main.py"]
    assert rows[card["focus"] - 1] == lines[card["focus"] - 1] == "        total += scale(row)"
    for n in range(card["start"], card["end"] + 1):
        assert rows[n - 1] == lines[n - 1], n
    assert 1 <= card["start"] <= card["focus"] <= card["end"] <= len(lines)
    assert card["bright"] and all(card["start"] <= n <= card["end"] for n in card["bright"])
    # lines no checkpoint asked for stay empty, so a long file contributes only what the page shows
    assert rows[0] == "" and len(rows) == card["end"]


def test_source_window_centres_a_block_wider_than_the_cap():
    block = [{"line": n} for n in (1, 5, 40, 90, 120)]
    start, end, bright = source_window(block, 90, 2, 200, 40)
    assert end - start + 1 == 40 and start <= 90 <= end and bright == [90]
    whole = source_window(block, 90, 2, 200, 0)
    assert whole[0] == 1 and whole[1] == 122 and whole[2] == [1, 5, 40, 90, 120]
    one = source_window([], 7, 3, 50)
    assert one == (4, 10, [])


def test_arm_text_says_when_a_branch_went_both_ways():
    assert arm_text(["if x took True"]) == "if x took True"
    assert arm_text(["for r ran 4 times"] * 2) == "for r ran 4 times, entered 2 times"
    assert arm_text(["if x took False", "if x took True", "if x took False"]) == "if x took False x2, True x1"


def test_call_hits_and_arm_come_from_the_run(saved: Path):
    data = history(saved, "--at", "8", "--at", "main.py:9")
    call_card, branch_card = data["steps"]
    assert call_card["call"] == {"name": "scale", "in": ["value = 1", "factor = 3"], "out": "return = 3"}
    assert call_card["hits"] == 2
    assert branch_card["arm"] == "if row < 0 took False x2, True x1" and branch_card["hits"] == 3
    assert branch_card["call"] is None  # a call with neither in nor out is noise, not evidence


def test_meta_identity(saved: Path):
    data = history(saved, "--at", "8")
    meta = data["meta"]
    run = json.loads(saved.read_text(encoding="utf-8"))
    assert meta["mode"] == "saved run" and meta["run"] == str(saved) and meta["file"] == "main.py"
    assert run["meta"]["files"][0]["sha256"].startswith(meta["sourceSha256"]) and len(meta["sourceSha256"]) == 14
    assert len(meta["runSha256"]) == 14
    assert meta["stepCount"] == pyokka_json("state", str(saved))["nav"]["count"] == 23
    assert meta["exitCode"] == 0 and meta["python"] == run["meta"]["python"] and meta["truncated"] == []


def test_prose_is_empty_until_merged(saved: Path):
    data = history(saved, "--at", "8")
    assert data["heading"] == "" and data["summary"] == "" and data["labels"] == {}
    card = data["steps"][0]
    assert card["title"] == "" and card["text"] == "" and card["note"] == ""


def test_prose_merge_fills_only_prose(saved: Path, tmp_path: Path):
    prose = tmp_path / "prose.json"
    prose.write_text(json.dumps({"heading": "scale runs twice", "steps": {"step-8": {"title": "First pass", "note": "n"}}}), encoding="utf-8")
    data = history(saved, "--at", "8", "--prose", str(prose))
    card = data["steps"][0]
    assert data["heading"] == "scale runs twice" and card["title"] == "First pass" and card["note"] == "n"
    assert card["values"] and card["verify"]  # the generated half is untouched


def test_prose_sets_evidence_links_as_documented(saved: Path, tmp_path: Path):
    """code-history.md lists `evidence` on a checkpoint as prose: links the agent cites, not values from the run."""
    prose = tmp_path / "prose.json"
    prose.write_text(json.dumps({"steps": {"step-8": {"title": "t", "evidence": ["notes/run.txt", "https://example.com/issue/1"]}}}), encoding="utf-8")
    card = history(saved, "--at", "8", "--prose", str(prose))["steps"][0]
    assert card["evidence"] == ["notes/run.txt", "https://example.com/issue/1"] and card["title"] == "t"
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"steps": {"step-8": {"evidence": "notes/run.txt"}}}), encoding="utf-8")
    code, out = pyokka("history", str(saved), "--at", "8", "--out", str(tmp_path / "h.json"), "--prose", str(bad), "--json")
    assert code == 2 and "evidence" in json.loads(out)["error"]
    bad.write_text(json.dumps({"steps": {"step-8": {"evidence": ["javascript:alert(1)"]}}}), encoding="utf-8")
    code, out = pyokka("history", str(saved), "--at", "8", "--out", str(tmp_path / "h.json"), "--prose", str(bad), "--json")
    assert code == 2 and "evidence" in json.loads(out)["error"]


LONG = """
prompt = "x" * 500
print(len(prompt))
"""


def test_card_values_follow_the_runs_value_limit(tmp_path: Path):
    """A run kept with --max-value-chars 0 holds the whole 502-character repr; the card shows it, not 200 characters of it."""
    prog = tmp_path / "long.py"
    prog.write_text(LONG.lstrip(), encoding="utf-8")
    out = tmp_path / "long.json"
    assert pyokka("run", str(prog), "--save", str(out), "--max-value-chars", "0")[0] == 0
    card = history(out, "--var", "prompt")["steps"][0]
    assert card["values"] == "prompt = '%s'" % ("x" * 500)
    # --value-chars cuts the page shorter than the run, and says how much it left out
    card = history(out, "--var", "prompt", "--value-chars", "60")["steps"][0]
    assert card["values"].startswith("prompt = 'xxx") and card["values"].endswith("chars)") and len(card["values"]) < 90
    # a run with the default limits still reads as it did: 120 characters of a local, marked
    short = tmp_path / "short.json"
    assert pyokka("run", str(prog), "--save", str(short))[0] == 0
    card = history(short, "--var", "prompt")["steps"][0]
    assert card["values"].endswith("…(+382 chars)"), card["values"]


@pytest.mark.parametrize(
    "prose, message",
    [
        ({"steps": {"step-8": {"values": "total = 999"}}}, 'prose may not set "values" on step-8'),
        ({"steps": {"step-8": {"step": 3}}}, 'prose may not set "step" on step-8'),
        ({"meta": {}}, 'prose may not set "meta"'),
        ({"steps": {"step-99": {"title": "x"}}}, "no checkpoint step-99 in this page"),
    ],
)
def test_prose_refuses_what_comes_from_the_run(saved: Path, tmp_path: Path, prose: dict, message: str):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(prose), encoding="utf-8")
    code, out = pyokka("history", str(saved), "--at", "8", "--out", str(tmp_path / "h.json"), "--prose", str(path), "--json")
    assert code == 2 and message in json.loads(out)["error"]


def test_a_stale_run_is_refused(saved: Path, program: Path, tmp_path: Path):
    program.write_text(program.read_text(encoding="utf-8") + "\n# edited\n", encoding="utf-8")
    code, out = pyokka("history", str(saved), "--at", "8", "--out", str(tmp_path / "h.json"), "--json")
    doc = json.loads(out)
    assert code == 2 and "stale: main.py changed since the run" in doc["error"] and "record again" in doc["hint"]


def test_limit_is_reported_not_silent(saved: Path):
    data = history(saved, "--var", "total", "--limit", "2")
    assert len(data["steps"]) == 2 and data["meta"]["truncated"] == ["--var total: 2 of 3 changes"]


def test_secrets_never_reach_the_page(saved: Path, tmp_path: Path):
    target = tmp_path / "secret.json"
    code, out = pyokka("history", str(saved), "--at", "0", "--out", str(target))
    raw = target.read_text(encoding="utf-8")
    assert code == 0
    # the value was masked when the run was saved; the source line is masked here, because an HTML
    # file travels further than the terminal `pyokka context` redacts for
    assert "sk-abcdefghijklmnopqrstuvwxyz012345" not in raw
    assert REDACTED in json.loads(raw)["files"]["main.py"][14]
    assert "main.py:15 held a secret and was redacted in the page's source" in out


def test_order_follows_the_command_line(saved: Path):
    data = history(saved, "--why", "22", "answer", "--at", "4", "--var", "total")
    assert [c["id"] for c in data["steps"]] == ["why-22-answer", "step-4", "var-total-1", "var-total-2", "var-total-3"]


def test_repeated_selectors_keep_unique_ids(saved: Path):
    data = history(saved, "--at", "8", "--at", "8")
    assert [c["id"] for c in data["steps"]] == ["step-8", "step-8-2"]


def test_no_checkpoints_is_an_error(saved: Path, tmp_path: Path):
    code, out = pyokka("history", str(saved), "--out", str(tmp_path / "h.json"), "--json")
    assert code == 2 and "no checkpoints" in json.loads(out)["error"]


def test_every_checkpoint_declares_an_evidence_kind(saved: Path):
    data = history(saved, "--at", "8", "--var", "total", "--why", "22", "answer")
    assert {c["kind"] for c in data["steps"]} == {"recorded step"}
    assert all(c["verify"].startswith("pyokka ") for c in data["steps"])
    assert all(c["output"] == "" and c["modified"] is False for c in data["steps"])


# -- the repository's own demo, end to end -------------------------------------------------------

DEMO = Path(__file__).resolve().parents[2] / "examples" / "demo.py"


@pytest.fixture
def demo_run(tmp_path: Path) -> Path:
    out = tmp_path / "demo-run.json"
    code, text = pyokka("run", str(DEMO), "--save", str(out))
    assert code == 1 and "saved" in text, text  # the demo ends on a deliberate ValueError
    return out


def test_the_demo_page_agrees_with_the_cli_everywhere(demo_run: Path):
    """Regenerate a page over the repository's demo and re-run every checkpoint's verify line.

    This is the claim the whole artifact rests on: a reader who pastes the command under a value
    gets that value back. It is checked here the way a reader would check it, by running the
    command, not by calling the generator's own formatter.
    """
    data = history(demo_run, "--at", "3", "--at", "9", "--at", "26", "--var", "pyokka", "--var", "total")
    assert len(data["steps"]) >= 5
    source = DEMO.read_text(encoding="utf-8").split("\n")
    for card in data["steps"]:
        verb, run, *rest = card["verify"].split()[1:]
        assert run == str(demo_run)
        if verb == "context":
            slice_ = pyokka_json("context", run, rest[0])
            assert card["values"] == expected_values(slice_, card["step"]), card["id"]
        else:
            change = next(c for c in pyokka_json("var", run, rest[0])["changes"] if c["step"] == card["step"])
            assert card["values"] == "%s = %s" % (change["name"], change["text"]), card["id"]
            slice_ = pyokka_json("context", run, str(card["step"]))
        assert card["focus"] == slice_["location"]["line"], card["id"]
        rows = data["files"][card["file"]]
        assert [rows[n - 1] for n in range(card["start"], card["end"] + 1)] == source[card["start"] - 1 : card["end"]], card["id"]
        ran = {line["line"] for line in slice_["block"]["lines"]}
        assert set(card["bright"]) <= ran, "%s: a green line the recording never ran" % card["id"]


def test_the_demo_page_renders(demo_run: Path, tmp_path: Path):
    import subprocess

    root = Path(__file__).resolve().parents[2]
    renderer = root / "skills" / "pyokka" / "scripts" / "render-code-history.cjs"
    if not (root / "node_modules" / "handlebars").exists():
        pytest.skip("handlebars is not installed; `npm install` in the checkout")
    target = tmp_path / "history.json"
    history(demo_run, "--at", "9", "--var", "total", out=str(target))
    page = tmp_path / "page.html"
    subprocess.run(["node", str(renderer), str(target), str(page)], cwd=root, check=True, capture_output=True)
    html = page.read_text(encoding="utf-8")
    assert html.startswith("<!doctype html>") and "pyokka context" in html
    assert "<script src=" not in html and "https://" not in html


def test_append_adds_to_an_existing_page_and_keeps_ids_unique(saved: Path, tmp_path: Path):
    """A program passes one pause at a time, so a page that follows two of them is built twice.

    Merging the generated objects keeps the guarantee the page rests on; merging them by hand in
    a scratch script, which is what an agent did before this flag existed, is how a typed value
    gets onto a page that claims none of its values were typed.
    """
    target = tmp_path / "page.json"
    history(saved, "--at", "4", out=str(target))
    code, text = pyokka("history", str(saved), "--at", "8", "--at", "4", "--out", str(target), "--append")
    assert code == 0 and "added 2 to" in text
    data = json.loads(target.read_text(encoding="utf-8"))
    assert [c["id"] for c in data["steps"]] == ["step-4", "step-8", "step-4-2"]
    assert data["steps"][0]["values"] == data["steps"][2]["values"], "the same step twice, same values"
    lines = data["files"]["main.py"]
    assert lines[10] and lines[6], "both windows' source survives the merge"


def test_append_refuses_a_file_that_is_not_a_page(saved: Path, tmp_path: Path):
    target = tmp_path / "notapage.json"
    target.write_text('{"hello": 1}', encoding="utf-8")
    code, out = pyokka("history", str(saved), "--at", "8", "--out", str(target), "--append", "--json")
    assert code == 2 and "is not a code-history page" in json.loads(out)["error"]
