"""The ``http.client`` fallback of ``http_record``: ``urllib.request``, urllib3 and raw ``http.client``.

``HTTPConnection.send`` hands us the request bytes since ``putrequest``;
``getresponse`` parses them (start line, headers, body de-chunked) and records
or replays. In replay the real ``getresponse`` runs over a fake socket that holds
the recorded message, so http.client's own state machine stays honest and
``connect`` never resolves a name or opens a TCP connection.

Mode ``off`` keeps only the header block of a request (the body is neither keyed
nor stored) and hands the program the network's response object untouched: no
``read()``, no rebuild, the size comes from ``content-length``.

A request a higher hook owns (requests over urllib3 over http.client) passes
through untouched: the hook wraps its call in ``owned()`` and every patch here
checks the thread-local depth first.
"""

from __future__ import annotations

import contextlib
import contextvars
import http.client
import io
import threading
import time
from typing import Any, Iterator

from . import _http_store as store

_local = threading.local()

# Set while an httpx or aiohttp hook is sending: a client it drives underneath (litellm's
# httpx transport over aiohttp) passes through instead of being counted twice. A ContextVar
# rather than a thread-local, because the inner call is awaited in the same task.
owner: contextvars.ContextVar[bool] = contextvars.ContextVar("pyokka_http_owner", default=False)
_HEADER_END = b"\r\n\r\n"


@contextlib.contextmanager
def owned() -> Iterator[None]:
    """While active on this thread, the fallback lets every http.client call through to the originals."""
    _local.depth = getattr(_local, "depth", 0) + 1
    try:
        yield
    finally:
        _local.depth -= 1


def _passthrough(conn: Any) -> bool:
    return getattr(_local, "depth", 0) > 0 or bool(conn.__dict__.get("_pyokka_connecting"))


def patch_http_client(session: Any) -> None:
    """``HTTPConnection.putrequest/send/connect/getresponse`` and ``HTTPSConnection.connect``.

    Subclasses that override these (urllib3) reach the patched base through ``super()``.
    """
    conn_cls = http.client.HTTPConnection

    def make_putrequest(original: Any) -> Any:
        def putrequest(conn: Any, *args: Any, **kwargs: Any) -> Any:
            if not _passthrough(conn):  # a new request: whatever a failed one left behind goes
                conn.__dict__["_pyokka_buf"] = []
                conn.__dict__["_pyokka_started"] = time.perf_counter()
                conn.__dict__["_pyokka_position"] = session.position()  # the user statement, read while its frame is on the stack
                conn.__dict__.pop("_pyokka_headed", None)
            return original(conn, *args, **kwargs)

        return putrequest

    def make_send(original: Any) -> Any:
        def send(conn: Any, data: Any) -> Any:
            if _passthrough(conn):
                return original(conn, data)
            if session.mode == "off" and conn.__dict__.get("_pyokka_headed"):
                return original(conn, data)  # the header block is in; a body is neither keyed nor stored in off mode
            data = _materialise(data)
            conn.__dict__.setdefault("_pyokka_buf", []).append(data)
            if session.mode == "off" and _HEADER_END in data:
                conn.__dict__["_pyokka_headed"] = True
            if session.mode == "replay":
                if conn.sock is None:
                    conn.sock = ReplaySocket()
                return None
            return original(conn, data)

        return send

    def make_connect(original: Any) -> Any:
        def connect(conn: Any) -> Any:
            if session.mode == "replay" and not _passthrough(conn):
                conn.sock = ReplaySocket()  # no DNS, no TCP
                return None
            conn.__dict__["_pyokka_connecting"] = True  # a proxy CONNECT sent from here is not a request
            try:
                return original(conn)
            finally:
                conn.__dict__.pop("_pyokka_connecting", None)

        return connect

    def make_getresponse(original: Any) -> Any:
        def getresponse(conn: Any) -> Any:
            if _passthrough(conn):
                return original(conn)
            raw = b"".join(conn.__dict__.pop("_pyokka_buf", []))
            started = conn.__dict__.pop("_pyokka_started", None) or time.perf_counter()
            position = conn.__dict__.pop("_pyokka_position", None) or session.position()
            conn.__dict__.pop("_pyokka_headed", None)
            if session.mode == "off":
                raw = raw.partition(_HEADER_END)[0] + _HEADER_END  # only the start line and headers matter
            try:
                method, url, items, body = parse_request(raw, conn)
            except Exception:  # noqa: BLE001 - nothing we can name: let the program have the network's answer
                if session.mode == "replay":
                    conn.close()
                    raise ConnectionError("pyokka replay: could not read the request sent on this connection") from None
                return original(conn)
            if session.mode == "replay":
                return _replay(session, conn, original, method, url, body, position)
            if session.mode == "off":
                return _observe(session, conn, original, method, url, started, position)
            return _record(session, conn, original, method, url, items, body, started, position)

        return getresponse

    session.patch(conn_cls, "putrequest", make_putrequest)
    session.patch(conn_cls, "send", make_send)
    session.patch(conn_cls, "connect", make_connect)
    session.patch(conn_cls, "getresponse", make_getresponse)
    https_cls = getattr(http.client, "HTTPSConnection", None)
    if https_cls is not None:
        session.patch(https_cls, "connect", make_connect)


def _record(session: Any, conn: Any, original: Any, method: str, url: str, items: Any, body: bytes, started: float, position: tuple[int, int]) -> Any:
    n = session.next_n()
    response = original(conn)
    data = response.read()  # the whole body; the response closes itself once its length is reached
    headers, chunks = store.prepare_response(response.headers.items(), [data] if data else [], decoded=False)
    reason = store.reason_phrase(response.status, response.reason)
    session.write(n, store.request_key(method, url, body), "http.client", store.request_entry(method, url, items, body), store.response_entry(response.status, reason, headers, chunks), started, size=len(data), rid=position[0], step=position[1])
    # the program reads what the file holds (decoded, no content-encoding): record and replay hand back the same bytes
    return rebuild(conn, response.status, reason, headers, b"".join(chunks))


def _observe(session: Any, conn: Any, original: Any, method: str, url: str, started: float, position: tuple[int, int]) -> Any:
    """Mode ``off``: the network's response object, untouched, and its row."""
    n = session.next_n()
    response = original(conn)
    size = store.declared_length(response.getheader("content-length"))
    session.observe(n, "http.client", method, url, response.status, store.reason_phrase(response.status, response.reason), started, size=size, rid=position[0], step=position[1])
    return response


def _replay(session: Any, conn: Any, original: Any, method: str, url: str, body: bytes, position: tuple[int, int]) -> Any:
    try:
        resp = session.lookup(store.request_key(method, url, body), method, url, client="http.client", rid=position[0], step=position[1])["response"]
    except ConnectionError:
        conn.close()  # what http.client does when a response fails: the connection is usable again
        raise
    status = int(resp.get("status") or 0)
    conn.sock = ReplaySocket(raw_response(status, store.reason_phrase(status, resp.get("reason")), resp.get("headers") or {}, b"".join(store.entry_chunks(resp))))
    return original(conn)


class ReplaySocket:
    """Stands in for ``HTTPConnection.sock`` in replay: nothing is sent, ``makefile`` serves the recorded response."""

    def __init__(self, data: bytes = b"") -> None:
        self.data = data

    def makefile(self, mode: str = "rb", *args: Any, **kwargs: Any) -> io.BytesIO:
        return io.BytesIO(self.data)

    def settimeout(self, value: Any) -> None:
        pass

    def setsockopt(self, *args: Any) -> None:
        pass

    def shutdown(self, how: Any = None) -> None:
        pass

    def close(self) -> None:
        pass


def _materialise(data: Any) -> bytes:
    """What ``HTTPConnection.send`` accepts (bytes-like, a readable, an iterable of bytes) as one bytes object."""
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if hasattr(data, "read"):
        parts = []
        while True:
            block = data.read(8192)
            if not block:
                break
            parts.append(block.encode("iso-8859-1") if isinstance(block, str) else bytes(block))
        return b"".join(parts)
    try:
        return bytes(memoryview(data))
    except TypeError:
        pass
    return b"".join(c.encode("iso-8859-1") if isinstance(c, str) else bytes(c) for c in data)


def dechunk(data: bytes) -> bytes:
    out = []
    buf = io.BytesIO(data)
    while True:
        line = buf.readline()
        if not line:
            break
        size_text = line.split(b";", 1)[0].strip()
        if not size_text:
            continue
        size = int(size_text, 16)
        if size == 0:
            break
        out.append(buf.read(size))
        buf.read(2)  # the CRLF after the chunk data
    return b"".join(out)


def parse_request(raw: bytes, conn: Any) -> tuple[str, str, list[tuple[str, str]], bytes]:
    """Method, URL, headers and body out of the bytes ``send`` collected since ``putrequest``."""
    head, sep, body = raw.partition(_HEADER_END)
    if not sep:
        raise ValueError("no request header block")
    start, _, header_block = head.partition(b"\r\n")
    parts = start.decode("latin-1").split(" ")
    if len(parts) < 2:
        raise ValueError("no request line")
    method, target = parts[0], parts[1]
    msg = http.client.parse_headers(io.BytesIO(header_block + b"\r\n"))
    items = list(msg.items())
    if "chunked" in (msg.get("transfer-encoding") or "").lower():
        body = dechunk(body)
    if target.startswith(("http://", "https://")):  # absolute-form, what a proxy gets
        url = target
    else:
        https_cls = getattr(http.client, "HTTPSConnection", None)
        # urllib3's HTTPSConnection does not subclass http.client's; its default_port tells the scheme
        secure = (https_cls is not None and isinstance(conn, https_cls)) or getattr(conn, "default_port", 80) == 443
        host = msg.get("host")
        if not host:
            host = conn.host if conn.port == conn.default_port else "%s:%s" % (conn.host, conn.port)
        url = "%s://%s%s" % ("https" if secure else "http", host, target)
    return method, url, items, body


def raw_response(status: int, reason: str, headers: dict[str, str], body: bytes) -> bytes:
    """An HTTP/1.1 response message: the stored headers, a Content-Length for the body we hold, nothing chunked."""
    lines = ["HTTP/1.1 %d %s" % (status, reason)]
    for name, value in headers.items():
        if name.lower() in ("content-length", "transfer-encoding"):
            continue
        lines.append("%s: %s" % (name, str(value).replace("\r", " ").replace("\n", " ")))
    lines.append("content-length: %d" % len(body))
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1", "replace") + body


def rebuild(conn: Any, status: int, reason: str, headers: dict[str, str], body: bytes) -> Any:
    """A response the program reads like the network's, over a socket that only holds what we captured."""
    response = conn.response_class(ReplaySocket(raw_response(status, reason, headers, body)), method=conn._method)
    response.begin()
    return response
