/** Panel chrome: the header toolbar shown while navigating and the vertical rail. */
import type { DebuggerState, HttpMode, ViewId } from '../src-shared';
import type { SessionInfo } from '../model';
import { IconButton, MenuButton, type MenuItem } from './ui';

export function formatMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`;
}

type DebugAction = Extract<import('../src-shared').WebviewToHost, { type: 'debugger.action' }>['action'];

/**
 * The Time Machine's header: auto play, the execution diagram and close. Stepping, continuing and
 * pausing are the VS Code debug toolbar's, which drives the same Time Machine through its replay
 * debug session (src/debug/replaySession.ts), so the panel has no second set.
 */
export interface DebugToolbarProps {
  state: DebuggerState;
  session: SessionInfo;
  onAction: (a: DebugAction) => void;
  onStop: () => void;
  /** the Execution Diagram button; absent hides it */
  onShowDiagram?: () => void;
  diagramShown?: boolean;
}

export function DebugToolbar({ state, session, onAction, onStop, onShowDiagram, diagramShown }: DebugToolbarProps) {
  return (
    <div class="pk-header">
      <span class="pk-session">
        {session.name ?? 'Pyokka'}
        {session.running ? <i class="codicon codicon-loading codicon-modifier-spin" /> : session.durationMs !== undefined ? <span class="pk-dim"> {formatMs(session.durationMs)}{session.replayed ? ' · replayed' : ''}</span> : null}
      </span>
      <span class="pk-toolbar pk-debug-toolbar">
        <IconButton icon={state.autoPlaying ? 'debug-pause' : 'play'} title={state.autoPlaying ? 'Pause auto play' : 'Auto play'} onClick={() => onAction(state.autoPlaying ? 'pause' : 'autoPlay')} />
        {onShowDiagram && <IconButton icon="type-hierarchy" title="Show execution diagram" active={diagramShown} onClick={onShowDiagram} />}
        <IconButton icon="close" title="Close the Time Machine" onClick={onStop} />
      </span>
    </div>
  );
}

/** the rail's More menu (exported so the items can be checked without opening the menu) */
export function railMenuItems(onView: (v: ViewId) => void, onCommand: (command: string, args?: unknown[]) => void): MenuItem[] {
  return [
    { label: 'Show Execution Diagram', onSelect: () => onView('run-diagram') },
    { label: 'View Recent Files', separatorAbove: true, onSelect: () => onCommand('pyokka.viewRecentFiles') },
    { label: 'Show Instrumented File', onSelect: () => onCommand('pyokka.showInstrumentedFile') },
    { label: 'Edit Session Settings', onSelect: () => onCommand('pyokka.editSessionSettings') },
    { label: 'Show Pyokka Logs', separatorAbove: true, onSelect: () => onCommand('pyokka.showLogs') },
  ];
}

export interface RailProps {
  view: ViewId;
  debuggerActive: boolean;
  /** a `record: false` debug session exists: the Debugger button shows */
  debugSessionActive?: boolean;
  /** a run is in flight: the play button spins (clicking it restarts the run) */
  running: boolean;
  /** the session's HTTP mode: the HTTP button carries a badge while it is on */
  http?: HttpMode;
  onView: (v: ViewId) => void;
  onCommand: (command: string, args?: unknown[]) => void;
}

export function Rail({ view, debuggerActive, debugSessionActive = false, running, http = 'off', onView, onCommand }: RailProps) {
  const httpTitle = http === 'record' ? 'HTTP requests · recording the next run' : http === 'replay' ? 'HTTP requests · replaying from the recording' : 'HTTP requests';
  return (
    <nav class="pk-rail" aria-label="Views">
      <IconButton icon={running ? 'loading' : 'play'} spin={running} title={running ? 'Running… (click to restart the run)' : 'Re-execute file (F5)'} onClick={() => onCommand('pyokka.reexecute')} />
      <IconButton icon="output" title="Show Output" active={view === 'output'} onClick={() => { onView('output'); onCommand('pyokka.showOutput'); }} />
      <IconButton
        icon="history"
        title={debuggerActive ? 'Show Time Machine' : 'Start Time Machine on the current line'}
        active={view === 'debugger'}
        onClick={() => (debuggerActive ? onView('debugger') : onCommand('pyokka.debug'))}
      />
      {debugSessionActive && <IconButton icon="debug-alt" title="Show Debugger" active={view === 'debug'} onClick={() => onView('debug')} />}
      <IconButton icon="book" title="View Code Story" onClick={() => onCommand('pyokka.viewCodeStory')} />
      <IconButton icon="symbol-variable" title="Variable History" active={view === 'variable'} onClick={() => onView(view === 'variable' ? 'output' : 'variable')} />
      <IconButton icon="globe" title={httpTitle} active={view === 'http'} class={http === 'off' ? undefined : `pk-rail-badge mode-${http}`} onClick={() => onView(view === 'http' ? 'output' : 'http')} />
      <IconButton icon="pulse" title="Profile" onClick={() => onCommand('pyokka.profile')} />
      <IconButton icon="settings-gear" title="Settings" active={view === 'settings'} onClick={() => onView(view === 'settings' ? 'output' : 'settings')} />
      <MenuButton
        icon="ellipsis"
        title="More"
        align="right"
        items={() => railMenuItems(onView, onCommand)}
      />
    </nav>
  );
}

/** The panel with no session bound: the two ways to start one on the active editor's file. */
export function NoSession({ onCommand }: { onCommand: (command: string) => void }) {
  return (
    <div class="pk-no-session">
      <div class="pk-dim">No Pyokka session is running.</div>
      <div class="pk-no-session-actions">
        <button type="button" class="pk-exec-btn" onClick={() => onCommand('pyokka.startOnCurrentFile')}>
          <i class="codicon codicon-debug-start" /> Start on current file
        </button>
        <button type="button" class="pk-exec-btn" onClick={() => onCommand('pyokka.debugCurrentFile')}>
          <i class="codicon codicon-debug-alt" /> Debug current file
        </button>
      </div>
    </div>
  );
}
