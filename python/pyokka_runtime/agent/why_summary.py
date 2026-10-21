"""The summary above a provenance tree: one of three states, in sentences built from the tree's own fields.

``summarize(tree)`` reads a ``pyokka why`` result and says what the tree shows, in the first state that applies:

- ``answer``: a node of the chain was changed in place, through another name or a path of its own, and the
  recording saw it (a ``shared`` holding, ``resolution: seen``; the first breadth-first, so the root's own
  change comes first): where, by which statement, and since when the names share it. Below the root only a
  builtin container counts (its text a literal): the chain read its contents. An object changed in place
  (``self.opcodes = None``) is read for other attributes as often as for the changed one, so the fallback
  names it without saying it reached the value;
- ``signpost``: a parameter received a value that differs from the last value recorded for the argument the
  call passed (both builtin literals, neither cut): when and what, not who, and how to find out;
- ``fallback``: neither. The value and where, and what this recording could not see.

A sentence is a list of pieces: ``{"t"}`` plain words, ``{"name"}`` a name the tree has, ``{"value", "of",
"at", "path"?}`` a node's recorded text (or the part of it at ``path``), ``{"step", "file", "fileId", "line",
"function"?}`` a place the tree has, ``{"code"}`` a statement's source. ``validate(summary, tree)`` checks
every piece against the tree field for field, and ``summarize`` drops a sentence that fails, so a summary
says nothing the tree does not hold. The TypeScript twin is ``src/shared/whySummary.ts``; the fixture cases
pin both to the same summaries, so keep the rules and the wording identical.

A value is compared, or a part of it picked, only when its text is a builtin literal (``parse_literal``:
dicts, lists, tuples, sets, strings, numbers, None, True, False). An object's repr can change while the
object does not (``<ArgumentParser object>`` before ``__init__`` filled it in, ``ArgumentParser(prog=…)``
after), and a cut text (``…``) is not the whole value.
"""

from __future__ import annotations

import re
from typing import Any

from ..protocol import MAX_LOCALS_ENTRIES

VALUE_LIMIT = 60
# the fallback's two sentences that say no more than "nothing found": the text form leaves them out
NOTHING_FOUND = "Nothing in this chain changed through another name or differs from what a call received."
FOLLOWING_SHOWS_MORE = "This recording sees new values given to names, not changes inside objects: following objects can show more."
_OPAQUE = re.compile(r"^<[^<>]* object(?: at 0x[0-9a-f]+)?>$")
_NUMBER = re.compile(r"-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)")


# -- builtin literals ------------------------------------------------------------------------------------------

class _Bail(Exception):
    pass


def parse_literal(text: str) -> dict | None:
    """``text`` as a tree of builtin literals, each node with its ``kind``, its ``span`` in ``text`` and, for a
    container, its ``items`` (a dict's as ``(key, value)`` pairs); None for anything else, a cut text included."""
    if "…" in text:
        return None
    pos = [0]

    def ws() -> None:
        while pos[0] < len(text) and text[pos[0]] in " \t\n":
            pos[0] += 1

    def peek(ch: str) -> bool:
        ws()
        if pos[0] >= len(text):
            raise _Bail
        return text[pos[0]] == ch

    def comma_or(close: str) -> None:
        """After an item: a comma (then maybe the end), or the end itself."""
        if peek(","):
            pos[0] += 1
        elif not peek(close):
            raise _Bail

    def value() -> dict:
        ws()
        if pos[0] >= len(text):
            raise _Bail
        start, ch = pos[0], text[pos[0]]
        if ch in "[(":
            close, kind = ("]", "list") if ch == "[" else (")", "tuple")
            pos[0] += 1
            items: list = []
            ws()
            while not peek(close):
                items.append(value())
                comma_or(close)
            pos[0] += 1
            return {"kind": kind, "span": (start, pos[0]), "items": items}
        if ch == "{":
            pos[0] += 1
            ws()
            if peek("}"):
                pos[0] += 1
                return {"kind": "dict", "span": (start, pos[0]), "items": []}
            first = value()
            ws()
            if peek(":"):
                pos[0] += 1
                pairs = [(first, value())]
                comma_or("}")
                while not peek("}"):
                    key = value()
                    ws()
                    if not peek(":"):
                        raise _Bail
                    pos[0] += 1
                    pairs.append((key, value()))
                    comma_or("}")
                pos[0] += 1
                return {"kind": "dict", "span": (start, pos[0]), "items": pairs}
            members = [first]
            comma_or("}")
            while not peek("}"):
                members.append(value())
                comma_or("}")
            pos[0] += 1
            return {"kind": "set", "span": (start, pos[0]), "items": members}
        if ch in "'\"":
            pos[0] += 1
            while pos[0] < len(text) and text[pos[0]] != ch:
                pos[0] += 2 if text[pos[0]] == "\\" else 1
            if pos[0] >= len(text):
                raise _Bail
            pos[0] += 1
            return {"kind": "str", "span": (start, pos[0])}
        for word in ("None", "True", "False"):
            if text.startswith(word, start) and not (start + len(word) < len(text) and (text[start + len(word)].isalnum() or text[start + len(word)] == "_")):
                pos[0] += len(word)
                return {"kind": "const", "span": (start, pos[0])}
        m = _NUMBER.match(text, start)
        if m and m.end() > start:
            pos[0] = m.end()
            return {"kind": "number", "span": (start, pos[0])}
        raise _Bail

    try:
        out = value()
        ws()
        return out if pos[0] == len(text) else None
    except _Bail:
        return None


def _src(text: str, node: dict) -> str:
    return text[node["span"][0] : node["span"][1]]


def literal_diff(a: str, b: str) -> tuple[str, str, str] | None:
    """Where two literal texts first differ: ``(path, part of a, part of b)``, the path in Python's
    subscript form (``['lines'][0]['qty']``, ``''`` for the whole value); None when they are equal or
    either is not a literal."""
    ta, tb = parse_literal(a), parse_literal(b)
    if ta is None or tb is None:
        return None

    def walk(x: dict, y: dict, path: str) -> tuple[str, str, str] | None:
        sx, sy = _src(a, x), _src(b, y)
        if sx == sy:
            return None
        if x["kind"] != y["kind"] or x["kind"] not in ("dict", "list", "tuple") or len(x["items"]) != len(y["items"]):
            return path, sx, sy
        if x["kind"] == "dict":
            if [_src(a, k) for k, _ in x["items"]] != [_src(b, k) for k, _ in y["items"]]:
                return path, sx, sy
            for (k, vx), (_, vy) in zip(x["items"], y["items"]):
                found = walk(vx, vy, "%s[%s]" % (path, _src(a, k)))
                if found:
                    return found
            return path, sx, sy
        for i, (vx, vy) in enumerate(zip(x["items"], y["items"])):
            found = walk(vx, vy, "%s[%d]" % (path, i))
            if found:
                return found
        return path, sx, sy

    return walk(ta, tb, "")


def literal_part(text: str, path: str) -> str | None:
    """The part of a literal text at ``path`` (``['lines'][0]['qty']``), or None when it has none there."""
    node = parse_literal(text)
    if node is None:
        return None
    rest = path
    while rest:
        if not rest.startswith("["):
            return None
        if node["kind"] == "dict":
            hit = next(((k, v) for k, v in node["items"] if rest.startswith("[%s]" % _src(text, k))), None)
            if hit is None:
                return None
            rest = rest[len(_src(text, hit[0])) + 2 :]
            node = hit[1]
        elif node["kind"] in ("list", "tuple"):
            m = re.match(r"\[(\d+)\]", rest)
            if not m or int(m.group(1)) >= len(node["items"]):
                return None
            node = node["items"][int(m.group(1))]
            rest = rest[m.end() :]
        else:
            return None
    return _src(text, node)


# -- pieces ----------------------------------------------------------------------------------------------------

def _value(node: dict, path: str = "", text: str | None = None) -> dict:
    out = {"value": node["text"] if text is None else text, "of": node["name"], "at": node["step"]}
    if path:
        out["path"] = path
    return out


def _place(step: Any, where: dict) -> dict:
    out: dict[str, Any] = {"step": int(step)}
    for key in ("file", "fileId", "line"):
        if where.get(key) is not None:
            out[key] = where[key]
    if where.get("function"):
        out["function"] = where["function"]
    return out


def _nodes(tree: dict) -> list[tuple[dict, list[dict]]]:
    """Every node of the tree breadth-first, with the nodes above it (root first)."""
    out: list[tuple[dict, list[dict]]] = []
    queue: list[tuple[dict, list[dict]]] = [(tree["root"], [])]
    while queue:
        node, above = queue.pop(0)
        out.append((node, above))
        for r in node.get("reads") or []:
            if isinstance(r, dict):
                queue.append((r, above + [node]))
    return out


# -- the three states ------------------------------------------------------------------------------------------

def _answer(tree: dict) -> dict | None:
    root = tree["root"]
    for node, above in _nodes(tree):
        if not _changed_in_place(node) or (above and parse_literal(str(node.get("text") or "")) is None):
            continue  # below the root only a builtin container whose contents the chain read: an object's change may not reach the value
        s = node["shared"]
        if s.get("as") is not None:  # the change came through another name
            head = [{"name": s["path"]}, {"t": ", the same object as "}, {"name": s["as"]}, {"t": ", was changed at "}, _place(node["step"], node)]
        else:  # through a path of the name itself (`self.totals[k] = v` reaching `ledger.totals`)
            head = [{"name": s["path"]}, {"t": " was changed at "}, _place(node["step"], node)]
        if node.get("function"):
            head += [{"t": " in "}, {"name": node["function"]}]
        if node.get("statement"):
            head += [{"t": ": "}, {"code": node["statement"]}]
        details: list[list[dict]] = []
        if above and root.get("text") is not None and root.get("step") is not None:
            details.append([{"t": "It is an input of "}, {"name": root["name"]}, {"t": ", which is "}, _value(root), {"t": " at "}, _place(root["step"], root), {"t": "."}])
        if s.get("line") is not None and s.get("since") is not None:
            lead = [{"t": "They share it since "}] if s.get("as") is not None else [{"name": node["name"]}, {"t": " holds it since "}]
            details.append(lead + [_place(s["since"], s), {"t": "."}])
        for p in [*above, node]:
            arg = p.get("argument")
            if isinstance(arg, dict) and p.get("step") is not None:
                details.append([{"name": p["name"]}, {"t": " at "}, _place(p["step"], p), {"t": " is the "}, {"name": arg["text"]}, {"t": " passed at "}, _place(arg["step"], arg), {"t": "."}])
        return {"state": "answer", "headline": head + [{"t": "."}], "details": details}
    return None


def _changed_in_place(node: dict) -> bool:
    """A node the recording saw changed in place, through another name or a path of its own."""
    s = node.get("shared") or {}
    return bool(s.get("path")) and node.get("resolution") == "seen" and node.get("step") is not None


def _touched(node: dict) -> list[dict]:
    """The fallback's sentence for an object of the chain that was changed in place but is no answer."""
    s = node["shared"]
    out = [{"name": s["path"]}, {"t": " was changed in place at "}, _place(node["step"], node)]
    if node.get("statement"):
        out += [{"t": ": "}, {"code": node["statement"]}]
    return out + [{"t": ". The chain reads it, but this recording does not say whether that change reached this value."}]


def _signpost(tree: dict, follow_objects: bool, capped: bool) -> dict | None:
    for node, _ in _nodes(tree):
        arg = node.get("argument")
        if not isinstance(arg, dict) or node.get("text") is None or node.get("step") is None:
            continue
        passed = next((r for r in node.get("reads") or [] if isinstance(r, dict) and r.get("name") == arg["text"] and r.get("step") is not None and r.get("text") is not None), None)
        if passed is None:
            continue
        diff = literal_diff(str(passed["text"]), str(node["text"]))
        if diff is None:
            continue
        path, before, after = diff
        name = passed["name"]
        head = [{"name": name + path}, {"t": " was "}, _value(passed, path, before), {"t": " at "}, _place(passed["step"], passed),
                {"t": ", and "}, {"name": node.get("function") or "<module>"}, {"t": " received "}, _value(node, path, after), {"t": " as "}, {"name": node["name"] + path},
                {"t": " at "}, _place(node["step"], node), {"t": "."}]
        details: list[list[dict]] = []
        if tree.get("recordedLocals") is not False and not capped:
            # value_at gave the last change recorded before the call: there is none after it
            details.append([{"t": "This recording has no change of "}, {"name": name}, {"t": " between "}, _place(passed["step"], passed), {"t": " and the call at "}, _place(arg["step"], arg), {"t": "."}])
        if follow_objects:
            details.append([{"t": "Even following objects, no stepped statement changed it in between: it changed in code that was not stepped (a library, a C extension) or along a path the recording did not follow."}])
            return {"state": "signpost", "headline": head, "details": details}
        details.append([{"t": "This recording sees new values given to names, not changes inside an object. Record again following objects to see the line that changed it."}])
        return {"state": "signpost", "headline": head, "details": details, "action": "followObjects"}
    return None


def _fallback(tree: dict, follow_objects: bool, capped: bool) -> dict | None:
    root = tree["root"]
    if root.get("text") is None or root.get("step") is None:
        return None
    head = [{"name": root["name"] or "the statement"}, {"t": " is "}, _value(root), {"t": " at "}, _place(root["step"], root), {"t": "."}]
    nodes = [n for n, _ in _nodes(tree)]
    touched = next((n for n in nodes if _changed_in_place(n)), None)
    details: list[list[dict]] = [_touched(touched) if touched is not None else [{"t": NOTHING_FOUND}]]
    limits: list[str] = []
    if tree.get("recordedLocals") is False:
        limits.append("noLocals")
        details.append([{"t": "This run recorded no locals: only logged values are known."}])
    if capped:
        limits.append("cap")
        details.append([{"t": "The recording stopped keeping changes at its limit of %s entries, before this step." % format(MAX_LOCALS_ENTRIES, ",")}])
    opaque = next((n for n in nodes if n.get("text") is not None and n.get("step") is not None and _OPAQUE.match(str(n["text"]))), None)
    if opaque is not None and not follow_objects:
        limits.append("opaque")
        details.append([{"name": opaque["name"]}, {"t": " shows nothing inside it ("}, _value(opaque), {"t": "), so this recording cannot see what changed inside it."}])
    if "…" in str(root["text"]):
        limits.append("cut")
        details.append([{"t": "The value is cut: Rerun value gets all of it."}])
    if tree.get("truncated") or any(n.get("cut") for n in nodes):
        limits.append("chainCut")
        details.append([{"t": "The chain goes on past what is shown: ask why for a node's name at its step."}])
    if any(n.get("beforeRecording") for n in nodes):
        limits.append("beforeRecording")
        details.append([{"t": "Part of the chain was made before the recording started, at #0."}])
    if not follow_objects and "opaque" not in limits:
        details.append([{"t": FOLLOWING_SHOWS_MORE}])
    out: dict[str, Any] = {"state": "fallback", "headline": head, "details": details, "limits": limits}
    if not follow_objects:
        out["action"] = "followObjects"
    return out


def summarize(tree: dict, follow_objects: bool = False, capped: bool = False) -> dict | None:
    """The summary of a tree (module docstring), its sentences validated; None when the root has no recorded value."""
    root = tree.get("root") or {}
    if not root.get("name") or root.get("step") is None or root.get("text") is None:
        return None
    summary = _answer(tree) or _signpost(tree, follow_objects, capped) or _fallback(tree, follow_objects, capped)
    if summary is None or validate_sentence(summary["headline"], tree):
        return None
    summary["details"] = [d for d in summary["details"] if not validate_sentence(d, tree)]
    return summary


# -- the validator ---------------------------------------------------------------------------------------------

def _places(tree: dict) -> set[tuple]:
    out: set[tuple] = set()
    for node, _ in _nodes(tree):
        for where in (node, node.get("argument"), node.get("shared")):
            if not isinstance(where, dict):
                continue
            step = where.get("since") if where is node.get("shared") else where.get("step")
            if step is not None:
                out.add((int(step), where.get("file"), where.get("fileId"), where.get("line")))
    return out


def _names(tree: dict) -> set[str]:
    out: set[str] = set()
    for node, _ in _nodes(tree):
        out.update(str(x) for x in (node.get("name"), node.get("function")) if x)
        s = node.get("shared") or {}
        out.update(str(x) for x in (s.get("path"), s.get("as")) if x)
        if isinstance(node.get("argument"), dict):
            out.add(str(node["argument"]["text"]))
    return out


def validate_sentence(pieces: list[dict], tree: dict) -> list[str]:
    """What in a sentence the tree does not hold, as one problem per piece; empty when every piece checks."""
    problems: list[str] = []
    nodes = {(n.get("name"), n.get("step")): n for n, _ in _nodes(tree)}
    places = _places(tree)
    names = _names(tree)
    statements = {str(n["statement"]) for n, _ in _nodes(tree) if n.get("statement")}
    for p in pieces:
        if "value" in p:
            node = nodes.get((p.get("of"), p.get("at")))
            if node is None or node.get("text") is None:
                problems.append("no node %s at #%s" % (p.get("of"), p.get("at")))
            elif p.get("path"):
                if literal_part(str(node["text"]), str(p["path"])) != p["value"]:
                    problems.append("%s at #%s has no %s%s = %s" % (p["of"], p["at"], p["of"], p["path"], p["value"]))
            elif str(node["text"]) != p["value"]:
                problems.append("%s at #%s is not %s" % (p["of"], p["at"], p["value"]))
        elif "step" in p:
            if (int(p["step"]), p.get("file"), p.get("fileId"), p.get("line")) not in places:
                problems.append("no place #%s %s:%s" % (p["step"], p.get("file"), p.get("line")))
        elif "name" in p:
            base = re.split(r"[\[]", str(p["name"]), maxsplit=1)[0]
            if p["name"] not in names and base not in names:
                problems.append("no name %s" % p["name"])
        elif "code" in p:
            if p["code"] not in statements:
                problems.append("no statement %s" % p["code"])
    return problems


def validate(summary: dict | None, tree: dict) -> list[str]:
    """Every problem of every sentence of the summary (``validate_sentence``); empty for a summary ``summarize`` made."""
    if not summary:
        return []
    out = validate_sentence(summary["headline"], tree)
    for d in summary.get("details") or []:
        out += validate_sentence(d, tree)
    return out


# -- text ------------------------------------------------------------------------------------------------------

def _clip(text: str) -> str:
    s = " ".join(str(text).split("\n")).strip()
    return s if len(s) <= VALUE_LIMIT else s[: VALUE_LIMIT - 1] + "…"


def _short(path: Any) -> str:
    return re.split(r"[\\/]", str(path or ""))[-1] or "<unknown>"


def sentence_text(pieces: list[dict]) -> str:
    """A sentence as one line: values cut at 60 characters, places as ``#23 promo.py:4``, code as written."""
    out = []
    for p in pieces:
        if "value" in p:
            out.append(_clip(p["value"]))
        elif "step" in p:
            out.append("#%s %s:%s" % (p["step"], _short(p.get("file")), p.get("line") if p.get("line") is not None else "?"))
        elif "name" in p:
            out.append(str(p["name"]))
        elif "code" in p:
            out.append(str(p["code"]))
        else:
            out.append(str(p.get("t", "")))
    return "".join(out)


LABELS = {"answer": "answer", "signpost": "signpost", "fallback": "summary"}
ACTIONS = {"followObjects": "next: record again following objects (--follow-objects)"}


def summary_lines(summary: dict | None) -> list[str]:
    """The text form's lines for a summary: ``answer: …`` or ``signpost: …``, one indented line per detail, the action.
    A fallback says only the limits it found (its headline repeats the conclusion), as ``summary: …`` lines, and
    the action only when an object showed nothing inside it; a fallback that found none prints nothing."""
    if not summary:
        return []
    details = [sentence_text(d) for d in summary.get("details") or []]
    if summary["state"] == "fallback":
        notes = [d for d in details if d not in (NOTHING_FOUND, FOLLOWING_SHOWS_MORE)]
        if not notes:
            return []
        out = ["%s: %s" % (LABELS["fallback"], notes[0])] + ["  " + n for n in notes[1:]]
        if "opaque" in (summary.get("limits") or []) and summary.get("action") in ACTIONS:
            out.append("  " + ACTIONS[summary["action"]])
        return out
    out = ["%s: %s" % (LABELS[summary["state"]], sentence_text(summary["headline"]))] + ["  " + d for d in details]
    if summary.get("action") in ACTIONS:
        out.append("  " + ACTIONS[summary["action"]])
    return out


__all__ = ["summarize", "validate", "validate_sentence", "parse_literal", "literal_diff", "literal_part", "sentence_text", "summary_lines"]
