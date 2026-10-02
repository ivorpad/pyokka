"""HTTP record and replay: the plugin behind ``config.http`` (docs/PROTOCOL.md, "HTTP record and replay").

The exchange is captured where it is meaningful, at the client's request/response
boundary rather than at the socket: method, URL, headers, the decoded body and,
for streamed responses, the chunk boundaries an SSE consumer sees. Four client
stacks cover practically everything a scratch file imports, and each has one
method where a request goes out and a response comes back:

* httpx (and ``httpx2``, the same classes under another name), sync and async:
  ``Client._transport_for_url`` / ``AsyncClient._transport_for_url``, so every
  request's transport goes through a tap, custom transports included;
* aiohttp: ``ClientSession._request``, the body read off ``StreamReader.feed_data``
  (a session that an httpx transport drives, as litellm's does, passes through);
* requests: ``HTTPAdapter.send``;
* everything else (``urllib.request``, urllib3, raw ``http.client``) bottoms
  out in ``http.client.HTTPConnection``: ``send`` hands us the request bytes,
  ``getresponse`` the response. A request that a higher hook already owns
  (requests over urllib3 over http.client) passes through untouched.

The patches live in ``_http_clients``, ``_http_aiohttp`` and ``_http_fallback``, the file format in
``_http_store``; this module is the hooks and the per-run session. ``before``
does nothing on purpose: in fork mode it runs in the runner parent, and anything
patched there would be inherited by every run. Everything installed in
``before_each`` is removed in ``after``; the CLI and the tests run several
executions in one process, so install and uninstall must leave no trace.

The plugin loads for every run. Mode ``off`` only *observes*: the same patches,
one ``http.exchange`` row per request, nothing written and nothing read, buffered
or rebuilt on the program's behalf (``config.httpObserve: false`` skips even
that). Recording and replay hand the program the same bytes: bodies are decoded
once (``content-encoding`` undone, the header dropped) before they are stored
*and* before they are handed back in record mode, so a run reads identically
whether the network answered or the file did.

Every row names the user statement that made the request: ``position`` walks the
frames up from the client call to the innermost frame of an instrumented,
non-library file (a worker thread or an instrumented package in between still
resolves to the user's line), so a row is one Time Machine jump away.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

from .. import execute
from ..instrument import SCOPE_NAME
from . import _http_aiohttp as aiohttp_patch
from . import _http_clients as clients
from . import _http_fallback as fallback
from . import _http_store as store
from ._http_clients import WATCHED  # noqa: F401 - the module names the import hook reacts to
from ._http_store import find_recording, load_recording, normalise_body, recording_dir, recording_path, request_key  # noqa: F401 - public helpers

FILE_VERSION = 1

_active: _Session | None = None


# -- hooks -------------------------------------------------------------------------------------

def before(cfg: dict | None = None) -> None:
    """Nothing: in fork mode this runs in the runner parent, whose imports every run inherits."""


def before_each(cfg: dict | None = None) -> None:
    global _active
    if _active is not None:  # a run whose `after` never came; never stack two sessions
        _active.finish()
        _active = None
    mode = _mode(cfg)
    if mode == "off" and not _observe(cfg):
        return  # the clients stay untouched: no rows
    spec = getattr(getattr(execute, "current", None), "spec", None)
    file_path = getattr(spec, "file_path", None)
    if not file_path:
        return
    workspace_root = getattr(spec, "workspace_root", None) or os.path.dirname(os.path.abspath(file_path))
    session = _Session(mode, os.path.abspath(file_path), os.path.abspath(workspace_root))
    session.start()
    _active = session


def after(cfg: dict | None = None) -> dict | None:
    global _active
    session, _active = _active, None
    return session.finish() if session is not None else None


def _mode(cfg: dict | None) -> str:
    value = cfg.get("http") if isinstance(cfg, dict) else None
    return value if value in ("record", "replay") else "off"


def _observe(cfg: dict | None) -> bool:
    return bool(cfg.get("httpObserve", True)) if isinstance(cfg, dict) else True


def _runner_error(message: str) -> None:
    """A ``runner.error`` for the current run; silent when no run is current (plugin code never breaks the program)."""
    try:
        fn = getattr(execute, "runner_error", None)
        if callable(fn):
            fn(message)
            return
        emit = getattr(getattr(execute, "current", None), "emit", None)
        if callable(emit):
            emit({"type": "runner.error", "message": message})
    except Exception:  # noqa: BLE001
        pass


def _emit(event: dict) -> None:
    """An event of the current run; silent when no run is current (plugin code never breaks the program)."""
    try:
        emit = getattr(getattr(execute, "current", None), "emit", None)
        if callable(emit):
            emit(event)
    except Exception:  # noqa: BLE001
        pass


def _elapsed(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def public_url(url: str) -> str:
    """The URL of a row: query values stripped (the names stay), no fragment. The full URL lives only in the recording."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not parts.query and not parts.fragment:
        return url
    names = [p.partition("=")[0] for p in parts.query.split("&") if p]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(names), ""))


# -- the session -----------------------------------------------------------------------------------

class _Session:
    """One run's worth of state: the file, the counters, the replay cursors and every patch to undo."""

    def __init__(self, mode: str, source: str, workspace_root: str) -> None:
        self.mode = mode
        self.source = source
        self.workspace_root = workspace_root
        self.file = ""
        self.lock = threading.RLock()
        self.n = 0
        self.requests = 0
        self.recorded = 0
        self.served = 0
        self.missed: set[str] = set()
        self.replay: dict[str, list[dict]] = {}
        self.cursor: dict[str, int] = {}
        self.pending: list[Any] = []  # recording streams the program has not finished consuming
        self.patches: list[tuple[Any, str, Any, bool]] = []
        self.finder = clients.Finder(self.patch_module)
        self.header_written = False
        self.finished = False
        self._user_files: dict[str, Any] = {}  # co_filename -> the tracer's InstrumentedFile, non-library files only
        self._user_files_n = -1

    # -- lifecycle -------------------------------------------------------------------------
    def start(self) -> None:
        if self.mode == "record":
            self.file = store.recording_path(self.workspace_root, self.source)  # what this run writes
        else:  # replay reads the recording; off only reports it (`finish`)
            found = store.find_recording(self.workspace_root, self.source)
            self.file = found or store.recording_path(self.workspace_root, self.source)
            if found and self.mode == "replay":
                try:
                    for entry in store.load_recording(found):
                        self.replay.setdefault(str(entry["key"]), []).append(entry)
                except OSError as exc:
                    _runner_error("http replay: cannot read %s: %s" % (found, exc))
        sys.meta_path.insert(0, self.finder)
        fallback.patch_http_client(self)
        for name in clients.WATCHED:
            mod = sys.modules.get(name)
            if mod is not None:
                self.patch_module(mod)

    def finish(self) -> dict | None:
        if self.finished:
            return None
        self.finished = True
        for stream in list(self.pending):  # what was captured of responses still open
            try:
                stream.finish()
            except Exception:  # noqa: BLE001
                pass
        self.pending.clear()
        sys.meta_path[:] = [f for f in sys.meta_path if f is not self.finder]
        for obj, attr, original, own in reversed(self.patches):
            try:
                if own:
                    setattr(obj, attr, original)
                else:
                    delattr(obj, attr)
            except Exception:  # noqa: BLE001
                pass
        self.patches.clear()
        http: dict[str, Any] = {"mode": self.mode, "requests": self.requests, "recorded": self.recorded, "served": self.served, "misses": len(self.missed), "file": self.file}
        http.update(store.recording_info(self.file))  # what is on disk after the run: exists, recordedAt, entries
        out: dict[str, Any] = {"http": http}
        if self.mode == "replay":
            out["replayed"] = True
        return out

    def patch(self, obj: Any, attr: str, make: Callable[[Any], Any]) -> None:
        """``obj.attr = make(original)``, remembered for ``finish`` (an inherited attribute is deleted again, not set)."""
        if any(o is obj and a == attr for o, a, _, _ in self.patches):
            return
        own = attr in vars(obj)
        original = vars(obj)[attr] if own else getattr(obj, attr)
        setattr(obj, attr, make(getattr(obj, attr)))
        self.patches.append((obj, attr, original, own))

    def patch_module(self, mod: Any) -> None:
        name = getattr(mod, "__name__", "")
        try:
            if name in ("httpx", "httpx2"):
                clients.patch_httpx(self, mod)
            elif name == "requests.adapters":
                clients.patch_requests(self, mod)
            elif name == "aiohttp":
                aiohttp_patch.patch_aiohttp(self, mod)
        except Exception as exc:  # noqa: BLE001
            _runner_error("http %s: cannot patch %s: %s: %s" % (self.mode, name, type(exc).__name__, exc))

    # -- where the program is -------------------------------------------------------------------
    def position(self) -> tuple[int, int]:
        """``(rid, step)`` of the innermost user statement on this thread's stack; ``(-1, -1)`` before the tracer exists.

        ``rid`` is the statement of the innermost frame that belongs to an instrumented,
        non-library file (a request from a worker thread or from inside an instrumented
        package still names the user's line); ``step`` is that frame's own last step, the
        Time Machine's target. Gathered tasks all suspend on the same line before their
        requests go out, so the step comes from the frame's scope and not from the most
        recent step of that line, which is the last task's. No such frame: ``(-1, the current step)``.
        """
        tracer = getattr(getattr(execute, "current", None), "tracer", None)
        if tracer is None:
            return (-1, -1)
        files = self._files_of(tracer)
        frame: Any = sys._getframe(1)
        while frame is not None:
            info = files.get(frame.f_code.co_filename)
            if info is not None:
                rid = tracer.rid_at(info, frame.f_lineno)
                step = _frame_step(tracer, frame)
                return rid, (step if step is not None else tracer.step_for(rid))
            frame = frame.f_back
        return (-1, tracer.cur_step)

    def _files_of(self, tracer: Any) -> dict[str, Any]:
        """``co_filename -> InstrumentedFile`` of the tracer's non-library files, rebuilt when a file was added."""
        by_id = tracer.files_by_id
        if len(by_id) != self._user_files_n:
            self._user_files = {info.filename: info for info in list(by_id.values()) if not getattr(info, "library", False)}
            self._user_files_n = len(by_id)
        return self._user_files

    # -- rows -------------------------------------------------------------------------------------
    def row(self, *, n: int, client: str, method: str, url: str, status: int | None, reason: str | None, size: int | None, ms: int, source: str, rid: int, step: int, recorded_ms: int | None = None) -> None:
        """One ``http.exchange`` event (the contract's "Rows"), counted in ``requests``."""
        event: dict[str, Any] = {"type": "http.exchange", "n": n, "client": client, "method": method, "url": public_url(url), "status": status, "reason": reason, "bytes": size, "ms": ms}
        if recorded_ms is not None:
            event["recordedMs"] = recorded_ms
        event.update(source=source, rid=rid, step=step)
        with self.lock:
            self.requests += 1
        _emit(event)

    def observe(self, n: int, client: str, method: str, url: str, status: int, reason: str, started: float, *, size: int | None, rid: int, step: int) -> None:
        """The row of an exchange that was only watched (mode ``off``): nothing read, nothing written."""
        self.row(n=n, client=client, method=method, url=url, status=status, reason=reason, size=size, ms=_elapsed(started), source="live", rid=rid, step=step)

    # -- the file -----------------------------------------------------------------------------
    def next_n(self) -> int:
        with self.lock:
            self.n += 1
            return self.n

    def write(self, n: int, key: str, client: str, request: dict, response: dict, started: float, *, size: int | None, rid: int, step: int) -> None:
        """Append the exchange to the recording (the first one replaces the previous file), then emit its row."""
        elapsed = _elapsed(started)
        source = "recorded"
        if self.mode == "off":
            source = "live"
        else:
            entry = {"n": n, "key": key, "client": client, "request": request, "response": response, "elapsedMs": elapsed}
            line = json.dumps(entry, ensure_ascii=False) + "\n"
            with self.lock:
                try:
                    if not self.header_written:  # the first exchange replaces the previous recording
                        os.makedirs(os.path.dirname(self.file), exist_ok=True)
                        header = {"pyokka": "http", "version": FILE_VERSION, "file": self.source, "recorded": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "python": platform.python_version()}
                        with open(self.file, "w", encoding="utf-8") as fh:
                            fh.write(json.dumps(header, ensure_ascii=False) + "\n" + line)
                        self.header_written = True
                    else:
                        with open(self.file, "a", encoding="utf-8") as fh:
                            fh.write(line)
                except OSError as exc:
                    _runner_error("http record: cannot write %s: %s" % (self.file, exc))
                    source = "live"  # the program had the network's answer; the file has nothing of it
                else:
                    self.recorded += 1
        self.row(n=n, client=client, method=str(request.get("method")), url=str(request.get("url") or ""), status=response.get("status"), reason=response.get("reason"), size=size, ms=elapsed, source=source, rid=rid, step=step)

    def lookup(self, key: str, method: str, url: str, *, client: str, rid: int, step: int) -> dict:
        """The next entry of ``key`` (the last one repeats) with its ``replayed`` row.

        A miss is one ``miss`` row per attempt (an SDK's retries show), one ``runner.error``
        per key, and a ``ConnectionError`` in the program.
        """
        started = time.perf_counter()
        n = self.next_n()
        entry: dict | None = None
        first = False
        with self.lock:
            entries = self.replay.get(key)
            if entries:
                i = self.cursor.get(key, 0)
                self.cursor[key] = i + 1
                self.served += 1
                entry = entries[min(i, len(entries) - 1)]
            else:
                first = key not in self.missed
                self.missed.add(key)
        if entry is not None:
            resp = entry.get("response") or {}
            status = int(resp.get("status") or 0)
            size = sum(len(c) for c in store.entry_chunks(resp))
            self.row(n=n, client=client, method=method, url=url, status=status, reason=store.reason_phrase(status, resp.get("reason")), size=size, ms=_elapsed(started), source="replayed", rid=rid, step=step, recorded_ms=entry.get("elapsedMs"))
            return entry
        self.row(n=n, client=client, method=method, url=url, status=None, reason=None, size=None, ms=_elapsed(started), source="miss", rid=rid, step=step)
        if first:
            _runner_error("no recorded response for %s %s; run once in record mode (%s)" % (method, url, self.file))
        raise ConnectionError("pyokka replay: no recorded response for %s %s" % (method, url))


def _frame_step(tracer: Any, frame: Any) -> int | None:
    """The last recorded step of ``frame``'s own scope (its ``_pk_scope_``), ``None`` when unknown.

    A module body keeps its scope in globals (0 for the main file); a function in its fast locals.
    A scope id from before a ``recordFrom`` recording began is mapped through ``tracer.foreign``.
    """
    code = frame.f_code
    if code.co_name == "<module>":
        sid = frame.f_globals.get(SCOPE_NAME, 0)
    elif SCOPE_NAME in code.co_varnames:
        sid = frame.f_locals.get(SCOPE_NAME)
    else:
        return None
    if not isinstance(sid, int) or sid < 0:
        return None
    if sid >= len(tracer.scope_last):
        sid = tracer.foreign.get(sid)
        if sid is None or sid >= len(tracer.scope_last):
            return None
    return tracer.scope_last[sid]
