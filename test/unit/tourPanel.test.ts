/** The TOUR section's model from a real `pyokka tour --json` (the rrf ablation run), resume across runs, and the CLI's answers. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildTourPanel, plainTitle, resumeFor, resumeStop, shortValue } from '../../src/session/tourPanel';
import { buildTourPrompt, parseProseAnswer, parseTourOutput, TourError, tourArgv, violationText } from '../../src/agent/tourRun';
import type { TourDoc } from '../../src/session/tourTypes';

const doc = (): TourDoc => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tour-rrf.json'), 'utf8')) as TourDoc;
const extras = { runId: 'r-1', fileIdOf: (f: string) => (f === 'rrf.py' ? 0 : -1), narrating: false, canNarrate: true, resumeStopId: null, noLocals: false };

/** What `tour --prose` adds (5.2): intro, pick, prose on the picked candidates and on chapters. */
function merged(): TourDoc {
  const d = doc();
  d.intro = 'Ranks five documents by reciprocal rank fusion.';
  d.pick = ['s53-189112', 's242-9eb311'];
  d.prose = { stops: 2, chapters: 1, warnings: [] };
  d.chapters[3]!.prose = { title: 'Scoring one list', text: 'Each rank becomes a score.' };
  d.candidates.find((c) => c.id === 's53-189112')!.prose = { title: 'The first score', text: 'Rank 1 scores 0.01639344262295082.', order: 1 };
  d.candidates.find((c) => c.id === 's242-9eb311')!.prose = { title: 'The total', text: 'The fused total.', order: 2, quote: { field: 's242-9eb311.v1', name: 'output', from: 0, to: 5, text: 'TOTAL' } };
  return d;
}

describe('buildTourPanel', () => {
  it('keeps the chapters and every candidate of the tour, in run order, with display paths resolved to file ids', () => {
    const p = buildTourPanel(doc(), extras);
    expect(p.chapters.map((c) => [c.id, c.n, c.first, c.last])).toEqual([
      ['c1', 1, 0, 26],
      ['c2', 2, 27, 42],
      ['c3', 3, 43, 52],
      ['c4', 4, 53, 103],
      ['c5', 5, 104, 152],
      ['c6', 6, 153, 242],
    ]);
    expect(p.stops).toHaveLength(35);
    expect(p.stops.map((s) => s.step)).toEqual([...p.stops.map((s) => s.step)].sort((a, b) => a - b));
    expect(p.chapters.reduce((n, c) => n + c.stops, 0)).toBe(35);
    expect(p.stops.every((s) => s.fileId === 0 && s.file === 'rrf.py')).toBe(true);
    expect(p.narrated).toBe(false);
    expect(p.stops.every((s) => !s.picked && s.text === null)).toBe(true);
    expect(p.goal).toEqual({ step: 242, text: '  TOTAL     : 0.016129' });
  });

  it('titles a stop by its strongest signal and statement before a narration, and shows one short value', () => {
    const p = buildTourPanel(doc(), extras);
    const s53 = p.stops.find((s) => s.id === 's53-189112')!;
    expect(s53.title.startsWith(`${doc().candidates.find((c) => c.id === 's53-189112')!.signals[0]!.signal} · contribution = reciprocal_rank(rank, k)`)).toBe(true);
    expect(s53.short).toBe('reciprocal_rank() = 0.01639344262295082');
    const loop = doc().candidates.find((c) => c.id === 's145-8632dd')!;
    expect(shortValue(loop)).toMatch(/^(for document_id in sorted\(all_documents\) ran 5 times|.* = )/);
    expect(plainTitle({ signals: [], statement: 'x = 1' })).toBe('stop · x = 1');
  });

  it('cuts the short value at 80 characters and keeps every value folded under it', () => {
    const p = buildTourPanel(doc(), extras);
    const s2 = p.stops.find((s) => s.id === 's2-372701')!;
    expect(s2.short!.length).toBeLessThanOrEqual(80);
    expect(s2.short!.endsWith('…')).toBe(true);
    expect(s2.values[0]!.text.length).toBeGreaterThan(80);
  });

  it('uses the merged prose: titles, texts, the quote, the picked stops and the chapter title', () => {
    const p = buildTourPanel(merged(), extras);
    expect(p.narrated).toBe(true);
    expect(p.intro).toBe('Ranks five documents by reciprocal rank fusion.');
    expect(p.stops.filter((s) => s.picked).map((s) => s.title)).toEqual(['The first score', 'The total']);
    expect(p.stops.find((s) => s.id === 's242-9eb311')!.quote).toEqual({ name: 'output', text: 'TOTAL' });
    expect(p.chapters[3]).toMatchObject({ title: 'Scoring one list', text: 'Each rank becomes a score.', picked: 1, stops: 11 });
    expect(p.chapters[0]).toMatchObject({ title: 'print_ranking', text: null, picked: 0 });
  });
});

describe('resume', () => {
  it('names the clicked stop by id in the same run', () => {
    const d = doc();
    const r = resumeFor(d, 'r-1', 's73-66ea63')!;
    expect(r).toEqual({ runId: 'r-1', stopId: 's73-66ea63', key: '66ea63', pass: 1, step: 73 });
    expect(resumeStop(d, 'r-1', r)).toBe('s73-66ea63');
  });

  it('finds the same pass of the same statement in a re-run whose steps moved', () => {
    const d = doc();
    const r = resumeFor(d, 'r-1', 's73-66ea63')!;
    const moved = doc();
    for (const c of moved.candidates) {
      c.step += 10;
      c.id = `s${c.step}-${c.key}`;
    }
    expect(resumeStop(moved, 'r-2', r)).toBe('s83-66ea63');
    expect(resumeStop(moved, 'r-2', { ...r, key: 'ffffff' })).toBeNull();
    expect(resumeStop(moved, 'r-2', undefined)).toBeNull();
  });

  it('reaches the panel as resumeStopId', () => {
    expect(buildTourPanel(doc(), { ...extras, resumeStopId: 's88-66ea63' }).resumeStopId).toBe('s88-66ea63');
  });
});

describe('the tour command', () => {
  it('passes goal and budget to the build and to the prose merge alike', () => {
    expect(tourArgv('/t/run.json')).toEqual(['tour', '/t/run.json', '--json']);
    expect(tourArgv('/t/run.json', { goal: 'scores', budget: 20000, prose: '/t/prose.json' })).toEqual(['tour', '/t/run.json', '--goal', 'scores', '--budget', '20000', '--prose', '/t/prose.json', '--json']);
  });

  it('reads the tour, a refusal with its violations, and a runtime without --prose', () => {
    expect(parseTourOutput(0, JSON.stringify(doc()), '').chapters).toHaveLength(6);
    const refusal = JSON.stringify({ ok: false, error: 'the prose has 2 problems', hint: 'fix them', violations: ['c9: unknown chapter id', 's12-abc.text: number 37 is not in the stop\'s values or quote'] });
    let err: unknown;
    try {
      parseTourOutput(2, refusal, '');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TourError);
    expect((err as TourError).violations).toHaveLength(2);
    expect(violationText(err as TourError)).toBe("the prose has 2 problems: c9: unknown chapter id; s12-abc.text: number 37 is not in the stop's values or quote");
    expect(() => parseTourOutput(2, '', 'usage: pyokka ...\npyokka: error: unrecognized arguments: --prose /t/p.json')).toThrow(/cannot merge a narration yet/);
    expect(() => parseTourOutput(1, '', 'Traceback ...\nKeyError: x')).toThrow(/exited with 1: Traceback ... KeyError: x/);
    expect(() => parseTourOutput(0, '{"tour": 1}', '')).toThrow(/not a tour/);
  });

  it('builds the prompt from the prompt file and the compact, redacted tour', () => {
    const d = doc();
    d.candidates[1]!.values[0]!.text = "api_key='sk-abcdefghijklmnopqrstuv'";
    const prompt = buildTourPrompt('# Write a tour\n\nThe tour.json follows.\n', d);
    expect(prompt.startsWith('# Write a tour\n\nThe tour.json follows.\n\n{"tour":1,')).toBe(true);
    expect(prompt).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(prompt).not.toContain('/work/');
    expect(prompt).toContain('"file":"rrf.py"');
    expect(prompt).not.toContain('"timing"');
  });

  it('takes the first JSON object of an answer and refuses one without', () => {
    expect(parseProseAnswer('Here:\n```json\n{"pick": ["s1-a"], "stops": {}}\n```')).toEqual({ pick: ['s1-a'], stops: {} });
    expect(() => parseProseAnswer('no json here')).toThrow(/did not answer with a JSON object/);
  });
});
