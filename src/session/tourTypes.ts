/**
 * `tour.json` as `pyokka tour --json` prints it (docs/TOUR.md), plus the fields the prose merge
 * (`pyokka tour --prose`, 5.2) adds. Types only: the host never computes a tour itself, it runs
 * the Python command and reads this back.
 */

export interface TourValue {
  id: string;
  role: 'in' | 'set' | 'value' | 'printed' | 'call' | 'returned' | 'raised' | 'took' | 'http' | string;
  name: string;
  length: number;
  text?: string;
  cut?: boolean;
  truncated?: boolean;
  evidence?: { from: number; to: number; text: string }[];
  sameAs?: string;
  like?: string;
  from?: number;
  to?: number;
}

export interface TourQuote {
  field: string;
  name?: string;
  from: number;
  to: number;
  text: string;
  length?: number;
  recordingCut?: boolean;
}

export interface TourCandidate {
  id: string;
  key: string;
  step: number;
  chapter: string;
  file: string;
  line: number;
  function: string;
  scopeId: number;
  signals: { signal: string; reason: string }[];
  statement: string;
  score: number;
  setup?: boolean;
  repeat?: number;
  values: TourValue[];
  /** merged prose (picked candidates only) */
  prose?: { title: string; text: string; order?: number; quote?: TourQuote };
}

export interface TourChapter {
  id: string;
  title: string;
  opens: string[];
  kind: 'call' | 'statements' | 'phase' | 'walkthrough' | string;
  steps: [number, number];
  share: number;
  http: number;
  llm: number;
  candidates: number;
  prose?: { title: string; text: string };
}

export interface TourDoc {
  tour: number;
  run: { file: string; steps: number; exitCode: number | null; durationMs: number | null; http: number; llm: number; recording?: unknown };
  goal: { kind: 'output' | 'name' | 'line' | 'end' | string; step: number; text: string; name?: string; line?: number };
  small: boolean;
  budget: { tokens: number; estimate: number; found: number; kept: number; dropped: number };
  chapters: TourChapter[];
  candidates: TourCandidate[];
  timing?: { ms: number; whyCalls: number };
  /* after `tour --prose` */
  intro?: string;
  pick?: string[];
  prose?: { stops: number; chapters: number; warnings: string[] };
}
