"""Sentence rules for what a person reads: the structural half of ASD-STE100, as warnings.

``check(label, text)`` lists one line per sentence that breaks a rule: more than 20 words, a passive
form (a be-verb and a participle, a heuristic, so the line says "may be passive"), an -ing verb used
as a noun (domain nouns allowed), a filler word, a synonym for a fixed term (stop, step, value, try,
finding, the person), a bold label with a colon, or a table row. ``prose_warnings(fields)`` runs it
over every prose field of a page and ends with one line that gives the pass rate. Code spans and
fenced blocks are dropped first; a decimal, ``file.py:12`` and ``e.g.`` do not end a sentence.
Style never fails a merge: ``tour --prose`` and ``history --prose`` print these as warnings and write
the page. SKILL.md, "How you write to the person", is the rule these lines point back to.
"""

from __future__ import annotations

import re
from typing import Iterable

MAX_WORDS = 20
TARGET = 0.8
ING_OK = frozenset("docstring docstrings string strings recording recordings finding findings setting settings warning warnings nothing something anything everything during thing things morning evening bring ring king sing wing spring following missing existing remaining incoming outgoing formatting parsing pricing encoding mapping spending ordering rounding matching working running being according including".split())
FILLER = frozenset("simply obviously basically just essentially actually robust seamless leverage comprehensive streamline holistic furthermore moreover".split())
SYNONYMS = {"breakpoint": "stop", "breakpoints": "stop", "experiment": "try", "experiments": "try", "repro": "try", "variable": "value", "variables": "value", "user": "the person", "users": "the person"}
PASSIVE = re.compile(r"\b(is|are|was|were|be|been|being|gets?|got)\s+(\w+ed|\w+en|built|caught|done|gone|hidden|kept|made|read|run|seen|shown|taken|thrown|written|set|put|cut|lost|found|held|left|given|driven|sent|spent|told|dropped)\b", re.I)
LABEL = re.compile(r"^\*\*[^*]+(:\*\*|\*\*:)\s*$")
BULLET = re.compile(r"^(\s*[-*•]|\s*\d+[.)])\s+")
SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(<\[])")
WORD = re.compile(r"[A-Za-z][\w'<>-]*")


def units(text: str) -> list[str]:
    """The sentences of ``text``, a table row as ``<table>…`` and a bold label with a colon as ``<label>…``."""
    text = re.sub(r"```.*?```", " CODE ", text or "", flags=re.S)
    text = re.sub(r"`[^`\n]*`", " CODE ", text)
    text = re.sub(r"(\d)[.,](\d)", r"\1<d>\2", text)
    text = text.replace("e.g.", "eg").replace("i.e.", "ie").replace("vs.", "vs")
    out: list[str] = []
    for line in (l.strip() for l in text.split("\n")):
        if not line:
            continue
        if line.startswith("|") or set(line) <= set("-|: "):
            out.append("<table>" + line)
            continue
        line = BULLET.sub("", line)
        if LABEL.match(line):
            out.append("<label>" + line)
            continue
        out.extend(p.strip() for p in SPLIT.split(line.replace("**", "")) if p.strip())
    return out


def reasons(unit: str) -> list[str]:
    """Why ``unit`` breaks the rules; empty when it passes."""
    if unit.startswith("<table>"):
        return ["table"]
    if unit.startswith("<label>"):
        return ["label with a colon"]
    out: list[str] = []
    words = WORD.findall(unit)
    if len(words) > MAX_WORDS:
        out.append("%d words" % len(words))
    if PASSIVE.search(unit):
        out.append("may be passive")
    lower = [w.lower() for w in words]
    ing = [w for w in lower if w.endswith("ing") and w not in ING_OK and len(w) > 5]
    if ing:
        out.append("-ing as a noun: " + ", ".join(ing[:3]))
    filler = [w for w in lower if w in FILLER]
    if filler:
        out.append("filler: " + ", ".join(filler))
    syn = ["%s, say %s" % (w, SYNONYMS[w]) for w in lower if w in SYNONYMS]
    if syn:
        out.append("; ".join(syn))
    return out


def check(label: str, text: str) -> tuple[list[str], int, int]:
    """``(lines, total, passed)``: one line per failing sentence of ``text``, named by ``label``."""
    lines: list[str] = []
    total = passed = 0
    for unit in units(text):
        total += 1
        why = reasons(unit)
        if not why:
            passed += 1
            continue
        shown = unit.split(">", 1)[1] if unit.startswith("<") else unit
        shown = shown.replace("<d>", ".").replace(" CODE ", " `…` ").replace("**", "").strip()
        if len(shown) > 80:
            shown = shown[:79] + "…"
        lines.append('%s: "%s" (%s)' % (label, shown, "; ".join(why)))
    return lines, total, passed


def prose_warnings(fields: Iterable[tuple[str, str]]) -> list[str]:
    """The failing sentences of every ``(label, text)``, then one line with the pass rate; nothing when there is no prose."""
    out: list[str] = []
    total = passed = 0
    for label, text in fields:
        lines, n, ok = check(label, text or "")
        out.extend(lines)
        total += n
        passed += ok
    if total:
        rate = passed / total
        tail = "" if rate >= TARGET else "; the rule asks for %d%%" % round(TARGET * 100)
        out.append("prose: %d of %d sentences pass the sentence rules (%d%%)%s" % (passed, total, round(rate * 100), tail))
    return out


__all__ = ["check", "prose_warnings", "reasons", "units", "MAX_WORDS", "TARGET"]
