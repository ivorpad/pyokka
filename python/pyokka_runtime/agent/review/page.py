"""The review as a code-history page (``review report --page``): what we looked at together, as a page.

Every stop shown and every line asked becomes a recorded-step checkpoint of ``head.json`` at that
step (``codehistory.build`` with ``--at`` selectors, in conversation order), and a stop whose fact
names a value gets a ``--why`` checkpoint too, the chain back to where the value came from. The
prose is the review's: the say as the card's text; the fact as the start of its note, with base's
value beside head's (the one thing a plain history page cannot show); then what the person asked at
that stop (``look``) and what the recording answered. A finding near a stop sets the card's tag to
its severity. The summary paragraph is the page's heading, the agenda its subtitle. Every prose
field goes through the sentence rules (``agent/prose.py``) and the warnings come back with the
answer. The page is ``history.json`` for ``render-code-history.cjs`` (show.md), written beside the
review or at ``--page FILE``, never inside the repository.
"""

from __future__ import annotations

import json
import os
from typing import Any

from ..codehistory import build, merge_prose, try_card
from ..prose import prose_warnings
from ..render import _one_line
from ..source import AgentError
from .actions import head_run, stop_fact
from .render import fact_text, side_text, where
from .state import Review, inside, now

SKILL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "skills", "pyokka"))
NEAR_LINES = 3
WHY_KINDS = ("type", "sign", "none", "value")


def page_path(review: Review, given: Any) -> str:
    """``--page FILE`` made absolute, else ``DIR/page.json``; a path inside the repository is refused."""
    path = os.path.abspath(os.path.expanduser(str(given))) if isinstance(given, str) and given.strip() and given not in ("true", "True") else review.path("page.json")
    if inside(path, review.repo):
        raise review.refuse("--page %s is inside the repository" % path, ["nothing is written inside the repository under review"], "review report --page FILE")
    return path


def selectors(review: Review) -> tuple[list[tuple], list[dict], list[tuple[str, str]]]:
    """``(selectors, entries, whys)``: one ``at`` per stop shown or line asked, in conversation order; a ``why`` for a stop whose fact names a value."""
    sels: list[tuple] = []
    entries: list[dict] = []
    whys: list[tuple[str, str]] = []
    for e in review.conversation:
        if not isinstance(e, dict) or e.get("kind") not in ("stop", "ask") or e.get("step") is None:
            continue
        sels.append(("at", str(e["step"])))
        entries.append(e)
        s = review.stop(int(e["n"])) if e.get("kind") == "stop" and e.get("n") is not None else None
        name = (s or {}).get("name")
        if s and name and s.get("kind") in WHY_KINDS:
            sels.append(("why", (str(e["step"]), str(name))))
            whys.append((str(e["step"]), str(name)))
    return sels, entries, whys


def build_data(review: Review, run_: Any) -> tuple[dict, list[dict], list[tuple[str, str]], list[str]]:
    """The page's data from head.json; when a ``why`` cannot be built, the page keeps the stops and says so."""
    sels, entries, whys = selectors(review)
    if not entries:
        raise review.refuse("nothing to put on a page: no stop was shown and no line asked", ["a page has one checkpoint per stop shown or line asked"], "review stop %d --say TEXT" % (review.remaining()[0] if review.remaining() else 1))
    label = review.path("head.json")
    warnings: list[str] = []
    try:
        data = build(run_, sels, run_label=label)
    except AgentError as exc:
        if not whys:
            raise
        warnings.append("the provenance checkpoints were left out: %s" % exc.message)
        data = build(run_, [s for s in sels if s[0] == "at"], run_label=label)
        whys = []
    return data, entries, whys, warnings


def _looks_after(review: Review) -> dict[int, list[dict]]:
    """The ``look`` entries that followed each stop or ask, keyed by that entry's index among stops and asks."""
    out: dict[int, list[dict]] = {}
    k = -1
    for e in review.conversation:
        if not isinstance(e, dict):
            continue
        if e.get("kind") in ("stop", "ask") and e.get("step") is not None:
            k += 1
        elif e.get("kind") == "look" and k >= 0:
            out.setdefault(k, []).append(e)
    return out


def _finding_near(review: Review, card: dict) -> dict | None:
    for fd in review.findings:
        if not isinstance(fd, dict):
            continue
        if fd.get("step") is not None and card.get("step") is not None and int(fd["step"]) == int(card["step"]):
            return fd
        try:
            same_file = os.path.basename(str(fd.get("file") or "")) == os.path.basename(str(card.get("file") or ""))
            if same_file and abs(int(fd.get("line")) - int(card.get("focus"))) <= NEAR_LINES:
                return fd
        except (TypeError, ValueError):
            continue
    return None


def prose_for(review: Review, data: dict, entries: list[dict], whys: list[tuple[str, str]]) -> dict:
    """The prose file a person would have written, from what the review recorded."""
    d = review.data
    summary = d.get("summary")
    paragraph = summary.get("text") if isinstance(summary, dict) else str(summary or "")
    shown = len(review.shown)
    n_find, n_try = len(review.findings), len(review.tries)
    heading = "Review %s: %s → %s of %s" % (d.get("id"), str(d.get("base"))[:7], str(d.get("head"))[:7], os.path.basename(review.repo))
    subtitle = "%s · %d of %d stops shown · %d finding%s · %d tr%s" % (d.get("entry"), shown, len(review.stops), n_find, "" if n_find == 1 else "s", n_try, "y" if n_try == 1 else "ies")
    steps: dict[str, dict] = {}
    looks = _looks_after(review)
    at_cards = [c for c in data["steps"] if str(c.get("id", "")).startswith("step-")]
    for k, (card, e) in enumerate(zip(at_cards, entries)):
        s = review.stop(int(e["n"])) if e.get("kind") == "stop" and e.get("n") is not None else None
        note: list[str] = []
        if s is not None:
            title = "Stop %s: %s in %s" % (s.get("n"), s.get("kind"), s.get("function") or where(s))
            fact = stop_fact(s) or {}
            a, b = side_text(fact.get("a")), side_text(fact.get("b"))
            if a is not None and b is not None:
                note.append("Base had %s. Head has %s." % (_one_line(a, 100), _one_line(b, 100)))
            elif fact_text(s.get("fact")):
                note.append(_one_line(fact_text(s.get("fact")), 200) + ".")
        else:
            title = "Asked: %s:%s" % (e.get("file"), e.get("line"))
        for look in looks.get(k, []):
            value = look.get("value")
            note.append("You asked what `%s` is. %s" % (look.get("expr"), ("It is `%s`." % _one_line(value, 100)) if value is not None else "The recording could not evaluate it."))
        fields: dict[str, Any] = {"title": title, "text": str(e.get("say") or ""), "note": " ".join(note)}
        fd = _finding_near(review, card)
        if fd is not None:
            fields["tag"] = "FINDING · %s" % str(fd.get("severity") or "").upper()
        steps[str(card["id"])] = fields
    for t in review.tries:
        if not isinstance(t, dict) or not t.get("id"):
            continue
        result_ = t.get("result")
        text = "Ran in the %s. %s" % ("Scratchpad on the page" if t.get("surface") == "page" else "sandbox", ("The result is `%s`." % _one_line(result_, 100)) if result_ is not None else ("It raised: %s." % _one_line(t.get("error"), 100) if t.get("error") else "It returned nothing."))
        steps[str(t["id"])] = {"title": str(t.get("title") or "Try %s" % t["id"]), "text": text, "note": ("Reproduces %s." % ", ".join(str(fd.get("id")) for fd in review.findings if isinstance(fd.get("repro"), dict) and fd["repro"].get("id") == t["id"])) if any(isinstance(fd.get("repro"), dict) and fd["repro"].get("id") == t["id"] for fd in review.findings) else ""}
    for step, name in whys:
        for c in data["steps"]:
            cid = str(c.get("id", ""))
            if cid.startswith("why-%s-" % step) and cid not in steps:
                steps[cid] = {"title": "Where `%s` came from" % name, "text": "The chain runs from step %s back to the value's source." % step}
                break
    return {"heading": heading, "subtitle": subtitle, "summary": str(paragraph or ""), "steps": steps}


def write_page(review: Review, given: Any) -> dict:
    """Build, fill, check and write the page; ``lines`` is what the report prints about it."""
    path = page_path(review, given)
    run_ = head_run(review)
    data, entries, whys, warnings = build_data(review, run_)
    verify = "pyokka review state --dir %s" % review.path()
    for t in review.tries:
        if isinstance(t, dict) and t.get("id"):
            data["steps"].append(try_card(data, t, verify))  # the tries, after the stops: sandbox runs, not steps of the program
    prose = prose_for(review, data, entries, whys)
    merge_prose(data, prose)
    fields = [(k, data.get(k, "")) for k in ("heading", "subtitle", "summary")] + [("%s.%s" % (c["id"], f), c.get(f, "")) for c in data["steps"] for f in ("text", "note")]
    warnings += list(data.pop("_warnings", []) or []) + prose_warnings(fields)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    review.data["page"] = {"path": path, "at": now(), "checkpoints": len(data["steps"])}
    html = os.path.splitext(path)[0] + ".html"
    script = os.path.join(SKILL_DIR, "scripts", "render-code-history.cjs")
    script = script if os.path.exists(script) else "<skill>/scripts/render-code-history.cjs"
    n_tries = sum(1 for c in data["steps"] if c.get("kind") == "try")
    lines = ["wrote page %s (%d checkpoints: %d stops or asks, %d chains, %d tries)" % (path, len(data["steps"]), len(entries), len(whys), n_tries), "render: node %s %s %s" % (script, path, html), *("warning: %s" % w for w in warnings)]
    return {"path": path, "checkpoints": len(data["steps"]), "warnings": warnings, "lines": lines}


__all__ = ["write_page", "page_path", "selectors", "build_data", "prose_for"]
