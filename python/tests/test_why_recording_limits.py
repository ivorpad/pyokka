"""What `why` gets wrong because the recording infers reads and writes, one case per known limit.

Reads come from the statement's source (`bindings.read_names`) and writes from comparing snapshots of the
frame's locals, taken by the hook before each statement, on `(id(value), len(value))`
(`tracer._record_locals`). Each case below is a program where that inference gives a wrong `why`, checked
on the `run --save` recording. They are `xfail(strict=True)`: the fix that makes one pass also has to drop
its marker. The short-circuit case passes both ways: the exact run records the loads, and the snapshot run
labels the source-parsed read `inferred`. The four that `run --exact` (`exacttrace.py`) fixes run both ways, and the exact run must pass. The fixes, in order: a hook after each statement (timing), exact writes for the statements
that mutate a target (`x[k] =`, `x.attr =`, `x +=`, `del x[k]`, `x.m(...)`), a `defined` link on a recorded
function or class (`defsite.py`, both recordings), `exact`/`inferred` on each read, and following an object by `id` across names.
"""

from __future__ import annotations

import io
import textwrap
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from pyokka_runtime.__main__ import main
from pyokka_runtime.agent.source import SavedRun


def record(tmp_path: Path, source: str | dict[str, str], exact: bool = False) -> SavedRun:
    """Record ``source`` (one program, or ``{file name: source}`` whose first file is the one run)."""
    files = source if isinstance(source, dict) else {"probe.py": source}
    for name, text in files.items():
        (tmp_path / name).write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")
    program = tmp_path / next(iter(files))
    saved = tmp_path / "run.json"
    with redirect_stdout(io.StringIO()):
        assert main(["run", str(program), "--save", str(saved), *(["--exact"] if exact else [])]) == 0
    return SavedRun(str(saved))


def steps_on(run: SavedRun, line: int, file: str | None = None) -> list[int]:
    """The steps of ``line`` (in ``file``, a base name, when the run has more than one file)."""
    out = []
    for s in range(run.trace.count):
        loc = run.trace.location(s)
        if loc and loc[1][0] == line and (file is None or Path(run.file_path(loc[0]) or "").name == file):
            out.append(s)
    return out


def nodes(tree: dict) -> list[dict]:
    out, todo = [], [tree["root"]]
    while todo:
        n = todo.pop(0)
        out.append(n)
        todo.extend(n.get("reads") or [])
    return out


def read(run: SavedRun, line: int, name: str, of: str) -> dict:
    """The read of ``of`` under the value ``name`` made on ``line`` (its first step there)."""
    tree = run.why(steps_on(run, line)[0], name)
    return next(n for n in tree["root"].get("reads") or [] if n.get("name") == of)


def EXACT_FIXES(reason: str):
    """The case as the default recording gets it (expected to fail, for ``reason``) and with ``run --exact`` (it must pass)."""
    return pytest.mark.parametrize("exact", [pytest.param(False, id="snapshot", marks=pytest.mark.xfail(strict=True, reason=reason)), pytest.param(True, id="exact")])


MUTATIONS = """
def run():
    prices = {"a": 1, "b": 2}
    prices["a"] = 10
    qty = 3
    qty = 3
    orders = []
    orders.append("x")
    alias = orders
    alias.append("y")
    total = prices["a"] * qty
    return total, orders


print(run())
"""


@EXACT_FIXES("exact writes: `prices['a'] = 10` keeps id and len, so the snapshot keeps the old text")
def test_a_change_in_place_is_the_value_why_shows(tmp_path, exact):
    run = record(tmp_path, MUTATIONS, exact)
    prices = read(run, 10, "total", "prices")
    assert prices.get("text") == "{'a': 10, 'b': 2}", "why total = 30 must not show prices['a'] as 1"
    assert prices.get("line") == 3


@EXACT_FIXES("reads resolve to the first change of a value written twice, not the latest write")
def test_a_rewrite_with_the_same_value_is_the_write_why_credits(tmp_path, exact):
    run = record(tmp_path, MUTATIONS, exact)
    assert read(run, 10, "total", "qty").get("line") == 5


@EXACT_FIXES("timing: the snapshot before line 8 is where line 7's append shows")
def test_an_append_is_credited_to_its_own_line(tmp_path, exact):
    run = record(tmp_path, MUTATIONS, exact)
    lines = [c["line"] for c in run.var("orders")["changes"]]
    assert 7 in lines and 8 not in lines


@EXACT_FIXES("timing and objects: a change through `alias` shows on the next line, with that line's reads")
def test_a_change_through_another_name_is_credited_to_that_line(tmp_path, exact):
    run = record(tmp_path, MUTATIONS, exact)
    changes = run.var("orders")["changes"]
    last = changes[-1]
    assert last["line"] == 9
    assert [r.get("name") for r in last.get("reads") or []] in ([], ["alias"])


BOTH = pytest.mark.parametrize("exact", [False, True], ids=["snapshot", "exact"])


@BOTH
def test_a_called_function_links_to_its_def(tmp_path, exact):
    run = record(tmp_path, """
    def discount(total):
        return total * 0.5


    def checkout(total):
        paid = discount(total)
        return paid


    print(checkout(55))
    """, exact)
    fn = read(run, 6, "paid", "discount")
    assert fn.get("line") == 1, "the read of discount names the def that bound it"
    assert fn.get("text", "").startswith("<function discount") and fn.get("defined") and "step" not in fn


@BOTH
def test_a_decorated_function_links_to_its_own_def_not_the_wrapper(tmp_path, exact):
    run = record(tmp_path, """
    import functools


    def logged(fn):
        @functools.wraps(fn)
        def wrapper(*args):
            return fn(*args)
        return wrapper


    @logged
    def tax(total):
        return total * 0.1


    def checkout(total):
        extra = tax(total)
        return extra


    print(checkout(55))
    """, exact)
    fn = read(run, 17, "extra", "tax")
    assert fn.get("line") == 11, "the link is tax's definition (its decorator line, as co_firstlineno counts), not wrapper's at line 5"


@BOTH
def test_a_class_instantiated_in_a_function_links_to_its_class_statement(tmp_path, exact):
    run = record(tmp_path, """
    class Order:
        def __init__(self, total):
            self.total = total


    def checkout(total):
        order = Order(total)
        return order.total


    print(checkout(55))
    """, exact)
    cls = read(run, 7, "order", "Order")
    assert cls.get("text", "").startswith("<class ") and cls.get("defined") and cls.get("line") == 1
    assert [c["text"].startswith("<class ") for c in run.var("Order")["changes"]] == [True], "one row in var Order"


SHORT_CIRCUIT = """
def label(tier, fallback):
    name = tier or fallback
    return name


print(label("gold", "none"))
"""


@pytest.mark.parametrize("exact", [pytest.param(False, id="snapshot"), pytest.param(True, id="exact")])
def test_a_short_circuited_name_is_not_a_plain_read(tmp_path, exact):
    """The snapshot recording still lists `fallback` from the source, labelled ``inferred``; the exact one records the loads."""
    run = record(tmp_path, SHORT_CIRCUIT, exact)
    tree = run.why(steps_on(run, 2)[0], "name")
    fallback = [n for n in tree["root"].get("reads") or [] if n.get("name") == "fallback"]
    assert not fallback or fallback[0].get("resolution") == "inferred"


def test_the_exact_tree_lists_only_the_operands_that_ran(tmp_path):
    """`tier or fallback` with a truthy tier never loads fallback: the exact tree reads tier alone, and says how
    each node is known (the parameter is not made by a step, so it is inferred). Only that mix gets a marker."""
    run = record(tmp_path, SHORT_CIRCUIT, exact=True)
    step = steps_on(run, 2)[0]
    tree = run.why(step, "name")
    assert tree["root"]["resolution"] == "exact"
    assert [(n["name"], n.get("resolution")) for n in tree["root"]["reads"]] == [("tier", "inferred")]
    assert [r["name"] for r in run.var("name")["changes"][0]["reads"]] == ["tier"]
    with redirect_stdout(io.StringIO()) as out:
        assert main(["why", str(tmp_path / "run.json"), str(step), "name"]) == 0
    assert "  ← tier = 'gold'  (inferred)   #" in out.getvalue()
    snapshot = record(tmp_path, SHORT_CIRCUIT)
    with redirect_stdout(io.StringIO()) as out:
        assert main(["why", str(tmp_path / "run.json"), str(steps_on(snapshot, 2)[0]), "name"]) == 0
    assert "(inferred)" not in out.getvalue() and "← fallback = 'none'" in out.getvalue()


@EXACT_FIXES("objects by id: the shared default list is changed by the second call, which why never reaches")
def test_a_shared_default_list_leads_to_the_call_that_changed_it(tmp_path, exact):
    run = record(tmp_path, """
    def add_tag(tag, tags=[]):
        tags.append(tag)
        return tags


    a = {"name": "ana", "tags": add_tag("admin")}
    b = {"name": "bo", "tags": add_tag("guest")}
    shown = a["tags"]
    print(shown)
    """, exact)
    second_append = steps_on(run, 2)[1]
    tree = run.why(steps_on(run, 8)[0], "shown")
    assert any(n.get("step") == second_append for n in nodes(tree)), "shown = ['admin', 'guest'] is explained by bo's append"


ORDERS = {
    "main.py": """
    from billing import Ledger
    from catalog import new_order
    from promo import bulk_bonus


    def main():
        ledger = Ledger()
        ana = new_order("ana")
        bo = new_order("bo")
        bulk_bonus(ana)  # only ana gets the bonus
        ledger.charge(ana)
        bill = ledger.charge(bo)
        print("bo pays", bill, "ledger", ledger.totals)


    main()
    """,
    "billing.py": """
    class Ledger:
        def __init__(self):
            self.totals = {}

        def charge(self, order):
            amount = 0
            for line in order["lines"]:
                amount += line["qty"] * line["price"]
            self.totals[order["customer"]] = amount
            return amount
    """,
    "catalog.py": """
    TEMPLATE = {"sku": "apple", "qty": 1, "price": 1.0}


    def new_order(customer):
        return {"customer": customer, "lines": [TEMPLATE]}
    """,
    "promo.py": """
    def bulk_bonus(order):
        for line in order["lines"]:
            if line["qty"] >= 1:
                line["qty"] += 1
        return order
    """,
}


def test_a_change_through_a_shared_object_reaches_every_name_that_holds_it(tmp_path):
    """bo pays 2.0: both orders hold catalog's one TEMPLATE dict, and ana's bonus changed it. ``why bill``
    reaches the change (promo.py:4) and says where bo's line started to be the shared object (catalog.py:5)."""
    run = record(tmp_path, ORDERS, exact=True)
    bump = steps_on(run, 4, "promo.py")[0]
    tree = run.why(steps_on(run, 13, "main.py")[0], "bill")
    found = nodes(tree)
    assert any(n.get("step") == bump for n in found), "why bill reaches line['qty'] += 1"
    shared = [n["shared"] for n in found if n.get("name") == "bo" and n.get("shared")]
    assert shared and shared[0]["path"] == "bo['lines'][0]" and shared[0].get("as") == "line", shared
    assert Path(shared[0]["file"]).name == "catalog.py" and shared[0]["line"] == 5, "the sharing began at new_order's return"
    assert bump in [c["step"] for c in run.var("TEMPLATE")["changes"]], "var TEMPLATE lists the change made through line"


def test_a_loop_target_is_credited_to_its_iteration_step(tmp_path):
    """``for x in xs`` binds x after the open statement (the header, then the body's last line) and before the
    iteration step: the exact recording gives each value to its iteration step, once."""
    run = record(tmp_path, """
    def f(xs):
        total = 0
        for x in xs:
            total += x
        return total


    print(f([1, 2, 3]))
    """, exact=True)
    changes = run.var("x")["changes"]
    assert [(c["line"], c["text"]) for c in changes] == [(3, "1"), (3, "2"), (3, "3")]
    assert [c["step"] for c in changes] == steps_on(run, 3)[1:], "each iteration step, not the header's or line 4's"


def test_a_container_filled_by_a_method_call_passes_a_later_change_to_its_owner(tmp_path):
    """``self.items.append(obj)`` makes the cart hold obj with no store of it; a later change to obj reaches the cart."""
    run = record(tmp_path, """
    class Cart:
        def __init__(self):
            self.items = []

        def add(self, obj):
            self.items.append(obj)


    def main():
        cart = Cart()
        apple = {"qty": 1}
        cart.add(apple)
        apple["qty"] = 5
        return cart


    print(main().items)
    """, exact=True)
    bump = steps_on(run, 13)[0]
    change = next((c for c in run.var("cart")["changes"] if c["step"] == bump), None)
    assert change is not None, "cart holds apple through cart.items: the change at line 13 reaches it"
    assert change["shared"]["path"] == "cart.items[0]" and change["shared"].get("as") == "apple"
    assert change["shared"]["line"] == 6, "the edge was made by the append"
