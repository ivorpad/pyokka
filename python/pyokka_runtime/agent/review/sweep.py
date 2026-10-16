"""Ranked anomalies over every step of two recordings (the ``harness/sweep.py`` prototype, ported).

Built on what ``pyokka diff --json``, ``exceptions --json`` and ``coverage --json`` return. Kinds,
in rank order: ``raise`` (an exception raised or caught only in head), ``type`` (a value's runtime
type changed, also across edited statements by name), ``none`` (None, nan or inf appearing in
head), ``sign`` (same magnitude, opposite sign, grouped per statement with a hit count),
``unreached`` (a changed line that never ran, as spans, not in tests), ``partial`` (a changed line
whose branch ran in part), ``branch``/``loop`` (a decision or loop count that changed, or exists
only in head, in a function the PR text does not name, grouped per statement), ``value`` (a value
that differs in a function the PR text does not name), ``print``. Each line ends with the command
that opens the evidence. Values the recorder did not keep (``(value not recorded)``) are skipped,
and a raise seen both by ``exceptions`` and as a diff fact is listed once.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Iterable, NamedTuple

from .edges import is_test_file

#: the kinds a review stops at: they have a head step to show
STOP_KINDS = ("raise", "type", "sign", "none", "print", "value")
RANK = {"raise": 0, "type": 1, "none": 2, "sign": 2, "print": 3, "unreached": 3, "branch": 4, "loop": 4, "decision": 4, "partial": 4, "value": 5, "numeric type": 6}
NUMBER = re.compile(r"(?:Decimal|Fraction)\('(-?\d+(?:\.\d+)?)'\)|(-?\d+(?:\.\d+)?)")


class Anomaly(NamedTuple):
    """One sweep line: ``(rank, kind, text, step_b, file, line, function, fact_a, fact_b)``."""

    rank: int
    kind: str
    text: str
    step_b: int | None
    file: str
    line: int | None
    function: str
    fact_a: str | None
    fact_b: str | None


@dataclass
class Row:
    """An anomaly with its parts apart, so the plan can show the fact without the where and the opener."""

    rank: int
    kind: str
    file: str
    line: int | None
    function: str
    fact: str
    lines: str = ""  # the line part of ``where`` when it is a span (``44-48``)
    steps: str = ""  # ``a#116 b#120``
    tag: str = ""  # ``claimed`` / ``UNCLAIMED``
    opener: str = ""  # ``pyokka context HEAD 120``
    step_a: int | None = None
    step_b: int | None = None
    fact_a: str | None = None
    fact_b: str | None = None
    name: str | None = None

    @property
    def where(self) -> str:
        head = "%s:%s" % (self.file, self.lines or self.line)
        return "%s %s" % (head, self.function) if self.function else head

    @property
    def text(self) -> str:
        """The prototype's one line: where, fact, steps, tag, then ``→`` the opener."""
        out = "%s %s" % (self.where, self.fact)
        if self.steps:
            out += "  " + self.steps
        if self.tag:
            out += "  " + self.tag
        if self.opener:
            out += "  → " + self.opener
        return out

    def as_tuple(self) -> Anomaly:
        return Anomaly(self.rank, self.kind, self.text, self.step_b, self.file, self.line, self.function, self.fact_a, self.fact_b)


# -- value texts ----------------------------------------------------------------------------------------------

def coarse(text: str | None) -> str | None:
    """The runtime type a rendered value shows: None for a value the recorder did not keep."""
    if text is None or "(value not recorded)" in text:
        return None
    t = text.strip()
    if t == "None":
        return "None"
    if t in ("True", "False"):
        return "bool"
    if t in ("nan", "inf", "-inf"):
        return "nan"
    if re.fullmatch(r"-?\d+", t):
        return "int"
    if re.fullmatch(r"-?\d+\.\d*(e-?\d+)?|-?\d*\.\d+(e-?\d+)?", t):
        return "float"
    if t[:1] in ("'", '"'):
        return "str"
    if t.startswith("["):
        return "list"
    if t.startswith("("):
        return "tuple"
    if t.startswith("{"):
        return "dict/set"
    if t.startswith("<function") or t.startswith("<bound method"):
        return "function"
    if t.startswith("<"):
        return "object"
    m = re.match(r"([A-Za-z_][A-Za-z0-9_.]*)\(", t)
    if m:
        return m.group(1)
    return "other"


def number_of(text: str | None) -> float | None:
    """The one number a rendered value carries (a float, an int, ``Decimal('-7160.00')``), else None."""
    if text is None:
        return None
    m = NUMBER.fullmatch(text.strip())
    if not m:
        return None
    try:
        return float(m.group(1) or m.group(2))
    except ValueError:
        return None


def words_of(text: str | None) -> set[str]:
    """The identifiers a PR text names: functions and file stems are checked against them."""
    return set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text or ""))


def _steps(fact: dict) -> tuple[str, int | None, int | None]:
    a = fact.get("a") or {}
    b = fact.get("b") or {}
    sa = a.get("step") if a.get("step") is not None else None
    sb = b.get("step") if b.get("step") is not None else None
    return " ".join(x for x in ("a#%s" % sa if sa is not None else "", "b#%s" % sb if sb is not None else "") if x), sa, sb


def _display(path: str | None, display_of: dict[str, str]) -> str:
    """A display path for an absolute one, through the coverage report's table, else its basename."""
    p = str(path or "")
    return display_of.get(p) or display_of.get(os.path.realpath(p) if p else p) or os.path.basename(p)


def _spans(lines: Iterable[int]) -> list[list[int]]:
    out: list[list[int]] = []
    for n in sorted(set(lines)):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return out


# -- the sweep -------------------------------------------------------------------------------------------------

def sweep_rows(diff_json: dict, exceptions_a: dict, exceptions_b: dict, coverage_b: dict, changed_lines: dict[str, set[int]], pr_words: set[str], head_run_path: str) -> list[Row]:
    """The anomalies as rows, ranked (stable: raises first, then the diff's statements in step order)."""
    head = str(head_run_path)
    display_of = {str(f.get("path")): str(f.get("file")) for f in coverage_b.get("files") or [] if f.get("path")}
    rows: list[Row] = []
    seen: set[tuple] = set()
    agg: dict[tuple, list[tuple[str, int | None, int | None]]] = {}  # (kind, where, text, note) -> [(steps, step_a, step_b)]
    signs: dict[tuple, list[tuple]] = {}  # (file, line, fn, name, tag) -> [(at, bt, steps, opener, step_a, step_b)]
    only: dict[tuple, dict[str, list[tuple]]] = {}  # (file, fn, name) -> {"a": [(text, step, line)], "b": [...]}

    def claimed(file: str, function: str) -> bool:
        stem = os.path.splitext(os.path.basename(file))[0]
        return function in pr_words or stem in pr_words

    def opener(fact: dict) -> str:
        b = fact.get("b") or {}
        return "pyokka context %s %s" % (head, b["step"]) if b.get("step") is not None else ""

    def add(row: Row) -> None:
        key = (row.kind, row.text)
        if key in seen:
            return
        seen.add(key)
        rows.append(row)

    def exc_key(r: dict) -> tuple:
        at = r.get("raisedAt") or {}
        return (r.get("errorType"), os.path.basename(str(at.get("file"))), at.get("line"))

    base_exc = {exc_key(r) for r in exceptions_a.get("rows") or []}
    for r in exceptions_b.get("rows") or []:
        if exc_key(r) in base_exc:
            continue
        at = r.get("raisedAt") or {}
        caught = r.get("caughtAt") or r.get("handledAt") or {}
        how = ("caught at %s:%s" % (os.path.basename(str(caught.get("file"))), caught.get("line"))) if caught else str(r.get("kind") or "")
        seen.add(("raise", os.path.basename(str(at.get("file"))), at.get("line"), r.get("errorType")))
        message = str(r.get("message") or "")[:80]
        step = r.get("step")
        add(Row(RANK["raise"], "raise", _display(at.get("file"), display_of), at.get("line"), str(at.get("function") or ""), "%s: %s (%s, %s×)" % (r.get("errorType"), message, how, r.get("count")), steps="step %s" % step, opener="pyokka context %s %s ; pyokka origin %s %s" % (head, step, head, step), step_b=int(step) if step is not None else None, fact_b="%s: %s" % (r.get("errorType"), r.get("message") or ""), name=str(r.get("errorType") or "")))

    for s in diff_json.get("statements") or []:
        file = str(s.get("file") or s.get("fileB") or "")
        fn = str(s.get("function") or "")
        line = s.get("lineB") or s.get("lineA")
        tag = "claimed" if claimed(file, fn) else "UNCLAIMED"
        for f in s.get("facts") or []:
            kind = f.get("kind")
            a = f.get("a") or None
            b = f.get("b") or None
            at = (a or {}).get("text")
            bt = (b or {}).get("text")
            name = f.get("name") or kind
            steps, sa, sb = _steps(f)
            if kind == "error" and a is None and b is not None:
                rk = ("raise", os.path.basename(file), line, str(bt or "").split(":")[0])
                if rk in seen:
                    continue
                seen.add(rk)
                add(Row(RANK["raise"], "raise", file, line, fn, str(bt or "")[:100], steps=steps, opener=opener(f), step_a=sa, step_b=sb, fact_b=bt, name=str(bt or "").split(":")[0]))
            elif kind in ("value", "return") and a is not None and b is not None:
                ca, cb = coarse(at), coarse(bt)
                if ca is None or cb is None:
                    continue
                if ca != cb:
                    numeric = {ca, cb} <= {"int", "float"}
                    add(Row(RANK["numeric type"] if numeric else RANK["type"], "type", file, line, fn, "%s: %s → %s (%s → %s)" % (name, ca, cb, (at or "")[:40], (bt or "")[:40]), steps=steps, tag=tag, opener=opener(f), step_a=sa, step_b=sb, fact_a=at, fact_b=bt, name=name))
                elif cb in ("None", "nan") and ca not in ("None", "nan"):
                    add(Row(RANK["none"], "none", file, line, fn, "%s: %s → %s" % (name, (at or "")[:40], bt), steps=steps, tag=tag, opener=opener(f), step_a=sa, step_b=sb, fact_a=at, fact_b=bt, name=name))
                elif number_of(at) is not None and number_of(bt) is not None and number_of(at) != 0 and number_of(at) == -number_of(bt):  # type: ignore[operator]
                    signs.setdefault((file, line, fn, name, tag), []).append((at, bt, steps, opener(f), sa, sb))
                elif at != bt and tag == "UNCLAIMED":
                    add(Row(RANK["value"], "value", file, line, fn, "%s: %s → %s" % (name, (at or "")[:50], (bt or "")[:50]), steps=steps, opener=opener(f), step_a=sa, step_b=sb, fact_a=at, fact_b=bt, name=name))
            elif kind in ("value", "return") and ((a is None) != (b is None)) and f.get("name"):
                side = "b" if a is None else "a"
                only.setdefault((file, fn, str(f["name"])), {"a": [], "b": []})[side].append((bt if a is None else at, (b or a or {}).get("step"), line))
                if a is None and coarse(bt) in ("None", "nan"):
                    add(Row(RANK["none"], "none", file, line, fn, "%s = %s (only in head)" % (name, bt), steps=steps, tag=tag, opener=opener(f), step_b=sb, fact_b=bt, name=name))
            elif kind in ("branch", "loop", "decision"):
                if a is not None and b is not None and at != bt:
                    agg.setdefault((kind, file, line, fn, "%s → %s" % (at, bt), ""), []).append((steps, sa, sb))
                elif a is None and b is not None and tag == "UNCLAIMED":
                    agg.setdefault((kind, file, line, fn, str(bt), "only in head"), []).append((steps, sa, sb))
            elif kind == "print" and a is not None and b is not None and at != bt:
                add(Row(RANK["print"], "print", file, line, fn, "printed text differs", steps=steps, opener=opener(f), step_a=sa, step_b=sb, fact_a=at, fact_b=bt, name="print"))

    for (file, line, fn, name, tag), hits in signs.items():
        at, bt, steps, op, sa, sb = hits[0]
        add(Row(RANK["sign"], "sign", file, line, fn, "%s: %s → %s (same magnitude, opposite sign; %d hit%s)" % (name, (at or "")[:40], (bt or "")[:40], len(hits), "s" if len(hits) != 1 else ""), steps=steps, tag=tag, opener=op, step_a=sa, step_b=sb, fact_a=at, fact_b=bt, name=name))
    for (file, fn, name), sides in only.items():
        ta = {coarse(t) for t, _, _ in sides["a"]} - {None}
        tb = {coarse(t) for t, _, _ in sides["b"]} - {None}
        if sides["a"] and sides["b"] and ta and tb and not (ta & tb):
            ta_t, sa, _ = sides["a"][0]
            tb_t, sb, lb = sides["b"][0]
            numeric = (ta | tb) <= {"int", "float"}  # type: ignore[operator]
            fact = "%s: %s → %s (%s → %s) across the edited statements (%d values each side)" % (name, "/".join(sorted(ta)), "/".join(sorted(tb)), (ta_t or "")[:30], (tb_t or "")[:30], min(len(sides["a"]), len(sides["b"])))  # type: ignore[arg-type]
            add(Row(RANK["numeric type"] if numeric else RANK["type"], "type", file, lb, fn, fact, tag="claimed" if claimed(file, fn) else "UNCLAIMED", opener="pyokka context %s %s" % (head, sb if sb is not None else ""), step_a=sa, step_b=sb, fact_a=ta_t, fact_b=tb_t, name=name))
    for (kind, file, line, fn, text, note), hits in agg.items():
        steps, sa, sb = hits[0]
        add(Row(RANK[kind], kind, file, line, fn, "%s%s, %d hit%s" % (text, (" (%s)" % note) if note else "", len(hits), "s" if len(hits) != 1 else ""), steps=steps, opener="pyokka context %s %s" % (head, sb if sb is not None else ""), step_a=sa, step_b=sb, fact_b=text, name=kind))

    # changed lines never run / partial, from head coverage joined to the diff hunks
    for cf in coverage_b.get("files") or []:
        rel = str(cf.get("file") or "")
        lines: set[int] | None = None
        for name, ls in changed_lines.items():
            if name == rel or name.endswith("/" + rel) or rel.endswith("/" + name) or (os.path.basename(name) == os.path.basename(rel) and name.endswith(rel)):
                lines = ls
                break
        if not lines or is_test_file(rel):
            continue
        for lo, hi in _spans(set(cf.get("notRun") or []) & lines):
            span = ("%d-%d" % (lo, hi)) if hi > lo else str(lo)
            add(Row(RANK["unreached"], "unreached", rel, lo, "", "changed line%s never ran" % ("s" if hi > lo else ""), lines=span, opener="pyokka coverage %s --file %s" % (head, os.path.basename(rel))))
        for n in sorted(set(cf.get("partial") or []) & lines):
            add(Row(RANK["partial"], "partial", rel, n, "", "changed line ran in part (a branch arm never taken)", opener="pyokka coverage %s --file %s" % (head, os.path.basename(rel))))

    rows.sort(key=lambda r: r.rank)
    return rows


def sweep(diff_json: dict, exceptions_a: dict, exceptions_b: dict, coverage_b: dict, changed_lines: dict[str, set[int]], pr_words: set[str], head_run_path: str) -> list[Anomaly]:
    """``[(rank, kind, text, step_b or None, file, line, function, fact_a, fact_b)]``, ranked."""
    return [r.as_tuple() for r in sweep_rows(diff_json, exceptions_a, exceptions_b, coverage_b, changed_lines, pr_words, head_run_path)]


def summary_line(rows: list[Row], diff_json: dict) -> str:
    """``sweep: 161 statements compared (119 same, 7 edited, 31 added, 4 removed), 34 differ; 16 anomalies: ...``."""
    m = diff_json.get("matching") or {}
    by_kind: dict[str, int] = {}
    for r in rows:
        by_kind[r.kind] = by_kind.get(r.kind, 0) + 1
    return "sweep: %s statements compared (%s same, %s edited, %s added, %s removed), %s differ; %d anomalies: %s" % (sum(m.values()) if m else "?", m.get("same"), m.get("edited"), m.get("added"), m.get("removed"), diff_json.get("total"), len(rows), ", ".join("%s %d" % (k, v) for k, v in sorted(by_kind.items())))


def render_sweep(rows: list[Row], diff_json: dict, changed_lines: dict[str, set[int]], cap: int = 30) -> list[str]:
    """The prototype's listing, for a side-by-side check against ``runs/sweep.txt``."""
    out = [summary_line(rows, diff_json)]
    out.append("changed lines in the PR: %s" % ", ".join("%s (%d)" % (os.path.basename(f), len(ls)) for f, ls in sorted(changed_lines.items()) if ls and f.endswith(".py")))
    for i, r in enumerate(rows[:cap], 1):
        out.append("%2d. [%s] %s" % (i, r.kind, r.text))
    if len(rows) > cap:
        out.append("… %d more" % (len(rows) - cap))
    return out


__all__ = ["Anomaly", "Row", "STOP_KINDS", "coarse", "number_of", "render_sweep", "summary_line", "sweep", "sweep_rows", "words_of"]
