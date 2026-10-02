"""The httpx / httpx2 and requests patches of ``http_record``, and the import hook that applies them lazily.

Each patcher takes the session (state, file, replay cursors) and installs its
wrappers through ``session.patch`` so ``after`` can undo them in order. The
runtime is stdlib-only and a program may never import httpx, so ``Finder`` wraps
the loader of a watched module and patches it the moment it has executed (wrapt's
pattern); a module already imported is patched at once by the session. The
aiohttp patch lives in ``_http_aiohttp``.
"""

from __future__ import annotations

import importlib.abc
import importlib.util
import io
import sys
import time
from typing import Any, Callable

from . import _http_fallback as fallback
from . import _http_store as store

WATCHED = ("httpx", "httpx2", "requests.adapters", "aiohttp")


# -- import hook -----------------------------------------------------------------------------------

class Finder(importlib.abc.MetaPathFinder):
    """Patches a watched client the moment its module has executed.

    Other names get None. The lookup we make for a watched name comes back through
    this finder, so a re-entered name gets None too and the other finders (the
    runtime's instrumenting one included) do the actual work.
    """

    def __init__(self, on_module: Callable[[Any], None]) -> None:
        self.on_module = on_module
        self._busy: set[str] = set()

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname not in WATCHED or fullname in self._busy:
            return None
        self._busy.add(fullname)
        try:
            spec = importlib.util.find_spec(fullname)
        except Exception:  # noqa: BLE001
            return None
        finally:
            self._busy.discard(fullname)
        if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
            return None
        spec.loader = _LoaderWrapper(spec.loader, self.on_module)
        return spec


class _LoaderWrapper:
    """The module's own loader, plus a callback once ``exec_module`` has run; everything else is delegated."""

    def __init__(self, loader: Any, callback: Callable[[Any], None]) -> None:
        self._loader = loader
        self._callback = callback

    def create_module(self, spec: Any) -> Any:
        create = getattr(self._loader, "create_module", None)
        return create(spec) if create is not None else None

    def exec_module(self, module: Any) -> None:
        self._loader.exec_module(module)
        self._callback(sys.modules.get(module.__name__, module))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._loader, name)


# -- httpx / httpx2 -----------------------------------------------------------------------------------

def patch_httpx(session: Any, mod: Any) -> None:
    """Every transport a client picks, through ``Client._transport_for_url`` / ``AsyncClient._transport_for_url``.

    The client hands each request to the transport that method returns; we return
    a ``Tap`` around it, so a custom transport (litellm's ``AiohttpTransport``, a
    mount, a proxy) is seen as well as ``HTTPTransport``. An httpx without that
    method gets the two transport classes patched instead.

    Record hands back a fresh Response over a recording stream rather than the
    original one: a transport response built with ``content=`` already holds its
    body, and the client would never iterate (so never let us see) its stream.
    While an async transport runs, ``owner`` is set, so an aiohttp session it
    drives underneath is not counted a second time.
    """
    streams = HttpxStreams(mod, session)

    def handle(send: Callable[[Any], Any], request: Any) -> Any:
        started = time.perf_counter()
        position = session.position()
        if session.mode == "replay":
            return _httpx_replay(session, mod, request, streams, request.read(), position, is_async=False)
        n = session.next_n()
        body = None if session.mode == "off" else request.read()  # off: nothing is keyed, the request stream is left alone
        token = fallback.owner.set(True)
        try:
            response = send(request)
        finally:
            fallback.owner.reset(token)
        stream = streams.record(response.stream, _httpx_done(session, n, request, body, response, started, position))
        return mod.Response(response.status_code, headers=response.headers, stream=stream, extensions=response.extensions, request=request)

    async def handle_async(send: Callable[[Any], Any], request: Any) -> Any:
        started = time.perf_counter()
        position = session.position()
        if session.mode == "replay":
            return _httpx_replay(session, mod, request, streams, await request.aread(), position, is_async=True)
        n = session.next_n()
        body = None if session.mode == "off" else await request.aread()
        token = fallback.owner.set(True)
        try:
            response = await send(request)
        finally:
            fallback.owner.reset(token)
        stream = streams.record_async(response.stream, _httpx_done(session, n, request, body, response, started, position))
        return mod.Response(response.status_code, headers=response.headers, stream=stream, extensions=response.extensions, request=request)

    class Tap:
        """The transport the client picked, with its one request method going through ``handle``; the rest is delegated."""

        __slots__ = ("_inner",)

        def __init__(self, inner: Any) -> None:
            self._inner = inner

        def handle_request(self, request: Any) -> Any:
            return handle(self._inner.handle_request, request)

        async def handle_async_request(self, request: Any) -> Any:
            return await handle_async(self._inner.handle_async_request, request)

        def __getattr__(self, name: str) -> Any:
            return getattr(self._inner, name)

    def make_for_url(original: Any) -> Any:
        def _transport_for_url(client: Any, url: Any) -> Any:
            return Tap(original(client, url))

        return _transport_for_url

    if callable(getattr(mod.Client, "_transport_for_url", None)) and callable(getattr(mod.AsyncClient, "_transport_for_url", None)):
        session.patch(mod.Client, "_transport_for_url", make_for_url)
        session.patch(mod.AsyncClient, "_transport_for_url", make_for_url)
        return

    def make_sync(original: Any) -> Any:
        def handle_request(transport: Any, request: Any) -> Any:
            return handle(lambda r: original(transport, r), request)

        return handle_request

    def make_async(original: Any) -> Any:
        async def handle_async_request(transport: Any, request: Any) -> Any:
            return await handle_async(lambda r: original(transport, r), request)

        return handle_async_request

    session.patch(mod.HTTPTransport, "handle_request", make_sync)
    session.patch(mod.AsyncHTTPTransport, "handle_async_request", make_async)


def _httpx_done(session: Any, n: int, request: Any, body: bytes | None, response: Any, started: float, position: tuple[int, int]) -> Callable[[list[bytes], int], None]:
    """The exchange writer a recording stream calls with the chunks the program consumed and their size (off: the size only)."""
    rid, step = position

    def done(chunks: list[bytes], size: int) -> None:
        url = str(request.url)
        reason = store.reason_phrase(response.status_code, response.extensions.get("reason_phrase"))
        if session.mode == "off":
            session.observe(n, "httpx", request.method, url, response.status_code, reason, started, size=size, rid=rid, step=step)
            return
        headers, plain = store.prepare_response(response.headers.multi_items(), chunks, decoded=False)
        session.write(
            n,
            store.request_key(request.method, url, body),
            "httpx",
            store.request_entry(request.method, url, request.headers.multi_items(), body),
            store.response_entry(response.status_code, reason, headers, plain),
            started,
            size=size,
            rid=rid,
            step=step,
        )

    return done


def _httpx_replay(session: Any, mod: Any, request: Any, streams: HttpxStreams, body: bytes, position: tuple[int, int], *, is_async: bool) -> Any:
    url = str(request.url)
    resp = session.lookup(store.request_key(request.method, url, body), request.method, url, client="httpx", rid=position[0], step=position[1])["response"]
    chunks = store.entry_chunks(resp)
    status = int(resp.get("status") or 0)
    return mod.Response(
        status,
        headers=dict(resp.get("headers") or {}),
        stream=streams.replay_async(chunks) if is_async else streams.replay(chunks),
        request=request,
        extensions={"http_version": b"HTTP/1.1", "reason_phrase": store.reason_phrase(status, resp.get("reason")).encode("ascii", "replace")},
    )


class HttpxStreams:
    """Stream classes bound to one httpx module: the client checks ``isinstance(stream, mod.SyncByteStream)``.

    A recording stream captures chunks as the program consumes them and writes
    the exchange on exhaustion or close, whichever comes first; ``after`` writes
    the ones still open with what they captured (``session.pending``). In mode
    ``off`` the same stream only counts the bytes: byte- and chunk-identical for
    the program, nothing kept.
    """

    def __init__(self, mod: Any, session: Any) -> None:
        sync_base, async_base = mod.SyncByteStream, mod.AsyncByteStream

        class RecordStream(sync_base):  # type: ignore[misc,valid-type]
            def __init__(self, inner: Any, done: Callable[[list[bytes], int], None]) -> None:
                self._inner = inner
                self._done = done
                self._keep = session.mode != "off"
                self._chunks: list[bytes] = []
                self._size = 0
                self._written = False
                session.pending.append(self)

            def __iter__(self) -> Any:
                for chunk in self._inner:
                    self._size += len(chunk)
                    if self._keep:
                        self._chunks.append(chunk)
                    yield chunk
                self.finish()

            def close(self) -> None:
                try:
                    close = getattr(self._inner, "close", None)
                    if close is not None:
                        close()
                finally:
                    self.finish()

            def finish(self) -> None:
                if not self._written:
                    self._written = True
                    if self in session.pending:
                        session.pending.remove(self)
                    self._done(self._chunks, self._size)

        class AsyncRecordStream(async_base):  # type: ignore[misc,valid-type]
            def __init__(self, inner: Any, done: Callable[[list[bytes], int], None]) -> None:
                self._inner = inner
                self._done = done
                self._keep = session.mode != "off"
                self._chunks: list[bytes] = []
                self._size = 0
                self._written = False
                session.pending.append(self)

            async def __aiter__(self) -> Any:
                async for chunk in self._inner:
                    self._size += len(chunk)
                    if self._keep:
                        self._chunks.append(chunk)
                    yield chunk
                self.finish()

            async def aclose(self) -> None:
                try:
                    aclose = getattr(self._inner, "aclose", None)
                    if aclose is not None:
                        await aclose()
                finally:
                    self.finish()

            def finish(self) -> None:
                if not self._written:
                    self._written = True
                    if self in session.pending:
                        session.pending.remove(self)
                    self._done(self._chunks, self._size)

        class ReplayStream(sync_base):  # type: ignore[misc,valid-type]
            def __init__(self, chunks: list[bytes]) -> None:
                self._chunks = chunks

            def __iter__(self) -> Any:
                yield from self._chunks

            def close(self) -> None:
                pass

        class AsyncReplayStream(async_base):  # type: ignore[misc,valid-type]
            def __init__(self, chunks: list[bytes]) -> None:
                self._chunks = chunks

            async def __aiter__(self) -> Any:
                for chunk in self._chunks:
                    yield chunk

            async def aclose(self) -> None:
                pass

        self.record = RecordStream
        self.record_async = AsyncRecordStream
        self.replay = ReplayStream
        self.replay_async = AsyncReplayStream


# -- requests -----------------------------------------------------------------------------------------

def patch_requests(session: Any, mod: Any) -> None:
    """``HTTPAdapter.send``: record through the original (the fallback lets it pass), replay from a built Response.

    Off leaves the response as the adapter made it: the body stays unread (``stream=True``
    keeps streaming) and the size is what the server declared.
    """

    def make(original: Any) -> Any:
        def send(adapter: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            rid, step = session.position()
            url = request.url if isinstance(request.url, str) else bytes(request.url).decode("utf-8")
            if session.mode == "off":
                n = session.next_n()
                with fallback.owned():
                    response = original(adapter, request, *args, **kwargs)
                size = store.declared_length(response.headers.get("content-length"))
                session.observe(n, "requests", request.method, url, int(response.status_code), store.reason_phrase(response.status_code, response.reason), started, size=size, rid=rid, step=step)
                return response
            body = _requests_body(request)
            if session.mode == "replay":
                return _requests_replay(session, mod, adapter, request, url, body, (rid, step))
            n = session.next_n()
            with fallback.owned():
                response = original(adapter, request, *args, **kwargs)
                content = response.content or b""  # requests has undone content-encoding by now
            headers, chunks = store.prepare_response(response.headers.items(), [content] if content else [], decoded=True)
            session.write(
                n,
                store.request_key(request.method, url, body),
                "requests",
                store.request_entry(request.method, url, request.headers.items(), body),
                store.response_entry(int(response.status_code), store.reason_phrase(response.status_code, response.reason), headers, chunks),
                started,
                size=len(content),
                rid=rid,
                step=step,
            )
            return response

        return send

    session.patch(mod.HTTPAdapter, "send", make)


def _requests_replay(session: Any, mod: Any, adapter: Any, request: Any, url: str, body: bytes | None, position: tuple[int, int]) -> Any:
    resp = session.lookup(store.request_key(request.method, url, body), request.method, url, client="requests", rid=position[0], step=position[1])["response"]
    content = b"".join(store.entry_chunks(resp))
    response = mod.Response()
    response.status_code = int(resp.get("status") or 0)
    response.reason = store.reason_phrase(response.status_code, resp.get("reason"))
    response.headers = mod.CaseInsensitiveDict(dict(resp.get("headers") or {}))
    response.encoding = mod.get_encoding_from_headers(response.headers)
    response.raw = io.BytesIO(content)
    response._content = content
    response._content_consumed = True
    response.url = url
    response.request = request
    response.connection = adapter
    return response


def _requests_body(request: Any) -> bytes | None:
    """A prepared request's body as bytes; a file or generator body is read once and put back as bytes."""
    body = request.body
    if body is None:
        return None
    if isinstance(body, str):
        return body.encode("utf-8")
    if isinstance(body, (bytes, bytearray, memoryview)):
        return bytes(body)
    if hasattr(body, "read"):
        data = body.read()
        data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        request.body = data
        return data
    try:
        data = b"".join(c.encode("utf-8") if isinstance(c, str) else bytes(c) for c in body)
    except TypeError:
        return None
    request.body = data
    return data
