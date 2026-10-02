"""Instrumentation goldens: every statement kind, expression-coverage sites, docstrings, positions."""

from __future__ import annotations

import ast
import textwrap

import pytest

from pyokka_runtime.instrument import InstrumentOptions, instrument

EVERY_STATEMENT = '''
"""Module docstring."""
from __future__ import annotations
import os
from os import path as p
x = 1
x += 1
y: int = 2
z: int
del z
assert x, "msg"
pass
if x and y:
    pass
elif x or y:
    pass
else:
    pass
for i in range(2):
    continue
else:
    pass
while x < 3 < 4:
    x += 1
    break
with open(os.devnull) as fh, open(os.devnull) as g:
    pass
try:
    raise ValueError("a")
except (ValueError, TypeError) as exc:
    pass
else:
    pass
finally:
    pass
try:
    pass
except* ValueError:
    pass
def f(a, b=1, *args, c, d=2, **kw) -> int:
    """doc"""
    global x
    nonlocal_holder = 1
    def inner():
        nonlocal nonlocal_holder
        nonlocal_holder += 1
        return nonlocal_holder
    return inner()
async def af():
    async with open(os.devnull) as fh:
        pass
    async for i in agen():
        pass
    await agen().__anext__()
async def agen():
    yield 1
class C(object, metaclass=type):
    """class doc"""
    attr = [i for i in range(3) if i]
    def m(self):
        return {k: v for k, v in zip("ab", "cd")} , {i for i in (1, 2)}, (i for i in ())
match x:
    case 1 if x > 0:
        pass
    case [a, *rest]:
        pass
    case {"k": v}:
        pass
    case C(attr=1):
        pass
    case _:
        pass
lam = lambda q: q if q else 0
type Alias = list[int]
@staticmethod
def deco(): ...
print(f"{x!r:>4} {y=}")
'''


def test_every_statement_kind_compiles_and_unparses():
    info = instrument(EVERY_STATEMENT, "every.py")
    assert info.error is None, info.error
    assert info.code is not None
    src = info.instrumented_source
    assert src is not None
    # docstrings preserved and first
    assert src.startswith('"""Module docstring."""')
    assert "from __future__ import annotations" in src.splitlines()[1]
    assert "    def f(a, b=1, *args, c, d=2, **kw) -> int:\n" not in src  # not indented further
    assert '"""doc"""\n    _pk_scope_ = _pk_f(' in src
    assert '"""class doc"""\n    _pk_c(' in src  # class-body statements are coverage-only, no step
    # `type` alias value must not be rewritten (lazily evaluated)
    assert "type Alias = list[int]" in src
    # ids are in source order: ranges sorted by start
    starts = [(r[0], r[1]) for r in info.ranges]
    assert starts == sorted(starts)
    # module range is rid 0
    assert info.ranges[0][:2] == [1, 0]
    assert 0 not in info.statements


def test_step_hooks_never_before_docstring_or_future():
    info = instrument('"""doc"""\nfrom __future__ import annotations\nx = 1\n', "a.py")
    lines = info.instrumented_source.splitlines()
    assert lines[0] == '"""doc"""'
    assert lines[1] == "from __future__ import annotations"
    assert lines[2].startswith("_pk_s(")
    assert lines[3] == "x = 1"


def test_expression_coverage_sites():
    src = textwrap.dedent(
        """
        a = x and y or z
        b = 1 if c else 2
        d = [e for e in items if e for f in e if f]
        g = 1 < h < 3
        assert cond, "message"
        match m:
            case 1 if guard:
                pass
        h = {k: v for k in ks}
        """
    ).strip()
    info = instrument(src, "c.py")
    out = info.instrumented_source
    assert "x and (_pk_c(" in out and "[1] or (_pk_c(" in out
    assert "(_pk_c(" in out.split("b = ")[1]
    assert out.count("_pk_c(") >= 12
    # every coverage site is attributed to its statement for partial-coverage computation
    assert info.expr_children
    for stmt, children in info.expr_children.items():
        for c in children:
            assert info.ranges[stmt][0] <= info.ranges[c][0]
    # assert msg wrapped, guard wrapped
    assert 'assert cond, (_pk_c(' in out
    assert "case 1 if (_pk_c(" in out


def test_compound_statement_ranges_are_headers():
    src = "if x:\n    y = 1\n    z = 2\nfor i in range(3):\n    pass\n"
    info = instrument(src, "h.py")
    header_ranges = [r for r in info.ranges if r[0] == 1]
    assert [1, 0, 1, 4] in header_ranges  # `if x` header only
    for_ranges = [r for r in info.ranges if r[0] == 4]
    assert [4, 0, 4, 17] in for_ranges


def test_function_scope_wrapping_and_functions_table():
    src = "def f(a):\n    return a\n\nlam = lambda v: v * 2\n"
    info = instrument(src, "f.py")
    out = info.instrumented_source
    assert "_pk_scope_ = _pk_f(" in out and "finally:\n        _pk_x(_pk_scope_, _pk_rv_)" in out
    assert "return _pk_s" not in out
    names = {f["name"] for f in info.functions}
    assert names == {"f", "<lambda>"}
    fdef = next(f for f in info.functions if f["name"] == "f")
    assert fdef["bodyRange"] == [1, 0, 2, 12]
    assert "(_pk_f(" in out.split("lam = ")[1]


def test_statement_hooks_carry_scope_inside_functions_and_classes_in_functions():
    src = "def f():\n    class K:\n        a = 1\n    x = 1\n    return K\n"
    info = instrument(src, "s.py")
    out = info.instrumented_source
    assert out.count("_pk_scope_)") >= 2 and "_pk_x(_pk_scope_, _pk_rv_)" in out
    assert "class K:\n            _pk_c(" in out  # class-body statements are coverage-only, no step


def test_identifier_expression_statement_logs_value():
    info = instrument("x = 1\nx\n", "i.py")
    assert "_pk_v(" in info.instrumented_source
    assert "'x', x, 'value'" in info.instrumented_source


def test_print_rewrite():
    info = instrument("print('a', 1, sep='-')\n", "p.py")
    assert "_pk_print(" in info.instrumented_source
    assert "sep='-'" in info.instrumented_source


def test_inline_config_is_extracted_and_removed():
    info = instrument('{"autoLog": True, "logLimit": 3}\nx = 1\n', "cfg.py")
    assert info.inline_config == {"autoLog": True, "logLimit": 3}
    assert "autoLog" not in info.instrumented_source


def test_auto_log_kinds():
    info = instrument("x = 1\nx + 1\nprint(x)\ndef f():\n    return 2\n", "al.py", options=InstrumentOptions(auto_log=True))
    out = info.instrumented_source
    assert out.count("'autoLog'") == 3  # assignment, expression, return (print excluded)


def test_syntax_error_is_reported_not_raised():
    info = instrument("def (:\n", "bad.py")
    assert info.code is None
    assert info.error and "SyntaxError" in info.error
    assert info.error_line == 1


def test_ignore_hints():
    src = "a = 1\nb = 2  # pragma: no cover\nif a:  # ignore coverage\n    c = 3\nd = 4\n"
    info = instrument(src, "ig.py")
    ignored_lines = sorted(info.ranges[r][0] for r in info.ignored)
    assert ignored_lines == [2, 3, 4]
    assert all(info.ranges[s][0] in (1, 5) for s in info.statements)
    info2 = instrument("# ignore file coverage\nx = 1\n", "igf.py")
    assert info2.ignore_file


def test_positions_are_preserved_for_tracebacks():
    src = "x = 1\n\n\ndef boom():\n    raise ValueError('x')\n\nboom()\n"
    info = instrument(src, "tb.py")
    import builtins

    installed = {n: (lambda *a, **k: 0) for n in ("_pk_s", "_pk_c", "_pk_f", "_pk_x", "_pk_v", "_pk_t", "_pk_print", "_pk_logpoint", "_pk_time", "_pk_snap_error", "_pk_u", "_pk_end")}
    saved = {n: getattr(builtins, n, None) for n in installed}
    for n, fn in installed.items():
        setattr(builtins, n, fn)
    try:
        with pytest.raises(ValueError) as ei:
            exec(info.code, {"__name__": "__main__"})
    finally:
        for n, old in saved.items():
            if old is None:
                delattr(builtins, n)
            else:
                setattr(builtins, n, old)
    tb = ei.traceback
    assert tb[-1].lineno + 1 == 5  # pytest traceback entries are 0-based


def test_marker_value_covering_expression_and_exp_marker():
    src = "def f(a, b):\n    total = a + b\n    return total\nf(1, 2)\n"
    markers = [
        {"id": "m1", "kind": "value", "range": [2, 12, 2, 17], "context": "a + b", "changeId": "c1"},
        {"id": "m2", "kind": "value", "range": [2, 4, 2, 9], "exp": "total * 10"},
    ]
    info = instrument(src, "mk.py", options=InstrumentOptions(markers=markers))
    out = info.instrumented_source
    assert "'a + b', a + b, 'value', 'm1', 'c1'" in out
    assert "_pk_logpoint(" in out and "'total * 10'" in out


def test_logpoint_markers():
    src = "def f(a, b=2):\n    return a\nx = f(1)\ny = x + 1\n"
    markers = [
        {"id": "lp1", "kind": "logpoint", "range": [1, 0, 1, 0]},
        {"id": "lp2", "kind": "logpoint", "range": [3, 0, 3, 0], "logMessage": "x is {x} and {x + 1}"},
        {"id": "lp3", "kind": "logpoint", "range": [4, 0, 4, 0]},
    ]
    info = instrument(src, "lp.py", options=InstrumentOptions(markers=markers))
    out = info.instrumented_source
    assert info.def_logs  # def-line logpoint logs the parameters at entry
    assert "'x is {x} and {x + 1}'" in out
    assert "y = _pk_v(" in out and "'logpoint', 'lp3'" in out


def test_line_range_normalisation_does_not_break_compile():
    # Deeply nested / odd layouts that historically trigger "AST node line range" errors.
    src = "x = (\n    1\n    + 2\n)\nif (x\n    and x):\n    y = (lambda:\n        3)()\n"
    info = instrument(src, "lr.py")
    assert info.error is None and info.code is not None


def test_snaps_mode_extracts_fences():
    src = textwrap.dedent(
        '''
        def add(a, b):
            """{{
            add(1, 2)
            }}"""
            return a + b
        broken = 1 / 0
        """{{
        x = add(2, 3)
        x * 2
        }}"""
        '''
    )
    info = instrument(src, "sn.py", options=InstrumentOptions(mode="snaps"))
    assert info.error is None
    assert info.snaps == 2
    out = info.instrumented_source
    assert out.count("_pk_snap_error(_pk_e") >= 4
    # snap statements map onto the fenced lines of the original file
    snap_lines = {r[0] for r in info.ranges}
    assert {4, 9, 10} <= snap_lines


def test_instrumented_code_for_class_names_is_not_mangled():
    src = "class A:\n    def m(self):\n        return [i for i in range(3) if i]\nA().m()\n"
    info = instrument(src, "mg.py")
    names = {n.id for n in ast.walk(ast.parse(info.instrumented_source)) if isinstance(n, ast.Name)}
    assert not any(n.startswith("_A__") for n in names)
