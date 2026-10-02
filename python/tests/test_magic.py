"""Magic comment grammar and attachment by containment."""

from __future__ import annotations

import textwrap

from pyokka_runtime.instrument import instrument
from pyokka_runtime.magic import Comment, find_magic, scan_comments


def kinds(src: str) -> list[tuple[int, str]]:
    info = instrument(textwrap.dedent(src), "m.py")
    assert info.error is None, info.error
    return sorted((info.ranges[m["rid"]][0], m["kind"]) for m in info.magic)


def test_grammar_suffixes():
    comments = [Comment(i + 1, 0, t) for i, t in enumerate(["# ?", "#?", "# ?+", "# ? .", "# ?.+", "# ?+ .", "# ?..", "# ? $.upper()", "# ? not an expr ###", "# question?", "# ?+ $ * 2"])]
    found = {m.line: (m.kind, m.code_text) for m in find_magic(comments)}
    assert found[1] == ("value", None)
    assert found[2] == ("value", None)
    assert found[3] == ("autoExpand", None)
    assert found[4] == ("time", None)
    assert found[5] == ("timeAutoExpand", None)
    assert found[6] == ("timeAutoExpand", None)
    assert 7 not in found
    assert found[8] == ("value", "$.upper()")
    assert 9 not in found
    assert 10 not in found
    assert found[11] == ("autoExpand", "$ * 2")


def test_comments_inside_strings_are_ignored():
    assert scan_comments('s = "# ? not a comment"\n') == []
    assert kinds('s = "# ?"\n') == []


def test_attach_simple_statements():
    src = """
    x = 1  # ?
    x  # ?+
    y = (1 +
         2)  # ?.
    """
    assert kinds(src) == [(2, "value"), (3, "autoExpand"), (4, "time")]


def test_attach_mid_chain_expression_on_continuation_line():
    src = """
    result = (
        "abc"
        .upper()  # ?
        .lower()
    )
    """
    info = instrument(textwrap.dedent(src), "chain.py")
    m = info.magic[0]
    assert info.ranges[m["rid"]] == [3, 4, 4, 12]  # "abc"\n.upper()
    assert "_pk_v(" in info.instrumented_source and ".lower()" in info.instrumented_source.split("_pk_v(")[1]


def test_attach_compound_headers_and_for_target():
    src = """
    for i in range(3):  # ?
        pass
    if i:  # ?
        pass
    def f(a):  # ?
        return a
    class K:  # ?
        pass
    """
    info = instrument(textwrap.dedent(src), "cmp.py")
    out = info.instrumented_source
    assert "'i', i, 'value'" in out  # for target logged per iteration inside the body
    assert "if _pk_v(" in out
    assert info.def_logs  # def header -> parameters at entry
    assert "'K', K, 'value'" in out
    assert sorted(info.ranges[m["rid"]][0] for m in info.magic) == [2, 4, 6, 8]


def test_assignment_return_and_augassign_logging_shapes():
    src = """
    def f(v):
        v += 1  # ?
        return v * 2  # ?
    a, b = 1, 2  # ?
    """
    out = instrument(textwrap.dedent(src), "asg.py").instrumented_source
    assert "v += 1\n" in out and "_pk_v(" in out.split("v += 1\n")[1].splitlines()[0]
    assert "return (_pk_rv_ := _pk_v(" in out
    assert "a, b = _pk_v(" in out and "'a, b'" in out


def test_dollar_code_becomes_lambda():
    out = instrument("name = 'abc'  # ? $.upper()\n", "d.py").instrumented_source
    assert "lambda _pk_d: _pk_d.upper()" in out


def test_comment_with_nothing_to_attach_is_ignored():
    info = instrument("x = 1\n# ?\nelse_ = 2\n", "n.py")
    assert info.magic == []
    assert info.warnings
