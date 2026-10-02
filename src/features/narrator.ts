/**
 * Narration in the host: the walkthrough of a session's last run, and "Narrate" (one batched
 * model call per run, never automatic). Backend order: `pyokka.explain.command`, else `claude -p`,
 * else `codex exec`, else VS Code's language model API (Copilot). Glosses are cached per run;
 * a failure is reported once and the walkthrough keeps `gloss: null`.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { buildWalkthrough, type Walkthrough, type WalkthroughOptions } from '../session/walkthrough';
import { GlossCache, NarrationError, buildPrompt, collectSources, parseGlosses, resolveBackend, runBackend } from '../agent/narrate';
import { walkthroughInputs } from '../agent/bridgeSupport';
import { setting } from '../config/settings';
import { log } from '../util/log';

export const EXPLAIN_COMMAND_SETTING = 'explain.command';

export class Narrator implements vscode.Disposable {
  private readonly cache = new GlossCache();
  private readonly busy = new Set<string>();
  private readonly errors = new Map<string, { runId: string; message: string }>();
  private readonly listeners: ((session: Session) => void)[] = [];
  private lmAvailable: boolean | undefined;

  constructor(
    private readonly manager: SessionManager,
    private readonly runtimeDir: string,
  ) {
    manager.on('sessionStopped', (s) => {
      this.cache.clear(s.key);
      this.errors.delete(s.key);
    });
  }

  dispose(): void {
    this.listeners.length = 0;
  }

  /** Called whenever a session's glosses, narration state or error changed. */
  onChange(listener: (session: Session) => void): void {
    this.listeners.push(listener);
  }

  private changed(session: Session): void {
    for (const l of this.listeners) l(session);
  }

  glosses(session: Session): Record<string, string> | undefined {
    return this.cache.get(session.key, session.state.runId);
  }

  isNarrating(session: Session): boolean {
    return this.busy.has(session.key);
  }

  lastError(session: Session): string | undefined {
    const e = this.errors.get(session.key);
    return e && e.runId === session.state.runId ? e.message : undefined;
  }

  /** The walkthrough of the session's last run with its cached glosses; undefined without a trace. */
  walkthrough(session: Session, opts: WalkthroughOptions = {}): Walkthrough | undefined {
    const inputs = walkthroughInputs(session, this.glosses(session));
    return inputs ? buildWalkthrough(inputs, opts) : undefined;
  }

  /** A backend exists: the setting, claude / codex on the PATH, or Copilot's models. */
  canNarrate(): boolean {
    if (resolveBackend(setting<string>(EXPLAIN_COMMAND_SETTING, ''))) return true;
    if (this.lmAvailable === undefined) {
      this.lmAvailable = false;
      void this.probeLm();
    }
    return this.lmAvailable;
  }

  private async probeLm(): Promise<void> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      this.lmAvailable = models.length > 0;
    } catch {
      this.lmAvailable = false;
    }
  }

  private promptTemplate(): string {
    return fs.readFileSync(path.join(this.runtimeDir, 'pyokka_runtime', 'agent', 'narrate_prompt.md'), 'utf8');
  }

  /** One batched call for the session's last run. Resolves with the glosses, or undefined when it failed (reported once). */
  async narrate(session: Session): Promise<Record<string, string> | undefined> {
    if (this.busy.has(session.key)) return this.glosses(session);
    const runId = session.state.runId;
    const w = this.walkthrough(session);
    if (!w || !w.moments.length) {
      void vscode.window.showInformationMessage('Pyokka: nothing to narrate yet; run the file first.');
      return undefined;
    }
    const cached = this.cache.get(session.key, runId);
    if (cached) return cached;
    const inputs = walkthroughInputs(session)!;
    const prompt = buildPrompt(this.promptTemplate(), w, collectSources(inputs, w.moments));
    const ids = w.moments.map((m) => m.id);
    this.busy.add(session.key);
    this.errors.delete(session.key);
    this.changed(session);
    try {
      const glosses = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Pyokka: narrating ${session.displayName}…` }, async (_progress, token) => {
        const answer = await this.askModel(prompt, token);
        return parseGlosses(answer, ids);
      });
      if (session.isDisposed) return undefined;
      this.cache.set(session.key, runId, glosses);
      log.info(`[${session.displayName}] narrated ${Object.keys(glosses).length} of ${ids.length} moments`);
      return glosses;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = err instanceof NarrationError ? err.hint : 'see the Pyokka output channel';
      this.errors.set(session.key, { runId, message });
      log.warn(`[${session.displayName}] narration failed: ${message} (${hint})`);
      void vscode.window.showWarningMessage(`Pyokka: narration failed: ${message}. ${hint}`, 'Show Logs').then((pick) => pick && log.show());
      return undefined;
    } finally {
      this.busy.delete(session.key);
      this.changed(session);
    }
  }

  /** One model call through the backend chain (the setting, claude, codex, Copilot); Narrate Tour uses it too. */
  async askModel(prompt: string, token: vscode.CancellationToken): Promise<string> {
    const backend = resolveBackend(setting<string>(EXPLAIN_COMMAND_SETTING, ''));
    if (backend) {
      log.info(`narration backend: ${backend.argv.join(' ')}`);
      return runBackend(backend, prompt);
    }
    const models = await Promise.resolve(vscode.lm.selectChatModels({ vendor: 'copilot' })).catch(() => [] as vscode.LanguageModelChat[]);
    const model = models[0];
    if (!model) throw new NarrationError('no narration backend', 'install claude or codex, set pyokka.explain.command to a command that reads the prompt on stdin, or sign in to GitHub Copilot');
    log.info(`narration backend: vscode.lm ${model.vendor}/${model.family}`);
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
    let text = '';
    for await (const chunk of response.text) text += chunk;
    return text;
  }
}
