/**
 * Host side of the panel's TOUR section. Once the section is open, every finished run of the bound
 * session gets its tour from the Python command (`tourRun.ts`): the recording goes to a temporary
 * `run.json`, `pyokka tour RUN --json` answers. A click on a stop is remembered per file in the
 * workspace state (the candidate's `key`, so a re-run finds the same statement) and reopens there.
 * Narrate Tour is one model call through Narrate's backend chain, merged by `tour --prose`.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../session/session';
import type { HostToWebview, TourPanel } from '../shared/webviewProtocol';
import type { Narrator } from '../features/narrator';
import type { TourDoc } from '../session/tourTypes';
import { buildTourPanel, resumeFor, resumeStop, type TourResume } from '../session/tourPanel';
import { buildTourPrompt, parseProseAnswer, runTourCli, TourError, tourArgv, tourTempDir, violationText, type TourArgs } from '../agent/tourRun';
import { NarrationError } from '../agent/narrate';
import { sessionRecording } from '../agent/bridgeSupport';
import { pyokkaHome } from '../util/paths';
import { log } from '../util/log';

export const TOUR_RESUME_KEY = 'pyokka.tour.resume';

interface Entry {
  runId: string;
  dir: string;
  runFile: string;
  args: TourArgs;
  doc?: TourDoc;
  error?: string;
  computing?: Promise<TourDoc | undefined>;
  narrating: boolean;
  narrationError?: string;
}

/** The prompt file: shipped in `dist/prompts` by esbuild, else the checkout's skill reference (a dev host). */
export function tourPromptPath(extensionPath: string): string {
  const shipped = path.join(extensionPath, 'dist', 'prompts', 'tour-prompt.md');
  return fs.existsSync(shipped) ? shipped : path.join(extensionPath, 'skills', 'pyokka', 'references', 'tour-prompt.md');
}

export class TourHost implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  /** the section is open in the panel: compute after every run */
  private wanted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtimeDir: string,
    private readonly narrator: Narrator,
    private readonly post: (session: Session, msg: HostToWebview) => void,
    /** the Python command; a unit test passes a fake */
    private readonly run: typeof runTourCli = runTourCli,
  ) {}

  dispose(): void {
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
  }

  private drop(e: Entry): void {
    fs.rm(e.dir, { recursive: true, force: true }, () => undefined);
  }

  forget(session: Session): void {
    const e = this.entries.get(session.key);
    if (e) this.drop(e);
    this.entries.delete(session.key);
  }

  /** The section opened or closed. Opening computes the tour of the session's finished run. */
  setOpen(session: Session | undefined, open: boolean): void {
    this.wanted = open;
    if (open && session) void this.ensure(session);
  }

  get isOpen(): boolean {
    return this.wanted;
  }

  /** A run started: the old tour no longer matches the code. */
  runStarted(session: Session): void {
    this.post(session, { type: 'tour', tour: null });
  }

  /** A run finished (or the panel re-bound): compute when the section is open, else just resend what is cached. */
  afterRun(session: Session): void {
    if (this.wanted) void this.ensure(session);
    else this.push(session);
  }

  /** The tour of the session's current run (merged prose included once narrated); undefined without one. */
  tour(session: Session): TourDoc | undefined {
    const e = this.entries.get(session.key);
    return e && e.runId === session.state.runId ? e.doc : undefined;
  }

  /** Compute (once per run) and push; resolves with the tour, undefined when there is no run or it failed. */
  async ensure(session: Session): Promise<TourDoc | undefined> {
    if (session.running || !session.state.finished) return undefined;
    const runId = session.state.runId;
    let e = this.entries.get(session.key);
    if (e && e.runId === runId) {
      if (e.computing) return e.computing;
      this.push(session);
      return e.doc;
    }
    if (e) this.drop(e);
    const recording = sessionRecording(session);
    if (!recording) {
      this.entries.delete(session.key);
      this.post(session, { type: 'tour', tour: null });
      return undefined;
    }
    const dir = tourTempDir();
    const runFile = path.join(dir, 'run.json');
    e = { runId, dir, runFile, args: {}, narrating: false };
    this.entries.set(session.key, e);
    const entry = e;
    entry.computing = (async () => {
      const started = Date.now();
      try {
        await fs.promises.writeFile(runFile, JSON.stringify(recording));
        const doc = await this.run(this.cli(session), tourArgv(runFile, entry.args));
        entry.doc = doc;
        log.info(`[${session.displayName}] tour of ${runId}: ${doc.chapters.length} chapters, ${doc.candidates.length} stops in ${Date.now() - started} ms`);
        return doc;
      } catch (err) {
        entry.error = err instanceof TourError ? `${err.message}${err.hint ? ` (${err.hint})` : ''}` : err instanceof Error ? err.message : String(err);
        log.warn(`[${session.displayName}] tour of ${runId} failed: ${entry.error}`);
        return undefined;
      } finally {
        entry.computing = undefined;
        if (this.entries.get(session.key) === entry) this.push(session);
      }
    })();
    this.push(session); // `computing` is set now, so the panel shows it
    return entry.computing;
  }

  private cli(session: Session) {
    return { python: session.interpreter.path, runtimeDir: this.runtimeDir, env: { PYOKKA_HOME: pyokkaHome() } };
  }

  /** The panel model of the session's current run; null before one. */
  panel(session: Session): TourPanel | null {
    const e = this.entries.get(session.key);
    if (!e || e.runId !== session.state.runId) return null;
    // the setting may already be on for the next run; the hint is for a run that recorded nothing and will again
    const noLocals = !session.recordLocals && session.state.locals.length === 0;
    const base = { runId: e.runId, steps: 0, goal: null, intro: null, chapters: [], stops: [], narrated: false, narrating: e.narrating, canNarrate: this.narrator.canNarrate(), resumeStopId: null, noLocals };
    if (e.computing && !e.doc) return { ...base, status: 'computing' };
    if (!e.doc) return { ...base, status: 'error', error: e.error ?? 'no tour' };
    const files = session.state.files.all();
    const fileIdOf = (display: string): number => {
      const f = files.find((x) => session.displayPath(x.fileId) === display) ?? files.find((x) => x.path === display || x.path.endsWith(`/${display}`) || x.path.endsWith(`\\${display.replace(/\//g, '\\')}`));
      return f ? f.fileId : -1;
    };
    return buildTourPanel(e.doc, { runId: e.runId, fileIdOf, narrating: e.narrating, narrationError: e.narrationError, canNarrate: this.narrator.canNarrate(), resumeStopId: resumeStop(e.doc, e.runId, this.resumeOf(session)), noLocals });
  }

  push(session: Session): void {
    this.post(session, { type: 'tour', tour: this.panel(session) });
  }

  private resumeOf(session: Session): TourResume | undefined {
    return this.context.workspaceState.get<Record<string, TourResume>>(TOUR_RESUME_KEY, {})[session.filePath];
  }

  /** The notice's button: record variable changes from now on and run once, an explicit run whatever the run mode. */
  async recordLocalsAndRun(session: Session): Promise<void> {
    session.setRecordLocals(true);
    await session.runNow('tour: record variable changes');
  }

  /** A stop was clicked: remember it for the file (the Time Machine move is the caller's, the `debugger.goto` path). */
  async remember(session: Session, stopId: string): Promise<void> {
    const doc = this.tour(session);
    const r = doc && resumeFor(doc, session.state.runId, stopId);
    if (!r) return;
    const all = { ...this.context.workspaceState.get<Record<string, TourResume>>(TOUR_RESUME_KEY, {}), [session.filePath]: r };
    await this.context.workspaceState.update(TOUR_RESUME_KEY, all);
    this.push(session);
  }

  /** Narrate Tour: one model call for this run, validated and merged by `tour --prose`. Never automatic; cached per run. */
  async narrate(session: Session): Promise<TourDoc | undefined> {
    const doc = await this.ensure(session);
    const e = this.entries.get(session.key);
    if (!doc || !e || e.runId !== session.state.runId) {
      void vscode.window.showInformationMessage('Pyokka: no tour to narrate yet; run the file first.');
      return undefined;
    }
    if (doc.pick?.length || e.narrating) return doc;
    let template: string;
    const promptFile = tourPromptPath(this.context.extensionPath);
    try {
      template = await fs.promises.readFile(promptFile, 'utf8');
    } catch {
      this.fail(session, e, `the tour prompt is missing (${promptFile})`, 'it ships with Pyokka 5.2; rebuild with `node esbuild.mjs`');
      return undefined;
    }
    e.narrating = true;
    e.narrationError = undefined;
    this.push(session);
    try {
      const merged = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Pyokka: narrating the tour of ${session.displayName}…` }, async (_p, token) => {
        const answer = await this.narrator.askModel(buildTourPrompt(template, doc), token);
        const prose = parseProseAnswer(answer);
        const proseFile = path.join(e.dir, 'prose.json');
        await fs.promises.writeFile(proseFile, JSON.stringify(prose));
        return this.run(this.cli(session), tourArgv(e.runFile, { ...e.args, prose: proseFile }));
      });
      if (session.isDisposed || this.entries.get(session.key) !== e) return undefined;
      e.doc = merged;
      log.info(`[${session.displayName}] tour narrated: ${merged.pick?.length ?? 0} stops picked${merged.prose?.warnings.length ? `, ${merged.prose.warnings.length} warnings` : ''}`);
      return merged;
    } catch (err) {
      if (err instanceof TourError) this.fail(session, e, violationText(err), err.hint);
      else if (err instanceof NarrationError) this.fail(session, e, err.message, err.hint);
      else this.fail(session, e, err instanceof Error ? err.message : String(err), 'see the Pyokka output channel');
      return undefined;
    } finally {
      e.narrating = false;
      this.push(session);
    }
  }

  /** A failed narration: kept on the run (the panel shows it) and reported once. */
  private fail(session: Session, e: Entry, message: string, hint: string): void {
    e.narrationError = message;
    log.warn(`[${session.displayName}] tour narration failed: ${message}${hint ? ` (${hint})` : ''}`);
    void vscode.window.showWarningMessage(`Pyokka: Narrate Tour failed: ${message}.${hint ? ` ${hint}` : ''}`, 'Show Logs').then((pick) => pick && log.show());
    this.push(session);
  }

  /** The last narration error of the session's current run. */
  lastError(session: Session): string | undefined {
    const e = this.entries.get(session.key);
    return e && e.runId === session.state.runId ? e.narrationError : undefined;
  }
}
