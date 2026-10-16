/**
 * Pyokka in a browser: a local bridge between one runtime (`<runtime> serve`, NDJSON on stdio,
 * docs/PROTOCOL.md) and the panel page over a WebSocket. The bridge runs the file, re-runs it when
 * it changes on disk (save in VS Code or any editor) unless the live debugger has a run, relays
 * requests from the page, and lets an agent drive the page over HTTP (`/api/state`,
 * `/api/command`, the `ctl` subcommand).
 *
 *   node dist/web/server.js FILE [--port 4777] [--cwd DIR] [--runtime python|"CMD ARGS"] [--python PATH] [--open] [--no-run] [--no-watch]
 *   node dist/web/server.js ctl state | goto N | step next|into|over|out|back|backOver|backOut | line N | say TEXT [--line N] | clear | run | eval EXPR
 *
 * Binds 127.0.0.1 only. A WebSocket or API call whose Origin or Host is not this server's is
 * refused, so a web page in another tab cannot run code through it. See docs/WEB.md.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ScratchpadStore } from './scratchpadStore';
import { SCRATCH_OPS, type ScratchCommand } from './scratchpadProtocol';
import { RunnerClient } from '../src/runtime/runnerClient';
import { DEFAULT_RUN_CONFIG } from '../src/config/merge';
import type { DebugBreakpointSpec, DebugExceptionMode, DefinitionLocation, RunConfig, RunEvent, RunnerMessage, RunRequest, WatchRequest } from '../src/shared/protocol';
import type { AgentCommand, BridgeFile, BridgeProfile, ConfigPatch, BridgeToPage, PageToBridge, RecentFile, RuntimeInfo } from './bridgeProtocol';
import { summarizeProfile } from './profileSummary';
import { upgrade, type WebSocketConnection } from './ws';
import { applyEvent, emptyRun, type RunData } from './runState';
import { ServerViews } from './serverViews';
import { blocksBridgeRun } from './runPolicy';

export const DEFAULT_PORT = 4777;
/** the virtual file `file.read` answers with the bridge's log (Show Logs) */
export const LOG_PATH = 'pyokka://logs';
const RECENT_MAX = 20;

export interface ServerOptions {
  file: string;
  port: number;
  host: string;
  /** `python`, or a whole command line that speaks the protocol on stdio (`uv run python -m pyokka_runtime serve`) */
  runtime: string;
  python: string;
  watch: boolean;
  open: boolean;
  /** false (`--no-run`): start without running the file; the page's Run runs it */
  initialRun?: boolean;
  /** dist/: where the page, the panel bundle and the Python runtime were built to */
  distDir: string;
  /** a command that reads a prompt on stdin and answers (Narrate); else `claude`, else `codex` */
  explainCommand?: string;
  /** where View Recent Files is kept (`recent.json`); `~/.pyokka` by default, '' keeps it in memory */
  stateDir?: string;
  /** `--cwd DIR`: the run's working directory, and its workspace root when it holds the file */
  cwd?: string;
}

const LANGUAGES: Record<string, string> = { '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript' };

export function languageFor(file: string): string {
  return LANGUAGES[path.extname(file).toLowerCase()] ?? 'plaintext';
}

/** Split a command line on whitespace, keeping "double" or 'single' quoted parts whole. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * The run's workspace root and working directory: the file's folder, or `--cwd DIR`. DIR is also
 * the root when it holds the file (a project root, so the project's own modules are user code that
 * the debugger stops and steps in); a DIR elsewhere moves only the working directory. The rule of
 * `pyokka run --cwd` (python/pyokka_runtime/agent/save.py, `run_dirs`).
 */
export function runDirs(file: string, cwd?: string): { root: string; cwd: string } {
  const here = path.dirname(file);
  if (!cwd) return { root: here, cwd: here };
  const dir = path.resolve(cwd);
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const inside = real(file).startsWith(real(dir).replace(/[\\/]+$/, '') + path.sep);
  return { root: inside ? dir : here, cwd: dir };
}

/** The command the bridge spawns for `--runtime`, and the directory it starts in. */
export function runtimeCommand(opts: Pick<ServerOptions, 'runtime' | 'python' | 'distDir' | 'file'>): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  if (opts.runtime === 'python') {
    const candidates = [path.join(opts.distDir, 'python'), path.join(opts.distDir, '..', 'python')];
    const dir = candidates.find((d) => fs.existsSync(path.join(d, 'pyokka_runtime', '__main__.py'))) ?? candidates[0]!;
    return { command: opts.python, args: ['-m', 'pyokka_runtime', 'serve'], cwd: dir, env: { PYTHONPATH: dir } };
  }
  const [command, ...args] = splitCommand(opts.runtime);
  if (!command) throw new Error('--runtime is empty');
  return { command, args, cwd: path.dirname(opts.file), env: {} };
}

/**
 * A request may come from this page only: Host must name this server (no DNS rebinding) and an
 * Origin, when the client sends one, must be this server's own.
 */
export function sameOrigin(headers: http.IncomingHttpHeaders, port: number): boolean {
  const local = (host: string) => host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  const host = headers.host ?? '';
  if (!local(host)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && local(u.host);
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export class BridgeServer {
  private readonly runner: RunnerClient;
  private readonly runtimeInfo: RuntimeInfo;
  private readonly pages = new Set<WebSocketConnection>();
  /** files a definition lookup answered: the page may read them (the source tab, a Cmd/Ctrl-click from there) */
  private readonly definitionFiles = new Set<string>();
  private server: http.Server | undefined;
  /** one watch per directory (an atomic save replaces the file's inode), the content each watched file had, and the debounce and settle timers */
  private readonly sourceWatchers = new Map<string, fs.FSWatcher>();
  private readonly watchedSources = new Map<string, string>();
  private readonly sourceWatchTimers = new Map<string, NodeJS.Timeout>();
  private file: BridgeFile;
  /** the events of the current run, replayed to a page that connects late */
  private events: RunEvent[] = [];
  private current: { runId: string; content: string; reason: string } | null = null;
  /** the current run folded into models, for Narrate and the tour */
  private runData: RunData | null = null;
  private readonly views: ServerViews;
  /** the Time Machine's watches and where it is, sent with every run until the page changes them */
  private watch: WatchRequest[] = [];
  private traceContext: { step: number; prefetch: number } | undefined;
  /** the live debugger: a runtime of its own, started on first use, and its one run */
  private debugRunner: RunnerClient | undefined;
  private debugRun: { runId: string; content: string; events: RunEvent[] } | null = null;
  private debugCounter = 0;
  /** the last breakpoint set a page sent: a reloaded or second tab shows the ones the debug run has.
   * Null until a page sends one, so a bridge restart does not clear the tabs that reconnect. */
  private breakpoints: DebugBreakpointSpec[] | null = null;
  private runCounter = 0;
  private nextAgentId = 1;
  /** the command sent to a page and not yet answered: at most one, and only its page may answer it */
  private readonly agentWaiters = new Map<number, { page: WebSocketConnection; wait?: boolean; finish: (r: { result: unknown; error?: string }) => void }>();
  /** the content the bridge last wrote, so its own save does not count as an edit from outside */
  private lastWritten: string | undefined;
  private configPatch: ConfigPatch = {};
  /** unsaved content the page ran; later runs (a settings change) keep running it until the disk changes */
  private buffer: string | undefined;
  /** `onDemand`: a change on disk only refreshes the page's text; Run runs it */
  private runMode: 'auto' | 'onSave' | 'onDemand' = 'auto';
  /** the file the bridge started with: Open may only switch to files of its language under its directory */
  private readonly rootFile: string;
  private recent: RecentFile[] = [];
  /** the main file's local imports by its path and content, and every file listed so far (readable with `file.read`) */
  private readonly imports = new Map<string, string[]>();
  private readonly importFiles = new Set<string>();
  private lastProfile: string | undefined;
  private profiling = false;

  constructor(private readonly opts: ServerOptions) {
    this.file = readBridgeFile(opts.file);
    this.rootFile = this.file.path;
    this.recent = loadRecent(this.recentPath());
    this.remember(this.file);
    const cmd = runtimeCommand(opts);
    this.runtimeInfo = { command: [cmd.command, ...cmd.args].join(' '), ready: null };
    this.runner = new RunnerClient({ command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env, version: '1', log: (line) => log(line) });
    this.runner.on('event', (ev) => this.onEvent(ev));
    this.runner.on('runnerError', (message, detail) => this.broadcast({ type: 'runner.error', message, detail }));
    this.runner.on('ready', (ready) => {
      this.runtimeInfo.ready = ready;
      this.broadcast({ type: 'runtime', runtime: this.runtimeInfo });
    });
    this.views = new ServerViews(
      { distDir: opts.distDir, python: opts.python, explainCommand: opts.explainCommand },
      () => ({ run: this.runData, mainPath: this.file.path }),
      (m) => this.broadcast(m),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this.opts.port}/`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.onHttp(req, res));
    this.server.on('upgrade', (req, socket) => {
      if (req.url !== '/ws' || !sameOrigin(req.headers, this.opts.port)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const ws = upgrade(req, socket);
      if (ws) this.onPage(ws);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    // port 0 asks the OS for one (tests); the origin checks need the real one
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.opts.port = addr.port;
    if (this.opts.watch) this.watchFile();
    if (this.opts.initialRun !== false) void this.run('start');
  }

  async close(): Promise<void> {
    this.clearSourceWatchers();
    for (const p of this.pages) p.close(1001);
    this.views.dispose();
    await Promise.all([this.runner, this.debugRunner].map((r) => r?.shutdown().catch(() => undefined)));
    this.runner.dispose();
    this.debugRunner?.dispose();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /* ---------- runs ---------- */

  async run(reason: string, content?: string): Promise<void> {
    if (blocksBridgeRun(!!this.debugRun, reason)) {
      // the page already has the new source or setting; Run, debug restart or a save after the debug run executes it
      log(`${reason}: no run while debug run ${this.debugRun!.runId} is active`);
      return;
    }
    const runId = `w-${++this.runCounter}`;
    if (content !== undefined) this.buffer = content;
    const text = this.buffer ?? this.file.content;
    if (this.current) void this.runner.stop(this.current.runId);
    this.current = { runId, content: text, reason };
    this.runData = emptyRun(runId, text);
    this.views.reset();
    this.events = [];
    this.broadcast({ type: 'run.begin', runId, content: text, reason });
    log(`run ${runId} of ${this.file.displayName} (${reason})`);
    const dirs = runDirs(this.file.path, this.opts.cwd);
    const request: Omit<RunRequest, 'type' | 'id'> = {
      runId,
      file: { path: this.file.path, displayName: this.file.displayName, content: text },
      workspaceRoot: dirs.root,
      cwd: dirs.cwd,
      argv: [],
      env: {},
      projectFiles: [],
      // the browser has no settings UI of its own yet: the extension's defaults, with every
      // changed local recorded so the Time Machine can show variables at any step
      config: runConfig(this.configPatch),
      markers: [],
      expressionsToEvaluate: {},
      watch: this.watch,
      ...(this.traceContext && this.watch.length ? { traceContext: this.traceContext } : {}),
      mode: 'normal',
    };
    try {
      await this.runner.run(request);
    } catch (err) {
      this.broadcast({ type: 'runner.error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private onEvent(ev: RunEvent): void {
    if (!this.current || ev.runId !== this.current.runId) return;
    this.events.push(ev);
    if (ev.type === 'file.instrumented') this.watchSource(ev.path);
    if (this.runData) applyEvent(this.runData, ev);
    this.broadcast({ type: 'event', event: ev });
  }

  /* ---------- the live debugger ---------- */

  private ensureDebugRunner(): RunnerClient {
    if (this.debugRunner) return this.debugRunner;
    const cmd = runtimeCommand(this.opts);
    const r = new RunnerClient({ command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env, version: '1', log: (line) => log(`debug: ${line}`) });
    r.on('event', (ev) => {
      const d = this.debugRun;
      if (!d || ev.runId !== d.runId) return;
      d.events.push(ev);
      if (ev.type === 'file.instrumented') this.watchSource(ev.path);
      this.broadcast({ type: 'debug.event', event: ev });
      if (ev.type === 'run.finished') {
        this.debugRun = null;
        this.broadcast({ type: 'debug.end', runId: d.runId });
      }
    });
    r.on('runnerError', (message) => {
      const d = this.debugRun;
      this.debugRun = null;
      if (d) this.broadcast({ type: 'debug.end', runId: d.runId, message });
    });
    this.debugRunner = r;
    return r;
  }

  /** A `record: false` debug run of the file (the Debugger view): it pauses and steps, records nothing. */
  async startDebug(breakpoints: DebugBreakpointSpec[], exceptions: DebugExceptionMode, content?: string, stopOnEntry = true): Promise<void> {
    await this.stopDebug();
    const runner = this.ensureDebugRunner();
    const runId = `d-${++this.debugCounter}`;
    const text = content ?? this.buffer ?? this.file.content;
    this.debugRun = { runId, content: text, events: [] };
    this.broadcast({ type: 'debug.begin', runId, content: text });
    const dirs = runDirs(this.file.path, this.opts.cwd);
    const base = runConfig(this.configPatch);
    const request: Omit<RunRequest, 'type' | 'id'> = {
      runId,
      file: { path: this.file.path, displayName: this.file.displayName, content: text },
      workspaceRoot: dirs.root,
      cwd: dirs.cwd,
      argv: [],
      env: {},
      projectFiles: [],
      config: { ...base, debug: true, record: false, stopOnEntry, breakOnException: exceptions, timeoutMs: 0, recordLocals: false, autoLog: false, http: 'off', httpObserve: false },
      breakpoints,
      markers: [],
      expressionsToEvaluate: {},
      watch: [],
      mode: 'normal',
    };
    try {
      await runner.run(request);
    } catch (err) {
      this.debugRun = null;
      this.broadcast({ type: 'debug.end', runId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async stopDebug(): Promise<void> {
    const d = this.debugRun;
    if (!d || !this.debugRunner) return;
    this.debugRun = null;
    await this.debugRunner.stop(d.runId).catch(() => undefined);
    this.broadcast({ type: 'debug.end', runId: d.runId });
  }

  /* ---------- profile ---------- */

  /** One run in the runtime's profile mode on a runtime of its own (the recorded run stays on screen). */
  async profile(content?: string): Promise<BridgeProfile> {
    if (this.profiling) return { error: 'a profile run is already going' };
    this.profiling = true;
    const cmd = runtimeCommand(this.opts);
    const runner = new RunnerClient({ command: cmd.command, args: cmd.args, cwd: cmd.cwd, env: cmd.env, version: '1', log: (line) => log(`profile: ${line}`) });
    const runId = `p-${++this.runCounter}`;
    const dirs = runDirs(this.file.path, this.opts.cwd);
    const text = content ?? this.buffer ?? this.file.content;
    let result: BridgeProfile;
    try {
      const finished = new Promise<Record<string, unknown>>((resolve, reject) => {
        runner.on('event', (ev) => {
          if (ev.runId === runId && ev.type === 'run.finished') resolve(ev as unknown as Record<string, unknown>);
        });
        runner.on('runnerError', (message) => reject(new Error(message)));
      });
      await runner.run({
        runId,
        file: { path: this.file.path, displayName: this.file.displayName, content: text },
        workspaceRoot: dirs.root,
        cwd: dirs.cwd,
        argv: [],
        env: {},
        projectFiles: [],
        config: runConfig(this.configPatch),
        markers: [],
        expressionsToEvaluate: {},
        watch: [],
        mode: 'profile',
      });
      const ev = await Promise.race([finished, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the profile run did not finish in 120 s')), 120_000))]);
      const file = (ev['profile'] as { path?: string } | undefined)?.path;
      if (!file || !fs.existsSync(file)) result = { error: 'the runtime did not write a .cpuprofile (does it support profile mode?)' };
      else {
        this.lastProfile = file;
        result = { path: file, summary: summarizeProfile(JSON.parse(fs.readFileSync(file, 'utf8'))) };
      }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.profiling = false;
      await runner.shutdown().catch(() => undefined);
      runner.dispose();
    }
    log(`profile: ${result.error ?? `${result.summary?.rows.length} functions, ${result.path}`}`);
    this.broadcast({ type: 'profile', profile: result });
    return result;
  }

  /* ---------- recent files ---------- */

  private recentPath(): string | undefined {
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.pyokka');
    return dir ? path.join(dir, 'recent.json') : undefined;
  }

  private remember(file: BridgeFile): void {
    this.recent = [{ path: file.path, displayName: file.displayName, at: Date.now() }, ...this.recent.filter((r) => r.path !== file.path)].slice(0, RECENT_MAX);
    const where = this.recentPath();
    if (!where) return;
    try {
      fs.mkdirSync(path.dirname(where), { recursive: true });
      fs.writeFileSync(where, JSON.stringify(this.recent, null, 1));
    } catch (err) {
      log(`recent files not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The recent files that still exist and that Open would accept. */
  recentFiles(): RecentFile[] {
    return this.recent.filter((r) => this.mayOpen(r.path) === null);
  }

  /** null when `file` may become the main file: it exists, is of the runtime's language, and is under the run's root (the start file's directory, or `--cwd`). */
  private mayOpen(file: string): string | null {
    const full = path.resolve(file);
    const root = runDirs(this.rootFile, this.opts.cwd).root + path.sep;
    if (!full.startsWith(root)) return `${file} is outside ${root}`;
    if (languageFor(full) !== languageFor(this.rootFile)) return `${path.basename(full)} is not ${languageFor(this.rootFile)}, the runtime this bridge runs`;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return `no such file: ${file}`;
    return null;
  }

  /** Make `file` the main file: the page shows it, the bridge watches it and runs it. */
  async open(file: string): Promise<string | null> {
    const why = this.mayOpen(file);
    if (why) return why;
    await this.stopDebug();
    if (this.current) await this.runner.stop(this.current.runId).catch(() => undefined);
    this.file = readBridgeFile(file);
    this.definitionFiles.clear();
    this.buffer = undefined;
    this.lastWritten = undefined;
    this.remember(this.file);
    this.clearSourceWatchers();
    if (this.opts.watch) this.watchFile();
    this.broadcast(this.hello());
    void this.sendImports();
    await this.run('open');
    return null;
  }

  private clearSourceWatchers(): void {
    for (const watcher of this.sourceWatchers.values()) watcher.close();
    for (const timer of this.sourceWatchTimers.values()) clearTimeout(timer);
    this.sourceWatchers.clear();
    this.sourceWatchTimers.clear();
    this.watchedSources.clear();
  }

  private watchFile(): void {
    this.watchSource(this.file.path);
  }

  /**
   * Watch a file the page shows: the main file, an import a run instrumented, a file the page read.
   * A change re-sends it to the page; only the main file's change runs anything.
   */
  private watchSource(file: string): void {
    if (!this.opts.watch || this.watchedSources.has(file) || file === LOG_PATH) return;
    try {
      this.watchedSources.set(file, readBridgeFile(file).content);
    } catch {
      return;
    }
    // a directory watch can miss a write made while it starts (FSEvents on macOS): read the file again once it settled
    for (const ms of [250, 1000]) {
      const key = `${file}\0settle${ms}`;
      this.sourceWatchTimers.set(key, setTimeout(() => {
        this.sourceWatchTimers.delete(key);
        this.onDiskChange(file);
      }, ms));
    }
    const dir = path.dirname(file);
    if (this.sourceWatchers.has(dir)) return;
    // watch the directory: editors that save by rename replace the file's inode
    try {
      this.sourceWatchers.set(dir, fs.watch(dir, (_kind, name) => {
        for (const source of this.watchedSources.keys()) {
          if (path.dirname(source) !== dir || (name !== null && String(name) !== path.basename(source))) continue;
          const pending = this.sourceWatchTimers.get(source);
          if (pending) clearTimeout(pending);
          this.sourceWatchTimers.set(source, setTimeout(() => {
            this.sourceWatchTimers.delete(source);
            this.onDiskChange(source);
          }, 80));
        }
      }));
    } catch {
      /* a directory that cannot be watched: the page still reads the file on request */
    }
  }

  private onDiskChange(file: string): void {
    let next: BridgeFile;
    try {
      next = readBridgeFile(file);
    } catch {
      return; // mid-save or deleted: the next event brings it back
    }
    if (next.content === this.watchedSources.get(file)) return;
    this.watchedSources.set(file, next.content);
    if (file !== this.file.path) {
      // an imported file: the page shows the new text; the main file's run is what executes it
      this.broadcast({ type: 'file', file: next });
      return;
    }
    if (next.content === this.file.content) return;
    this.file = next;
    if (next.content === this.lastWritten) return; // our own save; the page already ran it
    this.buffer = undefined;
    this.broadcast({ type: 'file', file: next });
    if (this.runMode !== 'onDemand') void this.run('disk');
  }

  /* ---------- pages ---------- */

  private hello(): Extract<BridgeToPage, { type: 'hello' }> {
    return { type: 'hello', file: this.file, runtime: this.runtimeInfo, watch: this.opts.watch, canNarrate: this.views.canNarrate(), build: this.pageBuild() };
  }

  /** A rebuild replaces app.js, so its size and mtime name the page code this bridge serves. */
  private pageBuild(): string | undefined {
    try {
      const s = fs.statSync(path.join(this.opts.distDir, 'web', 'app.js'));
      return `${s.size}-${Math.round(s.mtimeMs)}`;
    } catch {
      return undefined;
    }
  }

  /**
   * The main file's local imports, sent as `file` messages before any run instrumented them, so the
   * page has their source (and `file.read` serves them). The runtime lists them with `_imports`.
   */
  private async sendImports(ws?: WebSocketConnection): Promise<void> {
    const main = this.file;
    const key = `${main.path}\0${main.content}`;
    let files = this.imports.get(key);
    if (!files) {
      files = await listImports(this.opts, main.path, runDirs(main.path, this.opts.cwd).root);
      this.imports.clear();
      this.imports.set(key, files);
      log(`imports of ${main.displayName}: ${files.length ? files.map((f) => path.relative(path.dirname(main.path), f)).join(', ') : 'none'}`);
    }
    if (this.file.path !== main.path) return; // Open switched files while the list was computed
    for (const file of files) {
      this.importFiles.add(file);
      try {
        const message: BridgeToPage = { type: 'file', file: readBridgeFile(file) };
        if (ws) this.sendTo(ws, message);
        else this.broadcast(message);
        this.watchSource(file);
      } catch {
        /* removed since it was listed */
      }
    }
  }

  private onPage(ws: WebSocketConnection): void {
    this.pages.add(ws);
    ws.on('close', () => {
      this.pages.delete(ws);
      for (const [id, waiter] of this.agentWaiters) {
        if (waiter.page !== ws) continue;
        this.agentWaiters.delete(id);
        waiter.finish({ result: null, error: 'the page disconnected before answering; read state again before retrying' });
      }
    });
    ws.on('message', (text) => {
      let msg: PageToBridge;
      try {
        msg = JSON.parse(text) as PageToBridge;
      } catch {
        return;
      }
      void this.onPageMessage(ws, msg);
    });
    log(`page connected (${this.pages.size} open)`);
    this.sendTo(ws, this.hello());
    if (this.breakpoints) this.sendTo(ws, { type: 'debug.breakpoints', set: this.breakpoints });
    void this.sendImports(ws);
    if (this.current) {
      this.sendTo(ws, { type: 'run.begin', ...this.current });
      for (const ev of this.events) this.sendTo(ws, { type: 'event', event: ev });
      for (const m of this.views.replay(this.current.runId)) this.sendTo(ws, m);
    }
    if (this.debugRun) {
      this.sendTo(ws, { type: 'debug.begin', runId: this.debugRun.runId, content: this.debugRun.content });
      for (const ev of this.debugRun.events) this.sendTo(ws, { type: 'debug.event', event: ev });
    }
  }

  private async onPageMessage(ws: WebSocketConnection, msg: PageToBridge): Promise<void> {
    switch (msg.type) {
      case 'run':
        if (msg.watch !== undefined) this.watch = pickWatches(msg.watch);
        if (msg.traceContext !== undefined) this.traceContext = msg.traceContext && Number.isInteger(msg.traceContext.step) ? { step: msg.traceContext.step, prefetch: Math.max(0, Math.min(200, Number(msg.traceContext.prefetch) || 10)) } : undefined;
        await this.run('page', msg.content);
        return;
      case 'narrate':
        await this.views.narrate();
        return;
      case 'tour':
        if (msg.action === 'narrate') await this.views.narrateTour();
        else await this.views.computeTour();
        return;
      case 'debug.breakpoints':
        this.breakpoints = Array.isArray(msg.set) ? msg.set : [];
        for (const page of this.pages) if (page !== ws) this.sendTo(page, { type: 'debug.breakpoints', set: this.breakpoints });
        return;
      case 'debug.start':
        await this.startDebug(Array.isArray(msg.breakpoints) ? msg.breakpoints : [], msg.exceptions === 'off' || msg.exceptions === 'raised' ? msg.exceptions : 'uncaught', typeof msg.content === 'string' ? msg.content : undefined, msg.stopOnEntry !== false);
        return;
      case 'debug.stop':
        await this.stopDebug();
        return;
      case 'debug.request': {
        const runner = this.debugRunner;
        try {
          if (!runner || !this.debugRun) throw new Error('no debug run');
          const reply = await runner.forward(msg.body);
          this.sendTo(ws, { type: 'reply', id: msg.id, reply });
        } catch (err) {
          this.sendTo(ws, { type: 'reply', id: msg.id, reply: { type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) } });
        }
        return;
      }
      case 'config':
        this.configPatch = { ...this.configPatch, ...pickConfig(msg.patch) };
        await this.run('settings');
        return;
      case 'stop':
        if (this.current) await this.runner.stop(this.current.runId);
        return;
      case 'request': {
        try {
          const reply = await this.runner.forward(msg.body);
          this.sendTo(ws, { type: 'reply', id: msg.id, reply });
        } catch (err) {
          this.sendTo(ws, { type: 'reply', id: msg.id, reply: { type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) } });
        }
        return;
      }
      case 'save':
        this.lastWritten = msg.content;
        fs.writeFileSync(this.file.path, msg.content);
        this.file = { ...this.file, content: msg.content };
        this.buffer = undefined;
        this.sendTo(ws, { type: 'saved', path: this.file.path });
        return;
      case 'profile':
        await this.profile(typeof msg.content === 'string' ? msg.content : undefined);
        return;
      case 'runMode':
        if (msg.mode === 'auto' || msg.mode === 'onSave' || msg.mode === 'onDemand') this.runMode = msg.mode;
        return;
      case 'recent':
        this.sendTo(ws, { type: 'recent', files: this.recentFiles() });
        return;
      case 'open': {
        const why = typeof msg.path === 'string' ? await this.open(msg.path) : 'no path';
        if (why) this.sendTo(ws, { type: 'runner.error', message: `cannot open: ${why}` });
        return;
      }
      case 'file.read': {
        if (msg.path === LOG_PATH) {
          this.sendTo(ws, { type: 'file', file: { path: LOG_PATH, displayName: 'Pyokka logs', language: 'log', content: LOG_LINES.join('\n') + '\n' } });
          return;
        }
        // only files a run instrumented, and the HTTP recording it wrote: the page cannot read arbitrary paths
        const known = [...this.events, ...(this.debugRun?.events ?? [])].some((e) => (e.type === 'file.instrumented' && e.path === msg.path) || (e.type === 'run.finished' && e.http?.file === msg.path));
        if (!known && !this.importFiles.has(msg.path)) return;
        try {
          this.watchSource(msg.path);
          this.sendTo(ws, { type: 'file', file: readBridgeFile(msg.path) });
        } catch {
          /* gone since the run */
        }
        return;
      }
      case 'state':
        // the page's own report after each change; /api/state asks the page instead of trusting a copy
        return;
      case 'agent.result': {
        const w = this.agentWaiters.get(msg.id);
        if (w?.page === ws) {
          this.agentWaiters.delete(msg.id);
          w.finish({ result: msg.result, error: msg.error });
        }
        return;
      }
    }
  }

  private sendTo(ws: WebSocketConnection, msg: BridgeToPage): void {
    ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: BridgeToPage): void {
    const text = JSON.stringify(msg);
    for (const p of this.pages) p.send(text);
  }

  /**
   * Hand a command to the one open page and accept only its answer. Two pages would each carry it
   * out (a step taken twice), and a second command would race the first, so both are refused.
   */
  agent(command: AgentCommand, timeoutMs = 15_000): Promise<{ result: unknown; error?: string }> {
    if (!this.pages.size && command.action === 'scratchpad' && (command.op === 'list' || command.op === 'history')) {
      // saved scratchpads are on disk: reading them needs no page
      try {
        const store = this.scratchStore();
        if (command.op === 'list') return Promise.resolve({ result: { scratchpads: store.list(), liveExecutionChanged: false } });
        if (!command.id) throw new Error('history needs a scratchpad id');
        return Promise.resolve({ result: { history: store.history(command.id), ...(command.version !== undefined ? { entry: store.get(command.id, command.version) } : {}), liveExecutionChanged: false } });
      } catch (error) {
        return Promise.resolve({ result: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!this.pages.size) return Promise.resolve({ result: null, error: `no page is open: the person must open ${this.url} in one browser tab first` });
    if (this.pages.size > 1) return Promise.resolve({ result: null, error: `${this.pages.size} pages are open; close all but one before controlling this session (no command was sent)` });
    // a waitPause holds no pause of its own, so one other command may run beside it (the step it waits for)
    const wait = command.action === 'waitPause';
    const busy = [...this.agentWaiters.values()].filter((w) => w.wait === wait).length;
    if (busy) return Promise.resolve({ result: null, error: wait ? 'a waitPause is already pending; wait for its result' : 'a page command is still pending; wait for its result before sending another' });
    const page = [...this.pages][0]!;
    const id = this.nextAgentId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.agentWaiters.delete(id);
        resolve({ result: null, error: 'the page did not answer' });
      }, timeoutMs);
      this.agentWaiters.set(id, {
        page,
        wait,
        finish: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      this.sendTo(page, { type: 'agent', id, command });
    });
  }

  /* ---------- http ---------- */

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!sameOrigin(req.headers, this.opts.port)) return reply(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', this.url);
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const answer = await this.agent({ action: 'state' });
      return json(res, answer.error ? 409 : 200, { url: this.url, file: this.file.path, runtime: this.runtimeInfo, pages: this.pages.size, state: answer.result ?? null, ...(answer.error ? { error: answer.error } : {}) });
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      // a JSON body forces a CORS preflight in any browser, which this server never approves
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(res, 415, 'send application/json');
      let command: AgentCommand;
      try {
        command = JSON.parse(await readBody(req)) as AgentCommand;
      } catch {
        return reply(res, 400, 'bad JSON');
      }
      if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.action !== 'string') return json(res, 400, { error: 'command must be an object with an action' });
      if (command.action === 'profile') {
        // the bridge runs it; the page shows the table when the answer arrives
        const p = await this.profile();
        return json(res, p.error ? 409 : 200, { result: p.summary ? { path: p.path, totalMs: p.summary.totalMs, rows: p.summary.rows.slice(0, 20) } : null, ...(p.error ? { error: p.error } : {}) });
      }
      // a waitPause holds the page for up to its own timeout (25 s at most), a scratchpad its seeding and
      // its run (5 s); every other command answers within 15 s
      const r = await this.agent(command, command.action === 'waitPause' ? Math.min(Number(command.timeoutMs ?? 25_000), 25_000) + 5_000 : command.action === 'scratchpad' ? 45_000 : undefined);
      return json(res, r.error ? 409 : 200, r);
    }
    if (url.pathname === '/api/definitions' && req.method === 'POST') return this.definitions(req, res);
    if (url.pathname.startsWith('/api/scratchpad/') && req.method === 'POST') return this.scratchpad(url.pathname.slice('/api/scratchpad/'.length), req, res);
    if (req.method !== 'GET') return reply(res, 405, 'method not allowed');
    if (url.pathname === '/api/source') {
      // the definition tab's text: only the running file, files a run instrumented, and definition targets
      const file = url.searchParams.get('path') ?? '';
      if (!this.knownSource(file)) return reply(res, 403, 'unknown source file');
      try {
        return json(res, 200, { path: file, content: fs.readFileSync(file, 'utf8') });
      } catch {
        return reply(res, 404, 'not found');
      }
    }
    if (url.pathname === '/api/profile') {
      // the last profile's .cpuprofile, for Chrome DevTools (Performance > Load profile) or VS Code
      if (!this.lastProfile || !fs.existsSync(this.lastProfile)) return reply(res, 404, 'no profile yet: run Profile first');
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${path.basename(this.lastProfile)}"` });
      fs.createReadStream(this.lastProfile).pipe(res);
      return;
    }
    return this.serveStatic(url.pathname, res);
  }

  /* ---------- scratchpad ---------- */

  private scratchStore(): ScratchpadStore {
    const dir = this.opts.stateDir ?? path.join(os.homedir(), '.pyokka');
    return new ScratchpadStore(dir ? path.join(dir, 'scratchpads') : '');
  }

  /**
   * POST /api/scratchpad/{prepare,seed,format,run,sandbox}: one `_scratch` request to the Python
   * runtime (python/pyokka_runtime/scratchpad.py), which runs an experiment in a `python -I` of its
   * own; /library reads and writes the saved versions.
   */
  private async scratchpad(op: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(res, 415, 'send application/json');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('send an object');
    } catch {
      return reply(res, 400, 'bad JSON');
    }
    try {
      if (op === 'library') {
        const store = this.scratchStore();
        if (body['op'] === 'list') return json(res, 200, store.list());
        if (body['op'] === 'get') return json(res, 200, store.get(String(body['id']), body['version'] === undefined ? undefined : Number(body['version'])));
        if (body['op'] === 'history') return json(res, 200, store.history(String(body['id'])));
        if (body['op'] === 'save') return json(res, 200, store.save(body['entry'] as Parameters<ScratchpadStore['save']>[0]));
        throw new Error('library op is list, get, history or save');
      }
      if (!['prepare', 'seed', 'format', 'run', 'sandbox'].includes(op)) return reply(res, 404, 'not found');
      if ((op === 'prepare' || op === 'run') && !this.knownSource(String(body['file']))) return reply(res, 403, 'unknown source file');
      // the experiment runs under the interpreter the program runs under (a venv's, for its packages)
      const python = this.runtimeInfo.ready?.executable;
      return json(res, 200, await scratchRequest(this.opts, { ...body, op, ...(op === 'run' && python ? { python } : {}) }));
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private knownSource(file: string): boolean {
    return file === this.file.path || this.definitionFiles.has(file) || [...this.events, ...(this.debugRun?.events ?? [])].some((e) => e.type === 'file.instrumented' && e.path === file);
  }

  /** POST {file, content, offset}: the runtime resolves the definition (ast only, project files); the answer carries each target's text. */
  private async definitions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(res, 415, 'send application/json');
    let body: { file?: unknown; content?: unknown; offset?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return reply(res, 400, 'bad JSON');
    }
    if (typeof body.file !== 'string' || typeof body.content !== 'string' || typeof body.offset !== 'number' || !Number.isInteger(body.offset)) return reply(res, 400, 'send {file, content, offset}');
    if (!this.knownSource(body.file)) return reply(res, 403, 'unknown source file');
    let answer: RunnerMessage;
    try {
      answer = await this.runner.forward({ type: 'definition', source: body.content, path: body.file, offset: body.offset });
    } catch (err) {
      return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    if (answer.type !== 'definition') return json(res, 409, { error: answer.type === 'error' ? answer.message : `unexpected ${answer.type}` });
    const out: (DefinitionLocation & { content: string })[] = [];
    for (const loc of answer.locations) {
      try {
        out.push({ ...loc, content: fs.readFileSync(loc.path, 'utf8') });
        this.definitionFiles.add(loc.path);
      } catch {
        /* gone since it was found */
      }
    }
    return json(res, 200, out);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const rel = pathname === '/' ? 'web/index.html' : decodeURIComponent(pathname.slice(1));
    const full = path.resolve(this.opts.distDir, rel);
    const allowed = [path.join(this.opts.distDir, 'web') + path.sep, path.join(this.opts.distDir, 'webview') + path.sep];
    if (!allowed.some((dir) => full.startsWith(dir)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return reply(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  }
}

/** Watch requests from a page: an id and an expression each, at most 50. */
export function pickWatches(list: unknown): WatchRequest[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w): w is WatchRequest => !!w && typeof w === 'object' && typeof (w as WatchRequest).id === 'string' && typeof (w as WatchRequest).exp === 'string')
    .slice(0, 50)
    .map((w) => ({ id: w.id, exp: w.exp }));
}

/** Only the keys a page may set, with the right types; anything else is dropped. */
export function pickConfig(patch: ConfigPatch): ConfigPatch {
  const out: ConfigPatch = {};
  if (typeof patch.autoLog === 'boolean') out.autoLog = patch.autoLog;
  if (typeof patch.libraryCode === 'boolean') out.libraryCode = patch.libraryCode;
  if (typeof patch.recordLocals === 'boolean') out.recordLocals = patch.recordLocals;
  if (typeof patch.maskSecrets === 'boolean') out.maskSecrets = patch.maskSecrets;
  if (typeof patch.timeoutMs === 'number' && patch.timeoutMs >= 0) out.timeoutMs = patch.timeoutMs;
  if (patch.http === 'off' || patch.http === 'record' || patch.http === 'replay') out.http = patch.http;
  return out;
}

/**
 * The run config: the extension's defaults, with every changed local recorded (the browser's Time
 * Machine shows variables at any step, so it is on unless the page turned it off), then the page's patch.
 */
export function runConfig(patch: ConfigPatch): RunConfig {
  const { maskSecrets, ...rest } = patch;
  return {
    ...DEFAULT_RUN_CONFIG,
    recordLocals: true,
    ...rest,
    secrets: { ...DEFAULT_RUN_CONFIG.secrets, ...(maskSecrets === undefined ? {} : { mask: maskSecrets }) },
  };
}

/**
 * The project files `file` imports, listed by the runtime (`<runtime> _imports FILE --root DIR`,
 * stdlib `ast` and import resolution, site-packages left out). Empty for a runtime that is not
 * `... serve` or does not know `_imports`.
 */
export function listImports(opts: Pick<ServerOptions, 'runtime' | 'python' | 'distDir' | 'file'>, file: string, root = path.dirname(file)): Promise<string[]> {
  const cmd = runtimeCommand(opts);
  if (cmd.args[cmd.args.length - 1] !== 'serve') return Promise.resolve([]);
  const args = [...cmd.args.slice(0, -1), '_imports', file, '--root', root];
  return new Promise((resolve) => {
    execFile(cmd.command, args, { cwd: cmd.cwd, env: { ...process.env, ...cmd.env }, timeout: 15_000, maxBuffer: 4_000_000 }, (err, stdout) => {
      if (err) {
        log(`imports not listed: ${err.message.split('\n')[0]}`);
        return resolve([]);
      }
      try {
        const list = JSON.parse(stdout) as unknown;
        resolve(Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/** One `<runtime> _scratch` request (JSON on stdin, JSON on stdout); a runtime that is not `... serve` has none. */
export function scratchRequest(opts: Pick<ServerOptions, 'runtime' | 'python' | 'distDir' | 'file'>, request: Record<string, unknown>): Promise<unknown> {
  const cmd = runtimeCommand(opts);
  if (cmd.args[cmd.args.length - 1] !== 'serve') return Promise.reject(new Error('the Scratchpad needs the Python runtime (pyokka_runtime serve)'));
  return new Promise((resolve, reject) => {
    const child = execFile(cmd.command, [...cmd.args.slice(0, -1), '_scratch'], { cwd: cmd.cwd, env: { ...process.env, ...cmd.env }, timeout: 30_000, maxBuffer: 8_000_000 }, (err, stdout, stderr) => {
      let answer: unknown;
      try {
        answer = JSON.parse(stdout);
      } catch {
        return reject(new Error(`scratchpad runtime failed: ${(err?.message ?? stderr ?? '').split('\n').slice(0, 3).join(' ')}`));
      }
      if (answer && typeof answer === 'object' && 'error' in answer && typeof (answer as { error: unknown }).error === 'string') return reject(new Error((answer as { error: string }).error));
      resolve(answer);
    });
    child.stdin?.end(JSON.stringify(request));
  });
}

function readBridgeFile(file: string): BridgeFile {
  const full = path.resolve(file);
  return { path: full, displayName: path.basename(full), language: languageFor(full), content: fs.readFileSync(full, 'utf8') };
}

function reply(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) req.destroy(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let verbose = false;
/** the bridge's recent log lines, for Show Logs (`--verbose` also prints them) */
const LOG_LINES: string[] = [];
function log(line: string): void {
  LOG_LINES.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  if (LOG_LINES.length > 2000) LOG_LINES.splice(0, LOG_LINES.length - 2000);
  if (verbose) process.stderr.write(`[pyokka web] ${line}\n`);
}

function loadRecent(file: string | undefined): RecentFile[] {
  if (!file) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(list) ? list.filter((r): r is RecentFile => !!r && typeof r.path === 'string' && typeof r.displayName === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/* ---------- command line ---------- */

const USAGE = `usage:
  pyokka-web FILE [--port N] [--cwd DIR] [--runtime python|"CMD ARGS"] [--python PATH] [--open] [--no-run] [--no-watch] [--verbose]
  pyokka-web ctl [--port N] state | goto STEP | step next|into|over|out|back|backOver|backOut | line N
                 | say TEXT [--line N] [--step N] | clear | start | stop | run | eval EXPR | peek NAME[.KEY...]
                 | var NAME | why NAME [--step N] | watch EXPR [--remove]
                 | break LINE [on|off] [--if COND] | debug start|continue|step [into|over|out]|pause|stop|state
                 | wait-pause [--after N] [--timeout MS]
                 | story | profile | values | definition LINE COLUMN
                 | scratchpad open|experiment|create|state|update|run|restore|close|save|list|load|history
                     [--id ID] [--version N] [--title NAME] [--line N] [--code FILE] [--inputs FILE] [--mocks FILE]
                     [--auto-run true|false] [--data FILE] | scratchpad say [TEXT] [--line N]
  --cwd DIR runs FILE in DIR, and makes DIR the project root when it holds FILE: code under DIR is
  the project's, which the debugger stops and steps in (outside the root is library code).
  Step and debug commands take --say TEXT to show a narration bubble at the new position.
  scratchpad open copies the function around the paused line (or --line) with the pause's values as
  Inputs and runs it in a separate python -I (network denied on macOS); experiment does the same with
  --code; --inputs/--mocks/--code read Python source from a file, --data a JSON object of the fields.
  scratchpad say shows TEXT in a bubble under a line of the scratchpad's code (--line, else its
  cursor line); with no TEXT it clears the bubble.
  Any command takes --expect-source live|recording --expect-run ID --expect-step N --expect-frame N
  --expect-file PATH (step and file accept null), from state.context: a stale one is refused.`;

const EXPECT_FLAGS: Record<string, keyof NonNullable<AgentCommand['expect']>> = { '--expect-source': 'source', '--expect-run': 'runId', '--expect-step': 'step', '--expect-frame': 'frame', '--expect-file': 'file' };

/** Parse `ctl` arguments into a command. Exported for tests. */
export function parseCtl(args: string[]): AgentCommand {
  const expect: NonNullable<AgentCommand['expect']> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const key = EXPECT_FLAGS[flag];
    if (!key) {
      rest.push(flag);
      continue;
    }
    const value = args[++i];
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`);
    if ((key === 'step' || key === 'file') && value === 'null') expect[key] = null;
    else if (key === 'step' || key === 'frame') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a whole number of 0 or more`);
      expect[key] = n;
    } else if (key === 'source') {
      if (value !== 'live' && value !== 'recording') throw new Error(`${flag} needs live or recording`);
      expect.source = value;
    } else expect[key] = value;
  }
  const command = parseCtlAction(rest);
  return Object.keys(expect).length ? { ...command, expect } : command;
}

function parseCtlAction(args: string[]): AgentCommand {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--remove') flags.set('remove', '');
    else if (a === '--auto-run' && args[i + 1] !== 'true' && args[i + 1] !== 'false') flags.set('auto-run', 'true');
    else if (a.startsWith('--')) flags.set(a.slice(2), args[++i] ?? '');
    else rest.push(a);
  }
  const [action, ...words] = rest;
  const say = flags.get('say');
  const int = (v: string | undefined, what: string): number => {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isInteger(n)) throw new Error(`${what} must be a whole number`);
    return n;
  };
  switch (action) {
    case 'state':
    case 'clear':
    case 'start':
    case 'stop':
    case 'run':
    case 'story':
    case 'profile':
    case 'values':
      return { action };
    case 'definition':
      return { action, line: int(words[0], 'LINE'), column: int(words[1], 'COLUMN') };
    case 'goto':
      return { action, step: int(words[0], 'STEP'), ...(say ? { say } : {}) };
    case 'step': {
      const kind = (words[0] ?? 'into') as Extract<AgentCommand, { action: 'step' }>['kind'];
      if (!['next', 'into', 'over', 'out', 'back', 'backOver', 'backOut'].includes(kind)) throw new Error(`unknown step kind ${kind}`);
      return { action, kind, ...(say ? { say } : {}) };
    }
    case 'line':
      return { action, line: int(words[0], 'LINE'), ...(say ? { say } : {}) };
    case 'say':
      return {
        action,
        text: words.join(' '),
        ...(flags.has('line') ? { line: int(flags.get('line'), '--line') } : {}),
        ...(flags.has('step') ? { step: int(flags.get('step'), '--step') } : {}),
      };
    case 'eval':
      return { action, expression: words.join(' ') };
    case 'wait-pause':
      return { action: 'waitPause', ...(flags.has('after') ? { after: int(flags.get('after'), '--after') } : {}), ...(flags.has('timeout') ? { timeoutMs: Math.min(int(flags.get('timeout'), '--timeout'), 25_000) } : {}) };
    case 'peek':
      if (!words.length) throw new Error('peek needs NAME (a binding of the paused frame; items.0.name walks into it)');
      return { action, name: words.join(' ') };
    case 'var':
      return { action, name: words.join(' ') };
    case 'why':
      return { action, name: words.join(' '), ...(flags.has('step') ? { step: int(flags.get('step'), '--step') } : {}) };
    case 'watch':
      return { action, exp: words.join(' '), ...(flags.has('remove') ? { remove: true } : {}) };
    case 'break':
    case 'breakpoint':
      return { action: 'breakpoint', line: int(words[0], 'LINE'), ...(words[1] === 'on' ? { on: true } : words[1] === 'off' ? { on: false } : {}), ...(flags.has('if') ? { condition: flags.get('if') } : {}) };
    case 'debug': {
      const op = (words[0] ?? 'state') as Extract<AgentCommand, { action: 'debug' }>['op'];
      if (!['start', 'continue', 'step', 'pause', 'stop', 'state'].includes(op)) throw new Error(`unknown debug op ${op}`);
      const kind = words[1] as 'into' | 'over' | 'out' | undefined;
      if (op === 'step' && kind && !['into', 'over', 'out'].includes(kind)) throw new Error(`unknown step kind ${kind}`);
      return { action, op, ...(op === 'step' ? { kind: kind ?? 'over' } : {}), ...(say ? { say } : {}) };
    }
    case 'scratchpad': {
      const op = words[0] as ScratchCommand['op'];
      if (!SCRATCH_OPS.includes(op)) throw new Error(`scratchpad needs ${SCRATCH_OPS.join('|')}`);
      const read = (flag: string): string | undefined => (flags.has(flag) ? fs.readFileSync(flags.get(flag)!, 'utf8') : undefined);
      const data = flags.has('data') ? (JSON.parse(read('data')!) as Partial<ScratchCommand>) : {};
      const code = read('code'), inputs = read('inputs'), mocks = read('mocks');
      return {
        ...data,
        action,
        op,
        ...(flags.has('id') ? { id: flags.get('id') } : {}),
        ...(flags.has('title') ? { title: flags.get('title') } : {}),
        ...(flags.has('version') ? { version: int(flags.get('version'), '--version') } : {}),
        ...(flags.has('line') ? { line: int(flags.get('line'), '--line') } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(inputs !== undefined ? { inputs } : {}),
        ...(mocks !== undefined ? { mocks } : {}),
        ...(flags.has('auto-run') ? { autoRun: flags.get('auto-run') !== 'false' } : {}),
        ...(op === 'say' ? { text: words.slice(1).join(' ') } : {}),
      };
    }
    default:
      throw new Error(`unknown command ${action ?? '(none)'}`);
  }
}

/** ctl's exit status: 1 when the bridge refused, and for a scratchpad run or experiment that did not complete. */
export function ctlExitCode(command: AgentCommand, ok: boolean, body: string): number {
  if (!ok) return 1;
  if (command.action !== 'scratchpad' || (command.op !== 'run' && command.op !== 'experiment')) return 0;
  try {
    const result = (JSON.parse(body) as { result?: { status?: string } }).result;
    return result?.status === 'completed' ? 0 : 1;
  } catch {
    return 1;
  }
}

async function ctl(args: string[]): Promise<number> {
  let port = Number(process.env['PYOKKA_PORT'] ?? DEFAULT_PORT);
  const i = args.indexOf('--port');
  if (i >= 0) {
    port = Number(args[i + 1]);
    args = [...args.slice(0, i), ...args.slice(i + 2)];
  }
  const command = parseCtl(args);
  const base = `http://127.0.0.1:${port}`;
  let res: Response;
  try {
    res = command.action === 'state'
      ? await fetch(`${base}/api/state`)
      : await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
  } catch (err) {
    throw new Error(ctlConnectError(err, port));
  }
  const body = await res.text();
  process.stdout.write(formatJson(body) + '\n');
  return ctlExitCode(command, res.ok, body);
}

/** What a failed connection means: nothing served, or a sandbox that blocked it (which looks the same from inside). Exported for tests. */
export function ctlConnectError(err: unknown, port: number): string {
  const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  if (code === 'EPERM' || code === 'EACCES') return `the connection to 127.0.0.1:${port} was refused by the system (${code}), not by a server: a sandbox without network access blocks it, whether or not a page is open; run this outside the sandbox`;
  if (code === 'ECONNREFUSED') return `no Pyokka page is served on 127.0.0.1:${port}: start one with \`pyokka web FILE\`, or pass the --port it was started with`;
  return err instanceof Error ? err.message : String(err);
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'ctl') {
    try {
      return await ctl(argv.slice(1));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
      return 2;
    }
  }
  const opts: ServerOptions = {
    file: '',
    port: Number(process.env['PYOKKA_PORT'] ?? DEFAULT_PORT),
    host: '127.0.0.1',
    runtime: process.env['PYOKKA_RUNTIME'] ?? '',
    python: process.env['PYOKKA_PYTHON'] ?? 'python3',
    explainCommand: process.env['PYOKKA_EXPLAIN_COMMAND'],
    watch: true,
    open: false,
    distDir: path.resolve(__dirname, '..'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--runtime') opts.runtime = argv[++i] ?? '';
    else if (a === '--python') opts.python = argv[++i] ?? opts.python;
    else if (a === '--cwd') opts.cwd = argv[++i] ?? '';
    else if (a === '--open') opts.open = true;
    else if (a === '--no-watch') opts.watch = false;
    else if (a === '--no-run') opts.initialRun = false;
    else if (a === '--verbose') verbose = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE + '\n');
      return 0;
    } else if (!opts.file) opts.file = a;
    else {
      process.stderr.write(`unexpected argument ${a}\n${USAGE}\n`);
      return 2;
    }
  }
  if (!opts.file || !fs.existsSync(opts.file)) {
    process.stderr.write(`${opts.file ? `no such file: ${opts.file}` : 'name a file to run'}\n${USAGE}\n`);
    return 2;
  }
  if (opts.cwd !== undefined && (!opts.cwd || !fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory())) {
    process.stderr.write(`--cwd needs a directory${opts.cwd ? `: no such directory ${opts.cwd}` : ''}\n${USAGE}\n`);
    return 2;
  }
  if (opts.cwd) opts.cwd = path.resolve(opts.cwd);
  if (!opts.runtime) {
    const lang = languageFor(opts.file);
    if (lang !== 'python') {
      process.stderr.write(`${path.basename(opts.file)} is not a Python file: pass --runtime "CMD ARGS" (or set PYOKKA_RUNTIME) with a command that speaks docs/PROTOCOL.md on stdio\n`);
      return 2;
    }
    opts.runtime = 'python';
  }
  const server = new BridgeServer(opts);
  await server.start();
  process.stdout.write(`Pyokka: ${server.url}  (${path.basename(opts.file)}, ${opts.initialRun === false ? 'not run yet, ' : ''}${opts.watch ? 're-runs on save' : 'no file watch'}; Ctrl+C stops)\n`);
  if (opts.open) openBrowser(server.url);
  const stop = () => void server.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return -1;
}

if (require.main === module) {
  // under VS Code's Electron as Node (`pyokka web` without node on PATH) the flag has done its work at
  // startup; the runtimes and the programs they run must not inherit it, or an Electron app they start runs as Node
  delete process.env['ELECTRON_RUN_AS_NODE'];
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
