/** The rendered HTTP view: rows, footer, the recording hint, the empty states. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { HttpMode, HttpSummary } from '../../../src/shared/protocol';
import type { HttpPanel, HttpTableRow } from '../../../src/shared/webviewProtocol';
import { HttpPane } from '../../../webview/components/HttpPane';

const noop = () => undefined;
const tips = (html: string): string[] => [...html.matchAll(/data-tip="([^"]+)"/g)].map((m) => m[1]!);

const row = (over: Partial<HttpTableRow> = {}): HttpTableRow => ({ n: 1, client: 'httpx', method: 'POST', url: 'https://api.openai.com/v1/responses?key&v=1', name: 'responses', status: 200, reason: 'OK', bytes: 6812, ms: 1834, recordedMs: null, source: 'recorded', step: 88, location: { file: 'agent.py', line: 16, col: 0, fileId: 1 }, ...over });
const summary = (over: Partial<HttpSummary> = {}): HttpSummary => ({ mode: 'record', requests: 3, recorded: 3, served: 0, misses: 0, file: '/w/.pyokka/replay/3f2a.jsonl', exists: true, recordedAt: '2026-09-11T10:12:03Z', entries: 3, ...over });
const zero = { requests: 0, bytes: 0, ms: 0, misses: 0, missAttempts: 0 };
const panel = (over: Partial<HttpPanel> = {}): HttpPanel => ({
  runId: 'r-1',
  running: false,
  count: 3,
  truncated: false,
  totals: { requests: 3, bytes: 68123, ms: 1201, misses: 0, missAttempts: 0 },
  finished: summary(),
  requests: [row(), row({ n: 2, method: 'GET', url: 'https://api.openai.com/v1/models', name: 'models', bytes: 61311, ms: 400, step: 90 }), row({ n: 3, status: 404, reason: 'Not Found', bytes: 0, ms: 30, step: 95 })],
  ...over,
});
const pane = (p: HttpPanel | null, mode: HttpMode = 'off') => render(<HttpPane panel={p} mode={mode} onGoto={noop} onOpen={noop} onMode={noop} onOpenRecording={noop} onClose={noop} />);

describe('HttpPane', () => {
  it('lists every request with its name, method, status, initiator, size, time and source', () => {
    const html = pane(panel(), 'record');
    expect(html).toContain('HTTP <span class="pk-count">3</span>');
    for (const label of ['Name', 'Method', 'Status', 'Initiator', 'Size', 'Time', 'Source']) expect(html).toContain(`>${label}</span>`);
    expect(html).toMatch(/pk-http-n">#1<\/span><span class="pk-http-name">responses<\/span><span class="pk-http-method">POST<\/span><span class="pk-http-status">200<\/span>/);
    expect(html).toContain('>agent.py:16</a>');
    expect(html).toMatch(/pk-http-size">6.8 kB<\/span><span class="pk-http-time">1.8 s<\/span><span class="pk-http-source src-recorded">recorded</);
    expect(html).toContain('title="POST https://api.openai.com/v1/responses?key&amp;v=1 · click: Time Machine to step 88"');
    expect(html).toContain('pk-http-status pk-error-text">404<');
    expect(html).toMatch(/pk-dropdown pk-http-mode">HTTP Record</);
    // the toolbar, then one "Open to the side" per initiator link
    expect(tips(html)).toEqual(['Open recording', 'Close', 'Open to the side', 'Open to the side', 'Open to the side']);
  });
  it('marks a failed status and a miss as errors', () => {
    const html = pane(panel({ requests: [row({ status: 404, reason: 'Not Found' }), row({ n: 2, status: null, reason: null, bytes: null, ms: 3, source: 'miss' })] }));
    expect(html.match(/pk-row pk-http-row error"/g)?.length).toBe(2);
    expect(html).toContain('pk-http-status pk-error-text">404<');
    expect(html).toContain('pk-http-status pk-error-text">MISS<');
    expect(html).toContain('pk-http-size">—<');
    expect(html).toContain('pk-http-source src-miss">miss<');
    expect(pane(panel({ requests: [row(), row({ n: 2 })] }))).not.toContain('pk-http-row error"');
  });
  it('shows the recording time of a replayed row in its title', () => {
    expect(pane(panel({ requests: [row({ source: 'replayed', ms: 2, recordedMs: 1834 })] }))).toContain('title="POST https://api.openai.com/v1/responses?key&amp;v=1 · recorded 1.8 s · click: Time Machine to step 88"');
  });
  it('footers the totals with the recording written, the recording replayed and its misses, or HTTP off', () => {
    expect(pane(panel(), 'record')).toContain('pk-http-summary">3 requests · 68 kB · 1.2 s · recorded to 3f2a.jsonl (2026-09-11 10:12Z)<');
    const replay = panel({ finished: summary({ mode: 'replay', served: 1, misses: 2 }), totals: { requests: 3, bytes: 68123, ms: 1201, misses: 2, missAttempts: 3 } });
    expect(pane(replay, 'replay')).toContain('pk-http-summary">3 requests · 68 kB · 1.2 s · replayed from 3f2a.jsonl (2026-09-11 10:12Z), 2 missing (3 attempts)<');
    expect(pane(panel({ finished: summary({ mode: 'off', exists: false, recordedAt: null, entries: null }) }))).toContain('pk-http-summary">3 requests · 68 kB · 1.2 s · HTTP off<');
  });
  it('offers Replay when the mode is off and a recording exists', () => {
    const html = pane(panel({ finished: summary({ mode: 'off', exists: true, entries: 3 }) }), 'off');
    expect(html).toContain('A recording from 2026-09-11 10:12Z (3 requests) exists · <a href="#" class="pk-link">Replay</a>');
    expect(pane(panel({ finished: summary({ mode: 'off', exists: true, entries: 3 }) }), 'replay')).not.toContain('exists ·');
    expect(pane(panel({ finished: summary({ mode: 'off', exists: false, recordedAt: null, entries: null }) }), 'off')).not.toContain('exists ·');
  });
  it('says when there is no run, when the run is in flight, when it made no request, and when the clients were not observed', () => {
    expect(pane(null)).toContain('No run yet');
    expect(pane(null)).not.toContain('pk-count');
    const running = pane(panel({ running: true, finished: null, requests: [row()], count: 1 }));
    expect(running).toContain('Running…');
    expect(running).toContain('>responses<');
    expect(running).toContain('pk-http-row static"');
    expect(pane(panel({ requests: [], count: 0, totals: zero }))).toContain('No HTTP requests in this run');
    expect(pane(panel({ requests: [], count: 0, totals: zero, finished: null }))).toContain('HTTP clients untouched (pyokka.httpObserve is off)');
    expect(pane(panel({ requests: [], count: 0, totals: zero, finished: null }))).not.toContain('pk-http-footer');
  });
  it('disables Open recording without a file, and rows without a step or statement are static with a dim mark', () => {
    const html = pane(panel({ finished: null, requests: [row({ step: -1, location: null })], count: 1 }));
    expect(html).toMatch(/data-tip="Open recording" disabled/);
    expect(html).toContain('pk-http-row static"');
    expect(html).toContain('pk-http-initiator"><span class="pk-dim">—</span>');
    expect(pane(panel({ requests: [row({ location: null })] }))).toContain('pk-http-initiator"><span class="pk-dim">#88</span>');
    expect(pane(panel())).not.toMatch(/data-tip="Open recording" disabled/);
  });
  it('tells how many rows the cap hid', () => {
    expect(pane(panel({ count: 612, truncated: true }))).toContain('… 609 more requests');
    expect(pane(panel())).not.toContain('more requests');
  });
});
