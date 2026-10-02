"""Run one scratch file in the current process: import hook, module execution, output capture.

Used by the forked/spawned child (``runner``) and by the ``run`` CLI. Nothing
here touches the runner's stdout: every event goes through ``emit``.
"""

from __future__ import annotations

import builtins
import functools
import importlib.abc
import importlib.machinery
import importlib.util
import io
import os
import site
import sys
import threading
import time
import types
from dataclasses import dataclass, field
from typing import Any, Callable

from . import cache
from . import module_run
from . import secrets
from .instrument import InstrumentOptions, InstrumentedFile, Instrumenter
from .protocol import RunConfig
from .serialize import Registry
from .spans import module_span
from .tracer import Tracer

RUNTIME_DIR = os.path.dirname(os.path.abspath(__file__))
_SKIP_SEGMENTS = {"site-packages", "dist-packages", "__pycache__", ".venv", "venv", "node_modules", ".tox", ".nox"}
_plugins_started: set[str] = set()
current: Execution | None = None  # the running Execution from `before_each` to `after` (plugins read spec.file_path there); None in the runner


def runner_error(message: str) -> None:
    """A ``runner.error`` for the current run, for plugin code; nothing outside a run."""
    if current is not None:
        current.emit({"type": "runner.error", "message": message})


@functools.lru_cache(maxsize=8192)
def _realpath(path: str) -> str:
    # `should_instrument` runs for every import attempt (stdlib included); realpath stats each path component
    return os.path.realpath(path)


@dataclass
class RunSpec:
    file_path: str
    display_name: str
    content: str | None
    workspace_root: str
    cwd: str
    argv: list[str]
    env: dict[str, str]
    project_files: dict[str, str]
    config: RunConfig
    markers: list[dict]
    expressions_to_evaluate: dict
    watch: list[dict]
    trace_context: dict | None
    module: str | None = None  # `run.module`: a `python -m` launch instead of a file (module_run.py)
    mode: str = "normal"
    raw: dict = field(default_factory=dict)

    @classmethod
    def from_request(cls, req: dict) -> "RunSpec":
        f = req.get("file") or {}
        path = os.path.abspath(str(f.get("path") or req.get("path") or "scratch.py"))
        workspace = str(req.get("workspaceRoot") or os.path.dirname(path))
        config = RunConfig.from_dict(req.get("config"))
        mode = str(req.get("mode") or "normal")
        module = str(req.get("module") or "").strip() or None
        return cls(
            file_path=path,
            display_name=str(f.get("displayName") or os.path.basename(path)),
            content=f.get("content"),
            workspace_root=os.path.abspath(workspace),
            cwd=str(req.get("cwd") or workspace),
            argv=[str(a) for a in (req.get("argv") or [])],
            env={str(k): str(v) for k, v in (req.get("env") or {}).items()},
            project_files={os.path.abspath(str(p["path"])): str(p.get("content", "")) for p in (req.get("projectFiles") or []) if p.get("path")},
            config=config,
            markers=list(req.get("markers") or []),
            expressions_to_evaluate=dict(req.get("expressionsToEvaluate") or {}),
            watch=list(req.get("watch") or []),
            trace_context=req.get("traceContext"),
            module=module,
            mode=mode if config.records else "normal",  # profile and snaps are recordings of a different shape
            raw=req,
        )


@dataclass
class RunResult:
    exit_code: int
    uncaught: BaseException | None
    duration_ms: float
    step_count: int
    log_count: int
    profile: dict | None = None
    extra: dict = field(default_factory=dict)  # what the plugins' `after` returned, merged into `run.finished`


class StepStream(io.TextIOBase):
    """Replacement for sys.stdout/sys.stderr: Python-level writes become ``output`` events with the current step."""

    def __init__(self, stream: str, emit: Callable[[dict], None], tracer_ref: Callable[[], Tracer | None]) -> None:
        super().__init__()
        self.stream = stream
        self.emit = emit
        self.tracer_ref = tracer_ref
        self.buffer_text = ""
        self.lock = threading.Lock()

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"

    @property
    def errors(self) -> str:  # type: ignore[override]
        return "replace"

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            text = str(text)
        with self.lock:
            self.buffer_text += text
            if "\n" in self.buffer_text or len(self.buffer_text) > 4096:
                self._flush_locked()
        return len(text)

    def _flush_locked(self) -> None:
        if not self.buffer_text:
            return
        text, self.buffer_text = self.buffer_text, ""
        tracer = self.tracer_ref()
        event: dict[str, Any] = {"type": "output", "stream": self.stream, "text": text}
        if tracer is not None:
            event["step"] = tracer.output_step()  # the statement this write came from, in both modes
        self.emit(event)

    def flush(self) -> None:
        with self.lock:
            self._flush_locked()

    def fileno(self) -> int:
        return 1 if self.stream == "stdout" else 2

    def isatty(self) -> bool:
        return False


class _Loader(importlib.machinery.SourceFileLoader):
    def __init__(self, fullname: str, path: str, execution: "Execution") -> None:
        super().__init__(fullname, path)
        self.execution = execution

    def get_data(self, path: str) -> bytes:
        content = self.execution.spec.project_files.get(os.path.abspath(path))
        if content is not None:
            return content.encode("utf-8")
        return super().get_data(path)

    def get_code(self, fullname: str):  # type: ignore[override]
        source = importlib.util.decode_source(self.get_data(self.path))
        info = self.execution.instrument_source(source, self.path, module_scope=True, library=not self.execution.is_project_file(self.path))
        if info.code is None:
            raise SyntaxError(info.error or "cannot compile %s" % self.path)
        return info.code

    def set_data(self, path: str, data: bytes, *, _mode: int = 0o666) -> None:  # never write bytecode
        return None


class _Finder(importlib.abc.MetaPathFinder):
    def __init__(self, execution: "Execution") -> None:
        self.execution = execution

    def find_spec(self, fullname: str, path: Any = None, target: Any = None):  # type: ignore[override]
        if self.execution.in_plugin_hook:
            return None  # a plugin's module, and what its hooks import, is runtime code: never instrumented
        try:
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        except Exception:  # noqa: BLE001
            return None
        if spec is None or not spec.origin or not str(spec.origin).endswith(".py"):
            return None
        if not self.execution.should_instrument(spec.origin, fullname):
            return None
        loader = _Loader(fullname, spec.origin, self.execution)
        return importlib.util.spec_from_file_location(fullname, spec.origin, loader=loader, submodule_search_locations=spec.submodule_search_locations)


class Execution:
    def __init__(self, spec: RunSpec, emit: Callable[[dict], None], *, registry: Registry | None = None) -> None:
        self.spec = spec
        self.emit = emit
        self.registry = registry if registry is not None else Registry()
        self.tracer: Tracer | None = None
        self.next_file_id = 1
        self.finder = _Finder(self)
        self.module: Any = None
        self.skip_prefixes = self._skip_prefixes()
        self.aborted = False
        self.plugin_results: dict = {}
        self.in_plugin_hook = False  # while set, `finder` instruments nothing
        self.on_tracer: Callable[[Tracer], None] | None = None  # the run child attaches a debugger here (control.py)
        self.main_globals: dict | None = None  # the namespace the run used; `control` evaluates against it after the run
        secrets.install(spec.config.mask_secrets, spec.config.secret_names)

    # -- import filtering ------------------------------------------------------------
    def _skip_prefixes(self) -> list[str]:
        out = {RUNTIME_DIR, sys.prefix, sys.base_prefix, sys.exec_prefix}
        try:
            out.update(site.getsitepackages())
        except Exception:  # noqa: BLE001
            pass
        try:
            out.add(site.getusersitepackages())
        except Exception:  # noqa: BLE001
            pass
        return [os.path.realpath(p) for p in out if p]

    def should_instrument(self, path: str, fullname: str | None = None) -> bool:
        """Project files are always instrumented; library modules only with `libraryCode`.

        `exclude` takes a module or file out (it runs at full speed and records nothing); `only`,
        when set, records just the matching modules, library ones included without `libraryCode`.
        Neither touches the main file, which is instrumented outside this finder.
        """
        cfg = self.spec.config
        if cfg.exclude and self.matches(cfg.exclude, path, fullname):
            return False
        if cfg.only:
            if not self.matches(cfg.only, path, fullname):
                return False
            return self.is_project_file(path) or self.is_library_module(path, fullname, forced=True)
        if self.is_project_file(path):
            return True
        return self.is_library_module(path, fullname)

    def matches(self, patterns: list[str], path: str, fullname: str | None) -> bool:
        """Whether a module is named by one of ``patterns``: a dotted module name or glob (``pkg.flash``
        also covers ``pkg.flash.parser``), or a path glob, absolute or relative to the workspace root,
        where a directory covers what is under it (``pkg/flash``, ``*/parser.py``, ``pkg/*``)."""
        from fnmatch import fnmatchcase

        real = _realpath(path)
        root = _realpath(self.spec.workspace_root).rstrip(os.sep) + os.sep
        rel = real[len(root):] if real.startswith(root) else None
        for raw in patterns:
            pat = raw.strip()
            if not pat:
                continue
            if fullname and "/" not in pat and os.sep not in pat and not pat.endswith(".py"):
                if fnmatchcase(fullname, pat) or fullname.startswith(pat + ".") or fnmatchcase(fullname, pat + ".*"):
                    return True
            p = pat.replace("/", os.sep).rstrip(os.sep)
            for candidate in (real, rel):
                if candidate is None:
                    continue
                if fnmatchcase(candidate, p) or fnmatchcase(candidate, p + os.sep + "*"):
                    return True
            # a bare file or directory name matches it anywhere: `parser.py`, `flash`
            if os.sep not in p and (p in real.split(os.sep)[:-1] or fnmatchcase(os.path.basename(real), p)):
                return True
        return False

    def is_project_file(self, path: str) -> bool:
        real = _realpath(path)
        root = _realpath(self.spec.workspace_root)
        if not (real == root or real.startswith(root.rstrip(os.sep) + os.sep)):
            return False
        for prefix in self.skip_prefixes:
            if real == prefix or real.startswith(prefix.rstrip(os.sep) + os.sep):
                return False
        parts = set(real.split(os.sep))
        if parts & _SKIP_SEGMENTS:
            return False
        return True

    def is_library_module(self, path: str, fullname: str | None, *, forced: bool = False) -> bool:
        """Opt-in (`libraryCode`): third-party modules, never the stdlib or this runtime.

        `libraryPackages`, when non-empty, narrows it to matching top-level names or
        dotted globs (`requests`, `mypkg.*`).
        """
        cfg = self.spec.config
        if not (cfg.library_code or forced) or not fullname:
            return False
        top = fullname.split(".")[0]
        if not top or top == "pyokka_runtime" or top in getattr(sys, "stdlib_module_names", ()):
            return False
        real = _realpath(path)
        if real.startswith(_realpath(RUNTIME_DIR)) or "__pycache__" in real.split(os.sep):
            return False
        if cfg.library_packages and not forced:
            from fnmatch import fnmatchcase

            return any(fnmatchcase(top, pat) or fnmatchcase(fullname, pat) for pat in cfg.library_packages)
        return True

    # -- instrumentation -----------------------------------------------------------------
    def _options(self, file_id: int, *, module_scope: bool, library: bool, unparse: bool) -> InstrumentOptions:
        cfg = self.spec.config
        is_main = file_id == 1 and cfg.records  # autoLog and markers are logs, which a run without a recording has none of
        return InstrumentOptions(
            mode=self.spec.mode if is_main else "normal",
            auto_log=cfg.auto_log if is_main else False,
            markers=self.spec.markers if is_main else [],
            ignore_coverage=cfg.ignore_coverage,
            ignore_coverage_for_file=cfg.ignore_coverage_for_file,
            module_scope=module_scope,
            unparse=unparse,
            magic=not library,
            library=library,
        )

    def instrument_source(self, source: str, path: str, *, module_scope: bool, library: bool = False) -> InstrumentedFile:
        """Instrument (or, for library files, fetch from the cache) and register one file.

        Library files skip `instrumentedSource` (4-8 MB per run for openai; the `source`
        request serves it on demand) and go through the on-disk cache.
        """
        file_id = self.next_file_id
        self.next_file_id += 1
        options = self._options(file_id, module_scope=module_scope, library=library, unparse=not library)
        base = self.tracer.next_range_base() if self.tracer is not None else 0
        started = time.perf_counter()
        info: InstrumentedFile | None = None
        entry = cache.entry_path(path, options) if library else None
        if entry is not None:
            info = cache.load(entry, path, file_id, base)
        if info is None:
            options.relocatable = entry is not None
            info = Instrumenter(source, path, file_id, base, options).run()
            if entry is not None:
                cache.store(entry, info)
        instrument_ms = (time.perf_counter() - started) * 1000.0
        if not info.ranges:
            info.ranges = [list(module_span(source))]
        if self.tracer is not None:
            self.tracer.add_file(info)
        self.emit(info.to_event(path, instrument_ms))
        for w in info.warnings:
            self.emit({"type": "log", "logId": "w-%d-%d" % (file_id, len(w)), "kind": "system", "fileId": file_id, "rid": base, "hit": 1, "step": 0, "text": w, "runtimeKey": "warn"})
        if info.error:
            self.emit({
                "type": "error",
                "fileId": file_id,
                "rid": base,
                "step": self.tracer.cur_step if self.tracer else 0,
                "message": info.error,
                "errorType": "SyntaxError" if "SyntaxError" in info.error else "InstrumentationError",
                "stack": [{"fileId": file_id, "line": info.error_line or 1, "col": 0, "function": "<module>", "path": path}],
                "handled": False,
            })
        return info

    def instrumented_source(self, file_id: int) -> str | None:
        """The instrumented source of a file of this run, re-derived when it was not sent."""
        info = self.tracer.files_by_id.get(file_id) if self.tracer is not None else None
        if info is None:
            raise LookupError("no file %s in this run" % file_id)
        if info.instrumented_source is not None:
            return info.instrumented_source
        source = self.spec.project_files.get(os.path.abspath(info.filename))
        if source is None:
            with open(info.filename, "rb") as fh:
                source = importlib.util.decode_source(fh.read())
        options = self._options(file_id, module_scope=file_id != 1, library=info.library, unparse=True)
        return Instrumenter(source, info.filename, file_id, info.range_base, options).run().instrumented_source

    # -- plugins -----------------------------------------------------------------------------
    def run_plugins(self, stage: str) -> None:
        self.in_plugin_hook = True
        try:
            for name in self.spec.config.plugins:
                try:
                    import importlib

                    mod = importlib.import_module(name)
                    if stage == "before" and name not in _plugins_started:
                        _plugins_started.add(name)
                        fn = getattr(mod, "before", None)
                        if callable(fn):
                            fn(self.spec.config.raw)
                    if stage == "before_each":
                        fn = getattr(mod, "before_each", None)
                        if callable(fn):
                            fn(self.spec.config.raw)
                    if stage == "after":
                        fn = getattr(mod, "after", None)
                        if callable(fn):
                            out = fn(self.spec.config.raw)
                            if isinstance(out, dict):
                                self.plugin_results.update(out)
                except Exception as exc:  # noqa: BLE001
                    self.emit({"type": "runner.error", "message": "plugin %s failed in %s: %s: %s" % (name, stage, type(exc).__name__, exc)})
        finally:
            self.in_plugin_hook = False

    # -- execution ------------------------------------------------------------------------------
    def load_source(self) -> str:
        if self.spec.content is not None:
            return self.spec.content
        with open(self.spec.file_path, "rb") as fh:
            return importlib.util.decode_source(fh.read())

    def abort(self) -> None:
        """Called from a signal handler: flush what we have."""
        self.aborted = True
        if self.tracer is not None:
            self.tracer.finish(None)

    def run(self) -> RunResult:
        global current
        spec = self.spec
        started = time.perf_counter()
        os.environ.update(spec.env)
        try:
            if spec.cwd and os.path.isdir(spec.cwd):
                os.chdir(spec.cwd)
        except OSError:
            pass
        sys.dont_write_bytecode = True
        source = ""
        if spec.module:
            if spec.raw.get("file"):
                self.emit({"type": "runner.error", "message": "run.module and run.file are both set; running the module %s" % spec.module})
        else:
            sys.argv = [spec.file_path, *spec.argv]
            file_dir = os.path.dirname(spec.file_path)
            if sys.path and sys.path[0] != file_dir:
                sys.path.insert(0, file_dir)
            try:
                source = self.load_source()
            except OSError as exc:
                self.emit({"type": "runner.error", "message": "cannot read %s: %s" % (spec.file_path, exc)})
                return RunResult(1, None, 0.0, 0, 0)
        self.tracer = Tracer(spec.config, self.emit, trace_context=spec.trace_context, watches=spec.watch, expressions_to_evaluate=spec.expressions_to_evaluate, registry=self.registry)
        tracer = self.tracer
        if self.on_tracer is not None:
            self.on_tracer(tracer)
        tracer.snaps_mode = spec.mode == "snaps"
        module = types.ModuleType("__main__")
        module.__file__ = spec.file_path
        module.__dict__["__builtins__"] = builtins
        module.__dict__["__spec__"] = None
        sys.modules["__main__"] = module
        self.module = module  # kept alive for `evaluate` requests after the run
        self.main_globals = module.__dict__
        profile = None
        uncaught: BaseException | None = None
        exit_code = 0
        current = self
        # The finder goes on before the plugins run: the contract promises them it is already first,
        # so a finder a plugin inserts at 0 sees every import before the runtime does.
        sys.meta_path.insert(0, self.finder)
        try:
            self.run_plugins("before")
            self.run_plugins("before_each")
            if spec.mode == "profile":
                return self._run_profile(source, module, started)
            code_obj: Any = None
            if not spec.module:
                info = self.instrument_source(source, spec.file_path, module_scope=False)
                tracer.stop_code = info.code
                code_obj = info.code
                if code_obj is None:
                    tracer.error_states[info.range_base] = 3
                    self.run_plugins("after")
                    tracer.finish(None)
                    return RunResult(1, None, (time.perf_counter() - started) * 1000, tracer.step_count(), tracer.log_count, extra=self.plugin_results)
            # A `-m` launch resolves inside the try below: finding the module imports its parent
            # packages, which is the program running, so the hooks have to be on first.
            tracer.install()
            try:
                if spec.module:
                    code_obj = module_run.launch(self, spec.module)
                    module = sys.modules["__main__"]
                    if code_obj is None:
                        exit_code = 1
                if code_obj is not None:
                    exec(code_obj, module.__dict__)  # noqa: S102 - this is the point
            except SystemExit as exc:
                code = exc.code
                exit_code = code if isinstance(code, int) else (0 if code is None else 1)
                if not isinstance(code, int) and code is not None:
                    self.emit({"type": "output", "stream": "stderr", "text": str(code) + "\n", "step": tracer.output_step()})
            except KeyboardInterrupt:
                exit_code = 130
            except BaseException as exc:  # noqa: BLE001 - user code
                uncaught = exc
                exit_code = 1
                if tracer.dbg is not None:
                    tracer.dbg.on_uncaught(exc)  # a debug run pauses here unless breakOnException is off
            finally:
                self._flush_std()
                self.run_plugins("after")
                tracer.finish(uncaught)
                tracer.uninstall()
        finally:
            current = None
            try:
                sys.meta_path.remove(self.finder)
            except ValueError:
                pass
        return RunResult(exit_code, uncaught, (time.perf_counter() - started) * 1000, tracer.step_count(), tracer.log_count, profile, extra=self.plugin_results)

    def _flush_std(self) -> None:
        for s in (sys.stdout, sys.stderr):
            try:
                s.flush()
            except Exception:  # noqa: BLE001
                pass

    def _run_profile(self, source: str, module: types.ModuleType, started: float) -> RunResult:
        import cProfile

        from .profile import write_cpuprofile

        info = self.instrument_source(source, self.spec.file_path, module_scope=False)
        # The plain file runs without the tracer's builtins, so imports must stay plain too: off with the finder.
        try:
            sys.meta_path.remove(self.finder)
        except ValueError:
            pass
        try:
            code = compile(source, self.spec.file_path, "exec", dont_inherit=True)
        except SyntaxError:
            self.run_plugins("after")
            return RunResult(1, None, (time.perf_counter() - started) * 1000, 0, 0, extra=self.plugin_results)
        prof = cProfile.Profile()
        uncaught = None
        exit_code = 0
        try:
            prof.runctx(code, module.__dict__, module.__dict__)
        except SystemExit as exc:
            exit_code = exc.code if isinstance(exc.code, int) else 1
        except BaseException as exc:  # noqa: BLE001
            uncaught = exc
            exit_code = 1
        finally:
            self._flush_std()
            self.run_plugins("after")
        path = write_cpuprofile(prof, self.spec.display_name)
        if self.tracer is not None:
            if uncaught is not None:
                self.tracer.report_uncaught(uncaught)
            self.tracer.finish(None)
        _ = info
        return RunResult(exit_code, uncaught, (time.perf_counter() - started) * 1000, 0, 0, {"path": path}, extra=self.plugin_results)


def install_step_streams(emit: Callable[[dict], None], tracer_ref: Callable[[], Tracer | None]) -> None:
    sys.stdout = StepStream("stdout", emit, tracer_ref)
    sys.stderr = StepStream("stderr", emit, tracer_ref)
