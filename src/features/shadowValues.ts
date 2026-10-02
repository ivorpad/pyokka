/**
 * Shadow values: when a line is edited after a run (and the run mode forbids implicit
 * runs), ask the finished run's child what the edited statement would show, using the data
 * it already holds. No code is re-executed; calls are refused by the runtime.
 */
import * as vscode from 'vscode';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import type { Decorator } from '../decorations/decorator';

const DEBOUNCE_MS = 200;
const MAX_LINES = 40;

export class ShadowValues implements vscode.Disposable {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Map<string, () => void>();

  constructor(
    private readonly manager: SessionManager,
    private readonly decorator: Decorator,
  ) {
    manager.on('sessionStarted', (s) => this.attach(s));
    manager.on('sessionStopped', (s) => this.detach(s));
    for (const s of manager.all()) this.attach(s);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const s of this.manager.all()) this.detach(s);
  }

  private attach(session: Session): void {
    const listener = (): void => this.schedule(session);
    this.listeners.set(session.key, listener);
    session.on('stateChanged', listener);
  }

  private detach(session: Session): void {
    const l = this.listeners.get(session.key);
    if (l) session.off('stateChanged', l);
    this.listeners.delete(session.key);
    const t = this.timers.get(session.key);
    if (t) clearTimeout(t);
    this.timers.delete(session.key);
  }

  private schedule(session: Session): void {
    const t = this.timers.get(session.key);
    if (t) clearTimeout(t);
    this.timers.set(
      session.key,
      setTimeout(() => {
        this.timers.delete(session.key);
        void this.refresh(session);
      }, DEBOUNCE_MS),
    );
  }

  async refresh(session: Session): Promise<void> {
    if (session.isDisposed) return;
    if (session.implicitRunsAllowed || session.running || !session.state.finished) {
      if (session.shadowValues.size) {
        session.shadowValues.clear();
        this.decorator.refreshSession(session);
      }
      return;
    }
    const doc = session.document;
    let changed = false;
    for (const line of [...session.shadowValues.keys()]) {
      if (!session.dirtyLines.has(line)) {
        session.shadowValues.delete(line);
        changed = true;
      }
    }
    const lines = [...session.dirtyLines].filter((l) => l >= 1 && l <= doc.lineCount).slice(0, MAX_LINES);
    await Promise.all(
      lines.map(async (line) => {
        const text = doc.lineAt(line - 1).text;
        const trimmed = text.trim();
        const previous = session.shadowValues.get(line);
        if (!trimmed || trimmed.startsWith('#') || trimmed.endsWith(':') || /^(def|class|if|elif|else|for|while|try|except|finally|with|return|import|from|@)\b/.test(trimmed)) {
          if (previous) {
            session.shadowValues.delete(line);
            changed = true;
          }
          return;
        }
        if (previous && previous.context !== undefined && (previous as { source?: string }).source === text) return;
        const ev = await session.shadowLine(line, text);
        if (session.isDisposed || !session.dirtyLines.has(line) || doc.lineAt(line - 1).text !== text) return;
        if (ev) {
          (ev as { source?: string }).source = text;
          session.shadowValues.set(line, ev);
          changed = true;
        } else if (previous) {
          session.shadowValues.delete(line);
          changed = true;
        }
      }),
    );
    if (changed) this.decorator.refreshSession(session);
  }
}
