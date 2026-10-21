"""Which argument a call passed for a parameter (``parameter_argument`` in bindings.py), over call shapes.

The cases and the answers are written to ``test/unit/fixtures/parameter-argument.json``, which
``test/unit/parameterArgument.test.ts`` reads so the TypeScript twin gives the same answers.
Regenerate with PYOKKA_WRITE_FIXTURES=1.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from pyokka_runtime.bindings import parameter_argument, statement_bindings

FIXTURE = Path(__file__).resolve().parents[2] / "test" / "unit" / "fixtures" / "parameter-argument.json"

DEFS = '''
class C:
    def __init__(self, a, b=2): pass
    def m(self, x, *rest, k=0, **kw): pass
    @classmethod
    def mk(cls, v): pass
    @staticmethod
    def st(p, q): pass
    def one(self, x): pass
    def __new__(cls, a, b=2): pass
    @property
    def size(self): pass
def f(a, b, /, c, *, d): pass
def g(*args, **kwargs): pass
def h(x, y=1, *, z): pass
def f1(v): pass
'''
SCOPES = {"__init__": 3, "m": 4, "mk": 6, "st": 8, "one": 9, "__new__": 10, "size": 12, "f": 13, "g": 14, "h": 15, "f1": 16}


def case(call, scope, name, want, values=None, made=None, index=0, entered=1):
    """``values``: the recorded text of names at the call site; ``made``: the class the new object's text names."""
    return {"call": call, "scope": scope, "name": name, "want": want, "values": values or {}, "made": made, "index": index, "entered": entered}


def cls(name):
    return "<class 'mod.%s'>" % name


CASES = [
    case("C(x, y)", "__init__", "a", "x"),
    case("C(x, y)", "__init__", "self", None),  # the object being made: no argument names it
    case("C(x)", "__init__", "b", None),  # left to its default
    case("super().__init__(q)", "__init__", "a", "q"),
    case("C.__init__(o, q)", "__init__", "self", "o"),  # through the class, self is passed
    case("C.__init__(o, q)", "__init__", "a", "q"),
    case("Sub(x)", "__init__", "a", "x", {"Sub": cls("Sub")}, "Sub"),  # a subclass that inherits __init__
    case("Sub(x)", "__init__", "a", None, {"Sub": cls("Sub")}, "Other"),  # the object made is another class's: not this call
    case("Sub(x)", "__init__", "a", None, {"Sub": cls("Sub")}),  # no recorded object to say which class
    case("kind(x)", "__init__", "a", "x", {"kind": cls("Sub")}, "Sub"),  # a class kept in a variable
    case("C(x)", "__new__", "a", "x"),
    case("C(x)", "__new__", "cls", "C"),
    case("C.__new__(k, x)", "__new__", "cls", "k"),  # called as a function: the class is passed
    case("C.__new__(k, x)", "__new__", "a", "x"),
    case("super().__new__(cls, x)", "__new__", "a", "x"),
    case("n = o.size + 1", "size", "self", "o"),  # a property's getter: entered by loading the attribute
    case("n = o.size + p.size", "size", "self", "p", index=1, entered=2),
    case("n = o.size()", "size", "self", None),  # the getter runs, then its value is called: no load names it alone
    case("o.m(1, 2, 3, k=4, z=5)", "m", "self", "o"),
    case("o.m(1, 2, 3, k=4, z=5)", "m", "x", "1"),
    case("o.m(1, 2, 3, k=4, z=5)", "m", "rest", "2, 3"),
    case("o.m(1, 2, 3, k=4, z=5)", "m", "k", "4"),
    case("o.m(1, 2, 3, k=4, z=5)", "m", "kw", "z=5"),
    case("o.m(x=[i for i in items])", "m", "x", "[i for i in items]"),
    case("C.m(o, 1)", "m", "self", "o"),  # through the class: the arguments start at self
    case("C.m(o, 1)", "m", "x", "1"),
    case("mod.C.m(o, 1)", "m", "x", "1"),
    case("L.m(o, 1)", "m", "x", "1", {"L": cls("C")}),  # an alias of the class, known from the recorded value of L
    case("L.one(o, 1)", "one", "x", None),  # an alias not known as a class: the arguments do not fit a bound call
    case("C.mk(9)", "mk", "v", "9"),
    case("C.mk(9)", "mk", "cls", "C"),
    case("C.st(1, 2)", "st", "q", "2"),
    case("o.st(1, 2)", "st", "p", "1"),
    case("m(o, 1)", "m", "x", None),  # a method called by a bare name
    # a function kept in a variable, known from its recorded value
    case("r = conv(s)", "f1", "v", "s", {"conv": "<function f1 at 0x1>"}),
    case("r = conv(s)", "f1", "v", None, {"conv": "<function other at 0x1>"}),
    case("p(o, 1)", "m", "self", "o", {"p": "<function C.m at 0x1>"}),  # unbound: self is passed
    case("p(1)", "m", "x", "1", {"p": "<bound method C.m of <mod.C object at 0x2>>"}),  # bound: self is the method's
    case("p(1)", "m", "self", None, {"p": "<bound method C.m of <mod.C object at 0x2>>"}),
    case("f(1, 2, 3, d=4)", "f", "c", "3"),
    case("f(1, 2, c=3, d=4)", "f", "c", "3"),
    case("f(1, 2, 3)", "f", "a", None),  # d is required: Python would refuse this call
    case("f(*xs, d=1)", "f", "a", None),
    case("f(*xs, d=1)", "f", "d", "1"),
    case("g(a, b)", "g", "args", "a, b"),
    case("g(a, *b)", "g", "args", None),
    case("g(k=a, j=b)", "g", "kwargs", "k=a, j=b"),
    case("g(**opts)", "g", "kwargs", None),
    case("h(v, z=w)", "h", "x", "v"),
    case("h(v, z=w)", "h", "y", None),
    case("h(v)", "h", "x", None),  # z has no default
    case("h(v, q=1, z=2)", "h", "x", None),  # q is no parameter
    case("total = h(a + b * 2, z=n)", "h", "x", "a + b * 2"),
    # one function entered twice from a statement: told apart by the order Python runs the calls
    case("same = g2(f1(p), f1(q))", "f1", "v", "p", index=0, entered=2),
    case("same = g2(f1(p), f1(q))", "f1", "v", "q", index=1, entered=2),
    case("nested = f1(f1(2))", "f1", "v", "2", index=0, entered=2),
    case("nested = f1(f1(2))", "f1", "v", "f1(2)", index=1, entered=2),
    case("x = f1(p) if c else f1(q)", "f1", "v", None),  # a branch: which call ran is not in the source
    case("x = f1(p) + f1(q)", "f1", "v", None),  # entered once for two calls: something else happened
    case("y = f1(x)", "f1", "v", None, index=1, entered=2),  # entered twice for one call: once by something else (map(f1, ...) of the loop)
    case("rows = sorted(rs, key=f1)", "f1", "v", None, index=0, entered=2),  # entered by sorted, with arguments no call shows
    case("rows = sorted(rs, key=f1) + [f1(r)]", "f1", "v", None, index=0, entered=3),
    case("rows = list(map(self.f1, rs)) + [f1(r)]", "f1", "v", None, index=0, entered=3),
    case("rows = [f1(r) for r in rs]", "f1", "v", "r", index=2, entered=3),  # one call in a comprehension, entered once per item
    case("rows = sorted(rs, key=lambda r: f1(r))", "f1", "v", "r", index=0, entered=2),
    case("both = [f1(a) for a in xs] + [f1(b)]", "f1", "v", None, index=0, entered=3),
    case("t = sum(f1(n) for d, n in items)", "f1", "v", "n", index=1, entered=3),
    case("rows = sorted(rs, key=lambda r: f1(r + base))", "f1", "v", "r + base", index=0, entered=2),  # repeats and a single call: no count tells them apart
]


def answers() -> dict:
    by_line = {b["line"]: b["params"] for b in statement_bindings(DEFS) if b.get("params")}
    out = []
    for c in CASES:
        params = by_line[SCOPES[c["scope"]]]
        args = statement_bindings(c["call"])[0].get("args") or []
        got = parameter_argument(c["name"], c["scope"], params, args, c["values"].get, c["made"], c["index"], c["entered"])
        out.append({**{k: v for k, v in c.items() if k != "want"}, "params": params, "args": args, "argument": got})
    return {"cases": out}


def test_each_call_shape_binds_the_parameter_python_would():
    got = answers()
    assert [(c["call"], c["name"], c["argument"] and c["argument"]["text"]) for c in got["cases"]] == [(c["call"], c["name"], c["want"]) for c in CASES]


def test_an_argument_lists_the_names_it_loads():
    by = {(c["call"], c["name"]): c["argument"] for c in answers()["cases"]}
    assert by[("total = h(a + b * 2, z=n)", "x")]["names"] == ["a", "b"]
    assert by[("o.m(x=[i for i in items])", "x")]["names"] == ["items"]  # the comprehension's i is its own
    assert by[("g(a, b)", "args")]["names"] == ["a", "b"]
    assert by[("t = sum(f1(n) for d, n in items)", "v")] == {"text": "n", "names": []}  # n is the comprehension's
    assert by[("rows = sorted(rs, key=lambda r: f1(r + base))", "v")]["names"] == ["base"]


def test_the_typescript_twin_reads_the_same_cases():
    doc = answers()
    if os.environ.get("PYOKKA_WRITE_FIXTURES"):
        FIXTURE.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    assert doc == json.loads(FIXTURE.read_text(encoding="utf-8"))
