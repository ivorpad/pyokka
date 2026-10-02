"""Library stepping: quiet imports, the compile cache, trace deltas, the step cap, on-demand source."""

from __future__ import annotations

import types

import pytest

from pyokka_runtime import cache, execute
from pyokka_runtime import tracer as tracer_mod
from pyokka_runtime.instrument import RELOC_BASE, InstrumentOptions, instrument, relocate
from pyokka_runtime.protocol import COV_COVERED, FLAG_SCOPE_ENTRY

LIB = {
    "venv/site-packages/libq/__init__.py": """
    CONST = 1
    def helper(x):
        y = x + CONST
        return y
    built = helper(1)
    class Model:
        field = helper(2)
    for _i in range(2):
        built += _i
    def gen():
        yield helper(3)
    """
}
SRC = """
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv', 'site-packages'))
import libq
r = libq.helper(10)
g = list(libq.gen())
"""


def test_import_time_execution_is_coverage_only(run):
    out = run(SRC, files=LIB, config={"libraryCode": True})
    lib = out.file(2)
    assert [s["name"] for s in out.trace["scopes"]] == ["<module>", "helper", "gen", "helper"]
    steps = out.steps
    lib_steps = [i for i, (rid, *_rest) in enumerate(steps) if rid >= lib["rangeBase"]]
    user_lines = [out.file(1)["ranges"][rid][0] for rid, *_rest in steps[: lib_steps[0]]]
    # the user's import (line 4) records no library step; the first library step follows `r = libq.helper(10)`
    assert user_lines == [2, 3, 4, 5]
    assert steps[lib_steps[0]][3] & FLAG_SCOPE_ENTRY
    # everything that ran at import time still counts as covered
    for line in (2, 3, 6, 7, 8, 9, 10):
        assert out.state_at(line, 2) == COV_COVERED, line
    assert "instrumentedSource" not in lib and lib["instrumentMs"] >= 0
    assert out.result.step_count == len(steps)


def test_library_files_are_cached_and_rebased(run, tmp_path, monkeypatch):
    seen: list[str] = []
    real = execute.Instrumenter

    class Counting(real):
        def run(self):
            seen.append(self.filename)
            return super().run()

    monkeypatch.setattr(execute, "Instrumenter", Counting)
    first = run(SRC, files=LIB, config={"libraryCode": True})
    entries = list((tmp_path / "pyokka-cache").glob("*.bin"))
    assert len(entries) == 1 and any(f.endswith("__init__.py") for f in seen)
    seen.clear()
    # a longer scratch gives the library file a different range base: the entry is rebased, not rewritten
    second = run("a = 1\nb = 2\n" + SRC, config={"libraryCode": True})
    assert not any(f.endswith("__init__.py") for f in seen)
    assert len(list((tmp_path / "pyokka-cache").glob("*.bin"))) == 1
    f1, f2 = first.file(2), second.file(2)
    assert f2["rangeBase"] > f1["rangeBase"]
    assert {k: v for k, v in f1.items() if k not in ("rangeBase", "instrumentMs")} == {k: v for k, v in f2.items() if k not in ("rangeBase", "instrumentMs")}
    assert [s["name"] for s in second.trace["scopes"]] == ["<module>", "helper", "gen", "helper"]
    lib_rids = [rid - f2["rangeBase"] for rid, *_rest in second.steps if rid >= f2["rangeBase"]]
    assert lib_rids == [rid - f1["rangeBase"] for rid, *_rest in first.steps if rid >= f1["rangeBase"]]
    cov1 = next(c for c in first.of("coverage") if c["fileId"] == 2)
    cov2 = next(c for c in second.of("coverage") if c["fileId"] == 2)
    assert cov1["states"] == cov2["states"] and cov1["hits"] == cov2["hits"]
    # an edited library file is a different entry
    path = tmp_path / "venv/site-packages/libq/__init__.py"
    path.write_text(path.read_text() + "\nEXTRA = 2\n")
    run(SRC, files={}, config={"libraryCode": True})
    assert len(list((tmp_path / "pyokka-cache").glob("*.bin"))) == 2


def test_cache_can_be_disabled_and_survives_garbage(run, tmp_path, monkeypatch):
    monkeypatch.setenv("PYOKKA_CACHE_DIR", "")
    assert cache.cache_dir() is None
    run(SRC, files=LIB, config={"libraryCode": True})
    assert not (tmp_path / "pyokka-cache").exists()
    monkeypatch.setenv("PYOKKA_CACHE_DIR", str(tmp_path / "pyokka-cache"))
    out = run(SRC, files=LIB, config={"libraryCode": True})
    (entry,) = list((tmp_path / "pyokka-cache").glob("*.bin"))
    entry.write_bytes(b"not marshal")
    again = run(SRC, config={"libraryCode": True})
    assert again.trace["scopes"] == out.trace["scopes"]
    assert entry.stat().st_size > 20  # rewritten


def _ints(code: types.CodeType) -> list[int]:
    out = []
    for c in code.co_consts:
        if isinstance(c, types.CodeType):
            out.extend(_ints(c))
        elif type(c) is int:
            out.append(c)
    return sorted(out)


def test_relocatable_code_matches_a_direct_compile():
    src = "x = 1\nfor i in range(3):\n    x += i\ndef f(a):\n    return (lambda b: b + 2)(a)\nf(x)\nprint(x)\n"
    direct = instrument(src, "m.py", 1, 500, InstrumentOptions()).code
    info = instrument(src, "m.py", 1, 500, InstrumentOptions(relocatable=True))
    assert info.relocatable is not None and info.relocatable[1]
    assert _ints(info.code) == _ints(direct)
    moved = relocate(info.relocatable[0], info.relocatable[1], 900 - RELOC_BASE)
    assert _ints(moved) == _ints(instrument(src, "m.py", 1, 900, InstrumentOptions()).code)
    assert RELOC_BASE not in _ints(info.instrumented_source and info.code)


def test_relocation_gives_up_on_a_colliding_constant():
    src = "K = %d\nx = K + 1\n" % (RELOC_BASE + 1)  # equals the sentinel of the first statement's rid
    info = instrument(src, "m.py", 1, 7, InstrumentOptions(relocatable=True))
    assert info.relocatable is None and info.code is not None and info.error is None
    ints = _ints(info.code)
    assert RELOC_BASE + 1 in ints and 8 in ints


def test_partial_trace_deltas_carry_only_new_scopes(run, monkeypatch):
    monkeypatch.setattr(tracer_mod, "TRACE_FLUSH_S", 0.0)
    out = run("def f(i):\n    return i\nfor i in range(3000):\n    f(i)\n")
    partials = [e for e in out.of("trace") if e.get("partial")]
    assert len(partials) >= 2 and partials[0]["offset"] == 0
    ids = [s["scopeId"] for e in partials for s in e["scopes"]]
    assert ids == sorted(ids) and len(ids) == len(set(ids))
    final = {s["scopeId"] for s in out.trace["scopes"]}
    assert set(ids) <= final and 0 in ids


def test_no_scopes_are_created_past_the_cap(run):
    out = run("def f(i):\n    return i\nfor i in range(100):\n    f(i)\n", config={"maxTraceSteps": 20})
    assert out.trace["truncated"] and len(out.steps) == 20
    scopes = out.trace["scopes"]
    assert 1 < len(scopes) <= 8 and all(s["first"] < 20 and s["last"] < 20 for s in scopes)
    assert out.result.step_count > 20


def test_instrumented_source_on_demand(run):
    out = run(SRC, files=LIB, config={"libraryCode": True})
    ex = out.execution
    assert ex.instrumented_source(1) == out.file(1)["instrumentedSource"]
    text = ex.instrumented_source(2)
    assert "_pk_c(" in text and "_pk_f(" in text and "_pk_s(" in text
    with pytest.raises(LookupError):
        ex.instrumented_source(9)


def test_cache_status_and_clear_touch_only_entries(run, tmp_path):
    directory = tmp_path / "pyokka-cache"
    assert cache.status() == {"dir": str(directory), "entries": 0, "bytes": 0}  # missing directory: empty
    run(SRC, files=LIB, config={"libraryCode": True})
    (entry,) = list(directory.glob("*.bin"))
    (directory / ".tmp-left.bin").write_bytes(b"x" * 10)
    (directory / "notes.txt").write_text("keep")
    (directory / "sub.bin").mkdir()
    (directory / "sub.bin" / "inner.bin").write_bytes(b"y")
    st = cache.status()
    assert st["entries"] == 2 and st["bytes"] == entry.stat().st_size + 10
    assert cache.clear() == {"dir": str(directory), "removed": 2, "bytes": st["bytes"], "failed": 0}
    assert sorted(p.name for p in directory.iterdir()) == ["notes.txt", "sub.bin"]
    assert (directory / "sub.bin" / "inner.bin").exists()
    assert cache.clear() == {"dir": str(directory), "removed": 0, "bytes": 0, "failed": 0}
    # the next run is a miss that rewrites the entry
    run(SRC, config={"libraryCode": True})
    assert len([p for p in directory.glob("*.bin") if p.is_file()]) == 1


def test_cache_status_and_clear_when_off(monkeypatch):
    monkeypatch.setenv("PYOKKA_CACHE_DIR", "")
    assert cache.status() == {"dir": None, "entries": 0, "bytes": 0}
    assert cache.clear() == {"dir": None, "removed": 0, "bytes": 0, "failed": 0}
