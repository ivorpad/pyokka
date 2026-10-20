"""The review's actions when the debugger runs the program: start, stop (record the pause), skip, view.

The agenda comes from the diff and the program runs under the debugger in the person's VS Code, paused
on entry with a breakpoint on each item. The debugger is driven as always, through ``pyokka_debug``
(``continue``, ``step``, ``break``, ``eval``, ``pyokka ... --live``): the review does not wrap it.
``review stop [N] --say TEXT`` reads the pause the session is at, matches it to an item (an uncaught
exception or a breakpoint of the person's own becomes an item of its own), checks the text names a
value of the frame, and records it; then the person has the floor and the next ``stop`` needs
``--go-on``. ``skip`` removes an item's breakpoint, ``view vscode`` starts the program again with the
remaining items' breakpoints, and ``finding add`` (``debugger_findings.py``) takes a recorded pause
near its line as the place. ``ask`` and ``look`` are refused with the debugger's own commands.
"""

from __future__ import annotations

import os
from typing import Any

from ..render import _one_line
from ..source import AgentError
from .actions import names_a_value
from .debugger import CONTINUE, abs_file, adhoc_item, connect, current_pause, item_at, mark_ended, open_debug, pause_values, plan_items, recorded
from .render import fact_text, plan_lines, value_lines, where
from .state import FINDING_ADD, WAIT, Refusal, Review, change_diff, current_note, now, result, tree_hash

STOP_SAY = "review stop --say TEXT"


# -- start ------------------------------------------------------------------------------------------------------------

def _needs_vscode() -> None:
    """The debugger lives in VS Code: a live Pyokka session, or the ``code`` command; else the refusal names ``--full``."""
    from ..live import list_sessions

    if list_sessions():
        return
    try:
        from ..debug_start import code_command

        if code_command():
            return
    except Exception:  # noqa: BLE001  not found, or a debug_start without it
        pass
    from .start import _refuse
    from .view import code_found

    raise _refuse("a review in the debugger needs VS Code: no live Pyokka session answers and the code command was not found (%s)" % code_found(),
                  ["VS Code needs the pyokka.agentAccess setting on and the code command: tell the person, and start again once they have them",
                   "or review a full recording of both trees, in chat or on the page: review start --base REF --full (add --surface page for the page)"],
                  "review start --base REF --full")


def start_in_debugger(f: dict, pre: dict) -> dict:
    """``review start`` with the debugger: the agenda from the diff, the entry under the debugger in VS Code, no run of base.

    ``pre`` is what ``start.start`` resolved before the mode decided the rest: repo, base, base_ref, head, rel, test,
    directory, argv, interp, pr_text, pr_from.
    """
    from .scope import inside_any, narrow, only_paths, untracked_sentence
    from .session import session_lines
    from .uses import attach_uses
    from .start import _check_vscode, _prepare
    from .view import close_previous

    repo, rel, directory = str(pre["repo"]), str(pre["rel"]), str(pre["directory"])
    if str(f.get("surface") or "") == "vscode":
        _check_vscode(repo, rel)
    else:
        _needs_vscode()
    paths = only_paths(f, repo)
    # --only limits the diff read to its files, untracked ones included, and narrows the agenda before the review
    # directory is touched: one that leaves no item is refused with the last review intact
    change = change_diff(repo, pre["base"], (lambda rel: inside_any(rel, paths)) if paths else None)
    plan, only_notes = narrow(plan_items(repo, change.diff), paths, change.files)
    attach_uses(plan["stops"], repo)  # on the numbered agenda, so a callee on it is named by the stop the person sees
    if change.untracked:
        plan["summary"] = {**plan["summary"], "untracked": change.untracked, "text": "%s %s" % (plan["summary"]["text"], untracked_sentence(change.untracked))}
    close_previous(directory)
    _prepare(directory)
    interp = pre.get("interp")
    data: dict[str, Any] = {
        "id": "%s-%s" % (os.path.basename(repo.rstrip(os.sep)) or "repo", str(pre["base"])[:7]),
        "repo": repo, "base": pre["base"], "base_ref": pre["base_ref"], "head": pre["head"], "entry": rel, "test": pre.get("test"),
        "argv": list(pre.get("argv") or []), "python": getattr(interp, "path", None), "dir": directory, "created": now(), "mode": "debugger",
        "phase": "stops" if plan["stops"] else "findings", "tree_hash": tree_hash(repo), "pr": pre.get("pr_from"),
        "plan": {"stops": plan["stops"], "aside": plan.get("aside", []), "unreached": [], "edges": plan["edges"], "anomalies": [],
                 **({"only": plan["only"], "aside_edges": plan["aside_edges"], "outside": plan.get("outside", [])} if plan.get("only") else {})},
        "shown": [], "skipped": [], "ended": None, "waiting": None, "said": [], "asked": [], "conversation": [], "tries": [], "findings": [], "fix": None,
        "summary": plan["summary"],
    }
    review = Review(directory, data)
    review.save()
    pointer_note = current_note(directory)
    view, view_lines = _open(review)
    data["view"] = view
    review.save()
    head = "%s: %s → working tree at %s, entry %s%s, review directory %s" % (os.path.basename(repo), str(pre["base"])[:7], str(pre["head"])[:7], rel, (" (test %s)" % pre["test"]) if pre.get("test") else "", directory)
    python = [interp.line()] if hasattr(interp, "line") else []
    lines = [head, *python, plan["summary"]["text"], *only_notes, *pointer_note, *view_lines, *session_lines(review), *plan_lines(review)]
    if view.get("kind") == "vscode-debug" and not view.get("finished") and plan["stops"]:
        nxt = CONTINUE
    elif plan["stops"] and view.get("kind") != "vscode-debug":
        nxt = "review view vscode"
    else:
        nxt = review.after_stops()
    return result(review, lines, nxt, plan=review.plan, summary=data["summary"], dir=directory, mode="debugger", view=view)


def _open(review: Review) -> tuple[dict, list[str]]:
    try:
        return open_debug(review)
    except (AgentError, OSError) as exc:
        message = getattr(exc, "message", None) or str(exc)
        hint = getattr(exc, "hint", "") or ""
        return {"kind": "none", "why": message}, ["view: none. Could not open the debugger in VS Code: %s%s" % (message, (". " + hint) if hint else ""),
                                                  "Tell the person what the message asks of them; then `review view vscode` starts the entry under the debugger with a breakpoint on each item."]


# -- stop: record the pause -------------------------------------------------------------------------------------------

def _n(f: dict) -> int | None:
    value = f.get("n")
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _values_details(values: list[tuple[str, str]], step: Any) -> list[str]:
    out = ["values in the frame:", *value_lines(values)] if values else ["values in the frame: none"]
    if isinstance(step, int):
        out.append("or the step number: %d" % step)
    return out


def stop_in_debugger(review: Review, f: dict) -> dict:
    from .stop_context import remove_breakpoint, stop_context

    say = str(f.get("say") or "").strip()
    n = _n(f)
    if not say:
        raise review.refuse("stop records the pause the debugger is at: `review stop [N] --say TEXT`, naming a value of the frame", ["to reach the next item, continue in the debugger; the review does not run the program"], CONTINUE)
    if review.waiting is not None and not f.get("go_on"):
        raise review.refuse("the person has not spoken since stop %d; pass --go-on only after they said next, or answer them with the debugger (eval, step) and try" % review.waiting,
                            next_command="%s; when they say next, %s --go-on" % (WAIT, CONTINUE))
    live = connect(review)
    try:
        pause = current_pause(live)
        if pause is None:
            raise review.refuse("the program is running, not paused: nothing to record", ["`pyokka_debug status` with wait_seconds waits for the next pause; `pyokka_debug pause` stops it at its next statement"], CONTINUE)
        if pause.get("finished") is not None:
            mark_ended(review, pause["finished"])
            raise review.refuse("the program ended (exit %s); no pause to record" % (pause["finished"] or {}).get("exitCode"),
                                ["`review view vscode` runs the entry again with a breakpoint on each remaining item", "or go on to the findings: %s" % FINDING_ADD], review.after_stops())
        values = pause_values(live)
    finally:
        live.close()
    item = item_at(review, str(pause.get("file") or ""), pause.get("line"))
    if item is None and pause.get("reason") == "start":
        raise review.refuse("the program is paused on entry (%s:%s), not at an item; nothing to record" % (os.path.basename(str(pause.get("file") or "?")), pause.get("line")), ["continue in the debugger to the first item, then record that pause"], CONTINUE)
    item = item or adhoc_item(review, pause)
    k = int(item["n"])
    step = pause.get("step") if recorded(review) else None
    if n is not None and n != k:
        raise review.refuse("the debugger is paused at item %d (%s:%s), not item %d" % (k, os.path.basename(str(pause.get("file") or "")), pause.get("line"), n), _values_details(values, step), "review stop %d --say TEXT" % k)
    if names_a_value(say, values, None, step) is None:
        raise review.refuse("--say names none of the values in the frame", ["name one of these in the text (quotes optional, whitespace free):", *_values_details(values, step)], "review stop %d --say TEXT" % k)
    said = review.data.setdefault("said", [])
    for entry in said:
        if isinstance(entry, dict) and entry.get("n") == review.waiting:
            entry["go_on"] = True  # the person said next after that stop: --go-on is the agent's word for it
    first = k not in review.shown  # once recorded, a breakpoint on the item's line is the person's own
    review.mark_shown(k)
    said.append({"n": k, "say": say, "surface": "vscode-debug", "at": now(), "go_on": False})
    review.note("stop", n=k, step=step, say=say, file=item.get("file"), line=pause.get("line"), values=[[a, b] for a, b in values])
    review.save()
    removed = first and remove_breakpoint(review, item)
    context, used = stop_context(review, item, pause.get("line"), values)
    lines = ["stop %d/%d  %s  %s  %s%s" % (k, len(review.stops), item.get("kind"), where(item), _one_line(fact_text(item.get("fact")), 120), "; its breakpoint is removed" if removed else ""),
             "paused at %s:%s (%s)%s" % (os.path.basename(str(pause.get("file") or "?")), pause.get("line"), pause.get("reason") or "pause", ("  step #%d" % step) if isinstance(step, int) else ""),
             *context,
             "say: %s" % say,
             "view: VS Code, paused there; the person sees it in the editor"]
    return result(review, lines, "%s; when they say next, %s --go-on" % (WAIT, CONTINUE), stop=item, step=step, say=say, pause=pause, values=[{"name": a, "text": b} for a, b in values], used=used)


# -- skip, view ---------------------------------------------------------------------------------------------------------

def skip_in_debugger(review: Review, f: dict) -> dict:
    """``skip N [N …] --why TEXT``: every number checked before any is marked (``agenda.skip_numbers``), then their
    breakpoints removed in one call while the session answers."""
    from .agenda import skip_numbers
    from .session import session_lines

    numbers, why = skip_numbers(review, f, "item")
    items = [review.stop(n) or {} for n in numbers]
    for n in numbers:
        review.mark_skipped(n, why)
        review.note("skip", n=n, why=why)
    bps = [{"file": abs_file(review, str(s["file"])), "line": int(s["line"])} for s in items if s.get("line") is not None]
    removed = False
    if bps and not review.data.get("ended"):
        try:
            live = connect(review)
            try:
                live.breakpoints(remove=bps)
                removed = True
            finally:
                live.close()
        except AgentError:
            removed = False
    review.save()
    remaining = review.remaining()
    lines = [*("skipped %d. %s  %s  %s%s" % (n, s.get("kind"), where(s), _one_line(fact_text(s.get("fact")), 120), "; its breakpoint is removed" if removed and s.get("line") is not None else "") for n, s in zip(numbers, items)),
             "why: %s" % why, "remaining: %s" % (", ".join(str(x) for x in remaining) or "none; the agenda is done"), *session_lines(review)]
    return result(review, lines, skipped=review.skipped, remaining=remaining)


def view_in_debugger(review: Review, f: dict) -> dict:
    kind = str(f.get("surface") or "auto")
    if kind in ("page", "chat"):
        raise review.refuse("this review runs in the person's VS Code; the page and chat review a full recording of both trees",
                            ["start again with --full and --surface %s" % kind], "review start --base %s --full --surface %s" % (review.data.get("base_ref") or review.data.get("base"), kind))
    try:
        view, lines = open_debug(review)
    except (AgentError, OSError) as exc:
        message = getattr(exc, "message", None) or str(exc)
        hint = getattr(exc, "hint", "") or ""
        raise review.refuse("could not open the debugger in VS Code: %s" % message, [hint] if hint else None, "review view vscode") from None
    review.data["view"] = view
    review.data["ended"] = None
    review.data["waiting"] = None
    review.plan["unreached"] = []
    if review.phase == "findings" and review.remaining():
        review.phase = "stops"
    review.save()
    from .render import only_line
    from .session import session_lines

    only = only_line(review.plan)
    return result(review, [*lines, *session_lines(review), *([only] if only else [])], CONTINUE if not view.get("finished") and review.remaining() else review.after_stops(), view=view)


def not_in_debugger(review: Review, action: str) -> Refusal:
    """``ask`` and ``look`` are the debugger's own commands when it runs the review."""
    if action == "ask":
        return review.refuse("ask is the debugger's job in this review: set a breakpoint and run to it, then record the pause",
                             ["`pyokka break --live FILE:LINE` then `pyokka continue --live` (MCP pyokka_debug {\"action\": \"break\", ...} then continue), then review stop --say TEXT; a line already passed in a recording session: `pyokka step --live --to STEP`"],
                             STOP_SAY)
    return review.refuse("look is the debugger's job in this review: evaluate in the paused frame",
                         ["`pyokka eval --live EXPR` (MCP pyokka_value with live) reads the frame; `pyokka locals --live` lists it"],
                         STOP_SAY)


__all__ = ["not_in_debugger", "skip_in_debugger", "start_in_debugger", "stop_in_debugger", "view_in_debugger"]
