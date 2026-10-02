/**
 * View state of the TOUR section, pure so vitest can pin it: which chapter is open (the one the
 * Time Machine is in, else the one of the resumed stop, else the first; a manual toggle holds until
 * the followed chapter changes), which stop is "you are here", which stops a chapter lists, and the
 * message a click sends.
 */
import type { PanelTourChapter, PanelTourStop, TourPanel, WebviewToHost } from './src-shared';

/** The chapter whose step range holds `step`; null when none does. */
export function chapterAt(chapters: readonly PanelTourChapter[], step: number): string | null {
  for (const ch of chapters) if (step >= ch.first && step <= ch.last) return ch.id;
  return null;
}

/** The stops a chapter lists: once narrated, the picked ones unless "all candidates" is unfolded. */
export function chapterStops(tour: Pick<TourPanel, 'stops' | 'narrated'>, chapterId: string, showAll: boolean): PanelTourStop[] {
  return tour.stops.filter((s) => s.chapter === chapterId && (!tour.narrated || showAll || s.picked));
}

/** The stops that can be "you are here": the picked ones once narrated, else every candidate. */
export function hereCandidates(tour: Pick<TourPanel, 'stops' | 'narrated'>): PanelTourStop[] {
  return tour.narrated ? tour.stops.filter((s) => s.picked) : tour.stops;
}

/** Index of the stop nearest `step` (a tie goes to the earlier stop); -1 when there are none. */
export function nearestStopIndex(stops: readonly Pick<PanelTourStop, 'step'>[], step: number): number {
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = Math.abs(stops[i]!.step - step);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

/** "You are here": the stop nearest the Time Machine's step, or the resumed stop while it is inactive. */
export function hereStopId(tour: Pick<TourPanel, 'stops' | 'narrated' | 'resumeStopId'>, step: number | null): string | null {
  if (step === null) return tour.resumeStopId;
  const stops = hereCandidates(tour);
  return stops[nearestStopIndex(stops, step)]?.id ?? null;
}

/** The chapter that opens on its own: the Time Machine's, else the resumed stop's, else the first. */
export function followedChapter(tour: Pick<TourPanel, 'chapters' | 'stops' | 'resumeStopId'>, step: number | null): string | null {
  if (step !== null) {
    const at = chapterAt(tour.chapters, step);
    if (at) return at;
  }
  const resumed = tour.resumeStopId ? tour.stops.find((s) => s.id === tour.resumeStopId) : undefined;
  return resumed?.chapter ?? tour.chapters[0]?.id ?? null;
}

export interface TourFold {
  /** the chapter that is open without a click */
  follow: string | null;
  /** chapters the user opened (true) or closed (false) since `follow` last changed */
  toggled: Record<string, boolean>;
}

export const EMPTY_FOLD: TourFold = { follow: null, toggled: {} };

/** A new followed chapter drops the manual toggles, so only the open chapter is expanded again. */
export function follow(fold: TourFold, chapterId: string | null): TourFold {
  return chapterId === fold.follow ? fold : { follow: chapterId, toggled: {} };
}

export function isChapterOpen(fold: TourFold, chapterId: string): boolean {
  return fold.toggled[chapterId] ?? chapterId === fold.follow;
}

export function toggleChapter(fold: TourFold, chapterId: string): TourFold {
  return { ...fold, toggled: { ...fold.toggled, [chapterId]: !isChapterOpen(fold, chapterId) } };
}

/** What a click on a stop sends: the host remembers the stop and moves the Time Machine (the `debugger.goto` path). */
export function tourGotoMessage(stop: Pick<PanelTourStop, 'id' | 'step'>): WebviewToHost {
  return { type: 'tour.goto', step: stop.step, stopId: stop.id };
}

/** `1,867`: step numbers in the chapter map, as the published tours print them. */
export function fmtStep(n: number): string {
  return n.toLocaleString('en-US');
}

export function stopsLabel(n: number): string {
  return n === 1 ? '1 stop' : `${n} stops`;
}

export function llmLabel(n: number): string {
  return n === 0 ? 'no LLM calls' : n === 1 ? '1 LLM call' : `${n} LLM calls`;
}
