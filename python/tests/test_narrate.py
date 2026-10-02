"""`pyokka narrate`: backend resolution, the prompt, strict parsing, writing glosses into the saved run. No live model."""

from __future__ import annotations

import json
import os
import stat
import textwrap
from pathlib import Path

import pytest

from pyokka_runtime.agent import narrate
from pyokka_runtime.agent.narrate import GLOSS_MAX, Backend, NarrationError, build_prompt, extract_json_object, parse_glosses, resolve_backend, run_backend
from pyokka_runtime.agent.source import SavedRun
from pyokka_runtime.redact import REDACTED

from test_walkthrough import pyokka, saved_run

PROGRAM = """
def add(a, b):
    total = a + b
    return total

key = "sk-abcdefghijklmnopqrstuvwxyz012345"
n = add(1, 2)
print(n)
"""


def fake_cli(bin_dir: Path, name: str, script: str) -> Path:
    path = bin_dir / name
    path.write_text("#!/bin/sh\n" + textwrap.dedent(script), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


@pytest.fixture
def run_path(tmp_path: Path) -> Path:
    return saved_run(tmp_path, PROGRAM)


@pytest.fixture
def bin_dir(tmp_path: Path, monkeypatch) -> Path:
    d = tmp_path / "bin"
    d.mkdir()
    monkeypatch.setenv("PATH", "%s:/usr/bin:/bin" % d)  # the fakes use cat and printf
    return d


def test_resolve_backend_prefers_the_setting_then_claude_then_codex(bin_dir: Path):
    assert resolve_backend("my-model --fast").argv == ["my-model", "--fast"] and resolve_backend("my-model").name == "custom"
    assert resolve_backend(None) is None
    fake_cli(bin_dir, "codex", "exit 0")
    b = resolve_backend(None)
    assert b.name == "codex" and b.argv[:3] == ["codex", "exec", "--skip-git-repo-check"] and "-o" in b.argv and b.argv[-1] == "-" and b.output_file
    fake_cli(bin_dir, "claude", "exit 0")
    b = resolve_backend(None)
    assert b.name == "claude" and b.argv == ["claude", "-p", "--output-format", "json", "--tools", "", "--no-session-persistence"]


def test_run_backend_reads_each_cli_the_way_it_answers(bin_dir: Path):
    fake_cli(bin_dir, "claude", 'cat > /dev/null; printf \'{"type":"result","is_error":false,"result":"{\\\\"m0\\\\": \\\\"starts\\\\"}"}\'')
    assert run_backend(resolve_backend(None), "prompt") == '{"m0": "starts"}'
    fake_cli(bin_dir, "claude", 'cat > /dev/null; printf \'{"type":"result","is_error":true,"result":"Not logged in"}\'')
    with pytest.raises(NarrationError, match="claude reported an error: Not logged in"):
        run_backend(resolve_backend(None), "prompt")
    os.unlink(bin_dir / "claude")
    fake_cli(bin_dir, "codex", 'while [ "$1" != "-o" ]; do shift; done; cat > /dev/null; echo "log noise"; printf \'{"m0": "from codex"}\' > "$2"')
    b = resolve_backend(None)
    assert b.name == "codex" and run_backend(b, "prompt") == '{"m0": "from codex"}'
    fake_cli(bin_dir, "mine", 'read -r first; echo "{\\"m0\\": \\"$first\\"}"')
    assert run_backend(Backend("custom", [str(bin_dir / "mine")]), "hello\nworld") == '{"m0": "hello"}\n'
    fake_cli(bin_dir, "broken", 'echo "boom sk-abcdefghijklmnopqrstuvwxyz012345" >&2; exit 3')
    with pytest.raises(NarrationError) as exc:
        run_backend(Backend("custom", [str(bin_dir / "broken")]), "p")
    assert "exited with 3" in exc.value.message and REDACTED in exc.value.message and "sk-abc" not in exc.value.message
    with pytest.raises(NarrationError, match="not on the PATH"):
        run_backend(Backend("custom", ["no-such-command-xyz"]), "p")


def test_parse_glosses_is_strict_and_tolerant_of_fences():
    ids = ["m0", "m1", "m2"]
    assert parse_glosses('Sure!\n```json\n{"m0": "a", "m1": "b  c", "zz": "dropped"}\n```', ids) == {"m0": "a", "m1": "b c"}
    long = "x" * 200
    assert parse_glosses(json.dumps({"m2": long}), ids) == {"m2": long[: GLOSS_MAX - 1] + "…"}
    with pytest.raises(NarrationError, match="not answer with a JSON object"):
        parse_glosses("I cannot do that", ids)
    with pytest.raises(NarrationError, match="is not a string"):
        parse_glosses('{"m0": ["a"]}', ids)
    with pytest.raises(NarrationError, match="glossed none"):
        parse_glosses('{"other": "a"}', ids)
    assert extract_json_object('text {"a": "}"} more {"b": 1}') == {"a": "}"}
    with pytest.raises(ValueError):
        extract_json_object("[1, 2]")


def test_build_prompt_redacts_values_and_lists_sources():
    template = "HEAD\n{{walkthrough}}\nMID\n{{sources}}\nTAIL"
    walk = {"moments": [{"id": "m0", "step": 1, "kind": "value", "text": "key = 'sk-abcdefghijklmnopqrstuvwxyz012345'", "values": [{"role": "value", "name": "key", "text": "'sk-abcdefghijklmnopqrstuvwxyz012345'"}], "location": {"file": "/w/a.py", "line": 3, "function": "<module>", "fileId": 1}, "callee": {"secret": "x"}}]}
    text = build_prompt(template, walk, [{"file": "a.py", "function": "add", "line": 1, "text": "def add(a, b):\n    return a + b"}])
    assert text.startswith("HEAD\n{") and text.endswith("\nTAIL") and "### a.py: add (line 1)" in text and "```python\ndef add(a, b):" in text
    assert "sk-abc" not in text and REDACTED in text and '"file": "a.py"' in text and "callee" not in text and "/w/a.py" not in text


def test_narrate_writes_glosses_into_the_run_and_walkthrough_shows_them(run_path: Path, bin_dir: Path, tmp_path: Path):
    code, out = pyokka("walkthrough", str(run_path), "--json")
    ids = [m["id"] for m in json.loads(out)["moments"]]
    answer = json.dumps({i: "gloss for %s" % i for i in ids} | {"m0": "the program begins"})
    prompt_copy = tmp_path / "prompt.txt"
    fake_cli(bin_dir, "claude", 'cat > "%s"; printf \'%%s\' \'%s\'' % (prompt_copy, json.dumps({"type": "result", "result": answer})))
    code, text = pyokka("narrate", str(run_path))
    assert code == 0, text
    assert text.startswith("%d of %d moments glossed by claude, written to %s" % (len(ids), len(ids), run_path))
    prompt = prompt_copy.read_text(encoding="utf-8")
    assert "sk-abc" not in prompt and REDACTED in prompt and "def add(a, b):" in prompt and '"id": "m0"' in prompt
    meta = json.loads(run_path.read_text(encoding="utf-8"))["meta"]
    assert meta["walkthroughGloss"]["m0"] == "the program begins" and len(meta["walkthroughGloss"]) == len(ids)
    code, text = pyokka("walkthrough", str(run_path))
    lines = text.splitlines()
    assert lines[1] == "#0  module main.py starts" and lines[2] == "      the program begins"
    doc = json.loads(pyokka("walkthrough", str(run_path), "--json")[1])
    assert doc["moments"][0]["gloss"] == "the program begins" and all(m["gloss"] for m in doc["moments"])
    # the glosses survive a re-read; a failed narration keeps them untouched and reports once
    fake_cli(bin_dir, "claude", 'cat > /dev/null; echo "nope"')
    code, text = pyokka("narrate", str(run_path))
    assert code == 2
    assert json.loads(run_path.read_text(encoding="utf-8"))["meta"]["walkthroughGloss"]["m0"] == "the program begins"


def test_narrate_errors_say_what_to_do(run_path: Path, bin_dir: Path, capsys):
    code, _ = pyokka("narrate", str(run_path))
    err = capsys.readouterr().err
    assert code == 2 and "no narration backend" in err and "--command" in err
    code, _ = pyokka("narrate", str(run_path), "--command", "definitely-missing-cli")
    err = capsys.readouterr().err
    assert code == 2 and "narration failed: definitely-missing-cli is not on the PATH" in err
    code, out = pyokka("narrate", str(run_path), "--dry-run")
    assert code == 0 and out.startswith("You are annotating") and "{{walkthrough}}" not in out and "## Walkthrough" in out


def test_prompt_file_ships_with_the_runtime():
    assert os.path.exists(narrate.PROMPT_FILE) and "{{walkthrough}}" in narrate.prompt_template() and "{{sources}}" in narrate.prompt_template()
