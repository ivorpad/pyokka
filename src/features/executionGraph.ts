/**
 * The execution graph in the host: the graph of a session's last run (docs/PROTOCOL.md,
 * "Execution graph"), cached per run and options, the packages the panel has unrolled, and the
 * call stack of the Time Machine's step as node ids (throttled for the panel). Nothing here
 * talks to the panel; `outputPanel.ts` listens.
 */
import type * as vscode from 'vscode';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { buildExecutionGraph, graphStack, GRAPH_CAP, type ExecutionGraph, type ExecutionGraphOptions } from '../session/executionGraph';
import { walkthroughInputs } from '../agent/bridgeSupport';

/** the call stack reaches the panel at most this often while the Time Machine moves */
export const STACK_THROTTLE_MS = 50;

interface RunCache {
  runId: string;
  graphs: Map<string, ExecutionGraph>;
  expanded: string[];
}

function optionsKey(opts: ExecutionGraphOptions): string {
  return JSON.stringify({ all: !!opts.all, scope: opts.scope ?? null, expand: [...(opts.expand ?? [])].sort(), cap: opts.cap ?? GRAPH_CAP, statements: opts.statements !== false });
}

export class GraphProvider implements vscode.Disposable {
  private readonly runs = new Map<string, RunCache>();
  private readonly changeListeners: ((session: Session) => void)[] = [];
  private readonly stackListeners: ((session: Session) => void)[] = [];
  private readonly stackTimers = new Map<string, NodeJS.Timeout>();
  private readonly detachers = new Map<string, () => void>();
  private readonly onStarted = (s: Session): void => this.attach(s);
  private readonly onStopped = (s: Session): void => this.forget(s);

  constructor(private readonly manager: SessionManager) {
    manager.on('sessionStarted', this.onStarted);
    manager.on('sessionStopped', this.onStopped);
    for (const s of manager.all()) this.attach(s);
  }

  dispose(): void {
    this.manager.off('sessionStarted', this.onStarted);
    this.manager.off('sessionStopped', this.onStopped);
    for (const s of [...this.detachers.keys()]) {
      this.detachers.get(s)?.();
      this.detachers.delete(s);
    }
    for (const t of this.stackTimers.values()) clearTimeout(t);
    this.stackTimers.clear();
    this.runs.clear();
    this.changeListeners.length = 0;
    this.stackListeners.length = 0;
  }

  /** Fired when a session's unrolled packages changed (the panel's graph must be resent). */
  onChange(listener: (session: Session) => void): void {
    this.changeListeners.push(listener);
  }

  /** Fired after the Time Machine moved, at most every STACK_THROTTLE_MS (trailing edge). */
  onStack(listener: (session: Session) => void): void {
    this.stackListeners.push(listener);
  }

  /** The graph of the session's last run; undefined without a trace. Cached per (session, run, options). */
  graph(session: Session, opts: ExecutionGraphOptions = {}): ExecutionGraph | undefined {
    const inputs = walkthroughInputs(session);
    if (!inputs) return undefined;
    const cache = this.cache(session);
    const key = optionsKey(opts);
    let g = cache.graphs.get(key);
    if (!g) {
      g = buildExecutionGraph(inputs, opts);
      cache.graphs.set(key, g);
    }
    return g;
  }

  /** The panel's graph: the run's graph with the session's unrolled packages. */
  panelGraph(session: Session): ExecutionGraph | undefined {
    const expanded = this.expanded(session);
    return this.graph(session, expanded.length ? { expand: expanded } : {});
  }

  /** Package names the panel has unrolled for the session's current run. */
  expanded(session: Session): string[] {
    return [...this.cache(session).expanded];
  }

  setExpanded(session: Session, packages: string[]): void {
    const cache = this.cache(session);
    const next = [...new Set(packages)];
    if (next.length === cache.expanded.length && next.every((p, i) => p === cache.expanded[i])) return;
    cache.expanded = next;
    for (const l of this.changeListeners) l(session);
  }

  /** Node ids of the call stack at the Time Machine's step, innermost first, the running statement's node ahead of it; [] while it is inactive. */
  stack(session: Session): string[] {
    if (!session.nav.active || !session.trace) return [];
    const g = this.panelGraph(session);
    if (!g) return [];
    const step = session.nav.currentStep;
    const loc = session.trace.location(step);
    return graphStack(g, session.trace.callStack(step), loc ? { fileId: loc.fileId, line: loc.range[0] } : undefined);
  }

  private cache(session: Session): RunCache {
    const runId = session.state.runId;
    let c = this.runs.get(session.key);
    if (!c || c.runId !== runId) {
      c = { runId, graphs: new Map(), expanded: [] };
      this.runs.set(session.key, c);
    }
    return c;
  }

  private attach(session: Session): void {
    if (this.detachers.has(session.key)) return;
    const onNav = (): void => this.scheduleStack(session);
    session.on('navChanged', onNav);
    this.detachers.set(session.key, () => session.off('navChanged', onNav));
  }

  private forget(session: Session): void {
    this.detachers.get(session.key)?.();
    this.detachers.delete(session.key);
    const t = this.stackTimers.get(session.key);
    if (t) clearTimeout(t);
    this.stackTimers.delete(session.key);
    this.runs.delete(session.key);
  }

  private scheduleStack(session: Session): void {
    if (this.stackTimers.has(session.key)) return;
    this.stackTimers.set(
      session.key,
      setTimeout(() => {
        this.stackTimers.delete(session.key);
        if (session.isDisposed) return;
        for (const l of this.stackListeners) l(session);
      }, STACK_THROTTLE_MS),
    );
  }
}
