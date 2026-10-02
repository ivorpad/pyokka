"""The closing sentence of a provenance tree: the answer in words, built from the tree alone.

``conclusion(tree)`` reads the root of a ``pyokka why`` result and its first level (the reads
with recorded values, the stepped calls) and writes two sentences at most: what the value is
and where, then the one cause the tree supports. Nothing here guesses: a clause appears only
when the tree recorded the value it names, and a root without a recorded value says nothing.
The TypeScript twin is ``provenanceConclusion`` in ``src/shared/provenanceText.ts``; both are
pinned to the same trees by ``test/unit/fixtures/provenance.json``, so keep the rules and the
wording identical.

Rules, in order, the first that applies wins:
1. the root: ``NAME is VALUE at #STEP (file.py:LINE)``;
2. a conditional expression whose arm is known: ``The else arm ran: TEST is VALUE`` when the
   test is a name with a recorded value, or ``The else arm ran: TEST was false, since A is X``
   when the produced value is the arm's literal; ``since`` names up to two recorded reads of
   the test;
3. a stepped call with a recorded return: ``f(args) returned VALUE``, plus ``with P = None``
   for the first parameter recorded as None or empty;
4. a plain copy ``x = y`` of one recorded read: ``It copies y, which has been VALUE since #STEP
   (file.py:LINE)``;
5. a ``.get(...)`` or subscript that produced None from a recorded container: ``EXPR is None:
   the key is not in CONTAINER (N keys)``, the count when the recorded text is a whole dict;
6. otherwise ``It reads a = X, b = Y`` for up to three recorded reads.
Values are one line cut at 60 characters, as the panel shows them.
"""

from __future__ import annotations

import re
from typing import Any

VALUE_LIMIT = 60
FALSY = {"False", "None", "0", "0.0", "''", '""', "[]", "{}", "()", "set()"}
NONE_OR_EMPTY = {"None", "''", '""', "[]", "{}", "()", "set()", "frozenset()", "b''", 'b""'}
KEYWORDS = {"and", "or", "not", "is", "in", "if", "else", "None", "True", "False", "lambda", "for"}
_NAME = re.compile(r"^[A-Za-z_][\w.]*$")
_IDENT = re.compile(r"(?<![\w.])[A-Za-z_]\w*")
_STRING = re.compile(r"'[^']*'|\"[^\"]*\"")


def clip(text: Any) -> str:
    s = " ".join(str(text if text is not None else "").split("\n")).strip()
    return s if len(s) <= VALUE_LIMIT else s[: VALUE_LIMIT - 1] + "…"


def short_file(path: Any) -> str:
    parts = re.split(r"[\\/]", str(path or ""))
    return parts[-1] or "<unknown>"


def where(node: dict) -> str:
    return "#%s (%s:%s)" % (node.get("step"), short_file(node.get("file")), node.get("line") if node.get("line") is not None else "?")


def conclusion(tree: dict) -> str:
    root = tree.get("root") or {}
    name = root.get("name")
    if not name or root.get("step") is None or root.get("text") is None:
        return ""
    first = "%s is %s at %s" % (name, clip(root["text"]), where(root))
    reads = [r for r in root.get("reads") or [] if isinstance(r, dict) and r.get("text") is not None]
    calls = [c for c in root.get("calls") or [] if isinstance(c, dict)]
    second = _conditional(root, reads) or _call(root, calls) or _copy(root, reads) or _lookup(root, reads) or _reads(reads)
    return first + "." + (" " + second + "." if second else "")


def _rhs(statement: str) -> str:
    """The expression after the first ``=`` of an assignment (``==`` is not one); the statement itself otherwise."""
    m = re.search(r"(?<![=!<>])=(?!=)", statement)
    return statement[m.end() :].strip() if m else statement.strip()


def _names(text: str) -> list[str]:
    seen: list[str] = []
    for ident in _IDENT.findall(_STRING.sub("''", text)):
        if ident not in KEYWORDS and ident not in seen:
            seen.append(ident)
    return seen


def _since(test: str, reads: list[dict], skip: str | None) -> str:
    by_name = {r["name"]: r for r in reads}
    parts = ["%s is %s" % (n, clip(by_name[n]["text"])) for n in _names(test) if n != skip and n in by_name][:2]
    return ", since " + " and ".join(parts) if parts else ""


def _conditional(root: dict, reads: list[dict]) -> str:
    statement = str(root.get("statement") or "")
    rhs = _rhs(statement)
    if " if " not in rhs or " else " not in rhs:
        return ""
    if_arm, rest = rhs.split(" if ", 1)
    if " else " not in rest:
        return ""
    test, else_arm = rest.split(" else ", 1)
    test, if_arm, else_arm = test.strip(), if_arm.strip(), else_arm.strip()
    by_name = {r["name"]: r for r in reads}
    if _NAME.match(test) and test in by_name:
        text = str(by_name[test]["text"])
        arm = "else" if text in FALSY else "if"
        return "The %s arm ran: %s is %s%s" % (arm, test, clip(text), _since(test, reads, test))
    value = str(root.get("text"))
    if value == else_arm:
        return "The else arm ran: %s was false%s" % (test, _since(test, reads, None))
    if value == if_arm:
        return "The if arm ran: %s was true%s" % (test, _since(test, reads, None))
    return ""


def _call_text(statement: str, name: str) -> str:
    m = re.search(r"((?:[A-Za-z_]\w*\.)*%s)\(" % re.escape(name), statement)
    if not m:
        return "%s(...)" % name
    depth = 0
    for i in range(m.end() - 1, len(statement)):
        ch = statement[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return statement[m.start() : i + 1]
    return statement[m.start() :]


def _call(root: dict, calls: list[dict]) -> str:
    for call in calls:
        if call.get("result") is None:
            continue
        text = "%s returned %s" % (_call_text(str(root.get("statement") or ""), str(call.get("name"))), clip(call["result"]))
        for arg in call.get("inputs") or []:
            if isinstance(arg, dict) and arg.get("text") is not None and str(arg["text"]) in NONE_OR_EMPTY:
                text += " with %s = %s" % (arg.get("name"), arg.get("text"))
                break
        return text
    return ""


def _copy(root: dict, reads: list[dict]) -> str:
    earlier = [r for r in reads if r.get("step") is not None and int(r["step"]) < int(root["step"])]
    if len(earlier) != 1:
        return ""
    read = earlier[0]
    if _rhs(str(root.get("statement") or "")) != read["name"]:
        return ""
    return "It copies %s, which has been %s since %s" % (read["name"], clip(read["text"]), where(read))


def _count_keys(text: str) -> int | None:
    """Top-level keys of a whole dict repr; None when the text is not one or is cut."""
    if not (text.startswith("{") and text.endswith("}")) or "…" in text:
        return None
    depth, keys, quote = 0, 0, None
    for ch in text:
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in "'\"":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == ":" and depth == 1:
            keys += 1
    return keys


def _lookup(root: dict, reads: list[dict]) -> str:
    if str(root.get("text")) != "None":
        return ""
    statement = str(root.get("statement") or "")
    m = re.search(r"([A-Za-z_][\w.]*)(\.get\(|\[)", _rhs(statement))
    if not m:
        return ""
    container = m.group(1)
    by_name = {r["name"]: r for r in reads}
    read = by_name.get(container) or by_name.get(container.split(".", 1)[0])
    if read is None:
        return ""
    rhs = _rhs(statement)
    start = m.start()
    opener = rhs[start + len(m.group(0)) - 1]
    closer = ")" if opener == "(" else "]"
    depth, end = 0, len(rhs)
    for i in range(start + len(m.group(0)) - 1, len(rhs)):
        if rhs[i] == opener:
            depth += 1
        elif rhs[i] == closer:
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    expr = rhs[start:end]
    keys = _count_keys(str(read["text"])) if read["name"] == container else None
    return "%s is None: the key is not in %s%s" % (expr, container, " (%d keys)" % keys if keys is not None else "")


def _reads(reads: list[dict]) -> str:
    parts = ["%s = %s" % (r["name"], clip(r["text"])) for r in reads[:3]]
    return "It reads " + ", ".join(parts) if parts else ""


__all__ = ["conclusion", "clip", "short_file", "VALUE_LIMIT"]
