/**
 * The vscode glue of the DAP adapter (dapTranslator.ts does the protocol): an inline debug adapter
 * registered for the `pyokka` debugger type, a configuration provider that fills in the active
 * file, and the two `DebugTarget` views the translator drives.
 *
 * One door. Every start of a debug run goes through `vscode.debug.startDebugging`, so the standard
 * debug views open with the panel: the command "Pyokka: Debug Current File", F5 on a Python file
 * (a `pyokka` launch configuration or none at all), the URI handler, and the bridge's `debug`
 * request from the CLI. `resolve` then routes by `record`:
 *
 * - `record: false` (the default) is the Debugger: a `DebugSession` of its own, no run-all session,
 *   no recording, no Time Machine.
 * - `record: true` is today's behaviour: a run-all `Session` on the program's document in debug
 *   mode, with the Time Machine over its recording.
 *
 * `stopDebugging` and `restartDebugging` are the recording path's other two ends, shared with the
 * bridge; a restart replaces the run inside the same VS Code debug session.
 *
 * The Time Machine is a debug session too (replaySession.ts, replayLaunch.ts): opening it on a finished run starts
 * a `replay` launch, so the Run and Debug side bar shows the recording at the current step, and
 * closing it ends that session. A recording debug run (`record: true`) is already shown in a debug
 * session, which replays behind its frontier, so it gets no second one.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { interpreterRefusal, type SessionManager } from '../session/sessionManager';
import type { Session } from '../session/session';
import type { PausedInfo } from '../session/debugState';
import type { RecordFromSpec, RunFinishedEvent } from '../shared/protocol';
import { waitForIdle } from '../session/wait';
import { DapTranslator, type DebugSessionLike } from './dapTranslator';
import type { DapMessage } from './dapTypes';
import type { DebugSession } from './debugSession';
import type { DebugSessionManager } from './debugSessionManager';
import { launchKey, launchName, parseLaunch, recordFromSpec, type LaunchConfig } from './debugSessionState';
import { wrapDebugSession, type DebugTarget, type ReplaySource } from './debugTarget';
import { timeMachineReplay, wrapReplay } from './replaySession';
import { followTimeMachine, replayGivingWay, replaying, replayStarting, stopReplay } from './replayLaunch';
import { DEBUG_TYPE } from './dapShared';
import type { TimeMachine } from '../timeMachine/navigator';
import { log } from '../util/log';

export { DEBUG_TYPE } from './dapShared';
export const LAUNCH_NAME = 'Pyokka: Debug Current File';

/** the VS Code debug session showing each Pyokka session, while one is alive */
const attached = new Map<Session, vscode.DebugSession>();
/** the same for a `record: false` debug session */
const attachedDebug = new Map<DebugSession, vscode.DebugSession>();


/** Sessions whose debug run is being restarted, with the run being replaced: its finish must not end the VS Code debug session showing them. */
const restarting = new Map<Session, string | undefined>();

/** The VS Code debug session showing this Pyokka session, if any. */
export function debugSessionOf(session: Session): vscode.DebugSession | undefined {
  return attached.get(session);
}

/** The registry the adapter starts `record: false` sessions in; set once by `registerDapAdapter`. */
let debugSessions: DebugSessionManager | undefined;

/**
 * The one door: open a VS Code debug session over `launch`. A `record: false` session that already
 * holds the launch key and is shown in a live debug session restarts in place instead, so a second
 * start does not open a second toolbar.
 */
export async function startDebugSession(launch: LaunchConfig, opts: { stopOnEntry?: boolean } = {}): Promise<void> {
  const existing = debugSessions?.byKey(launch);
  if (existing && attachedDebug.has(existing)) {
    await existing.restart(opts);
    return;
  }
  const folder = launch.program ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(launch.program)) : undefined;
  const config: vscode.DebugConfiguration = {
    type: DEBUG_TYPE,
    request: 'launch',
    name: launch.module ? `Pyokka: Debug ${launchName(launch)}` : LAUNCH_NAME,
    ...(launch.program ? { program: launch.program } : {}),
    ...(launch.module ? { module: launch.module } : {}),
    ...(launch.args.length ? { args: launch.args } : {}),
    cwd: launch.cwd,
    ...(Object.keys(launch.env).length ? { env: launch.env } : {}),
    ...(launch.python ? { python: launch.python } : {}),
    stopOnEntry: opts.stopOnEntry ?? launch.stopOnEntry,
    breakOnException: launch.breakOnException,
    libraryCode: launch.libraryCode,
    record: launch.record,
    ...(launch.recordFrom ? { recordFrom: launch.recordFrom } : {}),
    // the Pyokka panel is where a run is read; the Debug Console opens when the user asks for it
    internalConsoleOptions: 'neverOpen',
  };
  const ok = await vscode.debug.startDebugging(folder, config);
  if (!ok) throw new Error(`VS Code did not start a debug session on ${launchName(launch)}`);
}

/**
 * Start a debug run of `doc`: a `record: false` Debugger session by default, or today's recording
 * run inside the document's own session with `record: true`.
 */
export async function debugDocument(doc: vscode.TextDocument, existing?: Session, opts: { stopOnEntry?: boolean; record?: boolean; recordFrom?: string; recordFromSpec?: RecordFromSpec } = {}): Promise<void> {
  const record = opts.record === true || !!opts.recordFrom || !!opts.recordFromSpec;
  const cwd = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? '';
  if (record && existing && attached.has(existing)) {
    // `recordFromSpec` is a restart keeping the run's own; `recordFrom` the `--at` text of a new start
    const recordFrom = opts.recordFromSpec ?? recordFromSpec({ recordFrom: opts.recordFrom, cwd: cwd || path.dirname(doc.uri.fsPath) });
    await existing.startDebug({ stopOnEntry: !!opts.stopOnEntry, ...(recordFrom ? { recordFrom } : {}) });
    return;
  }
  await startDebugSession({ program: doc.uri.fsPath, args: [], cwd, env: {}, stopOnEntry: !!opts.stopOnEntry, breakOnException: 'uncaught', libraryCode: false, record, ...(opts.recordFrom ? { recordFrom: opts.recordFrom } : {}) }, { stopOnEntry: !!opts.stopOnEntry });
}

/** What "Pyokka: Stop Debugging" does, then wait until the run is gone: leave debug mode, stop the run. Resolves at once when no run is in flight. */
export async function stopDebugging(session: Session): Promise<void> {
  session.stopDebug();
  if (!session.running) return;
  await session.stopRun();
  await waitForIdle(session, 30_000);
}

/**
 * Stop the debug run, wait for it to be gone, then start a fresh debug run of the same file.
 * `onStopped` runs between the two (the bridge registers its wait for the first stop there). The
 * VS Code debug session showing the Pyokka session is kept: the old run's finish is not reported
 * to it, and the new run opens inside it through `debugDocument`.
 */
export async function restartDebugging(session: Session, opts: { stopOnEntry?: boolean; onStopped?: () => void } = {}): Promise<void> {
  restarting.set(session, session.debug.runId ?? session.state.runId);
  try {
    await stopDebugging(session);
    opts.onStopped?.();
    const recordFrom = session.debugCtl.recordFrom;
    await debugDocument(session.document, session, { stopOnEntry: opts.stopOnEntry, record: true, ...(recordFrom ? { recordFromSpec: recordFrom } : {}) });
  } finally {
    restarting.delete(session);
  }
}

export class PyokkaDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private readonly translator: DapTranslator;
  private shown: Session | undefined;
  private shownDebug: DebugSession | undefined;
  /** a `replay` launch: the session key whose recording this debug session replays */
  private readonly replayKey: string | undefined;
  private readonly frameClicks: vscode.Disposable | undefined;

  constructor(
    private readonly mgr: SessionManager,
    private readonly debugMgr: DebugSessionManager,
    private readonly debugSession?: vscode.DebugSession,
    private readonly timeMachine?: TimeMachine,
  ) {
    const config = debugSession?.configuration;
    this.replayKey = typeof config?.['replay'] === 'string' ? config['replay'] : undefined;
    const replayable = !!timeMachine && (!!this.replayKey || config?.['record'] === true);
    this.translator = new DapTranslator(
      (launch, opts) => this.resolve(launch, opts),
      (msg) => this.emitter.fire(msg),
      { stepBack: replayable },
    );
    if (this.replayKey && debugSession) {
      // registered before `launch` arrives, so a second Time Machine move cannot start a second replay
      const session = mgr.getByKey(this.replayKey);
      if (session) {
        replaying.set(session, debugSession);
        replayStarting.delete(session);
        this.shown = session;
      }
    }
    // a frame clicked in the Call Stack moves the Time Machine to that frame's step
    this.frameClicks = replayable
      ? vscode.debug.onDidChangeActiveStackItem((item) => {
          if (item instanceof vscode.DebugStackFrame && item.session === this.debugSession) this.translator.selectFrame(item.frameId);
        })
      : undefined;
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as DapMessage;
    if (msg.type !== 'request') return;
    // Stop in the debug toolbar closes the Time Machine; this session is already on its way out
    if (this.replayKey && this.shown && (msg.command === 'disconnect' || msg.command === 'terminate') && replaying.get(this.shown) === this.debugSession) replaying.delete(this.shown);
    void this.translator.handle(msg);
  }

  dispose(): void {
    this.frameClicks?.dispose();
    if (this.shown && replaying.get(this.shown) === this.debugSession) replaying.delete(this.shown);
    if (this.shown && attached.get(this.shown) === this.debugSession) attached.delete(this.shown);
    if (this.shownDebug && attachedDebug.get(this.shownDebug) === this.debugSession) attachedDebug.delete(this.shownDebug);
    this.shown = undefined;
    this.shownDebug = undefined;
    this.translator.dispose();
    this.emitter.dispose();
  }

  private async resolve(launch: LaunchConfig, opts: { stopOnEntry: boolean }): Promise<DebugSessionLike> {
    if (this.replayKey) return this.resolveReplay(this.replayKey);
    return launch.record ? this.resolveRecording(launch, opts) : this.resolveDebugger(launch, opts);
  }

  /**
   * `replay`: the recording of a run-all session, through the Time Machine; nothing runs. The launch
   * never opens the Time Machine itself: one closed while this launch was on its way stays closed,
   * and replayLaunch.ts ends the session (reopening it here kept a replay alive nobody asked for).
   */
  private async resolveReplay(key: string): Promise<DebugSessionLike> {
    const session = this.mgr.getByKey(key);
    const tm = this.timeMachine;
    if (!session || !tm) throw new Error('the Pyokka session to replay is gone: start the Time Machine again');
    log.info(`[${session.displayName}] DAP launch (replay of the recording at step ${session.nav.currentStep})`);
    return wrapReplay(session, tm, { closesTimeMachine: () => !replayGivingWay.has(session) });
  }

  /** `record: false`: a `DebugSession` of its own; no run-all session is created or touched. */
  private async resolveDebugger(launch: LaunchConfig, opts: { stopOnEntry: boolean }): Promise<DebugSessionLike> {
    const existing = this.debugMgr.byKey(launch);
    if (existing && attachedDebug.has(existing) && attachedDebug.get(existing) !== this.debugSession) {
      throw new Error(`${existing.displayName} is already being debugged in another debug session: continue there, or stop it first`);
    }
    // the replay of this file's last run gives way: one file, one debug toolbar; the Time Machine stays open
    const runAll = launch.program ? this.mgr.all().find((s) => s.document.uri.scheme === 'file' && s.document.uri.fsPath === launch.program) : undefined;
    if (runAll) await stopReplay(runAll, { keepTimeMachine: true });
    const ds = await this.debugMgr.start(launch, { stopOnEntry: opts.stopOnEntry });
    log.info(`[${ds.displayName}] DAP launch (debug session ${ds.id}, no recording)`);
    if (this.debugSession) {
      attachedDebug.set(ds, this.debugSession);
      this.shownDebug = ds;
      ds.once('ended', () => {
        if (attachedDebug.get(ds) === this.debugSession) attachedDebug.delete(ds);
      });
    }
    return wrapDebugSession(ds);
  }

  /** `record: true`: today's run-all session in debug mode, with the Time Machine over its recording. */
  private async resolveRecording(launch: LaunchConfig, opts: { stopOnEntry: boolean }): Promise<DebugSessionLike> {
    const program = launch.program;
    if (!program) throw new Error('a recording debug session needs "program": "record": true runs the file as a Pyokka run-all session');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(program));
    // in an editor, not only loaded: a recording session ends with its document, and VS Code closes
    // a document nobody shows (a `--record` start through the URI, on a file that was not open,
    // lost its session on the first `continue`). It is also where the recording's values are drawn.
    if (!vscode.window.visibleTextEditors.some((e) => e.document === doc)) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    const existing = this.mgr.get(doc);
    // the replay of the previous run gives way: this debug session shows the Time Machine from now on
    if (existing) await stopReplay(existing, { keepTimeMachine: true });
    if (existing && attached.has(existing)) throw new Error(`${existing.displayName} is already being debugged in another debug session: continue there, or stop it first`);
    if (existing && launch.python && existing.interpreter.path !== launch.python) throw new Error(interpreterRefusal(existing.displayName));
    const recordFrom = recordFromSpec(launch);
    const session = existing ?? (await this.mgr.start(doc, { debug: true, stopOnEntry: opts.stopOnEntry, ...(recordFrom ? { recordFrom } : {}), ...(launch.python ? { interpreter: launch.python } : {}) }));
    if (!session) throw new Error(`Pyokka could not start a session on ${program}`);
    applyLaunchOverrides(session, launch);
    log.info(`[${session.displayName}] DAP launch${existing ? '' : ' (fresh session: its first run is the paused one)'} (recording)`);
    if (this.debugSession) {
      attached.set(session, this.debugSession);
      this.shown = session;
      session.once('disposed', () => {
        if (attached.get(session) === this.debugSession) attached.delete(session);
      });
    }
    return wrapSession(session, this.mgr, { debugStarted: !existing, recordFrom, replay: this.timeMachine ? timeMachineReplay(session, this.timeMachine) : undefined });
  }
}

/**
 * The three launch attributes a recording debug session sets on the run-all session
 * (docs/design/debugger-product.md, 3.7). `runNow` reads them as `?? this.config.argv` and so on,
 * so they are inert for every ordinary run-all run: only a recording debug start sets them.
 * `python` is not one of them: it reaches `SessionManager.start` as an option.
 */
export function applyLaunchOverrides(session: Session, launch: LaunchConfig): void {
  session.argvOverride = launch.args.length ? [...launch.args] : undefined;
  session.cwdOverride = launch.cwd || undefined;
  session.envOverride = Object.keys(launch.env).length ? { ...launch.env } : undefined;
}

/** The translator's view of a run-all session in debug mode (`record: true`). */
export function wrapSession(session: Session, mgr: SessionManager, opts: { debugStarted?: boolean; recordFrom?: RecordFromSpec; replay?: ReplaySource } = {}): DebugTarget {
  // a fresh session started in debug mode is already running its paused first run: the translator's
  // startDebug must not start a second one
  let debugStarted = !!opts.debugStarted;
  // the run this debug session reported as finished; VS Code's `disconnect` follows some
  // milliseconds later, and by then the session may already be running the next debug run, which
  // belongs to whoever started it
  let reported: string | undefined;
  const superseded = (): boolean => !!reported && !!session.debug.runId && session.debug.runId !== reported;
  return {
    id: session.key,
    kind: 'run',
    record: true,
    launch: undefined,
    replay: opts.replay,
    get displayName() {
      return session.displayName;
    },
    get debug() {
      return session.debug;
    },
    get running() {
      return session.running;
    },
    get output() {
      return session.state.output;
    },
    get modified() {
      return session.debug.modified;
    },
    get thread() {
      return session.debug.paused?.thread;
    },
    startDebug: (o) => {
      if (debugStarted) {
        debugStarted = false;
        return Promise.resolve();
      }
      // a recording from a pause is the launch's: the translator's start knows only stopOnEntry
      return session.startDebug(opts.recordFrom ? { ...o, recordFrom: opts.recordFrom } : o);
    },
    stopDebug: () => {
      if (!superseded()) session.stopDebug();
    },
    restart: (o) => restartDebugging(session, o),
    debugContinue: () => session.debugContinue(),
    debugStep: (kind) => session.debugStep(kind),
    debugPause: () => session.debugPause(),
    debugLocals: (o) => session.debugLocals(o),
    setDebugBreakpoints: (specs) => session.setDebugBreakpoints(specs),
    setDebugWatches: (specs) => session.setDebugWatches(specs),
    setDebugExceptions: (mode) => session.setDebugExceptions(mode),
    runToLine: (p, line) => session.debugCtl.runToLine(p, line),
    evaluate: async (expression, o) => {
      const ev = await session.evaluateLive(expression, undefined, o);
      return ev ? { text: ev.text, valueBag: ev.valueBag } : undefined;
    },
    // the control channel serves `exec` at any pause, recording or not, so both products answer it
    exec: (source, o) => session.debugExec(source, o),
    complete: (text) => session.completeExpression(text),
    expand: async (valueId, queryPath) => {
      if (!session.state.runId) return undefined;
      return session.runner.expand(session.state.runId, valueId, queryPath);
    },
    pathForFileId: (fileId) => session.uriForFileId(fileId)?.fsPath,
    locate: (rid) => {
      const loc = session.files.locate(rid);
      return loc ? { path: loc.path, line: loc.range[0] } : undefined;
    },
    // Stop in the toolbar ends the run and leaves debug mode, like "Pyokka: Stop Debugging"; the
    // session and its recording stay (the panel is still there to read what ran)
    terminate: () => {
      if (!superseded()) void session.stopRun().catch(() => undefined);
    },
    waitForPause: (timeoutMs) => session.waitForPause(timeoutMs),
    onPaused: (fn) => {
      const handler = (info: PausedInfo): void => fn(info);
      session.on('debugPaused', handler);
      return () => session.off('debugPaused', handler);
    },
    onResumed: (fn) => {
      const handler = (): void => fn();
      session.on('debugResumed', handler);
      return () => session.off('debugResumed', handler);
    },
    onFinished: (fn) => {
      const handler = (ev: RunFinishedEvent): void => {
        if (restarting.get(session) === ev.runId) return; // a restart replaces the run inside this debug session
        if (ev.runId !== session.debug.runId) return;
        reported = ev.runId;
        fn(ev.exitCode);
      };
      const disposed = (): void => fn(null); // the Pyokka session went away under the debug session
      session.on('runFinished', handler);
      session.once('disposed', disposed);
      return () => {
        session.off('runFinished', handler);
        session.off('disposed', disposed);
      };
    },
  };
}

/** Registers the debugger type: the inline adapter and the configuration provider. */
export function registerDapAdapter(mgr: SessionManager, debugMgr: DebugSessionManager, timeMachine?: TimeMachine): vscode.Disposable[] {
  debugSessions = debugMgr;
  // a file shown in a debug session of its own (recording, or a live `record: false` run of it) gets no replay
  if (timeMachine) followTimeMachine(mgr, (s) => attached.has(s) || [...attachedDebug.keys()].some((ds) => s.document.uri.scheme === 'file' && ds.launch.program === s.document.uri.fsPath));
  return [
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor: (debugSession) => new vscode.DebugAdapterInlineImplementation(new PyokkaDebugAdapter(mgr, debugMgr, debugSession, timeMachine)),
    }),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
      resolveDebugConfiguration(_folder, config) {
        // the Time Machine's own launch (startReplay) is complete as it is
        if (typeof config['replay'] === 'string') return config;
        // F5 on a Python file with no launch.json arrives empty; a launch without `program` means the active file
        const editor = vscode.window.activeTextEditor;
        if (!config.type && !config.request && !config.name) {
          if (!editor || editor.document.languageId !== 'python') {
            void vscode.window.showInformationMessage('Pyokka: open a Python file to debug it.');
            return undefined;
          }
          config.type = DEBUG_TYPE;
          config.request = 'launch';
          config.name = LAUNCH_NAME;
        }
        if (!config['program'] && !config['module']) config['program'] = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : '${file}';
        // the Pyokka panel is where a run is read; the Debug Console opens when the user asks for it
        if (!config['internalConsoleOptions']) config['internalConsoleOptions'] = 'neverOpen';
        // a launch the parser refuses must not open a session that then fails: report it here,
        // where `undefined` aborts the start and `startDebugging` answers false
        if (config['module'] && config['record'] === true) {
          void vscode.window.showErrorMessage('Pyokka: "record": true runs the file as a Pyokka run-all session, which has no module launch; use "record": false, or a "program" launch.');
          return undefined;
        }
        // a second start on a launch key a live debug session already holds restarts it in place and
        // opens no second toolbar; `undefined` aborts this start silently
        if (config['record'] !== true && (config['program'] || config['module'])) {
          const held = heldSession(config);
          if (held) {
            void held.restart({ stopOnEntry: config['stopOnEntry'] === true }).catch((err) => log.error(`debug restart failed (${held.displayName})`, err));
            return undefined;
          }
        }
        return config;
      },
    }),
  ];
}

/** The live debug session a configuration would land on, when one already holds its key. */
function heldSession(config: vscode.DebugConfiguration): DebugSession | undefined {
  if (!debugSessions) return undefined;
  let key: string;
  try {
    key = launchKey(parseLaunch(config as Record<string, unknown>));
  } catch {
    return undefined; // an unresolved `${file}` or a launch with neither program nor module
  }
  const ds = debugSessions.get(key);
  return ds && attachedDebug.has(ds) ? ds : undefined;
}
