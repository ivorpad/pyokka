"""``pyokka tour RUN --prose tour.prose.json``: check a model's (or an agent's) prose against the tour, then merge.

The prose (``docs/TOUR.md``, "tour.prose.json") picks candidate stops and writes titles and text;
everything else on the merged tour comes from the recording. ``check_prose`` lists every problem
at once so one retry can fix them all:

- ids: a chapter or stop id the tour does not have, a pick listed twice, a picked stop with no
  text, a stop written but not picked, a field the contract does not have;
- quotes: a field the stop does not have, a range outside the recorded value (or past where the
  recording cut it);
- numbers: every number in a title or text has to occur in the recorded values of that stop
  (whole, not the tour's 300-character cut), its statement or its quote, compared with thousands
  separators removed and trailing decimal zeros dropped (``1,024`` = ``1024``, ``0.50`` = ``0.5``).
  A chapter's may also come from its step range and request counts, the intro's from the run's;
- names: a name in backticks has to occur in the tour (a statement, function, file, value name
  or value);
- strings: text in 'single quotes' has to occur in that stop's recorded values.

Counts outside the prompt's ranges and chapters left untitled are warnings, not rejections.
"""

from __future__ import annotations

import re
from typing import Any

from ..source import AgentError
from .values import RECORDING_CUT

TOP = ("intro", "chapters", "pick", "stops")
STOP_FIELDS = ("title", "text", "quote")
CHAPTER_FIELDS = ("title", "text")
QUOTE_FIELDS = ("field", "value", "from", "to")  # `value` is the prototype's name for `field`
SMALL_PICK = (6, 10)  # a tour of under SMALL_TOUR candidates: picks in all
SMALL_TOUR = 60
CHAPTER_PICK = (3, 6)
TEXT_SENTENCES = 3

# A number as prose writes it: not part of a name (`s3`, `v2`, the 4 of `gpt-4o`), thousands
# separators allowed. In the recorded values any digit run counts.
NUM_TEXT = re.compile(r"(?<![\w.])(?<![A-Za-z]-)(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\d)")
NUM_PLAIN = re.compile(r"\d+(?:\.\d+)?")
NUM_GROUPED = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?")
TICK = re.compile(r"`([^`\n]+)`")
NAME = re.compile(r"^[A-Za-z_][\w.]*(?:\(.*\))?$")
SQUOTE = re.compile(r"(?:(?<=[\s(\[])|^)['\u2018]([^'\u2018\u2019\n]{2,}?)['\u2019](?=[\s.,;:)\]!?]|$)")
SENTENCE_END = re.compile(r"[.!?](?:\s|$)")


class ProseRejected(AgentError):
    """The prose broke the contract: every problem, one per line, for a retry."""

    def __init__(self, violations: list[str]) -> None:
        n = len(violations)
        super().__init__(
            "the prose has %d problem%s:\n%s" % (n, "" if n == 1 else "s", "\n".join("- " + v for v in violations)),
            "fix each one and run the same command again; a model retry gets this list appended (skills/pyokka/references/tour-prompt.md, \"Retry\")",
        )
        self.violations = violations

    def to_json(self) -> dict:
        out = super().to_json()
        out["error"] = self.message.split("\n", 1)[0].rstrip(":")
        out["violations"] = self.violations
        return out


def is_small_tour(tour: dict) -> bool:
    """Under ``SMALL_TOUR`` candidates (or a walkthrough-sized run): 6 to 10 picks in all, else 3 to 6 per chapter."""
    return bool(tour.get("small")) or len(tour.get("candidates") or []) < SMALL_TOUR or len(tour.get("chapters") or []) == 1


def norm_number(s: str) -> str:
    s = s.replace(",", "")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


def text_numbers(text: str) -> list[str]:
    return [m.group(0) for m in NUM_TEXT.finditer(text)]


def hay_numbers(*texts: str) -> set[str]:
    out: set[str] = set()
    for t in texts:
        for m in NUM_PLAIN.finditer(t):
            out.add(norm_number(m.group(0)))
        for m in NUM_GROUPED.finditer(t):
            out.add(norm_number(m.group(0)))
    return out


def _flat(s: str) -> str:
    return " ".join(s.split())


def _unescape(s: str) -> str:
    return s.replace("\\'", "'").replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")


def recorded_part(text: str) -> tuple[str, bool]:
    """The part of a value the recording holds, and whether the recording cut it (``…(+N chars)``)."""
    m = RECORDING_CUT.search(text)
    return (text[: m.start()], True) if m else (text, False)


class _Index:
    """The tour, keyed for the checks: candidates and chapters by id, every value's whole text."""

    def __init__(self, tour: dict, full: dict[str, str]) -> None:
        self.tour = tour
        self.cands = {c["id"]: c for c in tour.get("candidates") or []}
        self.chapters = {c["id"]: c for c in tour.get("chapters") or []}
        self.full = full
        words = []
        for c in self.cands.values():
            words += [c.get("statement", ""), c.get("function", ""), c.get("file", "")]
            for v in c.get("values") or []:
                words.append(v.get("name", ""))
                words.append(self.value_text(v))
        for ch in self.chapters.values():
            words += [ch.get("title", "")] + list(ch.get("opens") or [])
        words.append(str((tour.get("goal") or {}).get("text") or ""))
        self.everything = "\n".join(words)
        self._name_cache: dict[str, bool] = {}

    def value_text(self, v: dict) -> str:
        """The whole recorded text of a tour value: from the run when known, else what the tour shows."""
        if v["id"] in self.full:
            return self.full[v["id"]]
        if v.get("sameAs"):
            for c in self.cands.values():
                for w in c.get("values") or []:
                    if w["id"] == v["sameAs"]:
                        return self.value_text(w)
        return str(v.get("text") or "")

    def stop_values(self, cid: str) -> list[str]:
        return [self.value_text(v) for v in self.cands[cid].get("values") or []]

    def has_name(self, name: str) -> bool:
        if name not in self._name_cache:
            def word(w: str) -> bool:
                return re.search(r"(?<![\w])" + re.escape(w) + r"(?![\w])", self.everything) is not None

            parts = [p for p in name.split(".") if p]
            self._name_cache[name] = word(name) or (len(parts) > 1 and all(word(p) for p in parts))
        return self._name_cache[name]


def _resolve_field(c: dict, field: Any) -> dict | None:
    vals = c.get("values") or []
    if not isinstance(field, str) or not field:
        return None
    for v in vals:
        if v["id"] == field or v["id"].rsplit(".", 1)[-1] == field:
            return v
    named = [v for v in vals if v.get("name") == field]
    return named[0] if len(named) == 1 else None


def check_prose(tour: dict, prose: Any, full: dict[str, str]) -> tuple[list[str], list[str], dict]:
    """``(violations, warnings, parts)``: ``parts`` holds what a merge needs (picks in run order, quotes cut)."""
    v: list[str] = []
    w: list[str] = []
    if not isinstance(prose, dict):
        return ['the prose must be a JSON object: {"intro", "chapters", "pick", "stops"}'], w, {}
    ix = _Index(tour, full)
    for key in prose:
        if key not in TOP:
            v.append('unknown field "%s"; the prose has %s' % (key, ", ".join(TOP)))
    intro = prose.get("intro", "")
    if not isinstance(intro, str):
        v.append("intro: must be a string")
        intro = ""
    pick_raw = prose.get("pick")
    if not isinstance(pick_raw, list) or not all(isinstance(p, str) for p in pick_raw):
        v.append("pick: must be a list of candidate ids")
        pick_raw = []
    pick: list[str] = []
    for p in pick_raw:
        if p not in ix.cands:
            v.append("pick: unknown stop id %s" % p)
        elif p in pick:
            v.append("pick: %s listed twice" % p)
        else:
            pick.append(p)
    pick.sort(key=lambda p: ix.cands[p]["step"])
    stops = prose.get("stops")
    if not isinstance(stops, dict):
        v.append("stops: must be an object keyed by candidate id")
        stops = {}
    chapters = prose.get("chapters", {})
    if not isinstance(chapters, dict):
        v.append("chapters: must be an object keyed by chapter id")
        chapters = {}
    for sid in stops:
        if sid not in ix.cands:
            v.append("stops: unknown stop id %s" % sid)
        elif sid not in pick:
            v.append("stops: %s has text but is not in pick" % sid)

    quotes: dict[str, dict] = {}
    texts: dict[str, dict] = {}
    for sid in pick:
        e = stops.get(sid)
        if not isinstance(e, dict):
            v.append("stops: %s is picked but has no title and text" % sid)
            continue
        for key in e:
            if key not in STOP_FIELDS:
                v.append('%s: unknown field "%s"; a stop has %s' % (sid, key, ", ".join(STOP_FIELDS)))
        for key in ("title", "text"):
            if not isinstance(e.get(key), str) or not e.get(key, "").strip():
                v.append("%s.%s: missing or empty" % (sid, key))
        c = ix.cands[sid]
        qtext = ""
        q = e.get("quote")
        if q is not None:
            quote = _check_quote(sid, c, q, ix, v)
            if quote:
                quotes[sid] = quote
                qtext = quote["text"]
        vals = ix.stop_values(sid)
        nums = hay_numbers(*vals, c.get("statement", ""), qtext)
        strings = vals + [qtext]
        for key in ("title", "text"):
            if isinstance(e.get(key), str):
                _check_text("%s.%s" % (sid, key), e[key], nums, strings, ix, v)
        texts[sid] = {"title": e.get("title", ""), "text": e.get("text", "")}
        if isinstance(e.get("text"), str) and len(SENTENCE_END.findall(e["text"].strip())) > TEXT_SENTENCES:
            w.append("%s.text: more than %d sentences" % (sid, TEXT_SENTENCES))

    picked_in: dict[str, list[str]] = {}
    for sid in pick:
        picked_in.setdefault(ix.cands[sid]["chapter"], []).append(sid)

    def scope_hay(sids: list[str], extra: list[Any]) -> tuple[set[str], list[str]]:
        strings = [t for s in sids for t in ix.stop_values(s)] + [quotes[s]["text"] for s in sids if s in quotes]
        nums = hay_numbers(*strings, *[ix.cands[s].get("statement", "") for s in sids], *[str(x) for x in extra])
        return nums, strings

    chapter_texts: dict[str, dict] = {}
    for cid, e in chapters.items():
        if cid not in ix.chapters:
            v.append("chapters: unknown chapter id %s" % cid)
            continue
        if not isinstance(e, dict):
            v.append("chapters: %s must be {title, text}" % cid)
            continue
        for key in e:
            if key not in CHAPTER_FIELDS:
                v.append('%s: unknown field "%s"; a chapter has title and text' % (cid, key))
        if not isinstance(e.get("title"), str) or not e.get("title", "").strip():
            v.append("%s.title: missing or empty" % cid)
        ch = ix.chapters[cid]
        nums, strings = scope_hay(picked_in.get(cid, []), [*ch.get("steps", []), ch.get("http", 0), ch.get("llm", 0)])
        for key in ("title", "text"):
            if isinstance(e.get(key), str):
                _check_text("%s.%s" % (cid, key), e[key], nums, strings, ix, v)
        chapter_texts[cid] = {"title": e.get("title", ""), "text": e.get("text", "") if isinstance(e.get("text"), str) else ""}
    run = tour.get("run") or {}
    nums, strings = scope_hay(pick, [run.get("steps", ""), run.get("http", ""), run.get("llm", ""), run.get("exitCode", ""), len(ix.chapters)])
    _check_text("intro", intro, nums, strings, ix, v)

    # warnings: what the prompt asks for, which a merge survives without
    if not intro.strip():
        w.append("intro: empty")
    for cid in picked_in:
        if cid not in chapter_texts:
            w.append("%s holds a picked stop but has no title; the page uses the function that opens it" % cid)
    if is_small_tour(tour):
        lo, hi = SMALL_PICK
        if not lo <= len(pick) <= hi:
            w.append("pick: %d stops; the prompt asks for %d to %d" % (len(pick), lo, hi))
    else:
        lo, hi = CHAPTER_PICK
        for cid in ix.chapters:
            n = len(picked_in.get(cid, []))
            if ix.chapters[cid].get("candidates", 0) >= lo and not lo <= n <= hi:
                w.append("%s: %d stops; the prompt asks for %d to %d per chapter" % (cid, n, lo, hi))
    return v, w, {"pick": pick, "texts": texts, "quotes": quotes, "chapters": chapter_texts, "intro": intro}


def _check_quote(sid: str, c: dict, q: Any, ix: _Index, v: list[str]) -> dict | None:
    if not isinstance(q, dict):
        v.append("%s.quote: must be {field, from, to}" % sid)
        return None
    for key in q:
        if key not in QUOTE_FIELDS:
            v.append('%s.quote: unknown field "%s"; a quote has field, from, to' % (sid, key))
    field = q.get("field", q.get("value"))
    val = _resolve_field(c, field)
    if val is None:
        have = ", ".join("%s (%s)" % (x["id"].rsplit(".", 1)[-1], x.get("name")) for x in c.get("values") or []) or "none"
        v.append("%s.quote: field %r is not a value of this stop; it has %s" % (sid, field, have))
        return None
    a, b = q.get("from"), q.get("to")
    whole = ix.value_text(val)
    kept, cut = recorded_part(whole)
    if not (type(a) is int and type(b) is int and 0 <= a < b):
        v.append("%s.quote: from and to must be whole numbers with from < to, got %r and %r" % (sid, a, b))
        return None
    if b > len(kept):
        if cut:
            v.append("%s.quote: range %d-%d runs past character %d, where the recording cut %s (rerun with --max-value-chars 0 to keep it whole)" % (sid, a, b, len(kept), val["id"]))
        else:
            v.append("%s.quote: range %d-%d is outside %s, which is %d characters long" % (sid, a, b, val["id"], len(kept)))
        return None
    out = {"field": val["id"], "name": val.get("name", ""), "from": a, "to": b, "text": kept[a:b], "length": len(kept)}
    if cut:
        out["recordingCut"] = True
    return out


def _check_text(where: str, text: str, nums: set[str], strings: list[str], ix: _Index, v: list[str]) -> None:
    rest = text
    for span in TICK.findall(text):
        s = span.strip()
        if NAME.match(s):
            name = s.split("(", 1)[0]
            if name and not ix.has_name(name):
                v.append("%s: `%s` does not occur in the tour's statements, functions or values" % (where, span))
            rest = rest.replace("`%s`" % span, " ")
    hay = None
    for m in SQUOTE.finditer(rest):
        q = m.group(1)
        if hay is None:
            hay = "\n".join(strings)
            flat_hay = _flat(_unescape(hay))
        if q not in hay and _flat(_unescape(q)) not in flat_hay and _flat(q) not in flat_hay:
            v.append("%s: '%s' is not in %s" % (where, q[:60] + ("…" if len(q) > 60 else ""), _scope_words(where, numbers=False)))
    rest = SQUOTE.sub(" ", rest)
    for n in text_numbers(rest):
        if norm_number(n) not in nums:
            v.append("%s: number %s is not in %s" % (where, n, _scope_words(where)))


def _scope_words(where: str, numbers: bool = True) -> str:
    if where.startswith("intro"):
        return "the picked stops' values or the run's counts" if numbers else "the picked stops' values"
    if re.match(r"^c\d+\.", where):
        return "the values of the stops picked in this chapter or its step range and counts" if numbers else "the values of the stops picked in this chapter"
    return "this stop's values, statement or quote" if numbers else "this stop's values"


def merge_prose(tour: dict, parts: dict, warnings: list[str]) -> dict:
    """The tour with ``intro``, ``pick``, ``prose`` counts, and ``prose`` on chapters and picked candidates."""
    out = dict(tour)
    out["intro"] = parts["intro"]
    out["pick"] = list(parts["pick"])
    order = {sid: k for k, sid in enumerate(parts["pick"], 1)}
    cands = []
    for c in tour.get("candidates") or []:
        if c["id"] in order:
            c = dict(c)
            p = dict(parts["texts"][c["id"]], order=order[c["id"]])
            if c["id"] in parts["quotes"]:
                p["quote"] = parts["quotes"][c["id"]]
            c["prose"] = p
        cands.append(c)
    out["candidates"] = cands
    chs = []
    for ch in tour.get("chapters") or []:
        ch = dict(ch)
        if ch["id"] in parts["chapters"]:
            ch["prose"] = parts["chapters"][ch["id"]]
        chs.append(ch)
    out["chapters"] = chs
    out["prose"] = {"stops": len(parts["pick"]), "chapters": len(parts["chapters"]), "warnings": warnings}
    return out


def apply_prose(tour: dict, prose: Any, full: dict[str, str]) -> dict:
    """Check, then merge; raises ``ProseRejected`` with every violation."""
    violations, warnings, parts = check_prose(tour, prose, full)
    if violations:
        raise ProseRejected(violations)
    return merge_prose(tour, parts, warnings)


__all__ = ["apply_prose", "check_prose", "merge_prose", "ProseRejected", "norm_number", "recorded_part"]
