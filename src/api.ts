/**
 * The object `activate()` returns: the wired features and a few queries the e2e suite reads
 * (`test/e2e`). Types only; the implementation is the object literal at the end of `extension.ts`.
 */
import type * as vscode from 'vscode';
import type { Completions, Provenance, VariableHistory } from './shared/protocol';
import type { InlineValue } from './decorations/decorator';
import type { StoryValue } from './session/storyLines';
import type { SessionManager } from './session/sessionManager';
import type { Session } from './session/session';
import type { BreakpointSpec, DebugBreakpointEcho, DebugState, ExceptionMode, LocalVar, PausedInfo, StepKind } from './session/debugState';
import type { HistoryOptions } from './session/variableHistory';
import type { ExecutionGraph, ExecutionGraphOptions } from './session/executionGraph';
import type { ExceptionReport } from './session/exceptionReportTypes';
import type { TimeMachine } from './timeMachine/navigator';
import type { OutputPanel } from './views/outputPanel';
import type { AgentBridge } from './agent/bridge';
import type { DebugSession } from './debug/debugSession';
import type { DebugSessionPanel, HostToWebview } from './shared/webviewProtocol';
import type { Narrator } from './features/narrator';
import type { TourHost } from './views/tourPane';
import type { GraphProvider } from './features/executionGraph';

/** API returned from activate(); used by the e2e tests. */
export interface PyokkaApi {
  manager: SessionManager;
  timeMachine: TimeMachine;
  panel: OutputPanel;
  agentBridge: AgentBridge;
  narrator: Narrator;
  /** the TOUR section's host: `tour(session)`, `ensure(session)`, `panel(session)`, `narrate(session)` */
  tour: TourHost;
  graphProvider: GraphProvider;
  /** the execution graph of the session's last run (docs/PROTOCOL.md, "Execution graph"); undefined without a trace */
  graph(session: Session, opts?: ExecutionGraphOptions): ExecutionGraph | undefined;
  /** the exceptions report of the session's last run (docs/PROTOCOL.md, "Exceptions report"), absolute paths; undefined without a trace */
  exceptions(session: Session): ExceptionReport | undefined;
  /** wait until the session's current run has finished (resolves immediately when idle) */
  waitForIdle(session: Session, timeoutMs?: number): Promise<void>;
  /** wait for the next run to start (unless one is in flight) and finish */
  waitForNextRun(session: Session, timeoutMs?: number): Promise<void>;
  /** the variable history the Variable pane and the bridge's `var` compute (undefined without a trace) */
  variableHistory(session: Session, name: string, opts?: HistoryOptions): Promise<VariableHistory | undefined>;
  /** the provenance tree the Details pane's "why" and the bridge's `why` compute (undefined without a trace); an empty name explains the statement at `step` */
  provenance(session: Session, step: number, name: string, depth?: number): Promise<Provenance | undefined>;
  /** the inline values the editor shows, 1-based lines; `dim` marks a value from an earlier Time Machine step; the e2e suite reads it */
  inlineValues(editor: vscode.TextEditor): InlineValue[];
  /** the values the Code Story document of `editor` shows, by document row; the e2e suite reads it */
  storyValues(editor: vscode.TextEditor): StoryValue[];
  /* the Debugger (docs/design/debugger-product.md): the `record: false` sessions, for the e2e suite */
  /** every live `record: false` debug session, newest last */
  debugSessions(): DebugSession[];
  /** the Debugger view's state as the panel last pushed it (the e2e suite cannot see inside the webview) */
  debugPanelState(): DebugSessionPanel | null;
  /** every message the panel posts, for the e2e suite; the output deltas are only observable in flight */
  onPanelMessage(fn: (msg: HostToWebview) => void): vscode.Disposable;
  /** start a debug session from a raw launch, through `vscode.debug.startDebugging` (the one door) */
  startDebugSession(launch: Record<string, unknown>): Promise<void>;
  /** feed a `vscode://ivor.pyokka/debug` URI to this window (the e2e suite must never run the real `code`) */
  handleDebugUri(uri: vscode.Uri): Promise<void>;
  /* the recording debugger (docs/HANDOFF-debugger.md): the session's `debug*` methods, for the e2e suite */
  debug(session: Session): DebugState;
  startDebug(session: Session): Promise<void>;
  debugContinue(session: Session): Promise<void>;
  debugStep(session: Session, kind: StepKind): Promise<void>;
  debugPause(session: Session): Promise<void>;
  setDebugBreakpoints(session: Session, specs: BreakpointSpec[]): Promise<DebugBreakpointEcho[]>;
  /** where an exception pauses a debug run: off, uncaught (the default) or raised */
  setDebugExceptions(session: Session, mode: ExceptionMode): Promise<void>;
  debugLocals(session: Session): Promise<LocalVar[]>;
  waitForPause(session: Session, timeoutMs?: number): Promise<PausedInfo | 'finished'>;
  /** completions for a watch expression typed so far (the panel's dropdown and DAP `completions`): the paused frame, else the finished run */
  complete(session: Session, text: string): Promise<Completions>;
}
