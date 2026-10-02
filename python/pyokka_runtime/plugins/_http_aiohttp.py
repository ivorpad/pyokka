"""The aiohttp patch of ``http_record``: ``ClientSession._request`` and the bytes its ``StreamReader`` is fed."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import time
from types import SimpleNamespace
from typing import Any, Callable
from urllib.parse import urlencode

from . import _http_store as store
from ._http_fallback import owner


def patch_aiohttp(session: Any, mod: Any) -> None:
    """``ClientSession._request`` (every verb and ``request`` go through it) and ``StreamReader.feed_data``.

    Record and off hand the program aiohttp's own response, untouched: the body is
    captured as the connection feeds it into ``resp.content`` (``feed_data`` on the
    class, a dict miss for readers nobody taps; ``StreamReader`` has ``__slots__``,
    so it cannot be patched per instance), and the exchange is written at
    ``on_eof``. A streamed response therefore reaches the program as it arrives.
    Replay builds a ``ClientResponse`` over a fed ``StreamReader``, as aioresponses
    does. A websocket upgrade passes through in every mode.
    """
    taps: dict[int, Any] = {}  # id(reader) -> its tap; a tap holds its reader, so the id stays unique

    def make_feed_data(original: Any) -> Any:
        def feed_data(reader: Any, data: Any, *args: Any, **kwargs: Any) -> Any:
            tap = taps.get(id(reader)) if taps else None
            if tap is not None and data:
                tap.add(data)
            return original(reader, data, *args, **kwargs)

        return feed_data

    class ReaderTap:
        def __init__(self, reader: Any, done: Callable[[list[bytes], int], None], keep: bool) -> None:
            self._reader = reader
            self._done = done
            self._keep = keep
            self._chunks: list[bytes] = []
            self._size = 0
            self._written = False
            for chunk in list(getattr(reader, "_buffer", ()) or ()):  # what arrived with the headers
                self.add(chunk)
            session.pending.append(self)
            taps[id(reader)] = self
            reader.on_eof(self.finish)  # called at once when the body is already complete

        def add(self, data: Any) -> None:
            self._size += len(data)
            if self._keep:
                self._chunks.append(bytes(data))

        def finish(self) -> None:
            if not self._written:
                self._written = True
                taps.pop(id(self._reader), None)
                if self in session.pending:
                    session.pending.remove(self)
                self._done(self._chunks, self._size)

    def make_request(original: Any) -> Any:
        async def _request(client: Any, method: str, str_or_url: Any, *args: Any, **kwargs: Any) -> Any:
            if owner.get() or args or _aiohttp_upgrade(kwargs.get("headers")):
                return await original(client, method, str_or_url, *args, **kwargs)
            started = time.perf_counter()
            position = session.position()
            method = str(method).upper()
            url = _aiohttp_url(client, str_or_url, kwargs.get("params"))
            if session.mode == "replay":
                return await _aiohttp_replay(session, mod, client, method, url, _aiohttp_body(client, kwargs), position, kwargs)
            n = session.next_n()
            body = None if session.mode == "off" else _aiohttp_body(client, kwargs)
            token = owner.set(True)
            try:
                resp = await original(client, method, str_or_url, **kwargs)
            finally:
                owner.reset(token)
            decoded = kwargs.get("auto_decompress")
            if decoded is None:
                decoded = getattr(client, "_auto_decompress", True)
            done = _aiohttp_done(session, n, method, url, body, resp, bool(decoded), started, position)
            reader = getattr(resp, "content", None)
            if reader is None or not callable(getattr(reader, "on_eof", None)):
                done([], 0)
            else:
                ReaderTap(reader, done, session.mode != "off")
            return resp

        return _request

    session.patch(mod.StreamReader, "feed_data", make_feed_data)
    session.patch(mod.ClientSession, "_request", make_request)


def _aiohttp_upgrade(headers: Any) -> bool:
    """``ws_connect`` sends ``Upgrade: websocket``; a websocket is no exchange to record."""
    try:
        items = headers.items() if hasattr(headers, "items") else (headers or ())
        return any(str(k).lower() == "upgrade" for k, _ in items)
    except Exception:  # noqa: BLE001
        return False


def _aiohttp_url(client: Any, str_or_url: Any, params: Any) -> str:
    """The request URL as aiohttp builds it: the session's ``base_url`` joined, ``params`` added to the query."""
    build = getattr(client, "_build_url", None)
    url = build(str_or_url) if callable(build) else str_or_url
    if params:
        try:
            url = url.extend_query(params)
        except Exception:  # noqa: BLE001
            pass
    return str(url)


def _aiohttp_body(client: Any, kwargs: dict) -> bytes | None:
    """The request body for the key: ``json=`` serialised, ``data=`` bytes, text or a form; None for a stream or multipart."""
    if kwargs.get("json") is not None:
        dumps = getattr(client, "_json_serialize", None) or json.dumps
        out = dumps(kwargs["json"])
        return out.encode("utf-8") if isinstance(out, str) else bytes(out)
    data = kwargs.get("data")
    if data is None:
        return None
    if isinstance(data, str):
        return data.encode("utf-8")
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if isinstance(data, dict) or (isinstance(data, (list, tuple)) and all(isinstance(p, tuple) and len(p) == 2 for p in data)):
        return urlencode(data, doseq=True).encode("utf-8")
    value = getattr(data, "_value", None)  # aiohttp's BytesPayload / StringPayload
    return bytes(value) if isinstance(value, (bytes, bytearray)) else None


def _aiohttp_done(session: Any, n: int, method: str, url: str, body: bytes | None, resp: Any, decoded: bool, started: float, position: tuple[int, int]) -> Callable[[list[bytes], int], None]:
    """The exchange writer a reader tap calls at end of body (off: the row only)."""
    rid, step = position

    def done(chunks: list[bytes], size: int) -> None:
        status = int(resp.status)
        reason = store.reason_phrase(status, resp.reason)
        if session.mode == "off":
            session.observe(n, "aiohttp", method, url, status, reason, started, size=size, rid=rid, step=step)
            return
        headers, plain = store.prepare_response(resp.headers.items(), chunks, decoded=decoded)
        sent = getattr(getattr(resp, "request_info", None), "headers", None)
        session.write(
            n,
            store.request_key(method, url, body),
            "aiohttp",
            store.request_entry(method, url, sent.items() if sent is not None else (), body),
            store.response_entry(status, reason, headers, plain),
            started,
            size=size,
            rid=rid,
            step=step,
        )

    return done


async def _aiohttp_replay(session: Any, mod: Any, client: Any, method: str, url: str, body: bytes | None, position: tuple[int, int], kwargs: dict) -> Any:
    """A ``ClientResponse`` built from the recording, its ``content`` a ``StreamReader`` fed the recorded chunks."""
    entry = session.lookup(store.request_key(method, url, body), method, url, client="aiohttp", rid=position[0], step=position[1])["response"]
    status = int(entry.get("status") or 0)
    loop = asyncio.get_running_loop()
    multidict = importlib.import_module("multidict")
    yarl = importlib.import_module("yarl")
    proto = importlib.import_module(mod.__name__ + ".client_proto")
    helpers = importlib.import_module(mod.__name__ + ".helpers")
    reader = mod.StreamReader(proto.ResponseHandler(loop=loop), 2**16, loop=loop)
    for chunk in store.entry_chunks(entry):
        if chunk:
            reader.feed_data(chunk)
    reader.feed_eof()
    target = yarl.URL(url)
    sent = multidict.CIMultiDictProxy(multidict.CIMultiDict(kwargs.get("headers") or {}))
    accepted = inspect.signature(mod.ClientResponse.__init__).parameters
    options = {
        "writer": None,
        "continue100": None,
        "timer": helpers.TimerNoop(),
        "request_info": mod.RequestInfo(target, method, sent, target),
        "traces": [],
        "loop": loop,
        "session": client,
        "stream_writer": SimpleNamespace(output_size=0),
    }
    resp = mod.ClientResponse(method, target, **{k: v for k, v in options.items() if k in accepted})
    headers = multidict.CIMultiDict()
    for k, v in (entry.get("headers") or {}).items():
        headers.add(k, v)
    resp.version = getattr(mod, "HttpVersion11", None)
    resp.status = status
    resp.reason = store.reason_phrase(status, entry.get("reason"))
    resp._headers = multidict.CIMultiDictProxy(headers)
    resp._raw_headers = tuple((k.encode("latin-1", "replace"), v.encode("latin-1", "replace")) for k, v in headers.items())
    if hasattr(type(resp), "_raw_cookie_headers"):
        resp._raw_cookie_headers = tuple(headers.getall("set-cookie", ()))
    resp.content = reader
    check = kwargs.get("raise_for_status")
    if check is None:
        check = getattr(client, "_raise_for_status", False)
    if check is True:
        resp.raise_for_status()
    elif callable(check):
        await check(resp)
    return resp
