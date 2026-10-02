/**
 * The TOUR section's model from a `tour.json` (docs/TOUR.md), with or without merged prose. No
 * tour rules here: chapters, candidates and values are what `pyokka tour` printed; this only picks
 * what a row shows (a title, one short value) and resolves display paths to the run's file ids.
 */
import type { PanelTourChapter, PanelTourStop, TourPanel } from '../shared/webviewProtocol';
import type { TourCandidate, TourDoc, TourValue } from './tourTypes';

export const SHORT_VALUE_MAX = 80;
export const STATEMENT_TITLE_MAX = 90;

/** Where a stop was last left for a file: the candidate's id in that run, its key, and which pass of the key it was. */
export interface TourResume {
  runId: string;
  stopId: string;
  key: string;
  /** 0-based: the n-th candidate with this key, in run order */
  pass: number;
  step: number;
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/** The text a value shows: its own text, or what `sameAs` / `like` point at. */
function valueText(v: TourValue, byId: ReadonlyMap<string, TourValue>): string {
  if (v.text !== undefined && !v.like) return v.text;
  if (v.like) return `${v.text ?? ''} (grew from ${byId.get(v.like)?.name ?? v.like}, chars ${v.from ?? 0} to ${v.to ?? 0})`;
  if (v.sameAs) return `same as ${byId.get(v.sameAs)?.name ?? v.sameAs}: ${byId.get(v.sameAs)?.text ?? ''}`;
  return '';
}

/** Which value a folded row shows first: what came back or got bound, before what went in. */
const SHORT_ORDER = ['returned', 'raised', 'call', 'set', 'printed', 'http', 'value', 'took', 'in'];

function shortRank(role: string): number {
  const i = SHORT_ORDER.indexOf(role);
  return i < 0 ? SHORT_ORDER.length : i;
}

/** The one value a folded row shows, `name = text` cut to 80 characters (a branch shows its text alone). */
export function shortValue(c: Pick<TourCandidate, 'values'>, byId: ReadonlyMap<string, TourValue> = new Map()): string | null {
  const v = [...c.values].sort((a, b) => shortRank(a.role) - shortRank(b.role))[0];
  if (!v) return null;
  const text = valueText(v, byId);
  return cut(v.role === 'took' ? text : `${v.name} = ${text}`, SHORT_VALUE_MAX);
}

/** The title before a narration: the strongest signal's group:kind and the statement. */
export function plainTitle(c: Pick<TourCandidate, 'signals' | 'statement'>): string {
  return `${c.signals[0]?.signal ?? 'stop'} · ${cut(c.statement, STATEMENT_TITLE_MAX)}`;
}

/** The candidate a resume record names in this run: same id when the run is the same, else the same pass of the same key. */
export function resumeStop(doc: Pick<TourDoc, 'candidates'>, runId: string, resume: TourResume | undefined): string | null {
  if (!resume) return null;
  if (resume.runId === runId && doc.candidates.some((c) => c.id === resume.stopId)) return resume.stopId;
  const same = doc.candidates.filter((c) => c.key === resume.key);
  const hit = same[resume.pass] ?? same[0];
  return hit ? hit.id : null;
}

/** The resume record of a click on `stopId`. */
export function resumeFor(doc: Pick<TourDoc, 'candidates'>, runId: string, stopId: string): TourResume | undefined {
  const c = doc.candidates.find((x) => x.id === stopId);
  if (!c) return undefined;
  const pass = doc.candidates.filter((x) => x.key === c.key && x.step < c.step).length;
  return { runId, stopId, key: c.key, pass, step: c.step };
}

export interface TourPanelExtras {
  runId: string;
  fileIdOf: (displayPath: string) => number;
  narrating: boolean;
  narrationError?: string;
  canNarrate: boolean;
  resumeStopId: string | null;
  noLocals: boolean;
}

export function buildTourPanel(doc: TourDoc, x: TourPanelExtras): TourPanel {
  const byId = new Map<string, TourValue>();
  for (const c of doc.candidates) for (const v of c.values) byId.set(v.id, v);
  const picked = new Set(doc.pick ?? doc.candidates.filter((c) => c.prose).map((c) => c.id));
  const narrated = picked.size > 0;
  const stops: PanelTourStop[] = doc.candidates.map((c) => ({
    id: c.id,
    key: c.key,
    step: c.step,
    chapter: c.chapter,
    fileId: x.fileIdOf(c.file),
    file: c.file,
    line: c.line,
    function: c.function,
    title: c.prose?.title || plainTitle(c),
    text: c.prose?.text || null,
    signal: c.signals.map((s) => s.signal).join(', '),
    statement: c.statement,
    short: shortValue(c, byId),
    values: c.values.map((v) => ({ role: v.role, name: v.name, text: valueText(v, byId), cut: !!(v.cut || v.truncated) })),
    quote: c.prose?.quote ? { name: c.prose.quote.name ?? c.prose.quote.field, text: c.prose.quote.text } : null,
    picked: picked.has(c.id),
  }));
  const chapters: PanelTourChapter[] = doc.chapters.map((ch, i) => {
    const mine = stops.filter((s) => s.chapter === ch.id);
    return {
      id: ch.id,
      n: i + 1,
      title: ch.prose?.title || ch.title,
      text: ch.prose?.text || null,
      first: ch.steps[0],
      last: ch.steps[1],
      llm: ch.llm,
      http: ch.http,
      stops: mine.length,
      picked: mine.filter((s) => s.picked).length,
    };
  });
  return {
    runId: x.runId,
    status: 'ready',
    steps: doc.run.steps,
    goal: doc.goal ? { step: doc.goal.step, text: doc.goal.text } : null,
    intro: doc.intro || null,
    chapters,
    stops,
    narrated,
    narrating: x.narrating,
    ...(x.narrationError ? { narrationError: x.narrationError } : {}),
    canNarrate: x.canNarrate,
    resumeStopId: x.resumeStopId,
    noLocals: x.noLocals,
  };
}
