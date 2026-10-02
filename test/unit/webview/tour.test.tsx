/** The TOUR section's view state (fold, you are here, resume) and what it renders and sends. */
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { Tour } from '../../../webview/components/Tour';
import { chapterAt, chapterStops, EMPTY_FOLD, follow, followedChapter, hereStopId, isChapterOpen, nearestStopIndex, toggleChapter, tourGotoMessage } from '../../../webview/tourView';
import { reduce, initialState } from '../../../webview/model';
import { DEFAULT_PREFS } from '../../../webview/vscode';
import type { PanelTourChapter, PanelTourStop, TourPanel } from '../../../src/shared/webviewProtocol';

const noop = () => undefined;

function stop(id: string, step: number, chapter: string, over: Partial<PanelTourStop> = {}): PanelTourStop {
  return { id, key: id.split('-')[1] ?? id, step, chapter, fileId: 0, file: 'app.py', line: step + 1, function: 'main', title: `io:http · call ${id}`, text: null, signal: 'io:http', statement: `call_${id}()`, short: `call_${id}() = ${step}`, values: [{ role: 'call', name: `call_${id}()`, text: String(step), cut: false }], quote: null, picked: false, ...over };
}

function chapter(id: string, n: number, first: number, last: number, stops: number): PanelTourChapter {
  return { id, n, title: `chapter ${n}`, text: null, first, last, llm: n === 2 ? 3 : 0, http: 0, stops, picked: 0 };
}

function tour(over: Partial<TourPanel> = {}): TourPanel {
  return {
    runId: 'r-1',
    status: 'ready',
    steps: 300,
    goal: { step: 299, text: 'done' },
    intro: null,
    chapters: [chapter('c1', 1, 0, 99, 2), chapter('c2', 2, 100, 199, 2), chapter('c3', 3, 200, 299, 1)],
    stops: [stop('s5-aa', 5, 'c1'), stop('s40-bb', 40, 'c1'), stop('s120-cc', 120, 'c2'), stop('s180-dd', 180, 'c2'), stop('s250-ee', 250, 'c3')],
    narrated: false,
    narrating: false,
    canNarrate: true,
    resumeStopId: null,
    noLocals: false,
    ...over,
  };
}

describe('tour view state', () => {
  it('finds the chapter a step is in', () => {
    const t = tour();
    expect(chapterAt(t.chapters, 0)).toBe('c1');
    expect(chapterAt(t.chapters, 150)).toBe('c2');
    expect(chapterAt(t.chapters, 299)).toBe('c3');
    expect(chapterAt(t.chapters, 400)).toBeNull();
  });

  it('marks the stop nearest the Time Machine step as you are here, a tie going to the earlier stop', () => {
    const t = tour();
    expect(nearestStopIndex(t.stops, 22)).toBe(0);
    expect(nearestStopIndex(t.stops, 23)).toBe(1);
    expect(hereStopId(t, 150)).toBe('s120-cc');
    expect(hereStopId(t, 151)).toBe('s180-dd');
    expect(hereStopId(t, 1000)).toBe('s250-ee');
    expect(nearestStopIndex([], 5)).toBe(-1);
  });

  it('once narrated, only a picked stop can be you are here, and a chapter lists the picked ones unless unfolded', () => {
    const t = tour({ narrated: true, stops: tour().stops.map((s) => ({ ...s, picked: s.id === 's40-bb' || s.id === 's250-ee' })) });
    expect(hereStopId(t, 120)).toBe('s40-bb');
    expect(chapterStops(t, 'c1', false).map((s) => s.id)).toEqual(['s40-bb']);
    expect(chapterStops(t, 'c1', true).map((s) => s.id)).toEqual(['s5-aa', 's40-bb']);
    expect(chapterStops(tour(), 'c1', false)).toHaveLength(2);
  });

  it('opens only the chapter the Time Machine is in, else the resumed stop\'s, else the first', () => {
    expect(followedChapter(tour(), 150)).toBe('c2');
    expect(followedChapter(tour({ resumeStopId: 's250-ee' }), null)).toBe('c3');
    expect(followedChapter(tour(), null)).toBe('c1');
    const fold = follow(EMPTY_FOLD, 'c2');
    expect(['c1', 'c2', 'c3'].map((c) => isChapterOpen(fold, c))).toEqual([false, true, false]);
  });

  it('keeps a manual toggle until the followed chapter changes, then folds back to the open one', () => {
    let fold = follow(EMPTY_FOLD, 'c1');
    fold = toggleChapter(fold, 'c3');
    fold = toggleChapter(fold, 'c1');
    expect(['c1', 'c2', 'c3'].map((c) => isChapterOpen(fold, c))).toEqual([false, false, true]);
    expect(follow(fold, 'c1')).toBe(fold);
    fold = follow(fold, 'c2');
    expect(['c1', 'c2', 'c3'].map((c) => isChapterOpen(fold, c))).toEqual([false, true, false]);
  });

  it('a click sends tour.goto with the stop\'s step and id', () => {
    expect(tourGotoMessage(stop('s120-cc', 120, 'c2'))).toEqual({ type: 'tour.goto', step: 120, stopId: 's120-cc' });
  });

  it('the model keeps the host\'s tour and Show Tour expands the section', () => {
    let st = initialState({ ...DEFAULT_PREFS });
    expect(st.prefs.tourOpen).toBe(false);
    st = reduce(st, { type: 'host', message: { type: 'tour', tour: tour() } });
    expect(st.tour?.stops).toHaveLength(5);
    st = reduce(st, { type: 'host', message: { type: 'tour.reveal' } });
    expect(st.prefs.tourOpen).toBe(true);
  });
});

describe('Tour section', () => {
  const html = (props: Partial<Parameters<typeof Tour>[0]> = {}) => render(<Tour model={tour()} currentStep={null} open onToggle={noop} onGoto={noop} onNarrate={noop} onOpen={noop} onRecordLocals={noop} {...props} />);
  const stopsIn = (h: string) => [...h.matchAll(/data-stop="([^"]+)"/g)].map((m) => m[1]);

  it('draws the chapter map with step ranges and LLM calls', () => {
    const h = html();
    expect(h).toContain('steps 100 to 199 · 3 LLM calls');
    expect(h).toContain('steps 0 to 99 · no LLM calls');
    expect((h.match(/data-chapter=/g) ?? []).length).toBe(3);
    expect(h).toContain('no LLM calls · 1 stop<');
  });

  it('expands only the open chapter: the Time Machine\'s, with you are here on the nearest stop', () => {
    const h = html({ currentStep: 175 });
    expect(stopsIn(h)).toEqual(['s120-cc', 's180-dd']);
    expect(h).toMatch(/class="pk-tour-stop here"[^>]*data-stop="s180-dd"/);
    expect(h).toContain('you are here');
  });

  it('reopens at the resumed stop while the Time Machine is inactive', () => {
    const h = html({ model: tour({ resumeStopId: 's250-ee' }) });
    expect(stopsIn(h)).toEqual(['s250-ee']);
    expect(h).toMatch(/class="pk-tour-stop here"[^>]*data-stop="s250-ee"/);
  });

  it('shows a stop\'s title, place and short value, and folds its values', () => {
    const h = html({ currentStep: 5 });
    expect(h).toContain('io:http · call s5-aa');
    expect(h).toContain('app.py:6');
    expect(h).toContain('#5');
    expect(h).toMatch(/<div class="pk-moment-values"><span class="pk-repr">.*call_s5.*<span class="tk-num">5<\/span>/);
    expect(h).toContain('values (1)');
    expect(h).not.toContain('pk-tour-values');
  });

  it('says in one line when the run recorded no variable changes, with the link that records them', () => {
    const h = html({ model: tour({ noLocals: true }) });
    expect(h).toContain('This run recorded no variable changes');
    expect(h).toContain('Record them and run again');
    expect(html()).not.toContain('recorded no variable changes');
  });

  it('says what it is doing while computing, when it failed and when a narration failed', () => {
    expect(html({ model: { ...tour(), status: 'computing', chapters: [], stops: [] } })).toContain('COMPUTING THE TOUR');
    expect(html({ model: { ...tour(), status: 'error', error: 'pyokka tour exited with 1' } })).toContain('No tour: pyokka tour exited with 1');
    expect(html({ model: tour({ narrationError: 'the prose has 1 problems: c9: unknown chapter id' }) })).toContain('Narrate Tour failed: the prose has 1 problems: c9: unknown chapter id');
    expect(html({ model: null })).toContain('NO RUN YET');
    expect(html({ open: false })).not.toContain('pk-tour-map');
  });
});
