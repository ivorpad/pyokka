"""The actions over a started review: ``stop``, ``ask``, ``try``, ``finding add``, ``state``; ``run``
dispatches every action from a dict of fields (the CLI's names, the MCP tool's arguments) and
``review_dispatch`` is the CLI's entry (``commands.dispatch`` hands ``review`` here: it has no RUN).

A refusal is a ``Refusal``: the header line, ``refused: <why>``, the detail lines, ``next:``. The CLI
prints it on stderr with exit 2, the MCP tool returns the same text as ``isError``.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
from importlib import import_module
from types import SimpleNamespace
from typing import Any

from ...redact import redact
from ..context import _local_values, _step_location
from ..render import _one_line, _stale_lines, render_context
from ..source import AgentError, SavedRun
from .render import edge_line, fact_text, plan_lines, side_text, steps_text, text, try_lines, value_lines, where
from .state import ACTIONS, NO_REVIEW_HEADER, START, SURFACES, WAIT, Refusal, Review, next_id, now, resolve_dir, result

DEFAULT_PORT = 4777
COMMAND_TIMEOUT = 120
TAIL_LINES = 30
TRY_ID = re.compile(r"^t\d+$")
NUMBER = re.compile(r"^[-+]?\d+(?:\.\d+)?$")


# -- dispatch ----------------------------------------------------------------------------------------------------------

def run(fields: dict) -> dict:
    """One review action from its fields; the answer dict, or a ``Refusal``."""
    action = fields.get("action")
    if action not in ACTIONS:
        raise Refusal(NO_REVIEW_HEADER, "unknown review action %r" % action, START, ["actions: " + ", ".join(ACTIONS)])
    if action == "start":
        from .start import start

        try:
            return start(fields)
        except Refusal:
            raise
        except AgentError as exc:
            raise Refusal(NO_REVIEW_HEADER, exc.message, START, [exc.hint] if exc.hint else None) from None
    review = Review.load(resolve_dir(fields.get("dir")))
    try:
        if action == "stop":
            return stop(review, fields)
        if action == "ask":
            return ask(review, fields)
        if action == "try":
            return try_(review, fields)
        if action == "finding":
            from .findings import finding

            return finding(review, fields)
        if action == "close":
            from .agenda import close

            return close(review, fields)
        if action in ("skip", "look", "state"):
            from .agenda import look, skip, state

            return {"skip": skip, "look": look, "state": state}[action](review, fields)
        from .fixes import fix, report

        return fix(review, fields) if action == "fix" else report(review, fields)
    except Refusal:
        raise
    except AgentError as exc:
        raise review.refuse(exc.message, [exc.hint] if exc.hint else None) from None


def review_dispatch(args: Any, out: Any = None, err: Any = None) -> int:
    """``pyokka review ACTION ...``: the answer on stdout, a refusal on stderr with exit 2; ``--json`` the raw shapes."""
    out = out or sys.stdout
    err = err or sys.stderr
    fields = dict(vars(args))
    as_json = bool(fields.pop("json", False))
    try:
        if not fields.get("action"):
            raise Refusal(NO_REVIEW_HEADER, "review needs an action", START, ["actions: " + ", ".join(ACTIONS) + "; `pyokka review ACTION --help` lists its flags"])
        answer = run(fields)
    except Refusal as exc:
        if as_json:
            out.write(json.dumps(exc.to_json(), ensure_ascii=False) + "\n")
        else:
            err.write(redact(exc.text) + "\n")
        out.flush()
        err.flush()
        return 2
    out.write(json.dumps(answer, ensure_ascii=False, indent=1) + "\n" if as_json else redact(text(answer)))
    out.flush()
    return 0


# -- shared pieces -----------------------------------------------------------------------------------------------------

def head_run(review: Review) -> SavedRun:
    return SavedRun(review.path("head.json"))


def assigned_by(run_: SavedRun, step: int) -> list[tuple[str, str]]:
    """What the statement at ``step`` assigned: a change is recorded at the first step that can read it, the
    frame's next statement (``step --over``), which may sit in a later block of the same scope after a call."""
    nxt = run_.trace.step_over(step)
    if nxt is None or int(nxt) <= step or run_.trace.scope_id(int(nxt)) != run_.trace.scope_id(step):
        return []
    return [(str(v.get("context") or "value"), str(v["text"])) for v in _local_values(run_, int(nxt)) if v.get("text") is not None]


def values_at(run_: SavedRun, step: int) -> list[tuple[str, str]]:
    """The latest recorded text of each local of the frame as of the statement at ``step``: everything the
    frame recorded from its first step to this one (its parameters included), then what the statement itself assigned."""
    trace = run_.trace
    scope_id = trace.scope_id(step)
    scope = trace.scope(scope_id) or {}
    latest: dict[str, str] = {}
    for j in range(int(scope.get("first", step)), step + 1):
        if trace.scope_id(j) != scope_id:
            continue
        for v in _local_values(run_, j):
            if v.get("text") is not None:
                latest[str(v.get("context") or "value")] = str(v["text"])
    for name, text_ in assigned_by(run_, step):
        latest[name] = text_
    return list(latest.items())


def _tight(value: Any) -> str:
    return re.sub(r"\s+", "", str(value)).replace("'", "").replace('"', "")


def names_a_value(say: str, values: list[tuple[str, str]], fact: Any, step_b: Any) -> str | None:
    """What the text names: a value's rendered text, the fact's before or after text, or the step number; None when nothing.

    Containment is whitespace-insensitive and quotes are optional. A bare number (``0.0``, ``197``)
    counts only as a whole number, so ``10.0`` does not name ``0``."""
    hay_tight = _tight(say)
    hay = str(say).replace("'", "").replace('"', "")
    candidates = [("%s = %s" % (name, _one_line(t, 60)), t) for name, t in values]
    if isinstance(fact, dict):
        for label, key in (("the fact's before text", "a"), ("the fact's after text", "b")):
            t = side_text(fact.get(key))
            if t:
                candidates.append((label, t))
    elif fact:
        candidates.append(("the fact", str(fact)))
    for label, t in candidates:
        needle = _tight(t)
        if not needle:
            continue
        if NUMBER.match(needle):
            if re.search(r"(?<![\w.])%s(?![\w.])" % re.escape(needle), hay):
                return label
        elif needle in hay_tight:
            return label
    if step_b is not None and re.search(r"(?<![\w.])%d(?![\w.])" % int(step_b), hay):
        return "step %d" % int(step_b)
    return None


def _validated_say(review: Review, f: dict, values: list[tuple[str, str]], fact: Any, step: int, next_command: str) -> str:
    say = str(f.get("say") or "").strip()
    details = ["values here:", *value_lines(values)] if values else ["values here: none recorded at this step"]
    fact_line = fact_text(fact)
    if fact_line:
        details.append("fact: %s" % _one_line(fact_line, 160))
    details.append("or the step number: %d" % step)
    if not say:
        raise review.refuse("--say is empty: say what happens at this stop, naming a value", details, next_command)
    if names_a_value(say, values, fact, step) is None:
        raise review.refuse("--say names none of the stop's values", ["name one of these in the text (quotes optional, whitespace free):", *details], next_command)
    return say


def _port(f: dict) -> int:
    """``--port``, else ``$PYOKKA_PORT``, else 4777; an explicit 0 stays 0 (no page is asked)."""
    try:
        if f.get("port") is not None and str(f.get("port")).strip() != "":
            return int(f["port"])
        return int(os.environ.get("PYOKKA_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def move_view(review: Review, stop_: dict, say: str, f: dict) -> dict:
    """Move the person's view to the stop through ``surfaces`` (A2); never fatal: the stop prints whatever the surface did."""
    surface = str(f.get("surface") or "auto")
    if surface not in SURFACES:
        raise review.refuse("unknown surface %r" % surface, ["one of " + ", ".join(SURFACES)])
    port, session = _port(f), (f.get("session") or None)
    try:
        surfaces = import_module(".surfaces", __package__)
    except ImportError:
        return {"surface": "chat", "moved": False, "note": "no surfaces module in this build; nothing moved"}
    try:
        if surface == "chat":
            return {"surface": "chat", "moved": False, "note": "chat: nothing to move"}
        res = surfaces.move_to(stop_, say, surface, port, session, review.path("head.json"))  # auto and vscode are resolved there
        if not isinstance(res, dict):
            res = {"surface": surface, "moved": bool(res), "note": ""}
        res.setdefault("surface", surface)
        if not res.get("moved") and not res.get("note") and res.get("surface") == "chat":
            res["note"] = "chat: nothing to move"
        return res
    except Exception as exc:  # noqa: BLE001  a bridge that fails must not lose the stop
        return {"surface": surface, "moved": False, "note": "%s: %s" % (type(exc).__name__, exc)}


def unavailable(asked: str, move: dict) -> bool:
    """An asked ``vscode`` or ``page`` with nothing there to move: no session on the entry, no page with one tab on it."""
    if asked == "vscode":
        return move.get("available") is False or move.get("surface") == "chat"
    return asked == "page" and move.get("available") is False


def refuse_unavailable(review: Review, asked: str, move: dict, again: str) -> Refusal:
    """The refusal of a stop or ask whose asked surface has nothing to move: the stop stays unshown and ``next:`` starts the surface."""
    from .view import data_hints

    vs, page = data_hints(review.data)
    why = str(move.get("note") or "nothing answers").split("; ")[0]
    return review.refuse("surface %s is not available, so nothing was shown: %s" % (asked, why),
                         ["the person is not watching this stop; it is still unshown",
                          "to explain it in the conversation instead, pass surface chat (auto takes the first view that answers)"],
                         "%s; then %s" % (vs if asked == "vscode" else page, again))


def data_hints_vs(review: Review) -> str:
    from .view import data_hints

    return data_hints(review.data)[0]


def _fell_to_chat(f: dict, move: dict) -> bool:
    return str(f.get("surface") or "auto") == "auto" and move.get("surface") == "chat" and not move.get("moved")


def _move_line(move: dict) -> str:
    note = str(move.get("note") or "")
    return "view: %s%s%s" % (move.get("surface"), " moved" if move.get("moved") else " (not moved)", (": " + note) if note else "")


def _context_lines(run_: SavedRun, step: int) -> list[str]:
    """The stop as ``pyokka context head.json STEP`` prints it."""
    ctx = run_.context(step=step)
    return [*_stale_lines(ctx, run_), *render_context(ctx, run_, SimpleNamespace(scope=False))]


def run_command(command: str, cwd: str, timeout: int = COMMAND_TIMEOUT) -> tuple[str, int]:
    """A shell command's combined output and exit status; a timeout is reported as its own line."""
    try:
        done = subprocess.run(command, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout, errors="replace")
    except subprocess.TimeoutExpired:
        return "timed out after %d s" % timeout, -1
    return (done.stdout or "") + (done.stderr or ""), done.returncode


def tail(text_: str, lines: int = TAIL_LINES) -> str:
    rows = (text_ or "").rstrip("\n").split("\n")
    return "\n".join(rows[-lines:])


# -- stop and ask ------------------------------------------------------------------------------------------------------

def stop(review: Review, f: dict) -> dict:
    try:
        n = int(f.get("n"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise review.refuse("stop wants N, the stop's number in the plan", plan_lines(review)) from None
    s = review.stop(n)
    if s is None:
        raise review.refuse("stop %d is not in the plan" % n, [*plan_lines(review), "an unplanned line: review ask FILE:LINE --say TEXT"])
    go_on, waiting = bool(f.get("go_on")), review.waiting
    if waiting is not None and not go_on:
        raise review.refuse("the person has not spoken since stop %d; pass --go-on only after they said next, or answer them with ask/try/look" % waiting, next_command="%s; when they say next, review stop %d --say TEXT --go-on" % (WAIT, n))
    run_ = head_run(review)
    step = s.get("step_b")
    if step is None:
        raise review.refuse("stop %d has no head step to show" % n, ["its kind is %s; `review ask FILE:LINE --say TEXT` stops at a line that ran" % s.get("kind")])
    step = run_.check_step(int(step))
    values = _stop_values(run_, s, step)
    nxt = "review stop %d --say TEXT%s" % (n, " --go-on" if waiting is not None else "")
    say = _validated_say(review, f, values, stop_fact(s), step, nxt)
    move = move_view(review, s, say, f)
    asked = str(f.get("surface") or "auto")
    if unavailable(asked, move):
        raise refuse_unavailable(review, asked, move, "%s --surface %s" % (nxt, asked))
    said = review.data.setdefault("said", [])
    for entry in said:
        if isinstance(entry, dict) and entry.get("n") == waiting:
            entry["go_on"] = True  # the person said next after that stop: --go-on is the agent's word for it
    review.mark_shown(n)
    said.append({"n": n, "say": say, "surface": move.get("surface"), "at": now(), "go_on": False})
    review.note("stop", n=n, step=step, say=say)
    review.save()
    remaining = review.remaining()
    then = ("review stop %d --say TEXT --go-on" % remaining[0]) if remaining else review.after_stops()
    if _fell_to_chat(f, move):
        then = "%s; the person saw this stop only in chat, so explain it in your message. To show the next one in VS Code first run %s" % (then, data_hints_vs(review))
    lines = ["stop %d/%d  %s  %s  %s  %s" % (n, len(review.stops), s.get("kind"), where(s), _one_line(fact_text(s.get("fact")), 120), steps_text(s)), *_context_lines(run_, step), "say: %s" % say, _move_line(move)]
    return result(review, lines, "%s; when they say next, %s" % (WAIT, then), stop=s, step=step, say=say, moved=move, values=[{"name": k, "text": v} for k, v in values])


def _stop_values(run_: SavedRun, s: dict, step: int) -> list[tuple[str, str]]:
    """The plan's named values as of step_b (else the recording's), plus what the stop's statement assigned."""
    from .render import stop_values

    latest = dict(stop_values(s, step) or values_at(run_, step))
    latest.update(assigned_by(run_, step))
    return list(latest.items())


def stop_fact(s: dict) -> Any:
    """The stop's fact with its before and after texts: a ``fact`` dict as it is, else the plan's ``fact`` text with the stop's own ``a`` and ``b``."""
    fact = s.get("fact")
    if isinstance(fact, dict):
        return fact
    merged = {"text": fact, "a": s.get("a"), "b": s.get("b")}
    return merged if any(v not in (None, "") for v in merged.values()) else None


def ask(review: Review, f: dict) -> dict:
    spec = str(f.get("line") or "")
    file, _, line_text = spec.rpartition(":")
    if not file or not line_text.isdigit():
        raise review.refuse("ask wants FILE:LINE, got %r" % spec, next_command="review ask FILE:LINE --say TEXT")
    line = int(line_text)
    run_ = head_run(review)
    step, exact = first_step_on(run_, file, line)
    at = _step_location(run_, step)
    s = {"n": None, "kind": "ask", "file": run_.display_path(at["file"]), "line": at["line"], "function": at["function"], "fact": None, "step_a": None, "step_b": step, "values": None, "asked_line": line}
    values = values_at(run_, step)
    say = _validated_say(review, f, values, None, step, "review ask %s --say TEXT" % spec)
    move = move_view(review, s, say, f)
    asked = str(f.get("surface") or "auto")
    if unavailable(asked, move):
        raise refuse_unavailable(review, asked, move, "review ask %s --say TEXT --surface %s" % (spec, asked))
    review.asked.append({"file": s["file"], "line": line, "step": step, "say": say, "surface": move.get("surface"), "at": now()})
    review.note("ask", file=s["file"], line=line, step=step, say=say)
    review.save()
    lines = ["ask  %s  b#%d" % (where(s), step)]
    if not exact:
        lines.append("line %d never ran as a statement of its own; the stop is the statement around it, line %s" % (line, at["line"]))
    lines += [*_context_lines(run_, step), "say: %s" % say, _move_line(move)]
    then = WAIT
    if _fell_to_chat(f, move):
        then = "%s; they saw this only in chat, so answer in your message. To show the next one in VS Code first run %s" % (WAIT, data_hints_vs(review))
    return result(review, lines, then, stop=s, step=step, say=say, moved=move, values=[{"name": k, "text": v} for k, v in values])


def _function_at(source: str, line: int) -> str | None:
    """The innermost function whose body spans ``line``, or None."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return None
    best = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno <= line <= (node.end_lineno or node.lineno):
            if best is None or node.lineno > best.lineno:
                best = node
    return best.name if best else None


def first_step_on(run_: SavedRun, file: str, line: int) -> tuple[int, bool]:
    """``(step, exact)``: the first head step on the line, else the statement that ran around it (a loop header, a
    multi-line call), never a ``def`` or ``class`` whose body holds a line that did not run: that is an ``AgentError``."""
    f = run_.resolve_file(file)
    fid = int(f["fileId"])
    on = run_.trace.steps_on_line(fid, line)
    if on:
        return on[0], True
    step = run_.step_on_line(file, line)  # the statement around it, or the error that lists the lines that ran near it
    loc = run_.trace.location(step)
    src = run_.source_lines(fid)
    header = src[loc[1][0] - 1].strip() if loc and 0 < loc[1][0] <= len(src) else ""
    located = run_.locate(run_.trace.rid(step))
    if re.match(r"(async\s+)?def\b|class\b", header) or (located is not None and int(located.get("localRid", -1)) == 0):
        function = _function_at("\n".join(src), line)
        inside_ = ("inside `def %s`, which never reached that line in this run" % function) if function else "in module code that never ran"
        raise AgentError("no step on %s:%d: the line never ran" % (run_.display_path(str(f["path"])), line), "it is %s; `review try --expr EXPR` can call it" % inside_)
    return step, False


# -- try ---------------------------------------------------------------------------------------------------------------

def _read(review: Review, path: Any, flag: str) -> str:
    p = os.path.abspath(os.path.expanduser(str(path)))
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError as exc:
        raise review.refuse("cannot read %s %s: %s" % (flag, p, exc.strerror or exc), next_command="review try --code FILE") from None


def run_try(code: str, inputs: str | None, mocks: str | None, repo: str, port: int, title: str | None = None) -> dict:
    """``tryrun.run_try`` (A2); a failure of the runner itself is the try's ``error``, so the try is still kept."""
    try:
        runner = import_module(".tryrun", __package__).run_try
    except ImportError:
        raise AgentError("no tryrun module in this build", "the Scratchpad runner is part of review mode; update pyokka") from None
    try:
        out = runner(code, inputs, mocks, repo, port, title=title)  # the title names the experiment on the page
    except AgentError:
        raise
    except Exception as exc:  # noqa: BLE001
        out = {"result": None, "values": [], "output": None, "error": "%s: %s" % (type(exc).__name__, exc), "surface": "headless"}
    if not isinstance(out, dict):
        out = {"result": None if out is None else str(out), "values": [], "output": None, "error": None, "surface": "headless"}
    error = out.get("error")
    if isinstance(error, dict):  # the sandbox's {type, message, stage}
        out["error"] = "%s: %s" % (error.get("type") or "error", error.get("message") or "")
    if out.get("result") is not None and not isinstance(out["result"], str):
        out["result"] = str(out["result"])
    return out


def try_(review: Review, f: dict) -> dict:
    code_given, expr = f.get("code"), f.get("expr")
    if bool(code_given) == bool(expr):
        raise review.refuse("try needs one of --code FILE or --expr EXPR", next_command="review try --expr EXPR")
    if expr:
        code = "result = (%s)\n" % expr
    elif f.get("code_is_text"):  # the MCP tool's `code` carries the Python text itself
        code = str(code_given) if str(code_given).endswith("\n") else str(code_given) + "\n"
    else:
        code = _read(review, code_given, "--code")
    inputs = _read(review, f["inputs"], "--inputs") if f.get("inputs") else None
    mocks = _read(review, f["mocks"], "--mocks") if f.get("mocks") else None
    edge = str(f.get("edge") or "").strip() or None
    edges = [e for e in review.plan.get("edges") or [] if isinstance(e, dict)]
    edge_item = next((e for e in edges if str(e.get("id")) == edge), None) if edge else None
    if edge and edge_item is None:
        raise review.refuse("no edge candidate %s in the plan" % edge, [edge_line(e) for e in edges] or ["the plan has no edge candidates"], "review try --expr EXPR")
    outcome = run_try(code, inputs, mocks, review.repo, _port(f), title=f.get("title") or None)
    tid = next_id(review.tries, "t")
    entry = {"id": tid, "title": f.get("title") or None, "code": code, "inputs": inputs, "mocks": mocks, "edge": edge, "result": outcome.get("result"), "values": outcome.get("values") or [], "output": outcome.get("output"), "error": outcome.get("error"), "surface": outcome.get("surface") or "headless", "at": now()}
    os.makedirs(review.path("tries"), exist_ok=True)
    with open(review.path("tries", tid + ".json"), "w", encoding="utf-8") as fh:
        json.dump(entry, fh, ensure_ascii=False, indent=1)
    review.tries.append(entry)
    if edge_item is not None:
        edge_item["tried"] = tid
    review.note("try", id=tid, title=entry["title"], edge=edge, result=entry["result"], error=entry["error"])
    review.reopen()
    review.save()
    lines = [*try_lines(entry, with_code=True), "a finding built on it: --repro %s" % tid]
    return result(review, lines, WAIT, **{"try": entry})


__all__ = ["run", "review_dispatch", "stop", "ask", "try_", "first_step_on", "values_at", "names_a_value", "move_view", "run_command", "run_try", "tail", "head_run", "stop_fact"]
