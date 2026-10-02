/**
 * Pyokka extension host entry: activation, wiring, every command.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Range4 } from './shared/protocol';
import type { PyokkaApi } from './api';
import { SessionManager } from './session/sessionManager';
import type { Session } from './session/session';
import type { RunMode } from './session/types';
import { sessionProvenance, sessionVariableHistory } from './session/variableQuery';
import { createDecorationTypes } from './decorations/styles';
import { Decorator } from './decorations/decorator';
import { TimeMachine, type MoveKind } from './timeMachine/navigator';
import { OutputPanel, OUTPUT_VIEW_ID } from './views/outputPanel';
import { StatusBar } from './views/statusBar';
import { offerReplayGitignore } from './features/replayGitignore';
import { openHttpRecording, pickN } from './features/httpRecording';
import { LiveValues, expressionAtCursor } from './features/liveValues';
import { ValuePeekProvider } from './features/valuePeek';
import { Logpoints } from './features/logpoints';
import { CodeStory, STORY_SCHEME } from './features/codeStory';
import { StoryHoverProvider } from './features/storyHover';
import { RecentFilesView } from './features/recentFiles';
import { SnippetsFeature } from './features/snippets';
import { PackageInstall } from './features/packageInstall';
import { profileCommand } from './features/profiler';
import { showInstrumentedFile } from './features/instrumentedView';
import { clearLibraryCacheCommand } from './features/libraryCache';
import { DebugBreakpoints } from './features/debugBreakpoints';
import { Snaps } from './features/snaps';
import { ShadowValues } from './features/shadowValues';
import { StartView } from './features/startView';
import { pickVariableName, pickWhyTarget } from './features/variableHistory';
import { registerValueCommands } from './features/valueCommands';
import { waitForIdle, waitForNextRun } from './session/wait';
import { AgentBridge } from './agent/bridge';
import { debugDocument, registerDapAdapter, startDebugSession, wrapSession } from './debug/dapAdapter';
import type { DebugTarget } from './debug/debugTarget';
import { DebugSessionManager } from './debug/debugSessionManager';
import { registerDebugUriHandler, handleDebugUri } from './debug/debugUri';
import { registerDebugInlineValues } from './debug/debugInlineValues';
import { resetDebugContext } from './debug/debugContext';
import { parseLaunch } from './debug/debugSessionState';
import { DebugStatusBar } from './views/debugStatusBar';
import { setting } from './config/settings';
import { Narrator } from './features/narrator';
import { TourHost } from './views/tourPane';
import { installCliShim } from './features/cliShim';
import { GraphProvider } from './features/executionGraph';
import { buildExceptionReport } from './session/exceptionReport';
import { walkthroughInputs } from './agent/bridgeSupport';
import { editSessionSettings, selectAction, type QuickPickDeps } from './features/quickPicks';
import { invalidateVersionCache, onDidChangePythonEnvironment, selectInterpreterCommand } from './runtime/interpreter';
import { setContext, resetContextCache } from './util/context';
import { log } from './util/log';

declare const __PYOKKA_BUILD__: string;
/** build timestamp, injected by esbuild */
export const PYOKKA_BUILD: string = typeof __PYOKKA_BUILD__ === 'string' ? __PYOKKA_BUILD__ : 'unknown';

let manager: SessionManager | undefined;
let bridge: AgentBridge | undefined;

export type { PyokkaApi } from './api';

export function activate(context: vscode.ExtensionContext): PyokkaApi {
  resetContextCache();
  resetDebugContext();
  const distPython = context.asAbsolutePath('dist/python');
  const runtimeDir = fs.existsSync(path.join(distPython, 'pyokka_runtime')) ? distPython : context.asAbsolutePath('python');
  log.info(`Pyokka activating (build ${PYOKKA_BUILD}); runtime dir ${runtimeDir}`);

  for (const [k, v] of Object.entries({
    hasActiveSession: false,
    isActiveEditorRunningPyokka: false,
    startedAtLeastOnce: false,
    traceBeingNavigated: false,
    traceBeingAutoPlayed: false,
    autoLogEnabled: false,
    showValueOnSelectionEnabled: false,
    showSingleInlineValueEnabled: false,
    lineHasRemovableInlineValues: false,
    fileHasRemovableInlineValues: false,
    hasAnyEnabledBreakpointsInActiveEditor: false,
    activeFileHasBreakpoints: false,
    snapsExecutionAllowed: false,
    isProfilingEnabled: true,
    isCodeStoryEnabled: true,
    isAllowedDebuggerEditAndContinue: true,
    debug: true,
    debugSessionActive: false,
    panelView: 'output',
  })) setContext(k, v);

  const types = createDecorationTypes(context);
  const mgr = new SessionManager(context, runtimeDir);
  manager = mgr;
  // the Debugger: `record: false` sessions of their own, keyed by launch, not by document
  const debugSessions = new DebugSessionManager(runtimeDir);
  const decorator = new Decorator(types, mgr);
  const timeMachine = new TimeMachine(mgr, decorator);
  const panel = new OutputPanel(context, mgr, timeMachine);
  const statusBar = new StatusBar(mgr);
  const debugStatusBar = new DebugStatusBar(debugSessions);
  panel.setDebugSessions(debugSessions);
  // a debug session brings the panel to the Debugger view, under the setting a run-all start obeys
  // (outputPanel.ts does the same for a run). Every route lands here: F5 and the commands through
  // the DAP adapter, the URI handler, and both bridge sockets all create the session in the
  // registry. Only a new session, never a restart and never a pause: the caret stays where it is.
  debugSessions.on('sessionStarted', (ds) => {
    if (!setting<boolean>('showOutputOnStart', true, vscode.Uri.file(ds.launch.program ?? ds.launch.cwd))) return;
    // one macrotask later, after the context keys set just above have reached VS Code
    setTimeout(() => panel.showView('debug'), 0);
  });
  // the first HTTP recording in a workspace: offer once to keep .pyokka/replay/ out of git
  const replayGitignore = offerReplayGitignore(mgr, context);
  const liveValues = new LiveValues(mgr, decorator, panel);
  const valuePeek = new ValuePeekProvider(mgr);
  const shadowValues = new ShadowValues(mgr, decorator);
  const logpoints = new Logpoints(mgr);
  const debugBreakpoints = new DebugBreakpoints(mgr, debugSessions);
  const narrator = new Narrator(mgr, runtimeDir);
  panel.setNarrator(narrator);
  const tour = new TourHost(context, runtimeDir, narrator, (s, msg) => panel.post(s, msg));
  panel.setTour(tour);
  const graphProvider = new GraphProvider(mgr);
  panel.setGraphProvider(graphProvider);
  const codeStory = new CodeStory(mgr, timeMachine, types, (s) => narrator.walkthrough(s));
  narrator.onChange((s) => codeStory.refresh(s));
  const recent = new RecentFilesView(mgr);
  const snippets = new SnippetsFeature(mgr, recent);
  const packages = new PackageInstall(mgr);
  const snaps = new Snaps(context, mgr);
  const startView = new StartView(context, mgr);
  // local agents (the pyokka CLI) read runs and drive the Time Machine over a socket; off unless pyokka.agentAccess
  const agentBridge = new AgentBridge(mgr, timeMachine, (s) => narrator.glosses(s), debugSessions);
  bridge = agentBridge;
  // the Debug Adapter Protocol face of the debugger: VS Code's own debug toolbar and views over the same pause (src/debug)
  context.subscriptions.push(...registerDapAdapter(mgr, debugSessions, timeMachine));
  // `vscode://ivor.pyokka/debug?…`: how `pyokka debug FILE` reaches a window with no socket yet
  context.subscriptions.push(registerDebugUriHandler());
  // `name = value` on the paused function's lines during a Debugger pause, read from the frame
  context.subscriptions.push(registerDebugInlineValues());
  // `pyokka` on PATH, pointing at this version's runtime, so an agent never needs the extension's path
  context.subscriptions.push(installCliShim(context, runtimeDir));

  context.subscriptions.push(
    types,
    mgr,
    debugSessions,
    timeMachine,
    panel,
    statusBar,
    debugStatusBar,
    replayGitignore,
    liveValues,
    shadowValues,
    logpoints,
    debugBreakpoints,
    codeStory,
    recent,
    packages,
    snaps,
    startView,
    agentBridge,
    narrator,
    tour,
    graphProvider,
    vscode.window.registerWebviewViewProvider(OUTPUT_VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerHoverProvider({ language: 'python' }, valuePeek),
    // the same hover on a Code Story row, through the row's source file and line
    vscode.languages.registerHoverProvider({ scheme: STORY_SCHEME }, new StoryHoverProvider(codeStory, valuePeek)),
    vscode.window.onDidChangeVisibleTextEditors(() => decorator.refreshAll()),
    onDidChangePythonEnvironment(() => {
      invalidateVersionCache();
      if (mgr.all().length) {
        void vscode.window.showInformationMessage('Pyokka: the Python interpreter changed. Restart running sessions to use it?', 'Restart').then((pick) => {
          if (pick) for (const s of mgr.all()) void mgr.start(s.document, { restart: true, runMode: s.runMode, autoLog: s.autoLog });
        });
      }
    }),
  );

  // once per user: explain that Automatic mode re-executes the file (and its side effects) on every edit
  const AUTO_NOTICE_KEY = 'pyokka.autoRunNoticeShown';
  const SAVE_NOTICE_KEY = 'pyokka.onSaveNoticeShown';
  mgr.on('sessionStarted', (s) => {
    if (process.env['PYOKKA_E2E']) return;
    if (s.runMode === 'onSave' && !context.globalState.get<boolean>(SAVE_NOTICE_KEY)) {
      void context.globalState.update(SAVE_NOTICE_KEY, true);
      void vscode.window
        .showInformationMessage(`Pyokka runs project files on save (${s.displayName} is inside a project). Values update when you save; hovers and watches never execute the file. Scratch files run as you type.`, 'Run automatically', 'OK')
        .then((pick) => {
          if (pick === 'Run automatically') s.setRunMode('auto');
        });
      return;
    }
    if (s.runMode !== 'auto' || context.globalState.get<boolean>(AUTO_NOTICE_KEY)) return;
    void context.globalState.update(AUTO_NOTICE_KEY, true);
    void vscode.window
      .showInformationMessage(`Pyokka re-runs ${s.displayName} on every edit, hover and watch. For code with side effects (API calls, files, email) use Run on Save or Run on Demand; those modes execute only when you ask.`, 'Run on save', 'Run on demand', 'Keep automatic')
      .then((pick) => {
        if (pick === 'Run on save') s.setRunMode('onSave');
        else if (pick === 'Run on demand') s.setRunMode('onDemand');
      });
  });

  // decorations follow session state (coalesced per session)
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const refresh = (s: Session): void => {
    if (refreshTimers.has(s.key)) return;
    refreshTimers.set(
      s.key,
      setTimeout(() => {
        refreshTimers.delete(s.key);
        if (!s.isDisposed) decorator.refreshSession(s);
      }, 16),
    );
  };
  mgr.on('sessionStarted', (s) => {
    s.on('stateChanged', () => refresh(s));
    s.on('statusChanged', () => refresh(s));
    s.on('runStarted', () => refresh(s));
    decorator.refreshSession(s);
  });
  mgr.on('sessionStopped', (s) => {
    if (s.nav.active) {
      s.nav.autoLogByTimeMachine = false; // nothing to restore on a stopped session
      timeMachine.stop(s);
    }
    decorator.refreshAll();
  });
  mgr.on('activeChanged', () => decorator.refreshAll());

  /* ---------- helpers ---------- */

  const reg = (id: string, fn: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) => {
        try {
          const r = fn(...args);
          if (r instanceof Promise) return r.catch((err) => report(id, err));
          return r;
        } catch (err) {
          report(id, err);
          return undefined;
        }
      }),
    );
  };
  const report = (id: string, err: unknown): void => {
    log.error(`command ${id} failed`, err);
    void vscode.window.showErrorMessage(`Pyokka: ${err instanceof Error ? err.message : String(err)}`, 'Show Logs').then((p) => p && log.show());
  };
  const activeDoc = (): vscode.TextDocument | undefined => vscode.window.activeTextEditor?.document;
  const active = (): Session | undefined => mgr.active();
  const requireSession = (): Session | undefined => {
    const s = active();
    if (!s) void vscode.window.showInformationMessage('Pyokka: no active session. Start one with "Pyokka: Start on Current File" (Cmd/Ctrl+K Q).');
    return s;
  };
  const cursorLine = (s: Session): number | undefined => {
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document === s.document ? editor.selection.active.line + 1 : undefined;
  };
  const withRunMode = async (mode: RunMode): Promise<void> => {
    const doc = activeDoc();
    if (!doc) return;
    const s = mgr.get(doc);
    if (s) s.setRunMode(mode);
    else await mgr.start(doc, { runMode: mode });
  };
  const move = (kind: MoveKind) => (): void => {
    const s = active();
    if (s?.nav.active) timeMachine.move(s, kind);
  };
  const ensureNavigating = async (): Promise<Session | undefined> => {
    const doc = activeDoc();
    let s = active();
    if (!s && doc) s = await mgr.start(doc);
    if (!s) return undefined;
    return s;
  };

  /* ---------- session commands ---------- */

  reg('pyokka.startOnCurrentFile', async () => {
    const doc = activeDoc();
    if (doc) await mgr.start(doc);
    else await snippets.newPythonFile();
  });
  reg('pyokka.toggle', async () => {
    const doc = activeDoc();
    if (doc) await mgr.toggle(doc);
  });
  reg('pyokka.runAutomatically', () => withRunMode('auto'));
  reg('pyokka.runOnSave', () => withRunMode('onSave'));
  reg('pyokka.runOnDemand', () => withRunMode('onDemand'));
  reg('pyokka.reexecute', () => {
    const s = requireSession();
    if (s && !s.nav.active) void s.runNow('manual');
  });
  reg('pyokka.stopCurrent', () => {
    const s = active();
    if (s) mgr.stopSession(s, true);
  });
  reg('pyokka.stopAll', () => mgr.stopAll());
  reg('pyokka.focusActiveFile', async () => {
    const s = requireSession();
    if (!s) return;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === s.document);
    await vscode.window.showTextDocument(s.document, { viewColumn: editor?.viewColumn, preserveFocus: false });
  });
  reg('pyokka.selectWorkspaceFolder', () => mgr.selectWorkspaceFolder());
  reg('pyokka.showLogs', () => log.show());
  reg('pyokka.clearLibraryCache', () => clearLibraryCacheCommand(mgr));
  reg('pyokka.selectInterpreter', async () => {
    const exe = await selectInterpreterCommand();
    if (!exe) return;
    invalidateVersionCache();
    if (mgr.all().length) {
      const pick = await vscode.window.showInformationMessage(`Pyokka will use ${exe}. Restart running sessions?`, 'Restart');
      if (pick) for (const s of mgr.all()) void mgr.start(s.document, { restart: true, runMode: s.runMode, autoLog: s.autoLog });
    }
  });

  /* ---------- panel ---------- */

  reg('pyokka.showOutput', () => panel.show(true));
  reg('pyokka.focusOutput', () => panel.show(false));
  reg('pyokka.openStartView', () => startView.show());
  reg('pyokka.showInstrumentedFile', () => showInstrumentedFile(mgr));
  reg('pyokka.profile', () => profileCommand(mgr));
  reg('pyokka.showDiagramForEntry', (arg) => liveValues.showDiagramForEntry(arg));

  /* ---------- files ---------- */

  reg('pyokka.createFile', () => snippets.createFile());
  reg('pyokka.newRecentOrSnippet', () => snippets.createFile());
  reg('pyokka.newPythonFile', () => snippets.newPythonFile());
  reg('pyokka.createSnippetFromSelection', () => snippets.createSnippetFromSelection());
  reg('pyokka.editSnippets', () => snippets.editSnippets());
  reg('pyokka.viewRecentFiles', () => recent.show());
  reg('pyokka.runRecentFile', (arg) => recent.run(arg as { id?: string; clone?: boolean; folder?: string } | undefined));
  reg('pyokka.removeRecentFiles', (arg) => recent.remove(arg as { ids?: string[] } | undefined));

  /* ---------- values ---------- */

  registerValueCommands(reg, liveValues, packages);

  /* ---------- time machine ---------- */

  reg('pyokka.debug', async () => {
    const s = await ensureNavigating();
    if (!s) return;
    if (s.nav.active) timeMachine.stop(s);
    else await timeMachine.start(s, { line: cursorLine(s) });
  });
  reg('pyokka.debugAutoPlay', async () => {
    const s = await ensureNavigating();
    if (s) await timeMachine.start(s, { line: cursorLine(s), autoPlay: true });
  });
  reg('pyokka.stopTraceNavigation', () => {
    const s = active();
    if (s) timeMachine.stop(s);
  });
  /* ---------- the debugger (pause at the frontier; docs/HANDOFF-debugger.md) ---------- */

  // the seven control commands dispatch through the facade and nowhere else: the debug session when
  // one exists, else the active run-all session in debug mode (activeDebugTarget)
  const activeDebugTarget = (): DebugTarget | undefined => debugSessions.activeTarget() ?? wrapActive();
  const wrapActive = (): DebugTarget | undefined => {
    const s = requireSession();
    return s ? wrapSession(s, mgr) : undefined;
  };
  reg('pyokka.debugCurrentFile', async () => {
    const doc = activeDoc();
    if (!doc) return;
    // one door: a VS Code debug session over Pyokka's pause, so the standard views open with the panel
    await debugDocument(doc, mgr.get(doc));
  });
  reg('pyokka.debugCurrentFileRecording', async () => {
    const doc = activeDoc();
    if (!doc) return;
    // `record: true` is today's run-all session in debug mode: the Time Machine opens over its recording
    await debugDocument(doc, mgr.get(doc), { record: true });
  });
  reg('pyokka.debugContinue', () => activeDebugTarget()?.debugContinue());
  reg('pyokka.debugPause', () => activeDebugTarget()?.debugPause());
  reg('pyokka.debugStepOver', () => activeDebugTarget()?.debugStep('over'));
  reg('pyokka.debugStepInto', () => activeDebugTarget()?.debugStep('into'));
  reg('pyokka.debugStepOut', () => activeDebugTarget()?.debugStep('out'));
  reg('pyokka.debugRestart', () => activeDebugTarget()?.restart({}));
  reg('pyokka.debugStop', async () => {
    const target = activeDebugTarget();
    if (!target) return;
    target.stopDebug();
    target.terminate();
  });
  reg('pyokka.showDebugger', () => panel.showView('debug'));
  reg('pyokka.playTraceNextStep', move('into'));
  reg('pyokka.playTracePrevStep', move('back'));
  reg('pyokka.playTraceNextStepOver', move('over'));
  reg('pyokka.playTracePrevStepOver', move('backOver'));
  reg('pyokka.playTraceNextStepOut', move('out'));
  reg('pyokka.playTracePrevStepOut', move('backOut'));
  reg('pyokka.playTraceForwardToSelection', () => {
    const s = active();
    if (s?.nav.active) timeMachine.runToLine(s, false);
  });
  reg('pyokka.playTraceBackwardToSelection', () => {
    const s = active();
    if (s?.nav.active) timeMachine.runToLine(s, true);
  });
  reg('pyokka.playTraceForwardToBreakpoint', () => {
    const s = active();
    if (s?.nav.active) timeMachine.runToBreakpoint(s, false);
  });
  reg('pyokka.playTraceBackwardToBreakpoint', () => {
    const s = active();
    if (s?.nav.active) timeMachine.runToBreakpoint(s, true);
  });
  reg('pyokka.revealTraceStep', async (arg) => {
    const step = typeof arg === 'number' ? arg : arg && typeof arg === 'object' ? (arg as { step?: number }).step : undefined;
    const s = active();
    if (!s || step === undefined) return;
    if (!s.nav.active) await timeMachine.start(s);
    timeMachine.goto(s, step);
  });
  reg('pyokka.autoPlayCode', () => {
    const s = active();
    if (s?.nav.active) timeMachine.autoPlay(s);
  });
  reg('pyokka.pauseCodeExecution', () => {
    const s = active();
    if (s) timeMachine.pause(s);
  });
  // the call stack at the step is VS Code's Call Stack view, over the Time Machine's replay debug session
  reg('pyokka.viewCallStack', () => vscode.commands.executeCommand('workbench.debug.action.focusCallStackView'));
  reg('pyokka.hideCallStack', () => {
    const s = active();
    if (s) timeMachine.setCallStackVisible(s, false);
  });
  reg('pyokka.openCallStackFrame', (arg) => {
    const index = typeof arg === 'number' ? arg : arg && typeof arg === 'object' ? ((arg as { index?: number }).index ?? 0) : 0;
    const s = active();
    if (s) timeMachine.selectFrame(s, index);
  });
  reg('pyokka.toggleCodePreview', () => {
    const s = active();
    if (s) timeMachine.toggleCodePreview(s);
  });
  reg('pyokka.toggleStepEcho', () => {
    const s = active();
    if (s) timeMachine.toggleEcho(s);
  });
  reg('pyokka.addWatchExpression', async (arg) => {
    const a = (arg && typeof arg === 'object' ? arg : {}) as { exp?: string; range?: Range4; sessionKey?: string; fileId?: number };
    const s = (a.sessionKey && mgr.getByKey(a.sessionKey)) || active();
    if (!s) return;
    let exp = a.exp;
    let range = a.range;
    if (!exp) {
      const editor = vscode.window.activeTextEditor;
      const found = editor && editor.document === s.document ? expressionAtCursor(editor) : undefined;
      exp = found?.text;
      range = found?.range;
      if (!exp) exp = await vscode.window.showInputBox({ prompt: 'Watch expression', ignoreFocusOut: true });
    }
    if (!exp) return;
    if (!s.nav.active) await timeMachine.start(s, { line: cursorLine(s) });
    timeMachine.addWatch(s, exp, range, a.fileId ?? s.mainFileId());
    panel.showView('debugger');
  });
  reg('pyokka.removeWatchExpression', (arg) => {
    const id = typeof arg === 'string' ? arg : arg && typeof arg === 'object' ? (arg as { id?: string }).id : undefined;
    const s = active();
    if (s && id) timeMachine.removeWatch(s, id);
  });
  reg('pyokka.viewCodeStory', () => codeStory.open());
  reg('pyokka.narrateWalkthrough', async () => {
    const s = requireSession();
    if (!s) return;
    await narrator.narrate(s);
    panel.showView('output');
  });
  reg('pyokka.showTour', () => {
    const s = requireSession();
    if (s) panel.showTour(s);
  });
  reg('pyokka.narrateTour', async () => {
    const s = requireSession();
    if (!s) return;
    panel.showTour(s);
    await tour.narrate(s);
  });
  reg('pyokka.showVariableHistory', async (arg) => {
    const s = requireSession();
    const name = s && (await pickVariableName(s, arg));
    if (s && name) await panel.showVariable(s, name);
  });
  reg('pyokka.whyValue', async (arg) => {
    const s = requireSession();
    const target = s && (await pickWhyTarget(s, arg));
    if (s && target) await panel.showWhy(s, target.step, target.name);
  });
  // "Why This Value" on a row of VS Code's Variables view: the why tree at the Time Machine's step
  reg('pyokka.whyVariable', async (arg) => {
    const v = arg && typeof arg === 'object' ? (arg as { variable?: { name?: unknown; evaluateName?: unknown } }).variable : undefined;
    const name = typeof v?.evaluateName === 'string' ? v.evaluateName : typeof v?.name === 'string' ? v.name : undefined;
    const s = requireSession();
    const step = s?.nav.active ? s.nav.currentStep : s?.debug.paused?.step;
    if (s && name && step !== undefined) await panel.showWhy(s, step, name);
  });
  // the hover's "Record variables and re-run": one explicit click turns Record Variable Changes on for the session and runs once
  reg('pyokka.recordVariablesAndRerun', async (arg) => {
    const key = arg && typeof arg === 'object' ? (arg as { sessionKey?: unknown }).sessionKey : undefined;
    const s = (typeof key === 'string' ? mgr.getByKey(key) : undefined) ?? requireSession();
    if (!s) return;
    s.setRecordLocals(true);
    await s.runNow('manual');
  });
  reg('pyokka.showExecutionDiagram', () => {
    const s = requireSession();
    if (!s) return;
    if (!s.state.finished) {
      void vscode.window.showInformationMessage('Pyokka: nothing to draw yet; run the file first.');
      return;
    }
    panel.pushExecutionGraph(s);
    panel.showView('run-diagram');
  });
  reg('pyokka.showHttp', () => { const s = requireSession(); if (s) panel.showHttp(s); });
  reg('pyokka.openHttpRecording', (arg) => openHttpRecording(active(), pickN(arg)));

  /* ---------- snaps ---------- */

  reg('pyokka.allowFileSnapsExecution', () => snaps.allow());
  reg('pyokka.insertSnapOutput', () => snaps.insertOutput());
  reg('pyokka.deleteSnapOutput', () => snaps.deleteOutput());
  reg('pyokka.startFileSnapsDiscovery', () => snaps.setDiscovery(true));
  reg('pyokka.stopFileSnapsDiscovery', () => snaps.setDiscovery(false));

  /* ---------- quick picks ---------- */

  const picks: QuickPickDeps = { mgr, panel, startView, liveValues, recent, debugSessions, requireSession };
  reg('pyokka.selectAction', () => selectAction(picks));
  reg('pyokka.editSessionSettings', () => editSessionSettings(picks));

  mgr.updateActive();
  decorator.refreshAll();
  startView.maybeShowOnFirstActivation();
  log.info('Pyokka activated');
  return {
    manager: mgr,
    timeMachine: timeMachine,
    panel,
    agentBridge,
    narrator,
    tour,
    graphProvider,
    graph: (session, opts) => graphProvider.graph(session, opts),
    exceptions: (session) => {
      const inputs = walkthroughInputs(session);
      return inputs ? buildExceptionReport(inputs) : undefined;
    },
    waitForIdle,
    waitForNextRun,
    variableHistory: (session, name, opts) => sessionVariableHistory(session, name, opts),
    inlineValues: (editor) => decorator.inlineValues(editor),
    storyValues: (editor) => codeStory.values(editor),
    provenance: (session, step, name, depth) => sessionProvenance(session, step, name, depth),
    debugSessions: () => debugSessions.all(),
    debugPanelState: () => panel.debugPanelState(),
    onPanelMessage: (fn) => panel.onPost(fn),
    startDebugSession: (launch) => startDebugSession(parseLaunch(launch)),
    handleDebugUri: (uri) => handleDebugUri(uri),
    debug: (session) => session.debug,
    startDebug: (session) => session.startDebug(),
    debugContinue: (session) => session.debugContinue(),
    debugStep: (session, kind) => session.debugStep(kind),
    debugPause: (session) => session.debugPause(),
    setDebugBreakpoints: (session, specs) => session.setDebugBreakpoints(specs),
    setDebugExceptions: (session, mode) => session.setDebugExceptions(mode),
    debugLocals: (session) => session.debugLocals(),
    waitForPause: (session, timeoutMs) => session.waitForPause(timeoutMs),
    complete: (session, text) => session.completeExpression(text),
  };
}

export function deactivate(): void {
  bridge?.dispose();
  bridge = undefined;
  manager?.dispose();
  manager = undefined;
}
