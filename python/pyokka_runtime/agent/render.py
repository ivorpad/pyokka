"""Bounded text rendering of the contract shapes for the ``pyokka`` commands (``commands.py`` dispatches here).

One ``render_<command>(result, source, args) -> list[str]`` per command; ``render`` picks it,
prints the stale lines first and redacts every line on the way out. ``file:line`` and step
numbers, values inline, moves listed: never a range id, never base64. The graph and the
exceptions report render in their own modules (``graph.py``, ``exceptions.py``).
"""

from __future__ import annotations

import os
from typing import Any, Callable

from ..protocol import PROVENANCE_NODES
from ..redact import redact
from .exceptions import render_exceptions
from .graph import render_graph
from .http import render_http
from .origin.text import render_origin
from .live import stop_reason
from .render_debug import exec_error, is_debug_reply, recording_start_lines, recording_suffix, render_debug_exec, render_debug_state, render_debug_stop, render_record
from .recording import cut_line

MOVE_LABEL = {"into": "into", "over": "over", "out": "out", "back": "back", "backOver": "back-over", "backOut": "back-out"}
TEXT_MAX = 160
OUTPUT_LINES = 20
OUTPUT_LINES_SCOPE = 200
WHY_VALUE = 100
WHY_STATEMENT = 80
WHY_INPUT = 60


def _one_line(text: Any, limit: int = TEXT_MAX) -> str:
    return cut_line(text, limit, strip=True)  # a cut says how much it left out


def _loc(source: Any, file: str | None, line: int | None) -> str:
    name = source.display_path(file) if hasattr(source, "display_path") else (file or "<unknown>")
    return "%s:%s" % (name, line) if line else name


#: what `staleReason` means to a reader, and why they should not skip the line. A debug stop reads
#: its source from the editor when the file is open, so unsaved edits are shown as if they had run
#: and their line numbers can disagree with the stack's (`staleness` in src/agent/bridgeDebugReply.ts).
_STALE_TEXT = {
    "unsaved": "stale: %s has unsaved edits; the source below is the editor's, not the code that is running",
    "disk": "stale: %s changed on disk since the run started; the source below is not the code that ran",
}


def _stale_lines(result: dict, source: Any) -> list[str]:
    files = result.get("staleFiles")
    if files is None and hasattr(source, "stale_files"):
        files = source.stale_files()
    template = _STALE_TEXT.get(str(result.get("staleReason") or ""), "stale: %s changed since the run")
    return [template % p for p in (files or [])]


def render(command: str, result: dict, source: Any, args: Any) -> str:
    lines: list[str] = _stale_lines(result, source)
    if command == "graph" and getattr(args, "dot", False):
        from .graph_dot import render_dot

        lines = ["// " + l for l in lines] + render_dot(result).split("\n")
        return "\n".join(redact(l) for l in lines) + "\n"
    fn: Callable[[dict, Any, Any], list[str]] = {
        "story": render_story,
        "steps": render_steps,
        "step": render_stop,
        "context": render_context,
        "debug": render_stop,
        "continue": render_stop,
        "pause": render_stop,
        "restart": render_stop,
        "stop": render_stopped,
        "break": render_break,
        "watches": render_watches,
        "locals": render_locals,
        "values": render_values,
        "find": render_find,
        "var": render_var,
        "why": render_why,
        "origin": render_origin,
        "eval": render_eval,
        "exec": render_debug_exec,
        "record": render_record,
        "expand": render_expand,
        "release": render_release,
        "state": render_state,
        "walkthrough": render_walkthrough,
        "graph": render_graph,
        "exceptions": render_exceptions,
        "narrate": render_narrate,
        "history": render_history,
        "http": render_http,
        "diff": _render_diff,
        "tour": _render_tour,
    }[command]
    lines.extend(fn(result, source, args))
    return "\n".join(redact(l) for l in lines) + "\n"


def _render_tour(result: dict, source: Any, args: Any) -> list[str]:
    from .tour.text import render_tour

    return render_tour(result, wrote=getattr(args, "out", None)).split("\n")


def _render_diff(result: dict, source: Any, args: Any) -> list[str]:
    from .diff import render_diff

    return render_diff(result, source, args)


def _block_lines(block_lines: list[dict], src_width: int) -> list[str]:
    out = []
    prev: int | None = None
    for e in block_lines:
        if prev is not None and e["line"] - prev > 1:
            out.append("%s  …" % (" " * src_width))
        mark = ">" if e.get("current") else " "
        step = ("#%d" % e["step"]) if e.get("step") is not None else ""
        out.append("%s%s  %s%s" % (mark, str(e["line"]).rjust(src_width), e["text"].rstrip(), ("   " + step) if step else ""))
        prev = e["line"]
    return out


def render_story(result: dict, source: Any, args: Any) -> list[str]:
    head = "%d steps, %d blocks" % (result["count"], result["total"])
    if result.get("filtered"):
        head += ", %d matching" % result["matched"]
    if result["shown"] < result["matched"]:
        head += " (showing %d)" % result["shown"]
    out = [head]
    if not result["blocks"]:
        out.append("nothing ran that matches; try `story` without a filter or `steps`")
        return out
    for b in result["blocks"]:
        out.append("")
        first_line = b["lines"][0]["line"] if b["lines"] else 0
        out.append("## %s  %s  steps %d–%d" % (b["function"], _loc(source, b["file"], first_line), b["firstStep"], b["lastStep"]))
        if b.get("noSource"):
            out.append("   (no source available)")
            continue
        width = max(len(str(e["line"])) for e in b["lines"])
        out.extend(_block_lines(b["lines"], width))
    if result.get("truncated"):
        out.append("")
        out.append("… %d more blocks; narrow with --file F, --scope NAME or --line F:L, or raise --limit" % (result["matched"] - result["shown"]))
    return out


def _flags(row: dict) -> str:
    return (" [" + ",".join(row["flags"]) + "]") if row.get("flags") else ""


def render_steps(result: dict, source: Any, args: Any) -> list[str]:
    out = []
    if "line" in result:
        out.append("%d steps on %s (of %d)" % (result["total"], _loc(source, result["line"]["file"], result["line"]["line"]), result["count"]))
    else:
        out.append("steps %d.. of %d" % (result.get("from", 0), result["count"]))
    for r in result["steps"]:
        out.append("#%-6d %s  %s  depth %d%s" % (r["step"], _loc(source, r["file"], r["line"]), r["function"], r["depth"], _flags(r)))
    if result.get("next") is not None:
        out.append("next: --from %d" % result["next"])
    return out


def _paused_line(paused: dict, source: Any, loc: dict | None = None) -> str:
    """``paused at file:line (reason)``: the frontier of a debug run; the slice's location fills a missing file."""
    file = paused.get("file") or (loc or {}).get("file")
    line = paused.get("line") if paused.get("line") is not None else (loc or {}).get("line")
    return "paused at %s (%s%s)" % (_loc(source, file, line), stop_reason(paused), recording_suffix(paused))


def _locals_lines(variables: list, indent: str = "  ") -> list[str]:
    return ["%s%s = %s" % (indent, v.get("name"), _one_line(v.get("text"))) for v in variables if isinstance(v, dict)]


def _output_lines(output: Any, scope: bool = False) -> list[str]:
    """What the program printed so far at a pause: the last 20 lines (200 with ``--scope``), indented; nothing when it printed nothing."""
    if not isinstance(output, dict):
        return []
    lines = str(output.get("text") or "").splitlines()
    if not lines:
        return []
    shown = lines[-(OUTPUT_LINES_SCOPE if scope else OUTPUT_LINES) :]
    return ["output (last %d line%s):" % (len(shown), "" if len(shown) == 1 else "s"), *["  " + line for line in shown]]


def render_stop(result: dict, source: Any, args: Any) -> list[str]:
    """A debug stop (``debug``, ``continue``, ``pause``, ``step`` at the pause): the slice under a ``paused at`` line, or ``finished``.

    A ``record: false`` session has no trace behind the pause, so its stop is rendered by
    ``render_debug`` instead: no step numbers, no moves, no values.
    """
    fin = result.get("finished")
    if isinstance(fin, dict):
        # `stepped` says how many of a `--count N` run's stops happened before the program ended
        return render_debug_stop(result, source, args) if result.get("stepped") is not None else ["finished: exit %s, %s steps" % (fin.get("exitCode"), fin.get("stepCount"))]
    if result.get("resumed") or result.get("requested") or is_debug_reply(result):
        return render_debug_stop(result, source, args)
    return render_context(result, source, args)


def render_stopped(result: dict, source: Any, args: Any) -> list[str]:
    """``stop``: what the run that just ended did, or why there was nothing to stop."""
    if not result.get("stopped"):
        return ["nothing to stop: %s" % (result.get("hint") or "no debug run is in flight")]
    fin = result.get("finished") or {}
    return ["stopped: exit %s, %s steps" % (fin.get("exitCode"), fin.get("stepCount"))]


def _returned_text(value: Any) -> str:
    """A recorded return value; null is a body that ran off its end."""
    return "None (end of body)" if value is None else _one_line(value)


def _call_text(call: dict) -> str:
    """``helper #6 → 2``: a call the statement made, its entry step and what it returned or raised."""
    head = "%s #%d" % (call["function"], call["step"])
    if "returned" in call:
        return "%s → %s" % (head, _returned_text(call["returned"]))
    if "raised" in call:
        return "%s raised %s" % (head, call["raised"])
    return head


def render_context(result: dict, source: Any, args: Any) -> list[str]:
    if is_debug_reply(result):
        return render_debug_stop(result, source, args)
    loc = result["location"]
    out = []
    paused = result.get("paused")
    if isinstance(paused, dict):
        out.append(_paused_line(paused, source, loc))
    if "from" in result and result["from"] != result["step"]:
        out.append("from step %d" % result["from"])
    flags = (" [" + ",".join(result["flags"]) + "]") if result.get("flags") else ""
    out.append("step %d/%s  %s  %s%s" % (result["step"], result.get("count", "?"), _loc(source, loc["file"], loc["line"]), loc["function"], flags))
    out.extend(recording_start_lines(result))
    stack = result.get("stack") or []
    if len(stack) > 1:
        out.append("stack: " + " ← ".join("%s %s #%d" % (f["function"], _loc(source, f["file"], f["line"]), f["step"]) for f in stack))
    b = result["block"]
    cap = (" (%d of %d lines; --scope for all)" % (len(b["lines"]), b["totalLines"]) if b.get("totalLines") is not None else " (first %d lines; --scope for all)" % len(b["lines"])) if b.get("capped") else ""
    span = ("steps %d–%d" % (b["firstStep"], b["lastStep"]) if b.get("lastStep") is not None else "from step %d" % b["firstStep"]) if b.get("firstStep") is not None else ""
    left = ("  returned %s" % _returned_text(b["returned"])) if "returned" in b else ("  raised %s" % b["raised"]) if "raised" in b else ""
    out.append("block %s  %s  %s%s%s" % (b["function"], _loc(source, b["file"], None), span, cap, left))
    if b["lines"]:
        width = max(len(str(e["line"])) for e in b["lines"])
        out.extend(_block_lines(b["lines"], width))
    else:
        out.append("   (no source available)")
    calls = result.get("calls") or []
    if calls:
        out.append("calls: " + " · ".join(_call_text(c) for c in calls))
    values = result.get("values") or []
    if values:
        cap = (" (%d of %d; --scope for all)" % (len(values), result["valuesTotal"]) if result.get("valuesTotal") is not None else " (%d shown; --scope for all)" % len(values)) if result.get("valuesCapped") else ""
        out.append("values%s:" % cap)
        for v in values:
            ctx = ("%s = " % v["context"]) if v.get("context") else ""
            out.append("  #%d %s  %s%s" % (v["step"] if v["step"] is not None else -1, _loc(source, v.get("file"), v["line"]), ctx, _one_line(v["text"])))
    variables = result.get("locals")
    if isinstance(paused, dict) and isinstance(variables, list):
        out.append("locals:" if variables else "locals: (none)")
        out.extend(_locals_lines(variables))
    if isinstance(paused, dict):
        out.extend(_output_lines(result.get("output"), bool(getattr(args, "scope", False))))
    not_run = (result.get("coverage") or {}).get("notRun") or []
    if not_run:
        out.append("not run: " + ", ".join(str(l) for l in not_run))
    errors = result.get("errors") or []
    if errors:
        out.append("errors:")
        for e in errors:
            where = ("%s " % _loc(source, b["file"], e["line"])) if e.get("line") else ""
            out.append("  #%s %s%s: %s%s" % (e.get("step"), where, e.get("type"), _one_line(e.get("message")), " (handled)" if e.get("handled") else ""))
    moves = result["moves"]
    out.append("moves: " + " · ".join("%s %s" % (MOVE_LABEL[k], v if v is not None else "—") for k, v in moves.items()))
    return out


def render_break(result: dict, source: Any, args: Any) -> list[str]:
    """The breakpoints after the change, then where an exception pauses the run."""
    bps = [b for b in result.get("breakpoints") or [] if isinstance(b, dict)]
    tail = ["exceptions: %s" % result["exceptions"]] if result.get("exceptions") else []
    if not bps:
        return ["no breakpoints; `break --live FILE:LINE [--when EXPR]` adds one", *tail]
    out = ["%d breakpoint%s" % (len(bps), "" if len(bps) == 1 else "s")]
    for bp in bps:
        # a function breakpoint is named by its function; the runtime fills the location when it resolves it
        where = _loc(source, bp["file"], bp.get("line")) if bp.get("file") else None
        if bp.get("function"):
            line = "  %s%s" % (bp["function"], "  " + where if where else "")
        else:
            line = "  %s" % _loc(source, bp.get("file"), bp.get("line"))
        if bp.get("condition"):
            line += "  if %s" % _one_line(bp["condition"], 80)
        if bp.get("error"):
            line += "  (%s)" % _one_line(bp["error"], 80)
        elif bp.get("resolvedLine") is not None:
            line += "  -> resolved line %s" % bp["resolvedLine"]
        else:
            line += "  (not resolved yet)"
        out.append(line)
    return out + tail


def render_watches(result: dict, source: Any, args: Any) -> list[str]:
    watches = [w for w in result.get("watches") or [] if isinstance(w, dict)]
    if not watches:
        return ["no watches; `watches --live --add EXPR` shows one at every stop, `--break-when change|true` pauses on it"]
    out = ["%d watch%s" % (len(watches), "" if len(watches) == 1 else "es")]
    for w in watches:
        if w.get("breakWhen"):
            what = "break when true" if w.get("breakWhen") == "true" else "break when it changes"
            if w.get("error"):
                what += "  (%s)" % _one_line(w["error"], 80)
        elif w.get("error"):
            what = "(%s)" % _one_line(w["error"], 80)
        elif "text" in w:
            what = "= %s" % _one_line(str(w.get("text")), 100)
        else:
            what = "(no value at this step)"
        out.append("  %s  %s  %s" % (w.get("id"), _one_line(w.get("exp"), 80), what))
    return out


def render_locals(result: dict, source: Any, args: Any) -> list[str]:
    variables = [v for v in result.get("locals") or [] if isinstance(v, dict)]
    return _locals_lines(variables, "") if variables else ["(no variables in this frame)"]


def render_values(result: dict, source: Any, args: Any) -> list[str]:
    values = result["values"]
    out = ["%d values on %s" % (len(values), _loc(source, result["file"], result["line"]))]
    for v in values:
        ctx = ("%s = " % v["context"]) if v.get("context") else ""
        hit = (" hit %s" % v["hit"]) if v.get("hit") else ""
        out.append("  #%d%s  %s%s" % (v["step"] if v["step"] is not None else -1, hit, ctx, _one_line(v["text"])))
    if not values:
        # An assignment logs nothing, so the obvious line to ask about is the one that answers
        # with nothing. Name `var` when the line assigns something: that is what the asker wanted.
        names = _assigned_on(source, result.get("file"), result.get("line"))
        first = ("`var %s` lists every change of it" % names[0]) if names else "`context --line` shows what ran"
        out.append("no value was logged there; %s, `eval` (with --keep) reads the final state" % first)
    return out


def _assigned_on(source: Any, file: Any, line: Any) -> list[str]:
    """The names a statement on this line assigns, from the binding table; empty when unknown."""
    try:
        f = source.resolve_file(str(file))
        table = source.bindings(int(f["fileId"]))
    except Exception:  # noqa: BLE001  a live session has no binding table, and that is fine
        return []
    out: list[str] = []
    for binding in table.values():
        if int(binding.get("line", -1)) == int(line):
            out.extend(str(t) for t in binding.get("assigns") or [])
    return out


def render_find(result: dict, source: Any, args: Any) -> list[str]:
    out = ["%d hits for %r%s" % (result["total"], result["text"], " (showing %d)" % len(result["hits"]) if result.get("truncated") else "")]
    for h in result["hits"]:
        step = ("#%d " % h["step"]) if h.get("step") is not None else ""
        where = _loc(source, h["file"], h["line"]) if h.get("file") else h["kind"]
        ctx = ("%s = " % h["context"]) if h.get("context") and h["kind"] in ("value", "local") else (("%s: " % h["context"]) if h.get("context") and h["kind"] == "error" else "")
        out.append("  %s%s  %s%s" % (step, where, ctx, _one_line(h["text"])))
    if not result["hits"]:
        out.append("nothing matched; `story` lists the lines that ran")
    return out


VAR_READS_SHOWN = 4


def render_var(result: dict, source: Any, args: Any) -> list[str]:
    changes = result.get("changes") or []
    total = result.get("total", len(changes))
    head = "%d change%s of %s" % (total, "" if total == 1 else "s", result.get("name"))
    if result.get("truncated"):
        head += " (showing %d; --limit for more, --file F or --scope NAME to narrow)" % len(changes)
    out = [head]
    if not changes:
        hint = "no assignment of it ran" if result.get("recordedLocals", True) else "the run recorded no locals (saved with --no-locals?)"
        out.append("nothing recorded for %s: %s; `find` searches values and source lines for the text" % (result.get("name"), hint))
        return out
    for row in changes:
        where = "%s  %s" % (_loc(source, row.get("file"), row.get("line")), row.get("function") or "<module>")
        if row.get("text") is not None:
            what = "%s = %s%s" % (row.get("name"), _one_line(row.get("text")), "  (same object)" if row.get("unchanged") else "")
        else:
            what = "%s  assigned here (value not recorded)" % row.get("name")
        line = "  #%d %s  %s" % (row.get("step", -1), where, what)
        reads = [r for r in row.get("reads") or [] if isinstance(r, dict)]
        if reads:
            parts = ["%s = %s" % (r.get("name"), _one_line(r.get("text"), 60) if r.get("text") is not None else "?") for r in reads[:VAR_READS_SHOWN]]
            if len(reads) > VAR_READS_SHOWN:
                parts.append("… +%d" % (len(reads) - VAR_READS_SHOWN))
            line += "   ← " + ", ".join(parts)
        out.append(line)
    if not result.get("recordedLocals", True):
        out.append("(values come from logged statements only: this run recorded no locals)")
    return out


# a leaf of a recording that began at a pause (`--record-from`): its value was made before step 0
BEFORE_RECORDING = "   made before #0, where the recording started"


def _why_node(n: dict, prefix: str, source: Any) -> str:
    parts = []
    if n.get("name"):
        if n.get("text") is not None:
            parts.append("%s = %s%s" % (n["name"], _one_line(n["text"], WHY_VALUE), "  (same object)" if n.get("unchanged") else ""))
        elif n.get("step") is not None:
            parts.append("%s  assigned here (value not recorded)" % n["name"])
        else:
            parts.append("%s = ?%s" % (n["name"], BEFORE_RECORDING if n.get("beforeRecording") else ""))
    if n.get("step") is not None:
        parts.append("#%s %s %s" % (n["step"], _loc(source, n.get("file"), n.get("line")), n.get("function") or "<module>"))
    if n.get("statement"):
        parts.append(_one_line(n["statement"], WHY_STATEMENT))
    return prefix + "   ".join(parts) + ("  …" if n.get("cut") else "")


def _why_call(c: dict, source: Any) -> str:
    s = "↳ %s #%s–#%s %s" % (c.get("name"), c.get("entryStep"), c.get("returnStep"), _loc(source, c.get("file"), c.get("line")))
    inputs = [i for i in c.get("inputs") or [] if isinstance(i, dict)]
    if inputs:
        s += "   in " + ", ".join("%s = %s" % (i.get("name"), _one_line(i.get("text"), WHY_INPUT)) for i in inputs)
    if c.get("result") is not None:
        s += "   out %s" % _one_line(c["result"], WHY_STATEMENT)
    return s


def render_why(result: dict, source: Any, args: Any) -> list[str]:
    """The twin of ``src/shared/provenanceText.ts``: the header, one line per node depth-first (its reads,
    then its calls, then its opaque calls), the truncation note. Keep the two identical."""
    out = ["why %s at #%s" % (result["name"], result["step"]) if result.get("name") else "why #%s" % result["step"]]

    def walk(n: dict, level: int) -> None:
        pad = "  " * level
        out.append(pad + _why_node(n, "← " if level else "", source))
        for r in n.get("reads") or []:
            walk(r, level + 1)
        for c in n.get("calls") or []:
            out.append(pad + "  " + _why_call(c, source))
        for o in n.get("opaque") or []:
            out.append("%s  · %s   not stepped" % (pad, o))

    walk(result["root"], 0)
    if result.get("truncated"):
        out.append("… more inputs than %d nodes show; ask why for a node's name at its step" % PROVENANCE_NODES)
    if result.get("conclusion"):
        out.append(str(result["conclusion"]))
    return out


def render_eval(result: dict, source: Any, args: Any) -> list[str]:
    return ["%s = %s" % (result["expression"], _one_line(result.get("text"), 2000))]


def _node_lines(node: dict, indent: str = "  ") -> list[str]:
    out = []
    for p in node.get("props") or []:
        out.append("%s%s: %s" % (indent, p.get("name"), _one_line(p.get("value"))))
    return out


def render_expand(result: dict, source: Any, args: Any) -> list[str]:
    node = result.get("node") or {}
    out = ["%s %s" % (node.get("type"), _one_line(node.get("value"), 400))]
    out.extend(_node_lines(node)[:100])
    return out


def render_release(result: dict, source: Any, args: Any) -> list[str]:
    return ["released the kept runner (pid %s)" % result.get("pid") if result.get("released") else "the kept runner (pid %s) was already gone" % result.get("pid")]


def render_state(result: dict, source: Any, args: Any) -> list[str]:
    if result.get("kind") == "debug":
        return render_debug_state(result, source, args)
    nav = result.get("nav") or {}
    live = result.get("live")
    if live:
        head = "%s: %s steps, live in VS Code (pid %s)" % (result.get("displayName") or source.display_path(result.get("file")), nav.get("count") or 0, live.get("pid"))
        if result.get("running"):
            head += ", running"
        elif not result.get("finished"):
            head += ", no finished run yet"
        if result.get("stale"):
            head += ", stale"
        loc = result.get("location") or {}
        if nav.get("active"):
            where = "Time Machine at step %s/%s  %s  %s" % (nav.get("step"), nav.get("count"), _loc(source, loc.get("file"), loc.get("line")), loc.get("function") or "")
        else:
            where = "Time Machine inactive: `step --live --into` starts it at the first step, `step --live --to N` jumps"
        out = [head, where]
        dbg = result.get("debug")
        if isinstance(dbg, dict) and dbg.get("active"):
            paused = dbg.get("paused")
            out.append("debug: " + _paused_line(paused, source, loc) if isinstance(paused, dict) else "debug: running (`pause --live` stops it at its next statement)")
        return out
    keep = result.get("keep")
    return [
        "%s: %d steps, exit %s%s" % (result.get("file"), result["nav"]["count"], result.get("exitCode"), ", stale" if result.get("stale") else ""),
        "kept runner: pid %s" % keep["pid"] if keep else "no kept runner (eval needs `run --keep`)",
    ]


WALK_LINE = 100
WALK_VALUES = 8


def _walk_line(text: str, limit: int = WALK_LINE) -> str:
    indent = len(text) - len(text.lstrip(" "))
    return " " * indent + _one_line(text, limit - indent)


def render_walkthrough(result: dict, source: Any, args: Any) -> list[str]:
    head = "%d moments over %d steps" % (result["total"], result["count"])
    if result["shown"] < result["total"]:
        head += " (showing %d)" % result["shown"]
    out = [head]
    if not result["moments"]:
        out.append("nothing ran; `state` says what the run is")
        return out
    for m in result["moments"]:
        out.append(_walk_line("#%d  %s" % (m["step"], m["text"])))
        if m.get("gloss"):
            out.append(_walk_line("      %s" % m["gloss"]))
        values = [v for v in m.get("values") or [] if v.get("role") != "value"]  # a value moment's sentence already says `name = text`
        for v in values[:WALK_VALUES]:
            out.append(_walk_line("      %s %s = %s" % (v.get("role"), v.get("name"), v.get("text"))))
        if len(values) > WALK_VALUES:
            out.append("      … %d more (--json lists them)" % (len(values) - WALK_VALUES))
        if m.get("more"):
            what = "calls" if m["kind"] in ("call", "tool") else "values"
            out.append("      ≡ %d more %s like this" % (m["more"], what))
    if result.get("truncated"):
        out.append("… %d more moments; narrow with --from N --to M, --scope NAME or --file F" % (result["total"] - result["shown"]))
    return out


def render_narrate(result: dict, source: Any, args: Any) -> list[str]:
    if result.get("prompt") is not None:
        return [result["prompt"]]
    if result.get("error"):
        return ["narration failed: %s" % result["error"], "the walkthrough keeps gloss: null; %s" % (result.get("hint") or "")]
    return ["%d of %d moments glossed by %s, written to %s" % (result["glossed"], result["moments"], result["backend"], result["path"]), "`pyokka walkthrough %s` shows them" % os.path.basename(str(result["path"]))]


def render_history(result: dict, source: Any, args: Any) -> list[str]:
    out = ["warning: %s" % w for w in result.get("warnings") or []]
    out.extend("left out: %s (--limit raises it)" % t for t in result.get("truncated") or [])
    prosed = int(result.get("prosed") or 0)
    added = result.get("added")
    how = "wrote" if added is None or added == result["checkpoints"] else "added %d to" % added
    out.append("%s %s: %d checkpoints over %s%s" % (how, result["path"], result["checkpoints"], ", ".join(result["files"]) or "no file", ", %d with prose" % prosed if prosed else ""))
    out.append("fill the prose, then render: node skills/pyokka/scripts/render-code-history.cjs %s %s" % (result["path"], os.path.splitext(result["path"])[0] + ".html"))
    return out


__all__ = ["exec_error", "render", "render_context", "render_stop", "render_stopped", "render_state", "render_walkthrough", "MOVE_LABEL", "TEXT_MAX", "WALK_LINE"]
