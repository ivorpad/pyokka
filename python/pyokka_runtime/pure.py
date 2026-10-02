"""What a hover, a watch or a completion may run: names, attributes, subscripts, operators,
comprehensions, and the calls that cannot change the program.

One rule for the three callers (``Tracer.evaluate`` over a finished run, ``Debugger.evaluate``
in a paused frame, ``complete``). ``check_pure`` refuses what may not run, ``eval_pure``
evaluates the rest. A call is pure when its callee is a builtin from ``PURE_BUILTINS`` that is
still the real builtin where the expression is evaluated, or a non-mutating method of an exact
builtin type (``d.get``, ``s.lower``, ``rows.count``). A user function, a method of a user
object, ``list.append`` and ``dict.pop`` are refused. Calls used to be refused wholesale, which
made ``len(rows)``, ``type(x)`` and ``sorted(keys)`` fail: those are what people type first.

The names and the receiver are checked where the expression runs, not where it is parsed, so a
program that rebinds ``len`` gets a refusal rather than a wrong answer, and the receiver of a
method call is evaluated exactly once. Lambdas, awaits, yields and the walrus stay refused.

This is not a sandbox and never claimed to be: an attribute still runs a property, a subscript
runs ``__getitem__``, a comprehension runs ``__iter__``, and rendering a value runs ``__str__``
or ``__repr__``. A user object that does work in one of those does it here, as it did before
pure calls were allowed.
"""

from __future__ import annotations

import ast
import builtins
from typing import Any

PURE_BUILTINS = frozenset(
    """
    len type repr str int float bool isinstance issubclass sorted reversed list dict tuple set
    frozenset min max sum abs round any all hasattr getattr id hash chr ord divmod enumerate zip
    range format callable bin hex oct ascii bytes slice vars dir
    """.split()
)

# Instances of these are immutable, so every public method of theirs is safe to call.
IMMUTABLE_TYPES = (str, bytes, int, float, complex, bool, tuple, frozenset, range)

# The mutable builtin containers say which of their methods may run.
CONTAINER_METHODS: dict[type, frozenset[str]] = {
    dict: frozenset({"get", "keys", "values", "items", "copy"}),
    list: frozenset({"copy", "count", "index"}),
    set: frozenset({"copy", "issubset", "issuperset", "isdisjoint", "union", "intersection", "difference", "symmetric_difference"}),
}

METHODS: dict[type, frozenset[str]] = {t: frozenset(n for n in dir(t) if not n.startswith("_")) for t in IMMUTABLE_TYPES}
METHODS.update(CONTAINER_METHODS)
_ANY_METHOD = frozenset().union(*METHODS.values())

# Injected into the evaluation namespace; `_pk_` names are the runtime's own and are never listed
# by `locals`, `complete` or the value views.
BUILTIN_FN = "_pk_pure_builtin"
METHOD_FN = "_pk_pure_method"

MAX_TEXT = 60  # of the refused expression quoted in the message

RULE = (
    "a hover or a watch runs only names, attributes, subscripts, operators and pure calls "
    "(builtins like len, sorted, isinstance; non-mutating methods of str, dict, list, tuple, set)"
)

_REFUSED_NODES = {
    ast.Lambda: "a lambda",
    ast.Await: "an await",
    ast.Yield: "a yield",
    ast.YieldFrom: "a yield from",
    ast.NamedExpr: "a walrus assignment",
}


def _text(node: ast.AST) -> str:
    try:
        text = " ".join(ast.unparse(node).split())
    except Exception:  # noqa: BLE001 - a node unparse cannot handle
        return "this"
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "..."


def _no_call(node: ast.AST) -> ValueError:
    return ValueError("cannot call `%s` here: %s" % (_text(node), RULE))


def check_pure(node: ast.AST) -> None:
    """Refuse everything a hover, a watch or a completion may not run, by ``ValueError``."""
    for n in ast.walk(node):
        what = _REFUSED_NODES.get(type(n))
        if what is not None:
            raise ValueError("cannot evaluate %s here: %s" % (what, RULE))
        if isinstance(n, ast.Call):
            func = n.func
            if isinstance(func, ast.Name):
                if func.id not in PURE_BUILTINS:
                    raise _no_call(func)
            elif isinstance(func, ast.Attribute):
                if func.attr not in _ANY_METHOD:  # the receiver's type decides the rest, at evaluation time
                    raise _no_call(func)
            else:
                raise _no_call(func)


def _builtin(name: str, namespace: dict) -> Any:
    """The real builtin ``name``, or a refusal when the program bound that name to something else."""
    real = getattr(builtins, name, None)
    if namespace.get(name, real) is not real:
        raise ValueError("`%s` is rebound here" % name)
    return real


def _method(receiver: Any, name: str, text: str) -> Any:
    """A non-mutating method of an exact builtin type; a subclass may have overridden it, so it is refused."""
    allowed = METHODS.get(type(receiver))
    if allowed is None or name not in allowed:
        raise ValueError("cannot call `%s` here: %s" % (text, RULE))
    return getattr(receiver, name)


class _Calls(ast.NodeTransformer):
    """Route every call through the runtime check, keeping the receiver a single evaluation."""

    def visit_Call(self, node: ast.Call) -> ast.Call:
        self.generic_visit(node)
        func = node.func
        if isinstance(func, ast.Name):
            node.func = _helper(BUILTIN_FN, [ast.Constant(value=func.id)])
        elif isinstance(func, ast.Attribute):
            node.func = _helper(METHOD_FN, [func.value, ast.Constant(value=func.attr), ast.Constant(value=_text(func))])
        return node


def _helper(name: str, args: list) -> ast.Call:
    return ast.Call(func=ast.Name(id=name, ctx=ast.Load()), args=args, keywords=[])


def eval_pure(node: ast.AST, globals_: dict, locals_: Any = None, filename: str = "<pyokka-evaluate>") -> Any:
    """Evaluate one checked expression node. Neither namespace is modified.

    Both namespaces are merged into the copy the expression runs in, locals over globals, so a
    comprehension's body sees the frame's variables (its own scope would only reach globals).
    """
    check_pure(node)
    namespace = dict(globals_)
    if locals_ is not None and locals_ is not globals_:
        namespace.update(locals_)
    namespace[BUILTIN_FN] = lambda name: _builtin(name, namespace)
    namespace[METHOD_FN] = _method
    expr = ast.fix_missing_locations(ast.Expression(body=_Calls().visit(node)))
    return eval(compile(expr, filename, "eval"), namespace)  # noqa: S307 - only pure calls survive check_pure and the rewrite


__all__ = ["PURE_BUILTINS", "METHODS", "RULE", "check_pure", "eval_pure"]
