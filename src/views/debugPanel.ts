/**
 * Host side of the debugger in the panel (docs/HANDOFF-debugger.md): the `debug` fields merged into
 * the Time Machine view's state, the locals of the paused frame fetched at each pause, the four
 * toolbar messages (continue, pause, step, stop), and the panel's first view of a recording debug
 * run. Kept out of outputPanel.ts so the panel stays a message router; whyPane.ts is the same pattern.
 */
import * as vscode from 'vscode';
import { setting } from '../config/settings';
import type { Session, SessionEvents } from '../session/session';
import type { LocalVar, PausedInfo } from '../session/debugState';
import { currentStepEntries, initialDebugView } from '../debug/debugViewRule';
import type { DebugPanelInfo, HostToWebview, ViewId, WebviewToHost } from '../shared/webviewProtocol';
import { log } from '../util/log';

export type SessionOn = <K extends keyof SessionEvents>(ev: K, fn: (...args: SessionEvents[K]) => void) => void;
export type DebugMessage = Extract<WebviewToHost, { type: 'debugContinue' | 'debugPause' | 'debugStep' | 'debugStop' }>;

export class DebugPanelHost {
  /** the frontier's locals per session key, valid for the pause step they were fetched at */
  private readonly locals = new Map<string, { step: number; locals: LocalVar[] }>();
  /** the debug run (per session key) whose first pause already brought the panel up */
  private readonly revealed = new Map<string, string | undefined>();

  constructor(
    private readonly post: (session: Session, msg: HostToWebview) => void,
    /** re-sends the Time Machine view's state (outputPanel.pushDebugger) */
    private readonly refresh: (session: Session) => void,
    /** brings the panel up on a view (outputPanel.showView), focus left where it is */
    private readonly show: (view: ViewId) => void,
  ) {}

  /** Subscribe for the bound session; `on` unsubscribes when the panel rebinds. */
  bind(session: Session, on: SessionOn): void {
    on('debugChanged', () => this.refresh(session));
    on('debugPaused', (info) => {
      void this.fetchLocals(session, info);
      this.revealFirstPause(session, info);
    });
    on('debugResumed', () => this.locals.delete(session.key));
  }

  /** The `debug` fields of the view's state; undefined while debug mode is off. */
  fields(session: Session): DebugPanelInfo | undefined {
    const d = session.debug;
    if (!d.active && !d.paused) return undefined;
    const p = d.paused;
    const info: DebugPanelInfo = { active: d.active, paused: !!p, frontier: d.frontier };
    if (!p) return info;
    info.reason = p.reason;
    if (p.kind) info.kind = p.kind;
    info.location = `${session.displayPath(p.fileId)}:${p.line ?? '?'}`;
    // a function breakpoint carries no line of its own until the runtime resolved it
    const bpLine = p.breakpoint?.line ?? p.breakpoint?.resolvedLine;
    if (p.breakpoint && bpLine !== undefined) info.breakpoint = p.breakpoint.condition ? { line: bpLine, condition: p.breakpoint.condition } : { line: bpLine };
    if (p.conditionError) info.conditionError = p.conditionError;
    if (p.exception) info.exception = { ...p.exception };
    if (p.watch) {
      const mode = d.watches.find((w) => w.id === p.watch?.id)?.breakWhen;
      info.watch = mode ? { ...p.watch, breakWhen: mode } : { ...p.watch };
    }
    info.stack = p.stack.map((f, i) => ({ name: f.name, scopeId: f.scopeId ?? f.frameId ?? i, depth: f.depth ?? i }));
    const cached = this.locals.get(session.key);
    if (cached && cached.step === p.step) info.locals = cached.locals;
    return info;
  }

  /** A toolbar or pane message; errors reach the user like a failed command does. */
  async handle(session: Session, msg: DebugMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'debugContinue':
          await session.debugContinue();
          return;
        case 'debugPause':
          await session.debugPause();
          return;
        case 'debugStep':
          await session.debugStep(msg.kind);
          return;
        case 'debugStop':
          session.stopDebug();
          await session.stopRun();
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`panel ${msg.type} failed (${session.displayName})`, err);
      void vscode.window.showErrorMessage(`Pyokka: ${message}`);
    }
  }

  /**
   * The first pause of a recording debug run brings the panel to the Time Machine, the way a plain
   * session's start brings it to the Debugger view (extension.ts, the same `pyokka.showOutputOnStart`
   * switch; debugViewRule.ts is the rule). A recording's values are the entries behind the frontier,
   * so the current step's entries are selected and the Details pane opens on them; a pause with
   * nothing recorded yet (`recordFrom`, before its first step) selects nothing, and the Time Machine
   * view appears once a step is recorded. Once per run: a later pause leaves the panel where the
   * reader put it.
   */
  private revealFirstPause(session: Session, info: PausedInfo): void {
    const runId = session.debug.runId ?? session.state.runId;
    if (this.revealed.get(session.key) === runId) return;
    this.revealed.set(session.key, runId);
    if (!setting<boolean>('showOutputOnStart', true, session.document.uri)) return;
    this.show(initialDebugView({ record: true }));
    const logIds = currentStepEntries(session.state.entries, info.step);
    if (logIds.length) this.post(session, { type: 'entries.select', logIds });
  }

  private async fetchLocals(session: Session, info: PausedInfo): Promise<void> {
    try {
      const locals = await session.debugLocals();
      if (session.debug.paused?.step !== info.step) return; // moved on meanwhile
      this.locals.set(session.key, { step: info.step, locals });
      this.refresh(session);
    } catch (err) {
      log.warn(`locals at the pause unavailable (${session.displayName}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
