/**
 * The tour of a session's run, host side (no vscode here). The host writes the session's recording
 * (`recordingDoc`, the bridge's `recording` reply) to a temporary `run.json` and runs
 * `python -m pyokka_runtime tour RUN --json` with the session's interpreter, the same command an
 * agent runs, so the chapters and candidates come from the Python tour code and nowhere else.
 * Narrate Tour's answer goes back through `tour RUN --prose PROSE --json` (5.2), which validates
 * it against the recording and merges it.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redact } from '../util/redact';
import { extractJsonObject, NarrationError } from './narrate';
import type { TourDoc } from '../session/tourTypes';

export const TOUR_TIMEOUT_MS = 120_000;

export class TourError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly violations: string[] = [],
  ) {
    super(message);
  }
}

export interface TourCliOptions {
  python: string;
  /** the directory holding `pyokka_runtime` (the extension's `dist/python`) */
  runtimeDir: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface TourArgs {
  goal?: string;
  budget?: number;
  /** a prose file to validate and merge (`tour --prose`, 5.2) */
  prose?: string;
}

/** The argv after `-m pyokka_runtime`. Goal and budget go to the build and to the merge alike, or the ids would not match. */
export function tourArgv(runFile: string, a: TourArgs = {}): string[] {
  const argv = ['tour', runFile];
  if (a.goal) argv.push('--goal', a.goal);
  if (a.budget) argv.push('--budget', String(a.budget));
  if (a.prose) argv.push('--prose', a.prose);
  argv.push('--json');
  return argv;
}

/** A fresh directory for one session's run file and prose files. */
export function tourTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-tour-'));
}

/** Read the command's answer: the tour on stdout, `{ok: false, error, hint, violations?}` on a refusal. */
export function parseTourOutput(code: number | null, stdout: string, stderr: string): TourDoc {
  if (/unrecognized arguments: --prose/.test(stderr)) {
    throw new TourError('this runtime cannot merge a narration yet', '`pyokka tour --prose` (Pyokka 5.2) validates and merges the answer; update Pyokka');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    const tail = redact((stderr || stdout).trim().split('\n').slice(-3).join(' ')).slice(0, 400);
    throw new TourError(`pyokka tour exited with ${code ?? 'a signal'}${tail ? `: ${tail}` : ''}`, 'see the Pyokka output channel');
  }
  if (doc && typeof doc === 'object' && (doc as { ok?: unknown }).ok === false) {
    const d = doc as { error?: unknown; hint?: unknown; violations?: unknown };
    const violations = Array.isArray(d.violations) ? d.violations.map(String) : [];
    throw new TourError(String(d.error ?? 'pyokka tour failed'), String(d.hint ?? ''), violations);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as TourDoc).chapters) || !Array.isArray((doc as TourDoc).candidates)) {
    throw new TourError('pyokka tour printed something that is not a tour', 'see the Pyokka output channel');
  }
  return doc as TourDoc;
}

/** Run `python -m pyokka_runtime <argv>` in the runtime directory; resolves with the tour. */
export function runTourCli(o: TourCliOptions, argv: string[]): Promise<TourDoc> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.python, ['-m', 'pyokka_runtime', ...argv], {
      cwd: o.runtimeDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(o.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new TourError(`pyokka tour took longer than ${Math.round((o.timeoutMs ?? TOUR_TIMEOUT_MS) / 1000)} s`, 'a run of this size may need `pyokka tour run.json` from a terminal')));
    }, o.timeoutMs ?? TOUR_TIMEOUT_MS);
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (err) => finish(() => reject(new TourError(`${o.python} could not start: ${err.message}`, 'check the Python interpreter (Pyokka: Select Python Interpreter)'))));
    child.on('close', (code) => {
      finish(() => {
        try {
          resolve(parseTourOutput(code, stdout, stderr));
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

/**
 * The Narrate Tour prompt: the prompt file, a blank line, then the compact tour.json (the prompt
 * file says the tour follows). Every string is redacted, the run's absolute path becomes its file
 * name, and the build timing is left out.
 */
export function buildTourPrompt(template: string, tour: TourDoc): string {
  const { timing: _timing, ...rest } = tour;
  const doc = { ...rest, run: { ...rest.run, file: path.basename(rest.run.file ?? '') } };
  return `${template.trimEnd()}\n\n${JSON.stringify(redactDeep(doc))}`;
}

/** The model's answer as the prose object `tour --prose` reads; throws when it holds no JSON object. */
export function parseProseAnswer(answer: string): Record<string, unknown> {
  const doc = extractJsonObject(answer);
  if (!doc) throw new NarrationError('the model did not answer with a JSON object', `the answer started: ${redact(answer.trim().slice(0, 120))}`);
  return doc;
}

/** The reasons of a refused narration, as one line for the panel (the first 6, then a count). */
export function violationText(err: TourError): string {
  if (!err.violations.length) return err.message;
  const shown = err.violations.slice(0, 6).join('; ');
  const more = err.violations.length > 6 ? `; and ${err.violations.length - 6} more` : '';
  return `${err.message}: ${shown}${more}`;
}
