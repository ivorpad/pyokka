"""On-disk cache of instrumented library files.

Rewriting a third-party package on every run costs more than running it (openai with
pydantic: about 1000 files, 3-4 s of AST work), so library files are cached under
``$PYOKKA_HOME/cache/`` (``~/.pyokka`` by default; ``PYOKKA_CACHE_DIR`` overrides the directory; empty disables the
cache). An entry is keyed by the runtime version, the interpreter's bytecode magic, the
file's real path, mtime and size, and the instrumentation options, and holds the
marshalled code object compiled at ``RELOC_BASE`` plus the constant slots that carry range
ids, so it can be rebased to whatever ``range_base`` the current run assigns the file.
Project files are never cached: they change all the time and are cheap.
"""

from __future__ import annotations

import hashlib
import importlib.util
import marshal
import os
import sys
import tempfile
import time

from . import __version__
from .home import pyokka_home
from .instrument import RELOC_BASE, InstrumentedFile, InstrumentOptions, relocate

FORMAT = 3  # 2: imported modules keep their own line positions (the module_scope wrap no longer stamps line 1); 3: `_pk_r` on every return
MAX_AGE_S = 30 * 24 * 3600  # entries not rewritten for this long are swept (once per process, after a store)
_swept = False


def cache_dir() -> str | None:
    env = os.environ.get("PYOKKA_CACHE_DIR")
    if env is not None:
        return env or None
    return os.path.join(pyokka_home(), "cache")


def _options_key(options: InstrumentOptions) -> str:
    return "|".join(str(x) for x in (options.mode, options.auto_log, options.ignore_coverage, options.ignore_coverage_for_file, options.module_scope, options.magic, options.library))


def entry_path(path: str, options: InstrumentOptions) -> str | None:
    """Where the entry for ``path`` (as it is on disk right now) lives, or None when caching is off."""
    directory = cache_dir()
    if not directory:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    parts = (str(FORMAT), __version__, importlib.util.MAGIC_NUMBER.hex(), sys.implementation.cache_tag or "", os.path.realpath(path), str(st.st_mtime_ns), str(st.st_size), _options_key(options))
    digest = hashlib.sha1("\0".join(parts).encode("utf-8", "surrogateescape")).hexdigest()
    return os.path.join(directory, digest + ".bin")


def load(entry: str, path: str, file_id: int, range_base: int) -> InstrumentedFile | None:
    try:
        with open(entry, "rb") as fh:
            data = marshal.load(fh)
    except (OSError, EOFError, ValueError, TypeError):
        return None
    try:
        code = relocate(data["code"], [tuple(p) for p in data["slots"]], range_base - RELOC_BASE)
        m = data["meta"]
        return InstrumentedFile(
            filename=path,
            file_id=file_id,
            range_base=range_base,
            code=code,
            ranges=[list(r) for r in m["ranges"]],
            statements=list(m["statements"]),
            functions=[dict(f) for f in m["functions"]],
            magic=[dict(x) for x in m["magic"]],
            instrumented_source=None,
            inline_config=m["inline_config"],
            expr_children={k: list(v) for k, v in m["expr_children"].items()},
            line_rids=dict(m["line_rids"]),
            ignored=set(m["ignored"]),
            ignore_file=bool(m["ignore_file"]),
            library=bool(m["library"]),
            def_logs={range_base + k: dict(v) for k, v in m["def_logs"].items()},
            function_names={range_base + k: v for k, v in m["function_names"].items()},
            warnings=list(m["warnings"]),
            module_rid=int(m["module_rid"]),
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def store(entry: str, info: InstrumentedFile) -> bool:
    """Write ``info`` (instrumented with ``relocatable=True``) to ``entry``; False when it cannot be cached."""
    if info.relocatable is None or info.error is not None:
        return False
    code, slots = info.relocatable
    base = info.range_base
    meta = {
        "ranges": [list(r) for r in info.ranges],
        "statements": list(info.statements),
        "functions": [dict(f) for f in info.functions],
        "magic": [dict(x) for x in info.magic],
        "inline_config": info.inline_config,
        "expr_children": {k: list(v) for k, v in info.expr_children.items()},
        "line_rids": dict(info.line_rids),
        "ignored": sorted(info.ignored),
        "ignore_file": info.ignore_file,
        "library": info.library,
        "def_logs": {k - base: dict(v) for k, v in info.def_logs.items()},
        "function_names": {k - base: v for k, v in info.function_names.items()},
        "warnings": list(info.warnings),
        "module_rid": info.module_rid,
    }
    try:
        data = marshal.dumps({"meta": meta, "code": code, "slots": [list(p) for p in slots]})
    except ValueError:
        return False
    directory = os.path.dirname(entry)
    tmp = None
    try:
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".bin")
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, entry)
        _sweep(directory)
        return True
    except OSError:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return False


def _sweep(directory: str) -> None:
    """Drop entries older than MAX_AGE_S (reinstalled packages leave their old entries behind)."""
    global _swept
    if _swept:
        return
    _swept = True
    cutoff = time.time() - MAX_AGE_S
    try:
        with os.scandir(directory) as it:
            for de in it:
                try:
                    if de.name.endswith(".bin") and de.is_file() and de.stat().st_mtime < cutoff:
                        os.unlink(de.path)
                except OSError:
                    pass
    except OSError:
        pass


def status(directory: str | None = None) -> dict:
    """The cache directory with its entry count and total size; ``dir`` is None when the cache is off."""
    directory = cache_dir() if directory is None else (directory or None)
    entries = 0
    size = 0
    for de in _entries(directory):
        try:
            size += de.stat(follow_symlinks=False).st_size
        except OSError:
            continue
        entries += 1
    return {"dir": directory, "entries": entries, "bytes": size}


def clear(directory: str | None = None) -> dict:
    """Remove every entry and report ``removed``, ``bytes`` and ``failed`` (a file in use on Windows, or read-only).

    Entries are the ``*.bin`` files at the top of the directory, ``.tmp-*.bin`` leftovers included; nothing
    else is touched, so a ``PYOKKA_CACHE_DIR`` that points at a shared folder loses only cache entries. The
    directory stays. The next run rewrites what it needs (``load`` on a missing entry is a miss, never an
    error), so clearing while a session is running costs that session one slow run at most.
    """
    directory = cache_dir() if directory is None else (directory or None)
    out = {"dir": directory, "removed": 0, "bytes": 0, "failed": 0}
    for de in _entries(directory):
        try:
            size = de.stat(follow_symlinks=False).st_size
            os.unlink(de.path)
        except OSError:
            out["failed"] += 1
            continue
        out["removed"] += 1
        out["bytes"] += size
    return out


def _entries(directory: str | None) -> list:
    """The ``*.bin`` regular files at the top of ``directory`` (symlinks skipped); [] when it is off or missing."""
    if not directory:
        return []
    try:
        with os.scandir(directory) as it:
            return [de for de in it if de.name.endswith(".bin") and de.is_file(follow_symlinks=False)]
    except OSError:
        return []
