"""The browser page's Scratchpad: experiments seeded from a live pause, run in a fresh ``python -I``.

The page bridge calls ``python -m pyokka_runtime _scratch`` with one JSON request on stdin:

``prepare``  the function around a line, as a copy that calls itself with the paused names (``ast``)
``seed``     the pause's ValueNode trees as Inputs source: Python literals ``ast.literal_eval`` rebuilds
             exactly, and an ``unavailable`` reason for every value it cannot (an object, a function,
             a cut string, a capped list): those are reported, never approximated
``format``   check and tidy experiment code (``tokenize``)
``run``      the experiment in scratchpad_child.py under ``python -I``, with the source file's
             top-level imports, functions, classes and assignments it names copied in (not its
             ``__main__`` block), Inputs bound, Mocks applied with ``unittest.mock``, a 5 s limit,
             and on macOS ``sandbox-exec`` denying every network operation

Stdlib only. Nothing here touches the paused program: it is a separate process with no shared
state, environment credentials or network.
"""

from __future__ import annotations

import ast
import io
import json
import os
import subprocess
import sys
import textwrap
import threading
import tokenize
from typing import Any

MAX_CODE = 100_000
TIMEOUT_S = 5.0
MAX_STREAM = 128_000
MAX_RESULT = 2_000_000
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)"
CHILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scratchpad_child.py")


class ScratchError(Exception):
    pass


# ---------------------------------------------------------------- prepare


def prepare(source: str, line: int) -> dict:
    """The innermost function around ``line`` as standalone code ending in ``result = name(params)``."""
    tree = ast.parse(source)
    parents: dict[int, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node
    around = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno <= line <= (n.end_lineno or n.lineno)]
    found = None
    if around:
        fn = max(around, key=lambda n: n.lineno)
        owner = parents.get(id(fn))
        found = (fn, owner if isinstance(owner, ast.ClassDef) else None)
    lines = source.splitlines()
    if found is None:
        stmt = next((s for s in tree.body if s.lineno <= line <= (s.end_lineno or s.lineno)), None)
        text = "\n".join(lines[stmt.lineno - 1 : stmt.end_lineno]) if stmt else ""
        return {"code": "# The paused statement; the pause's values are in Inputs.\n%s\n" % textwrap.dedent(text), "parameters": []}
    fn, owner = found
    code = textwrap.dedent("\n".join(lines[fn.lineno - 1 : fn.end_lineno]))
    a = fn.args
    params = [p.arg for p in (*a.posonlyargs, *a.args)]
    call = list(params)
    if a.vararg:
        params.append(a.vararg.arg)
        call.append("*" + a.vararg.arg)
    for p in a.kwonlyargs:
        params.append(p.arg)
        call.append("%s=%s" % (p.arg, p.arg))
    if a.kwarg:
        params.append(a.kwarg.arg)
        call.append("**" + a.kwarg.arg)
    static = any(isinstance(d, ast.Name) and d.id == "staticmethod" for d in fn.decorator_list)
    receiver = owner is not None and not static and bool(params) and params[0] in ("self", "cls")
    awaited = "await " if isinstance(fn, ast.AsyncFunctionDef) else ""
    code = "%s\n\n\nresult = %s%s(%s)\n" % (code, awaited, fn.name, ", ".join(call))
    return {"code": code, "name": fn.name, "parameters": params, **({"requiresReceiver": True, "className": owner.name} if receiver else {})}


# ---------------------------------------------------------------- seed

#: ValueNode types whose text the runtime's serializer writes as a Python literal
_SCALARS = {"None", "bool", "number", "str", "bytes"}
_CONTAINERS = {"list": ("[", "]"), "tuple": ("(", ")"), "set": ("{", "}"), "frozenset": ("frozenset({", "})"), "dict": ("{", "}")}


class Unrebuildable(Exception):
    pass


def literal(node: dict, at: str) -> str:
    """Python source for a captured ValueNode, or Unrebuildable naming the part a fresh process cannot rebuild."""
    t = node.get("type")
    if node.get("secret"):
        raise Unrebuildable("%s is masked as a secret" % at)
    if node.get("circular"):
        raise Unrebuildable("%s refers back to itself" % at)
    if t in _SCALARS:
        if t == "str":
            if node.get("capped") is not None and node.get("capped") is not False:
                raise Unrebuildable("%s is a string cut at %d of %s characters" % (at, len(str(node.get("value", ""))), node.get("length", "?")))
            text = repr(node.get("value", ""))
        else:
            text = str(node.get("value", ""))
            if node.get("nan") or node.get("positiveInfinity") or node.get("negativeInfinity"):
                raise Unrebuildable("%s is %s, which has no literal" % (at, text))
        try:
            value = ast.literal_eval(text)
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            raise Unrebuildable("%s was captured only as the preview %s" % (at, text)) from None
        if t == "bytes" and len(value) != node.get("length", len(value)):
            raise Unrebuildable("%s is bytes cut at %d of %d" % (at, len(value), node["length"]))
        return text
    if t in _CONTAINERS:
        props = [p for p in node.get("props") or [] if not p.get("loadActionNode")]
        if node.get("props") is None and node.get("length", 0) != 0:
            raise Unrebuildable("%s was not expanded at the pause" % at)
        if node.get("cappedElements") or node.get("cappedProps") or len(props) != node.get("length", len(props)):
            raise Unrebuildable("%s holds %s items and %d were captured" % (at, node.get("length", "?"), len(props)))
        if t == "dict":
            parts = []
            for p in props:
                key = p.get("keyRepr") or repr(p.get("name"))
                try:
                    hash(ast.literal_eval(key))
                except Exception:  # noqa: BLE001
                    raise Unrebuildable("%s has the key %s, which is not a literal" % (at, key)) from None
                parts.append("%s: %s" % (key, literal(p, "%s[%s]" % (at, key))))
        else:
            parts = [literal(p, "%s[%d]" % (at, i)) for i, p in enumerate(props)]
        if t == "set" and not parts:
            return "set()"
        if t == "frozenset" and not parts:
            return "frozenset()"
        if t == "tuple" and len(parts) == 1:
            return "(%s,)" % parts[0]
        open_, close = _CONTAINERS[t]
        return open_ + ", ".join(parts) + close
    kind = {"function": "a function", "class": "a class", "module": "a module (import it in the experiment)"}.get(str(t))
    raise Unrebuildable("%s is %s" % (at, kind or "a %s object; a fresh process cannot rebuild it from its captured fields" % t))


_LITERAL_NODES = (ast.Expression, ast.Constant, ast.List, ast.Tuple, ast.Set, ast.Dict, ast.Load, ast.UnaryOp, ast.USub, ast.UAdd, ast.BinOp, ast.Add, ast.Sub)


def rebuild(text: str) -> Any:
    """The value a seed's text stands for: a literal, where ``frozenset(...)``/``set()`` are the only calls allowed."""
    tree = ast.parse(text, mode="eval")
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if not (isinstance(node.func, ast.Name) and node.func.id in ("set", "frozenset") and not node.keywords and len(node.args) <= 1):
                raise ValueError("not a literal: %s" % ast.unparse(node))
        elif isinstance(node, ast.Name):
            if node.id not in ("set", "frozenset"):
                raise ValueError("not a literal: %s" % node.id)
        elif not isinstance(node, _LITERAL_NODES):
            raise ValueError("not a literal: %s" % type(node).__name__)
    return eval(compile(tree, "<seed>", "eval"), {"__builtins__": {}, "set": set, "frozenset": frozenset})


def seed(values: dict[str, Any]) -> dict:
    """Inputs source for the pause's values (name -> ValueNode or None), and why each other value is left out."""
    lines: list[str] = []
    unavailable: dict[str, str] = {}
    for name, node in values.items():
        if not name.isidentifier():
            continue
        if not isinstance(node, dict):
            unavailable[name] = "%s has no captured value" % name
            continue
        try:
            text = literal(node, name)
            # the text is a literal that rebuilds the value; anything else was refused above
            rebuild(text)
            lines.append("%s = %s" % (name, text))
        except Unrebuildable as exc:
            unavailable[name] = str(exc)
        except RecursionError:
            unavailable[name] = "%s is nested too deeply" % name
    for name, reason in unavailable.items():
        lines.append("# %s: unavailable, %s" % (name, reason))
    return {"inputs": "\n".join(lines) + ("\n" if lines else ""), "unavailable": unavailable}


# ---------------------------------------------------------------- format


def format_code(code: str) -> str:
    """Check the code parses; drop trailing blanks (outside strings), keep at most two blank lines in a row, end with one newline."""
    if not isinstance(code, str) or len(code) > MAX_CODE:
        raise ScratchError("scratchpad code is a string of at most %d characters" % MAX_CODE)
    try:
        ast.parse(code, "<scratchpad>")
    except SyntaxError as exc:
        raise ScratchError("line %s: %s" % (exc.lineno, exc.msg)) from None
    keep: set[int] = set()
    for tok in tokenize.generate_tokens(io.StringIO(code).readline):
        if tok.type == tokenize.STRING and tok.start[0] != tok.end[0]:
            keep.update(range(tok.start[0], tok.end[0]))
        elif tok.type == getattr(tokenize, "FSTRING_MIDDLE", -1) and tok.start[0] != tok.end[0]:
            keep.update(range(tok.start[0], tok.end[0]))
    out: list[str] = []
    blank = 0
    for i, text in enumerate(code.splitlines(), start=1):
        if i not in keep:
            text = text.rstrip()
        blank = blank + 1 if not text else 0
        if blank <= 2:
            out.append(text)
    while out and not out[-1]:
        out.pop()
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- dependencies


# a top-level block whose branches bind names: `try: from .m import f` / `except ImportError: from m import f`, `if TYPE_CHECKING:`
_BLOCKS = tuple(t for t in (ast.Try, getattr(ast, "TryStar", None), ast.If, ast.With) if t is not None)


def _branches(stmt: ast.stmt) -> list[ast.stmt]:
    out = [*getattr(stmt, "body", []), *getattr(stmt, "orelse", []), *getattr(stmt, "finalbody", [])]
    for handler in getattr(stmt, "handlers", []):
        out.extend(handler.body)
    return out


def _bound(stmt: ast.stmt) -> list[str]:
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [stmt.name]
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return [(a.asname or a.name).split(".")[0] for a in stmt.names if a.name != "*"]
    if isinstance(stmt, _BLOCKS):
        # the whole block is copied, so each branch binds as it would in the program
        return [name for child in _branches(stmt) for name in _bound(child)]
    targets: list[ast.expr] = []
    if isinstance(stmt, ast.Assign):
        targets = list(stmt.targets)
    elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
        targets = [stmt.target]
    return [n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)]


def _used(tree: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}


def dependencies(source: str, own: set[str], used: set[str]) -> str:
    """The source's top-level statements that bind a name ``used`` names (transitively), not ``own`` ones,
    blanked elsewhere so each keeps its line number in the original file."""
    tree = ast.parse(source)
    binds: dict[str, list[ast.stmt]] = {}
    for stmt in tree.body:
        for name in _bound(stmt):
            binds.setdefault(name, []).append(stmt)
    chosen: set[int] = set()
    todo = [n for n in used if n not in own]
    seen: set[str] = set()
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        for stmt in binds.get(name, []):
            if id(stmt) not in chosen:
                chosen.add(id(stmt))
                todo.extend(n for n in _used(stmt) if n not in own)
    lines = source.splitlines()
    out = [""] * len(lines)
    for stmt in tree.body:
        future = isinstance(stmt, ast.ImportFrom) and stmt.module == "__future__"
        if id(stmt) in chosen or future:
            start = min([stmt.lineno, *(d.lineno for d in getattr(stmt, "decorator_list", []))])
            for i in range(start - 1, stmt.end_lineno or stmt.lineno):
                out[i] = lines[i]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- run


def network_sandbox() -> dict:
    if sys.platform == "darwin" and os.path.exists(SANDBOX_EXEC):
        return {"network": "denied", "how": "macOS sandbox-exec (deny network*)"}
    return {"network": "open", "how": "no network sandbox on %s: only macOS sandbox-exec is supported, so the experiment can reach the network" % sys.platform}


def _read(stream: Any, limit: int, into: list[bytes], over: threading.Event) -> None:
    size = 0
    for chunk in iter(lambda: stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536), b""):
        size += len(chunk)
        if size > limit:
            over.set()
            continue
        into.append(chunk)


def run(request: dict) -> dict:
    file = request.get("file")
    code = request.get("code")
    if not isinstance(file, str) or not os.path.isfile(file):
        raise ScratchError("a scratchpad runs beside a source file; %r is not one" % (file,))
    if not isinstance(code, str) or len(code) > MAX_CODE:
        raise ScratchError("scratchpad code is a string of at most %d characters" % MAX_CODE)
    inputs = request.get("inputs") or ""
    mocks = request.get("mocks") or ""
    unavailable = request.get("unavailable") or {}
    if not isinstance(inputs, str) or not isinstance(mocks, str) or not isinstance(unavailable, dict):
        raise ScratchError("inputs and mocks are Python source text, unavailable an object")
    python = request.get("python") or sys.executable
    sandbox = network_sandbox()
    try:
        own: set[str] = set(unavailable)
        used: set[str] = set()
        for text, mode in ((code, "exec"), (inputs, "exec"), (mocks, "eval")):
            if not text.strip():
                continue
            tree = ast.parse(text, mode=mode)
            used |= _used(tree)
            if mode == "exec":
                own |= {n for s in tree.body for n in _bound(s)}
        if mocks.strip():
            m = ast.parse(mocks, mode="eval").body
            if isinstance(m, ast.Dict):
                own |= {k.value for k in m.keys if isinstance(k, ast.Constant) and isinstance(k.value, str) and "." not in k.value}
        with open(file, encoding="utf-8") as fh:
            deps = dependencies(fh.read(), own, used)
    except SyntaxError as exc:
        where = {"<unknown>": "the code"}.get(str(exc.filename), "the code")
        return {"values": [], "output": "", "error": {"type": "SyntaxError", "message": "%s, line %s: %s" % (where, exc.lineno, exc.msg), "stage": "code", "line": exc.lineno}, "sandbox": sandbox}
    payload = json.dumps({"file": os.path.abspath(file), "code": code, "inputs": inputs, "mocks": mocks, "unavailable": unavailable, "dependencies": deps}).encode("utf-8")
    read_fd, write_fd = os.pipe()
    argv = [python, "-I", CHILD, "--result-fd", str(write_fd)]
    if sandbox["network"] == "denied":
        argv = [SANDBOX_EXEC, "-p", SANDBOX_PROFILE, *argv]
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": os.environ.get("LANG", "en_US.UTF-8")}
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=os.path.dirname(os.path.abspath(file)), env=env, pass_fds=(write_fd,), start_new_session=True)
    finally:
        os.close(write_fd)
    result_parts: list[bytes] = []
    out_parts: list[bytes] = []
    over = threading.Event()
    stream_over = threading.Event()
    result_file = os.fdopen(read_fd, "rb")
    readers = [
        threading.Thread(target=_read, args=(result_file, MAX_RESULT, result_parts, over), daemon=True),
        threading.Thread(target=_read, args=(proc.stdout, MAX_STREAM, out_parts, stream_over), daemon=True),
        threading.Thread(target=_read, args=(proc.stderr, MAX_STREAM, out_parts, stream_over), daemon=True),
    ]
    for t in readers:
        t.start()
    timed_out = False
    try:
        proc.stdin.write(payload)  # type: ignore[union-attr]
        proc.stdin.close()  # type: ignore[union-attr]
    except BrokenPipeError:
        pass
    try:
        proc.wait(TIMEOUT_S)
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        # the experiment's whole session goes with it, subprocesses it started included
        try:
            os.killpg(proc.pid, 9)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()
    for t in readers:
        t.join(2)
    result_file.close()
    stray = b"".join(out_parts).decode("utf-8", "replace")
    if timed_out:
        return {"values": [], "output": stray, "error": {"type": "TimeoutError", "message": "the experiment ran past %g s and was stopped" % TIMEOUT_S, "stage": "code"}, "sandbox": sandbox}
    if over.is_set():
        return {"values": [], "output": "", "error": {"type": "ScratchError", "message": "the experiment's result was larger than %d bytes" % MAX_RESULT, "stage": "code"}, "sandbox": sandbox}
    raw = b"".join(result_parts).decode("utf-8", "replace").strip()
    if not raw:
        return {"values": [], "output": stray, "error": {"type": "ScratchError", "message": "the experiment's process ended (exit %s) without a result: %s" % (proc.returncode, stray[-1500:].strip()), "stage": "process"}, "sandbox": sandbox}
    result = json.loads(raw)
    if stray:
        # what subprocesses or os.write(1, ...) printed past sys.stdout
        result["output"] = (result.get("output") or "") + stray
    result["sandbox"] = sandbox
    result["isolation"] = "python -I, a new process: no state, environment variables or credentials shared with the paused program"
    return result


def handle(request: dict) -> Any:
    op = request.get("op")
    if op == "prepare":
        with open(str(request.get("file")), encoding="utf-8") as fh:
            return prepare(fh.read(), int(request.get("line") or 1))
    if op == "seed":
        values = request.get("values")
        if not isinstance(values, dict):
            raise ScratchError("seed needs values: {name: ValueNode}")
        return seed(values)
    if op == "format":
        return {"code": format_code(request.get("code"))}
    if op == "run":
        return run(request)
    if op == "sandbox":
        return network_sandbox()
    raise ScratchError("unknown scratchpad op %r: prepare, seed, format, run, sandbox" % (op,))


def main() -> int:
    """``_scratch``: one JSON request on stdin, one JSON answer on stdout (``{"error": ...}`` on failure)."""
    try:
        answer = handle(json.load(sys.stdin))
    except (ScratchError, OSError, ValueError, SyntaxError) as exc:
        print(json.dumps({"error": str(exc)}))
        return 1
    print(json.dumps(answer))
    return 0


__all__ = ["prepare", "seed", "format_code", "dependencies", "run", "network_sandbox", "handle", "main"]
