/**
 * The HTTP table (docs/PROTOCOL.md, "HTTP record and replay", HTTP table): a run's `http.exchange`
 * rows with their initiators, the totals and `run.finished.http`. Pure and shared by the bridge's
 * `http` reply, the panel's HTTP view and `pyokka http --live`; the Python builder
 * (pyokka_runtime/agent/http.py) produces the same table from a saved run and
 * test/unit/fixtures/http-table*.json pins both. No node imports: the webview bundles the formatters.
 */
import type { HttpExchangeEvent, HttpSummary, HttpTable, HttpTableRow } from '../shared/protocol';

export interface HttpTableInputs {
  runId: string;
  running: boolean;
  events: readonly HttpExchangeEvent[];
  /** `run.finished.http`; null while the run is in flight or when the clients were not observed */
  finished: HttpSummary | null | undefined;
  /** the statement a row's `rid` names (absolute path for the bridge, display path for the panel); undefined when unknown */
  locate: (rid: number) => { fileId: number; file: string; line: number; col: number } | undefined;
}

/** rows listed at most; the totals still count every request */
export const HTTP_TABLE_CAP = 500;
const NAME_LIMIT = 60;

export function buildHttpTable(inputs: HttpTableInputs, cap = HTTP_TABLE_CAP): HttpTable {
  // request order: an httpx row is emitted when its stream is exhausted, so events arrive in completion order
  const events = [...inputs.events].sort((a, b) => a.n - b.n);
  let bytes = 0;
  let ms = 0;
  let missAttempts = 0;
  // the recording's key is not in the row; method + URL is the closest thing while the run is in flight
  const missKeys = new Set<string>();
  for (const ev of events) {
    if (typeof ev.bytes === 'number') bytes += Math.trunc(ev.bytes);
    if (typeof ev.ms === 'number') ms += Math.trunc(ev.ms);
    if (ev.source === 'miss') {
      missAttempts++;
      missKeys.add(`${ev.method} ${ev.url}`);
    }
  }
  const finished = inputs.finished ?? null;
  const count = events.length;
  return {
    runId: inputs.runId,
    running: inputs.running,
    count,
    truncated: count > cap,
    totals: { requests: count, bytes, ms, misses: finished?.misses ?? missKeys.size, missAttempts },
    finished,
    requests: events.slice(0, cap).map((ev) => toRow(ev, inputs.locate)),
  };
}

function toRow(ev: HttpExchangeEvent, locate: HttpTableInputs['locate']): HttpTableRow {
  const loc = ev.rid >= 0 ? locate(ev.rid) : undefined;
  return {
    n: ev.n,
    client: ev.client,
    method: ev.method,
    url: ev.url,
    name: requestName(ev.url),
    status: ev.status ?? null,
    reason: ev.reason ?? null,
    bytes: ev.bytes ?? null,
    ms: ev.ms,
    recordedMs: ev.recordedMs ?? null,
    source: ev.source,
    step: ev.step,
    location: loc ? { file: loc.file, line: loc.line, col: loc.col, fileId: loc.fileId } : null,
  };
}

/** The URL's last non-empty path segment, else its host name (lower-cased, no port or userinfo, like urlsplit().hostname), cut at 60 characters. */
export function requestName(url: string): string {
  const bare = url.split('#')[0]!.split('?')[0]!;
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)(.*)$/.exec(bare);
  const authority = m ? m[1]!.replace(/^[^@]*@/, '') : '';
  const host = (/^\[([^\]]*)\]/.exec(authority)?.[1] ?? authority.split(':')[0]!).toLowerCase();
  const segments = (m ? m[2]! : bare).split('/').filter(Boolean);
  const name = segments.length ? segments[segments.length - 1]! : host || url;
  return name.length <= NAME_LIMIT ? name : name.slice(0, NAME_LIMIT - 1) + '…';
}

/** `512 B`, `6.8 kB`, `68 kB`, `1.2 MB`: one decimal under ten of a unit, none above (the Python side rounds the same way). */
export function formatBytes(n: number): string {
  n = Math.trunc(n);
  if (n < 1000) return `${n} B`;
  const [v, unit] = n < 1e6 ? [n / 1e3, 'kB'] : n < 1e9 ? [n / 1e6, 'MB'] : [n / 1e9, 'GB'];
  return v < 10 ? `${(Math.floor(v * 10 + 0.5) / 10).toFixed(1)} ${unit}` : `${Math.floor(v + 0.5)} ${unit}`;
}

/** `834 ms`, `1.2 s`: the walkthrough's duration format, without node imports. */
export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms + 0.5)} ms`;
  return `${(Math.floor(ms / 100 + 0.5) / 10).toFixed(1)} s`;
}

/** `2026-09-11T10:12:03Z` as the recording's date in text: `2026-09-11 10:12Z`. */
export function formatRecordedAt(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}Z` : iso;
}

export function basename(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}

/** `3f2a….jsonl (2026-09-11 10:12Z)`: the recording's name cut to its first hex digits, and its header's date. */
export function recordingLabel(finished: HttpSummary): string {
  let name = finished.file ? basename(finished.file) : '?';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (stem.length > 8) name = `${stem.slice(0, 4)}…${dot > 0 ? name.slice(dot) : ''}`;
  return finished.recordedAt ? `${name} (${formatRecordedAt(finished.recordedAt)})` : name;
}

/**
 * The table's one-line summary, the text form's header and the HTTP view's footer:
 * `3 requests · 68 kB · 1.2 s · recorded to 3f2a….jsonl (2026-09-11 10:12Z)`, `· replayed from …, 2 missing (3 attempts)`, `· HTTP off`.
 */
export function httpTableSummary(table: HttpTable): string {
  const t = table.totals;
  const parts = [`${t.requests} ${t.requests === 1 ? 'request' : 'requests'}`, formatBytes(t.bytes), formatSeconds(t.ms)];
  const fin = table.finished;
  if (fin?.mode === 'record') parts.push(fin.recorded ? `recorded to ${recordingLabel(fin)}` : 'HTTP record, nothing written');
  else if (fin?.mode === 'replay') {
    const missing = fin.misses > 0 ? `, ${fin.misses} missing (${t.missAttempts} ${t.missAttempts === 1 ? 'attempt' : 'attempts'})` : '';
    parts.push(`replayed from ${recordingLabel(fin)}${missing}`);
  } else if (fin) parts.push('HTTP off');
  return parts.join(' · ');
}
