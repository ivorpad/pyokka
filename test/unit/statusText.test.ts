/** The status bar's HTTP segment and tooltip: the rule table of PROTOCOL.md "HTTP record and replay", Hosts. */
import { describe, expect, it } from 'vitest';
import type { HttpMode, HttpSummary } from '../../src/shared/protocol';
import { debugSegment, httpSegment, httpTooltip } from '../../src/views/statusText';
import { freshDebugState } from '../../src/session/debugState';

const fin = (over: Partial<HttpSummary> = {}): HttpSummary => ({ mode: 'off', requests: 3, recorded: 0, served: 0, misses: 0, file: '/w/.pyokka/replay/3f2a.jsonl', exists: true, recordedAt: '2026-09-11T10:12:03Z', entries: 3, ...over });

describe('httpSegment', () => {
  it('names the mode while it is on, with what the last run did in that mode', () => {
    expect(httpSegment('record', undefined, undefined)).toBe(' · HTTP record');
    expect(httpSegment('record', fin({ mode: 'off' }), undefined)).toBe(' · HTTP record');
    expect(httpSegment('record', fin({ mode: 'record', recorded: 7 }), undefined)).toBe(' · HTTP record, 7 recorded');
    expect(httpSegment('record', fin({ mode: 'record', recorded: 0 }), undefined)).toBe(' · HTTP record, 0 recorded');
    expect(httpSegment('replay', undefined, undefined)).toBe(' · HTTP replay');
    expect(httpSegment('replay', fin({ mode: 'off' }), undefined)).toBe(' · HTTP replay');
    expect(httpSegment('replay', fin({ mode: 'replay', served: 3 }), true)).toBe(' · HTTP replay');
    expect(httpSegment('replay', fin({ mode: 'replay', misses: 2 }), true)).toBe(' · HTTP replay, 2 missing');
  });
  it('says what the last run did when it had the other on-mode', () => {
    expect(httpSegment('record', fin({ mode: 'replay' }), true)).toBe(' · HTTP record · last run replayed');
    expect(httpSegment('replay', fin({ mode: 'record', recorded: 7 }), undefined)).toBe(' · HTTP replay · last run recorded 7');
  });
  it('keeps the last run outcome while the mode is off, and nothing when that run was off too', () => {
    expect(httpSegment('off', undefined, undefined)).toBe('');
    expect(httpSegment('off', fin({ mode: 'off' }), undefined)).toBe('');
    expect(httpSegment('off', fin({ mode: 'replay', served: 3 }), true)).toBe(' · replayed');
    expect(httpSegment('off', fin({ mode: 'replay', misses: 2 }), true)).toBe(' · replayed, 2 missing');
    expect(httpSegment('off', fin({ mode: 'record', recorded: 7 }), undefined)).toBe(' · recorded 7');
    // an older runtime sends only the replayed flag
    expect(httpSegment('off', undefined, true)).toBe(' · replayed');
    expect(httpSegment('replay', undefined, true)).toBe(' · HTTP replay');
  });
  it('never puts "replayed" and "HTTP replay" in one text', () => {
    const modes: HttpMode[] = ['off', 'record', 'replay'];
    const lasts: (HttpSummary | undefined)[] = [undefined, fin({ mode: 'off' }), fin({ mode: 'record', recorded: 2 }), fin({ mode: 'replay' }), fin({ mode: 'replay', misses: 3 })];
    for (const mode of modes) {
      for (const last of lasts) {
        for (const text of [httpSegment(mode, last, last?.mode === 'replay'), httpTooltip(mode, last, last?.mode === 'replay')]) {
          expect(/HTTP replay/i.test(text) && /replayed/.test(text), `${mode} after ${last?.mode ?? 'no run'}: ${text}`).toBe(false);
        }
      }
    }
  });
});

describe('httpTooltip', () => {
  it('explains the next run while the mode is on', () => {
    expect(httpTooltip('record', undefined, undefined)).toBe(' · HTTP Record: the next run writes every HTTP exchange to .pyokka/replay/');
    expect(httpTooltip('record', fin({ mode: 'record', recorded: 7 }), undefined)).toBe(' · HTTP Record: the next run writes every HTTP exchange to 3f2a.jsonl; the last run recorded 7');
    expect(httpTooltip('record', fin({ mode: 'replay' }), true)).toBe(' · HTTP Record: the next run writes every HTTP exchange to 3f2a.jsonl; the last run replayed from it');
    expect(httpTooltip('replay', fin({ mode: 'replay' }), true)).toBe(' · HTTP Replay: the next run answers every request from 3f2a.jsonl; nothing reaches the network');
    expect(httpTooltip('replay', fin({ mode: 'replay', misses: 1 }), true)).toBe(' · HTTP Replay: the next run answers every request from 3f2a.jsonl; nothing reaches the network; 1 request had no recorded response (run once with HTTP Record)');
    expect(httpTooltip('replay', fin({ mode: 'record', recorded: 7 }), undefined)).toBe(' · HTTP Replay: the next run answers every request from 3f2a.jsonl; nothing reaches the network; the last run recorded 7');
  });
  it('explains the last run while the mode is off', () => {
    expect(httpTooltip('off', undefined, undefined)).toBe('');
    expect(httpTooltip('off', fin({ mode: 'off' }), undefined)).toBe('');
    expect(httpTooltip('off', fin({ mode: 'replay', misses: 2 }), true)).toBe(' · HTTP responses replayed from 3f2a.jsonl; no request reached the network; 2 requests had no recorded response (run once with HTTP Record)');
    expect(httpTooltip('off', fin({ mode: 'record', recorded: 7 }), undefined)).toBe(' · HTTP exchanges recorded to 3f2a.jsonl; switch HTTP to Replay in Settings to re-run without the network');
    expect(httpTooltip('off', fin({ mode: 'replay', file: null }), true)).toBe(' · HTTP responses replayed from the recording; no request reached the network');
  });
});

describe('debugSegment', () => {
  const paused = { step: 12, rid: 40, fileId: 1, line: 42 as number | null, scopeId: 0, depth: 0, reason: 'breakpoint' as const, stack: [] };
  it('names the pause with its line and reason, the run while it runs, nothing outside debug mode', () => {
    expect(debugSegment(freshDebugState(), 'demo.py', true)).toBe('');
    expect(debugSegment({ ...freshDebugState(), active: true }, 'demo.py', false)).toBe('');
    expect(debugSegment({ ...freshDebugState(), active: true }, 'demo.py', true)).toBe(' · Debug: running');
    expect(debugSegment({ ...freshDebugState(), active: true, paused, frontier: 12 }, 'demo.py', true)).toBe(' · Debug: paused at demo.py:42 (breakpoint)');
    expect(debugSegment({ ...freshDebugState(), active: true, paused: { ...paused, line: null, reason: 'start' }, frontier: 12 }, 'demo.py', true)).toBe(' · Debug: paused at demo.py (start)');
  });
  it('names the exception a run stopped on instead of the bare reason', () => {
    const exception = { ...paused, line: 6 as number | null, reason: 'exception' as const, exception: { type: 'ValueError', message: 'too big: 3', uncaught: true } };
    expect(debugSegment({ ...freshDebugState(), active: true, paused: exception, frontier: 12 }, 'debug_raise.py', true)).toBe(' · Debug: paused at debug_raise.py:6 (uncaught ValueError: too big: 3)');
    expect(debugSegment({ ...freshDebugState(), active: true, paused: { ...exception, exception: { ...exception.exception, uncaught: false } }, frontier: 12 }, 'debug_raise.py', true)).toBe(' · Debug: paused at debug_raise.py:6 (raised ValueError: too big: 3)');
  });
});
