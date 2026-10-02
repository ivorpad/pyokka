"""The recording file of ``http_record``: where it lives, how a request is keyed, how bytes and headers are stored.

Bodies are stored *decoded*: ``content-encoding`` is undone here (gzip, deflate;
br and zstd when a decoder imports) so the file is readable and the replayed
response needs no decoder. Decoding happens per network chunk, which is what the
client's own decoder did at record time, so a streamed consumer sees the same
pieces on replay. A body that cannot be decoded is kept as received, header
included.
"""

from __future__ import annotations

import base64
import hashlib
import http
import json
import os
import zlib
from typing import Any

from .. import secrets

# credentials never go to disk; content-length/transfer-encoding describe the wire form, not the stored body
DROP_REQUEST_HEADERS = frozenset({"authorization", "proxy-authorization", "cookie"})
DROP_RESPONSE_HEADERS = frozenset({"set-cookie", "content-length", "transfer-encoding"})


# -- paths ---------------------------------------------------------------------------------------

def recording_dir(workspace_root: str) -> str:
    """``<root>/.pyokka/replay``, or ``<root>/.pyokka-replay`` when ``.pyokka`` is the Quokka-style config *file*."""
    dot = os.path.join(workspace_root, ".pyokka")
    if os.path.isfile(dot):
        return os.path.join(workspace_root, ".pyokka-replay")
    return os.path.join(dot, "replay")


def recording_path(workspace_root: str, file_path: str) -> str:
    """One file per source file, named after its real path: edits keep it, a move starts a new one."""
    digest = hashlib.sha256(os.path.realpath(file_path).encode("utf-8")).hexdigest()[:16]
    return os.path.join(recording_dir(workspace_root), digest + ".jsonl")


def find_recording(workspace_root: str, file_path: str) -> str | None:
    """The workspace root first, then the file's directory and its ancestors.

    ``pyokka run`` records with the file's directory as workspace root; the panel
    records under the project's. Either recording replays in the other.
    """
    roots = [os.path.abspath(workspace_root)]
    d = os.path.dirname(os.path.abspath(file_path))
    while True:
        roots.append(d)
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    seen: set[str] = set()
    for root in roots:
        if root in seen:
            continue
        seen.add(root)
        path = recording_path(root, file_path)
        if os.path.isfile(path):
            return path
    return None


def load_recording(path: str) -> list[dict]:
    """The exchanges of a recording in request order (they land in completion order); header and damaged lines skipped."""
    entries: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and "key" in obj and "n" in obj:
                entries.append(obj)
    entries.sort(key=lambda e: e.get("n", 0))
    return entries


def recording_info(path: str) -> dict:
    """``exists``, the header's ``recorded`` and the number of exchanges of the recording at ``path`` (nulls when it is not on disk)."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return {"exists": False, "recordedAt": None, "entries": None}
    recorded_at = None
    entries = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        if "n" in obj:
            entries += 1
        elif obj.get("pyokka") == "http" and recorded_at is None:
            recorded_at = obj.get("recorded")
    return {"exists": True, "recordedAt": recorded_at, "entries": entries}


def declared_length(value: Any) -> int | None:
    """A ``content-length`` header value as an int: the size of a body nobody read for the program; None when absent or not a number."""
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except ValueError:
        return None


# -- keys ------------------------------------------------------------------------------------------

def request_key(method: str, url: str, body: bytes | None) -> str:
    """sha256 of ``METHOD\\nURL\\n<body>``; headers carry credentials and dates, so they are not part of it."""
    h = hashlib.sha256()
    h.update(("%s\n%s\n" % (method.upper(), url)).encode("utf-8"))
    h.update(normalise_body(body))
    return h.hexdigest()


def normalise_body(body: bytes | bytearray | None) -> bytes:
    """Canonical JSON when it parses, else text with whitespace runs collapsed, else the raw bytes."""
    if not body:
        return b""
    try:
        text = bytes(body).decode("utf-8")
    except UnicodeDecodeError:
        return bytes(body)
    try:
        obj = json.loads(text)
    except ValueError:
        return " ".join(text.split()).encode("utf-8")
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# -- stored fields ---------------------------------------------------------------------------------

def store_bytes(data: bytes | None) -> Any:
    """UTF-8 text (scrubbed), ``{"base64": …}`` for anything else, ``None`` for no body."""
    if not data:
        return None
    try:
        return secrets.current.scrub(bytes(data).decode("utf-8"))
    except UnicodeDecodeError:
        return {"base64": base64.b64encode(bytes(data)).decode("ascii")}


def load_bytes(value: Any) -> bytes:
    if value is None:
        return b""
    if isinstance(value, dict):
        return base64.b64decode(value.get("base64") or "")
    return str(value).encode("utf-8")


def headers(items: Any, drop: frozenset[str]) -> dict[str, str]:
    """Lower-cased names, repeated names joined with commas, credential and secret-named headers dropped.

    The name rule is the "Secrets" one, including the words ``config.secrets.names``
    added, and applies whether or not masking is on: a key never goes to disk.
    """
    extra = getattr(secrets.current, "extra", frozenset())
    out: dict[str, str] = {}
    for name, value in items:
        if isinstance(name, bytes):
            name = name.decode("latin-1")
        if isinstance(value, bytes):
            value = value.decode("latin-1")
        name = str(name).lower()
        if name in drop or secrets.is_secret_name(name, extra):
            continue
        value = str(value)
        out[name] = value if name not in out else out[name] + ", " + value
    return out


def scrubbed(values: dict[str, str]) -> dict[str, str]:
    return {k: secrets.current.scrub(v) for k, v in values.items()}


def request_entry(method: str, url: str, items: Any, body: bytes | None) -> dict:
    return {"method": method, "url": secrets.current.scrub(url), "headers": scrubbed(headers(items, DROP_REQUEST_HEADERS)), "body": store_bytes(body)}


def response_entry(status: int, reason: str, stored_headers: dict[str, str], chunks: list[bytes]) -> dict:
    """``streamed`` means more than one chunk; the chunks are then kept apart and ``body`` is null."""
    streamed = len(chunks) > 1
    return {
        "status": status,
        "reason": reason,
        "headers": scrubbed(stored_headers),
        "body": None if streamed else store_bytes(b"".join(chunks)),
        "streamed": streamed,
        "chunks": [store_bytes(c) for c in chunks] if streamed else None,
    }


def entry_chunks(response: dict) -> list[bytes]:
    if response.get("streamed") and response.get("chunks") is not None:
        return [load_bytes(c) for c in response["chunks"]]
    body = load_bytes(response.get("body"))
    return [body] if body else []


def reason_phrase(status: int, reason: Any) -> str:
    if isinstance(reason, bytes):
        reason = reason.decode("ascii", "replace")
    if reason:
        return str(reason)
    try:
        return http.HTTPStatus(status).phrase
    except ValueError:
        return ""


# -- content decoding ----------------------------------------------------------------------------

class _Deflate:
    """RFC 9110 deflate is zlib-wrapped, but some servers send raw deflate; try the wrapper first, like urllib3."""

    def __init__(self) -> None:
        self._obj = zlib.decompressobj()
        self._first = True

    def decompress(self, data: bytes) -> bytes:
        if not data or not self._first:
            return self._obj.decompress(data)
        self._first = False
        try:
            return self._obj.decompress(data)
        except zlib.error:
            self._obj = zlib.decompressobj(-zlib.MAX_WBITS)
            return self._obj.decompress(data)

    def flush(self) -> bytes:
        return self._obj.flush()


class _Oneshot:
    """``decompress``/``flush`` over a decoder that only offers a feed method (brotli, the stdlib zstd)."""

    def __init__(self, feed: Any) -> None:
        self._feed = feed

    def decompress(self, data: bytes) -> bytes:
        return self._feed(data)

    def flush(self) -> bytes:
        return b""


def decoder(encoding: str) -> Any:
    """An incremental decoder (``decompress``/``flush``) for one ``content-encoding``; None when none is at hand."""
    if encoding in ("gzip", "x-gzip"):
        return zlib.decompressobj(16 + zlib.MAX_WBITS)
    if encoding == "deflate":
        return _Deflate()
    if encoding == "br":
        try:
            import brotli  # type: ignore[import-not-found]
        except ImportError:
            return None
        return _Oneshot(brotli.Decompressor().process)
    if encoding == "zstd":
        try:
            from compression import zstd  # Python 3.14

            return _Oneshot(zstd.ZstdDecompressor().decompress)
        except ImportError:
            pass
        try:
            import zstandard  # type: ignore[import-not-found]
        except ImportError:
            return None
        return zstandard.ZstdDecompressor().decompressobj()
    return None


def decode_chunks(chunks: list[bytes], encoding: str) -> list[bytes] | None:
    """The chunks with ``content-encoding`` undone, one output per input; None when it cannot be done."""
    names = [e.strip().lower() for e in encoding.split(",") if e.strip() and e.strip().lower() != "identity"]
    if not names:
        return chunks
    if len(names) > 1:  # stacked encodings: rare enough to keep as received
        return None
    dec = decoder(names[0])
    if dec is None:
        return None
    try:
        out = [dec.decompress(c) for c in chunks]
        tail = dec.flush()
    except Exception:  # noqa: BLE001 - damaged data or a lying header: keep the body as it came
        return None
    if tail:
        if out:
            out[-1] += tail
        else:
            out.append(tail)
    return [c for c in out if c]


def prepare_response(items: Any, chunks: list[bytes], *, decoded: bool) -> tuple[dict[str, str], list[bytes]]:
    """Stored-form headers and the decoded chunks of a response (``decoded``: the client already undid the encoding)."""
    stored = headers(items, DROP_RESPONSE_HEADERS)
    encoding = stored.get("content-encoding")
    if encoding:
        if decoded:
            del stored["content-encoding"]
        else:
            plain = decode_chunks(chunks, encoding)
            if plain is not None:
                chunks = plain
                del stored["content-encoding"]
    return stored, chunks
