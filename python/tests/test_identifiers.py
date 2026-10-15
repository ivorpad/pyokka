"""The `bindings` reply's `identifiers`: lexical scopes and references with UTF-16 offsets (4.12)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from pyokka_runtime.identifiers import source_identifiers

PY_DIR = Path(__file__).resolve().parents[1]


def _text(source: str, ref: dict) -> str:
    """The reference's text as JavaScript slices it (UTF-16 code units)."""
    units = source.encode("utf-16-le")
    return units[2 * ref["start"] : 2 * ref["end"]].decode("utf-16-le")


def test_offsets_are_utf16_units_on_a_non_ascii_line_through_the_runner():
    # "é" is one UTF-16 unit and 2 UTF-8 bytes; "🚀" is two units, one code point and 4 bytes
    source = 'label = "é🚀"; total = 1\nprint(total)\n'
    proc = subprocess.run(
        [sys.executable, "-m", "pyokka_runtime", "serve"],
        input=json.dumps({"type": "bindings", "id": 1, "source": source, "identifiers": True}) + "\n" + json.dumps({"type": "shutdown", "id": 2}) + "\n",
        capture_output=True, text=True, cwd=PY_DIR, timeout=30,
    )
    reply = next(json.loads(line) for line in proc.stdout.splitlines() if json.loads(line).get("id") == 1)
    refs = reply["identifiers"]["references"]
    total = [r for r in refs if r["name"] == "total"]
    assert [r["start"] for r in total] == [15, 31]  # Python str indices would say 14
    assert [_text(source, r) for r in refs] == ["label", "total", "print", "total"]


def test_scopes_follow_python_name_resolution():
    source = (
        "x = 1\n"
        "def f(x):\n"
        "    global g\n"
        "    g = x\n"
        "    ys = [x for x in range(3)]\n"
        "    class K:\n"
        "        k = 1\n"
        "        def m(self):\n"
        "            return k, x\n"
        "    return ys\n"
    )
    data = source_identifiers(source)
    scopes, refs = data["scopes"], data["references"]
    by = lambda name: [r for r in refs if r["name"] == name]
    xs = by("x")
    module, param = xs[0]["scope"], xs[1]["scope"]
    assert module == 0 and param != module and scopes[param]["name"] == "f"
    # `g = x` reads the parameter; the comprehension's own x is its own binding
    assert xs[2]["scope"] == param
    comp = {r["scope"] for r in xs[3:5]}
    assert len(comp) == 1 and scopes[comp.pop()].get("comprehension")
    # the method's x is f's parameter; its `k` does not see the class body's k
    assert xs[5]["scope"] == param
    assert [r["scope"] for r in by("k")] == [scopes.index(next(s for s in scopes if s.get("name") == "K")), -1]
    # `global g` in f binds the module's g
    assert by("g")[0]["scope"] == 0 and "g" in scopes[0]["names"]


def test_declarations_are_assignment_targets_parameters_for_targets_and_with_as():
    source = (
        "import os\n"
        "def run(path, *rest, flag=False, **opts):\n"
        "    total = 0\n"
        "    a, (b, c) = 1, (2, 3)\n"
        "    total += a\n"
        "    for i, item in enumerate(rest):\n"
        "        print(item)\n"
        "    with open(path) as fh, open(path) as gh:\n"
        "        if (n := len(fh.read())):\n"
        "            pass\n"
        "    hint: int\n"
        "    return total\n"
    )
    refs = source_identifiers(source)["references"]
    declared = [r["name"] for r in refs if r.get("declaration")]
    assert declared == ["path", "rest", "flag", "opts", "total", "a", "b", "c", "total", "i", "item", "fh", "gh", "n"]
    # reads, the def's own name, imports and an annotation without a value declare nothing
    assert not any(r.get("declaration") for r in refs if r["name"] in ("os", "run", "print", "enumerate", "open", "hint"))
