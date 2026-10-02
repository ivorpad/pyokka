/**
 * The HTTP table builder: names, initiators, totals, the cap, misses, the formatters, and the shared
 * fixture (`fixtures/http-table-run.json` -> `fixtures/http-table.json`, written by the Python side)
 * that pins the host's table to the Python builder's.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileTable } from '../../src/session/fileTable';
import type { FileInstrumentedEvent, HttpExchangeEvent, HttpSummary, RunFinishedEvent } from '../../src/shared/protocol';
import { buildHttpTable, formatBytes, formatRecordedAt, formatSeconds, httpTableSummary, recordingLabel, requestName } from '../../src/session/httpTable';

const FIXTURES = path.join(__dirname, 'fixtures');

const ev = (over: Partial<HttpExchangeEvent> = {}): HttpExchangeEvent => ({ type: 'http.exchange', runId: 'r-1', seq: 1, n: 1, client: 'httpx', method: 'POST', url: 'https://api.openai.com/v1/responses?key&v=1', status: 200, reason: 'OK', bytes: 6812, ms: 1834, source: 'live', rid: 17, step: 88, ...over });
const locate = (rid: number) => (rid === 17 ? { fileId: 1, file: '/abs/agent.py', line: 16, col: 0 } : undefined);
const summary = (over: Partial<HttpSummary> = {}): HttpSummary => ({ mode: 'off', requests: 1, recorded: 0, served: 0, misses: 0, file: '/w/.pyokka/replay/3f2a.jsonl', exists: false, recordedAt: null, entries: null, ...over });

describe('buildHttpTable', () => {
  it('names rows by the last path segment (else the host), locates the initiator and sums the totals', () => {
    const t = buildHttpTable({ runId: 'r-1', running: false, events: [ev(), ev({ n: 2, seq: 2, client: 'requests', method: 'GET', url: 'https://example.com/', bytes: null, ms: 200, rid: -1, step: -1 })], finished: summary({ requests: 2 }), locate });
    expect(t.runId).toBe('r-1');
    expect(t.running).toBe(false);
    expect(t.count).toBe(2);
    expect(t.truncated).toBe(false);
    expect(t.requests[0]).toEqual({ n: 1, client: 'httpx', method: 'POST', url: 'https://api.openai.com/v1/responses?key&v=1', name: 'responses', status: 200, reason: 'OK', bytes: 6812, ms: 1834, recordedMs: null, source: 'live', step: 88, location: { file: '/abs/agent.py', line: 16, col: 0, fileId: 1 } });
    expect(t.requests[1]).toMatchObject({ name: 'example.com', bytes: null, location: null, step: -1 });
    expect(t.totals).toEqual({ requests: 2, bytes: 6812, ms: 2034, misses: 0, missAttempts: 0 });
    expect(t.finished).toEqual(summary({ requests: 2 }));
  });
  it('lists rows in request order: a streamed response completes after a later request', () => {
    const t = buildHttpTable({ runId: 'r-1', running: false, events: [ev({ n: 2, seq: 1 }), ev({ n: 1, seq: 2, ms: 2000.7, bytes: 10.9 })], finished: null, locate });
    expect(t.requests.map((r) => r.n)).toEqual([1, 2]);
    // the totals truncate like the Python builder's int()
    expect(t.totals.ms).toBe(3834);
    expect(t.totals.bytes).toBe(6822);
  });
  it('leaves the initiator null when the statement is not in the run', () => {
    const t = buildHttpTable({ runId: 'r-1', running: false, events: [ev({ rid: 999 })], finished: null, locate });
    expect(t.requests[0]!.location).toBeNull();
    expect(t.requests[0]!.step).toBe(88);
    expect(t.finished).toBeNull();
  });
  it('caps the rows but counts every request', () => {
    const events = Array.from({ length: 502 }, (_, i) => ev({ n: i + 1, seq: i + 1 }));
    const t = buildHttpTable({ runId: 'r-1', running: true, events, finished: null, locate });
    expect(t.requests.length).toBe(500);
    expect(t.count).toBe(502);
    expect(t.truncated).toBe(true);
    expect(t.running).toBe(true);
    expect(t.totals).toEqual({ requests: 502, bytes: 502 * 6812, ms: 502 * 1834, misses: 0, missAttempts: 0 });
    expect(buildHttpTable({ runId: 'r-1', running: false, events, finished: null, locate }, 2).requests.map((r) => r.n)).toEqual([1, 2]);
    expect(buildHttpTable({ runId: 'r-1', running: false, events: events.slice(0, 500), finished: null, locate }).truncated).toBe(false);
  });
  it('lists a miss per attempt, counts distinct misses while in flight and trusts the tally once finished', () => {
    const miss = (n: number, url = 'https://api.openai.com/v1/responses'): HttpExchangeEvent => ev({ n, seq: n, url, status: null, reason: null, bytes: null, ms: 3, source: 'miss' });
    const events = [miss(1), miss(2), miss(3, 'https://api.openai.com/v1/other'), ev({ n: 4, seq: 4, source: 'replayed', recordedMs: 1834, ms: 2 })];
    const live = buildHttpTable({ runId: 'r-1', running: true, events, finished: null, locate });
    expect(live.totals).toEqual({ requests: 4, bytes: 6812, ms: 11, misses: 2, missAttempts: 3 });
    expect(live.requests[0]).toMatchObject({ status: null, reason: null, bytes: null, source: 'miss', name: 'responses' });
    expect(live.requests[3]).toMatchObject({ recordedMs: 1834, ms: 2, source: 'replayed' });
    const done = buildHttpTable({ runId: 'r-1', running: false, events, finished: summary({ mode: 'replay', requests: 4, served: 1, misses: 1 }), locate });
    expect(done.totals.misses).toBe(1);
    expect(done.totals.missAttempts).toBe(3);
  });
});

describe('requestName', () => {
  it('takes the last non-empty path segment, else the host name like urlsplit().hostname, and cuts at 60', () => {
    expect(requestName('https://api.openai.com/v1/responses?key&v=1')).toBe('responses');
    expect(requestName('https://api.openai.com/v1/responses/')).toBe('responses');
    expect(requestName('https://api.openai.com/v1/responses#frag')).toBe('responses');
    expect(requestName('https://example.com')).toBe('example.com');
    expect(requestName('https://Example.COM/?q')).toBe('example.com');
    expect(requestName('http://user:pw@localhost:8765/')).toBe('localhost');
    expect(requestName('http://[::1]:8080/')).toBe('::1');
    expect(requestName('/hello')).toBe('hello');
    expect(requestName('')).toBe('');
    const long = requestName(`https://x.test/${'a'.repeat(70)}`);
    expect(long.length).toBe(60);
    expect(long.endsWith('…')).toBe(true);
    expect(requestName(`https://x.test/${'a'.repeat(60)}`)).toBe('a'.repeat(60));
  });
});

describe('formatters', () => {
  it('formats sizes with one decimal under ten of a unit, rounding like the Python side', () => {
    expect([0, 512, 999, 1000, 6812, 9949, 9950, 68123, 999_499, 999_500, 1_000_000, 1_234_567, 12_345_678, 2_500_000_000].map(formatBytes)).toEqual(['0 B', '512 B', '999 B', '1.0 kB', '6.8 kB', '9.9 kB', '10.0 kB', '68 kB', '999 kB', '1000 kB', '1.0 MB', '1.2 MB', '12 MB', '2.5 GB']);
  });
  it('formats durations like the walkthrough', () => {
    expect([3, 834, 999.6, 1201, 1834, 59_000, 90_000].map(formatSeconds)).toEqual(['3 ms', '834 ms', '1000 ms', '1.2 s', '1.8 s', '59.0 s', '90.0 s']);
  });
  it('shortens the recording timestamp and the recording name', () => {
    expect(formatRecordedAt('2026-09-11T10:12:03Z')).toBe('2026-09-11 10:12Z');
    expect(formatRecordedAt('yesterday')).toBe('yesterday');
    expect(recordingLabel(summary({ file: '/w/.pyokka/replay/3f2a9c1e5b7d0f42.jsonl', recordedAt: '2026-09-11T10:12:03Z' }))).toBe('3f2a….jsonl (2026-09-11 10:12Z)');
    expect(recordingLabel(summary({ file: '/w/.pyokka/replay/3f2a.jsonl' }))).toBe('3f2a.jsonl');
    expect(recordingLabel(summary({ file: null }))).toBe('?');
  });
});

describe('httpTableSummary', () => {
  const table = (finished: HttpSummary | null, totals = { requests: 3, bytes: 68123, ms: 1201, misses: 0, missAttempts: 0 }) => ({ runId: 'r-1', running: false, count: 3, truncated: false, totals, finished, requests: [] });
  it('names the totals and the recording', () => {
    expect(httpTableSummary(table(summary({ mode: 'record', recorded: 3, exists: true, recordedAt: '2026-09-11T10:12:03Z', entries: 3 })))).toBe('3 requests · 68 kB · 1.2 s · recorded to 3f2a.jsonl (2026-09-11 10:12Z)');
    expect(httpTableSummary(table(summary({ mode: 'record', recorded: 0 }), { requests: 0, bytes: 0, ms: 0, misses: 0, missAttempts: 0 }))).toBe('0 requests · 0 B · 0 ms · HTTP record, nothing written');
    expect(httpTableSummary(table(summary({ mode: 'replay', served: 1, misses: 2 }), { requests: 3, bytes: 68123, ms: 1201, misses: 2, missAttempts: 3 }))).toBe('3 requests · 68 kB · 1.2 s · replayed from 3f2a.jsonl, 2 missing (3 attempts)');
    expect(httpTableSummary(table(summary({ mode: 'replay', misses: 1 }), { requests: 1, bytes: 0, ms: 5, misses: 1, missAttempts: 1 }))).toBe('1 request · 0 B · 5 ms · replayed from 3f2a.jsonl, 1 missing (1 attempt)');
    expect(httpTableSummary(table(summary({ mode: 'off' })))).toBe('3 requests · 68 kB · 1.2 s · HTTP off');
    expect(httpTableSummary(table(null))).toBe('3 requests · 68 kB · 1.2 s');
  });
});

/* ---------- the shared fixture ---------- */

interface SavedRun {
  meta?: Record<string, unknown>;
  events: ({ type: string; runId?: string } & Record<string, unknown>)[];
}

describe('http table fixture', () => {
  const runFile = path.join(FIXTURES, 'http-table-run.json');
  const tableFile = path.join(FIXTURES, 'http-table.json');
  const present = fs.existsSync(runFile) && fs.existsSync(tableFile);
  const name = present ? 'produces the table the Python builder wrote' : 'produces the table the Python builder wrote (SKIPPED: fixtures/http-table-run.json or fixtures/http-table.json is missing; the Python side writes both)';
  (present ? it : it.skip)(name, () => {
    const doc = JSON.parse(fs.readFileSync(runFile, 'utf8')) as SavedRun;
    const expected = JSON.parse(fs.readFileSync(tableFile, 'utf8')) as Record<string, unknown>;
    const files = new FileTable();
    const events: HttpExchangeEvent[] = [];
    let finished: RunFinishedEvent | undefined;
    for (const e of doc.events) {
      if (e.type === 'file.instrumented') files.add(e as unknown as FileInstrumentedEvent);
      else if (e.type === 'http.exchange') events.push(e as unknown as HttpExchangeEvent);
      else if (e.type === 'run.finished') finished = e as unknown as RunFinishedEvent;
    }
    const runId = typeof expected['runId'] === 'string' ? expected['runId'] : finished?.runId ?? events[0]?.runId ?? '';
    const table = buildHttpTable({
      runId,
      running: false,
      events,
      finished: finished?.http ?? null,
      locate: (rid) => {
        const l = files.locate(rid);
        return l && { fileId: l.fileId, file: l.path, line: l.range[0], col: l.range[1] };
      },
    });
    expect(JSON.parse(JSON.stringify(table))).toEqual(expected);
  });
});
