/**
 * Helpers of the agent bridge that need no socket: request field parsing, staleness, source
 * reading, redaction of replies and the descriptor directory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { Session } from '../session/session';
import type { ContextSlice, SliceOptions, SliceValue } from '../session/contextSlice';
import type { Walkthrough, WalkthroughInputs } from '../session/walkthrough';
import { sourceLines } from '../session/variableQuery';
import type { HttpTable, Provenance, ProvenanceNode, VariableHistory } from '../shared/protocol';
import type { ExecutionGraph, GraphNode } from '../session/executionGraphTypes';
import type { ExceptionReport } from '../session/exceptionReportTypes';
import { redact, redactValueBag } from '../util/redact';
import { pyokkaHome } from '../util/paths';
import { recordingDoc } from './bridgeRecording';

/** `$PYOKKA_SESSIONS_DIR`, else `<PYOKKA_HOME>/sessions`: the directory the CLI reads (`live.py`, `sessions_dir`). */
export function sessionsDir(): string {
  return process.env['PYOKKA_SESSIONS_DIR'] || path.join(pyokkaHome(), 'sessions');
}

/** macOS caps a Unix socket path (sun_path) at 104 bytes including the NUL. */
const SOCKET_PATH_MAX = 103;

/**
 * The socket for descriptor `base`: beside the descriptor when the path fits in sun_path, else a
 * short path in the temp directory. The descriptor records the path either way.
 */
export function socketPathFor(dir: string, base: string): string {
  const beside = path.join(dir, `${base}.sock`);
  if (Buffer.byteLength(beside) <= SOCKET_PATH_MAX) return beside;
  return path.join(os.tmpdir(), `pyokka-${base}-${crypto.randomBytes(3).toString('hex')}.sock`);
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export type Request = Record<string, unknown> & { id?: unknown };


export function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

export function sliceOptions(req: Request): SliceOptions {
  return { scope: !!req.scope, valueBag: !!req.valueBag };
}

export function describe(req: Request): string {
  const parts: string[] = [];
  if (req.kind !== undefined) parts.push(`kind=${String(req.kind)}`);
  if (req.to !== undefined) parts.push(`to=${String(req.to)}`);
  if (req.step !== undefined) parts.push(`step=${String(req.step)}`);
  if (req.file !== undefined || req.line !== undefined) parts.push(`${String(req.file ?? '')}:${String(req.line ?? '')}${req.endLine !== undefined ? `-${String(req.endLine)}` : ''}`);
  if (req.expression !== undefined) parts.push(JSON.stringify(String(req.expression)));
  if (req.name !== undefined) parts.push(`name=${String(req.name)}`);
  if (req.depth !== undefined) parts.push(`depth=${String(req.depth)}`);
  if (req.valueId !== undefined) parts.push(`valueId=${String(req.valueId)}`);
  if (req.scope) parts.push(typeof req.scope === 'string' ? `scope=${req.scope}` : 'scope');
  if (req.from !== undefined || req.to !== undefined) parts.push(`${String(req.from ?? '')}..${String(req.to ?? '')}`);
  if (req.all) parts.push('all');
  if (req.expand !== undefined) parts.push(`expand=${Array.isArray(req.expand) ? req.expand.map(String).join(',') : String(req.expand)}`);
  if (req.statements === false) parts.push('no-statements');
  for (const key of ['set', 'add', 'remove'] as const) if (Array.isArray(req[key])) parts.push(`${key}=${req[key].length}`);
  if (req.list) parts.push('list');
  if (req.exceptions !== undefined) parts.push(`exceptions=${String(req.exceptions)}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function isStale(session: Session): boolean {
  if (session.dirtyLines.size > 0) return true;
  try {
    return session.state.finished !== undefined && session.document.getText() !== session.state.content;
  } catch {
    return false;
  }
}

/** Source lines of a file of the run: the content that ran for the main file, the editor buffer or the disk for the others. */
export function readSource(session: Session, fileId: number): string[] | undefined {
  return sourceLines(session, fileId);
}

/** The session's run as a saved run's `{meta, events}` (the `recording` reply, and the Tour view's `run.json`); undefined without a trace. */
export function sessionRecording(session: Session): ReturnType<typeof recordingDoc> | undefined {
  const st = session.state;
  if (!st.trace) return undefined;
  return recordingDoc({ runId: st.runId, file: session.filePath, workspaceRoot: session.workspaceRoot, files: st.files.all(), trace: { steps: st.trace.steps, scopes: st.trace.scopes, truncated: st.trace.truncated, midRun: st.midRun }, entries: st.entries, locals: st.locals, errors: st.errors, coverage: st.coverage, http: st.http, finished: st.finished, readSource: (fileId) => readSource(session, fileId) });
}

/**
 * Resolve once no run is in flight or scheduled. Starting the Time Machine switches Auto Log on,
 * which schedules a re-run (debounced) in Automatic mode; an agent's next request must not land
 * in that window and see "no execution trace".
 */
export function awaitIdle(session: Session, timeoutMs = 20_000): Promise<void> {
  // a debug run paused at its frontier is idle for every reader: the recording behind the pause is settled
  const busy = (): boolean => !session.debug.paused && (session.running || session.runScheduled);
  if (!busy()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      clearInterval(poll);
      session.off('statusChanged', handler);
      resolve();
    };
    const handler = (): void => {
      if (!busy()) done();
    };
    const timer = setTimeout(done, timeoutMs);
    const poll = setInterval(handler, 50); // a scheduled run emits nothing until it starts
    session.on('statusChanged', handler);
  });
}

export function redactValues(values: SliceValue[]): SliceValue[] {
  return values.map((v) => {
    const out: SliceValue = { ...v, text: redact(v.text) };
    if (v.context !== undefined) out.context = redact(v.context);
    if (v.valueBag) out.valueBag = redactValueBag(v.valueBag);
    return out;
  });
}

export function redactSlice(slice: ContextSlice): Record<string, unknown> {
  return { ...slice, values: redactValues(slice.values), errors: slice.errors.map((e) => ({ ...e, message: redact(e.message) })) };
}

/** The walkthrough builder's inputs from a session's state (the last run, glosses included when given). */
export function walkthroughInputs(session: Session, gloss?: Record<string, string>): WalkthroughInputs | undefined {
  const trace = session.trace;
  if (!trace) return undefined;
  const st = session.state;
  const fin = st.finished;
  return {
    trace,
    files: st.files,
    entries: st.entries,
    locals: st.locals,
    errors: st.errors,
    mainFile: session.filePath,
    workspaceRoot: session.workspaceRoot,
    readSource: (fileId) => readSource(session, fileId),
    finished: fin ? { exitCode: fin.exitCode, durationMs: fin.durationMs, timedOut: fin.timedOut, stopped: fin.stopped } : undefined,
    stale: isStale(session),
    staleFiles: isStale(session) ? [session.filePath] : [],
    gloss,
  };
}

export function redactWalkthrough(w: Walkthrough): Walkthrough {
  return { ...w, moments: w.moments.map((m) => ({ ...m, text: redact(m.text), gloss: m.gloss ? redact(m.gloss) : m.gloss, values: m.values.map((v) => ({ ...v, name: redact(v.name), text: redact(v.text) })) })) };
}

export function redactHistory(history: VariableHistory): VariableHistory {
  return {
    ...history,
    changes: history.changes.map((c) => ({
      ...c,
      name: redact(c.name),
      ...(c.text !== undefined ? { text: redact(c.text) } : {}),
      ...(c.reads ? { reads: c.reads.map((r) => ({ ...r, ...(r.text !== undefined ? { text: redact(r.text) } : {}) })) } : {}),
    })),
  };
}
/** A row's URL and name are text an agent reads (the full URL lives only in the recording); paths and counts stay. */
export function redactHttpTable(t: HttpTable): HttpTable {
  return { ...t, requests: t.requests.map((r) => ({ ...r, url: redact(r.url), name: redact(r.name) })) };
}

/** Node names and texts, call inputs and results are values; statements and opaque call texts are source and stay. */
export function redactProvenance(p: Provenance): Provenance {
  const node = (n: ProvenanceNode): ProvenanceNode => ({
    ...n,
    name: redact(n.name),
    ...(n.text !== undefined ? { text: redact(n.text) } : {}),
    ...(n.reads ? { reads: n.reads.map(node) } : {}),
    ...(n.calls ? { calls: n.calls.map((c) => ({ ...c, inputs: c.inputs.map((i) => ({ ...i, text: redact(i.text) })), ...(c.result !== undefined ? { result: redact(c.result) } : {}) })) } : {}),
  });
  return { ...p, root: node(p.root) };
}
/** Row names and texts are values; decision texts and labels and edge labels are source and stay. */
export function redactGraph(g: ExecutionGraph): ExecutionGraph {
  const nodes = g.nodes.map((n): GraphNode => ({ ...n, rows: n.rows.map((r) => ({ ...r, name: redact(r.name), text: redact(r.text) })) }));
  return { ...g, nodes };
}
/** Exception messages carry values (`KeyError: 'sk-…'`); types, paths and functions are source and stay. */
export function redactExceptionReport(r: ExceptionReport): ExceptionReport {
  return { ...r, rows: r.rows.map((row) => ({ ...row, message: redact(row.message) })) };
}

/** Resolve a `file` request field (absolute, workspace-relative, or a basename) to a run fileId. */
export function fileIdFor(session: Session, file: unknown): number {
  const main = session.mainFileId();
  if (typeof file !== 'string' || !file) {
    if (main === undefined) throw new BridgeError('no file in the run yet', 'run the file first');
    return main;
  }
  if (file === session.displayName) return main ?? -1;
  const abs = path.isAbsolute(file) ? file : path.resolve(session.workspaceRoot || path.dirname(session.filePath), file);
  if (abs === session.filePath && main !== undefined) return main;
  const exact = session.files.byPath(abs);
  if (exact) return exact.fileId;
  const suffix = session.files.all().filter((f) => f.path.endsWith(`${path.sep}${file}`) || path.basename(f.path) === file);
  if (suffix.length === 1) return suffix[0]!.fileId;
  throw new BridgeError(`file not part of the run: ${file}`, suffix.length ? `ambiguous; use an absolute path: ${suffix.map((f) => f.path).join(', ')}` : `files of the run: ${session.files.all().slice(0, 8).map((f) => f.path).join(', ')}`);
}

export function rm(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

/** Remove descriptors (and sockets) left by extension hosts that are gone. */
export function sweepDeadDescriptors(): void {
  const dir = sessionsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let pid: number | undefined;
    let socket: string | undefined;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; socket?: unknown };
      pid = doc.pid;
      socket = typeof doc.socket === 'string' && doc.socket.endsWith('.sock') ? doc.socket : undefined;
    } catch {
      pid = undefined;
    }
    if (pid !== undefined && pid !== process.pid && processAlive(pid)) continue;
    if (pid === process.pid) continue;
    rm(file);
    rm(file.replace(/\.json$/, '.sock'));
    if (socket) rm(socket); // a socket that did not fit beside its descriptor lives in the temp directory
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
