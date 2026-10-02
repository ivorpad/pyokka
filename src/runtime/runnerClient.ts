/**
 * Client for one `python -m pyokka_runtime serve` process: NDJSON both ways, request/response
 * by `id`, typed run events, restart with backoff after a crash.
 * vscode-free so it can be exercised with a fake runner in unit tests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Completions, DebugRequest, HostRequest, RunEvent, RunnerMessage, RunRequest, StatementBinding, ValueBag, ValueNode } from '../shared/protocol';
import { NdjsonDecoder, encodeNdjson } from './ndjson';
import { execResult, type ExecResult } from '../debug/debugExec';
import { pyokkaHome } from '../util/paths';

export interface ReadyInfo {
  pythonVersion: string;
  executable: string;
  platform: string;
  capabilities: string[];
  /** pyokka_runtime.__version__ (absent from older runtimes) */
  runtimeVersion?: string;
}

/** The capability a `record: false` debug session needs; an older runtime in `dist/python` lacks it. */
export const RECORD_CAPABILITY = 'record';

/** The capability `exec` needs: a runtime that can run a statement in the paused frame. */
export const EXEC_CAPABILITY = 'exec';

/** The capability `--record-from` needs: a runtime that can start recording at a pause. */
export const RECORD_FROM_CAPABILITY = 'recordFrom';

/** What to tell the caller when the runtime cannot record from a pause. */
export const RECORD_FROM_CAPABILITY_ERROR = 'the Pyokka runtime in dist/python is older than the extension: it cannot start recording at a pause. Reinstall the extension, or debug with --record.';

/** What to tell the caller when the runtime cannot run code at the pause. */
export const EXEC_CAPABILITY_ERROR = 'the Pyokka runtime in dist/python is older than the extension: it cannot run code at a pause. Reinstall the extension.';

/** What to tell the user when the runtime cannot serve a Debugger session. */
export const RECORD_CAPABILITY_ERROR = 'the Pyokka runtime in dist/python is older than the extension: it cannot run a debug session without recording. Reinstall the extension, or run the Debugger with "record": true.';

export interface RunnerClientOptions {
  /** executable + args; defaults to `python -m pyokka_runtime serve` */
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  /** protocol version string sent in `hello` */
  version?: string;
  log?: (line: string) => void;
  maxRestarts?: number;
  requestTimeoutMs?: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type HostBody = DistributiveOmit<HostRequest, 'id'>;

type Pending = { resolve: (msg: RunnerMessage) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout };

export interface RunnerClientEvents {
  event: [RunEvent];
  runnerError: [message: string, detail?: string];
  exit: [code: number | null, signal: NodeJS.Signals | null, willRestart: boolean];
  ready: [ReadyInfo];
  stderr: [text: string];
}

export class RunnerClient extends EventEmitter<RunnerClientEvents> {
  private proc: ChildProcess | undefined;
  private starting: Promise<ReadyInfo> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private restartAttempts = 0;
  private lastStart = 0;
  private disposed = false;
  ready: ReadyInfo | undefined;

  constructor(private readonly options: RunnerClientOptions) {
    super();
  }

  get alive(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Spawn (or re-spawn) the runner and complete the `hello` handshake. */
  start(): Promise<ReadyInfo> {
    if (this.disposed) return Promise.reject(new Error('runner disposed'));
    if (this.alive && this.ready) return Promise.resolve(this.ready);
    if (this.starting) return this.starting;
    this.starting = this.spawnAndHello().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawnAndHello(): Promise<ReadyInfo> {
    const sinceLast = Date.now() - this.lastStart;
    if (this.lastStart && sinceLast < 30_000) {
      const delay = Math.min(500 * 2 ** this.restartAttempts, 8000);
      this.restartAttempts++;
      if (this.restartAttempts > (this.options.maxRestarts ?? 5)) {
        throw new Error('Pyokka runner keeps crashing; giving up. Check the Pyokka output channel.');
      }
      await new Promise((r) => setTimeout(r, delay));
    } else this.restartAttempts = 0;
    this.lastStart = Date.now();
    const args = this.options.args ?? ['-m', 'pyokka_runtime', 'serve'];
    this.options.log?.(`spawn ${this.options.command} ${args.join(' ')} (cwd ${this.options.cwd})`);
    const proc = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      // PYOKKA_HOME resolved here (`~` expanded) so the runtime and any CLI it starts use the window's directory
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYOKKA_HOME: pyokkaHome(), ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this.ready = undefined;
    const decoder = new NdjsonDecoder((line) => this.options.log?.(`runner sent non-JSON: ${line.slice(0, 200)}`));
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) this.handleMessage(msg as RunnerMessage);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.options.log?.(`runner stderr: ${text.trimEnd()}`);
      this.emit('stderr', text);
    });
    proc.on('error', (err) => {
      this.options.log?.(`runner spawn error: ${err.message}`);
      this.failPending(new Error(`Pyokka runner failed to start: ${err.message}`));
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.ready = undefined;
      const willRestart = !this.disposed;
      this.options.log?.(`runner exited code=${code} signal=${signal}`);
      this.failPending(new Error(`Pyokka runner exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`));
      this.emit('exit', code, signal, willRestart);
    });
    const reply = await this.send({ type: 'hello', version: this.options.version ?? '1' }, 20_000);
    if (reply.type !== 'ready') throw new Error(`unexpected handshake reply: ${reply.type}`);
    const info: ReadyInfo = { pythonVersion: reply.pythonVersion, executable: reply.executable, platform: reply.platform, capabilities: reply.capabilities ?? [], runtimeVersion: reply.runtimeVersion };
    this.ready = info;
    this.emit('ready', info);
    return info;
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(msg: RunnerMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'runner.error') {
      this.emit('runnerError', msg.message, msg.detail);
      return;
    }
    if ('id' in msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    if ('runId' in msg) this.emit('event', msg as RunEvent);
  }

  private send(body: HostBody, timeoutMs?: number): Promise<RunnerMessage> {
    const proc = this.proc;
    if (!proc?.stdin || !this.alive) return Promise.reject(new Error('Pyokka runner is not running'));
    const id = this.nextId++;
    return new Promise<RunnerMessage>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      const t = timeoutMs ?? this.options.requestTimeoutMs;
      if (t && t > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Pyokka runner did not answer "${body.type}" within ${t}ms`));
        }, t);
      }
      this.pending.set(id, pending);
      proc.stdin!.write(encodeNdjson({ ...body, id }), (err) => {
        if (err) {
          this.pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          reject(err);
        }
      });
    });
  }

  private async request(body: HostBody, timeoutMs?: number): Promise<RunnerMessage> {
    await this.start();
    const reply = await this.send(body, timeoutMs);
    if (reply.type === 'error') throw new Error(reply.message);
    return reply;
  }

  /** Send a run; resolves when the runner acknowledged it (events stream afterwards). */
  async run(req: Omit<RunRequest, 'type' | 'id'>): Promise<void> {
    await this.request({ type: 'run', ...req });
  }

  /**
   * Evaluate a side-effect-free expression against the finished run's namespace (no re-run), or in
   * the frame `frameId` names while a debug run is paused (innermost by default).
   */
  async evaluate(runId: string, expression: string, opts: { frameId?: number } = {}): Promise<{ text: string; valueBag: ValueBag }> {
    const reply = await this.request({ type: 'evaluate', runId, expression, ...(opts.frameId ? { frameId: opts.frameId } : {}) }, 15_000);
    if (reply.type !== 'evaluated') throw new Error(`unexpected evaluate reply: ${reply.type}`);
    return { text: reply.text, valueBag: reply.valueBag };
  }

  /**
   * Run a statement in the paused frame (docs/design/debugger-product.md, 2.7). Only reachable at
   * a pause: the runner answers an `error` reply while the program runs and after it ended, and
   * the caller surfaces that message. Any attempt sets `modified`.
   */
  async exec(runId: string, source: string, opts: { frameId?: number } = {}): Promise<ExecResult> {
    const reply = await this.request({ type: 'exec', runId, source, ...(opts.frameId ? { frameId: opts.frameId } : {}) }, 30_000);
    if (reply.type !== 'executed') throw new Error(`unexpected exec reply: ${reply.type}`);
    return execResult(reply);
  }

  /** Completions for a watch expression typed so far: names in scope, or attributes after a dot (same namespace as `evaluate`). */
  async complete(runId: string, expression: string, limit?: number): Promise<Completions> {
    const reply = await this.request({ type: 'complete', runId, expression, ...(limit ? { limit } : {}) }, 15_000);
    if (reply.type !== 'completed') throw new Error(`unexpected complete reply: ${reply.type}`);
    return { prefix: reply.prefix, items: reply.items, ...(reply.error ? { error: reply.error } : {}) };
  }

  /** What one edited statement would show, from the finished run's state (no re-run). */
  async shadow(runId: string, source: string): Promise<{ text: string; valueBag: ValueBag; kind?: string; context?: string }> {
    const reply = await this.request({ type: 'shadow', runId, source }, 15_000);
    if (reply.type !== 'evaluated') throw new Error(`unexpected shadow reply: ${reply.type}`);
    return { text: reply.text, valueBag: reply.valueBag, kind: reply.kind, context: reply.context };
  }

  /** Instrumented source of one file of the finished run (library files do not send it with `file.instrumented`). */
  async source(runId: string, fileId: number): Promise<string | undefined> {
    const reply = await this.request({ type: 'source', runId, fileId }, 15_000);
    if (reply.type !== 'source') throw new Error(`unexpected source reply: ${reply.type}`);
    return reply.instrumentedSource ?? undefined;
  }

  /** What each statement of `source` assigns and reads (from its AST; stateless, no run needed). */
  async bindings(source: string): Promise<StatementBinding[]> {
    const reply = await this.request({ type: 'bindings', source }, 15_000);
    if (reply.type !== 'bindings') throw new Error(`unexpected bindings reply: ${reply.type}`);
    return reply.statements;
  }

  async expand(runId: string, valueId: string, queryPath: string[]): Promise<ValueNode> {
    const reply = await this.request({ type: 'expand', runId, valueId, queryPath }, 30_000);
    if (reply.type !== 'value') throw new Error(`unexpected expand reply: ${reply.type}`);
    return reply.node;
  }

  /** A debugger action on the run in progress (docs/PROTOCOL.md `debug`); resolves with the runtime's `debug.result` fields. */
  async debug(runId: string, body: Omit<DebugRequest, 'type' | 'id' | 'runId'>): Promise<Record<string, unknown>> {
    const reply = await this.request({ type: 'debug', runId, ...body }, 30_000);
    if (reply.type !== 'debug.result') throw new Error(`unexpected debug reply: ${reply.type}`);
    const { type: _type, id: _id, ...rest } = reply;
    return rest;
  }

  async stop(runId: string): Promise<void> {
    if (!this.alive) return;
    try {
      await this.send({ type: 'stop', runId }, 10_000);
    } catch {
      /* runner gone; nothing to stop */
    }
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc || !this.alive) return;
    try {
      proc.stdin?.write(encodeNdjson({ type: 'shutdown', id: this.nextId++ }));
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** true once `dispose` ran: every request is refused from then on */
  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    const proc = this.proc;
    this.proc = undefined;
    this.failPending(new Error('Pyokka runner disposed'));
    if (proc && proc.exitCode === null) {
      try {
        proc.stdin?.write(encodeNdjson({ type: 'shutdown', id: this.nextId++ }));
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 1500).unref();
    }
    this.removeAllListeners();
  }
}
