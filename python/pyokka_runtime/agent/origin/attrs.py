"""Attribute paths in ``pyokka origin`` (``lines[0].unit_price``): a field of an object, read from its repr.

The recording keeps a value as repr text, and a dataclass, a namedtuple or an attrs class prints
its fields by name (``Line(sku='a', qty=2, unit_price=3.5)``), which ``reprs.parse`` reads as a
``Record``; ``.unit_price`` then projects the way a key does. The walk needs three more moves:

- a constructor call that left no steps (``Line(sku, qty, price)``: a generated ``__init__``): the
  argument that became the field, by keyword or by the class's field order read from its ``class``
  statement in the run's files, else the field's default;
- a class with a stepped ``__init__``: the statement in that scope that set ``self.<field>``;
- a loop variable (``for line in lines``): the element of the iterable whose field carries the text.

An object whose repr shows no fields (``<Foo object at 0x…>``) cannot be followed into a field, and
``exprs.py`` says so when it is named.
"""

from __future__ import annotations

import ast
from typing import Any

from ..history import _previous_step_in_scope as previous_step_in_scope
from ..provenance import callee_name
from ..reprs import UNKNOWN, Attr, _Opaque, path_text, project, text_of
from .nodes import binds_name, is_mutation

INIT_SCAN_MAX = 5_000
FIELD_DECORATORS = frozenset({"dataclass", "define", "frozen", "mutable", "s", "attrs"})
FIELD_BASES = frozenset({"NamedTuple"})


def _decorator_name(node: ast.expr) -> str:
    if isinstance(node, ast.Call):
        node = node.func
    return node.attr if isinstance(node, ast.Attribute) else node.id if isinstance(node, ast.Name) else ""


def _base_of(node: ast.expr) -> str:
    return node.attr if isinstance(node, ast.Attribute) else node.id if isinstance(node, ast.Name) else ""


def prints_fields(cls: ast.ClassDef) -> bool:
    """A dataclass, an attrs class or a NamedTuple: its repr prints its fields and its fields are its positional arguments."""
    return any(_decorator_name(d) in FIELD_DECORATORS for d in cls.decorator_list) or any(_base_of(b) in FIELD_BASES for b in cls.bases)


def _positional(stmt: ast.AnnAssign) -> bool:
    """A field that takes a positional argument: not a ClassVar, not ``field(init=False)``, not ``kw_only``."""
    if "ClassVar" in ast.dump(stmt.annotation):
        return False
    v = stmt.value
    if isinstance(v, ast.Call) and _decorator_name(v) in ("field", "ib", "attrib"):
        for kw in v.keywords:
            if kw.arg in ("init", "kw_only") and isinstance(kw.value, ast.Constant) and kw.value.value is (kw.arg != "init"):
                return False
    return True


def self_assignment(node: ast.stmt | None, attr: str) -> ast.expr | None:
    """The value of ``self.<attr> = …`` when ``node`` is that statement."""
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self" and t.attr == attr:
                return node.value
    if isinstance(node, ast.AnnAssign) and node.value is not None and isinstance(node.target, ast.Attribute) and isinstance(node.target.value, ast.Name) and node.target.value.id == "self" and node.target.attr == attr:
        return node.value
    return None


class AttrMixin:
    """``OriginBuilder``'s attribute moves."""

    def class_def(self, name: str) -> ast.ClassDef | None:
        """``class NAME`` in the run's files, the first found."""
        cache = self.__dict__.setdefault("_class_defs", {})
        if name not in cache:
            cache[name] = None
            for fid in self.run.files:
                for node in self._file(int(fid))[1].values():
                    if isinstance(node, ast.ClassDef) and node.name == name:
                        cache[name] = node
                        break
                if cache[name] is not None:
                    break
        return cache[name]

    def init_owner(self, scope: dict) -> str | None:
        """The class whose ``__init__`` the scope ran: the ``class`` statement holding its ``def``; None when the run's files do not show one."""
        cache = self.__dict__.setdefault("_init_owners", {})
        sid = int(scope["scopeId"])
        if sid not in cache:
            cache[sid] = None
            first = int(scope["first"])
            node, loc = self.stmt(first), self.trace.location(first)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and loc is not None:
                for cls in self._file(loc[0])[1].values():
                    if isinstance(cls, ast.ClassDef) and any(b is node for b in cls.body):
                        cache[sid] = cls.name
                        break
        return cache[sid]

    def class_fields(self, name: str, depth: int = 0) -> list[str] | None:
        """The positional fields of ``class NAME``, bases first; None when it is not a class that prints its fields."""
        cls = self.class_def(name)
        if cls is None or not prints_fields(cls) or depth > 5:
            return None
        fields: list[str] = []
        for b in cls.bases:
            bname = _base_of(b)
            if bname and bname != name and bname not in FIELD_BASES:
                fields.extend(f for f in self.class_fields(bname, depth + 1) or [] if f not in fields)
        for stmt in cls.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and _positional(stmt) and stmt.target.id not in fields:
                fields.append(stmt.target.id)
        return fields

    def field_default(self, name: str, attr: str) -> ast.expr | None:
        """The default of field ``attr`` in ``class NAME``: the annotation's value, or ``field(default=…)``."""
        cls = self.class_def(name)
        for stmt in cls.body if cls is not None else []:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.target.id == attr and stmt.value is not None:
                v = stmt.value
                if isinstance(v, ast.Call) and _decorator_name(v) in ("field", "ib", "attrib"):
                    return next((kw.value for kw in v.keywords if kw.arg == "default"), None)
                return v
        return None

    def constructor_argument(self, call: ast.Call, attr: str, step: int) -> ast.expr | None:
        """The argument of ``call`` that became field ``attr``: ``attr=…`` by keyword, else by the class's field order."""
        for kw in call.keywords:
            if kw.arg == attr:
                return kw.value
        fields = self.class_fields(callee_name(self.seg(step, call)))
        if fields is None or attr not in fields or any(kw.arg is None for kw in call.keywords):
            return None
        i = fields.index(attr)
        if any(isinstance(a, ast.Starred) for a in call.args[: i + 1]):
            return None
        return call.args[i] if i < len(call.args) else None

    def constructor_text(self, call: ast.Call, path: list, step: int) -> str | None:
        """``simple_text`` of a field of a constructor call: the text of the argument that became it."""
        if not path or not isinstance(path[0], Attr):
            return None
        arg = self.constructor_argument(call, path[0].name, step)
        return self.simple_text(arg, path[1:], step) if arg is not None else None

    def into_constructor(self, call: ast.Call, path: list, step: int, carried: str | None, scope: dict | None = None) -> None:
        """A call carrying ``.field``: into a stepped ``__init__``, to the argument that became the field, or to its default."""
        attr = path[0].name
        name = callee_name(self.seg(step, call))
        scopes = [scope] if scope is not None else self.callee_scopes(step, name)
        if scopes:
            if str(scopes[-1]["name"]).rsplit(".", 1)[-1] == "__init__":
                self.init_assignment(scopes[-1], name, path, carried)
            else:
                self.returned(scopes[-1], path, carried)  # the function returned the object; its return is followed with the field
            return
        arg = self.constructor_argument(call, attr, step)
        if arg is not None:
            expr = path_text(self.seg(step, arg), path[1:]) if path[1:] else self.seg(step, arg)
            if self.add(step, expr, carried, "argument", note="field %s of %s" % (attr, name)) is None:
                return
            self.follow_expr(arg, path[1:], step, carried)
            return
        default = self.field_default(name, attr)
        if default is not None:
            self.add(step, "%s=%s" % (attr, self.seg(step, default)), carried, "literal", note="default value of %s's field %s" % (name, attr))
            self.end = "the default value of %s's field %s" % (name, attr)
            return
        self.computed(call, step, carried)  # not a class that prints its fields: the call's inputs are all the recording has

    def init_assignment(self, scope: dict, name: str, path: list, carried: str | None) -> None:
        """A stepped ``__init__``: the last statement of its scope that set ``self.<field>``."""
        attr = path[0].name
        first, last, sid = int(scope["first"]), int(scope["last"]), int(scope["scopeId"])
        hit: tuple[int, ast.expr] | None = None
        for j in range(first, min(last, first + INIT_SCAN_MAX) + 1):
            if self.trace.scope_id(j) != sid:
                continue
            value = self_assignment(self.stmt(j), attr)
            if value is not None:
                hit = (j, value)
        if hit is None:
            self.add(first, "%s()" % name, carried, "argument", note="%s.__init__ runs here and no statement of it sets self.%s" % (name, attr))
            self.end = "self.%s is not set in %s.__init__ in the recording (a base class or a later statement may set it)" % (attr, name)
            return
        j, value = hit
        if self.add(j, "self.%s = %s" % (attr, self.seg(j, value)), carried, "assigned", note="set in %s.__init__" % name) is None:
            return
        self.follow_expr(value, path[1:], j, carried)

    def loop_element(self, node: ast.For | ast.AsyncFor, name: str, path: list, made: int, carried: str | None) -> bool:
        """``for line in lines`` carrying ``.unit_price``: the element of the iterable whose field has the text. False when it cannot tell."""
        if carried is None or not any(isinstance(k, Attr) for k in path):
            return False
        over = self.seg(made, node.iter)
        found = self.evaluate(node.iter, made, {})
        for base, ipath, items in found:
            if not isinstance(items, (list, tuple)):
                continue
            hits = [i for i, el in enumerate(items) if text_of(project(el, path)) == carried]
            if not hits:
                continue
            note = "loop variable over %s; the element whose %s has this text" % (over, path_text("", path))
            if len(hits) > 1:
                note += " (%d elements do; the first is shown)" % len(hits)
            if self.add(made, path_text(name, path), carried, "element", "inferred", note=note) is not None:
                self.follow_name(base, list(ipath) + [hits[0]] + list(path), made, carried)
            return True
        if found and all(items is UNKNOWN or isinstance(items, _Opaque) for _, _, items in found):
            # the iterable is an attribute of an object whose repr prints no fields: its elements' texts are not in the recording
            self.add(made, path_text(name, path), carried, "element", note="loop variable over %s, whose elements the recording does not print" % over)
            self.end = "%s is an element of %s, which the recording shows only as part of an object without a printed repr, so the statement that made it is not known" % (name, over)
            return True
        return False

    def observed_in_place(self, node: ast.stmt, name: str, path: list, made: int, text: str | None, carried: str | None) -> bool:
        """The recorder saw ``name`` change at ``made``, a statement that only reads it: the change was in place, by the
        scope's previous statement (an ``append`` the bindings do not count as a store). True when that statement is followed."""
        if binds_name(node, name) or is_mutation(node, name) or isinstance(node, (ast.For, ast.AsyncFor, ast.FunctionDef, ast.AsyncFunctionDef)):
            return False
        prev = previous_step_in_scope(self.run, made, self.trace.scope_id(made))
        prev_node = self.stmt(prev) if prev >= 0 else None
        if prev_node is None or not is_mutation(prev_node, name):
            return False
        self.mutation(prev_node, name, path, prev, text, carried)
        return True

    def attribute_mutation(self, node: ast.stmt, name: str, path: list, made: int, text: str | None) -> bool:
        """``name.field = v`` at ``made`` with a path that starts at ``.field``: the value set is the link."""
        if not (isinstance(node, ast.Assign) and isinstance(path[0], Attr)):
            return False
        for t in node.targets:
            if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == name and t.attr == path[0].name:
                if self.add(made, self.seg(made, node.value), text, "assigned", note="set as %s" % path_text(name, path[:1])) is not None:
                    self.follow_expr(node.value, path[1:], made, text)
                return True
        return False

    # the rest (`run`, `trace`, `_file`, `stmt`, `seg`, `add`, `callee_scopes`, `evaluate`, `simple_text`,
    # `follow_expr`, `follow_name`, `returned`, `computed`) is OriginBuilder's, like the other mixins'
    run: Any
    trace: Any


__all__ = ["AttrMixin", "prints_fields", "self_assignment"]
