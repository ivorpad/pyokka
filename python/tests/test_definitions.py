"""Cmd-click definitions resolved with `ast` only across the project's own files (4.14)."""

from __future__ import annotations

from pathlib import Path

from pyokka_runtime.definitions import definitions

PROJECT = Path(__file__).resolve().parent / "fixtures" / "port" / "defs"
MAIN = PROJECT / "main.py"


def at(name: str, line: int, nth: int = 0) -> list[tuple[str, int, int]]:
    """Definitions of the `nth` `name` on 1-based `line` of main.py, clicked on its first character."""
    source = MAIN.read_text(encoding="utf-8")
    lines = source.split("\n")
    col = -1
    for _ in range(nth + 1):
        col = lines[line - 1].index(name, col + 1)
    offset = len("\n".join(lines[: line - 1] + [lines[line - 1][:col]]).encode("utf-16-le")) // 2
    return [(str(Path(d["path"]).relative_to(PROJECT)), d["line"], d["column"]) for d in definitions(source, str(MAIN), offset)]


def test_imports_are_followed_into_project_files():
    # `from shapes import area_of` goes through shapes/__init__.py's re-export to core.py
    assert at("area_of", 7) == [("shapes/core.py", 12, 5)]
    assert at("Circle", 6) == [("shapes/core.py", 4, 7)]
    # `units.scale`: an attribute of a module imported `as units`
    assert at("scale", 7) == [("shapes/units.py", 1, 5)]
    # a namespace package (no __init__.py)
    assert at("shout", 7) == [("helpers/text.py", 1, 5)]
    # `Circle.area`: the method in the class body
    assert at("area", 8, 1) == [("shapes/core.py", 8, 9)]


def test_local_bindings_and_out_of_scope_targets():
    # `c`: its assignment, after a non-ASCII string on its line (column in UTF-16 units; Python's str index says 15)
    assert at("c", 8) == [("main.py", 6, 16)]
    # the standard library, installed packages and builtins answer nothing
    assert at("json", 7) == []
    assert at("dumps", 7) == []
    assert at("print", 7) == []
