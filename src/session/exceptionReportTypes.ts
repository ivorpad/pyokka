/**
 * The exceptions report: every exception a run raised, where it was raised, where it was caught, how
 * often (docs/PROTOCOL.md, "Exceptions report"). Built by `exceptionReport.ts` (host) and
 * `python/pyokka_runtime/agent/exceptions.py` (saved runs) with identical output;
 * `test/unit/fixtures/exceptions.json` pins both over the fixture run `exceptions-run.json`.
 */
import type { WalkthroughInputs } from './walkthroughShared';

export const EXCEPTION_MESSAGE_MAX = 200;

export type ExceptionRowKind = 'uncaught' | 'caught';

/** Where an exception was raised: the statement (`rid`), its first line, the frame's function. */
export interface ExceptionSite {
  file: string | null;
  line: number;
  function: string;
  fileId: number;
  rid: number;
}

/** Where it was caught: the matching `except` clause's line (or the `with` line), the `rid` of the statement that owns it. */
export interface ExceptionHandlerSite extends ExceptionSite {
  /** a bare `except:`, or a clause whose type is `Exception` / `BaseException` (alone or in a tuple) */
  broad: boolean;
}

export interface ExceptionRow {
  /** `x0`, `x1`, … in display order */
  id: string;
  kind: ExceptionRowKind;
  errorType: string;
  /** the first raise's message, ≤ EXCEPTION_MESSAGE_MAX chars */
  message: string;
  /** exception objects this row stands for */
  count: number;
  /** the first raise's step (where a click lands) and the last one's */
  step: number;
  lastStep: number;
  raisedAt: ExceptionSite;
  /** null: uncaught, or caught outside instrumented code (C code, the stdlib, an unstepped library) */
  handledAt: ExceptionHandlerSite | null;
}

export interface ExceptionReport {
  /** steps in the run */
  count: number;
  file: string | null;
  exitCode: number | null;
  stale: boolean;
  staleFiles: string[];
  /** rows */
  total: number;
  /** sum of `count` over the rows */
  raises: number;
  /** rows per kind */
  uncaught: number;
  caught: number;
  /** rows whose handler is broad */
  broad: number;
  rows: ExceptionRow[];
}

/** What the builder reads: the walkthrough's inputs minus what it does not need. */
export type ExceptionReportInputs = Pick<WalkthroughInputs, 'trace' | 'files' | 'errors' | 'mainFile' | 'finished' | 'stale' | 'staleFiles'>;
