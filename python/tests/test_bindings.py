"""Statement bindings from the AST: what each statement assigns and reads, positions, loops, matching."""

from __future__ import annotations

import textwrap

import pytest

from pyokka_runtime.bindings import index_bindings, matches_name, statement_bindings

SRC = textwrap.dedent(
    '''
    import os, sys as system
    from dateutil import parser

    def greet(name, *rest, punct="!", **kw):
        msg = "hello " + name
        return msg.upper()

    class Account:
        def deposit(self, amount):
            self.balance += amount
            return self.balance

    acct = Account()
    total, count = 0, 0
    for i in range(3):
        total += acct.deposit(i)
    with open(__file__) as fh:
        first = fh.readline()
    if (n := len(first)) > 10:
        print(n)
    squares = [x * x for x in range(4)]
    handler = lambda ev: ev.name
    acct.items[0] = squares
    del squares
    '''
).lstrip()


def by_line(entries: list[dict]) -> dict[int, dict]:
    return {e["line"]: e for e in entries}


def test_assigns_and_reads_per_statement():
    b = by_line(statement_bindings(SRC))
    assert b[1]["assigns"] == ["os", "system"] and b[1]["reads"] == []
    assert b[2]["assigns"] == ["parser"]
    # def: the parameters (bound when a call enters), nothing read
    assert b[4]["assigns"] == ["name", "rest", "punct", "kw"] and b[4]["reads"] == []
    assert b[5] == {"line": 5, "col": 4, "assigns": ["msg"], "reads": ["name"]}
    assert b[6]["assigns"] == [] and b[6]["reads"] == ["msg"]
    assert b[9]["assigns"] == ["self", "amount"]
    # augmented assignment reads its target's root and its value
    assert b[10]["assigns"] == ["self.balance"] and b[10]["reads"] == ["self", "amount"]
    assert b[13]["assigns"] == ["acct"] and b[13]["reads"] == ["Account"]
    assert b[14]["assigns"] == ["total", "count"]
    assert b[16]["assigns"] == ["total"] and b[16]["reads"] == ["total", "acct", "i"]
    assert b[17]["assigns"] == ["fh"] and b[17]["reads"] == ["__file__"]
    assert b[18]["assigns"] == ["first"] and b[18]["reads"] == ["fh"]
    # walrus binds in the header; builtins (len, print) are never reads
    assert b[19]["assigns"] == ["n"] and b[19]["reads"] == ["first"]
    assert b[20]["assigns"] == [] and b[20]["reads"] == ["n"]
    # comprehension variables and lambda parameters are not reads
    assert b[21]["assigns"] == ["squares"] and b[21]["reads"] == []
    assert b[22]["assigns"] == ["handler"] and b[22]["reads"] == []
    # a subscript store binds the container path
    assert b[23]["assigns"] == ["acct.items"] and b[23]["reads"] == ["acct", "squares"]
    assert 24 not in b  # del binds nothing and reads nothing we track
    assert 8 not in b  # a class statement is never a step


def test_calls_are_the_header_call_texts():
    b = by_line(statement_bindings(SRC))
    assert b[6]["calls"] == ["msg.upper()"] and b[13]["calls"] == ["Account()"] and b[16]["calls"] == ["acct.deposit(i)"]
    assert b[15]["calls"] == ["range(3)"] and b[17]["calls"] == ["open(__file__)"] and b[18]["calls"] == ["fh.readline()"]
    assert b[19]["calls"] == ["len(first)"] and b[20]["calls"] == ["print(n)"] and b[21]["calls"] == ["range(4)"]
    assert all("calls" not in b[line] for line in (1, 2, 4, 5, 9, 14, 22))
    src = textwrap.dedent(
        '''
        total = sum(a.balance for a in [acct, Account("guest", 5)])
        label = helper.describe(total,
                                os.sep)
        twice = f(x) + f(x)
        many = g(a0(), a1(), a2(), a3(), a4(), a5(), a6(), a7(), a8())
        long = fn("%s")
        @decorate(1)
        def h(p=default(2)):
            return p
        class K(Base(3)):
            pass
        print("hello")
        '''
        % ("x" * 90)
    ).lstrip()
    b = by_line(statement_bindings(src))
    # outermost first, a call split over lines collapsed, duplicates dropped, at most 8, at most 80 characters
    assert b[1]["calls"] == ['sum(a.balance for a in [acct, Account("guest", 5)])', 'Account("guest", 5)']
    assert b[2]["calls"] == ["helper.describe(total, os.sep)"]
    assert b[4]["calls"] == ["f(x)"]
    assert b[5]["calls"] == ["g(a0(), a1(), a2(), a3(), a4(), a5(), a6(), a7(), a8())", "a0()", "a1()", "a2()", "a3()", "a4()", "a5()", "a6()"]
    assert len(b[6]["calls"][0]) == 80 and b[6]["calls"][0].endswith("…")
    # def and class statements make no call at a step (decorators and defaults run when the definition executes)
    assert "calls" not in b[8] and 7 not in b and 10 not in b
    # a statement with only a call is listed for it
    assert b[12] == {"line": 12, "col": 0, "assigns": [], "reads": [], "calls": ['print("hello")']}


def test_loops_carry_their_last_line():
    b = by_line(statement_bindings(SRC))
    assert b[15]["assigns"] == ["i"] and b[15]["reads"] == [] and b[15]["loop"] == 16
    assert "loop" not in b[17]
    w = by_line(statement_bindings("k = 0\nwhile k < 3:\n    k += 1\n    x = k\n"))
    assert w[2]["loop"] == 4 and w[2]["reads"] == ["k"]


def test_positions_follow_the_ast_and_syntax_errors_raise():
    b = statement_bindings("if True:\n    a = 1\nelse:\n    b = 2\n")
    assert [(e["line"], e["col"]) for e in b] == [(2, 4), (4, 4)]
    with pytest.raises(SyntaxError):
        statement_bindings("def (:\n")


def test_matches_name_rule():
    assert matches_name("acct", "acct")
    assert matches_name("acct.deposit(amount)", "acct")
    assert matches_name("acct[0]", "acct")
    assert matches_name("self", "self.balance")
    assert matches_name("self.balance", "self")
    assert not matches_name("account", "acct")
    assert not matches_name("acct_total", "acct")
    assert not matches_name("", "acct") and not matches_name("acct", "")


def test_index_bindings_maps_positions_to_global_range_ids():
    entries = [{"line": 1, "col": 0, "assigns": ["a"], "reads": []}, {"line": 2, "col": 0, "assigns": ["b"], "reads": ["a"]}, {"line": 9, "col": 0, "assigns": ["z"], "reads": []}]
    ranges = [[1, 0, 2, 5], [1, 0, 1, 5], [2, 0, 2, 5], [2, 0, 2, 1]]  # 0: module, 1: `a = 1`, 2: `b = a`, 3: an expression child at the same start as 2
    table = index_bindings(entries, ranges, statements=[1, 2], function_rids=[], range_base=100)
    assert table == {101: entries[0], 102: entries[1]}
    # a def header (functions[].rid) is addressable; a statement at the same position wins
    table = index_bindings([{"line": 1, "col": 0, "assigns": ["x"], "reads": []}], [[1, 0, 1, 9], [1, 0, 3, 0]], statements=[0], function_rids=[1], range_base=0)
    assert list(table) == [0]
