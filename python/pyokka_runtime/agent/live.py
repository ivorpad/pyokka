"""``--live``: the commands over the bridge of an open VS Code session.

The extension (``src/agent/bridge.ts``, setting ``pyokka.agentAccess``) listens on one Unix
socket per session and describes it in ``$PYOKKA_HOME/sessions/<pid>-<n>.json`` (``~/.pyokka``
when unset) (``socket``,
``token``, ``pid``, ``workspace``, ``file``, ``displayName``, ...). ``PYOKKA_SESSIONS_DIR``
moves that directory (tests). ``LiveRun`` sends the token line, then one request per command
and hands the reply to the same renderer as a saved run: the bridge already answers with the
context-slice shape. What the bridge does not serve (the whole trace: ``story``, ``find``,
``steps --line``) is refused with a hint that names the saved-run command instead.

Debugging (``debug``, ``continue``, ``pause``, ``stop``, ``restart``, ``break``, ``watches``,
``locals``) is live only: the bridge runs the session's file paused at its frontier and answers
every stop with the same slice plus ``paused`` (``stop_reason`` turns it into the text after
``paused at``), or ``finished`` when the program ended (see "Debugging over the bridge" in
``docs/PROTOCOL.md``). ``stop`` answers ``{stopped, runId?, finished?, hint?}`` instead.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Callable

from ..home import pyokka_home
from ..protocol import PROVENANCE_DEPTH
from .context import STORY_LINE_CAP
from .link import LinkClosed, SocketLink
from .sessions import DEBUG_VERBS, EITHER_VERBS, NO_SESSION, NO_SESSION_HINT, RUN_VERBS, descriptor_kind, pick_session, prefer_kind, substitution_note, _file_matches
from .source import AgentError, display_path

SESSIONS_ENV = "PYOKKA_SESSIONS_DIR"
CONNECT_TIMEOUT_S = 5.0
WATCH_VALUES = 6
#: what a debug session answers for the verbs that read a recording (docs/PROTOCOL.md, 4.2)
RECORDING_HINT = 'start the debug session with recording (`pyokka debug FILE --record`, or "Pyokka: Debug Current File (Recording)"), or read a run-all session of the file'


def sessions_dir() -> str:
    return os.environ.get(SESSIONS_ENV) or os.path.join(pyokka_home(), "sessions")


def pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, OverflowError, TypeError, ValueError):
        return False
    return True


def read_descriptor(path: str) -> dict | None:
    """The descriptor at ``path`` when it is readable, complete and its extension host is alive."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or not all(isinstance(doc.get(k), str) and doc.get(k) for k in ("socket", "token", "file")):
        return None
    if not pid_alive(doc.get("pid")):
        return None
    out = dict(doc)
    out["descriptor"] = path
    return out


def list_sessions(directory: str | None = None) -> list[dict]:
    """Live descriptors, newest first; dead pids and unreadable files are skipped."""
    directory = directory or sessions_dir()
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    out = []
    for name in names:
        if name.endswith(".json"):
            d = read_descriptor(os.path.join(directory, name))
            if d is not None:
                out.append(d)
    out.sort(key=lambda d: str(d.get("started") or ""), reverse=True)
    return out


#: the host's answer to a request type it does not know: `unknown request "recording"`
OLD_EXTENSION = re.compile(r"""^unknown request ["']([^"']*)["']$""")


class LiveRun:
    """One bridge connection; every method is one request (``steps`` is one per step)."""

    def __init__(self, descriptor: dict) -> None:
        self.descriptor = descriptor
        self.file = str(descriptor.get("file") or "")
        self.workspace_root = str(descriptor.get("workspace") or os.path.dirname(self.file))
        self.display_name = str(descriptor.get("displayName") or os.path.basename(self.file))
        self.kind = descriptor_kind(descriptor)
        self._stale = False
        try:
            self.link = SocketLink(str(descriptor["socket"]), timeout=CONNECT_TIMEOUT_S)
        except LinkClosed as exc:
            raise AgentError("cannot connect to the live session %s: %s" % (self.display_name, exc), "the VS Code window may be gone; " + NO_SESSION_HINT) from None
        self.link.send_raw({"token": descriptor.get("token")})

    # -- wire -----------------------------------------------------------------------------------------------
    def request(self, msg: dict) -> dict:
        try:
            reply = self.link.call(dict(msg))
        except LinkClosed as exc:
            raise AgentError("the live session %s stopped answering: %s" % (self.display_name, exc), "a closed connection right away means a stale descriptor (bad token); " + NO_SESSION_HINT) from None
        if not reply.get("ok"):
            unknown = OLD_EXTENSION.match(str(reply.get("error") or ""))
            if unknown:
                # the window runs an extension older than this CLI: say so, not the host's list of types
                raise AgentError(
                    "the VS Code extension is older than this CLI (no %s request): install the vsix built from this checkout and run Developer: Reload Window" % unknown.group(1),
                    "the CLI sent %r, which the installed extension does not serve" % msg.get("type"),
                )
            hint = str(reply["hint"]) if reply.get("hint") else None
            note = substitution_note(self.descriptor)
            if note:
                hint = note if not hint else "%s %s" % (hint, note)
            raise AgentError(str(reply.get("error") or "%s failed" % msg.get("type")), hint)
        out = {k: v for k, v in reply.items() if k not in ("id", "ok")}
        if "stale" in out:
            self._stale = bool(out["stale"])
        return out

    def _slice(self, reply: dict) -> dict:
        """Fill what the renderer reads and a saved run has: the block's first step, the values' file.

        A debug stop without a recording has no step numbers on its lines, so it gets no
        ``firstStep``: ``render_debug`` prints the block without a step range.
        """
        block = reply.get("block")
        if isinstance(block, dict):
            steps = [l["step"] for l in block.get("lines") or [] if isinstance(l, dict) and l.get("step") is not None]
            if steps:
                block.setdefault("firstStep", min(steps))
            elif "count" in reply:
                block.setdefault("firstStep", reply.get("step"))
            for v in reply.get("values") or []:
                if isinstance(v, dict):
                    v.setdefault("file", block.get("file"))
        return reply

    def _file_of(self, name: str | None) -> str | None:
        if not name or _file_matches(self.descriptor, name):
            return self.file
        return name

    # -- RunSource ----------------------------------------------------------------------------------------
    def state(self) -> dict:
        out = self.request({"type": "state"})
        out["live"] = {"pid": self.descriptor.get("pid"), "descriptor": self.descriptor.get("descriptor"), "workspace": self.workspace_root}
        return out

    def context(self, *, step: int | None = None, file: str | None = None, line: int | None = None, scope: bool = False) -> dict:
        req: dict[str, Any] = {"type": "context"}
        if step is not None:
            req["step"] = step
        elif line is not None:
            if file:
                req["file"] = file
            req["line"] = line
        if scope:
            req["scope"] = True
        return self._slice(self.request(req))

    def step(self, step: int | None = None, *, kind: str | None = None, to: int | None = None, scope: bool = False, count: int | None = None) -> dict:
        extra: dict[str, Any] = {"scope": True} if scope else {}
        if count is not None and count > 1:
            extra["count"] = count  # N stops in a row; the reply is the last one
        if to is not None:
            reply = self.request({"type": "step", "to": to, **extra})
        else:
            if step is not None:
                self.request({"type": "step", "to": step})
            reply = self.request({"type": "step", "kind": kind, **extra})
        out = self._slice(reply)
        if step is not None:
            out["from"] = step
        return out

    def values(self, file: str, line: int) -> dict:
        reply = self.request({"type": "values", "file": file, "line": line})
        values = [v for v in reply.get("values") or [] if isinstance(v, dict)]
        for v in values:
            v.setdefault("file", self._file_of(file))
        return {"file": self._file_of(file), "line": line, "values": values}

    def eval(self, expression: str, *, frame: int | None = None) -> dict:
        req: dict[str, Any] = {"type": "eval", "expression": expression}
        if frame:
            req["frameId"] = frame
        reply = self.request(req)
        return {"expression": expression, "text": reply.get("text"), "valueBag": reply.get("valueBag"), "logId": reply.get("logId")}

    def expand(self, value_id: str, query_path: list[str]) -> dict:
        reply = self.request({"type": "expand", "valueId": value_id, "queryPath": list(query_path)})
        return {"node": reply.get("node")}

    def story(self, *, file: str | None = None, scope: str | None = None, line: tuple[str, int] | None = None, limit: int = STORY_LINE_CAP) -> dict:
        self._needs_recording("story")
        raise AgentError("story needs the whole trace, which the bridge does not serve", self._saved_hint("story run.json --file %s" % self.display_name))

    def find(self, text: str, limit: int = 50) -> dict:
        self._needs_recording("find")
        raise AgentError("find needs the whole trace and every value, which the bridge does not serve", self._saved_hint("find run.json %r" % text))

    def steps(self, *, start: int = 0, count: int = 40, line: tuple[str, int] | None = None) -> dict:
        self._needs_recording("steps")
        if line is not None:
            raise AgentError("steps --line needs the trace; the bridge serves one step per request", "`context --live --line %s:%d` gives the first step on the line; a saved run lists them all" % line)
        total = int((self.request({"type": "state"}).get("nav") or {}).get("count") or 0)
        start = max(0, start)
        end = min(total, start + max(1, count))
        rows = []
        for i in range(start, end):
            c = self.request({"type": "context", "step": i})
            loc = c.get("location") or {}
            rows.append({"step": i, "file": loc.get("file"), "line": loc.get("line"), "function": loc.get("function"), "depth": max(0, len(c.get("stack") or []) - 1), "scopeId": (c.get("block") or {}).get("scopeId"), "flags": []})
        return {"steps": rows, "count": total, "from": start, "next": end if end < total else None}

    def walkthrough(self, *, file: str | None = None, scope: str | None = None, start: int | None = None, end: int | None = None, all_scopes: bool = False) -> dict:
        req: dict[str, Any] = {"type": "walkthrough"}
        if file is not None:
            req["file"] = file
        if scope is not None:
            req["scope"] = scope
        if start is not None:
            req["from"] = start
        if end is not None:
            req["to"] = end
        if all_scopes:
            req["all"] = True
        return self.request(req)
    def var(self, name: str, *, file: str | None = None, scope: str | None = None, limit: int = 200) -> dict:
        req: dict[str, Any] = {"type": "var", "name": name, "limit": limit}
        if file:
            req["file"] = file
        if scope:
            req["scope"] = scope
        out = self.request(req)
        for row in out.get("changes") or []:
            if isinstance(row, dict) and row.get("file") is None:
                row["file"] = self.file
        return out

    def why(self, step: int | None, name: str = "", *, depth: int = PROVENANCE_DEPTH) -> dict:
        if step is None:
            nav = self.request({"type": "state"}).get("nav") or {}
            if not nav.get("active") or nav.get("step") is None:
                raise AgentError("the Time Machine is not active, so there is no current step", "give one: `why --live 21 total`; `step --live --to N` starts the Time Machine there")
            step = int(nav["step"])
        out = self.request({"type": "why", "step": step, "name": name, "depth": depth})

        def fill(node: Any) -> None:
            """The session's file where the bridge sent none, on every node with a step and every call."""
            if not isinstance(node, dict):
                return
            if node.get("step") is not None and node.get("file") is None:
                node["file"] = self.file
            for read in node.get("reads") or []:
                fill(read)
            for call in node.get("calls") or []:
                if isinstance(call, dict) and call.get("file") is None:
                    call["file"] = self.file

        fill(out.get("root"))
        return out

    def origin(self, step: int | None, expr: str = "", *, depth: int = 20) -> dict:
        """Built here over the session's recording (bridge ``recording``), the same builder as a saved run's."""
        from .origin import origin
        from .source import SavedRun

        if step is None:
            nav = self.request({"type": "state"}).get("nav") or {}
            if not nav.get("active") or nav.get("step") is None:
                raise AgentError("the Time Machine is not active, so there is no current step", "give one: `origin --live 64`; `exceptions --live` lists the steps where exceptions were raised")
            step = int(nav["step"])
        doc = self.request({"type": "recording"})
        run = SavedRun(str(doc.get("meta", {}).get("file") or self.file or "live-session.json"), doc=doc)
        out = origin(run, run.check_step(step), expr, depth=depth)
        out["stale"] = bool(self._stale)
        out["staleFiles"] = self.stale_files()
        return out

    def graph(self, *, all_scopes: bool = False, scope: str | None = None, expand: list[str] | None = None, statements: bool = True) -> dict:
        req: dict[str, Any] = {"type": "graph"}
        if all_scopes:
            req["all"] = True
        if scope is not None:
            req["scope"] = scope
        if expand:
            req["expand"] = list(expand)
        if not statements:
            req["statements"] = False
        return self.request(req)

    def http(self) -> dict:
        return self.request({"type": "http"})  # the table as the bridge builds it, rows so far while a run is in flight
    def exceptions(self) -> dict:
        return self.request({"type": "exceptions"})

    def recording(self) -> dict:
        """The session's run as a saved run's ``{meta, events}`` (bridge ``recording``), for verbs that read the whole trace."""
        self._needs_recording("tour")
        return self.request({"type": "recording"})

    def release(self) -> dict:
        raise AgentError("release is for the kept runner of a saved run", "a live session belongs to VS Code; stop it there")

    # -- debugging: the pause -------------------------------------------------------------------------------
    def debug(self, *, stop_on_entry: bool = False, launch: dict | None = None) -> dict:
        """Start (or read) a debug session of this file; the reply is the first stop.

        On a ``kind: "debug"`` socket a paused session answers its current pause and a running one
        is refused, so "start the debugger" twice never loses the pause an agent is reading. On a
        run socket the host starts the session and the reply is its first stop (route (b) of 3.10).
        Without ``stop_on_entry`` the run goes to the first breakpoint and pauses before the first
        statement only when none is set.
        """
        req = self._debug_request("debug", stop_on_entry)
        if launch is not None:
            req["launch"] = launch
        return self._stop(self.request(req))

    def restart(self, *, stop_on_entry: bool = False) -> dict:
        """Stop the program and start it again; the reply is the first stop of the new run."""
        return self._stop(self.request(self._debug_request("restart", stop_on_entry)))

    def stop(self) -> dict:
        """End the debug run. A run-all session and its recording stay; a debug session is gone."""
        return self.request({"type": "stop"})

    @staticmethod
    def _debug_request(type_: str, stop_on_entry: bool) -> dict:
        req: dict[str, Any] = {"type": type_}
        if stop_on_entry:
            req["stopOnEntry"] = True
        return req

    def continue_(self, *, no_wait: bool = False, until: str | None = None, to: tuple[str, int] | None = None) -> dict:
        """Resume; the reply is the next stop.

        ``no_wait`` answers ``{resumed: true}`` at once instead of waiting for it. ``until`` runs to
        the first moment an expression is true (a one-shot break-when watch the host removes after
        the stop), ``to`` runs to a line through the run-to-line breakpoint.
        """
        req: dict[str, Any] = {"type": "continue"}
        if no_wait:
            req["noWait"] = True
        if until:
            req["until"] = until
        if to is not None:
            req["to"] = {"file": to[0], "line": to[1]}
        return self._stop(self.request(req))

    def exec(self, source: str, *, frame: int | None = None) -> dict:
        """Run a statement in the paused frame: an assignment, a call, an import, a block.

        The reply carries the last expression statement's value (``text``), ``modified``, and the
        exception when the statement raised: the session stays paused either way.
        """
        req: dict[str, Any] = {"type": "exec", "source": source}
        if frame:
            req["frameId"] = frame
        reply = self.request(req)
        out: dict[str, Any] = {"source": source, "text": reply.get("text"), "modified": bool(reply.get("modified")), "valueBag": reply.get("valueBag"), "exception": reply.get("exception")}
        if isinstance(out["exception"], dict):
            out["location"] = self._paused_location()  # the text form says where the program still is
        return out

    def record(self) -> dict:
        """Record from the current pause on; the reply is the same pause as step 0, or ``already`` with the pause."""
        return self._stop(self.request({"type": "record"}))

    def _paused_location(self) -> dict | None:
        """``{file, line}`` of the current pause, from ``state``; None when nothing is paused."""
        try:
            dbg = self.request({"type": "state"}).get("debug")
        except AgentError:
            return None
        paused = dbg.get("paused") if isinstance(dbg, dict) else None
        if not isinstance(paused, dict):
            return None
        return {"file": paused.get("file"), "line": paused.get("line")}

    def pause(self, *, no_wait: bool = False) -> dict:
        """Pause at the next statement; ``no_wait`` answers ``{requested: true}`` without waiting.

        A server can sit in ``accept()`` for minutes, so a ten-minute wait is worse than a second call.
        """
        req: dict[str, Any] = {"type": "pause"}
        if no_wait:
            req["noWait"] = True
        return self._stop(self.request(req))

    def _stop(self, reply: dict) -> dict:
        """A stop reply: the slice of the frontier step plus ``paused``, or ``finished`` when the run ended."""
        return reply if isinstance(reply.get("finished"), dict) else self._slice(reply)

    def breakpoints(self, *, add: list[dict] | None = None, remove: list[dict] | None = None, exceptions: str | None = None, at: str | None = None) -> dict:
        """``at`` is a function name whose entry pauses; the runtime resolves it, not the host."""
        req: dict[str, Any] = {"type": "break"}
        if add:
            req["add"] = list(add)
        if remove:
            req["remove"] = list(remove)
        if exceptions:
            req["exceptions"] = exceptions
        if at:
            req["at"] = at
        if not add and not remove and not exceptions and not at:
            req["list"] = True
        return self.request(req)

    def watches(self, *, add: list[dict] | None = None, remove: list[str] | None = None) -> dict:
        req: dict[str, Any] = {"type": "watches"}
        if add:
            req["add"] = list(add)
        if remove:
            req["remove"] = list(remove)
        if not add and not remove:
            req["list"] = True
        return self.request(req)

    def locals(self, *, value_bag: bool = False, frame: int | None = None) -> dict:
        req: dict[str, Any] = {"type": "locals"}
        if value_bag:
            req["valueBag"] = True
        if frame:
            req["frameId"] = frame
        return self.request(req)

    def watch(self, on_event: Callable[[dict], None]) -> None:
        """``watch`` once, then hand every streamed event over until the bridge closes or Ctrl-C."""
        self.request({"type": "watch"})
        try:
            while True:
                try:
                    msg = self.link.recv()
                except LinkClosed:
                    return
                if isinstance(msg, dict) and msg.get("event"):
                    on_event(msg)
        finally:
            try:
                self.link.send({"type": "unwatch"})
            except LinkClosed:
                pass

    def _needs_recording(self, verb: str) -> None:
        """A debug session records nothing, so the verbs that read a trace are refused (4.2)."""
        if self.kind == "debug":
            raise AgentError("%s needs a recording" % verb, RECORDING_HINT)

    def _saved_hint(self, command: str) -> str:
        return "save a run (`pyokka run %s --save run.json`) and use `pyokka %s`; live, `context --live --line F:L` and `step --live` navigate without it" % (self.display_path(self.file), command)

    # -- what the renderer asks a source ---------------------------------------------------------------------
    def stale_files(self) -> list[str]:
        return [self.display_path(self.file)] if self._stale else []

    def display_path(self, path: str | None) -> str:
        return display_path(path, self.workspace_root)

    def close(self) -> None:
        self.link.close()


def stop_reason(paused: dict) -> str:
    """The text after ``paused at file:line``: ``breakpoint if x > 1``, ``step over``, ``watch total: 3``, ``uncaught ValueError: too big: 3``, ``start``, ``pause``."""
    reason = str(paused.get("reason") or "pause")
    if reason == "breakpoint":
        bp = paused.get("breakpoint") if isinstance(paused.get("breakpoint"), dict) else {}
        text = "breakpoint" + (" if %s" % bp["condition"] if bp.get("condition") else "")
        if paused.get("conditionError"):
            text += ", condition failed: %s" % paused["conditionError"]
        return text
    if reason == "step":
        return "step %s" % (paused.get("kind") or "into")
    if reason == "watch":
        w = paused.get("watch") if isinstance(paused.get("watch"), dict) else {}
        return "watch %s: %s" % (w.get("exp"), w.get("text")) if w else "watch"
    if reason == "exception":
        e = paused.get("exception") if isinstance(paused.get("exception"), dict) else {}
        return "%s %s: %s" % ("uncaught" if e.get("uncaught") else "raised", e.get("type"), e.get("message")) if e else "exception"
    return reason


def _values_part(event: dict, one_line: Callable[..., str]) -> str:
    parts = []
    values = [v for v in event.get("values") or [] if isinstance(v, dict)]
    for v in values[:WATCH_VALUES]:
        text = one_line(v.get("text"), 60)
        parts.append("%s = %s" % (v["context"], text) if v.get("context") else text)
    if len(values) > WATCH_VALUES:
        parts.append("… %d more" % (len(values) - WATCH_VALUES))
    return ("   values: " + ", ".join(parts)) if parts else ""


def _one_line_text(text: Any) -> str:
    return " ".join(str(text or "").split("\n")).strip()


def watch_line(event: dict, source: Any, one_line: Callable[..., str]) -> str:
    """One bounded line per streamed event: ``step N  file:line  function   values: a = 1``, ``paused at file:line (reason)``."""
    kind = event.get("event")
    loc = event.get("location") or {}
    if kind == "step":
        where = "%s:%s" % (source.display_path(loc.get("file")), loc.get("line"))
        return "step %s  %s  %s" % (event.get("step"), where, loc.get("function") or "") + _values_part(event, one_line)
    if kind == "paused":
        where = "%s:%s" % (source.display_path(loc.get("file") or event.get("file")), loc.get("line") or event.get("line"))
        return "paused at %s (%s)" % (where, stop_reason(event)) + _values_part(event, one_line)
    if kind == "resumed":
        return "resumed"
    if kind == "output":
        return "output: %s" % _one_line_text(event.get("text"))
    if kind == "finished":
        return "finished: exit %s" % event.get("exitCode")
    if kind == "rerun":
        return "rerun"
    if kind == "stopped":
        return "stopped"
    return str(kind)


__all__ = ["LiveRun", "SESSIONS_ENV", "sessions_dir", "list_sessions", "pick_session", "prefer_kind", "descriptor_kind", "read_descriptor", "watch_line", "stop_reason", "NO_SESSION", "NO_SESSION_HINT", "DEBUG_VERBS", "RUN_VERBS", "EITHER_VERBS", "substitution_note"]
