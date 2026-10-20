"""Edge candidates from a PR's added lines: the constructs that have edges, each with what to try."""

from __future__ import annotations

import ast
import textwrap
from pathlib import Path

from pyokka_runtime.agent.review.debugger import breakable_line
from pyokka_runtime.agent.review.edges import changed_lines, edges, is_test_file, render_edges
from pyokka_runtime.agent.review.syntax import function_at

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "review"

DIFF = """\
diff --git a/pkg/a.py b/pkg/a.py
index 1..2 100644
--- a/pkg/a.py
+++ b/pkg/a.py
@@ -1,4 +1,5 @@
 import os
-x = 1
+x = 2
+y = 3
 z = 4
@@ -10,3 +11,4 @@ def f():
     a = 1
+    b = 2
     return a
\\ No newline at end of file
diff --git a/pkg/new.py b/pkg/new.py
new file mode 100644
--- /dev/null
+++ b/pkg/new.py
@@ -0,0 +1,2 @@
+def g():
+    pass
diff --git a/pkg/gone.py b/pkg/gone.py
deleted file mode 100644
--- a/pkg/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-def h():
-    pass
"""


def test_changed_lines_are_the_added_lines_in_head_per_file():
    assert changed_lines(DIFF) == {"pkg/a.py": {2, 3, 12}, "pkg/new.py": {1, 2}}
    assert changed_lines("") == {}


def test_test_files_are_recognised_by_path_or_name():
    assert is_test_file("tests/test_money.py") and is_test_file("pkg/tests/x.py") and is_test_file("test_cli.py")
    assert not is_test_file("shopkit/pricing.py") and not is_test_file("pkg/testing.py")


def test_shop_edges_name_the_boundary_the_attribute_and_the_except_path():
    diff = (FIXTURES / "shop.diff").read_text(encoding="utf-8")
    rows = edges(diff, str(FIXTURES / "shop_head"))
    assert [r["id"] for r in rows] == ["E%d" % i for i in range(1, 14)]
    assert [(r["kind"], r["file"], r["line"], r["function"]) for r in rows[:3]] == [
        ("boundary", "shopkit/discounts.py", 16, "spend_tier_rate"),
        ("attribute", "shopkit/discounts.py", 8, "loyalty_rate"),
        ("except path", "shopkit/pricing.py", 13, "subtotal"),
    ]
    assert rows[0]["what"] == "`spend > threshold`: call spend_tier_rate with spend equal to threshold, and just above and below it; check the arm against what the PR says (at or above? strictly above?)"
    assert rows[1]["what"].startswith("`settings.platinum_rate`: no class in the project defines `platinum_rate`")
    assert rows[2]["what"].startswith("handler for (TypeError, KeyError) returning 0.0: give subtotal an input that raises inside the try")
    kinds = {r["kind"] for r in rows}
    assert kinds == {"boundary", "attribute", "except path", "new parameter", "empty loop", "ordering", "equality"}
    assert not any(r["file"].startswith("tests/") for r in rows)  # tests/test_*.py changed too, and are left out
    assert [r["rank"] for r in rows] == sorted(r["rank"] for r in rows)
    listing = render_edges(rows, 10)
    assert listing[0] == "edges: 13 candidates from 10 changed files; try each with a run, a test command or an experiment and report tried (result) or skipped (why)"
    assert listing[1:3] == ["E1 [boundary] shopkit/discounts.py:16 spend_tier_rate", "    " + rows[0]["what"]]


def _tree(tmp_path: Path, files: dict[str, str]) -> tuple[str, str]:
    """Write ``files`` under ``tmp_path`` and return the tree and a diff that adds every line of each."""
    hunks = []
    for rel, text in files.items():
        text = textwrap.dedent(text).lstrip("\n")
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text, encoding="utf-8")
        lines = text.splitlines()
        hunks.append("--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n%s\n" % (rel, len(lines), "\n".join("+" + l for l in lines)))
    return str(tmp_path), "".join(hunks)


def test_each_rule_fires_on_its_construct_and_not_on_the_exceptions(tmp_path: Path):
    tree, diff = _tree(tmp_path, {
        "pkg/models.py": """
            class Settings:
                known: int = 1

                def __init__(self):
                    self.also = 2
            """,
        "pkg/work.py": """
            import os
            from pkg.models import Settings


            def work(rows, settings, n, label):
                total = rows[0]["qty"] + settings.get("extra", 0)
                share = total / n
                head = rows[:n]
                order = sorted(rows, key=lambda r: r["qty"])
                text = "%s" % label
                a = settings.known + settings.also + settings.missing
                b = settings.run() + os.path.sep
                for r in rows:
                    total = total + 1
                try:
                    return total
                except ValueError:
                    return None
            """,
        "tests/test_work.py": """
            def test_it(rows):
                assert rows[0]["qty"] > 1
            """,
    })
    rows = edges(diff, tree)
    by_kind: dict[str, list[dict]] = {}
    for r in rows:
        by_kind.setdefault(r["kind"], []).append(r)
    assert all(r["file"] == "pkg/work.py" for r in rows), rows  # models.py has no edge, tests are skipped

    def construct(r: dict) -> str:
        return r["what"][: r["what"].index("`:") + 1]

    assert [construct(r) for r in by_kind["missing key"]] == ["`rows[0]['qty']`", "`settings.get('extra', 0)`", "`r['qty']`"]  # the lambda's subscript counts too
    assert [r["what"] for r in by_kind["zero divisor"]] == ["`total / n`: call work with n == 0"]  # `'%s' % label` is a format, not a division
    assert [r["line"] for r in by_kind["slice bound"]] == [8]
    assert [construct(r) for r in by_kind["ordering"]] == ["`sorted(rows, key=lambda r: r['qty'])`"]
    assert [construct(r) for r in by_kind["attribute"]] == ["`settings.missing`"]  # `known`, `also` are defined; `run()` is a call; `os.path` is imported
    assert by_kind["except path"][0]["what"].startswith("handler for ValueError returning None: give work an input")
    assert by_kind["new parameter"][0]["what"].startswith("new function work(rows, settings, n, label)")
    assert by_kind["empty loop"][0]["what"] == "`for r in rows`: call work with rows empty and with one element; check the value the loop leaves behind (total)"
    assert [r["id"] for r in rows] == ["E%d" % i for i in range(1, len(rows) + 1)]
    assert rows[0]["kind"] in ("attribute", "except path")  # rank 0 first


def test_the_function_named_is_the_innermost_def_around_the_line(tmp_path: Path):
    # each file's functions are listed once and asked per line (a walk per node took 12 s on a langchain plan,
    # 2026-10-20); the rule stays: the def that starts last among those holding the line, the first in walk order on a tie
    tree, diff = _tree(tmp_path, {
        "pkg/nest.py": """
            LIMIT = 3 if len("ab") > 1 else 4


            def outer(rows, n):
                def inner(x):
                    return x / n
                total = sum(inner(r) for r in rows)
                return total > LIMIT
            """,
    })
    named = {(r["kind"], r["line"]): r["function"] for r in edges(diff, tree)}
    assert named[("zero divisor", 6)] == "inner"  # inside the nested def
    assert named[("boundary", 8)] == "outer"  # past the nested def's end, still inside outer
    assert named[("boundary", 1)] == "<module>"
    assert named[("new parameter", 4)] == "outer" and named[("new parameter", 5)] == "inner"  # a def's own line is inside it
    source = (tmp_path / "pkg" / "nest.py").read_text(encoding="utf-8")
    assert [breakable_line(source, lo, lo) for lo in (1, 5, 7, 8)] == [(1, None), (6, "inner"), (7, "outer"), (8, "outer")]
    a, b = ast.parse("def a():\n    pass\n").body[0], ast.parse("def b():\n    pass\n").body[0]  # both on lines 1-2: a tie
    assert function_at([a, b], 2) == "a" and function_at([b, a], 2) == "b"  # type: ignore[list-item]


def test_a_file_that_can_define_no_attribute_is_never_parsed(tmp_path: Path, monkeypatch):
    # the scan for attribute names keeps no tree and skips text without `class` and `self` (2026-10-20); a self.x store in
    # a function outside any class still defines x, and so does a fullwidth self, which only a non-ASCII text can hold
    tree, diff = _tree(tmp_path, {
        "pkg/work.py": """
            def work(settings):
                return settings.extra + settings.wide + settings.missing
            """,
    })
    texts = {
        "helpers.py": "def attach(self):\n    self.extra = 1\n",
        "wide.py": "def attach(ｓｅｌｆ):\n    ｓｅｌｆ.wide = 1\n",
        "plain.py": "def double(x):\n    return x * 2\n",
    }
    for name, text in texts.items():
        (tmp_path / "pkg" / name).write_text(text, encoding="utf-8")
    seen: list[str] = []
    parse = ast.parse

    def recording(source, *args, **kwargs):
        seen.append(source)
        return parse(source, *args, **kwargs)

    monkeypatch.setattr(ast, "parse", recording)
    rows = edges(diff, tree)
    assert [r["what"].split("`")[1] for r in rows if r["kind"] == "attribute"] == ["settings.missing"]
    assert texts["helpers.py"] in seen and texts["wide.py"] in seen
    assert texts["plain.py"] not in seen
