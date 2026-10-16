"""The review as a tour (``review report --tour``): the change as a story, in run order.

``build_tour`` runs on head.json with every stop shown and line asked forced as a candidate
(``force``), so each has a stop in the tour; the says become the tour's prose: ``pick`` is those
stops in step order, each one's ``text`` its say and its ``title`` the stop's kind and function.
``apply_prose`` checks every number and quoted string in a say against that stop's values, as it
does for prose a model wrote. A say it rejects falls back to head's own value, then to a plain
sentence, and each rejection stays as a warning, so the tour is still written. The intro is the review's
summary paragraph. The sentence rules run over the prose too. ``tour.json`` goes beside the review
or to ``--tour FILE``, never inside the repository, for ``render-tour.cjs`` (show.md).
"""

from __future__ import annotations

import json
import os
from typing import Any

from ..prose import prose_warnings
from ..render import _one_line
from ..tour.build import build_tour
from ..tour.prose import ProseRejected, apply_prose
from .actions import head_run, stop_fact
from .render import fact_text, side_text
from .state import Review, inside, now

SKILL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "skills", "pyokka"))
RETRIES = 4


def tour_path(review: Review, given: Any) -> str:
    path = os.path.abspath(os.path.expanduser(str(given))) if isinstance(given, str) and given.strip() and given not in ("true", "True") else review.path("tour.json")
    if inside(path, review.repo):
        raise review.refuse("--tour %s is inside the repository" % path, ["nothing is written inside the repository under review"], "review report --tour FILE")
    return path


def entries_of(review: Review) -> list[dict]:
    """The stops shown and lines asked, in conversation order, each with its step, say and the stop it came from."""
    out: list[dict] = []
    for e in review.conversation:
        if not isinstance(e, dict) or e.get("kind") not in ("stop", "ask") or e.get("step") is None:
            continue
        s = review.stop(int(e["n"])) if e.get("kind") == "stop" and e.get("n") is not None else None
        out.append({"step": int(e["step"]), "say": str(e.get("say") or ""), "stop": s, "file": e.get("file"), "line": e.get("line")})
    return out


def _title(entry: dict) -> str:
    s = entry.get("stop")
    if s:
        return "%s in %s" % (s.get("kind"), s.get("function") or os.path.basename(str(s.get("file") or "")))
    return "asked at %s" % os.path.basename(str(entry.get("file") or ""))


PLAIN = {"raise": "The statement raises here and a handler catches it.", "type": "The value changes type here.", "sign": "The value changes sign here.", "none": "The value becomes None here.", "print": "The program prints something different here.", "value": "The value changes here."}


def _fallback(entry: dict, attempt: int) -> str:
    """What a stop says about itself when the say does not pass the tour's check: first head's own value
    (the tour is of head.json, so base's cannot be quoted), then a plain sentence with no number in it."""
    s = entry.get("stop")
    if not s:
        return "You asked about this line."
    if attempt <= 1 and s.get("kind") != "raise":  # a raise's "value" is the exception's text, which reads badly as "here X is X"
        fact = stop_fact(s) or {}
        name, b = fact.get("name"), side_text(fact.get("b"))
        if name and b is not None and "\n" not in b:
            return "Here `%s` is %s." % (name, _one_line(b, 100))
    return PLAIN.get(str(s.get("kind")), "Behaviour differs from base here.")


def write_tour(review: Review, given: Any) -> dict:
    path = tour_path(review, given)
    entries = entries_of(review)
    if not entries:
        raise review.refuse("nothing to tell: no stop was shown and no line asked", ["a tour has one stop per stop shown or line asked"], "review stop %d --say TEXT" % (review.remaining()[0] if review.remaining() else 1))
    run_ = head_run(review)
    full: dict[str, str] = {}
    steps = list(dict.fromkeys(e["step"] for e in entries))
    tour = build_tour(run_, full=full, force=steps)
    by_step = {int(c["step"]): str(c["id"]) for c in tour.get("candidates") or [] if c.get("step") is not None}
    warnings: list[str] = []
    texts: dict[str, str] = {}
    titles: dict[str, str] = {}
    pick: list[str] = []
    for e in entries:
        cid = by_step.get(e["step"])
        if cid is None:
            warnings.append("step %d has no candidate in the tour; its stop is left out" % e["step"])
            continue
        if cid not in pick:
            pick.append(cid)
            texts[cid] = e["say"]
            titles[cid] = _title(e)
    d = review.data
    summary = d.get("summary")
    intro = str(summary.get("text") if isinstance(summary, dict) else summary or "")
    plain_intro = "This tour follows a review of %s: the stops below are where head behaves differently from base." % os.path.basename(review.repo)
    fallen: set[str] = set()
    merged = None
    for attempt in range(RETRIES):
        prose = {"intro": intro, "pick": pick, "stops": {cid: {"title": titles[cid], "text": texts[cid]} for cid in pick}, "chapters": {}}
        try:
            merged = apply_prose(tour, prose, full)
            break
        except ProseRejected as exc:
            warnings.extend("the tour's check rejected %s" % v for v in exc.violations)
            for v in exc.violations:
                key = v.split(":", 1)[0].split(".", 1)[0].strip()
                if key == "intro":
                    intro = "" if intro == plain_intro else plain_intro  # the summary paragraph is all counts; say what the tour is without them
                elif key in texts:
                    entry = next((e for e in entries if by_step.get(e["step"]) == key), None)
                    texts[key] = _fallback(entry or {}, attempt + 1)
                    fallen.add(key)
    if merged is None:
        raise review.refuse("the says could not be merged into the tour after %d tries" % RETRIES, warnings[-6:], "review report --out FILE")
    warnings += prose_warnings([("intro", merged.get("intro") or "")] + [("%s.text" % cid, texts[cid]) for cid in pick])
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(merged, ensure_ascii=False, separators=(",", ":")) + "\n")
    review.data["tour"] = {"path": path, "at": now(), "stops": len(pick)}
    html = os.path.splitext(path)[0] + ".html"
    script = os.path.join(SKILL_DIR, "scripts", "render-tour.cjs")
    script = script if os.path.exists(script) else "<skill>/scripts/render-tour.cjs"
    lines = ["wrote tour %s (%d stops, %d said as recorded, %d fell back to the fact)" % (path, len(pick), len(pick) - len(fallen), len(fallen)), "render: node %s %s %s" % (script, path, html), *("warning: %s" % w for w in warnings)]
    return {"path": path, "stops": len(pick), "warnings": warnings, "lines": lines}


__all__ = ["write_tour", "tour_path", "entries_of"]
