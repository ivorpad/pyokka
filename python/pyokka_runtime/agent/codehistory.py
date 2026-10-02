"""``pyokka history``: the data behind a code-history page, generated from a run.

The page (``skills/pyokka/templates/code-history.html.hbs``) is numbered source on the
left and chronological checkpoints on the right. Everything on it that is a fact comes from
here, and every checkpoint carries in ``verify`` the command that prints those same values
again: the selectors below are the same ``RunSource`` methods ``context``, ``var`` and ``why``
call, so a value and the command beside it cannot drift apart.

Prose (``heading``, ``summary``, ``title``, ``text``, ``note``) is left empty for the agent to
fill, through ``--prose`` or by editing. ``merge_prose`` refuses a prose file that tries to set
a generated field: a page whose numbers were typed is the thing this verb exists to prevent.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any

from ..redact import redact
from .checkpoint import Facts, card_value_chars, flat, flatten_chain, slug, source_window, stack_text, values_text
from .save import file_hash, read_text, sha256_text
from .source import AgentError

WINDOW_MAX = 40
KINDS = ("recorded step", "live pause", "static source", "gloss")
OUTPUT_LINES = 12
SHA_PREFIX = 14
PROSE_TOP = ("title", "eyebrow", "heading", "subtitle", "summary", "historyLabel", "scope", "footer", "reportHref", "reportLabel")
PROSE_STEP = ("title", "text", "note", "tag")
PROSE_LISTS = ("evidence",)  # prose that is a list: links relative to the page, or http(s) URLs


def valid_link(value: Any) -> bool:
    """The renderer's rule (``validLink`` in render-code-history.cjs): no spaces or control characters, no scheme but http(s)."""
    return isinstance(value, str) and bool(value) and not re.search(r"[\x00-\x20\x7f]", value) and (not re.match(r"^[a-z][a-z0-9+.-]*:", value, re.I) or bool(re.match(r"^https?://", value, re.I)))


class Checkpoint(argparse.Action):
    """``--at``, ``--var``, ``--why`` and ``--pause`` append to one ordered list.

    A page is a narrative and its order is the one that was written; argparse would otherwise
    hand back three unrelated lists and lose it.
    """

    def __call__(self, parser: Any, namespace: Any, values: Any, option_string: str | None = None) -> None:
        kind = (option_string or "--at").lstrip("-")
        if kind == "why":
            step, name = values
            if not str(step).lstrip("-").isdigit():
                raise argparse.ArgumentError(self, "wants STEP NAME, e.g. `--why 124 fused_ranking`")
            values = (int(step), str(name))
        items = list(getattr(namespace, self.dest, None) or [])
        items.append((kind, None if kind == "pause" else values))
        setattr(namespace, self.dest, items)


class Builder:
    """Turns selectors into checkpoints, collecting the source each one needs as it goes."""

    def __init__(self, source: Any, *, run_label: str, pad: int, limit: int, scope: bool, value_chars: int | None = None) -> None:
        self.source = source
        self.run_label = run_label
        self.pad = pad
        self.limit = limit
        self.scope = scope
        self.chars = card_value_chars(source, value_chars)
        self.facts = Facts(source, self.chars)
        self.files: dict[str, list[str]] = {}
        self.needed: dict[str, set] = {}
        self.paths: dict[str, str] = {}
        self.ids: set = set()
        self.truncated: list[str] = []
        self.warnings: list[str] = []
        self.block_text: dict[str, dict] = {}
        self._lines: dict[str, list[str]] = {}

    # -- source ---------------------------------------------------------------------------------
    def lines_of(self, path: str) -> list[str]:
        if path not in self._lines:
            try:
                self._lines[path] = read_text(path).split("\n")
            except (OSError, UnicodeDecodeError, SyntaxError, TypeError):
                self._lines[path] = []
        return self._lines[path]

    def key_of(self, path: str | None) -> str:
        key = self.source.display_path(path)
        self.paths[key] = str(path or "")
        return key

    def want(self, key: str, start: int, end: int) -> None:
        self.needed.setdefault(key, set()).update(range(start, end + 1))

    def emit_files(self) -> dict:
        """The source the page needs, and only that: original numbering, empty where nothing asked.

        Disk first, then the ``block.lines`` the slice already carried. A live session's file can
        be in a remote workspace the CLI cannot open, and a page with a blank left panel is worse
        than one built from the sixty lines the bridge sent.
        """
        out: dict[str, list[str]] = {}
        for key, wanted in self.needed.items():
            lines = self.lines_of(self.paths[key])
            fallback = self.block_text.get(key) or {}
            if not lines and not fallback:
                self.warnings.append("cannot read %s; its source panel will be empty" % key)
            top = max(wanted)
            rows = [""] * top
            for n in sorted(wanted):
                text = lines[n - 1] if n - 1 < len(lines) else fallback.get(n, "")
                # `pyokka context` redacts source on the way to a terminal; an HTML file travels
                # further than a terminal, so it is redacted here too, and the agent is told which
                # line changed rather than left to find a literal key in a page it just shared.
                safe = redact(text)
                if safe != text:
                    self.warnings.append("%s:%d held a secret and was redacted in the page's source" % (key, n))
                rows[n - 1] = safe
            out[key] = rows
        return out

    # -- checkpoints ----------------------------------------------------------------------------
    def unique(self, cid: str) -> str:
        if cid not in self.ids:
            self.ids.add(cid)
            return cid
        n = 2
        while "%s-%d" % (cid, n) in self.ids:
            n += 1
        self.ids.add("%s-%d" % (cid, n))
        return "%s-%d" % (cid, n)

    def blank(self, cid: str, kind: str, tag: str) -> dict:
        return {
            "id": cid, "kind": kind, "tag": tag, "step": None,
            "title": "", "text": "", "note": "",
            "file": "", "start": 1, "end": 1, "focus": 1, "bright": [],
            "values": "", "reads": [], "stack": [], "output": "",
            "call": None, "hits": None, "arm": None, "reason": "", "chain": [],
            "exception": None, "http": None, "gloss": None, "modified": False,
            "verify": "", "evidence": [],
        }

    def anchor(self, card: dict, slice_: dict) -> dict:
        """Put a checkpoint on its source: file, range, focus, the green lines, the stack."""
        loc = slice_.get("location") if isinstance(slice_.get("location"), dict) else {}
        block = slice_.get("block") if isinstance(slice_.get("block"), dict) else {}
        path = loc.get("file") or block.get("file")
        key = self.key_of(path)
        focus = int(loc.get("line") or 1)
        for entry in block.get("lines") or []:
            if isinstance(entry, dict) and isinstance(entry.get("line"), int):
                self.block_text.setdefault(key, {}).setdefault(int(entry["line"]), str(entry.get("text") or ""))
        start, end, bright = source_window(block.get("lines") or [], focus, self.pad, len(self.lines_of(str(path))), 0 if self.scope else WINDOW_MAX)
        self.want(key, start, end)
        card.update(file=key, start=start, end=end, focus=focus, bright=bright, stack=stack_text(slice_.get("stack") or []))
        step = card.get("step")
        if isinstance(step, int):
            card["gloss"] = self.facts.glosses.get(step)
            card["exception"] = self.facts.raises.get(step)
            card["http"] = self.facts.requests.get(step)
            call = self.facts.calls.get(step)
            card["call"] = call if call and (call["in"] or call["out"]) else None
        fkey = Facts._key(path, focus)
        card["hits"] = self.facts.hits.get(fkey)
        card["arm"] = self.facts.arms.get(fkey)
        return card

    def at(self, spec: str) -> list[dict]:
        if str(spec).lstrip("-").isdigit():
            slice_ = self.source.context(step=int(spec), scope=self.scope)
        else:
            from .commands import parse_line

            file, line = parse_line(spec, "--at")
            slice_ = self.source.context(file=file, line=line, scope=self.scope)
        step = slice_.get("step")
        card = self.blank(self.unique("step-%s" % step), "recorded step", "RECORDED STEP")
        card["step"] = step if isinstance(step, int) else None
        card["values"] = values_text(slice_.get("values") or [], card["step"], self.chars)
        card["verify"] = "pyokka context %s %s --json" % (self.run_label, step)
        return [self.anchor(card, slice_)]

    def var(self, name: str) -> list[dict]:
        result = self.source.var(name)
        changes = [c for c in result.get("changes") or [] if isinstance(c, dict)]
        total = int(result.get("total") or len(changes))
        if len(changes) > self.limit:
            self.truncated.append("--var %s: %d of %d changes" % (name, self.limit, total))
            changes = changes[: self.limit]
        cards = []
        for i, change in enumerate(changes):
            step = int(change.get("step"))
            slice_ = self.source.context(step=step, scope=self.scope)
            card = self.blank(self.unique("var-%s-%d" % (slug(name), i + 1)), "recorded step", "CHANGE %d OF %d" % (i + 1, total))
            card["step"] = step
            card["values"] = "%s = %s" % (change.get("name") or name, flat(change.get("text"), self.chars))
            card["reads"] = ["%s = %s%s" % (r.get("name"), flat(r.get("text"), self.chars), "   #%d" % r["step"] if isinstance(r.get("step"), int) else "") for r in change.get("reads") or [] if isinstance(r, dict)]
            card["verify"] = "pyokka var %s %s --json" % (self.run_label, name)
            cards.append(self.anchor(card, slice_))
        return cards

    def why(self, step: int, name: str) -> list[dict]:
        result = self.source.why(int(step), name)
        root = result.get("root") if isinstance(result.get("root"), dict) else {}
        at = root.get("step") if isinstance(root.get("step"), int) else int(step)
        slice_ = self.source.context(step=at, scope=self.scope)
        card = self.blank(self.unique("why-%s-%s" % (step, slug(name))), "recorded step", "WHY %s" % name.upper())
        card["step"] = at
        card["values"] = "%s = %s" % (root.get("name") or name, flat(root.get("text"), self.chars))
        card["chain"] = flatten_chain(root, limit=self.chars)
        card["verify"] = "pyokka why %s %s %s --json" % (self.run_label, step, name)
        return [self.anchor(card, slice_)]

    def pause(self) -> list[dict]:
        slice_ = self.source.context(scope=self.scope)
        paused = slice_.get("paused") if isinstance(slice_.get("paused"), dict) else None
        if not paused:
            raise AgentError("no debug pause to capture", "pause one first: `pyokka break --live FILE:LINE` then `pyokka continue --live`")
        from .live import stop_reason

        modified = bool(slice_.get("modified"))
        tag = "LIVE PAUSE (VALUES MODIFIED FROM THE CONSOLE)" if modified else "LIVE PAUSE"
        card = self.blank(self.unique("pause-%s" % (len([i for i in self.ids if i.startswith("pause-")]) or 1)), "live pause", tag)
        card["step"] = slice_.get("step") if isinstance(slice_.get("step"), int) else None
        card["values"] = "\n".join("%s = %s" % (v.get("name"), flat(v.get("text"), self.chars)) for v in slice_.get("locals") or [] if isinstance(v, dict))
        card["modified"] = modified
        output = slice_.get("output") if isinstance(slice_.get("output"), dict) else {}
        tail = str(output.get("text") or "").splitlines()[-OUTPUT_LINES:]
        card["output"] = "\n".join(tail)
        card["verify"] = "pyokka context %s --json" % self.run_label
        card = self.anchor(card, slice_)
        card["reason"] = stop_reason(paused)
        card["chain"] = []  # a record:false session recorded nothing behind the pause
        return [card]


def build(source: Any, selectors: list, *, run_label: str, pad: int = 2, limit: int = 20, lang: str = "en", scope: bool = False, value_chars: int | None = None) -> dict:
    """The whole document. ``selectors`` is ``[(kind, value)]`` in the order they were written."""
    state = source.state()
    stale = [os.path.basename(str(p)) for p in state.get("staleFiles") or []]
    if state.get("stale"):
        raise AgentError(
            "stale: %s changed since the run" % ", ".join(stale or ["the source"]),
            "the page would show source that does not match its values; record again with `pyokka run FILE --save run.json`",
        )
    builder = Builder(source, run_label=run_label, pad=pad, limit=limit, scope=scope, value_chars=value_chars)
    steps: list[dict] = []
    for kind, value in selectors:
        if kind == "at":
            steps.extend(builder.at(value))
        elif kind == "var":
            steps.extend(builder.var(value))
        elif kind == "why":
            steps.extend(builder.why(value[0], value[1]))
        elif kind == "pause":
            steps.extend(builder.pause())
    if not steps:
        raise AgentError("no checkpoints", "pick some: `--at STEP`, `--at FILE:LINE`, `--var NAME`, `--why STEP NAME`, or `--live --pause`")
    for card in steps:
        card["values"] = redact(card["values"])
        card["reads"] = [redact(r) for r in card["reads"]]
        card["output"] = redact(card["output"])
    return {
        "lang": lang,
        "labels": {},
        **{field: "" for field in PROSE_TOP},
        "meta": meta_of(source, state, run_label, builder.truncated),
        "files": builder.emit_files(),
        "steps": steps,
        "_warnings": builder.warnings,
    }


def meta_of(source: Any, state: dict, run_label: str, truncated: list) -> dict:
    """Run identity: what a reader needs to say this page and that run are the same thing."""
    live = run_label.startswith("--live")
    meta = getattr(source, "meta", {}) or {}
    descriptor = getattr(source, "descriptor", {}) or {}
    path = str(state.get("file") or meta.get("file") or "")
    files = meta.get("files") or []
    source_sha = next((str(f.get("sha256") or "") for f in files if os.path.abspath(str(f.get("path") or "")) == os.path.abspath(path)), "") or (file_hash(path) or "")
    run_path = getattr(source, "path", None)
    out = {
        "mode": "live session" if live else "saved run",
        "run": run_label,
        "file": os.path.basename(path),
        "sourceSha256": source_sha[:SHA_PREFIX],
        "runSha256": (sha256_text(read_text(run_path))[:SHA_PREFIX] if run_path and os.path.exists(str(run_path)) else ""),
        "python": str(meta.get("python") or ""),
        "runtimeVersion": str(meta.get("runtimeVersion") or descriptor.get("runtimeVersion") or ""),
        "exitCode": state.get("exitCode"),
        "stepCount": int((state.get("nav") or {}).get("count") or 0),
        "recordedAt": str(meta.get("started") or descriptor.get("started") or ""),
        "truncated": list(truncated),
    }
    debug = state.get("debug") if isinstance(state.get("debug"), dict) else None
    paused = debug.get("paused") if isinstance(debug, dict) and isinstance(debug.get("paused"), dict) else None
    if paused:
        out["paused"] = "%s:%s" % (os.path.basename(str(paused.get("file") or "?")), paused.get("line"))
    return out


def write_history(source: Any, args: Any, run_label: str) -> dict:
    """The command: build, merge the prose, write the file, report what a reader can check."""
    data = build(
        source,
        list(getattr(args, "checkpoints", None) or []),
        run_label=run_label,
        pad=max(0, int(args.pad)),
        limit=max(1, int(args.limit)),
        lang=str(args.lang),
        scope=bool(args.scope),
        value_chars=getattr(args, "value_chars", None),
    )
    prosed = 0
    if args.prose:
        try:
            with open(args.prose, "r", encoding="utf-8") as fh:
                prose = json.load(fh)
        except (OSError, ValueError) as exc:
            raise AgentError('cannot read the prose file %s: %s' % (args.prose, exc), 'a JSON object: {"heading": "...", "steps": {"step-55": {"title": "..."}}}') from None
        merge_prose(data, prose)
        prosed = sum(1 for card in data["steps"] if card["title"] or card["text"] or card["note"])
    warnings = data.pop("_warnings", [])
    path = os.path.abspath(str(args.out))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    added = len(data["steps"])
    if getattr(args, "append", False) and os.path.exists(path):
        data = append_to(path, data)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    return {
        "path": path,
        "added": added,
        "checkpoints": len(data["steps"]),
        "files": sorted(data["files"]),
        "prosed": prosed,
        "truncated": data["meta"]["truncated"],
        "warnings": warnings,
    }


def append_to(path: str, data: dict) -> dict:
    """Add this run's checkpoints to a page that already exists, keeping every id unique.

    A program passes one pause at a time, so following it through several means running the verb
    at each one. Merging the generated objects keeps the guarantee that no value was retyped;
    merging them by hand in a scratch script is how a typo gets onto the page.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            old = json.load(fh)
    except (OSError, ValueError) as exc:
        raise AgentError("cannot append to %s: %s" % (path, exc), "drop --append to start the page again") from None
    if not isinstance(old, dict) or not isinstance(old.get("steps"), list):
        raise AgentError("%s is not a code-history page" % path, "drop --append to start the page again")
    taken = {str(card.get("id")) for card in old["steps"]}
    for card in data["steps"]:
        cid = str(card["id"])
        n = 2
        while cid in taken:
            cid = "%s-%d" % (card["id"], n)
            n += 1
        taken.add(cid)
        card["id"] = cid
    for key, lines in data["files"].items():
        kept = list(old.get("files", {}).get(key) or [])
        if len(lines) > len(kept):
            kept.extend([""] * (len(lines) - len(kept)))
        for i, text in enumerate(lines):
            if text:
                kept[i] = text
        old.setdefault("files", {})[key] = kept
    old["steps"] = list(old["steps"]) + list(data["steps"])
    old["meta"] = {**old.get("meta", {}), "truncated": list(old.get("meta", {}).get("truncated") or []) + list(data["meta"]["truncated"])}
    return old


def merge_prose(data: dict, prose: dict) -> None:
    """Prose fills prose. A file that names a generated field is an error, not a silent overwrite."""
    if not isinstance(prose, dict):
        raise AgentError("the prose file must be a JSON object", 'e.g. {"heading": "...", "steps": {"step-55": {"title": "..."}}}')
    by_id = {card["id"]: card for card in data["steps"]}
    for key, value in prose.items():
        if key == "steps":
            continue
        if key not in PROSE_TOP:
            raise AgentError('prose may not set "%s"' % key, "prose fields: %s, and steps" % ", ".join(PROSE_TOP))
        data[key] = str(value)
    for cid, fields in (prose.get("steps") or {}).items():
        card = by_id.get(cid)
        if card is None:
            raise AgentError("no checkpoint %s in this page" % cid, "its checkpoints: %s" % ", ".join(list(by_id)[:12]))
        for field, value in (fields or {}).items():
            if field in PROSE_LISTS:
                if not isinstance(value, list) or not all(valid_link(v) for v in value):
                    raise AgentError('prose "%s" on %s must be a list of links' % (field, cid), 'e.g. "evidence": ["notes/run.txt", "https://example.com/issue/1"]')
                card[field] = list(value)
                continue
            if field not in PROSE_STEP:
                raise AgentError('prose may not set "%s" on %s: it comes from the run' % (field, cid), "prose fields on a checkpoint: %s" % ", ".join(PROSE_STEP + PROSE_LISTS))
            card[field] = str(value)
