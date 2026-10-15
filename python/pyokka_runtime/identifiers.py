"""Lexical identities of a source's names: which scope each identifier belongs to, with UTF-16 offsets.

The browser page attaches a paused frame's values to the source: a hover on each identifier that
names the frame's binding, and a shadow next to the binding's declaration. A name alone is not
enough (a parameter ``x`` in one function and a module ``x`` are different bindings), so the
``bindings`` request with ``identifiers: true`` answers the scopes and every reference.

Scopes come from the AST (modules, ``def``, ``lambda``, ``class``, comprehensions); which names
are local to a ``def``, ``lambda``, ``class`` or the module comes from ``symtable`` (so ``global``
and ``nonlocal`` declarations, and a walrus in a comprehension, land where Python binds them).
A scope's ``parent`` is the scope its free names resolve in: a function or comprehension inside a
class body skips the class, as Python's name resolution does. Comprehension targets are local to
the comprehension, also on 3.12+ where ``symtable`` lists them with the enclosing function.

Offsets are UTF-16 code units into the exact ``source`` string (the page's JavaScript string
indices); the AST's columns are UTF-8 bytes and are converted per line. Nothing is evaluated.

A reference is ``declaration: true`` where it binds the name by the page's declaration rule:
assignment targets (``=``, ``+=``, annotated with a value, ``:=``, unpacking), parameters,
``for`` targets (comprehensions included) and ``with ... as`` targets.
"""

from __future__ import annotations

import ast
import re
import symtable

from .bindings import source_lines

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
_FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
_NAME_AFTER = re.compile(r"(?:async\s+)?(?:def|class)\s+")


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


class _Offsets:
    """UTF-8 byte columns per line -> UTF-16 offsets into the whole source."""

    def __init__(self, source: str) -> None:
        self.lines = source_lines(source)
        self.encoded = [line.encode("utf-8") for line in self.lines]
        self.starts: list[int] = []
        at = 0
        for line in self.lines:
            self.starts.append(at)
            at += _utf16_len(line)
        self.length = at

    def at(self, lineno: int, col: int) -> int:
        if lineno < 1:
            return 0
        if lineno > len(self.lines):
            return self.length
        return self.starts[lineno - 1] + _utf16_len(self.encoded[lineno - 1][:col].decode("utf-8", "replace"))


def _symbol_tables(source: str) -> dict[tuple[str, str, int], list[symtable.SymbolTable]]:
    """Every function and class table by ``(type, name, line)``, in source order, for matching AST nodes."""
    out: dict[tuple[str, str, int], list[symtable.SymbolTable]] = {}
    try:
        top = symtable.symtable(source, "<pyokka>", "exec")
    except (SyntaxError, ValueError):
        return out
    stack = [top]
    found: list[symtable.SymbolTable] = []
    while stack:
        t = stack.pop()
        found.append(t)
        stack.extend(reversed(t.get_children()))
    for t in found:
        kind = str(t.get_type()).lower().rsplit(".", 1)[-1]
        if kind in ("function", "class", "module"):
            out.setdefault((kind, t.get_name(), t.get_lineno()), []).append(t)
    return out


class _Walker:
    def __init__(self, source: str, tree: ast.Module) -> None:
        self.tree = tree
        self.offsets = _Offsets(source)
        self.tables = _symbol_tables(source)
        self.scopes: list[dict] = []
        self.references: list[dict] = []
        # where each name gets bound, for definitions.py: {name, scope, start, line, col, kind, node}
        self.sites: list[dict] = []
        # per scope: names the AST binds there directly, and the symbol table that says which are local
        self.bound: list[list[str]] = []
        self.table: list[symtable.SymbolTable | None] = []
        self.parents: dict[int, ast.AST] = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                self.parents[id(child)] = node
        module = self.tables.get(("module", "top", 0), [None])[0]
        self._new_scope(0, self.offsets.length, -1, None, module)

    # -- scopes ------------------------------------------------------------------------------------------
    def _new_scope(self, start: int, end: int, parent: int, kind: str | None, table: symtable.SymbolTable | None, name: str | None = None) -> int:
        scope: dict = {"start": start, "end": end, "parent": parent, "names": []}
        if kind == "function":
            scope["function"] = True
        elif kind == "class":
            scope["class"] = True
        elif kind == "comprehension":
            scope["comprehension"] = True
        if name is not None:
            scope["name"] = name
        self.scopes.append(scope)
        self.bound.append([])
        self.table.append(table)
        return len(self.scopes) - 1

    def _resolution_parent(self, scope: int) -> int:
        """Names free in a scope nested in a class body resolve past the class."""
        while scope >= 0 and self.scopes[scope].get("class"):
            scope = self.scopes[scope]["parent"]
        return scope

    def _owner(self, scope: int) -> int:
        """The scope a walrus binds in: the nearest one that is not a comprehension."""
        while scope > 0 and self.scopes[scope].get("comprehension"):
            scope = self.scopes[scope]["parent"]
        return scope

    def _table_for(self, kind: str, name: str, lineno: int) -> symtable.SymbolTable | None:
        queue = self.tables.get((kind, name, lineno))
        return queue.pop(0) if queue else None

    def _span(self, node: ast.AST) -> tuple[int, int]:
        return (self.offsets.at(node.lineno, node.col_offset), self.offsets.at(node.end_lineno or node.lineno, node.end_col_offset or 0))

    # -- references --------------------------------------------------------------------------------------
    def _ref(self, name: str, lineno: int, col: int, scope: int, path: list[str] | None = None, declaration: bool = False) -> None:
        start = self.offsets.at(lineno, col)
        ref: dict = {"start": start, "end": start + _utf16_len(name), "name": name, "scope": scope, "path": path or []}
        if declaration:
            ref["declaration"] = True
        self.references.append(ref)

    def _bind(self, scope: int, name: str) -> None:
        if name not in self.bound[scope]:
            self.bound[scope].append(name)

    def _site(self, name: str, scope: int, lineno: int, col: int, kind: str, node: ast.AST) -> None:
        self.sites.append({"name": name, "scope": scope, "start": self.offsets.at(lineno, col), "line": lineno, "col": col, "kind": kind, "node": node})

    def _named_header(self, node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef, scope: int) -> None:
        """``def NAME`` / ``class NAME``: the name's column is after the keyword on the header line."""
        line = self.offsets.encoded[node.lineno - 1] if node.lineno <= len(self.offsets.encoded) else b""
        text = line[node.col_offset:].decode("utf-8", "replace")
        m = _NAME_AFTER.match(text)
        col = node.col_offset
        if m and text[m.end():].startswith(node.name):
            col += len(text[: m.end()].encode("utf-8"))
            self._ref(node.name, node.lineno, col, scope)
        self._bind(scope, node.name)
        self._site(node.name, scope, node.lineno, col, "class" if isinstance(node, ast.ClassDef) else "def", node)

    def _path(self, node: ast.Name) -> list[str]:
        out: list[str] = []
        child: ast.AST = node
        parent = self.parents.get(id(child))
        while isinstance(parent, ast.Attribute) and parent.value is child:
            out.append(parent.attr)
            child, parent = parent, self.parents.get(id(parent))
        return out

    def _declares(self, node: ast.Name) -> bool:
        parent = self.parents.get(id(node))
        while isinstance(parent, (ast.Tuple, ast.List, ast.Starred)):
            parent = self.parents.get(id(parent))
        return not (isinstance(parent, ast.AnnAssign) and parent.value is None)

    # -- the walk ----------------------------------------------------------------------------------------
    def visit(self, node: ast.AST, scope: int) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self._named_header(node, scope)
            for d in node.decorator_list:
                self.visit(d, scope)
            self._outer_arguments(node.args, scope)
            if node.returns is not None:
                self.visit(node.returns, scope)
            start, end = self._span(node)
            child = self._new_scope(start, end, self._resolution_parent(scope), "function", self._table_for("function", node.name, node.lineno), node.name)
            self._parameters(node.args, child)
            for stmt in node.body:
                self.visit(stmt, child)
            return
        if isinstance(node, ast.Lambda):
            self._outer_arguments(node.args, scope)
            start, end = self._span(node)
            child = self._new_scope(start, end, self._resolution_parent(scope), "function", self._table_for("function", "lambda", node.lineno), "lambda")
            self._parameters(node.args, child)
            self.visit(node.body, child)
            return
        if isinstance(node, ast.ClassDef):
            self._named_header(node, scope)
            for d in node.decorator_list:
                self.visit(d, scope)
            for b in node.bases:
                self.visit(b, scope)
            for k in node.keywords:
                self.visit(k.value, scope)
            start, end = self._span(node)
            child = self._new_scope(start, end, self._resolution_parent(scope), "class", self._table_for("class", node.name, node.lineno), node.name)
            for stmt in node.body:
                self.visit(stmt, child)
            return
        if isinstance(node, _COMPREHENSIONS):
            # the first iterable runs in the enclosing scope; everything else in the comprehension's own
            gens = node.generators
            self.visit(gens[0].iter, scope)
            start, end = self._span(node)
            child = self._new_scope(start, end, self._resolution_parent(scope), "comprehension", None)
            for i, gen in enumerate(gens):
                if i:
                    self.visit(gen.iter, child)
                self.visit(gen.target, child)
                for cond in gen.ifs:
                    self.visit(cond, child)
            if isinstance(node, ast.DictComp):
                self.visit(node.key, child)
                self.visit(node.value, child)
            else:
                self.visit(node.elt, child)
            return
        if isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
            t = node.target
            self._ref(t.id, t.lineno, t.col_offset, scope, declaration=True)
            self._bind(self._owner(scope), t.id)
            self.visit(node.value, scope)
            return
        if isinstance(node, ast.Name):
            store = isinstance(node.ctx, (ast.Store, ast.Del))
            self._ref(node.id, node.lineno, node.col_offset, scope, [] if store else self._path(node), store and isinstance(node.ctx, ast.Store) and self._declares(node))
            if store:
                self._bind(scope, node.id)
                if isinstance(node.ctx, ast.Store):
                    self._site(node.id, scope, node.lineno, node.col_offset, "assign", node)
            return
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name == "*":
                    continue
                bound = alias.asname or alias.name.split(".")[0]
                self._bind(scope, bound)
                lineno, col = getattr(alias, "lineno", None) or node.lineno, getattr(alias, "col_offset", None)
                found = col is not None
                if col is None:
                    col = node.col_offset
                elif alias.asname:
                    text = self.offsets.encoded[lineno - 1][col:].decode("utf-8", "replace")
                    m = re.search(r"\bas\s+" + re.escape(alias.asname) + r"\b", text)
                    found = bool(m)
                    if m:
                        col += len(text[: m.end() - len(alias.asname)].encode("utf-8"))
                if found:
                    self._ref(bound, lineno, col, scope)
                self._site(bound, scope, lineno, col, "import", node)
                self.sites[-1]["alias"] = alias
            return
        if isinstance(node, ast.ExceptHandler):
            if node.name:
                self._bind(scope, node.name)
            for child in ast.iter_child_nodes(node):
                self.visit(child, scope)
            return
        if isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            self._bind(scope, node.name)
        if isinstance(node, ast.MatchMapping) and node.rest:
            self._bind(scope, node.rest)
        for child in ast.iter_child_nodes(node):
            self.visit(child, scope)

    def _outer_arguments(self, args: ast.arguments, scope: int) -> None:
        """Defaults and annotations run where the ``def`` / ``lambda`` is."""
        for d in [*args.defaults, *[d for d in args.kw_defaults if d is not None]]:
            self.visit(d, scope)
        for a in [*args.posonlyargs, *args.args, *([args.vararg] if args.vararg else []), *args.kwonlyargs, *([args.kwarg] if args.kwarg else [])]:
            if a.annotation is not None:
                self.visit(a.annotation, scope)

    def _parameters(self, args: ast.arguments, scope: int) -> None:
        for a in [*args.posonlyargs, *args.args, *([args.vararg] if args.vararg else []), *args.kwonlyargs, *([args.kwarg] if args.kwarg else [])]:
            self._ref(a.arg, a.lineno, a.col_offset, scope, declaration=True)
            self._bind(scope, a.arg)
            self._site(a.arg, scope, a.lineno, a.col_offset, "param", a)

    # -- result ------------------------------------------------------------------------------------------
    def finish(self) -> dict:
        declared_global: list[str] = []
        for i, scope in enumerate(self.scopes):
            table = self.table[i]
            names = self.bound[i]
            if table is not None:
                local: list[str] = []
                for n in names:
                    try:
                        sym = table.lookup(n)
                    except KeyError:
                        continue
                    if sym.is_local():
                        local.append(n)
                    elif sym.is_declared_global():
                        declared_global.append(n)  # `global g; g = 1` binds the module's g
                names = local
            scope["names"] = names
        module = self.scopes[0]["names"]
        module.extend(n for n in dict.fromkeys(declared_global) if n not in module)
        for ref in self.references:
            s = ref["scope"]
            while s >= 0 and ref["name"] not in self.scopes[s]["names"]:
                s = self.scopes[s]["parent"]
            ref["scope"] = s
        self.references.sort(key=lambda r: r["start"])
        return {"scopes": self.scopes, "references": self.references}


def walk_source(source: str) -> _Walker:
    """The finished walk: ``scopes``, ``references`` and the binding ``sites`` (definitions.py reads them)."""
    tree = ast.parse(source)
    walker = _Walker(source, tree)
    for stmt in tree.body:
        walker.visit(stmt, 0)
    walker.finish()
    return walker


def source_identifiers(source: str) -> dict:
    """``{scopes: [{start, end, parent, names, function?, class?, comprehension?, name?}], references: [{start, end, name, scope, path, declaration?}]}``.

    ``scope`` of a reference is the scope whose binding it names (-1: a builtin or an undefined
    name); ``path`` is the attribute chain read off a loaded name (``job.spec.seconds`` gives
    ``["spec", "seconds"]``). Raises ``SyntaxError`` when the source does not parse.
    """
    tree = ast.parse(source)
    walker = _Walker(source, tree)
    for stmt in tree.body:
        walker.visit(stmt, 0)
    return walker.finish()


__all__ = ["source_identifiers"]
