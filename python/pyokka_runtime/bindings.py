"""Per-statement name bindings from the AST: what a statement assigns, reads and calls.

The variable history (``pyokka var``, the panel's Variable pane) needs two facts about a
statement that the trace does not carry: which names it binds (so a recorded change can be
attributed to the statement that made it, and so an assignment with no recorded value can
still be listed) and which names it reads (so "where did this come from" can show the values
that fed it). The provenance tree (``pyokka why``) adds a third: the source text of the calls
the statement makes, so a call whose body left no steps can still be named, and with it each
call's arguments (``args``) and each ``def``'s parameters (``params``), so a parameter can be
followed back to the argument the caller passed (``parameter_argument``). All come from the
source alone, so the same function serves the CLI over a saved run and the runner's
``bindings`` request for the extension.

Positions follow the range table: a statement is identified by ``(lineno, col_offset)`` of
its AST node, which is where the instrumenter starts its range (the header for compound
statements). ``def`` statements list their parameters as assignments: the only step on a
``def`` header is a call entering the function, and that is where the parameters get bound.
"""

from __future__ import annotations

import ast
import builtins
import re

BUILTIN_NAMES = frozenset(dir(builtins))
READS_CAP = 12
CALLS_CAP = 8
CALL_TEXT_MAX = 80
ARGS_CAP = 64  # a statement with more calls and attribute loads lists none: one left out could be the one that matched

_EOL = re.compile(r"\r\n|\r|\n")
_BODY_FIELDS = ("body", "orelse", "finalbody", "handlers", "cases")


def statement_bindings(source: str) -> list[dict]:
    """``[{line, col, assigns, reads, loop?, calls?}]`` for every statement that binds or reads a name or makes a call, in source order.

    Raises ``SyntaxError`` when the source does not parse.
    """
    tree = ast.parse(source)
    lines = source_lines(source)
    owners = {id(child): node for node in ast.walk(tree) if isinstance(node, ast.ClassDef) for child in node.body}
    out: list[dict] = []
    for stmt in ast.walk(tree):
        if not isinstance(stmt, ast.stmt) or getattr(stmt, "lineno", None) is None:
            continue
        assigns = assigned_paths(stmt)
        reads = read_names(stmt)
        calls = call_texts(stmt, source, lines)
        args = call_args(stmt, lines) if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else []
        if assigns or reads or calls or args:
            entry: dict = {"line": stmt.lineno, "col": stmt.col_offset, "assigns": assigns, "reads": reads}
            if isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
                # a loop header runs once before the loop and once per iteration, after the target is
                # bound; `loop` is the last line of the loop so a consumer can tell the two apart
                entry["loop"] = int(getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno)
            if calls:
                entry["calls"] = calls
            if args:
                entry["args"] = args
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                entry["params"] = def_params(stmt, owners.get(id(stmt)))
            out.append(entry)
    out.sort(key=lambda e: (e["line"], e["col"]))
    return out


# -- assignments --------------------------------------------------------------------------------------------

def target_path(node: ast.expr) -> str | None:
    """``acct``, ``self.balance``; a subscript binds its container (``acct[0] = 1`` assigns ``acct``)."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = target_path(node.value)
        return "%s.%s" % (base, node.attr) if base else None
    if isinstance(node, ast.Subscript):
        return target_path(node.value)
    if isinstance(node, ast.Starred):
        return target_path(node.value)
    return None


def _target_paths(node: ast.expr) -> list[str]:
    if isinstance(node, (ast.Tuple, ast.List)):
        out: list[str] = []
        for elt in node.elts:
            out.extend(_target_paths(elt))
        return out
    path = target_path(node)
    return [path] if path else []


def assigned_paths(stmt: ast.stmt) -> list[str]:
    """Names (or attribute paths) the statement binds when it executes, in source order, deduplicated."""
    out: list[str] = []
    if isinstance(stmt, ast.Assign):
        for t in stmt.targets:
            out.extend(_target_paths(t))
    elif isinstance(stmt, ast.AugAssign):
        out.extend(_target_paths(stmt.target))
    elif isinstance(stmt, ast.AnnAssign):
        if stmt.value is not None:
            out.extend(_target_paths(stmt.target))
    elif isinstance(stmt, (ast.For, ast.AsyncFor)):
        out.extend(_target_paths(stmt.target))
    elif isinstance(stmt, (ast.With, ast.AsyncWith)):
        for item in stmt.items:
            if item.optional_vars is not None:
                out.extend(_target_paths(item.optional_vars))
    elif isinstance(stmt, ast.Import):
        for alias in stmt.names:
            out.append(alias.asname or alias.name.split(".")[0])
    elif isinstance(stmt, ast.ImportFrom):
        for alias in stmt.names:
            if alias.name != "*":
                out.append(alias.asname or alias.name)
    elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
        a = stmt.args
        out.extend(arg.arg for arg in a.posonlyargs + a.args)
        if a.vararg:
            out.append(a.vararg.arg)
        out.extend(arg.arg for arg in a.kwonlyargs)
        if a.kwarg:
            out.append(a.kwarg.arg)
    if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        for node in _header_nodes(stmt):
            if isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
                out.append(node.target.id)
    return _dedupe(out)


# -- reads -----------------------------------------------------------------------------------------------------

def _header_nodes(stmt: ast.stmt):
    """Every node of the statement outside its nested blocks (the header for compound statements)."""
    for field, value in ast.iter_fields(stmt):
        if field in _BODY_FIELDS:
            continue
        if isinstance(value, ast.AST):
            yield from ast.walk(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, ast.AST):
                    yield from ast.walk(item)


def read_names(stmt: ast.stmt) -> list[str]:
    """Names the statement loads when it executes (``ast.Name`` loads of its header), in source order.

    Builtins, comprehension variables and lambda parameters are left out: they are never a
    recorded variable of the program. ``def`` and ``class`` statements read nothing at a step
    (defaults and decorators run when the definition executes, which is never a step).
    """
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return []
    local: set[str] = set()
    for node in _header_nodes(stmt):
        if isinstance(node, ast.comprehension):
            local.update(_target_paths(node.target))
        elif isinstance(node, ast.Lambda):
            a = node.args
            local.update(arg.arg for arg in a.posonlyargs + a.args + a.kwonlyargs)
            if a.vararg:
                local.add(a.vararg.arg)
            if a.kwarg:
                local.add(a.kwarg.arg)
    names: list[tuple[tuple[int, int], str]] = []
    if isinstance(stmt, ast.AugAssign) and isinstance(stmt.target, ast.Name):
        names.append(((stmt.target.lineno, stmt.target.col_offset), stmt.target.id))  # `x += 1` reads x, though the AST stores it
    for node in _header_nodes(stmt):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in local and node.id not in BUILTIN_NAMES:
            names.append(((node.lineno, node.col_offset), node.id))
    names.sort()
    return _dedupe([n for _, n in names])[:READS_CAP]


# -- calls -----------------------------------------------------------------------------------------------------

def call_texts(stmt: ast.stmt, source: str, lines: list[str] | None = None) -> list[str]:
    """The source text of each call the statement's header makes, outermost first, in ``ast.walk`` order.

    Whitespace is collapsed (a call split over lines reads as one), duplicates dropped, at most
    ``CALLS_CAP`` texts of at most ``CALL_TEXT_MAX`` characters. ``def`` and ``class`` statements
    make none at a step, like their reads. ``lines`` is ``source_lines(source)``, passed once
    per file so a long file is not split again for every call.
    """
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return []
    if lines is None:
        lines = source_lines(source)
    out: list[str] = []
    for node in _header_nodes(stmt):
        if not isinstance(node, ast.Call):
            continue
        text = " ".join((_segment(lines, node) or ast.unparse(node)).split())
        if text and text not in out:
            out.append(text)
            if len(out) == CALLS_CAP:
                break
    return [t if len(t) <= CALL_TEXT_MAX else t[: CALL_TEXT_MAX - 1] + "…" for t in out]


# -- arguments and parameters -------------------------------------------------------------------------------

def _loaded_names(node: ast.AST) -> list[str]:
    """``read_names`` for one expression: its ``ast.Name`` loads in source order, without builtins and the
    names a comprehension or lambda inside it binds."""
    local: set[str] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.comprehension):
            local.update(_target_paths(n.target))
        elif isinstance(n, ast.Lambda):
            a = n.args
            local.update(arg.arg for arg in a.posonlyargs + a.args + a.kwonlyargs)
            local.update(x.arg for x in (a.vararg, a.kwarg) if x)
    found = sorted(((n.lineno, n.col_offset), n.id) for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in local and n.id not in BUILTIN_NAMES)
    return _dedupe([name for _, name in found])


def _argument(node: ast.expr, lines: list[str], local: set[str] | frozenset[str] = frozenset()) -> dict:
    """An argument's text and the names it loads, without ``local``: the names a lambda or a comprehension around it binds."""
    text = " ".join((_segment(lines, node) or ast.unparse(node)).split())
    return {"text": text if len(text) <= CALL_TEXT_MAX else text[: CALL_TEXT_MAX - 1] + "…", "names": [n for n in _loaded_names(node) if n not in local]}


def _evaluation_order(stmt: ast.stmt) -> list[ast.expr]:
    """The header's calls and attribute loads in the order Python runs them: a call after its function and its
    arguments (``f(g(x))`` enters ``g`` first), an attribute after its object, children in field order. Only an
    ``_ordered`` statement runs them in this order. The attribute that names a called method is the call's."""
    out: list[ast.expr] = []
    called = set()

    def visit(node: ast.AST) -> None:
        if isinstance(node, ast.Call):
            called.add(id(node.func))
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.stmt, ast.excepthandler, ast.match_case)):
                visit(child)
        if isinstance(node, ast.Call) or (isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load) and id(node) not in called):
            out.append(node)

    for field, value in ast.iter_fields(stmt):
        if field in _BODY_FIELDS:
            continue
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, ast.AST):
                visit(item)
    return out


_UNORDERED = (ast.IfExp, ast.BoolOp, ast.Dict, ast.Lambda, ast.comprehension, ast.Await, ast.Yield, ast.YieldFrom)


def _ordered(stmt: ast.stmt) -> bool:
    """Whether everything the header runs runs once, in ``_evaluation_order``: no branch (``a if c else b``, ``and``,
    a chained comparison), nothing run later or many times (a lambda, a comprehension, an await), and no field
    Python evaluates out of its order (a dict's keys and values interleave; an assignment's targets after its value)."""
    for node in _header_nodes(stmt):
        if isinstance(node, _UNORDERED) or (isinstance(node, ast.Compare) and len(node.ops) > 1):
            return False
        if isinstance(node, ast.Call) and node.keywords and any(isinstance(a, ast.Starred) for a in node.args):
            return False
    if isinstance(stmt, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
        if any(isinstance(n, (ast.Call, ast.Attribute)) and isinstance(getattr(n, "ctx", ast.Load()), ast.Load) for t in targets for n in ast.walk(t)):
            return False
    return True


def _repeating(stmt: ast.stmt) -> dict[int, set[str]]:
    """The calls and attributes inside a lambda or a comprehension of the header (they run any number of times, or
    none), each with the names those bind around it: an argument ``n`` of ``Fraction(n, d) for d, n in items`` is the
    comprehension's, not a variable of the frame."""
    out: dict[int, set[str]] = {}

    def bound(node: ast.AST) -> set[str]:
        if isinstance(node, ast.Lambda):
            a = node.args
            return {arg.arg for arg in a.posonlyargs + a.args + a.kwonlyargs} | {x.arg for x in (a.vararg, a.kwarg) if x}
        return {n for gen in node.generators for n in _target_paths(gen.target)}

    for node in _header_nodes(stmt):
        if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            names = bound(node)
            for n in ast.walk(node):
                if isinstance(n, (ast.Call, ast.Attribute)):
                    out.setdefault(id(n), set()).update(names)
    return out


def call_args(stmt: ast.stmt, lines: list[str]) -> list[dict]:
    """What the statement's header passes to the functions it enters: one entry per call, and one per attribute it
    loads (``attribute``: a property's getter is entered with the object before the dot), in the order Python runs
    them (``_evaluation_order``), duplicates kept. None at all past ``ARGS_CAP`` entries.

    ``callee`` is the last name before the parenthesis (``charge`` for ``ledger.charge(bo)``), or the attribute's
    name; ``receiver`` is the expression before that name (``ledger``), which a method binds to its first
    parameter. ``positional`` lists the arguments before the first ``*x`` (``star`` says one was there),
    ``keywords`` the ``name=`` ones (``kwstar`` says a ``**x`` was there). Each argument has its source text
    and the names it loads. ``repeats`` marks an entry inside a lambda or a comprehension. The first entry carries
    two facts about the whole statement: ``unordered`` when what it runs may run in another order or not at all
    (``_ordered``), ``passes`` the callees it also hands over as a value (``_passed_values``). A call through
    anything but a name or an attribute (``f()(x)``) is left out.
    """
    out: list[dict] = []
    repeating = _repeating(stmt)
    for node in _evaluation_order(stmt):
        entry: dict = {}
        local = repeating.get(id(node), frozenset())
        if isinstance(node, ast.Attribute):
            entry = {"callee": node.attr, "receiver": _argument(node.value, lines, local), "positional": [], "attribute": True}
        else:
            func = node.func
            if isinstance(func, ast.Name):
                entry["callee"] = func.id
            elif isinstance(func, ast.Attribute):
                entry["callee"] = func.attr
                entry["receiver"] = _argument(func.value, lines, local)
            else:
                continue
            positional: list[dict] = []
            for arg in node.args:
                if isinstance(arg, ast.Starred):
                    entry["star"] = True
                    break
                positional.append(_argument(arg, lines, local))
            entry["positional"] = positional
            keywords = [dict(_argument(k.value, lines, local), name=k.arg) for k in node.keywords if k.arg is not None]
            if keywords:
                entry["keywords"] = keywords
            if any(k.arg is None for k in node.keywords):
                entry["kwstar"] = True
        if id(node) in repeating:
            entry["repeats"] = True
        out.append(entry)
        if len(out) > ARGS_CAP:
            return []
    if out and not _ordered(stmt):
        out[0]["unordered"] = True
    passed = _passed_values(stmt, {e["callee"] for e in out if not e.get("attribute")})
    if passed:
        out[0]["passes"] = passed
    return out


def _passed_values(stmt: ast.stmt, callees: set[str]) -> list[str]:
    """The callees the header also uses as a value, not called there: ``keyed`` in ``sorted(rows, key=keyed)``,
    ``keyed`` in ``map(self.keyed, rows)``. Such a function is entered with arguments no call of the statement shows."""
    called = {id(n.func) for n in _header_nodes(stmt) if isinstance(n, ast.Call)}
    found: list[str] = []
    for node in _header_nodes(stmt):
        if id(node) in called:
            continue
        name = node.id if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) else node.attr if isinstance(node, ast.Attribute) else None
        if name in callees and name not in found:
            found.append(name)
    return found


_PROPERTY = frozenset({"property", "cached_property", "getter"})


def def_params(stmt: ast.FunctionDef | ast.AsyncFunctionDef, owner: ast.ClassDef | None) -> dict:
    """A ``def``'s parameters by kind. ``owner`` is the class whose body holds the ``def``; ``binds`` says how a
    call binds the first parameter: ``self`` (a method), ``cls`` (a ``@classmethod``, and ``__new__``, which Python
    passes its class), absent for a plain function or a ``@staticmethod``. ``property`` marks a getter
    (``@property``, ``@cached_property``, ``@x.getter``), entered by loading the attribute, not by a call."""
    a = stmt.args
    out: dict = {"positional": [arg.arg for arg in a.posonlyargs + a.args]}
    if a.posonlyargs:
        out["positionalOnly"] = len(a.posonlyargs)
    if a.defaults:
        out["defaults"] = len(a.defaults)  # the last N positional parameters have one
    if a.vararg:
        out["vararg"] = a.vararg.arg
    if a.kwonlyargs:
        out["keywordOnly"] = [arg.arg for arg in a.kwonlyargs]
        required = [arg.arg for arg, d in zip(a.kwonlyargs, a.kw_defaults) if d is None]
        if required:
            out["requiredKeywordOnly"] = required
    if a.kwarg:
        out["kwarg"] = a.kwarg.arg
    if owner is not None:
        out["owner"] = owner.name
        decorators = {d.id if isinstance(d, ast.Name) else d.attr if isinstance(d, ast.Attribute) else "" for d in stmt.decorator_list}
        if "staticmethod" not in decorators and out["positional"]:
            out["binds"] = "cls" if "classmethod" in decorators or stmt.name == "__new__" else "self"
        if decorators & _PROPERTY:
            out["property"] = True
    return out


_MAKERS = ("__init__", "__new__")  # entered by calling the class


def parameter_argument(name: str, scope_name: str, params: dict, calls: list[dict], value_of=None, made: str | None = None, index: int = 0, entered: int = 1) -> dict | None:
    """The argument the call site passed for parameter ``name`` of the function ``scope_name`` (its ``def_params``),
    from the call site's ``call_args``: ``{text, names}``, or None when the call site does not say.

    ``value_of(text)`` is the recorded text of a name at the call site, or None (the builder reads the recording),
    which says when the name holds a class (``<class 'm.Plain'>``) or a function (``<function identity at 0x1>``,
    ``<bound method Printer.dict of …>``); ``made`` the name of the class whose object ``__init__`` or ``__new__`` was entered for, as the
    recorded first parameter names it; ``entered`` is how many times the statement entered this function and
    ``index`` which of those this one was.

    The entry is a call whose callee is the function's name, or, when none is, a call of a name that holds the
    function (``type_func(arg)`` with ``type_func = identity``; a bound method there has bound its first
    parameter); for a property's getter an attribute load of that name; for ``__init__`` and ``__new__`` a call of the class: its name, a name that holds a class (a subclass that
    inherits the method, a class kept in a variable), or the method itself (``super().__init__(x)``). One such entry
    is the one when the statement entered the function once, or many times from a lambda or a comprehension
    (``repeats``). Several are told apart by the order Python runs them, when each runs once in a statement that is
    not ``unordered`` and they entered as many times as there are entries. A function the statement also hands over
    as a value (``sorted(rows, key=keyed)``) is entered with arguments no call shows: None. So is anything else.

    A method's first parameter is the receiver of an attribute call (``ledger`` for ``ledger.charge(bo)``), except
    through the class itself (``Ledger.charge(ledger, bo)``, where the arguments start at it: a receiver whose text
    is the class's name or that holds a class). ``__init__``'s is the object being made, which no argument names;
    ``__new__``'s the class called. An explicit ``super().__init__(x)`` binds self too, but ``Base.__init__(self, x)``
    and ``object.__new__(cls)`` pass it, as any method called through its class does. Then keywords by name, positions in order (none past a ``*x``), and the
    ``*args`` and ``**kwargs`` parameters take what is left over, joined, when nothing unknown could have joined
    them. A parameter left to its default gives None. A call whose arguments do not fit the parameters (more
    positions than the ``def`` takes, a parameter without a default that nothing fills) gives None for every
    parameter: the call bound them some other way (an alias of the class, a decorator in between).
    """
    value_of = value_of or (lambda _text: None)

    def class_of(text: str) -> str | None:
        return class_name(value_of(text) or "") if text.isidentifier() else None

    owner = params.get("owner")
    bound_by_variable = False
    maker = scope_name in _MAKERS and bool(owner)
    if params.get("property"):
        candidates = [c for c in calls if c.get("attribute") and c.get("callee") == scope_name]
    else:
        if calls and scope_name in (calls[0].get("passes") or []):
            return None
        plain = [c for c in calls if not c.get("attribute")]
        candidates = [c for c in plain if c.get("callee") == scope_name and (not maker or c.get("receiver") is not None)]
        if not candidates and not maker:
            held = [(c, function_name(value_of(c["callee"]) or "")) for c in plain if c.get("receiver") is None and c["callee"].isidentifier()]
            candidates = [c for c, f in held if f is not None and f[0] == scope_name]
            bound_by_variable = any(f is not None and f[0] == scope_name and f[1] for _, f in held)
            if bound_by_variable and not all(f[1] for c, f in held if f is not None and f[0] == scope_name):
                return None  # the same function held bound and unbound: which binding a call made is not known
        if maker:
            named = [c for c in plain if c.get("callee") == owner]
            if not named:
                named = [c for c in plain if c.get("receiver") is None and made is not None and class_of(c["callee"]) == made]
            candidates = named + candidates
    if len(candidates) == 1 and (entered == 1 or candidates[0].get("repeats")):
        call = candidates[0]
    elif len(candidates) == entered > 1 and 0 <= index < entered and not calls[0].get("unordered") and not any(c.get("repeats") for c in candidates):
        call = candidates[index]
    else:
        return None
    positional_params = list(params.get("positional") or [])
    args = list(call.get("positional") or [])
    receiver = call.get("receiver")
    binds = params.get("binds")
    explicit = call.get("callee") == scope_name and maker  # `super().__init__(x)`, `object.__new__(cls)`
    first: str | None = None
    first_is: dict | None = None
    if binds and positional_params:
        through_class = receiver is not None and (class_of(receiver["text"]) is not None or receiver["text"] == owner or receiver["text"].endswith("." + str(owner)))
        if maker and not explicit:
            first = positional_params.pop(0)
            first_is = {"text": call["callee"], "names": [call["callee"]]} if scope_name == "__new__" and receiver is None else None
        elif maker:
            # `super().__init__(x)` binds self; `Base.__init__(self, x)` and `object.__new__(cls)` pass it
            if scope_name == "__init__" and not through_class:
                first = positional_params.pop(0)
        elif receiver is None and call.get("callee") != scope_name:
            if bound_by_variable:
                first = positional_params.pop(0)  # the bound method holds its first argument: no argument names it
        else:
            through_class = through_class and binds == "self"
            if receiver is not None and not through_class:
                first = positional_params.pop(0)
                first_is = {"text": receiver["text"], "names": list(receiver["names"])}
            elif receiver is None:
                return None  # a method called by a bare name: not a binding this rule can read
    keywords = {k["name"]: k for k in call.get("keywords") or []}
    only = int(params.get("positionalOnly") or 0) - (1 if first is not None else 0)
    named_params = positional_params[max(0, only):] + list(params.get("keywordOnly") or [])
    if not _fits(params, positional_params, named_params, args, keywords, call):
        return None
    if first is not None and name == first:
        return first_is
    if name in keywords and name in named_params:
        return {"text": keywords[name]["text"], "names": list(keywords[name]["names"])}
    if name in positional_params:
        i = positional_params.index(name)
        return {"text": args[i]["text"], "names": list(args[i]["names"])} if i < len(args) else None
    if name == params.get("vararg") and not call.get("star"):
        return _joined(args[len(positional_params):])
    if name == params.get("kwarg") and not call.get("kwstar"):
        extra = [k for n, k in keywords.items() if n not in named_params]
        return _joined([{"text": "%s=%s" % (k["name"], k["text"]), "names": k["names"]} for k in extra])
    return None


def _fits(params: dict, positional_params: list[str], named: list[str], args: list[dict], keywords: dict, call: dict) -> bool:
    """Whether the call's arguments bind to the parameters as Python would bind them, as far as the source shows."""
    if len(args) > len(positional_params) and not params.get("vararg"):
        return False
    if any(n not in named for n in keywords) and not params.get("kwarg"):
        return False
    if call.get("star") or call.get("kwstar"):
        return True  # what else they pass is unknown; the named and positional ones above still hold
    defaults = int(params.get("defaults") or 0)
    required = positional_params[: max(0, len(positional_params) - defaults)]
    filled = set(positional_params[: len(args)]) | set(keywords)
    return all(p in filled for p in required) and all(p in keywords for p in params.get("requiredKeywordOnly") or [])


_CLASS_TEXT = re.compile(r"^<class '(?:[\w.]*\.)?(\w+)'>$")
_INSTANCE_TEXT = re.compile(r"^<(?:[\w.]*\.)?(\w+) object(?: at 0x[0-9a-f]+)?>$|^(\w+)\(")


def class_name(text: str) -> str | None:
    """The class a recorded value names when it is a class: ``Plain`` for ``<class 'shapes.Plain'>``."""
    m = _CLASS_TEXT.match(text)
    return m.group(1) if m else None


_FUNCTION_TEXT = re.compile(r"^<(bound method|function) (?:[\w.<>]*\.)?(\w+)(?: at 0x[0-9a-f]+| of .*)>$", re.S)


def function_name(text: str) -> tuple[str, bool] | None:
    """The function a recorded value names, and whether it is a bound method: ``("identity", False)`` for
    ``<function identity at 0x1>``, ``("dict", True)`` for ``<bound method Printer.dict of <Printer object>>``."""
    m = _FUNCTION_TEXT.match(text)
    return (m.group(2), m.group(1) == "bound method") if m else None


def instance_class(text: str) -> str | None:
    """The class a recorded object's text names: ``Plain`` for ``<shapes.Plain object at 0x1>``, the placeholder of an
    object whose repr failed (``<Plain object>``) or a constructor-style repr (``Plain(name='x')``); None otherwise."""
    m = _INSTANCE_TEXT.match(text)
    return (m.group(1) or m.group(2)) if m else None


def _joined(args: list[dict]) -> dict | None:
    if not args:
        return None
    return {"text": ", ".join(a["text"] for a in args), "names": _dedupe([n for a in args for n in a["names"]])}


def source_lines(source: str) -> list[str]:
    """Lines with their endings, split on ``\\r\\n``, ``\\r`` and ``\\n`` only (as the AST counts them; ``str.splitlines`` also splits on a form feed)."""
    out: list[str] = []
    start = 0
    for m in _EOL.finditer(source):
        out.append(source[start:m.end()])
        start = m.end()
    if start < len(source):
        out.append(source[start:])
    return out


def _segment(lines: list[str], node: ast.AST) -> str | None:
    """``ast.get_source_segment`` over lines split once (columns are UTF-8 byte offsets)."""
    a, b = getattr(node, "lineno", None), getattr(node, "end_lineno", None)
    ca, cb = getattr(node, "col_offset", None), getattr(node, "end_col_offset", None)
    if a is None or b is None or ca is None or cb is None or b > len(lines):
        return None
    if a == b:
        return lines[a - 1].encode()[ca:cb].decode(errors="replace")
    first = lines[a - 1].encode()[ca:].decode(errors="replace")
    last = lines[b - 1].encode()[:cb].decode(errors="replace")
    return "".join([first, *lines[a:b - 1], last])


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


# -- matching --------------------------------------------------------------------------------------------------

def matches_name(candidate: str | None, query: str) -> bool:
    """The variable history's name rule: exact, or one path under the other (``acct`` ~ ``acct.deposit(x)``, ``self`` ~ ``self.balance``)."""
    if not candidate or not query:
        return False
    if candidate == query:
        return True
    for sep in (".", "["):
        if candidate.startswith(query + sep) or query.startswith(candidate + sep):
            return True
    return False


def index_bindings(entries: list[dict], ranges: list[list[int]], statements: list[int], function_rids: list[int], range_base: int = 0) -> dict[int, dict]:
    """Bindings keyed by global range id, via the ``(line, col)`` the range table and the AST share.

    Statement ranges win over ``def`` headers at the same position (a bare lambda statement).
    """
    by_pos: dict[tuple[int, int], int] = {}
    for local in list(function_rids) + list(statements):
        if 0 <= local < len(ranges):
            r = ranges[local]
            by_pos[(int(r[0]), int(r[1]))] = local
    out: dict[int, dict] = {}
    for e in entries:
        local = by_pos.get((int(e["line"]), int(e["col"])))
        if local is not None:
            out[range_base + local] = e
    return out


__all__ = ["statement_bindings", "call_args", "def_params", "parameter_argument", "class_name", "function_name", "instance_class", "ARGS_CAP", "assigned_paths", "read_names", "call_texts", "target_path", "matches_name", "index_bindings", "BUILTIN_NAMES", "READS_CAP", "CALLS_CAP", "CALL_TEXT_MAX"]
