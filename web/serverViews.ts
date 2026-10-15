/**
 * The bridge's half of the views that need the machine: Narrate (one model call through `claude`,
 * `codex` or PYOKKA_EXPLAIN_COMMAND, as the extension's narrator does) and the tour
 * (`python -m pyokka_runtime tour run.json --json` over the run saved as a `run.json`, the same
 * command an agent runs). Both read the run the bridge keeps (runState.ts) and answer once per run;
 * the page draws the results with the extension's own builders.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWalkthrough } from '../src/session/walkthrough';
import { buildPrompt, collectSources, NarrationError, parseGlosses, resolveBackend, runBackend, type Backend } from '../src/agent/narrate';
import { buildTourPrompt, parseProseAnswer, runTourCli, TourError, tourArgv, violationText, type TourCliOptions } from '../src/agent/tourRun';
import { recordingDoc } from '../src/agent/bridgeRecording';
import { decodeSteps } from '../src/shared/protocol';
import type { TourDoc } from '../src/session/tourTypes';
import { runInputs, workspaceRootOf, type RunData } from './runState';
import type { BridgeNarration, BridgeTour } from './bridgeProtocol';

export interface ViewsOptions {
  distDir: string;
  /** the interpreter that runs `pyokka tour` (also for a JS run: the tour code is Python) */
  python: string;
  /** PYOKKA_EXPLAIN_COMMAND: a command that reads the prompt on stdin */
  explainCommand?: string;
  /** tests replace the model and the tour command */
  ask?: (prompt: string) => Promise<string>;
  tourCli?: typeof runTourCli;
}

/** Where `pyokka_runtime` is: the build's copy, else the checkout's. */
export function runtimeDir(distDir: string): string {
  const candidates = [path.join(distDir, 'python'), path.join(distDir, '..', 'python')];
  return candidates.find((d) => fs.existsSync(path.join(d, 'pyokka_runtime', '__main__.py'))) ?? candidates[0]!;
}

/** The lines of a file of the run: the text it ran for the main file, the disk for the others. */
export function readRunSource(run: RunData, mainPath: string, fileId: number): string[] | undefined {
  const p = run.files.get(fileId)?.path;
  if (!p) return undefined;
  if (p === mainPath) return run.content.split(/\r?\n/);
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

export type ViewMessage = { type: 'narration'; narration: BridgeNarration } | { type: 'tour'; tour: BridgeTour };

export class ServerViews {
  private narration: BridgeNarration | null = null;
  private tour: (BridgeTour & { dir?: string; runFile?: string }) | null = null;

  constructor(
    private readonly opts: ViewsOptions,
    private readonly current: () => { run: RunData | null; mainPath: string },
    private readonly broadcast: (m: ViewMessage) => void,
  ) {}

  private backend(): Backend | undefined {
    return resolveBackend(this.opts.explainCommand);
  }

  canNarrate(): boolean {
    return !!this.opts.ask || !!this.backend();
  }

  private ask(prompt: string): Promise<string> {
    if (this.opts.ask) return this.opts.ask(prompt);
    const backend = this.backend();
    if (!backend) return Promise.reject(new NarrationError('no narration backend', 'install claude or codex, or set PYOKKA_EXPLAIN_COMMAND to a command that reads the prompt on stdin'));
    return runBackend(backend, prompt);
  }

  /** What a page that connects late needs to catch up: this run's narration and tour. */
  replay(runId: string | undefined): ViewMessage[] {
    const out: ViewMessage[] = [];
    if (this.narration && this.narration.runId === runId) out.push({ type: 'narration', narration: this.narration });
    if (this.tour && this.tour.runId === runId) out.push({ type: 'tour', tour: this.publicTour(this.tour) });
    return out;
  }

  /** A new run began: what was computed belongs to the old one. */
  reset(): void {
    if (this.tour?.dir) fs.rm(this.tour.dir, { recursive: true, force: true }, () => undefined);
    this.tour = null;
    this.narration = null;
  }

  dispose(): void {
    this.reset();
  }

  /* ---------- Narrate ---------- */

  async narrate(): Promise<void> {
    const { run, mainPath } = this.current();
    const inputs = runInputs(run, mainPath, (fileId) => (run ? readRunSource(run, mainPath, fileId) : undefined));
    if (!run || !inputs) return this.sendNarration({ runId: run?.runId ?? '', narrating: false, error: 'nothing to narrate yet: run the file first' });
    if (this.narration?.runId === run.runId && (this.narration.narrating || this.narration.glosses)) return this.sendNarration(this.narration);
    const w = buildWalkthrough(inputs);
    if (!w.moments.length) return this.sendNarration({ runId: run.runId, narrating: false, error: 'the run has no moments to narrate' });
    this.sendNarration({ runId: run.runId, narrating: true });
    try {
      const template = fs.readFileSync(path.join(runtimeDir(this.opts.distDir), 'pyokka_runtime', 'agent', 'narrate_prompt.md'), 'utf8');
      const answer = await this.ask(buildPrompt(template, w, collectSources(inputs, w.moments)));
      const glosses = parseGlosses(answer, w.moments.map((m) => m.id));
      if (this.current().run?.runId === run.runId) this.sendNarration({ runId: run.runId, narrating: false, glosses });
    } catch (err) {
      const hint = err instanceof NarrationError && err.hint ? ` (${err.hint})` : '';
      if (this.current().run?.runId === run.runId) this.sendNarration({ runId: run.runId, narrating: false, error: `${err instanceof Error ? err.message : String(err)}${hint}` });
    }
  }

  private sendNarration(n: BridgeNarration): void {
    this.narration = n.runId ? n : this.narration;
    this.broadcast({ type: 'narration', narration: n });
  }

  /* ---------- the tour ---------- */

  private cli(): TourCliOptions {
    return { python: this.opts.python, runtimeDir: runtimeDir(this.opts.distDir) };
  }

  private publicTour(t: BridgeTour & { dir?: string; runFile?: string }): BridgeTour {
    const { dir: _dir, runFile: _runFile, ...rest } = t;
    return rest;
  }

  private sendTour(t: BridgeTour & { dir?: string; runFile?: string }): void {
    this.tour = t;
    this.broadcast({ type: 'tour', tour: this.publicTour(t) });
  }

  /** The tour of the finished run, computed once; later calls resend it. */
  async computeTour(): Promise<TourDoc | undefined> {
    const { run, mainPath } = this.current();
    if (!run || run.running || !run.finished || !run.traceEvent) return undefined;
    if (this.tour?.runId === run.runId) {
      this.sendTour(this.tour);
      return this.tour.doc;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-tour-'));
    const runFile = path.join(dir, 'run.json');
    const entry = { runId: run.runId, status: 'computing' as const, narrating: false, dir, runFile };
    this.sendTour(entry);
    try {
      const t = run.traceEvent;
      const doc = recordingDoc({
        runId: run.runId,
        file: mainPath,
        workspaceRoot: workspaceRootOf(mainPath),
        files: run.files.all(),
        trace: { steps: decodeSteps(t.steps), scopes: t.scopes, truncated: t.truncated },
        entries: run.logs,
        locals: run.locals,
        errors: run.errors,
        coverage: run.coverage,
        http: run.http,
        finished: run.finished,
        readSource: (fileId) => readRunSource(run, mainPath, fileId),
      });
      await fs.promises.writeFile(runFile, JSON.stringify(doc));
      const tour = await (this.opts.tourCli ?? runTourCli)(this.cli(), tourArgv(runFile));
      if (this.tour?.runId !== run.runId) return undefined;
      this.sendTour({ ...entry, status: 'ready', doc: tour });
      return tour;
    } catch (err) {
      const error = err instanceof TourError ? `${err.message}${err.hint ? ` (${err.hint})` : ''}` : err instanceof Error ? err.message : String(err);
      if (this.tour?.runId === run.runId) this.sendTour({ ...entry, status: 'error', error });
      return undefined;
    }
  }

  /** Narrate Tour: one model call, validated and merged by `tour --prose`. */
  async narrateTour(): Promise<void> {
    const doc = await this.computeTour();
    const t = this.tour;
    if (!doc || !t || !t.runFile || !t.dir) return;
    if (doc.pick?.length || t.narrating) return;
    const runId = t.runId;
    this.sendTour({ ...t, narrating: true, narrationError: undefined });
    try {
      const promptFile = [path.join(this.opts.distDir, 'prompts', 'tour-prompt.md'), path.join(this.opts.distDir, '..', 'skills', 'pyokka', 'references', 'tour-prompt.md')].find((f) => fs.existsSync(f));
      if (!promptFile) throw new TourError('the tour prompt is missing', 'rebuild with `node esbuild.mjs`');
      const answer = await this.ask(buildTourPrompt(fs.readFileSync(promptFile, 'utf8'), doc));
      const proseFile = path.join(t.dir, 'prose.json');
      await fs.promises.writeFile(proseFile, JSON.stringify(parseProseAnswer(answer)));
      const merged = await (this.opts.tourCli ?? runTourCli)(this.cli(), tourArgv(t.runFile, { prose: proseFile }));
      if (this.tour?.runId === runId) this.sendTour({ ...this.tour, doc: merged, narrating: false });
    } catch (err) {
      const message = err instanceof TourError ? violationText(err) : err instanceof Error ? err.message : String(err);
      const hint = err instanceof TourError || err instanceof NarrationError ? err.hint : '';
      if (this.tour?.runId === runId) this.sendTour({ ...this.tour, narrating: false, narrationError: `${message}${hint ? ` (${hint})` : ''}` });
    }
  }
}
