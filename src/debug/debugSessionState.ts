/**
 * The Debugger's pure decisions (docs/design/debugger-product.md, 3.2, 3.9, 4.1, 4.3): the launch
 * configuration and its defaults, the registry key, the `vscode://ivor.pyokka/debug` codec, the
 * bridge descriptor, and the stop slice a `record: false` pause answers with. No vscode import, so
 * vitest covers it (test/unit/debugLaunch.test.ts, debugUri.test.ts, stopSlice.test.ts).
 *
 * There is no descriptor picker here on purpose: choosing between a run socket and a debug socket
 * is the CLI's job and lives in python/pyokka_runtime/agent/live.py.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Range4, RecordFromSpec, RunConfig, RunRequest } from '../shared/protocol';
import type { BlockLine, SliceBlock, SliceError, SliceLocation, SliceOptions, SliceValue } from '../session/contextSlice';
import type { BreakpointSpec, ExceptionMode, PausedInfo, PausedThread } from '../session/debugState';

/** The extension's id, as the URI handler is registered under. */
export const URI_AUTHORITY = 'ivor.pyokka';

/** Lines of the enclosing function a stop slice spends before it cuts on the code's own structure. */
export const BLOCK_LINES = 60;

/** Lines of the `def` header a cut block keeps however far down the function the pause is. */
export const BLOCK_SIGNATURE_LINES = 8;

/** How much of the program's output a stop reply carries: what is new since the previous stop. */
export const STOP_OUTPUT_TAIL = 4_000;

/* ---------- 3.2 the launch configuration ---------- */

export interface LaunchConfig {
  /** absolute path; exactly one of `program` / `module` */
  program?: string;
  /** dotted name, run like `python -m` */
  module?: string;
  args: string[];
  /** the workspace folder of the program, else its directory */
  cwd: string;
  env: Record<string, string>;
  /** interpreter path; undefined means resolve it as a run-all session does */
  python?: string;
  stopOnEntry: boolean;
  breakOnException: ExceptionMode;
  libraryCode: boolean;
  /** also record the run, so the Time Machine opens over it (wave 2); off by default */
  record: boolean;
  /**
   * Record only from the first pause here on (`--record-from`, `FILE:LINE` or a function name, the
   * `--at` grammar); implies `record`. The code before it runs at the debugger's speed.
   */
  recordFrom?: string;
}

export interface LaunchContext {
  /** `${file}`: the active editor's file */
  activeFile?: string;
  /** `${workspaceFolder}` and the default `cwd` */
  workspaceRoot?: string;
}

const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function strMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
  return out;
}

function mode(v: unknown): ExceptionMode | undefined {
  return v === 'off' || v === 'uncaught' || v === 'raised' ? v : undefined;
}

/** `${file}` and `${workspaceFolder}` as VS Code substitutes them. */
export function substitute(value: string, ctx: LaunchContext): string {
  return value.replace(/\$\{file\}/g, ctx.activeFile ?? '').replace(/\$\{workspaceFolder\}/g, ctx.workspaceRoot ?? '');
}

/**
 * A raw launch (the DAP `launch` request, a command, the URI handler, the bridge) as a
 * `LaunchConfig`. Throws when neither `program` nor `module` is given, when `module` is not a
 * dotted name, and when `module` is asked for with `record: true` (a recording run is a run-all
 * session on a document, and a module has none).
 */
export function parseLaunch(raw: Record<string, unknown>, ctx: LaunchContext = {}): LaunchConfig {
  const module = str(raw['module']);
  let program = str(raw['program']);
  if (program) {
    program = substitute(program, ctx);
    program = program ? path.resolve(program) : undefined;
  }
  const recordFrom = str(raw['recordFrom']);
  if (recordFrom && !parseAt(recordFrom)) throw new Error(`"recordFrom" is FILE:LINE or a function name, the \`--at\` grammar: got ${JSON.stringify(recordFrom)}`);
  // recording from a pause is a recording session: the run-all session holds the trace once it starts
  const record = raw['record'] === true || !!recordFrom;
  if (!program && !module) throw new Error('a Pyokka launch needs "program" (the Python file to run) or "module" (a dotted name run like `python -m`)');
  if (module && !MODULE_RE.test(module)) throw new Error(`"module" is a dotted module name, not a path: got ${JSON.stringify(module)}`);
  if (module && record) throw new Error('"record": true runs the file as a Pyokka run-all session, which has no module launch; use "record": false, or a "program" launch');
  const rawCwd = str(raw['cwd']);
  const cwd = rawCwd ? path.resolve(substitute(rawCwd, ctx)) : ctx.workspaceRoot || (program ? path.dirname(program) : process.cwd());
  const launch: LaunchConfig = {
    args: strings(raw['args']),
    cwd,
    env: strMap(raw['env']),
    stopOnEntry: raw['stopOnEntry'] === true,
    breakOnException: mode(raw['breakOnException']) ?? 'uncaught',
    libraryCode: raw['libraryCode'] === true,
    record,
  };
  // `module` wins over `program`, as the runtime does, so a launch that names both is not ambiguous
  if (module) launch.module = module;
  else if (program) launch.program = program;
  if (recordFrom) launch.recordFrom = recordFrom;
  const python = str(raw['python']);
  if (python) launch.python = path.resolve(substitute(python, ctx));
  return launch;
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** The registry key: one debug session per program (or module) and working directory. */
export function launchKey(launch: LaunchConfig, real: (p: string) => string = realOr): string {
  const head = launch.module ? `m:${launch.module}` : `f:${real(launch.program ?? '')}`;
  return `${head}|${launch.cwd}`;
}

/** `app.py` for a program launch, `-m app.server` for a module launch. */
export function launchName(launch: LaunchConfig): string {
  return launch.module ? `-m ${launch.module}` : path.basename(launch.program ?? '');
}

/** The one-line launch the status bar's tooltip and the CLI's `state` print. */
export function launchLine(launch: LaunchConfig): string {
  // the interpreter only when the launch names one: a session's is filled in from what it resolved,
  // and printing `python3` for a session that runs a venv would be a guess, not a fact
  const target = launch.module ? `-m ${launch.module}` : (launch.program ?? '');
  const head = launch.python ? `${launch.python} ${target}` : target;
  return [head, ...launch.args].join(' ');
}

/* ---------- 3.9 the URI codec ---------- */

export interface DebugUri {
  launch: LaunchConfig;
  /** `FILE:LINE`, or a function name whose entry pauses */
  at?: string;
  /** the `--at` values after the first, each one more breakpoint set before the program starts */
  also?: string[];
}

/** `vscode://ivor.pyokka/debug?…` for a launch; every value `encodeURIComponent`-ed. */
export function debugUri(launch: LaunchConfig, at?: string): string {
  const q = new URLSearchParams();
  if (launch.program) q.set('program', launch.program);
  if (launch.module) q.set('module', launch.module);
  if (launch.args.length) q.set('args', JSON.stringify(launch.args));
  if (launch.cwd) q.set('cwd', launch.cwd);
  if (Object.keys(launch.env).length) q.set('env', JSON.stringify(launch.env));
  if (launch.python) q.set('python', launch.python);
  if (launch.stopOnEntry) q.set('stopOnEntry', '1');
  if (launch.record) q.set('record', '1');
  if (launch.recordFrom) q.set('recordFrom', launch.recordFrom);
  if (launch.libraryCode) q.set('libraryCode', '1');
  if (launch.breakOnException !== 'uncaught') q.set('breakOnException', launch.breakOnException);
  if (at) q.set('at', at);
  return `vscode://${URI_AUTHORITY}/debug?${q.toString()}`;
}

function json(q: URLSearchParams, key: string): unknown {
  const raw = q.get(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`the debug URI's "${key}" is not JSON: ${raw.slice(0, 60)}`);
  }
}

/** The inverse of `debugUri`; takes the query alone or a whole URI. Throws on a value it cannot read. */
export function parseDebugUri(query: string): DebugUri {
  const i = query.indexOf('?');
  const q = new URLSearchParams(i >= 0 ? query.slice(i + 1) : query);
  const args = json(q, 'args');
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) throw new Error('the debug URI\'s "args" must be a JSON array of strings');
  const env = json(q, 'env');
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some((v) => typeof v !== 'string'))) throw new Error('the debug URI\'s "env" must be a JSON object of strings');
  const raw: Record<string, unknown> = {
    args: args ?? [],
    env: env ?? {},
    stopOnEntry: q.get('stopOnEntry') === '1',
    record: q.get('record') === '1',
    libraryCode: q.get('libraryCode') === '1',
  };
  for (const key of ['program', 'module', 'cwd', 'python', 'breakOnException', 'recordFrom'] as const) {
    const v = q.get(key);
    if (v !== null && v !== '') raw[key] = v;
  }
  const out: DebugUri = { launch: parseLaunch(raw) };
  // `--at` repeats (a breakpoint at each stage of a pipeline); the first one is `at`
  const ats = q.getAll('at').filter(Boolean);
  if (ats[0]) out.at = ats[0];
  if (ats.length > 1) out.also = ats.slice(1);
  return out;
}

/** A function name `--at` accepts: `rrf`, or `Ranker.rank` for a method. */
const AT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * `--at FILE:LINE` or `--at NAME`. A bare (or dotted) name is a function's entry, which the
 * runtime resolves from its rid-to-name table: a module imported later gets its breakpoint when it
 * loads, which an AST scan on the host cannot do. Undefined for anything that is neither.
 */
export function parseAt(at: string): { file: string; line: number } | { function: string } | undefined {
  const value = at.trim();
  if (!value) return undefined;
  const i = value.lastIndexOf(':');
  if (i > 0) {
    const line = Number(value.slice(i + 1));
    if (Number.isInteger(line) && line >= 1) return { file: value.slice(0, i), line };
  }
  return AT_NAME_RE.test(value) ? { function: value } : undefined;
}

/**
 * A launch's `recordFrom` as the run config carries it: a function name stays a name (the runtime
 * resolves it), a file is resolved against the launch's cwd as `--at` is. Undefined without one.
 */
export function recordFromSpec(launch: Pick<LaunchConfig, 'recordFrom' | 'cwd'>): RecordFromSpec | undefined {
  const at = launch.recordFrom ? parseAt(launch.recordFrom) : undefined;
  if (!at) return undefined;
  if ('function' in at) return { function: at.function };
  return { path: path.isAbsolute(at.file) ? at.file : path.resolve(launch.cwd, at.file), line: at.line };
}

/** What `--at` answers for a value that is neither `FILE:LINE` nor a function name. */
export const AT_UNREADABLE = '--at wants FILE:LINE or a function name';

/* ---------- the one run request a debug session sends ---------- */

export interface RunRequestInput {
  runId: string;
  launch: LaunchConfig;
  workspaceRoot: string;
  /** the resolved settings of the launch's file: the base `RunConfig` and the environment */
  base: { run: RunConfig; env: Record<string, string> };
  stopOnEntry: boolean;
  exceptions: ExceptionMode;
  breakpoints: BreakpointSpec[];
}

/**
 * The request of a debug run. `record: false` turns the recording off, the timeout is always 0 (a
 * paused server must outlive any clock), and no buffer content is sent: what runs is what is on
 * disk, which is why an edit while paused is not applied until the next start.
 */
export function debugRunRequest(input: RunRequestInput): Omit<RunRequest, 'type' | 'id'> {
  const l = input.launch;
  const config: RunConfig = {
    ...input.base.run,
    record: l.record,
    debug: true,
    stopOnEntry: input.stopOnEntry,
    breakOnException: input.exceptions,
    libraryCode: l.libraryCode,
    timeoutMs: 0,
    recordLocals: l.record,
    autoLog: false,
    http: 'off',
    httpObserve: false,
  };
  return {
    runId: input.runId,
    ...(l.module ? { module: l.module } : { file: { path: l.program ?? '', displayName: path.basename(l.program ?? '') } }),
    workspaceRoot: input.workspaceRoot,
    cwd: l.cwd,
    argv: [...l.args],
    env: { ...input.base.env, ...l.env },
    projectFiles: [],
    config,
    breakpoints: input.breakpoints,
    markers: [],
    expressionsToEvaluate: {},
    watch: [],
    mode: 'normal',
  };
}

/* ---------- 4.1 the descriptor ---------- */

export interface DebugDescriptorLaunch {
  program: string | null;
  module: string | null;
  args: string[];
  cwd: string;
  python: string | null;
  record: boolean;
}

export interface DebugDescriptor {
  socket: string;
  token: string;
  pid: number;
  kind: 'debug';
  workspace: string;
  /** the main file once the run reported it; the launch's `cwd` until then (a module launch) */
  file: string;
  displayName: string;
  launch: DebugDescriptorLaunch;
  runtimeVersion: string;
  started: string;
}

export function descriptorFor(input: { socket: string; token: string; pid: number; workspace: string; file: string; launch: LaunchConfig; runtimeVersion: string; started: number | string }): DebugDescriptor {
  const l = input.launch;
  return {
    socket: input.socket,
    token: input.token,
    pid: input.pid,
    kind: 'debug',
    workspace: input.workspace,
    file: input.file,
    displayName: launchName(l),
    launch: { program: l.program ?? null, module: l.module ?? null, args: [...l.args], cwd: l.cwd, python: l.python ?? null, record: l.record },
    runtimeVersion: input.runtimeVersion,
    started: typeof input.started === 'string' ? input.started : new Date(input.started).toISOString(),
  };
}

/** The whole launch, as `state` and the Debugger view report it. */
export function launchReply(launch: LaunchConfig): Record<string, unknown> {
  return {
    program: launch.program ?? null,
    module: launch.module ?? null,
    args: [...launch.args],
    cwd: launch.cwd,
    env: { ...launch.env },
    python: launch.python ?? null,
    stopOnEntry: launch.stopOnEntry,
    breakOnException: launch.breakOnException,
    libraryCode: launch.libraryCode,
    record: launch.record,
  };
}

/* ---------- 4.3 the stop slice ---------- */

/** One frame of a stop's stack: the frame chain's own file and line, addressed by `frameId`. */
export interface StopFrame {
  file: string;
  line: number;
  function: string;
  frameId: number;
}

/**
 * Frames the slice has no source for, folded where they stand instead of dropped. Library frames
 * cannot be shown — there is no instrumented file behind them — but removing them silently turns a
 * chain into `quick_test ← <module>`, which reads as a call that was never made. The marker keeps
 * the chain honest: how many frames are missing, and which files they are in.
 */
export interface ElidedFrames {
  elided: number;
  where: 'library';
  /** the files they run in, innermost first, at most three; absent from a runtime that sends no path */
  in?: string[];
}

export type StopStackEntry = StopFrame | ElidedFrames;

/** A stack entry the slice folded rather than showed. */
export function isElided(entry: StopStackEntry): entry is ElidedFrames {
  return 'elided' in entry;
}

/**
 * What a stop says about the program's output. `text` is what the program printed since the
 * previous stop, not the tail of everything it has ever printed: re-sending the same 4 KB at every
 * stop made a reader re-read what it had already read and never told it which line its own move
 * produced. `earlier` and `seq` are what make that delta safe to trust — how much is behind it, and
 * where it ends, so a caller that lost one can ask for the window with `scope`.
 */
export interface StopOutput {
  text: string;
  /** what `text` covers: since the previous stop, or the whole window the host keeps */
  since: 'stop' | 'start';
  /** lines in `text` */
  lines: number;
  /** lines before `text` that the window still holds and this reply does not carry */
  earlier: number;
  /** the head of `text` was cut: the per-stop budget, or the window's own 64 KB limit */
  truncated: boolean;
  /** the committed offset `text` ends at; the next stop's delta starts here */
  seq: number;
}

/** A read of the session's output log, as `stopReply` takes it (`bridgeDebugReply.ts`). */
export interface OutputRead {
  /** already redacted by the log; whole lines, plus a line still being written */
  text: string;
  since: 'stop' | 'start';
  /** lines of the window that come before `text` */
  earlier: number;
  seq: number;
  /** the window itself lost its head, so `text` does not reach back to where the run started */
  cut?: boolean;
}

export interface StopSlice {
  step: number;
  location: SliceLocation;
  stale: boolean;
  /** why, when it is: unsaved edits in the editor, or a change on disk under the run */
  staleReason?: 'unsaved' | 'disk';
  stack: StopStackEntry[];
  block: SliceBlock;
  /** always empty: nothing is recorded */
  values: SliceValue[];
  errors: SliceError[];
  output: StopOutput;
  modified: boolean;
  thread?: PausedThread;
}

export interface StopSliceInputs {
  paused: PausedInfo;
  /** the absolute path of a fileId; undefined when the file is not instrumented (`fileId: 0`) */
  pathForFileId: (fileId: number) => string | undefined;
  /** source lines of a file: the open document, else the file on disk; undefined when unavailable */
  readSource: (fileId: number) => string[] | undefined;
  /** the function whose body contains a line, as `file.instrumented` reported it */
  functionAt: (fileId: number, line: number) => { name: string; bodyRange: Range4 } | undefined;
  /** what the program printed, as the caller read it out of the session's output log */
  output: OutputRead;
  modified: boolean;
  /** why the program's file is not the file that is running, or null when it is */
  staleReason: 'unsaved' | 'disk' | null;
  errors: SliceError[];
}

/** The part of a session's `OutputLog` a stop reads; the rest of it is the Debugger view's. */
export interface OutputSource {
  readonly seq: number;
  readonly dropped: number;
  all(): { text: string }[];
  since(seq: number): { text: string }[] | null;
  openLine(): { text: string } | null;
  linesBefore(seq: number): number;
}

/** How far the agent path has read a session's output, and which stop it read it for (`-1`: none). */
export interface OutputCursor {
  step: number;
  from: number;
  seq: number;
  /** what that read covered, so reading the same stop again answers the same thing */
  since?: 'stop' | 'start';
}

/**
 * What a stop carries of the program's output, and the cursor the next stop starts from.
 *
 * The cursor belongs to the session, not to the connection, because the CLI opens a connection per
 * command and "since the previous stop" has to mean the same thing across them. A read for the stop
 * the cursor already answered repeats that same delta rather than consuming a new one, so re-reading
 * a stop costs nothing; `scope` asks for the whole window, and so does a delta whose start the log
 * has already cut from its head.
 *
 * The line still being written is sent whole every time (the log cannot redact half a line safely),
 * so a line in flight can appear once as a fragment and again once it ends.
 */
export function readOutput(log: OutputSource, cursor: OutputCursor, step: number, scope: boolean): { read: OutputRead; cursor: OutputCursor } {
  const open = log.openLine()?.text ?? '';
  const reread = cursor.step === step;
  const from = reread ? cursor.from : cursor.seq;
  // `step: -1` is a cursor no stop has used yet, so the first stop of a run answers the window; a
  // stop after one that sat at offset 0 still answers a delta, which is what it is. Reading the
  // same stop again answers what it answered the first time, label included.
  const wanted = scope || cursor.step < 0 ? 'start' : reread && cursor.since ? cursor.since : 'stop';
  const chunks = wanted === 'start' ? null : log.since(from);
  if (!chunks) {
    const text = log.all().map((c) => c.text).join('') + open;
    return { read: { text, since: 'start', earlier: 0, seq: log.seq, cut: log.dropped > 0 }, cursor: { step, from, seq: log.seq, since: 'start' } };
  }
  return {
    read: { text: chunks.map((c) => c.text).join('') + open, since: 'stop', earlier: log.linesBefore(from), seq: log.seq },
    cursor: { step, from, seq: log.seq, since: 'stop' },
  };
}

/** Lines in `text`, counting a line still being written as one. */
function lineCount(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return text.endsWith('\n') ? n : n + 1;
}

/**
 * A read of the output log cut to `limit` characters **at a line boundary**, with what the cut
 * removed counted into `earlier`. A cut on the character count alone hands a reader half a line
 * with nothing saying so; the only line this cuts in the middle is one that is longer than the
 * whole budget by itself, and `truncated` is there for exactly that.
 */
export function stopOutput(read: OutputRead, limit = STOP_OUTPUT_TAIL): StopOutput {
  let text = read.text;
  let earlier = read.earlier;
  let truncated = !!read.cut;
  if (text.length > limit) {
    const cut = text.indexOf('\n', text.length - limit);
    const from = cut === -1 ? text.length - limit : cut + 1;
    earlier += lineCount(text.slice(0, from));
    text = text.slice(from);
    truncated = true;
  }
  return { text, since: read.since, lines: lineCount(text), earlier, truncated, seq: read.seq };
}

/** Leading whitespace of a line, in characters: Python's own structure, and all this needs of it. */
function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** A line with no code on it: the structure reads straight through it. */
function isBlank(text: string): boolean {
  const t = text.trim();
  return t === '' || t.startsWith('#');
}

/** Does this line open a suite (`def f():`, `for r in rows:`, `else:`)? A trailing comment is not in the way. */
function opensSuite(text: string): boolean {
  return text.replace(/#[^'"]*$/, '').trimEnd().endsWith(':');
}

/** The last line with code on it in `from..to`, which for a function body is what it answers with. */
function lastCode(source: string[], from: number, to: number): number {
  for (let line = to; line >= from; line--) if (!isBlank(source[line - 1] ?? '')) return line;
  return to;
}

/** The `def` line down to the `:` that ends the signature: one line unless the parameters wrap. */
function signatureEnd(source: string[], first: number, last: number): number {
  const to = Math.min(last, first + BLOCK_SIGNATURE_LINES - 1);
  for (let line = first; line <= to; line++) if (opensSuite(source[line - 1] ?? '')) return line;
  return first;
}

/**
 * The suite the paused line sits in: the `for` / `if` / `with` header above it, and the lines
 * under that header. This is the boundary a reader of one line actually wants — the loop body it
 * is in, whole — where a window of N lines centred on the pause cuts wherever the number lands and
 * can open on the tail of one statement and close on the head of another.
 */
function enclosingSuite(source: string[], line: number, first: number, last: number): [number, number] {
  const own = indentOf(source[line - 1] ?? '');
  let header = first;
  for (let l = line - 1; l >= first; l--) {
    const text = source[l - 1] ?? '';
    if (isBlank(text)) continue;
    if (indentOf(text) < own && opensSuite(text)) {
      header = l;
      break;
    }
  }
  const headerIndent = indentOf(source[header - 1] ?? '');
  let end = header;
  for (let l = header + 1; l <= last; l++) {
    const text = source[l - 1] ?? '';
    if (isBlank(text)) continue;
    if (indentOf(text) <= headerIndent) break;
    end = l;
  }
  // nothing encloses the line (module level, or a header at the function's own indent): the pause
  // itself is the boundary, and the caller widens it into the room it has
  return end >= line ? [header, end] : [line, line];
}

/**
 * The enclosing function's source as the stop shows it: its `def` line to its last line when that
 * fits `BLOCK_LINES`, `current` on the paused line. Without a function (module level) the window is
 * the paused line's neighbourhood.
 *
 * When it does not fit, the block is cut on the code's structure rather than on a line count: the
 * signature always stays (a reader who cannot see the parameters cannot read the body), and the
 * rest of the budget goes to the suite the pause is in, widened into the lines around it when there
 * is room to spare. `totalLines` says how long the function really is, and the gaps between the
 * pieces are visible in the line numbers, so what is missing is never silent.
 */
export function stopBlock(inputs: StopSliceInputs, opts: SliceOptions = {}): SliceBlock {
  const p = inputs.paused;
  const file = inputs.pathForFileId(p.fileId) ?? '';
  const fn = p.line !== null ? inputs.functionAt(p.fileId, p.line) : undefined;
  const block: SliceBlock = { file, function: fn?.name ?? p.stack[0]?.name ?? '<module>', scopeId: p.scopeId, lines: [] };
  const source = inputs.readSource(p.fileId);
  if (!source || p.line === null) return block;
  const first = Math.max(1, fn ? fn.bodyRange[0] : 1);
  const last = Math.min(source.length, fn ? fn.bodyRange[2] : source.length);
  const total = last - first + 1;
  const budget = opts.scope ? Number.MAX_SAFE_INTEGER : BLOCK_LINES;
  const spans: [number, number][] = total <= budget ? [[first, last]] : cutSpans(source, p.line, first, last, budget, !!fn);
  const lines: BlockLine[] = [];
  let shown = 0;
  for (const [from, to] of spans) {
    for (let line = Math.max(first, from); line <= Math.min(last, to); line++) {
      if (shown && line <= lines[lines.length - 1]!.line) continue; // spans can meet: the signature and the suite
      const entry: BlockLine = { line, text: source[line - 1] ?? '' };
      if (line === p.line) entry.current = true;
      lines.push(entry);
      shown++;
    }
  }
  block.lines = lines;
  if (lines.length < total) {
    block.capped = true;
    block.totalLines = total;
  }
  return block;
}

/**
 * The pieces of a block too long to show whole: the signature, and the suite the pause is in.
 * Module level has no signature to keep (the first lines of a file are not a header for the line
 * that is running), so the whole budget goes to the pause's own neighbourhood.
 */
function cutSpans(source: string[], line: number, first: number, last: number, budget: number, hasSignature: boolean): [number, number][] {
  const sigEnd = hasSignature ? signatureEnd(source, first, last) : first - 1;
  const spans: [number, number][] = hasSignature ? [[first, sigEnd]] : [];
  const [suiteFrom, suiteTo] = enclosingSuite(source, line, first, last);
  // the last line of a function is what it answers with, and a cut that drops the `return` drops
  // the point of reading the body at all; one line of the budget buys it
  const tailLine = hasSignature ? lastCode(source, Math.max(first, sigEnd + 1), last) : 0;
  const keepTail = tailLine > suiteTo && tailLine > line;
  let room = Math.max(1, budget - (sigEnd - first + 1) - (keepTail ? 1 : 0));
  let from = Math.max(suiteFrom, sigEnd + 1);
  let to = Math.max(suiteTo, from);
  if (to - from + 1 > room) {
    // the suite itself is over budget: keep its header line, then centre the rest on the pause
    if (suiteFrom > sigEnd && room > 1) {
      spans.push([suiteFrom, suiteFrom]);
      room -= 1;
      from = suiteFrom + 1;
    }
    from = Math.max(from, Math.min(line - Math.floor(room / 2), to - room + 1));
    to = from + room - 1;
  } else {
    // room to spare: spend it on the lines around the suite, inside the function
    let left = room - (to - from + 1);
    while (left > 0 && (from > sigEnd + 1 || to < last)) {
      if (to < last) {
        to++;
        left--;
      }
      if (left > 0 && from > sigEnd + 1) {
        from--;
        left--;
      }
    }
  }
  spans.push([from, Math.min(to, last)]);
  if (keepTail && tailLine > to) spans.push([tailLine, tailLine]);
  return spans;
}

/**
 * The stop slice of a `record: false` pause: where it stopped, the frame chain with real caller
 * lines and the library frames folded into markers, the enclosing function's source, and what the
 * program has printed since the previous stop. No `count`, no `moves`, no `coverage` and no
 * `values`: there is no recording to read them from.
 */
export function stopSlice(inputs: StopSliceInputs, opts: SliceOptions = {}): StopSlice {
  const p = inputs.paused;
  const block = stopBlock(inputs, opts);
  const location: SliceLocation = {
    file: inputs.pathForFileId(p.fileId) ?? '',
    line: p.line ?? 0,
    col: 0,
    function: p.stack[0]?.name ?? block.function,
    fileId: p.fileId,
  };
  const out: StopSlice = {
    step: p.step,
    location,
    stale: inputs.staleReason !== null,
    stack: stopStack(inputs),
    block,
    values: [],
    errors: inputs.errors,
    output: stopOutput(inputs.output),
    modified: inputs.modified,
  };
  if (inputs.staleReason) out.staleReason = inputs.staleReason;
  if (p.thread) out.thread = p.thread;
  return out;
}

/** The frame chain as the slice carries it: source frames, runs of library frames as one marker. */
function stopStack(inputs: StopSliceInputs): StopStackEntry[] {
  const p = inputs.paused;
  const stack: StopStackEntry[] = [];
  let folded: ElidedFrames | null = null;
  const flush = (): void => {
    if (folded) stack.push(folded);
    folded = null;
  };
  p.stack.forEach((frame, i) => {
    // frames outside instrumented files are in `paused.stack` with fileId 0; the slice's stack is source
    const fileId = frame.fileId ?? p.fileId;
    const file = frame.fileId === 0 ? undefined : inputs.pathForFileId(fileId);
    if (!file) {
      folded ??= { elided: 0, where: 'library' };
      folded.elided++;
      const where = libraryPath(frame.path);
      if (where && !folded.in?.includes(where)) folded.in = [...(folded.in ?? []), where].slice(0, 3);
      return;
    }
    flush();
    stack.push({ file, line: frame.line ?? p.line ?? 0, function: frame.name, frameId: frame.frameId ?? i });
  });
  flush();
  return stack;
}

/**
 * `…/site-packages/httpx/_client.py` as `httpx/_client.py`, `…/lib/python3.14/socketserver.py` as
 * `socketserver.py`: the package a reader would name it by, without the interpreter's own layout.
 */
export function libraryPath(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const parts = file.split(/[\\/]/).filter(Boolean);
  const packages = parts.lastIndexOf('site-packages');
  const from = packages >= 0 ? packages + 1 : Math.max(0, parts.length - 2);
  const kept = parts.slice(from);
  if (kept.length > 1 && /^(lib|lib-dynload|python\d+(\.\d+)?)$/.test(kept[0]!)) kept.shift();
  return kept.join('/') || undefined;
}

/** `{finished: {exitCode, durationMs, stepCount}}`: the program ended instead of stopping. */
export function finishedSlice(fin: { exitCode: number | null; durationMs: number; stepCount: number } | undefined): Record<string, unknown> {
  return { finished: { exitCode: fin?.exitCode ?? null, durationMs: fin?.durationMs ?? 0, stepCount: fin?.stepCount ?? 0 } };
}
