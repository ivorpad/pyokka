"""Bounded value snapshots in the protocol's value-node schema.

Design rules (they fix the pitfalls of the reference implementation):

* Attribute discovery reads ``__dict__`` and ``__slots__`` descriptors only.
  ``dir()``/``getattr()`` are never used on user objects, so properties and
  ``__getattr__`` hooks are not invoked unless ``resolve_getters`` is set.
* Cycles are detected along the current path (``circular: true``); shared
  sub-objects that are not ancestors are serialised normally.
* ``repr`` is always guarded and truncated.
* Depth/breadth/string limits come from ``LogLimitSet``; an
  ``expressionsToEvaluate`` tree forces expansion along a query path;
  capped containers get a synthetic ``loadActionNode`` child.
"""
from __future__ import annotations

import dataclasses
import enum
import itertools
import math
import types
from collections import deque
from collections.abc import Mapping
from typing import Any

from . import secrets
from .protocol import LogLimitSet
from .values import (
    LOAD_MORE_SUFFIX,
    PREVIEW_LEN,
    Registry,
    _LEAF_TYPES,
    _function_repr,
    _guarded_repr,
    _index_expr,
    _instance_dict,
    _int_repr,
    _is_namedtuple,
    _key_name,
    _safe_type_name,
    _slot_names,
    _tb_summary,
    child_by_segment,
    short_repr,
    type_name,
)

__all__ = ["Registry", "Serializer", "serialize", "short_repr", "type_name", "child_by_segment", "expression_name"]


def expression_name(expr: str | None) -> str:
    """The name a root expression ends in: ``client.api_key`` -> ``api_key``, ``d['token']`` -> ``token``."""
    if not expr:
        return ""
    tail = expr.rstrip(")]'\" ").rsplit(".", 1)[-1]
    if "[" in tail:
        tail = tail.rsplit("[", 1)[-1].strip("'\" ")
    return tail


class Serializer:
    def __init__(
        self,
        limits: LogLimitSet,
        *,
        root_key: str,
        hit: int = 0,
        registry: Registry | None = None,
        resolve_getters: bool = False,
        expression_root: str | None = None,
        expand_tree: dict | None = None,
        id_prefix: str | None = None,
    ) -> None:
        self.limits = limits
        self.root_key = root_key
        self.hit = hit
        self.registry = registry
        self.resolve_getters = resolve_getters
        self.expression_root = expression_root
        self.expand_tree = expand_tree
        self.id_prefix = id_prefix if id_prefix is not None else "%s %s" % (root_key, hit)
        self.counter = 0
        self.stack: list[int] = []

    # -- ids -----------------------------------------------------------
    def _next_id(self) -> str:
        self.counter += 1
        return "%s %d" % (self.id_prefix, self.counter)

    # -- entry ---------------------------------------------------------
    def root(self, obj: Any, query_path: list[str] | None = None, depth: int | None = None) -> dict:
        path = list(query_path) if query_path else [self.root_key]
        expr = self.expression_root if self.expression_root is not None else ""
        if not expr and len(path) > 1:
            expr = "$"
        depth_left = self.limits.depth if depth is None else depth
        if self.registry is not None:
            self.registry.set_root(self.root_key, obj)
        node = self.node(obj, path, expr, depth_left, self.expand_tree)
        if secrets.current.secret_name(expression_name(expr)):
            secrets.current.mask_leaf(node)
        return node

    # -- the recursive worker -----------------------------------------
    def node(self, obj: Any, path: list[str], expr: str, depth_left: int, tree: dict | None) -> dict:
        try:
            return self._node(obj, path, expr, depth_left, tree)
        except RecursionError:
            return self._leaf("object", "<too deep>", path, expr)
        except BaseException as exc:  # noqa: BLE001 - never let user objects break logging
            return self._leaf(_safe_type_name(obj), "<unserializable: %s>" % _guarded_repr(exc, 80), path, expr)

    def _leaf(self, tname: str, value: str, path: list[str], expr: str, **extra: Any) -> dict:
        out: dict[str, Any] = {"type": tname, "value": value, "id": self._next_id(), "queryPath": path}
        if expr:
            out["expressionPath"] = expr
        out.update(extra)
        return out

    def _node(self, obj: Any, path: list[str], expr: str, depth_left: int, tree: dict | None) -> dict:
        if obj is None:
            return self._leaf("None", "None", path, expr)
        t = type(obj)
        if t is bool:
            return self._leaf("bool", "True" if obj else "False", path, expr)
        if t is int:
            return self._leaf("number", _int_repr(obj), path, expr)
        if t is float:
            if math.isnan(obj):
                return self._leaf("number", "nan", path, expr, nan=True)
            if math.isinf(obj):
                flag = "positiveInfinity" if obj > 0 else "negativeInfinity"
                return self._leaf("number", repr(obj), path, expr, **{flag: True})
            return self._leaf("number", repr(obj), path, expr)
        if t is complex:
            return self._leaf("number", repr(obj), path, expr)
        if t is str:
            return self._string(obj, path, expr)
        if t in (bytes, bytearray):
            node = self._leaf("bytes", short_repr(obj, self.limits.string_length), path, expr)
            node["length"] = len(obj)
            return node
        if isinstance(obj, enum.Enum):
            return self._enum(obj, path, expr, depth_left, tree)
        if isinstance(obj, type):
            return self._class(obj, path, expr, depth_left, tree)
        if isinstance(obj, types.ModuleType):
            return self._leaf("module", getattr(obj, "__name__", "<module>"), path, expr)
        tname = type_name(obj)
        if tname == "function":
            return self._leaf("function", _function_repr(obj), path, expr)
        if isinstance(obj, _LEAF_TYPES) or isinstance(obj, (int, float, complex, str)):
            # int/str subclasses land here too: show as their class with a repr value.
            return self._leaf(tname, short_repr(obj, self.limits.string_length), path, expr)
        if isinstance(obj, (list, tuple, deque)) or t in (set, frozenset) or isinstance(obj, (set, frozenset)):
            if _is_namedtuple(obj):
                return self._object(obj, path, expr, depth_left, tree, named_tuple=True)
            return self._sequence(obj, path, expr, depth_left, tree)
        if isinstance(obj, Mapping):
            return self._mapping(obj, path, expr, depth_left, tree)
        if isinstance(obj, BaseException):
            return self._exception(obj, path, expr, depth_left, tree)
        return self._object(obj, path, expr, depth_left, tree)

    # -- helpers for containers ----------------------------------------
    def _begin(self, obj: Any, tname: str, preview: str, path: list[str], expr: str) -> tuple[dict, bool]:
        """Create the container node; returns (node, circular)."""
        oid = id(obj)
        node = self._leaf(tname, preview, path, expr)
        if oid in self.stack:
            node["circular"] = True
            node["value"] = "[Circular]"
            node["expandable"] = True
            return node, True
        if self.registry is not None:
            self.registry.register(node["id"], obj)
        return node, False

    def _child_path(self, path: list[str], name: str) -> list[str]:
        return path + ["_p_" + name]

    def _subtree(self, tree: dict | None, name: str) -> dict | None:
        if not tree:
            return None
        return tree.get("_p_" + name)

    def _child_depth(self, depth_left: int, sub: dict | None) -> int:
        if sub is not None:
            # forced expansion along the requested path
            return max(depth_left - 1, self.limits.depth if not sub else 1)
        return depth_left - 1

    def _should_expand(self, depth_left: int, tree: dict | None) -> bool:
        return depth_left > 0 or bool(tree)

    def _string(self, s: str, path: list[str], expr: str) -> dict:
        node = self._leaf("str", s, path, expr)
        node["length"] = len(s)
        limit = self.limits.string_length
        if len(s) > limit:
            prefix = s[:limit]
            node["value"] = prefix
            node["capped"] = prefix
        return node

    def _sequence(self, obj: Any, path: list[str], expr: str, depth_left: int, tree: dict | None) -> dict:
        tname = type_name(obj)
        node, circular = self._begin(obj, tname, short_repr(obj, PREVIEW_LEN), path, expr)
        try:
            node["length"] = len(obj)
        except Exception:  # noqa: BLE001
            pass
        if circular:
            return node
        if not self._should_expand(depth_left, tree):
            node["capped"] = True
            node["expandable"] = node.get("length", 1) != 0
            return node
        self.stack.append(id(obj))
        try:
            props: list[dict] = []
            limit = self.limits.elements
            it = iter(list(itertools.islice(obj, limit + 1))) if isinstance(obj, (set, frozenset, deque)) else iter(obj)
            capped = False
            for i, item in enumerate(it):
                if i >= limit:
                    capped = True
                    break
                name = str(i)
                sub = self._subtree(tree, name)
                child = self.node(item, self._child_path(path, name), _index_expr(expr, i), self._child_depth(depth_left, sub), sub)
                child["name"] = name
                props.append(child)
            node["props"] = props
            node["expandable"] = True
            if capped:
                node["cappedElements"] = True
                props.append(self._load_more(node, path))
        finally:
            self.stack.pop()
        return node

    def _mapping(self, obj: Any, path: list[str], expr: str, depth_left: int, tree: dict | None) -> dict:
        tname = "dict" if type(obj) is dict else type(obj).__name__
        node, circular = self._begin(obj, tname, short_repr(obj, PREVIEW_LEN), path, expr)
        try:
            node["length"] = len(obj)
        except Exception:  # noqa: BLE001
            pass
        if circular:
            return node
        if not self._should_expand(depth_left, tree):
            node["capped"] = True
            node["expandable"] = node.get("length", 1) != 0
            return node
        self.stack.append(id(obj))
        try:
            props: list[dict] = []
            limit = self.limits.elements
            capped = False
            try:
                items = list(itertools.islice(obj.items(), limit + 1))
            except Exception:  # noqa: BLE001
                items = []
            for i, (key, value) in enumerate(items):
                if i >= limit:
                    capped = True
                    break
                name = _key_name(key)
                key_repr = _guarded_repr(key)
                sub = self._subtree(tree, name)
                child = self.node(value, self._child_path(path, name), "%s[%s]" % (expr or "$", key_repr), self._child_depth(depth_left, sub), sub)
                child["name"] = name
                child["keyRepr"] = key_repr
                if secrets.current.secret_name(name):
                    secrets.current.mask_leaf(child)
                props.append(child)
            node["props"] = props
            node["expandable"] = True
            if capped:
                node["cappedElements"] = True
                props.append(self._load_more(node, path))
        finally:
            self.stack.pop()
        return node

    def _enum(self, obj: enum.Enum, path: list[str], expr: str, depth_left: int, tree: dict | None) -> dict:
        tname = type(obj).__name__
        node, _ = self._begin(obj, tname, "%s.%s" % (tname, obj.name), path, expr)
        if not self._should_expand(depth_left, tree):
            node["capped"] = True
            node["expandable"] = True
            return node
        self.stack.append(id(obj))
        try:
            props = []
            for name, val in (("name", obj.name), ("value", obj.value)):
                sub = self._subtree(tree, name)
                child = self.node(val, self._child_path(path, name), "%s.%s" % (expr or "$", name), self._child_depth(depth_left, sub), sub)
                child["name"] = name
                if secrets.current.secret_name(name):
                    secrets.current.mask_leaf(child)
                props.append(child)
            node["props"] = props
            node["expandable"] = True
        finally:
            self.stack.pop()
        return node

    def _class(self, cls: type, path: list[str], expr: str, depth_left: int, tree: dict | None) -> dict:
        qual = getattr(cls, "__qualname__", None) or getattr(cls, "__name__", "class")
        node, circular = self._begin(cls, "class", "<class %s>" % qual, path, expr)
        if circular:
            return node
        if not self._should_expand(depth_left, tree):
            node["capped"] = True
            node["expandable"] = True
            return node
        self.stack.append(id(cls))
        try:
            props = []
            count = 0
            capped = False
            try:
                items = list(vars(cls).items())
            except Exception:  # noqa: BLE001
                items = []
            for name, val in items:
                if name.startswith("__") and name.endswith("__"):
                    continue
                if isinstance(val, (types.FunctionType, classmethod, staticmethod, property)):
                    continue
                if count >= self.limits.props:
                    capped = True
                    break
                sub = self._subtree(tree, name)
                child = self.node(val, self._child_path(path, name), "%s.%s" % (expr or qual, name), self._child_depth(depth_left, sub), sub)
                child["name"] = name
                if secrets.current.secret_name(name):
                    secrets.current.mask_leaf(child)
                props.append(child)
                count += 1
            node["props"] = props
            node["expandable"] = True
            if capped:
                node["cappedProps"] = True
                props.append(self._load_more(node, path))
        finally:
            self.stack.pop()
        return node

    def _exception(self, exc: BaseException, path: list[str], expr: str, depth_left: int, tree: dict | None) -> dict:
        tname = type(exc).__name__
        try:
            msg = str(exc)
        except BaseException:  # noqa: BLE001
            msg = ""
        preview = "%s(%s)" % (tname, short_repr(msg, 160)) if msg else "%s()" % tname
        node, circular = self._begin(exc, tname, preview, path, expr)
        if circular:
            return node
        if not self._should_expand(depth_left, tree):
            node["capped"] = True
            node["expandable"] = True
            return node
        self.stack.append(id(exc))
        try:
            props = []
            entries: list[tuple[str, Any]] = [("args", exc.args)]
            d = _instance_dict(exc)
            if d:
                entries.extend((k, v) for k, v in list(d.items())[: self.limits.props])
            if exc.__cause__ is not None:
                entries.append(("__cause__", exc.__cause__))
            elif exc.__context__ is not None and not exc.__suppress_context__:
                entries.append(("__context__", exc.__context__))
            tb = _tb_summary(exc)
            if tb:
                entries.append(("traceback", tb))
            for name, val in entries:
                sub = self._subtree(tree, name)
                child = self.node(val, self._child_path(path, name), "%s.%s" % (expr or "$", name), self._child_depth(depth_left, sub), sub)
                child["name"] = name
                if secrets.current.secret_name(name):
                    secrets.current.mask_leaf(child)
                props.append(child)
            node["props"] = props
            node["expandable"] = True
        finally:
            self.stack.pop()
        return node

    def _object(self, obj: Any, path: list[str], expr: str, depth_left: int, tree: dict | None, *, named_tuple: bool = False) -> dict:
        tname = type(obj).__name__
        node, circular = self._begin(obj, tname, short_repr(obj, PREVIEW_LEN), path, expr)
        if circular:
            return node
        entries = self._own_attributes(obj, named_tuple)
        if named_tuple:
            node["length"] = len(obj)
        if entries is None:
            # Nothing we can safely show beyond the repr.
            return node
        if not self._should_expand(depth_left, tree):
            node["capped"] = True
            node["expandable"] = True
            return node
        self.stack.append(id(obj))
        try:
            props = []
            capped = False
            for i, (name, val) in enumerate(entries):
                if i >= self.limits.props:
                    capped = True
                    break
                sub = self._subtree(tree, name)
                child = self.node(val, self._child_path(path, name), "%s.%s" % (expr or "$", name), self._child_depth(depth_left, sub), sub)
                child["name"] = name
                if secrets.current.secret_name(name):
                    secrets.current.mask_leaf(child)
                props.append(child)
            node["props"] = props
            node["expandable"] = True
            if capped:
                node["cappedProps"] = True
                props.append(self._load_more(node, path))
        finally:
            self.stack.pop()
        return node

    def _own_attributes(self, obj: Any, named_tuple: bool) -> list[tuple[str, Any]] | None:
        if named_tuple:
            fields = getattr(type(obj), "_fields", ())
            return [(name, obj[i]) for i, name in enumerate(fields)]
        entries: list[tuple[str, Any]] = []
        seen: set[str] = set()
        cls = type(obj)
        if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
            order = [f.name for f in dataclasses.fields(obj)]
        else:
            order = None
        d = _instance_dict(obj)
        if d is not None:
            if order:
                for name in order:
                    if name in d:
                        entries.append((name, d[name]))
                        seen.add(name)
            for name, val in list(d.items()):
                if name in seen or name.startswith("_pk_"):
                    continue
                entries.append((name, val))
                seen.add(name)
        found_slots = False
        for klass in cls.__mro__:
            for name in _slot_names(klass):
                found_slots = True
                if name in seen:
                    continue
                desc = vars(klass).get(name)
                if desc is None:
                    continue
                try:
                    val = desc.__get__(obj, klass)
                except AttributeError:
                    continue
                except Exception:  # noqa: BLE001
                    continue
                entries.append((name, val))
                seen.add(name)
        if self.resolve_getters:
            for klass in cls.__mro__:
                for name, member in list(vars(klass).items()):
                    if name in seen or not isinstance(member, property) or member.fget is None:
                        continue
                    try:
                        val = member.fget(obj)
                    except BaseException as exc:  # noqa: BLE001
                        val = "<getter raised %s>" % type(exc).__name__
                    entries.append((name, val))
                    seen.add(name)
        if d is None and not found_slots and not entries:
            return None
        return entries

    def _load_more(self, parent: dict, path: list[str]) -> dict:
        return {
            "type": "…",
            "value": "…",
            "loadActionNode": True,
            "name": "…",
            "id": parent["id"] + LOAD_MORE_SUFFIX,
            "queryPath": list(path),
        }


def serialize(
    obj: Any,
    limits: LogLimitSet,
    *,
    root_key: str = "0",
    hit: int = 0,
    depth: int | None = None,
    expand_tree: dict | None = None,
    registry: Registry | None = None,
    resolve_getters: bool = False,
    expression_root: str | None = None,
    query_path: list[str] | None = None,
    id_prefix: str | None = None,
) -> dict:
    """Serialize ``obj`` into a protocol value node."""
    ser = Serializer(
        limits,
        root_key=root_key,
        hit=hit,
        registry=registry,
        resolve_getters=resolve_getters,
        expression_root=expression_root,
        expand_tree=expand_tree,
        id_prefix=id_prefix,
    )
    return ser.root(obj, query_path, depth)
