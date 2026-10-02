"""The root of a chain: where the value took the form that failed (``docs/design/origin.md``, "The root")."""

from __future__ import annotations

import difflib

from ..reprs import parse, type_of
from .need import Need


MAKERS = ("assigned", "return", "element", "literal")


def shape(text: str | None, need: Need | None) -> str:
    """A value's form in the terms the need is about: ``a str``, ``None``, ``a list of length 2``, ``a dict without 'port'``."""
    t = type_of(text)
    if t == "NoneType":
        return "None"
    value = parse(text)
    if need is not None and need.kind == "index" and isinstance(value, (list, tuple, str)) and "…(+" not in str(text):
        return "a %s of length %d" % (t, len(value))
    if need is not None and need.kind == "key" and isinstance(value, dict):
        return "a dict %s %r" % ("with" if need.key in value else "without", need.key)
    return "a %s" % t if t else "a value"


class RootMixin:
    """``OriginBuilder``'s root rule: sibling runs of the same statement first, else the earliest link with the failing value."""

    def siblings(self, link: dict) -> list[str]:
        """The texts the link's statement produced on its other runs, for the same role."""
        how = link["how"]
        if how == "return" and link.get("scopeReturned") is not None:
            this = self.trace.scope(int(link["scopeReturned"]))
            if this is None:
                return []
            return [str(s["returned"]) for s in self.scopes_by_rid.get(int(this["rid"]), ()) if s is not this and s.get("returned") is not None]
        if link.get("_sib"):
            name, rid, own = link["_sib"]
            return [str(r["text"]) for r in self.history.rows(name)
                    if int(r["step"]) != own and self.trace.rid(int(r["step"])) == rid and r.get("name") == name and r.get("text") is not None and not r.get("unchanged")]
        return []

    def mark_root(self, need: Need | None, failing: bool = True) -> dict | None:
        if not self.links:
            return None
        final = self.links[0].get("text")
        k = 0
        while k + 1 < len(self.links) and self.links[k + 1].get("text") == final and final is not None:
            k += 1
        for i in range(k, -1, -1):  # forward in time
            link = self.links[i]
            here = type_of(link.get("text"))
            sib = self.siblings(link)
            if not sib:
                continue
            types = [type_of(t) for t in sib]
            if need is not None:
                if need.fits(link.get("text")) is not False:
                    continue
                good = [t for t in sib if need.fits(t)]
                if not good:
                    continue
            else:
                good = [t for t, ty in zip(sib, types) if ty and here and ty != here]
                if not good:
                    continue
            kinds = sorted({shape(t, need) for t in good})
            if link["how"] == "return":
                who, verb, others = link.get("function") or "<module>", "returned", "calls"
            elif link["how"] == "argument":
                who, verb, others = "this call", "passed", "calls"
            else:
                who, verb, others = "this statement", "made", "runs"
            share = "its other %d %s" % (len(sib), others) if len(good) == len(sib) else "%d of its other %d %s" % (len(good), len(sib), others)
            reason = "%s %s %s here; %s %s %s" % (who, verb, shape(link.get("text"), need), share, verb, " or ".join(kinds))
            link["root"] = True
            return {"index": i, "step": link["step"], "reason": reason, "evidence": "siblings"}
        # without sibling evidence the root is the earliest link that already carries the value, but only a
        # link that made it: a chain cut at an argument or a read does not know where the value was made
        while k >= 0 and self.links[k]["how"] not in MAKERS:
            k -= 1
        if k < 0:
            return None
        link = self.links[k]
        link["root"] = True
        if need is not None and need.kind == "key" and isinstance(parse(link.get("text")), dict):
            keys = [str(x) for x in parse(link.get("text")) if isinstance(x, str)]
            close = difflib.get_close_matches(str(need.key), keys, n=1)
            reason = "the dict has no key %r from here on" % (need.key,)
            if close:
                reason += "; it has %r" % close[0]
            return {"index": k, "step": link["step"], "reason": reason, "evidence": "first"}
        reason = "the value is %s from here to %s" % (link.get("text") if len(str(link.get("text"))) <= 40 else shape(link.get("text"), need), "the failure" if failing else "the step asked about")
        return {"index": k, "step": link["step"], "reason": reason, "evidence": "first"}


__all__ = ["RootMixin"]
