/**
 * One run as the browser keeps it: the runtime's events folded into the extension's vscode-free
 * models (FileTable, TraceModel) and plain lists. The page (pageHost.ts) and the bridge
 * (server.ts) both build it from the same events, so the walkthrough the bridge narrates is the one
 * the page shows, with the same moment ids.
 */
import { FileTable } from '../src/session/fileTable';
import { TraceModel } from '../src/timeMachine/traceModel';
import { decodeSteps } from '../src/shared/protocol';
import type { WalkthroughInputs } from '../src/session/walkthroughShared';
import type { CoverageEvent, ErrorEvent, HttpExchangeEvent, LocalsEvent, LogEvent, RunEvent, RunFinishedEvent, StatementBinding, WatchEvent } from '../src/shared/protocol';

export const OUTPUT_KEEP = 64 * 1024;

export interface RunData {
  runId: string;
  /** the main file's text this run ran */
  content: string;
  running: boolean;
  files: FileTable;
  logs: LogEvent[];
  logsById: Map<string, LogEvent>;
  logsByRid: Map<number, LogEvent[]>;
  errors: ErrorEvent[];
  coverage: Map<number, CoverageEvent>;
  trace: TraceModel | null;
  /** the raw trace event, kept for the saved-run document (`pyokka tour`) */
  traceEvent: Extract<RunEvent, { type: 'trace' }> | null;
  locals: LocalsEvent['entries'];
  http: HttpExchangeEvent[];
  watch: WatchEvent[];
  output: string;
  finished: RunFinishedEvent | null;
  runnerErrors: string[];
  /** what each statement of a file assigns and reads, asked of the runtime once per file */
  bindings: Map<number, Promise<ReadonlyMap<number, StatementBinding> | undefined>>;
}

export function emptyRun(runId: string, content: string): RunData {
  return { runId, content, running: true, files: new FileTable(), logs: [], logsById: new Map(), logsByRid: new Map(), errors: [], coverage: new Map(), trace: null, traceEvent: null, locals: [], http: [], watch: [], output: '', finished: null, runnerErrors: [], bindings: new Map() };
}

/** Fold one event of the run into its data. Returns false for an event of another run. */
export function applyEvent(run: RunData, ev: RunEvent): boolean {
  if (ev.runId !== run.runId) return false;
  switch (ev.type) {
    case 'file.instrumented':
      run.files.add(ev);
      break;
    case 'log': {
      run.logs.push(ev);
      run.logsById.set(ev.logId, ev);
      const same = run.logsByRid.get(ev.rid);
      if (same) same.push(ev);
      else run.logsByRid.set(ev.rid, [ev]);
      break;
    }
    case 'output':
      run.output = (run.output + ev.text).slice(-OUTPUT_KEEP);
      break;
    case 'error':
      run.errors.push(ev);
      break;
    case 'coverage':
      run.coverage.set(ev.fileId, ev);
      break;
    case 'trace':
      // partial deltas only matter for a live view of a long run; the final trace is authoritative
      if (ev.partial) break;
      run.traceEvent = ev;
      run.trace = new TraceModel(decodeSteps(ev.steps), ev.scopes, ev.truncated, (rid) => run.files.locate(rid), ev.cap === undefined ? undefined : { cap: ev.cap, stepsRun: ev.stepsRun, spentBy: ev.spentBy ?? [] });
      break;
    case 'locals':
      for (const e of ev.entries) run.locals.push(e);
      break;
    case 'http.exchange':
      run.http.push(ev);
      break;
    case 'watch':
      run.watch.push(ev);
      break;
    case 'run.finished':
      run.running = false;
      run.finished = ev;
      break;
    default:
      break;
  }
  return true;
}

/** The directory of the main file, with no trailing separator. */
export function workspaceRootOf(mainPath: string): string {
  const i = Math.max(mainPath.lastIndexOf('/'), mainPath.lastIndexOf('\\'));
  return i > 0 ? mainPath.slice(0, i) : mainPath;
}

/** The walkthrough builders' inputs, once the run finished with a trace. */
export function runInputs(run: RunData | null, mainPath: string, readSource: (fileId: number) => string[] | undefined, gloss?: Record<string, string>): WalkthroughInputs | undefined {
  if (!run || run.running || !run.finished || !run.trace) return undefined;
  const fin = run.finished;
  return {
    trace: run.trace,
    files: run.files,
    entries: run.logs,
    locals: run.locals,
    errors: run.errors,
    mainFile: mainPath,
    workspaceRoot: workspaceRootOf(mainPath),
    readSource,
    finished: { exitCode: fin.exitCode, durationMs: fin.durationMs, timedOut: fin.timedOut, stopped: fin.stopped },
    ...(gloss ? { gloss } : {}),
  };
}
