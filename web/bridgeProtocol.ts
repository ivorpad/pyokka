/**
 * Messages between the browser bridge (web/server.ts) and the browser page (web/main.tsx) over the
 * WebSocket at `/ws`. The bridge relays the runtime's NDJSON protocol (docs/PROTOCOL.md) verbatim:
 * run events arrive as `event`, host requests go out as `request` and come back as `reply`. Nothing
 * here knows which language the runtime speaks, so the same page serves the Python runtime and the
 * JS/TS one. See docs/WEB.md.
 */
import type { DebugBreakpointSpec, DebugExceptionMode, HostRequest, RunConfig, RunEvent, RunnerMessage, WatchRequest } from '../src/shared/protocol';
import type { TourDoc } from '../src/session/tourTypes';
import type { SliceBlock } from '../src/session/contextSlice';
import type { ProfileSummary } from './profileSummary';
import type { ScratchCommand } from './scratchpadProtocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RequestBody = DistributiveOmit<HostRequest, 'id'>;

/** The run settings a page may change; everything else stays the extension's defaults. */
export type ConfigPatch = Partial<Pick<RunConfig, 'autoLog' | 'libraryCode' | 'timeoutMs' | 'recordLocals' | 'http'>> & { maskSecrets?: boolean };

export interface BridgeFile {
  /** absolute path on the machine the bridge runs on */
  path: string;
  displayName: string;
  /** Monaco language id: `python`, `javascript`, `typescript` */
  language: string;
  content: string;
}

export interface RuntimeInfo {
  /** what the bridge spawned, for the header: `python3 -m pyokka_runtime serve` */
  command: string;
  /** the `ready` reply's fields; null until the handshake completed */
  ready: { pythonVersion?: string; executable?: string; platform?: string; capabilities: string[]; runtimeVersion?: string } | null;
}

/** The context an agent read from `state.context`; a command carrying it is refused when the page moved on. */
export interface AgentExpectation {
  source?: 'live' | 'recording';
  runId?: string;
  step?: number | null;
  frame?: number;
  file?: string | null;
}

/** An instruction from an agent (the HTTP API, the `ctl` CLI or WebMCP), carried out by the page. */
export type AgentCommand = { expect?: AgentExpectation } & (
  | { action: 'state' }
  | { action: 'goto'; step: number; say?: string }
  /** `next`: exactly one recorded event forward; the others move like the debugger toolbar */
  | { action: 'step'; kind: 'next' | 'into' | 'over' | 'out' | 'back' | 'backOver' | 'backOut'; say?: string }
  | { action: 'line'; line: number; file?: string; say?: string }
  | { action: 'say'; text: string; line?: number; step?: number }
  | { action: 'clear' }
  | { action: 'start' }
  | { action: 'stop' }
  | { action: 'run' }
  | { action: 'eval'; expression: string }
  /** the captured value of a binding of the paused frame (`items.0.name` walks into it) as a ValueNode tree; nothing is evaluated */
  | { action: 'peek'; name: string }
  /** wait for the live debugger's next pause after cursor `after` (omit it to read the cursor), at most 25 s; it may wait beside one other command */
  | { action: 'waitPause'; after?: number; timeoutMs?: number }
  /** every recorded change of a variable (the Variable History view) */
  | { action: 'var'; name: string }
  /** why `name` had its value after `step` (empty name: the statement), the Details pane's tree */
  | { action: 'why'; step?: number; name: string }
  /** add a Time Machine watch (`remove` drops the one with this text) */
  | { action: 'watch'; exp: string; remove?: boolean }
  /** the live debugger: start a `record: false` run, move it, or stop it */
  | { action: 'debug'; op: 'start' | 'continue' | 'step' | 'pause' | 'stop' | 'state'; kind?: 'into' | 'over' | 'out'; say?: string }
  /** set or clear a breakpoint of the main file (toggles without `on`) */
  | { action: 'breakpoint'; line: number; on?: boolean; condition?: string }
  /** open the Code Story of the last run (starting the Time Machine), and read it back */
  | { action: 'story' }
  /** run once under the runtime's profiler and read the hottest functions */
  | { action: 'profile' }
  /** the live pause's values on the source: shadows beside declarations and the hover of each identifier */
  | { action: 'values' }
  /** where the name at LINE:COLUMN of the main file is defined (what Cmd/Ctrl-click opens), and the tab's URL */
  | { action: 'definition'; line: number; column: number }
  /** the Scratchpad: an experiment seeded from the live pause, run in a separate `python -I` (web/scratchpad.ts) */
  | ({ action: 'scratchpad' } & ScratchCommand)
);

/** The TOUR section's state for a run, as the bridge computed it with `pyokka tour`. */
export interface BridgeTour {
  runId: string;
  status: 'computing' | 'ready' | 'error';
  doc?: TourDoc;
  error?: string;
  narrating: boolean;
  narrationError?: string;
}

/** Profile's answer: the hottest functions of one profiled run (web/profileSummary.ts), or why there are none. */
export interface BridgeProfile {
  /** the `.cpuprofile` the runtime wrote, served at `/api/profile` */
  path?: string;
  summary?: ProfileSummary;
  error?: string;
}

/** A file the bridge ran as its main file, newest first (View Recent Files). */
export interface RecentFile {
  path: string;
  displayName: string;
  /** ms since the epoch */
  at: number;
}

/** Narrate's state for a run: the glosses once one model call answered. */
export interface BridgeNarration {
  runId: string;
  narrating: boolean;
  glosses?: Record<string, string>;
  error?: string;
}

export type BridgeToPage =
  | {
      type: 'hello';
      file: BridgeFile;
      runtime: RuntimeInfo;
      watch: boolean;
      /** a narration backend exists (claude, codex, PYOKKA_EXPLAIN_COMMAND) */
      canNarrate: boolean;
      /** the page bundle this bridge serves (app.js size and mtime); a clean tab loaded from another build reloads */
      build?: string;
    }
  /** the file changed on disk (or `file.read` asked for another one) */
  | { type: 'file'; file: BridgeFile }
  | { type: 'event'; event: RunEvent }
  | { type: 'reply'; id: number; reply: RunnerMessage }
  | { type: 'runner.error'; message: string; detail?: string }
  /** a requested run could not launch; the token belongs only to that page invocation */
  | { type: 'run.error'; requestId: string; runId?: string; message: string }
  | { type: 'runtime'; runtime: RuntimeInfo }
  | { type: 'agent'; id: number; command: AgentCommand }
  /** a run the bridge started and the content it ran, sent before the runtime's first event */
  | { type: 'run.begin'; runId: string; content: string; reason: string; requestId?: string }
  | { type: 'saved'; path: string }
  | { type: 'narration'; narration: BridgeNarration }
  | { type: 'tour'; tour: BridgeTour }
  /** the live debugger's run (a runtime of its own): begun, each of its events, and gone */
  | { type: 'debug.begin'; runId: string; content: string }
  | { type: 'debug.event'; event: RunEvent }
  | { type: 'debug.end'; runId: string; message?: string }
  /** the breakpoints the bridge holds (sent on connect, and when another tab changes them) */
  | { type: 'debug.breakpoints'; set: DebugBreakpointSpec[] }
  | { type: 'profile'; profile: BridgeProfile }
  | { type: 'recent'; files: RecentFile[] };

export type PageToBridge =
  /** run the file; `watch` and `traceContext` stay for later runs (a save, a settings change) until the next `run` */
  | { type: 'run'; requestId?: string; content?: string; watch?: WatchRequest[]; traceContext?: { step: number; prefetch: number } | null }
  /** change the run config for this and every later run (the panel's Settings view), then re-run */
  | { type: 'config'; patch: ConfigPatch }
  | { type: 'stop' }
  | { type: 'request'; id: number; body: RequestBody }
  | { type: 'save'; content: string }
  | { type: 'file.read'; path: string }
  /** what the page shows now, for `GET /api/state` */
  | { type: 'state'; state: PageState }
  | { type: 'agent.result'; id: number; result: unknown; error?: string }
  /** one model call that glosses the last run's walkthrough */
  | { type: 'narrate' }
  /** the tour of the last run (`pyokka tour`), or Narrate Tour */
  | { type: 'tour'; action: 'compute' | 'narrate' }
  | { type: 'debug.start'; breakpoints: DebugBreakpointSpec[]; exceptions: DebugExceptionMode; content?: string; stopOnEntry?: boolean }
  /** a host request for the debugger's run (`debug`, `evaluate`, `expand`, `complete`), answered with `reply` */
  | { type: 'debug.request'; id: number; body: RequestBody }
  | { type: 'debug.stop' }
  /** the page's breakpoints changed: the bridge keeps the set for a reload or another tab */
  | { type: 'debug.breakpoints'; set: DebugBreakpointSpec[] }
  /** run once in the runtime's profile mode (the buffer when `content` is given); answered with `profile` */
  | { type: 'profile'; content?: string }
  /** when a change on disk re-runs the file: `auto` and `onSave` do, `onDemand` waits for Run */
  | { type: 'runMode'; mode: 'auto' | 'onSave' | 'onDemand' }
  /** the files this bridge ran, answered with `recent` */
  | { type: 'recent' }
  /** make another file of the workspace the main one (a recent file), and run it */
  | { type: 'open'; path: string };

/** The page's position as an agent reads it back (`GET /api/state`, `ctl state`, WebMCP `pyokka_state`). */
export interface PageState {
  /**
   * The surface an agent acts on: the live debugger's run while it has one, else the recording.
   * The fields below it describe the recording only, as before.
   */
  context: {
    source: 'live' | 'recording';
    runId: string | null;
    running: boolean;
    paused: boolean;
    step: number | null;
    frame: number;
    file: string | null;
    line: number | null;
    /** the locals belong to this step and frame (false while they are on their way) */
    localsReady: boolean;
    locals: { name: string; text: string }[];
  };
  /** the file the code pane shows, which may differ from the context's frame */
  shownFile: string | null;
  runId: string | null;
  running: boolean;
  file: string;
  /** steps recorded in the last run; 0 before a trace arrived */
  steps: number;
  /** the Time Machine is on and `step` is its position */
  timeMachine: boolean;
  step: number | null;
  location: { file: string; line: number; function: string } | null;
  /** the source line at `location` */
  code: string | null;
  /**
   * On an agent command's reply: the enclosing function's code at `location` (or the live pause),
   * the current line marked `current`, each recorded line with the step it ran at; `capped` with
   * `totalLines` when a long function was cut. Absent when the file cannot be read.
   */
  block?: SliceBlock;
  /** recorded variable changes at `step` (record locals is on in the browser) */
  locals: { name: string; text: string }[];
  /** the call stack at `step`, innermost first */
  stack: { function: string; line: number; step: number }[];
  /** values logged so far (up to `step` while the Time Machine is on) */
  values: { line: number; context?: string; text: string; step: number }[];
  output: string;
  errors: { type: string; message: string; line: number }[];
  /** the narration bubble now showing */
  narration: { text: string; line: number } | null;
}
