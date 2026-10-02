"""The parts one code-history checkpoint is made of, as pure functions plus one index.

``codehistory.py`` assembles the document; everything here shapes a single card: its values, its
call stack, the source window the left panel shows, the provenance chain as an indented list,
and ``Facts``, which reads the walkthrough, the graph, the exceptions report and the HTTP table
once so twenty checkpoints cost four reads of the run instead of eighty.
"""

from __future__ import annotations

import os
import re
from collections import Counter
from typing import Any

from ..values import LOG_CHARS, value_chars
from .source import AgentError
from .recording import cut_line

VALUE_MAX = LOG_CHARS  # a card value from a run that does not say its limit (a live session): as long as a logged value
WINDOW_MAX = 40


def flat(text: Any, limit: int = VALUE_MAX) -> str:
    """One line, bounded: a value in a card is read at a glance, not scrolled."""
    return cut_line(text, limit, strip=True)


def card_value_chars(source: Any, setting: int | None = None) -> int:
    """How much of one value a card shows: ``setting`` (``--value-chars``, 0 for all of it), else the run's own limit.

    A run saved with ``--max-value-chars N`` kept N characters of every value; cutting them again
    at a fixed width would hide what the recording was made to keep. A run with the default limits
    kept 120 characters of a local and 200 of a logged value, so 200 shows each one whole.
    """
    if setting is not None:
        return value_chars(setting, VALUE_MAX)
    config = (getattr(source, "meta", None) or {}).get("config") or {}
    return value_chars(config.get("maxValueChars"), VALUE_MAX)


def slug(text: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_.]+", "-", str(text or "")).strip("-") or "x"


def values_text(values: list, step: int | None = None, limit: int = VALUE_MAX) -> str:
    """``name = value`` per line; a value logged at another step keeps its ``#step``."""
    out = []
    for v in values or []:
        if not isinstance(v, dict):
            continue
        name = v.get("context")
        line = "%s = %s" % (name, flat(v.get("text"), limit)) if name else flat(v.get("text"), limit)
        at = v.get("step")
        if isinstance(at, int) and step is not None and at != step:
            line += "   #%d" % at
        out.append(line)
    return "\n".join(out)


def stack_text(stack: list) -> list[str]:
    out = []
    for f in stack or []:
        if not isinstance(f, dict):
            continue
        if f.get("elided"):  # a run of library frames the slice folded: kept as one line, not dropped twice
            out.append("… %d library frames" % int(f["elided"]))
            continue
        where = "%s:%s" % (os.path.basename(str(f.get("file") or "?")), f.get("line"))
        at = f.get("step")
        out.append("%s %s%s" % (f.get("function") or "<module>", where, "   #%d" % at if isinstance(at, int) else ""))
    return out


def source_window(block_lines: list, focus: int, pad: int, file_len: int, span_max: int = WINDOW_MAX) -> tuple[int, int, list[int]]:
    """The left panel's range and its green lines: the block widened by ``pad``, clamped to the file.

    ``bright`` is the lines the recording says ran. Dim is context, which is the distinction the
    page makes and prose cannot. A module block runs from the first import to the last line, so a
    block wider than ``span_max`` is centred on the focus instead: a panel showing the whole file
    shows nothing. ``--scope`` passes 0 and takes the block whole.
    """
    nums = sorted({int(l["line"]) for l in block_lines or [] if isinstance(l, dict) and isinstance(l.get("line"), int)})
    lo = min(nums + [focus]) if nums else focus
    hi = max(nums + [focus]) if nums else focus
    start = max(1, lo - pad)
    end = max(start, min(file_len or hi, hi + pad))
    if span_max and end - start + 1 > span_max:
        start = max(1, focus - span_max // 2)
        end = min(file_len or (start + span_max - 1), start + span_max - 1)
        start = max(1, min(start, end))
    return start, end, [n for n in nums if start <= n <= end]


def arm_text(texts: list) -> str:
    """One line for a decision the run met more than once: ``if row < 0 took False x2, True x1``.

    The walkthrough has one moment per pass, and both the graph and the last moment would show a
    single arm. A branch that went both ways has to say so, or the page argues from one pass.
    """
    counts = Counter(texts)
    if len(counts) == 1:
        text, n = next(iter(counts.items()))
        return text if n == 1 else "%s, entered %d times" % (text, n)
    head = os.path.commonprefix(list(counts)).rstrip()
    return "%s %s" % (head, ", ".join("%s x%d" % (t[len(head):].strip(), n) for t, n in counts.most_common()))


def flatten_chain(node: Any, depth: int = 0, via: str = "root", limit: int = VALUE_MAX) -> list[dict]:
    """``why``'s tree as an indented list: ``depth`` keeps the shape, ``via`` says how we got here."""
    if not isinstance(node, dict):
        return []
    out = [{
        "depth": depth,
        "via": via,
        "name": str(node.get("name") or ""),
        "text": flat(node.get("text"), limit) if node.get("text") is not None else "?",
        # a leaf of a recording that began at a pause: the value was made before step 0
        "statement": "made before #0, where the recording started" if node.get("beforeRecording") else flat(node.get("statement"), 100),
        "location": "%s:%s" % (os.path.basename(str(node.get("file") or "")), node.get("line")) if node.get("file") else "",
        "step": node.get("step") if isinstance(node.get("step"), int) else None,
    }]
    for read in node.get("reads") or []:
        out.extend(flatten_chain(read, depth + 1, "reads", limit))
    for call in node.get("calls") or []:
        if not isinstance(call, dict):
            continue
        inputs = ", ".join("%s = %s" % (i.get("name"), flat(i.get("text"), min(60, limit))) for i in call.get("inputs") or [] if isinstance(i, dict))
        out.append({
            "depth": depth + 1,
            "via": "calls",
            "name": str(call.get("name") or ""),
            "text": inputs,
            "statement": "",
            "location": "%s:%s" % (os.path.basename(str(call.get("file") or "")), call.get("line")) if call.get("file") else "",
            "step": call.get("entryStep") if isinstance(call.get("entryStep"), int) else None,
        })
    return out


class Facts:
    """What the other reports know about a step, indexed once: calls, hits, arms, raises, requests.

    A page with twenty checkpoints costs four reads of the run, not eighty. A live debug session
    refuses every one of these, and then a checkpoint simply carries none of them.
    """

    def __init__(self, source: Any, value_limit: int = VALUE_MAX) -> None:
        self.value_limit = value_limit
        self.calls: dict[int, dict] = {}
        self.arms: dict[tuple, str] = {}
        self.hits: dict[tuple, int] = {}
        self.glosses: dict[int, str] = {}
        self.raises: dict[int, str] = {}
        self.requests: dict[int, str] = {}
        for load in (self._walkthrough, self._graph, self._exceptions, self._http):
            try:
                load(source)
            except (AgentError, KeyError, TypeError, ValueError):
                pass

    @staticmethod
    def _key(file: Any, line: Any) -> tuple:
        return (os.path.basename(str(file or "")), int(line or 0))

    def _walkthrough(self, source: Any) -> None:
        arms: dict[tuple, list] = {}
        for m in source.walkthrough().get("moments") or []:
            step = m.get("step")
            if m.get("gloss"):
                self.glosses[int(step)] = str(m["gloss"])
            if m.get("kind") == "call":
                callee = m.get("callee") if isinstance(m.get("callee"), dict) else {}
                values = [v for v in m.get("values") or [] if isinstance(v, dict)]
                self.calls[int(step)] = {
                    "name": str(callee.get("function") or "?"),
                    "in": ["%s = %s" % (v.get("name"), flat(v.get("text"), self.value_limit)) for v in values if v.get("role") == "in"],
                    "out": next(("%s = %s" % (v.get("name"), flat(v.get("text"), self.value_limit)) for v in values if v.get("role") == "out"), ""),
                }
            elif m.get("kind") == "decision":
                loc = m.get("location") if isinstance(m.get("location"), dict) else {}
                arms.setdefault(self._key(loc.get("file"), loc.get("line")), []).append(str(m.get("text") or ""))
        self.arms = {key: arm_text(texts) for key, texts in arms.items()}

    def _graph(self, source: Any) -> None:
        for n in source.graph().get("nodes") or []:
            if n.get("kind") in ("statement", "decision") and isinstance(n.get("hits"), int):
                self.hits[self._key(n.get("file"), n.get("line"))] = int(n["hits"])

    def _exceptions(self, source: Any) -> None:
        for row in source.exceptions().get("rows") or []:
            raised = row.get("raisedAt") if isinstance(row.get("raisedAt"), dict) else {}
            handled = row.get("handledAt") if isinstance(row.get("handledAt"), dict) else None
            text = "%s: %s" % (row.get("errorType"), flat(row.get("message"), 100))
            text += "   raised %s:%s" % (os.path.basename(str(raised.get("file") or "?")), raised.get("line"))
            text += "   caught %s:%s%s" % (os.path.basename(str(handled.get("file") or "?")), handled.get("line"), " (broad handler)" if handled.get("broad") else "") if handled else "   uncaught"
            self.raises[int(row.get("step") or -1)] = text

    def _http(self, source: Any) -> None:
        for r in source.http().get("requests") or []:
            if not isinstance(r.get("step"), int):
                continue
            self.requests[int(r["step"])] = "%s %s  %s  %s ms  %s" % (r.get("method"), flat(r.get("url"), 80), r.get("status"), r.get("ms"), r.get("source"))
