"""Wire-level constants and message constructors.

Source of truth for the shapes is ``docs/PROTOCOL.md`` (mirrored by
``src/shared/protocol.ts``). Everything here is plain dicts so it can be
``json.dumps``-ed with ``ensure_ascii=False``.
"""

from __future__ import annotations

import base64
import json
from array import array
from dataclasses import dataclass, field
from typing import Any

PROTOCOL_VERSION = "1"

# Coverage states (index = local range id).
COV_NOT_RUN = 0
COV_COVERED = 1
COV_PARTIAL = 2
COV_ERROR_SOURCE = 3
COV_ERROR_PATH = 4
COV_IGNORED = 5  # Pyokka addition: range excluded by an ignore hint

# Trace step flags.
FLAG_LOG = 1
FLAG_ERROR = 2
FLAG_SCOPE_ENTRY = 4
FLAG_NO_CODE_MAPPING = 8
FLAG_UNWINDING = 16

# Log kinds.
LOG_KINDS = ("log", "value", "autoLog", "autoExpand", "time", "logpoint", "system", "error")

# `locals` entries recorded per run at most (`recordLocals`); past the cap nothing is observed,
# so "no change recorded" stops meaning "unchanged".
MAX_LOCALS_ENTRIES = 100_000

# Provenance (`pyokka why`): levels below the root expanded by default, the most a query may ask
# for, and the nodes one tree holds at most (`truncated` says when the budget cut).
PROVENANCE_DEPTH = 5
PROVENANCE_MAX_DEPTH = 8
PROVENANCE_NODES = 60

# Magic-comment / marker kinds.
KIND_VALUE = "value"
KIND_TIME = "time"
KIND_AUTO_EXPAND = "autoExpand"
KIND_TIME_AUTO_EXPAND = "timeAutoExpand"

# `config.http` modes other than "off", and the runtime plugin they load; with `httpObserve` (the default)
# it loads for "off" too and only observes (see "HTTP record and replay").
HTTP_MODES = ("record", "replay")
HTTP_PLUGIN = "pyokka_runtime.plugins.http_record"

# `config.breakOnException` and the `debug` action `exceptions`: where a debug run pauses on an
# exception. "off" never, "uncaught" the one that ends the run, "raised" every first sighting too.
EXCEPTION_MODES = ("off", "uncaught", "raised")
EXCEPTION_MODE_DEFAULT = "uncaught"

Range4 = list[int]


def dumps(message: dict[str, Any]) -> str:
    """One NDJSON line (no trailing newline)."""
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=_json_default)


def _json_default(obj: Any) -> Any:
    if isinstance(obj, (set, frozenset, tuple)):
        return list(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8", "replace")
    return repr(obj)


def encode_steps(steps: array) -> str:
    """base64 of the little-endian Int32 quads the host decodes with ``decodeSteps``."""
    if steps.typecode != "i":
        raise TypeError("steps must be array('i')")
    buf = steps.tobytes()
    if array("i", [1]).tobytes()[0] != 1:  # big-endian host: byteswap a copy
        copy = array("i", steps)
        copy.byteswap()
        buf = copy.tobytes()
    return base64.b64encode(buf).decode("ascii")


def decode_steps(b64: str) -> array:
    out = array("i")
    out.frombytes(base64.b64decode(b64))
    if array("i", [1]).tobytes()[0] != 1:
        out.byteswap()
    return out


@dataclass
class LogLimitSet:
    depth: int
    elements: int
    string_length: int
    props: int = 0

    def __post_init__(self) -> None:
        if not self.props:
            self.props = self.elements


def _record_from(value: Any) -> str | dict[str, Any] | None:
    """``config.recordFrom``: ``"pause"``, ``{"function": NAME}`` or ``{"path": P, "line": L}``; anything else is None."""
    if value == "pause":
        return "pause"
    if isinstance(value, dict):
        function = str(value.get("function") or "").strip()
        if function:
            return {"function": function}
        try:
            line = int(value.get("line") or 0)
        except (TypeError, ValueError):
            return None
        if value.get("path") and line >= 1:
            return {"path": str(value["path"]), "line": line}
    return None


def _int_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass
class RunConfig:
    """Normalised ``run.config`` with Quokka's defaults filled in."""

    log_limit: int = 100
    max_console_messages: int = 1000
    inline: LogLimitSet = field(default_factory=lambda: LogLimitSet(5, 5000, 8192))
    auto_expand: LogLimitSet = field(default_factory=lambda: LogLimitSet(10, 5000, 8192))
    max_log_entry_size: int = 16384
    resolve_getters: bool = False
    auto_log: bool = False
    max_trace_steps: int = 999_999
    timeout_ms: int = 30_000
    record_locals: bool = False
    library_code: bool = False
    library_packages: list[str] = field(default_factory=list)
    # `exclude` / `only` (path globs or dotted module names, `execute.py`): code left out runs at full speed and records nothing
    exclude: list[str] = field(default_factory=list)
    only: list[str] = field(default_factory=list)
    # characters one recorded value keeps (`values.value_chars`): None is 120 for a local and 200 for a logged value, 0 the ceiling
    max_value_chars: int | None = None
    ignore_coverage: str = "ignore coverage|pragma: no cover"
    ignore_coverage_for_file: str = "ignore file coverage"
    plugins: list[str] = field(default_factory=list)
    mask_secrets: bool = True
    secret_names: list[str] = field(default_factory=list)
    http: str = "off"
    http_observe: bool = True
    debug: bool = False  # the run can pause, step and break (debugger.py); paused at its first statement unless stop_on_entry is off
    record: bool = True  # read only with debug: False is a debugger with no recording (no trace, coverage, logs, locals, times, watches)
    stop_on_entry: bool = True  # with debug: False runs to the first breakpoint (or the end) instead of pausing at the first statement
    break_on_exception: str = EXCEPTION_MODE_DEFAULT  # only a run with a debugger reads it; the `exceptions` action changes it in flight
    # read only with debug and record: the run starts with the debugger's hooks and records from a pause on
    # (`Tracer.start_recording`): "pause" is the first pause, {"function"} / {"path", "line"} the first pause there
    record_from: str | dict[str, Any] | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def records(self) -> bool:
        """Whether this run records. ``record`` is only read with ``debug``, so a run-all run always records."""
        return bool(self.record) or not self.debug

    @property
    def records_later(self) -> bool:
        """A debug run that records, but only from a pause on (``recordFrom``)."""
        return self.debug and bool(self.record) and self.record_from is not None

    @classmethod
    def from_dict(cls, cfg: dict[str, Any] | None) -> "RunConfig":
        cfg = dict(cfg or {})
        limits = cfg.get("logLimits") or {}
        inline = limits.get("inline") or {}
        values = limits.get("values") or {}
        default = values.get("default") or {}
        auto = values.get("autoExpand") or {}
        string_length = int(default.get("stringLength", 8192))
        max_value_chars = _int_or_none(cfg.get("maxValueChars"))
        entry_size = int(cfg.get("maxLogEntrySize", 16384))
        if max_value_chars is not None:
            from .values import value_chars

            # the expandable value carries a string as long as its inline text does
            wanted = value_chars(max_value_chars, 0)
            string_length = max(string_length, wanted)
            entry_size = max(entry_size, 2 * wanted + 4096) if entry_size else entry_size
        hints = cfg.get("hints") or {}
        secrets = cfg.get("secrets") or {}
        http = cfg.get("http")
        http = http if http in HTTP_MODES else "off"
        break_on_exception = cfg.get("breakOnException")
        break_on_exception = break_on_exception if break_on_exception in EXCEPTION_MODES else EXCEPTION_MODE_DEFAULT
        http_observe = bool(cfg.get("httpObserve", True))
        debug = bool(cfg.get("debug", False))
        record = bool(cfg.get("record", True))
        if debug and not record:
            # A debugger with no recording has no HTTP view to fill, and the plugin keeps a row per
            # request in memory, which grows without bound in a server.
            http, http_observe = "off", False
        plugins = [str(p) for p in (cfg.get("plugins") or [])]
        if (http != "off" or http_observe) and HTTP_PLUGIN not in plugins:
            plugins.append(HTTP_PLUGIN)  # the runtime's own plugin (it observes in "off"); `raw` keeps the list as the host sent it
        return cls(
            log_limit=int(cfg.get("logLimit", 100)),
            max_console_messages=int(cfg.get("maxConsoleMessages", 1000)),
            inline=LogLimitSet(int(inline.get("depth", 5)), int(inline.get("elements", 5000)), string_length),
            auto_expand=LogLimitSet(
                int(auto.get("depth", 10)),
                int(auto.get("elements", 5000)),
                int(auto.get("stringLength", string_length)),
            ),
            max_log_entry_size=entry_size,
            resolve_getters=bool(cfg.get("resolveGetters", False)),
            auto_log=bool(cfg.get("autoLog", False)),
            max_trace_steps=int(cfg.get("maxTraceSteps", 999_999)),
            timeout_ms=int(cfg.get("timeoutMs", 30_000)),
            record_locals=bool(cfg.get("recordLocals", False)),
            library_code=bool(cfg.get("libraryCode", False)),
            library_packages=[str(p) for p in (cfg.get("libraryPackages") or [])],
            exclude=[str(p) for p in (cfg.get("exclude") or []) if str(p).strip()],
            only=[str(p) for p in (cfg.get("only") or []) if str(p).strip()],
            max_value_chars=max_value_chars,
            ignore_coverage=str(hints.get("ignoreCoverage", "ignore coverage|pragma: no cover")),
            ignore_coverage_for_file=str(hints.get("ignoreCoverageForFile", "ignore file coverage")),
            plugins=plugins,
            mask_secrets=bool(secrets.get("mask", True)),
            secret_names=[str(n) for n in (secrets.get("names") or [])],
            http=http,
            http_observe=http_observe,
            debug=debug,
            record=record,
            stop_on_entry=bool(cfg.get("stopOnEntry", True)),
            break_on_exception=break_on_exception,
            record_from=_record_from(cfg.get("recordFrom")),
            raw=cfg,
        )


# ---- message constructors (runner -> host) -------------------------------

def msg_ready(request_id: Any, *, python_version: str, executable: str, platform: str, capabilities: list[str]) -> dict:
    return {
        "type": "ready",
        "id": request_id,
        "pythonVersion": python_version,
        "executable": executable,
        "platform": platform,
        "capabilities": capabilities,
        "protocolVersion": PROTOCOL_VERSION,
    }


def msg_ok(request_id: Any) -> dict:
    return {"type": "ok", "id": request_id}


def msg_error(request_id: Any, message: str, detail: str | None = None) -> dict:
    out: dict[str, Any] = {"type": "error", "id": request_id, "message": message}
    if detail:
        out["detail"] = detail
    return out


def msg_runner_error(message: str, detail: str | None = None) -> dict:
    out: dict[str, Any] = {"type": "runner.error", "message": message}
    if detail:
        out["detail"] = detail
    return out


def ev_file_instrumented(
    *,
    file_id: int,
    path: str,
    range_base: int,
    ranges: list[Range4],
    statements: list[int],
    functions: list[dict],
    magic: list[dict],
    instrumented_source: str | None,
    instrument_ms: float | None = None,
) -> dict:
    out: dict[str, Any] = {
        "type": "file.instrumented",
        "fileId": file_id,
        "path": path,
        "rangeBase": range_base,
        "ranges": ranges,
        "statements": statements,
        "functions": functions,
        "magic": magic,
    }
    if instrumented_source is not None:
        out["instrumentedSource"] = instrumented_source
    if instrument_ms is not None:
        out["instrumentMs"] = round(instrument_ms, 3)
    return out


def ev_output(stream: str, text: str, step: int | None = None) -> dict:
    out: dict[str, Any] = {"type": "output", "stream": stream, "text": text}
    if step is not None:
        out["step"] = step
    return out


def ev_coverage(file_id: int, states: list[int], hits: list[int]) -> dict:
    return {"type": "coverage", "fileId": file_id, "states": states, "hits": hits}


def ev_time(rid: int, n: int, total: float, mn: float, mx: float) -> dict:
    return {"type": "time", "rid": rid, "n": n, "total": total, "min": mn, "max": mx}


def ev_trace(steps_b64: str, scopes: list[dict], truncated: bool, *, partial: bool = False, offset: int = 0, mid_run: bool = False) -> dict:
    out: dict[str, Any] = {"type": "trace", "steps": steps_b64, "scopes": scopes, "truncated": truncated}
    if mid_run:
        out["midRun"] = True  # the recording started at a pause (`recordFrom`): step 0 is not the program's start
    if partial:
        out["partial"] = True
        out["offset"] = offset
    return out


def ev_run_finished(
    *,
    exit_code: int | None,
    duration_ms: float,
    timed_out: bool,
    stopped: bool,
    step_count: int,
    log_count: int,
    profile: dict | None = None,
    extra: dict | None = None,
) -> dict:
    """``run.finished``. ``extra`` (what plugins returned from ``after``, e.g. ``replayed``/``http``) is
    merged in first; the runtime's own fields (``type``, ``exitCode``, ``durationMs``, ``timedOut``,
    ``stopped``, ``stepCount``, ``logCount``, ``profile``) are set after it, so they win."""
    out: dict[str, Any] = {"type": "run.finished", **(extra or {})}  # `type` first on the wire; re-set below in case `extra` carried one
    out.update(type="run.finished", exitCode=exit_code, durationMs=duration_ms, timedOut=timed_out, stopped=stopped, stepCount=step_count, logCount=log_count)
    if profile:
        out["profile"] = profile
    else:
        out.pop("profile", None)
    return out
