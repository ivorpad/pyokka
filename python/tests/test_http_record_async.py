"""HTTP record and replay against a local server: httpx sync and async over real sockets, aiohttp, and an httpx transport over aiohttp (litellm's shape)."""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import time

import aiohttp
import httpx
import pytest

from pyokka_runtime.plugins import http_record
from tests.http_record_support import CHUNKS, RECORD, REPLAY, errors, lines_of, plugin, rows, server  # noqa: F401 - fixtures

SSE = b"".join(CHUNKS)


def entries_of(ctx) -> list[dict]:
    return http_record.load_recording(ctx.path)


def summary(ctx) -> list[tuple]:
    return [(e["n"], e["source"], e["client"], e["method"], e["status"], e["bytes"]) for e in rows(ctx)]


# -- httpx over real sockets ---------------------------------------------------------------------

def test_httpx_sync_client_records_and_replays_a_local_server(plugin, server):
    def drive():
        with httpx.Client() as client:
            a = client.get(server.url + "/json")
            b = client.post(server.url + "/echo", json={"q": 1})
            g = client.get(server.url + "/gzip")
            with client.stream("GET", server.url + "/sse") as s:
                streamed = b"".join(s.iter_bytes())
        return a.json(), b.json(), g.json(), streamed

    http_record.before_each(RECORD)
    recorded = drive()
    http_record.after(RECORD)
    assert recorded == ({"hello": "world"}, {"echo": {"q": 1}}, {"hello": "gzip"}, SSE)
    assert server.hits == 4
    assert summary(plugin) == [(1, "recorded", "httpx", "GET", 200, 18), (2, "recorded", "httpx", "POST", 200, 18), (3, "recorded", "httpx", "GET", 200, len(gzip.compress(b'{"hello": "gzip"}'))), (4, "recorded", "httpx", "GET", 200, len(SSE))]
    stored = entries_of(plugin)
    assert "content-encoding" not in stored[2]["response"]["headers"] and json.loads(stored[2]["response"]["body"]) == {"hello": "gzip"}
    assert "".join(stored[3]["response"]["chunks"] or [stored[3]["response"]["body"]]) == SSE.decode()

    server.stop()  # replay never reaches it
    http_record.before_each(REPLAY)
    assert drive() == recorded
    assert [e["source"] for e in rows(plugin)[4:]] == ["replayed"] * 4
    assert http_record.after(REPLAY)["http"]["served"] == 4


def test_httpx_async_client_records_and_replays_a_local_server(plugin, server):
    async def drive():
        async with httpx.AsyncClient() as client:
            a, b = await asyncio.gather(client.get(server.url + "/json"), client.post(server.url + "/echo", json={"q": 2}))
            async with client.stream("GET", server.url + "/sse") as s:
                streamed = [c async for c in s.aiter_bytes()]
        return a.json(), b.json(), b"".join(streamed)

    http_record.before_each(RECORD)
    recorded = asyncio.run(drive())
    http_record.after(RECORD)
    assert recorded == ({"hello": "world"}, {"echo": {"q": 2}}, SSE)
    assert sorted((e["client"], e["method"], e["source"]) for e in rows(plugin)) == [("httpx", "GET", "recorded"), ("httpx", "GET", "recorded"), ("httpx", "POST", "recorded")]
    assert len(entries_of(plugin)) == 3

    server.stop()
    http_record.before_each(REPLAY)
    assert asyncio.run(drive()) == recorded
    assert [e["source"] for e in rows(plugin)[3:]] == ["replayed"] * 3
    assert http_record.after(REPLAY)["http"]["served"] == 3


# -- aiohttp -----------------------------------------------------------------------------------------

async def aiohttp_drive(url: str, *, timed: bool = False) -> tuple:
    async with aiohttp.ClientSession() as session:
        async with session.get(url + "/json") as r:
            a = (r.status, r.reason, r.headers["content-type"], await r.json())
        async with session.post(url + "/echo", json={"q": 3}) as r:
            b = await r.json()
        r = await session.get(url + "/gzip")
        g = await r.text()
        r.release()
        events = []
        started = time.perf_counter()
        first = None
        async with session.get(url + "/sse") as r:
            async for line in r.content:
                if first is None:
                    first = time.perf_counter() - started
                events.append(line)
        async with session.get(url + "/missing", params={"page": "1"}) as r:
            m = (r.status, await r.text())
    out = (a, b, g, b"".join(events), m)
    return (out, first) if timed else out


def test_aiohttp_records_streams_as_it_arrives_and_replays(plugin, server):
    http_record.before_each(RECORD)
    recorded, first = asyncio.run(aiohttp_drive(server.url, timed=True))
    finished = http_record.after(RECORD)
    assert recorded == ((200, "OK", "application/json", {"hello": "world"}), {"echo": {"q": 3}}, '{"hello": "gzip"}', SSE, (404, "nope"))
    assert first is not None and first < 0.045  # the first event reached the program before the server sent the last one (3 x 20 ms)
    assert finished["http"]["recorded"] == 5 and server.hits == 5
    assert summary(plugin) == [(1, "recorded", "aiohttp", "GET", 200, 18), (2, "recorded", "aiohttp", "POST", 200, 18), (3, "recorded", "aiohttp", "GET", 200, 17), (4, "recorded", "aiohttp", "GET", 200, len(SSE)), (5, "recorded", "aiohttp", "GET", 404, 4)]
    assert rows(plugin)[4]["url"] == server.url + "/missing?page"
    stored = entries_of(plugin)
    assert stored[4]["request"]["url"] == server.url + "/missing?page=1"
    assert json.loads(stored[1]["request"]["body"]) == {"q": 3}
    assert "content-encoding" not in stored[2]["response"]["headers"] and stored[2]["response"]["body"] == '{"hello": "gzip"}'
    sse = stored[3]["response"]
    assert "".join(sse["chunks"] or [sse["body"]]) == SSE.decode()

    server.stop()
    http_record.before_each(REPLAY)
    assert asyncio.run(aiohttp_drive(server.url)) == recorded
    replayed = rows(plugin)[5:]
    assert [(e["n"], e["source"], e["client"], e["status"]) for e in replayed] == [(1, "replayed", "aiohttp", 200), (2, "replayed", "aiohttp", 200), (3, "replayed", "aiohttp", 200), (4, "replayed", "aiohttp", 200), (5, "replayed", "aiohttp", 404)]
    assert http_record.after(REPLAY)["http"]["served"] == 5


def test_aiohttp_replay_miss_and_raise_for_status(plugin, server):
    async def drive(path: str, **kw):
        async with aiohttp.ClientSession(**kw) as session:
            async with session.get(server.url + path) as r:
                return r.status

    http_record.before_each(RECORD)
    assert asyncio.run(drive("/missing")) == 404
    http_record.after(RECORD)
    http_record.before_each(REPLAY)
    with pytest.raises(aiohttp.ClientResponseError):
        asyncio.run(drive("/missing", raise_for_status=True))
    with pytest.raises(ConnectionError, match="no recorded response for GET"):
        asyncio.run(drive("/json"))
    http_record.after(REPLAY)
    assert errors(plugin) == ["no recorded response for GET %s/json; run once in record mode (%s)" % (server.url, plugin.path)]


def test_aiohttp_off_observes_without_writing(plugin, server):
    http_record.before_each({"http": "off"})
    out = asyncio.run(aiohttp_drive(server.url))
    assert out[3] == SSE
    assert http_record.after({"http": "off"})["http"]["requests"] == 5
    assert summary(plugin) == [(1, "live", "aiohttp", "GET", 200, 18), (2, "live", "aiohttp", "POST", 200, 18), (3, "live", "aiohttp", "GET", 200, 17), (4, "live", "aiohttp", "GET", 200, len(SSE)), (5, "live", "aiohttp", "GET", 404, 4)]
    assert not os.path.exists(plugin.path)


# -- an httpx transport over aiohttp (litellm's AiohttpTransport) ---------------------------------

class AiohttpTransport(httpx.AsyncBaseTransport):
    """What litellm installs on its AsyncClient: httpx's API, aiohttp's sockets."""

    def __init__(self) -> None:
        self.session: aiohttp.ClientSession | None = None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self.session is None:
            self.session = aiohttp.ClientSession()
        resp = await self.session.request(request.method, str(request.url), headers=dict(request.headers), data=await request.aread() or None, auto_decompress=False)

        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                async for chunk in resp.content.iter_chunked(1024):
                    yield chunk

            async def aclose(self):
                resp.release()

        return httpx.Response(resp.status, headers=list(resp.headers.items()), stream=Stream())

    async def aclose(self) -> None:
        if self.session is not None:
            await self.session.close()


def test_httpx_over_aiohttp_is_one_row_and_replays_without_the_network(plugin, server):
    async def drive():
        async with httpx.AsyncClient(transport=AiohttpTransport()) as client:
            a = await client.post(server.url + "/echo", json={"model": "m", "messages": ["hi"]})
            async with client.stream("GET", server.url + "/sse") as s:
                events = [line async for line in s.aiter_lines()]
            return a.json(), events

    http_record.before_each(RECORD)
    recorded = asyncio.run(drive())
    http_record.after(RECORD)
    assert recorded == ({"echo": {"model": "m", "messages": ["hi"]}}, ["data: 1", "", "data: 2", "", "data: 3", ""])
    assert summary(plugin) == [(1, "recorded", "httpx", "POST", 200, 44), (2, "recorded", "httpx", "GET", 200, len(SSE))]
    assert [e["client"] for e in entries_of(plugin)] == ["httpx", "httpx"]

    server.stop()
    http_record.before_each(REPLAY)
    assert asyncio.run(drive()) == recorded
    assert [(e["source"], e["client"]) for e in rows(plugin)[2:]] == [("replayed", "httpx"), ("replayed", "httpx")]
    http_record.after(REPLAY)
