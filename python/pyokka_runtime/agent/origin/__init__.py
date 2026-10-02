"""Where a bad value was made (``pyokka origin``): a chain of steps from the failing statement back to its source.

``why`` stops at a function's parameter. ``origin`` keeps going across calls and containers:

- a parameter to the argument at the call site (the call is found in the call-site statement's
  AST and the parameter mapped by position or keyword),
- a name to the statement that bound it (``History.value_at``, the recorded locals),
- a call result to the callee's ``return`` and the expression it returned,
- an element of a container to the statement that put it there,
- down to a literal, or to a value computed from more than one input.

Every value on a link comes from the recording. The links do not all have the same footing,
because the recording keeps a value's text, not its identity, and each link says which kind it is:

- ``recorded``: the step, the statement and the value are in the recording and the link between
  them is structural (an argument mapped to its parameter, a call to the scope it entered).
- ``inferred``: picked by value among structural candidates (the branch of ``a if c else b``
  whose value is the one carried, the input of a one-input expression, the ``append`` or
  ``{"key": v}`` whose key and value text match). Two objects with the same text can fool it.
- ``text match``: only the text says so (the line of a multi-line literal).

The root is the first link, walking forward in time, from which the value has the form that
failed. When the same statement produced a value of a type that fits on its other runs (the
same function returned ``float`` five times and ``str`` once), that statement is the root and
the reason says so; otherwise it is the earliest link that already carries the failing value.
``docs/design/origin.md`` has the ablation behind these rules.
"""

from __future__ import annotations

import ast
from typing import TYPE_CHECKING, Any

from ..reprs import parse, path_text, project, text_of, type_of, type_of_value
from .need import Need, need_from_error
from .walk import ORIGIN_DEPTH, ORIGIN_MAX_DEPTH, OriginBuilder

if TYPE_CHECKING:
    from ..source import SavedRun


def _error_at(run: "SavedRun", step: int) -> dict | None:
    rid = run.trace.rid(step)
    best = None
    for ev in run.errors:
        if ev.get("step") is None:
            continue
        first, last = int(ev["step"]), int(ev.get("lastStep", ev["step"]))
        if first == step or (int(ev.get("rid", -1)) == rid and first <= step <= last):
            best = ev
            if first == step:
                break
    return best


def origin(run: "SavedRun", step: int, expr: str = "", depth: int = ORIGIN_DEPTH) -> dict:
    """The chain from the value at ``step`` back to where it was made (``docs/design/origin.md``)."""
    b = OriginBuilder(run, depth)
    out: dict[str, Any] = {**b.history.location(step), "statement": b.statement(step), "recordedLocals": bool(run.locals_entries), "links": [], "root": None, "truncated": False}
    error = _error_at(run, step)
    need: Need | None = None
    if error is not None:
        out["error"] = {"type": str(error.get("errorType") or ""), "message": str(error.get("message") or ""), "caught": bool(error.get("handled"))}
        need = need_from_error(out["error"]["type"], out["error"]["message"])
    if not run.locals_entries:
        out["end"] = "this run recorded no locals, so values cannot be followed back"
        out["hint"] = "save the run again with locals: `pyokka run FILE --save run.json --record-locals`"
        return out
    picked: dict | None = None
    if expr.strip():
        try:
            tree = ast.parse(expr.strip(), mode="eval").body
        except SyntaxError:
            tree = None
        node = b.stmt(step)
        comp = b.comprehension_targets(node) if node is not None else {}
        hits = b.evaluate(tree, step, comp) if isinstance(tree, (ast.Name, ast.Subscript)) else []
        if need is not None and need.kind == "type":
            hits = [h for h in hits if type_of_value(h[2]) == need.bad] or hits
        if not hits:
            out["end"] = "%s has no recorded value at #%d; give a name or a subscript of one (items[0][\"price\"])" % (expr.strip(), step)
            out["reads"] = [r for r in b.history.reads_for(step) if type_of(r.get("text")) != "function" and not str(r.get("text", "")).startswith("<class ")]
            return out
        base, path, value = hits[0]
        text = text_of(value)
        if text is None:
            found = b.value(base, step)
            text = text_of(project(parse(found.get("text")), path)) if path else found.get("text")
        picked = {"expr": path_text(base, path), "base": base, "path": path, "text": text, "chosen": "named"}
        if need is not None and (type_of(text) != need.bad if need.kind == "type" else need.fits(text) is not False):
            need = None  # the named value is not the one the error is about, so the error says nothing of its form
    elif need is not None:
        picked = b.pick(step, need, out["error"]["type"])
    if picked is None:
        out["reads"] = [r for r in b.history.reads_for(step) if type_of(r.get("text")) != "function" and not str(r.get("text", "")).startswith("<class ")]
        if error is None:
            out["end"] = "no exception at #%d: give EXPR, one of the values the statement read" % step
        else:
            out["end"] = "could not tell which value the %s is about: give EXPR, one of the values the statement read" % out["error"]["type"]
        return out
    out["value"] = {"expr": picked["expr"], "text": picked["text"], "type": type_of(picked["text"]), "chosen": picked["chosen"]}
    if need is not None and need.describe():
        out["need"] = need.describe()
    b.add(step, picked["expr"], picked["text"], "read", "recorded", note="the failing statement reads it" if error is not None else "read here")
    b.follow_name(picked["base"], list(picked["path"]), step, picked["text"])
    root = b.mark_root(need, failing=error is not None)
    for link in b.links:
        link.pop("scopeReturned", None)
        link.pop("_sib", None)
    out["links"] = b.links
    out["root"] = root
    out["truncated"] = b.truncated
    out["end"] = "the chain is longer than %d links; raise --depth" % b.depth if b.truncated else b.end
    if root is None and b.links:
        out["rootUnknown"] = "the chain stops before a statement that made the value, so its root is not known"
    return out


__all__ = ["origin", "OriginBuilder", "Need", "need_from_error", "ORIGIN_DEPTH", "ORIGIN_MAX_DEPTH"]
