"""Value logging for the tracer: live comments, identifiers, print, logpoints, timing, awaitables."""

from __future__ import annotations

import asyncio
import inspect
import re
import sys
import time
from typing import Any

from .protocol import (
    FLAG_LOG,
    KIND_AUTO_EXPAND,
    KIND_TIME,
    KIND_TIME_AUTO_EXPAND,
    dumps,
)
from . import secrets
from .serialize import expression_name, serialize, short_repr
from .values import cut_entry

_TEMPLATE_RE = re.compile(r"\{([^{}]+)\}")
_AUTO_EXPAND_KINDS = (KIND_AUTO_EXPAND, KIND_TIME_AUTO_EXPAND)


class LogMixin:
    """Mixed into ``Tracer``; relies on its state (config, emit, hits, steps, registry...)."""

    # -- generic log emission ------------------------------------------------
    def _next_log_id(self) -> str:
        self.log_serial += 1
        return "l-%d" % self.log_serial

    def _limits_for(self, kind: str):
        return self.config.auto_expand if kind in _AUTO_EXPAND_KINDS else self.config.inline

    def _bag(self, value: Any, runtime_key: str, hit: int, kind: str, context: str | None) -> dict:
        limits = self._limits_for(kind)
        tree = self.expressions_to_evaluate.get(runtime_key)
        node = serialize(
            value,
            limits,
            root_key=runtime_key,
            hit=hit,
            expand_tree=tree,
            registry=self.registry,
            resolve_getters=self.config.resolve_getters,
            expression_root=context,
        )
        budget = self.config.max_log_entry_size
        if budget and len(dumps(node)) > budget:
            depth, elements = limits.depth, limits.elements
            while True:
                depth = max(0, depth - 1) if depth > 1 else 0
                elements = max(8, elements // 4)
                shrunk = type(limits)(depth, elements, min(limits.string_length, budget // 2))
                node = serialize(value, shrunk, root_key=runtime_key, hit=hit, registry=self.registry, resolve_getters=self.config.resolve_getters, expression_root=context)
                if len(dumps(node)) <= budget or depth == 0:
                    break
        return {"data": node, "runtimeKey": runtime_key}

    def _log_allowed(self, rid: int) -> int | None:
        """Per-range and global throttling. Returns the hit number or None when suppressed."""
        hit = self.log_hits.get(rid, 0) + 1
        self.log_hits[rid] = hit
        limit = self.config.log_limit
        if limit and hit > limit:
            if hit == limit + 1:
                self._system_log(rid, "log limit (%d) reached for this line; further values are not shown" % limit)
            return None
        if self.config.max_console_messages and self.log_count >= self.config.max_console_messages:
            if not self.console_limit_hit:
                self.console_limit_hit = True
                self._system_log(rid, "maximum of %d messages reached; further values are not shown" % self.config.max_console_messages, force=True)
            return None
        return hit

    def _emit_log(self, rid: int, kind: str, text: str, *, hit: int = 1, context: str | None = None, runtime_key: str | None = None, value_bag: dict | None = None, marker_id: str | None = None, change_id: str | None = None, time_info: dict | None = None, cut: dict | None = None) -> None:
        step = self.cur_step
        event: dict[str, Any] = {
            "type": "log",
            "logId": self._next_log_id(),
            "kind": kind,
            "fileId": self.file_id_for(rid),
            "rid": rid,
            "hit": hit,
            "step": step,
            "text": text,
            "runtimeKey": runtime_key if runtime_key is not None else str(rid),
        }
        if context is not None:
            event["context"] = context
        if change_id is not None:
            event["changeId"] = change_id
        if marker_id is not None:
            event["markerId"] = marker_id
        if value_bag is not None:
            event["valueBag"] = value_bag
        if time_info is not None:
            event["time"] = time_info
        if cut:
            event.update(cut)  # `truncated` and `length`: the text was cut (values.value_text)
        self.log_count += 1
        self._flag_step(step, FLAG_LOG)
        self.emit(event)

    def _system_log(self, rid: int, text: str, *, force: bool = False) -> None:
        if not force and text in self.system_messages:
            return
        self.system_messages.add(text)
        self._emit_log(rid, "system", text, runtime_key="system:%d" % rid)

    def hook_error(self, exc: BaseException, where: str = "hook") -> None:
        if not self.record:
            # No recording, so no `log` event exists to carry it; `runner.error` is the channel.
            message = "debugger hook failed in %s: %s: %s" % (where, type(exc).__name__, exc)
            if message not in self.system_messages:
                self.system_messages.add(message)
                self.emit({"type": "runner.error", "message": message})
            return
        self._system_log(self.cur_rid(), "Pyokka %s error: %s: %s" % (where, type(exc).__name__, exc))

    # -- value logs -------------------------------------------------------------
    def log_value(self, rid: int, context: str | None, value: Any, kind: str, marker_id: str | None = None, change_id: str | None = None, fn: Any = None, discard: bool = False) -> None:
        shown = value
        if fn is not None:
            try:
                shown = fn(value)
            except BaseException as exc:  # noqa: BLE001 - user `$` code
                self._emit_error_value(rid, context, exc, marker_id, change_id)
                return
        if inspect.iscoroutine(shown):
            if discard or fn is not None:
                self._resolve_coroutine(rid, context, shown, kind, marker_id, change_id)
            else:
                self._log_object(rid, context, shown, kind, marker_id, change_id)
            return
        if isinstance(shown, asyncio.Future):
            self._watch_future(rid, context, shown, kind, marker_id, change_id)
            return
        self._log_object(rid, context, shown, kind, marker_id, change_id)

    def _log_object(self, rid: int, context: str | None, value: Any, kind: str, marker_id: str | None, change_id: str | None, runtime_key: str | None = None) -> None:
        hit = self._log_allowed(rid)
        if hit is None:
            return
        key = runtime_key or str(rid)
        bag = self._bag(value, key, hit, kind, context)
        cut = cut_entry({}, expression_name(context), value, self.log_chars)
        self._emit_log(rid, kind, cut.pop("text"), hit=hit, context=context, runtime_key=key, value_bag=bag, marker_id=marker_id, change_id=change_id, cut=cut)

    def _emit_error_value(self, rid: int, context: str | None, exc: BaseException, marker_id: str | None, change_id: str | None) -> None:
        hit = self._log_allowed(rid)
        if hit is None:
            return
        bag = self._bag(exc, str(rid), hit, "value", context)
        self._emit_log(rid, "error", "%s: %s" % (type(exc).__name__, exc), hit=hit, context=context, value_bag=bag, marker_id=marker_id, change_id=change_id)

    def _resolve_coroutine(self, rid: int, context: str | None, coro: Any, kind: str, marker_id: str | None, change_id: str | None) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is None:
            try:
                result = asyncio.run(coro)
            except BaseException as exc:  # noqa: BLE001
                self._emit_error_value(rid, context, exc, marker_id, change_id)
                return
            self._log_object(rid, context, result, kind, marker_id, change_id)
            return
        task = loop.create_task(coro)
        self._watch_future(rid, context, task, kind, marker_id, change_id)

    def _watch_future(self, rid: int, context: str | None, fut: Any, kind: str, marker_id: str | None, change_id: str | None) -> None:
        def done(f: Any) -> None:
            try:
                if f.cancelled():
                    self._log_object(rid, context, "<cancelled>", kind, marker_id, change_id)
                elif f.exception() is not None:
                    self._emit_error_value(rid, context, f.exception(), marker_id, change_id)
                else:
                    self._log_object(rid, context, f.result(), kind, marker_id, change_id)
            except BaseException as exc:  # noqa: BLE001
                self.hook_error(exc, "future")

        if fut.done():
            done(fut)
        else:
            fut.add_done_callback(done)

    # -- timing -----------------------------------------------------------------
    def log_time(self, rid: int, context: str | None, t0: float, value: Any, kind: str, marker_id: str | None, change_id: str | None) -> None:
        dt = (time.perf_counter() - t0) * 1000.0
        agg = self.times.get(rid)
        if agg is None:
            agg = self.times[rid] = [0, 0.0, dt, dt]
        agg[0] += 1
        agg[1] += dt
        if dt < agg[2]:
            agg[2] = dt
        if dt > agg[3]:
            agg[3] = dt
        self.times_dirty = True
        hit = self._log_allowed(rid)
        if hit is None:
            return
        info = {"n": agg[0], "total": agg[1], "min": agg[2], "max": agg[3]}
        self._emit_log(rid, "time", "%.3fms" % dt, hit=hit, context=context, runtime_key="t:%d" % rid, marker_id=marker_id, change_id=change_id, time_info=info)
        if kind == KIND_TIME_AUTO_EXPAND:
            bag = self._bag(value, str(rid), hit, KIND_AUTO_EXPAND, context)
            cut = cut_entry({}, expression_name(context), value, self.log_chars)
            self._emit_log(rid, "value", cut.pop("text"), hit=hit, context=context, value_bag=bag, marker_id=marker_id, change_id=change_id, cut=cut)
        elif kind != KIND_TIME and kind != "time":
            self._log_object(rid, context, value, kind, marker_id, change_id)

    # -- print ------------------------------------------------------------------
    def log_print(self, rid: int, args: tuple, kwargs: dict) -> None:
        file = kwargs.get("file")
        stream = "stdout"
        if file is not None:
            if file is sys.stderr or file is sys.__stderr__:
                stream = "stderr"
            elif file is not sys.stdout and file is not sys.__stdout__:
                self.real_print(*args, **kwargs)
                return
        sep = kwargs.get("sep")
        end = kwargs.get("end")
        sep = " " if sep is None else sep
        end = "\n" if end is None else end
        text = sep.join(str(a) for a in args) + end
        hit = self._log_allowed(rid)
        if hit is None:
            return
        shown: Any
        if len(args) == 1:
            shown = args[0]
        elif not args:
            shown = ""
        else:
            shown = tuple(args)
        bag = self._bag(shown, str(rid), hit, "value", None)
        inline = secrets.current.scrub(text[:-1] if text.endswith("\n") else text)
        inline = inline.replace("\r\n", "\n").replace("\n", "\\n")
        cut: dict = {}
        if len(inline) > self.log_chars:
            cut = {"truncated": True, "length": len(inline)}
            inline = "%s…(+%s chars)" % (inline[: self.log_chars - 1], format(len(inline) - self.log_chars + 1, ","))
        self._emit_log(rid, "log", inline, hit=hit, context="stderr" if stream == "stderr" else None, value_bag=bag, cut=cut)

    # -- logpoints and host `exp` markers ------------------------------------------
    def log_point(self, rid: int, kind: str, template: str, context: str | None, marker_id: str | None, change_id: str | None, is_expr: bool, frame: Any) -> None:
        if is_expr:
            try:
                value = eval(self._compiled(template), frame.f_globals, frame.f_locals)  # noqa: S307 - user expression
            except BaseException as exc:  # noqa: BLE001
                self._emit_error_value(rid, context or template, exc, marker_id, change_id)
                return
            self.log_value(rid, context or template, value, kind, marker_id, change_id)
            return
        parts = _TEMPLATE_RE.split(template)
        if len(parts) == 3 and parts[0].strip() == "" and parts[2].strip() == "":
            expr = parts[1]
            try:
                value = eval(self._compiled(expr), frame.f_globals, frame.f_locals)  # noqa: S307
            except BaseException as exc:  # noqa: BLE001
                self._emit_error_value(rid, expr, exc, marker_id, change_id)
                return
            self.log_value(rid, context if context is not None else expr, value, kind, marker_id, change_id)
            return
        out: list[str] = []
        for i, part in enumerate(parts):
            if i % 2 == 0:
                out.append(part)
                continue
            try:
                out.append(str(eval(self._compiled(part), frame.f_globals, frame.f_locals)))  # noqa: S307
            except BaseException as exc:  # noqa: BLE001
                out.append("{%s: %s}" % (type(exc).__name__, exc))
        text = "".join(out)
        hit = self._log_allowed(rid)
        if hit is None:
            return
        bag = self._bag(text, str(rid), hit, kind, context)
        cut = cut_entry({}, None, text, self.log_chars)
        self._emit_log(rid, kind, cut.pop("text"), hit=hit, context=context, value_bag=bag, marker_id=marker_id, change_id=change_id, cut=cut)

    def log_parameters(self, rid: int, info: dict, frame: Any) -> None:
        code = frame.f_code
        n = code.co_argcount + code.co_kwonlyargcount
        names = list(code.co_varnames[:n])
        if code.co_flags & inspect.CO_VARARGS:
            names.append(code.co_varnames[n])
            n += 1
        if code.co_flags & inspect.CO_VARKEYWORDS:
            names.append(code.co_varnames[n])
        local = frame.f_locals
        kind = info.get("kind") or "logpoint"
        for name in names:
            if name in local:
                self._log_object(rid, name, local[name], kind, info.get("markerId"), info.get("changeId"), runtime_key="%d:%s" % (rid, name))

    def _compiled(self, expr: str):
        code = self.compiled_cache.get(expr)
        if code is None:
            code = compile(expr.strip(), "<pyokka-expr>", "eval")
            self.compiled_cache[expr] = code
        return code
