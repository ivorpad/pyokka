"""``why --live STEP NAME --full``: the full value on the why tree's first line, copied by a replay.

The extension runs the program again, in a runner of its own, up to the step; it checks every
step and every value the recording kept on the way, and copies the value whole (the bridge's
``why`` with ``full``, docs/PROTOCOL.md "Replay"). Here its answer becomes text: the status label
the panel shows, the summary, the first difference when there is one, then the value as indented
Python-like text. Also here: the refusal for a saved run, which has no runner to replay in, and
the hint that ``var``, ``why`` and ``step`` print under a value the recording cut.
"""

from __future__ import annotations

import json
import re
import shlex
from typing import Any

from .recording import CUT_RE, cut_line
from .source import AgentError

#: the panel's labels (webview/components/FullValue.tsx)
STATUS_LABEL = {
    "pending": "Replaying",
    "checked": "Checked",
    "path": "Path checked",
    "differs": "Differs",
    "diverged": "Went another way",
    "unavailable": "Not available",
    "error": "Failed",
}
#: what a replay does besides reading, said wherever the CLI offers one
REPLAY_EFFECTS = "runs the program again in a separate process up to that step: files it writes are written again, network answers come from the HTTP recording"
#: the width a value is kept on one line within, and the lines of it printed (`--json` has all of it)
WIDTH = 100
VALUE_LINES = 400
#: a level the recorder left closed (`{...}`, `[...]`, `(...)`) or a container it shortened (`, ...]`)
CLOSED = re.compile(r"(?:[\[{(]|, )\.\.\.[\]})]")
SEQUENCES = {"list": ("[", "]"), "tuple": ("(", ")"), "set": ("{", "}"), "frozenset": ("frozenset({", "})")}
#: the copy's limits (python/pyokka_runtime/replay.py, `FULL`), for the line that says where it stopped
COPY_LIMITS = "30 levels, 5,000 items per container and 200,000 characters per string"

SAVED_RUN = "--full replays the run in the VS Code session that recorded it, and a saved run has no runner to replay it in"
SAVED_RUN_HINT = 'record it in VS Code (`pyokka debug FILE --record --at NAME`, MCP: pyokka_debug {"action": "start", "file": "FILE", "record": true, "at": ["NAME"]}), then `pyokka why --live STEP NAME --full` (MCP: pyokka_value {"action": "why", "live": true, "step": STEP, "name": "NAME", "full": true})'


def check_request(source: Any, name: str) -> None:
    """Refuse what cannot be replayed before anything is sent: no name, or a saved run."""
    if not name:
        raise AgentError("--full needs NAME, the value to copy whole", 'e.g. `pyokka why --live 41 order --full` (MCP: pyokka_value {"action": "why", "live": true, "step": 41, "name": "order", "full": true}); without NAME, why explains the statement at STEP')
    if not hasattr(source, "descriptor"):
        raise AgentError(SAVED_RUN, SAVED_RUN_HINT)


def full_lines(view: dict) -> list[str]:
    """The text of a full value: label, summary, the replay's effects, the first difference, the value."""
    status = str(view.get("status") or "")
    out = ["", "full value of %s: %s" % (view.get("name"), STATUS_LABEL.get(status, status))]
    if view.get("summary"):
        out.append(str(view["summary"]))
    if view.get("ms") is not None and status not in ("pending", "unavailable"):
        out.append("replayed in %s: the program ran again in a separate process, so files it writes were written again" % _seconds(int(view["ms"])))
    d = view.get("difference")
    if isinstance(d, dict):
        out.append("first difference, #%s %s: the recording kept %s, the replay has %s" % (d.get("step"), d.get("name"), cut_line(d.get("recorded"), 200, strip=True), cut_line(d.get("replay"), 200, strip=True)))
    if isinstance(view.get("value"), dict):
        out.extend(value_lines(view["value"], str(view.get("name") or "value")))
    return out


def _seconds(ms: int) -> str:
    return "%d ms" % ms if ms < 1000 else "%.1f s" % (ms / 1000)


# -- the value as text ---------------------------------------------------------------------------------


def value_lines(node: dict, name: str) -> list[str]:
    """``name = value``, on one line when it fits ``WIDTH``, else one member per line, indented; at most ``VALUE_LINES``."""
    out: list[str] = []
    cut = [False]
    _emit(node, "  %s = " % name, "  ", "", out, cut)
    if len(out) > VALUE_LINES:
        more = len(out) - VALUE_LINES
        out = out[:VALUE_LINES] + ["  … %d more line%s; `--json` has the whole copy" % (more, "" if more == 1 else "s")]
    if cut[0]:
        out.append("  (… is where the copy stopped: it keeps %s)" % COPY_LIMITS)
    return out


def _emit(node: dict, lead: str, indent: str, tail: str, out: list[str], cut: list[bool]) -> None:
    one = _inline(node, cut, WIDTH - len(lead) - len(tail))
    if one is not None:
        out.append(lead + one + tail)
        return
    shape = _shape(node)
    if shape is None:  # a leaf longer than the width: whole, on its own line
        out.append(lead + _leaf(node, cut) + tail)
        return
    opener, closer, items = shape
    out.append(lead + opener)
    for prefix, child in items:
        if child is None:
            cut[0] = True
            out.append(indent + "  …")
        else:
            _emit(child, indent + "  " + prefix, indent + "  ", ",", out, cut)
    out.append(indent + closer + tail)


def _inline(node: dict, cut: list[bool], budget: int) -> str | None:
    """The node on one line within ``budget`` characters, or None."""
    shape = _shape(node)
    if shape is None:
        text = _leaf(node, cut)
        return text if len(text) <= budget else None
    opener, closer, items = shape
    parts: list[str] = []
    used = len(opener) + len(closer)
    for prefix, child in items:
        if child is None:
            cut[0] = True
            text: str | None = "…"
        else:
            text = _inline(child, cut, budget - used - len(prefix))
        if text is None:
            return None
        parts.append(prefix + text)
        used += len(prefix) + len(text) + 2
        if used > budget + 2:
            return None
    line = opener + ", ".join(parts) + ("," if node.get("type") == "tuple" and len(parts) == 1 else "") + closer
    return line if len(line) <= budget else None


def _shape(node: dict) -> tuple[str, str, list[tuple[str, dict | None]]] | None:
    """``(opener, closer, [(prefix, member)])`` of a value with members; None for a leaf (or an empty container)."""
    props = [p for p in node.get("props") or [] if isinstance(p, dict)]
    if not props:
        return None
    kind = str(node.get("type") or "")
    members = [p for p in props if not p.get("loadActionNode")]
    keyed = any("keyRepr" in p for p in members)
    indexed = bool(members) and all(str(p.get("name", "")).isdigit() for p in members)
    items: list[tuple[str, dict | None]] = []
    for p in props:
        if p.get("loadActionNode"):
            items.append(("", None))  # the copy's limit: the rest of the container was not copied
        elif keyed:
            items.append(("%s: " % (p.get("keyRepr") or repr(p.get("name"))), p))
        elif indexed or kind in SEQUENCES:
            items.append(("", p))
        else:
            items.append(("%s=" % p.get("name"), p))
    if kind == "dict":
        return "{", "}", items
    if kind in SEQUENCES:
        return SEQUENCES[kind][0], SEQUENCES[kind][1], items
    if keyed:
        return kind + "({", "})", items  # OrderedDict, defaultdict, Counter
    if indexed:
        return kind + "([", "])", items  # deque, array
    return kind + "(", ")", items  # an object, by its attributes


def _leaf(node: dict, cut: list[bool]) -> str:
    value = node.get("value")
    if node.get("type") == "str" and not node.get("secret"):
        text = str(value if value is not None else "")
        length = node.get("length")
        if isinstance(length, int) and length > len(text):
            cut[0] = True
            return repr(text) + "…(+%d chars)" % (length - len(text))
        return repr(text)
    if node.get("expandable"):  # a level past the copy's depth: its own short text, closed
        cut[0] = True
    return str(value if value is not None else node.get("type") or "")


# -- the hint under a cut value ------------------------------------------------------------------------

_NAME = re.compile(r"^[A-Za-z_][\w.]*$")
_HINTED = frozenset({"var", "why", "step", "context"})


def full_hint(command: str, result: dict, args: Any, source: Any, *, why_chars: int, text_chars: int) -> list[str]:
    """One line naming ``why --live STEP NAME --full`` when ``result`` printed a recorded value cut, for a session that can replay it.

    A saved run gets none: its values were cut when it was recorded, and nothing replays it."""
    if command not in _HINTED or isinstance(result.get("full"), dict) or getattr(source, "kind", None) != "run" or not hasattr(source, "descriptor"):
        return []
    target = _first_cut(command, result, why_chars, text_chars)
    if target is None:
        return []
    step, name = target
    session = getattr(args, "session", None)
    words = ["pyokka", "why", "--live", *(["--session", str(session)] if session else []), str(step), name or "NAME", "--full"]
    mcp: dict[str, Any] = {"action": "why", "live": True, **({"session": session} if session else {}), "step": step, "name": name or "NAME", "full": True}
    return ["hint: a recorded value was cut: `%s` %s, and prints all of it (MCP: pyokka_value %s)" % (" ".join(shlex.quote(w) for w in words), REPLAY_EFFECTS, json.dumps(mcp))]


def _is_cut(text: Any, limit: int) -> bool:
    s = " ".join(str(text).split("\n")).strip()
    return bool(CUT_RE.search(s) or CLOSED.search(s) or len(s) > limit)


def _first_cut(command: str, result: dict, why_chars: int, text_chars: int) -> tuple[int, str | None] | None:
    """``(step, name)`` of the first cut value the command printed, the step ``why`` takes for it."""
    if command == "why":
        root = result.get("root")
        if isinstance(root, dict) and root.get("text") is not None and _is_cut(root["text"], why_chars) and result.get("name"):
            return int(result["step"]), str(result["name"])

        def walk(node: Any) -> tuple[int, str | None] | None:
            reads = node.get("reads") if isinstance(node, dict) else None
            for read in reads or []:
                if isinstance(read, dict) and read.get("text") is not None and read.get("step") is not None and read.get("name") and _is_cut(read["text"], why_chars):
                    return int(read["step"]), str(read["name"])
                found = walk(read)
                if found:
                    return found
            return None

        return walk(root)
    if command == "var":
        for row in result.get("changes") or []:
            if isinstance(row, dict) and row.get("text") is not None and row.get("step") is not None and _is_cut(row["text"], text_chars):
                return int(row["step"]), str(row.get("name") or "") or None
        return None
    for v in result.get("values") or []:  # step, context: the values the slice's statements logged
        if isinstance(v, dict) and v.get("text") is not None and v.get("step") is not None and _is_cut(v["text"], text_chars):
            ctx = str(v.get("context") or "")
            return int(v["step"]), ctx if _NAME.match(ctx) else None
    return None
