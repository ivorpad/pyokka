"""The review in the debugger: the agenda from the source diff, a breakpoint per changed function, the person's debugger.

``review start`` without ``--full`` plans from ``git diff BASE`` alone, with no run of either tree: one
item per changed function (its hunks as spans), one per module-level hunk, each with a breakpoint at
the first changed statement that decides something, else the first that calls other code, else the
first statement of its first span (``stop_place.py``; a changed ``def`` line breaks at the first statement
of the body, a change inside a multi-line statement at that statement). The entry then runs under the
debugger in the person's VS Code, stopped on entry, with the debugger's own recording on for a
program (a test runs through its runner as a module launch, which has no recording), and
the debugger is driven through ``pyokka_debug`` as always, and ``review stop`` records the pause it is at. Every
debugger route opens a VS Code window; the page and chat keep the full recording of both trees (``start.py``, ``--full``).
"""

from __future__ import annotations

import ast
import json
import os
from typing import Any

from ..live import LIVE_TEXT_LEN, LiveRun, list_sessions, read_descriptor
from ..sessions import _file_matches, descriptor_kind
from ..source import AgentError
from .edges import changed_lines, edges, is_test_file
from .state import Review, now
from .stop_place import stop_line
from .syntax import function_at, parsed

ITEM_KINDS = ("change", "pause")
CONTINUE = "continue in the debugger to the next item (pyokka continue --live; MCP pyokka_debug {\"action\": \"continue\"}), then review stop --say TEXT at the pause"
NEAR = 3  # a pause this many lines past an item's breakpoint still belongs to it (the debugger resolves a breakpoint to the next statement)


# -- the plan ---------------------------------------------------------------------------------------------------------

def spans_of(lines: set[int]) -> list[tuple[int, int]]:
    """Consecutive runs of line numbers as ``(lo, hi)``."""
    out: list[tuple[int, int]] = []
    for n in sorted(set(lines)):
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def span_text(lo: int, hi: int) -> str:
    return "%d-%d" % (lo, hi) if hi > lo else str(lo)


def _past_docstring(node: ast.AST) -> ast.AST:
    """The first statement a breakpoint pauses at inside a def or class: the body's first statement, past a docstring."""
    while isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
        body = node.body
        first = body[0]
        if len(body) > 1 and isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant) and isinstance(first.value.value, str):  # type: ignore[attr-defined]
            node = body[1]
        else:
            node = first
    return node


def breakable_line(source: str, lo: int, hi: int) -> tuple[int, str | None]:
    """``(line, function)``: where a breakpoint for the changed span ``lo..hi`` pauses, and the function it is in.

    The first statement that starts inside the span; a ``def`` or ``class`` header breaks at the first
    statement of its body (the header itself pauses when the function is defined, not when it runs);
    a span inside a statement that started earlier (a multi-line call) breaks at that statement. The
    parse, the statement order and the function list come from ``syntax.parsed``, once for all of a file's spans.
    """
    p = parsed(source)
    if p is None:
        return lo, None
    stmts = p.statements
    first = next((n for n in stmts if lo <= n.lineno <= hi), None)
    if first is None:
        around = [n for n in stmts if n.lineno <= lo <= (n.end_lineno or n.lineno) and not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        if around:
            first = max(around, key=lambda n: n.lineno)
    if first is None:
        return lo, function_at(p.functions, lo)
    node = _past_docstring(first)
    line = int(getattr(node, "lineno", lo))
    return line, function_at(p.functions, line)


def describe(summary: dict) -> str:
    """One paragraph of the plan: what changed, how many items, what is not on the agenda."""
    parts = ["%d changed line%s in %d Python file%s" % (summary.get("lines", 0), "" if summary.get("lines") == 1 else "s", summary.get("files", 0), "" if summary.get("files") == 1 else "s")]
    parts.append("%d item%s on the agenda, one breakpoint each, in the changed functions of %d file%s" % (summary.get("items", 0), "" if summary.get("items") == 1 else "s", summary.get("agenda_files", 0), "" if summary.get("agenda_files") == 1 else "s"))
    aside = []
    if summary.get("module"):
        aside.append("%d at module level" % summary["module"])
    if summary.get("test_items"):
        aside.append("%d in test files" % summary["test_items"])
    if aside:
        parts.append("set aside without a breakpoint: %s (`pyokka break --live FILE:LINE` puts one there)" % ", ".join(aside))
    if summary.get("edges"):
        parts.append("%d edge candidate%s" % (summary["edges"], "" if summary["edges"] == 1 else "s"))
    if summary.get("other_files"):
        parts.append("%d other changed file%s not on the agenda (%s)" % (len(summary["other_files"]), "" if len(summary["other_files"]) == 1 else "s", ", ".join(summary["other_files"][:4])))
    parts.append("removed lines have no place in head to stop at")
    return "; ".join(parts) + "."


def plan_items(repo: str, diff_text: str) -> dict:
    """``{stops, edges, unreached, anomalies, summary, other_files}`` from the diff alone: the agenda of a review in the debugger."""
    changed = changed_lines(diff_text or "")
    items: list[dict] = []
    other: list[str] = []
    total_lines = 0
    for file in sorted(changed, key=lambda f: (is_test_file(f), f)):
        lines = changed[file]
        if not lines:
            continue
        if not file.endswith(".py"):
            other.append(file)
            continue
        try:
            with open(os.path.join(repo, file), encoding="utf-8", errors="replace") as fh:
                source = fh.read()
        except OSError:
            other.append(file)
            continue
        total_lines += len(lines)
        groups: dict[str, list[tuple[int, int, int, str | None]]] = {}
        for lo, hi in spans_of(lines):
            line, function = breakable_line(source, lo, hi)
            key = function if function else "<module>:%d" % lo
            groups.setdefault(key, []).append((lo, hi, line, function))
        for spans in groups.values():
            spans.sort()
            _, _, line0, fn = spans[0]
            if fn:  # a stop on what the change decides, not on its first assignment
                line0 = stop_line(source, [(lo, hi) for lo, hi, _, _ in spans], line0)
            items.append({
                "kind": "change", "file": file, "line": line0, "function": fn or "",
                "spans": [[lo, hi] for lo, hi, _, _ in spans],
                "fact": {"kind": "change", "name": None, "text": "changed line%s %s" % ("s" if len(spans) > 1 or spans[0][1] > spans[0][0] else "", ", ".join(span_text(lo, hi) for lo, hi, _, _ in spans)), "a": None, "b": None},
                "step_a": None, "step_b": None, "test_file": is_test_file(file),
            })
    # the agenda: the changed functions of the program's own files. A change at module level runs at import, before
    # any test does, and a change in a test file is the exerciser rather than the code under review: both are set
    # aside, listed without a breakpoint (a langchain range on 2026-10-19 planned 355 items, 321 of these two kinds)
    agenda = [it for it in items if it["function"] and not it.get("test_file")]
    aside = [it for it in items if not (it["function"] and not it.get("test_file"))]
    for i, item in enumerate(agenda, 1):
        item["n"] = i
    from .hunks import attach_hunks  # each item's removed and added lines, which its stop prints

    attach_hunks(agenda, diff_text or "")
    edge_rows = edges(diff_text or "", repo)
    summary = {
        "lines": total_lines, "files": len({it["file"] for it in items}), "items": len(agenda),
        "functions": len(agenda), "agenda_files": len({it["file"] for it in agenda}),
        "module": sum(1 for it in aside if not it.get("test_file")), "test_items": sum(1 for it in aside if it.get("test_file")),
        "edges": len(edge_rows), "other_files": other,
    }
    summary["text"] = describe(summary)
    return {"stops": agenda, "aside": aside, "edges": edge_rows, "unreached": [], "anomalies": [], "summary": summary, "other_files": other}


# -- the session ------------------------------------------------------------------------------------------------------

def launch_for(data: dict) -> dict:
    """The debugger launch of the review's entry: stopped on entry so the breakpoints go in before anything runs; the
    debugger's recording on for a program. A test runs through its runner as a module launch, which has no recording."""
    from ..debug_start import build_launch
    from ..one_test import runner_for
    from .start import test_of

    repo, rel = str(data["repo"]), str(data["entry"])
    entry = os.path.join(repo, rel)
    argv = [str(a) for a in (data.get("argv") or [])]
    env = {"PYTHONDONTWRITEBYTECODE": "1"}
    test = test_of(data.get("test"), rel)
    if test:
        module, words = runner_for(entry, test)
        return build_launch(module=module, args=[*words, *argv], cwd=repo, env=env, python=data.get("python"), stop_on_entry=True)
    launch = build_launch(program=entry, args=argv, cwd=repo, env=env, python=data.get("python"), stop_on_entry=True, record=True)
    if data.get("exact"):
        launch["exact"] = list(data["exact"])
    return launch


def abs_file(review: Review, file: str) -> str:
    return file if os.path.isabs(file) else os.path.join(review.repo, file)


def breakpoints_for(review: Review, items: list[dict]) -> list[dict]:
    return [{"file": abs_file(review, str(it["file"])), "line": int(it["line"])} for it in items if it.get("line") is not None]


def open_debug(review: Review) -> tuple[dict, list[str]]:
    """Launch the entry under the debugger in VS Code, set a breakpoint per remaining item, leave it paused on entry.

    ``(view, lines)``: the view for the state and the lines that tell where the person is looking. Raises ``AgentError``
    when no VS Code answers.
    """
    from ..debug_start import focus_editor, open_debug_session

    launch = launch_for(review.data)
    remaining = [review.stop(n) for n in review.remaining()]
    bps = breakpoints_for(review, [s for s in remaining if s])
    source, send, route = open_debug_session(launch)
    try:
        reply = source.debug(launch=send)
        if bps:
            source.breakpoints(add=bps)
        descriptor = source.descriptor.get("descriptor")
        paused = reply.get("paused") if isinstance(reply.get("paused"), dict) else {}
        finished = reply.get("finished") if isinstance(reply.get("finished"), dict) else None
        if route in ("uri", "run") and paused and not finished:
            focus_editor(str(paused.get("file") or launch.get("program") or ""), int(paused.get("line") or 1))
    finally:
        source.close()
    recorded = bool(launch.get("record"))
    entry = os.path.basename(str(review.data.get("entry")))
    view = {"kind": "vscode-debug", "route": route, "descriptor": descriptor, "record": recorded, "opened_at": now(), "launch": launch,
            "entry_pause": {"file": paused.get("file"), "line": paused.get("line")} if paused else None, "finished": finished}
    how = "launched VS Code (code --open-url)" if route == "uri" else "in the open VS Code window"
    if finished:
        lines = ["view: VS Code, %s: %s ran to its end (exit %s) before any breakpoint was set; `review view vscode` runs it again." % (how, entry, finished.get("exitCode"))]
    else:
        lines = ["view: VS Code debug session on %s, %s, paused on entry at %s:%s; %d breakpoint%s on the changed lines; the debugger's recording is %s. `review stop` continues to the first one." % (
            entry, how, os.path.basename(str(paused.get("file") or "?")), paused.get("line"), len(bps), "" if len(bps) == 1 else "s",
            "on (stops on passed items move its Time Machine)" if recorded else "off (a test runs through its runner, which has no recording; a passed item needs the run again)")]
    return view, lines


def review_descriptor(review: Review) -> dict | None:
    """The review's debug session as a descriptor: the one ``start`` kept while it is published, else a debug session on
    the entry; None when neither is. ``connect`` opens it, and the ``session:`` lines name its file."""
    view = review.data.get("view") if isinstance(review.data.get("view"), dict) else {}
    descriptor = None
    path = view.get("descriptor")
    if path:
        descriptor = read_descriptor(str(path))
    if descriptor is None:
        entry = abs_file(review, str(review.data.get("entry")))
        candidates = [d for d in list_sessions() if _file_matches(d, entry) or _file_matches(d, os.path.basename(entry))]
        candidates.sort(key=lambda d: descriptor_kind(d) != "debug")
        descriptor = candidates[0] if candidates else None
    return descriptor


def connect(review: Review) -> LiveRun:
    """The review's debug session (``review_descriptor``); a refusal when none answers."""
    descriptor = review_descriptor(review)
    if descriptor is None:
        raise review.refuse("the VS Code debug session of this review is gone (the window closed, or the program was stopped)",
                            ["`review view vscode` runs the entry again under the debugger with a breakpoint on each remaining item; what was shown stays shown"],
                            "review view vscode")
    try:
        return LiveRun(descriptor)
    except AgentError as exc:
        raise review.refuse("cannot reach the review's debug session: %s" % exc.message, [exc.hint] if exc.hint else ["`review view vscode` starts it again"], "review view vscode") from None


def recorded(review: Review) -> bool:
    """Whether the review's debug session records as it runs (a program: yes; a test through its runner: no)."""
    view = review.data.get("view")
    return bool(isinstance(view, dict) and view.get("record"))


# -- pauses -----------------------------------------------------------------------------------------------------------

def current_pause(live: LiveRun) -> dict | None:
    """``{file, line, reason, step, function}`` of the pause the session is at; ``{finished: {...}}`` when the program ended;
    None while it runs. Read from ``state``, which every socket serves."""
    from ..live import stop_reason

    state = live.state()
    finished = state.get("finished")
    dbg = state.get("debug") if isinstance(state.get("debug"), dict) else {}
    if isinstance(dbg.get("finished"), dict):
        finished = dbg["finished"]
    paused = dbg.get("paused") if isinstance(dbg.get("paused"), dict) else None
    if paused is None:
        if finished:
            return {"finished": finished if isinstance(finished, dict) else {"exitCode": (state.get("exitCode") if isinstance(state.get("exitCode"), int) else None)}}
        return None
    step = paused.get("step") if isinstance(paused.get("step"), int) else None
    if step is None and isinstance((state.get("nav") or {}).get("step"), int):
        step = int(state["nav"]["step"])
    return {"file": str(paused.get("file") or ""), "line": int(paused["line"]) if paused.get("line") is not None else None, "function": str(paused.get("function") or ""), "reason": stop_reason(paused), "step": step}


def mark_ended(review: Review, finished: dict | None) -> None:
    """The program ended: the items never recorded become the plan's unreached lines."""
    review.data["ended"] = {"exit": (finished or {}).get("exitCode"), "at": now()}
    review.plan["unreached"] = unreached_items(review)
    if review.phase == "stops":
        review.phase = "findings"
    review.save()


def run_over(review: Review) -> bool:
    """Whether the program is over: marked ended, or the session says finished, or the session is gone."""
    if isinstance(review.data.get("ended"), dict):
        return True
    try:
        live = connect(review)
    except AgentError:
        mark_ended(review, None)
        return True
    try:
        pause = current_pause(live)
    except AgentError:
        pause = None
    finally:
        live.close()
    if pause is not None and pause.get("finished") is not None:
        mark_ended(review, pause["finished"])
        return True
    return False


def pause_values(live: LiveRun) -> list[tuple[str, str]]:
    """The paused frame's locals as ``(name, text)`` pairs, at the length the CLI asks a live pause for.

    Without ``text_len`` the runtime answers with the editor's 200 characters, which cut a 256-character dataclass
    local at the smoke test's first stop (2026-10-19); the stop prints these texts as they come, so they are read whole.
    """
    try:
        rows = live.locals(text_len=LIVE_TEXT_LEN).get("locals") or []
    except AgentError:
        return []
    return [(str(v.get("name")), str(v.get("text"))) for v in rows if isinstance(v, dict) and v.get("name") and v.get("text") is not None]


def item_at(review: Review, file: str, line: int | None) -> dict | None:
    """The agenda item a pause belongs to: same file, at its breakpoint line (or the next few lines, where the debugger
    resolved it), else inside one of its spans; the exact breakpoint line wins."""
    if line is None or not file:
        return None
    base = os.path.basename(file)
    exact: dict | None = None
    near: dict | None = None
    within: dict | None = None
    for item in review.stops:
        if os.path.basename(str(item.get("file") or "")) != base:
            continue
        at = item.get("line")
        if at is not None and int(at) == line:
            exact = exact or item
        elif at is not None and int(at) <= line <= int(at) + NEAR:
            near = near or item
        elif any(int(lo) <= line <= int(hi) for lo, hi in (item.get("spans") or [])):
            within = within or item
    return exact or near or within


def adhoc_item(review: Review, pause: dict) -> dict:
    """A pause outside every item (an uncaught exception, a breakpoint of the person's own): an item of its own, so it can be explained and referenced."""
    rel = os.path.relpath(pause["file"], review.repo) if pause.get("file") and os.path.isabs(str(pause["file"])) else str(pause.get("file") or "")
    item = {"n": max([int(s.get("n", 0)) for s in review.stops] + [0]) + 1, "kind": "pause", "file": rel, "line": pause.get("line"), "function": pause.get("function") or "",
            "spans": [[pause.get("line"), pause.get("line")]] if pause.get("line") is not None else [], "fact": {"kind": "pause", "name": None, "text": str(pause.get("reason") or "pause"), "a": None, "b": None}, "step_a": None, "step_b": None}
    review.plan.setdefault("stops", []).append(item)
    return item


def save_recording(review: Review, live: LiveRun) -> bool:
    """The debugger's recording so far as ``DIR/head.json`` (a saved run's ``{meta, events}``); False when the session has none."""
    try:
        doc = live.recording()
    except AgentError:
        return False
    if not isinstance(doc, dict) or not isinstance(doc.get("events"), list):
        return False
    meta = dict(doc.get("meta") or {})
    meta.setdefault("file", abs_file(review, str(review.data.get("entry"))))
    meta.setdefault("cwd", review.repo)
    doc["meta"] = meta
    with open(review.path("head.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)
    review.data["head_json_saved"] = now()
    return True


def ensure_head_json(review: Review) -> bool:
    """A head recording on disk: the full review's, or the debug session's recording saved now; False when there is none to save."""
    if os.path.isfile(review.path("head.json")):
        return True
    if review.data.get("mode") != "debug" or not (review.data.get("view") or {}).get("record"):
        return False
    try:
        live = connect(review)
    except AgentError:
        return False
    try:
        return save_recording(review, live)
    finally:
        live.close()


def unreached_items(review: Review) -> list[dict]:
    """The plan's ``unreached`` entries for the items the run never paused at, once it ended."""
    done = {int(x) for x in review.shown} | set(review.skipped_numbers())
    out = []
    for item in review.stops:
        if int(item.get("n", -1)) in done or item.get("kind") != "change":
            continue
        for lo, hi in item.get("spans") or [[item.get("line"), item.get("line")]]:
            if lo is None:
                continue
            out.append({"file": item.get("file"), "span": [int(lo), int(hi)], "lines": list(range(int(lo), int(hi) + 1)), "start": int(lo), "end": int(hi), "text": "changed line%s never paused under %s (item %s)" % ("s" if hi > lo else "", os.path.basename(str(review.data.get("entry"))), item.get("n"))})
    return out


__all__ = ["CONTINUE", "ITEM_KINDS", "NEAR", "abs_file", "adhoc_item", "breakable_line", "breakpoints_for", "connect", "current_pause", "describe", "ensure_head_json", "item_at", "launch_for", "mark_ended", "open_debug", "pause_values", "plan_items", "recorded", "review_descriptor", "run_over", "save_recording", "span_text", "spans_of", "unreached_items"]
