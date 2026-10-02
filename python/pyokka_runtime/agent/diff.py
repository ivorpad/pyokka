"""``pyokka diff A B``: what an edit changed between two runs, statement by statement.

Each side is a ``RunSource`` (a saved run, or the open VS Code session with ``--live``) and is read
only through the verbs both kinds serve: ``state``, ``walkthrough`` (uncapped, by step window) and
``var`` for every name a statement of the user's files assigns. So the facts are the ones those
verbs print: values a statement assigned, the arm a branch took, how often a loop ran, the calls a
statement made with their arguments, prints, logged values, raises.

Matching. Each user file is parsed into statements (simple statements and compound headers, with
the enclosing function). The two versions of a file are aligned with ``difflib`` over
``(function, normalized text)``, the text being ``ast.unparse`` of the statement (compound bodies
dropped), so whitespace, comments and line shifts do not matter. Equal statements pair up; in a
block that changed, statements pair by position when they are in the same function (``edited``),
the rest are ``added`` or ``removed``. Facts then pair by hit: with as many hits on both sides the
nth value of ``total`` on a statement in A goes against the nth in B; with a different count they
are aligned with ``difflib`` so a hit inserted early does not shift every later one
(``diff_match.py``).

A saved run reads its files from the redacted copy ``save.py`` keeps in ``meta.files[].source``,
so the run from before the edit still has the text that ran. An older run without that copy
falls back to the file on disk and says so. Both sides parse the redacted text, so a secret in the
source never decides a match and never prints.
"""

from __future__ import annotations

import argparse
import difflib
import os
import re
from typing import Any

from .diff_match import Stmt, assigned_names, cap_facts, compare_hits, pair_statements, parse_statements, safe_source
from .save import read_text
from .source import AgentError, SavedRun, display_path
from .walkthrough import is_user_file

VAR_LIMIT = 100_000
_TOOK = re.compile(r" took (.+)$")
_RAN = re.compile(r" ran (\d+) times?$")


# -- one side -------------------------------------------------------------------------------------------------

class Side:
    """One run of the pair: its source, its user files' text and statements, its facts."""

    def __init__(self, tag: str, label: str, source: Any) -> None:
        self.tag = tag
        self.label = label
        self.source = source
        self.notes: list[str] = []
        state = source.state()
        self.count = int((state.get("nav") or {}).get("count") or 0)
        self.exit_code = state.get("exitCode")
        self.main = str(state.get("file") or getattr(source, "file", "") or "")
        self.root = str(getattr(source, "workspace_root", "") or os.path.dirname(self.main))
        # a VS Code session records locals only with pyokka.timeMachine.recordLocals on, `pyokka run` unless --no-locals
        self.recorded_locals = bool((source.meta.get("config") or {}).get("recordLocals", bool(source.locals_entries))) if isinstance(source, SavedRun) else True
        self.texts: dict[str, str] = {}
        self.stmts: dict[str, list[Stmt]] = {}
        self._starts: dict[str, dict[int, Stmt]] = {}
        if isinstance(source, SavedRun):
            self._saved_texts(source)
        elif self.main:
            self.text_of(self.main)

    def _saved_texts(self, run: SavedRun) -> None:
        stale = set(run.stale_files())
        kept = {str(f.get("path")): f.get("source") for f in run.meta.get("files") or [] if isinstance(f.get("source"), str)}
        for fid, f in run.files.items():
            path = str(f["path"])
            if not is_user_file(path, self.root, self.main):
                continue
            if path not in kept and path in stale:
                self.notes.append("%s: %s changed since this run and the run keeps no copy of it, so its statements are read from the file as it is now; record it again for a clean diff" % (self.tag, self.display(path)))
            text = safe_source(kept[path] if path in kept else "\n".join(run.source_lines(fid)))
            run._sources[fid] = text.split("\n")  # the text that ran, for every verb this diff calls
            self.texts[path] = text
            self.stmts[path] = parse_statements(text)

    def display(self, path: str | None) -> str:
        return display_path(path, self.root)

    def user(self, path: str | None) -> bool:
        return bool(path) and is_user_file(path, self.root, self.main)

    def text_of(self, path: str) -> str | None:
        if path not in self.texts:
            try:
                self.texts[path] = safe_source(read_text(path))
            except (OSError, UnicodeDecodeError, SyntaxError):
                return None
            self.stmts[path] = parse_statements(self.texts[path])
        return self.texts[path]

    def statement_at(self, path: str, line: int) -> Stmt | None:
        if self.text_of(path) is None:
            return None
        starts = self._starts.get(path)
        if starts is None:
            starts = self._starts[path] = {s.line: s for s in self.stmts.get(path, [])}
        if line in starts:
            return starts[line]
        inside = [s for s in self.stmts.get(path, []) if s.line <= line <= s.end]
        return inside[-1] if inside else None

    # -- facts --------------------------------------------------------------------------------------------------
    def collect(self) -> list[dict]:
        """``{path, line, channel, text, step, extra}`` per fact, in step order."""
        facts: list[dict] = []
        end = max(0, self.count - 1)
        w = self.source.walkthrough(start=0, end=end) if self.count else {"moments": []}
        for m in w.get("moments") or []:
            loc = m.get("location") or {}
            path = loc.get("file")
            if not self.user(path):
                continue
            self.text_of(str(path))
            callee = m.get("callee") or {}
            if callee.get("file") and self.user(callee.get("file")):
                self.text_of(str(callee["file"]))
            fact = moment_fact(m)
            if fact is not None:
                fact.update(path=str(path), line=int(loc.get("line") or 0), step=int(m.get("step") or 0))
                facts.append(fact)
        names: dict[str, None] = {}
        for path in list(self.texts):
            for n in assigned_names(self.texts[path]):
                names.setdefault(n, None)
        seen: set[tuple] = set()
        for name in names:
            try:
                res = self.source.var(name, limit=VAR_LIMIT)
            except AgentError:
                continue
            if res.get("recordedLocals") is False:
                self.recorded_locals = False
            for ch in res.get("changes") or []:
                if ch.get("name") != name or not self.user(ch.get("file")):
                    continue
                key = (int(ch.get("step") or 0), name)
                if key in seen:
                    continue
                seen.add(key)
                facts.append({"path": str(ch["file"]), "line": int(ch.get("line") or 0), "step": key[0], "channel": ("value", name), "text": ch.get("text"), "source": ch.get("source")})
        facts.sort(key=lambda f: f["step"])
        return facts


def _values(m: dict, role: str) -> list[dict]:
    return [v for v in m.get("values") or [] if v.get("role") == role]


def moment_fact(m: dict) -> dict | None:
    kind = m.get("kind")
    text = str(m.get("text") or "")
    if kind in ("call", "tool"):
        callee = str((m.get("callee") or {}).get("function") or "?")
        args = ", ".join("%s=%s" % (v.get("name"), v.get("text")) for v in _values(m, "in"))
        outs = _values(m, "out")
        raised = next((str(v.get("text")) for v in outs if v.get("name") == "raised"), None)
        returned = next((str(v.get("text")) for v in outs if v.get("name") != "raised"), None)
        tail = " raised %s" % raised if raised else ""
        end = m.get("endStep")  # where the value was returned: a changed return is dated there, after what changed inside the callee
        return {"channel": ("call", callee), "text": "%s(%s)%s" % (callee, args, tail), "bare": "%s(…)%s" % (callee, tail), "returned": returned, "returnStep": int(end) if end is not None else None}
    if kind == "decision":
        took = _TOOK.search(text)
        if took:
            return {"channel": ("branch",), "text": took.group(1)}
        ran = _RAN.search(text)
        if ran:
            return {"channel": ("loop",), "text": "%s time%s" % (ran.group(1), "" if ran.group(1) == "1" else "s")}
        return {"channel": ("decision",), "text": text}
    if kind == "print":
        return {"channel": ("print",), "text": text[len("prints "):] if text.startswith("prints ") else text}
    if kind == "value":
        v = (m.get("values") or [{}])[0]
        return {"channel": ("log", str(v.get("name") or "value")), "text": str(v.get("text") or text)}
    if kind == "error":
        return {"channel": ("error",), "text": text[len("raised "):] if text.startswith("raised ") else text}
    return None


# -- pairing statements -----------------------------------------------------------------------------------------

def _pair_files(a: Side, b: Side) -> list[tuple[str | None, str | None]]:
    """``(path in a, path in b)``: the main files always pair, the rest by workspace-relative path, then by basename."""
    pairs: list[tuple[str | None, str | None]] = []
    left = [p for p in a.texts if p != a.main]
    right = [p for p in b.texts if p != b.main]
    if a.main in a.texts or b.main in b.texts:
        pairs.append((a.main if a.main in a.texts else None, b.main if b.main in b.texts else None))
    for p in list(left):
        q = next((q for q in right if b.display(q) == a.display(p)), None)
        if q is None:
            same = [q for q in right if os.path.basename(q) == os.path.basename(p)]
            q = same[0] if len(same) == 1 else None
        if q is not None:
            pairs.append((p, q))
            left.remove(p)
            right.remove(q)
    pairs.extend((p, None) for p in left)
    pairs.extend((None, q) for q in right)
    return pairs


# -- the diff ---------------------------------------------------------------------------------------------------

def comparable(facts: list[dict], with_locals: bool) -> list[dict]:
    """The facts both sides can have. Values a statement assigned and a call's arguments come from
    recorded locals; when one side has none, only logged values and the call itself are compared."""
    out = []
    for f in facts:
        kind = f["channel"][0]
        if kind == "value":
            if not with_locals and f.get("source") != "value":
                continue
            f = dict(f, text="(value not recorded)" if f.get("text") is None else str(f["text"]))
        elif kind == "call" and not with_locals:
            f = dict(f, text=f["bare"], returned=None)
        out.append(f)
    return out


def _locals_note(side: Side) -> str:
    where = "the session's pyokka.timeMachine.recordLocals (Record Variable Changes) is off" if side.label == "--live" else "it was saved with --no-locals"
    return "%s recorded no locals (%s), so assigned values and call arguments are left out; record both with locals to compare them" % (side.tag, where)


def diff_sides(a: Side, b: Side, *, limit: int = 40) -> dict:
    raw_a, raw_b = a.collect(), b.collect()
    with_locals = a.recorded_locals and b.recorded_locals
    facts_a, facts_b = comparable(raw_a, with_locals), comparable(raw_b, with_locals)
    for side in (a, b):
        if not side.recorded_locals:
            side.notes.append(_locals_note(side))
    entries: dict[int, dict] = {}
    index_a: dict[tuple[str, int], int] = {}
    index_b: dict[tuple[str, int], int] = {}
    counts = {"same": 0, "edited": 0, "added": 0, "removed": 0}
    for pa, pb in _pair_files(a, b):
        pairs, _ = pair_statements(a.stmts.get(pa, []) if pa else [], b.stmts.get(pb, []) if pb else [])
        for sa, sb, status in pairs:
            counts[status] += 1
            i = len(entries)
            entries[i] = {
                "file": b.display(pb) if pb else a.display(pa),
                "fileA": a.display(pa) if pa else None,
                "fileB": b.display(pb) if pb else None,
                "lineA": sa.line if sa else None,
                "lineB": sb.line if sb else None,
                "function": (sb or sa).function,  # type: ignore[union-attr]
                "textA": sa.text if sa else None,
                "textB": sb.text if sb else None,
                "status": status,
                **({"sourceA": sa.source, "sourceB": sb.source} if status == "edited" and sa and sb else {}),
                "def": (sb or sa).kind == "def",  # type: ignore[union-attr]
            }
            if sa and pa:
                index_a[(pa, sa.line)] = i
            if sb and pb:
                index_b[(pb, sb.line)] = i

    def group(side: Side, facts: list[dict], index: dict) -> dict[int, dict[tuple, list[dict]]]:
        out: dict[int, dict[tuple, list[dict]]] = {}
        for f in facts:
            s = side.statement_at(f["path"], f["line"])
            if s is None:
                continue
            i = index.get((f["path"], s.line))
            if i is None or (entries[i]["def"] and f["channel"][0] == "value"):
                continue  # parameters bound at a `def` line are the call's arguments, shown on the call
            out.setdefault(i, {}).setdefault(f["channel"], []).append(f)
        return out

    ga, gb = group(a, facts_a, index_a), group(b, facts_b, index_b)
    changed: list[dict] = []
    for i in sorted(set(ga) | set(gb)):
        ca, cb = ga.get(i, {}), gb.get(i, {})
        facts: list[dict] = []
        for channel in sorted(set(ca) | set(cb)):
            facts.extend(compare_hits(channel, ca.get(channel, []), cb.get(channel, [])))
        if not facts:
            continue
        e = dict(entries[i])
        e.pop("def", None)
        e["facts"] = cap_facts(sorted(facts, key=lambda f: ((f.get("b") or f.get("a") or {}).get("step", 0))))
        steps_b = [f["b"]["step"] for f in facts if f.get("b")]
        steps_a = [f["a"]["step"] for f in facts if f.get("a")]
        e["stepA"] = min(steps_a) if steps_a else None
        e["stepB"] = min(steps_b) if steps_b else None
        changed.append(e)
    changed.sort(key=lambda e: (e["stepB"] if e["stepB"] is not None else e["stepA"], e["stepA"] if e["stepA"] is not None else -1))
    first = None
    if changed:
        e = changed[0]
        first = {"file": e["file"], "lineA": e["lineA"], "lineB": e["lineB"], "stepA": e["stepA"], "stepB": e["stepB"]}
    return {
        "a": {"run": a.label, "file": a.main, "count": a.count, "exitCode": a.exit_code},
        "b": {"run": b.label, "file": b.main, "count": b.count, "exitCode": b.exit_code},
        "matching": {"same": counts["same"], "edited": counts["edited"], "added": counts["added"], "removed": counts["removed"]},
        "notes": a.notes + b.notes,
        "firstDifference": first,
        "total": len(changed),
        "shown": min(len(changed), limit),
        "statements": changed[:limit],
        "staleFiles": [],
    }


# -- opening the pair ------------------------------------------------------------------------------------------

class DiffPair:
    """Both sides, opened by ``commands.open_source`` for the command ``diff``."""

    def __init__(self, a: Side, b: Side) -> None:
        self.a, self.b = a, b
        self.workspace_root = b.root

    def display_path(self, path: str | None) -> str:
        return display_path(path, self.workspace_root)

    def stale_files(self) -> list[str]:
        return []

    def close(self) -> None:
        for side in (self.a, self.b):
            try:
                side.source.close()
            except Exception:  # noqa: BLE001
                pass


USAGE_HINT = "`pyokka diff before.json after.json`, or `pyokka diff before.json --live` for the open session as the after"


def open_pair(args: Any) -> DiffPair:
    from .commands import is_live, open_source

    runs = [r for r in (getattr(args, "runs", None) or []) if r]
    if is_live(args):
        if len(runs) != 1:
            raise AgentError("diff --live takes one saved run, the before; the live session is the after", USAGE_HINT)
        a = Side("a", runs[0], SavedRun(runs[0]))
        ns = argparse.Namespace(command="walkthrough", run=None, live=True, session=getattr(args, "session", None), file=a.main or None, line=None, json=getattr(args, "json", False))
        live = open_source(ns)
        return DiffPair(a, Side("b", "--live", live))
    if len(runs) != 2:
        raise AgentError("diff needs two runs, got %d" % len(runs), USAGE_HINT)
    return DiffPair(Side("a", runs[0], SavedRun(runs[0])), Side("b", runs[1], SavedRun(runs[1])))


def diff_command(args: Any, source: Any) -> dict:
    """``source`` is the pair ``open_pair`` made, or (in ``pyokka shell``) the live session as the after."""
    limit = max(1, int(getattr(args, "limit", 40) or 40))
    if isinstance(source, DiffPair):
        return diff_sides(source.a, source.b, limit=limit)
    runs = [r for r in (getattr(args, "runs", None) or []) if r]
    if len(runs) != 1:
        raise AgentError("in the shell, diff takes one saved run, the before; the live session is the after", "e.g. `diff before.json`")
    return diff_sides(Side("a", runs[0], SavedRun(runs[0])), Side("b", "--live", source), limit=limit)


# -- text -----------------------------------------------------------------------------------------------------

def _where(e: dict) -> str:
    if e["status"] == "removed":
        return "%s:%s in a" % (e["fileA"], e["lineA"])
    if e["status"] == "added":
        return "%s:%s" % (e["fileB"], e["lineB"])
    name = e["fileB"] if e["fileA"] == e["fileB"] else "%s (a: %s)" % (e["fileB"], e["fileA"])
    line = str(e["lineB"]) if e["lineA"] == e["lineB"] else "%s→%s" % (e["lineA"], e["lineB"])
    return "%s:%s" % (name, line)


def _steps(f: dict) -> str:
    return "  ".join(s for s in ("a#%d" % f["a"]["step"] if f.get("a") else "", "b#%d" % f["b"]["step"] if f.get("b") else "") if s)


def _fact_line(f: dict, one_line: Any) -> str:
    kind, name = f["kind"], f.get("name")
    if "more" in f:
        return "  … %d more differing %s" % (f["more"], ("hits of %s" % name) if name else "hits")
    a, b = f.get("a"), f.get("b")
    if kind == "return":
        return "  %s returned %s → %s   %s" % (one_line(f["call"], 80), one_line(a["text"], 60), one_line(b["text"], 60), _steps(f))
    label = {"value": "%s = " % name, "log": "%s = " % name, "call": "call ", "print": "printed ", "error": "raised ", "branch": "took ", "loop": "ran ", "decision": ""}.get(kind, "")
    if a and b:
        return "  %s%s → %s   %s" % (label, one_line(a["text"], 80), one_line(b["text"], 80), _steps(f))
    only = a or b
    return "  %s%s   only in %s   %s" % (label, one_line(only["text"], 120), "a" if a else "b", _steps(f))


EDIT_WIDTH = 120  # characters of one changed line shown
_EDIT_LEAD = 30  # of them, how many come before the first character that differs


def _window(line: str, start: int) -> str:
    """``line`` from ``start`` on, ``EDIT_WIDTH`` characters, with ``…`` where it was cut."""
    head = "…" if start > 0 else ""
    rest = line[start:]
    return head + (rest[:EDIT_WIDTH] + "…" if len(rest) > EDIT_WIDTH else rest)


def _changed_pair(a: str, b: str) -> tuple[str, str]:
    """Two versions of a line, each cut to a window that starts a little before the first character that differs."""
    if len(a) <= EDIT_WIDTH and len(b) <= EDIT_WIDTH:
        return a, b
    p = 0
    while p < min(len(a), len(b)) and a[p] == b[p]:
        p += 1
    start = max(0, p - _EDIT_LEAD)
    return _window(a, start), _window(b, start)


def edited_lines(text_a: str | None, text_b: str | None) -> list[str]:
    """The lines of an edited statement that changed, as ``  - old`` / ``  + new``.

    A statement spans lines; the ones both versions share are left out, and when the change is
    below the first line, that line comes first as context (``    scores = rrf( …``). A long line
    is shown from shortly before its first differing character.
    """
    la = [l.strip() for l in (text_a or "").splitlines() if l.strip()]
    lb = [l.strip() for l in (text_b or "").splitlines() if l.strip()]
    ops = [op for op in difflib.SequenceMatcher(None, la, lb, autojunk=False).get_opcodes() if op[0] != "equal"]
    context: list[str] = []
    if ops and la and min(ops[0][1], ops[0][3]) > 0:
        context.append("    %s%s" % (_window(la[0], 0), " …" if len(la) > 1 else ""))
    minus: list[str] = []
    plus: list[str] = []
    for _, i1, i2, j1, j2 in ops:
        old, new = la[i1:i2], lb[j1:j2]
        for k in range(max(len(old), len(new))):
            if k < len(old) and k < len(new):
                x, y = _changed_pair(old[k], new[k])
                minus.append("  - " + x)
                plus.append("  + " + y)
            elif k < len(old):
                minus.append("  - " + _window(old[k], 0))
            else:
                plus.append("  + " + _window(new[k], 0))
    return context + minus + plus


def render_diff(result: dict, source: Any, args: Any) -> list[str]:
    from .render import _one_line

    a, b = result["a"], result["b"]
    m = result["matching"]
    out = [
        "a  %s  %s  %d steps  exit %s" % (a["run"], os.path.basename(str(a["file"] or "")), a["count"], a["exitCode"]),
        "b  %s  %s  %d steps  exit %s" % (b["run"], os.path.basename(str(b["file"] or "")), b["count"], b["exitCode"]),
        "statements: %d same, %d edited, %d added, %d removed (matched by file, function and text)" % (m["same"], m["edited"], m["added"], m["removed"]),
    ]
    out.extend("note: %s" % n for n in result.get("notes") or [])
    if a["exitCode"] != b["exitCode"]:
        out.append("exit code %s → %s" % (a["exitCode"], b["exitCode"]))
    if not result["statements"]:
        out.append("no difference in values, branches, loops, calls, prints or raises")
        return out
    head = "%d statements did something different" % result["total"]
    first = result.get("firstDifference") or {}
    if first:
        head += "; the first at %s:%s (%s)" % (first["file"], first["lineB"] if first.get("lineB") is not None else first.get("lineA"), "  ".join(s for s in ("a#%s" % first["stepA"] if first.get("stepA") is not None else "", "b#%s" % first["stepB"] if first.get("stepB") is not None else "") if s))
    if result["shown"] < result["total"]:
        head += " (showing %d; --limit K for more)" % result["shown"]
    out.append(head)
    for e in result["statements"]:
        status = "" if e["status"] == "same" else "  " + e["status"]
        if e["status"] == "edited":
            out.append("%s  %s%s" % (_where(e), e["function"], status))
            out.extend(edited_lines(e.get("sourceA", e["textA"]), e.get("sourceB", e["textB"])))
        else:
            out.append("%s  %s  %s%s" % (_where(e), e["function"], _one_line(e["textB"] or e["textA"], 100), status))
        out.extend(_fact_line(f, _one_line) for f in e["facts"])
    return out


__all__ = ["DiffPair", "Side", "diff_command", "diff_sides", "open_pair", "pair_statements", "parse_statements", "render_diff"]
