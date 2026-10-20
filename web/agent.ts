/**
 * What an agent can do with the page: read where the Time Machine is, move it, and explain a line
 * in a bubble under it. The same commands arrive three ways: from the bridge's HTTP API (and the
 * `ctl` subcommand that calls it), and as WebMCP tools for an agent working in the browser itself.
 */
import type { AgentCommand, PageState } from './bridgeProtocol';
import type { Link, PageHost } from './pageHost';
import { renderValueNode } from '../src/views/valueText';
import type { ValueNode } from '../src/shared/protocol';
import { SCRATCH_OPS, type ScratchCommand } from './scratchpadProtocol';
import { withBlock } from './agentBlock';
import type { WebMCP } from 'webmcp-types';
import { WebMcpResults, legacyWebMcpResult, type ResultOutcome } from './webMcpResults';

/** pages with a command in progress: a second one is refused rather than raced against the first */
interface MutationLease { settled: () => boolean }
const pending = new WeakMap<PageHost, MutationLease>();
export interface AgentExecutionOptions { signal?: AbortSignal }
interface CommandExecution extends AgentExecutionOptions { effect: (settled: () => boolean) => void; dispatched: () => void }

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('command cancelled'), { outcome: 'cancelled' });
}

/** Bound the invocation's own wait without claiming the underlying effect stopped. */
function phase<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new Error('command cancelled')); };
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    promise.then((value) => { cleanup(); if (signal?.aborted) reject(new Error('command cancelled')); else resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

const RECORDING_ACTIONS = ['goto', 'step', 'line', 'start', 'stop', 'run', 'var', 'why', 'watch', 'story'];
const DEBUG_OPS = ['start', 'continue', 'step', 'pause', 'stop', 'state'];

/** The one entry point for HTTP, `ctl` and WebMCP: one command at a time, checked against `expect`. */
export async function runAgentCommand(host: PageHost, link: Link, cmd: AgentCommand, options: AgentExecutionOptions = {}): Promise<unknown> {
  checkCancelled(options.signal);
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.action !== 'string') throw new Error('command must be an object with an action');
  const status = cmd.action === 'state' || (cmd.action === 'debug' && cmd.op === 'state') || cmd.action === 'waitPause';
  const recovery = cmd.action === 'stop' || (cmd.action === 'debug' && cmd.op === 'stop');
  const previous = pending.get(host);
  if (previous && previous.settled()) pending.delete(host);
  if (!status && !recovery && pending.has(host)) throw new Error('a command is still pending or its outcome is unknown; read state or explicitly stop the runtime before retrying; reload the page if neither can reconcile it (reload does not stop dispatched work)');
  let effectSettled: (() => boolean) | undefined;
  let dispatched = false;
  let working = true;
  const lease = { settled: () => !working && (!effectSettled || effectSettled()) };
  if (!status && !(recovery && pending.has(host))) pending.set(host, lease);
  const controller = new AbortController();
  let timedOut = false;
  const cancelled = (): void => controller.abort();
  options.signal?.addEventListener('abort', cancelled, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, host.commandTimeoutMs?.() ?? 35_000);
  const execution: CommandExecution = { signal: controller.signal, effect: (settled) => { dispatched = true; effectSettled = settled; }, dispatched: () => { dispatched = true; } };
  try {
    checkExpectation(host, cmd);
    if (cmd.action === 'waitPause') {
      const event = await host.debug.waitForPause(cmd.after, cmd.timeoutMs, controller.signal);
      return { ...event, ...(event.changed ? { state: await phase(withBlock(host, debugSummary(host) as Record<string, unknown>, 'live'), controller.signal) } : {}) };
    }
    return await phase(executeCommand(host, link, cmd, execution), controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      const unknown = dispatched && (!effectSettled || !effectSettled());
      const recovery = cmd.action === 'scratchpad' ? '; outcome unknown, dispatched work may still continue; inspect scratchpad state before a deliberate new action' : '; outcome unknown, read state or explicitly stop the runtime before retrying';
      const failure = new Error(`${timedOut ? 'command timed out' : 'command cancelled'}${unknown ? recovery : dispatched ? '; producing action completed, but delivery was interrupted' : ''}`);
      Object.assign(failure, { outcome: unknown ? 'unknown' : dispatched ? 'completed' : 'cancelled' });
      throw failure;
    }
    if (effectSettled && !effectSettled()) {
      const failure = new Error(`${error instanceof Error ? error.message : String(error)}; outcome unknown, read state or explicitly stop the runtime before retrying`);
      Object.assign(failure, { outcome: 'unknown' });
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancelled);
    // Retire owned waits even when a control request fails before its next-stop promise settles.
    controller.abort();
    working = false;
    if (pending.get(host) === lease && lease.settled()) pending.delete(host);
  }
}

/** Refuse a command whose `expect` no longer matches `state().context`: the run, pause, frame or file moved on. */
function checkExpectation(host: PageHost, cmd: AgentCommand): void {
  const expected = cmd.expect;
  if (expected === undefined) return;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('expect must be a context object');
  const actual = host.state().context;
  for (const key of ['source', 'runId', 'step', 'frame', 'file'] as const) {
    if (key in expected && expected[key] !== actual[key]) throw new Error(`stale context: ${key} is ${JSON.stringify(actual[key])}, not ${JSON.stringify(expected[key])}; read state again`);
  }
}

async function executeCommand(host: PageHost, link: Link, cmd: AgentCommand, execution: CommandExecution): Promise<unknown> {
  if (host.debug.active && RECORDING_ACTIONS.includes(cmd.action)) throw new Error('the live debugger is active; use debug step/state/stop before navigating the recording');
  if (cmd.action !== 'state' && cmd.action !== 'stop' && cmd.action !== 'say' && cmd.action !== 'clear' && cmd.action !== 'debug' && cmd.action !== 'breakpoint' && cmd.action !== 'profile' && cmd.action !== 'peek' && cmd.action !== 'values' && cmd.action !== 'definition' && cmd.action !== 'scratchpad') await host.idle(host.commandTimeoutMs(), execution.signal);
  checkCancelled(execution.signal);
  // waiting for the run may have moved the page
  checkExpectation(host, cmd);
  switch (cmd.action) {
    case 'state':
      return withBlock(host, host.state());
    case 'goto':
      if (!host.nav.active) host.start({ step: cmd.step });
      else host.goto(cmd.step);
      return afterMove(host, cmd.say);
    case 'step': {
      let moved = true;
      if (!host.nav.active) host.start();
      else moved = cmd.kind === 'next' ? host.next() : host.move(cmd.kind);
      if (!moved) return { moved, state: host.state() };
      return { moved, state: await afterMove(host, cmd.say) };
    }
    case 'line': {
      if (!host.trace) throw new Error('nothing recorded yet: the run has no trace');
      const fileId = host.shownFileId() ?? host.mainFileId();
      if (fileId === undefined) throw new Error('the shown file is not part of the run');
      if (!host.nav.active) {
        host.start({ line: cmd.line });
      } else {
        const t = host.trace;
        const next = t.runToLine(host.nav.step, fileId, cmd.line);
        host.goto(next >= 0 ? next : t.startStep(fileId, cmd.line));
      }
      return afterMove(host, cmd.say);
    }
    case 'say':
      if (cmd.step !== undefined) {
        if (!host.nav.active) host.start({ step: cmd.step });
        else host.goto(cmd.step);
      }
      host.say(cmd.text, cmd.line);
      return host.state();
    case 'clear':
      host.say(null);
      return host.state();
    case 'start':
      host.start();
      return withBlock(host, host.state());
    case 'stop':
      if (host.runRequestPending || host.profilePending) {
        link.send({ type: 'stop' });
        // Stopping the bridge is explicit recovery, but only terminal evidence releases the lease.
        await host.idle(host.commandTimeoutMs(), execution.signal);
        if (host.runRequestPending || host.profilePending) throw new Error('stop sent; outcome unknown until the runtime confirms completion; reload the page if the bridge never replies');
      }
      host.stop();
      return host.state();
    case 'run':
      execution.effect(() => !host.runRequestPending);
      await host.rerunAndWait(execution.signal);
      return host.state();
    case 'eval': {
      // at a pause of the live debugger the paused frame answers, as `pyokka eval --live` does
      if (host.debug.paused) return { text: (await host.debug.evaluateAtPause(cmd.expression, execution.signal)).text, at: host.debug.state()?.location };
      const runId = host.run?.runId;
      if (!runId) throw new Error('no run yet');
      const reply = await link.request({ type: 'evaluate', runId, expression: cmd.expression }, execution.signal);
      if (reply.type === 'evaluated') return { text: reply.text };
      throw new Error(reply.type === 'error' ? reply.message : `unexpected reply ${reply.type}`);
    }
    case 'peek':
      return peek(host, link, cmd.name, execution.signal);
    case 'var': {
      const history = await phase(host.panes.variableHistory(cmd.name), execution.signal);
      checkCancelled(execution.signal);
      if (!history) throw new Error('nothing recorded yet: the run has no trace');
      // the Variable History view shows the same answer to the person watching
      checkCancelled(execution.signal);
      await phase(host.showVariableHistory(cmd.name, true, execution.signal), execution.signal);
      return { name: history.name, changes: history.changes.map((c) => ({ step: c.step, line: c.line, function: c.function, file: host.displayPath(c.fileId), source: c.source, ...(c.text !== undefined ? { text: c.text } : {}) })) };
    }
    case 'why': {
      const step = cmd.step ?? (host.nav.active ? host.nav.step : undefined);
      if (step === undefined) throw new Error('name a step, or start the Time Machine first');
      const tree = await phase(host.panes.provenance(step, cmd.name), execution.signal);
      checkCancelled(execution.signal);
      if (!tree) throw new Error('nothing recorded yet: the run has no trace');
      checkCancelled(execution.signal);
      await phase(host.panes.queryWhy(step, cmd.name, undefined, true, execution.signal), execution.signal);
      return tree;
    }
    case 'watch': {
      if (cmd.remove) {
        const w = host.panes.watches.find((x) => x.exp === cmd.exp.trim());
        if (w) host.panes.removeWatch(w.id);
      } else {
        if (!host.nav.active) host.start();
        if (host.panes.addWatch(cmd.exp, false)) {
          checkCancelled(execution.signal);
          execution.effect(() => !host.runRequestPending);
          await host.rerunAndWait(execution.signal);
        }
      }
      const step = host.nav.active ? host.nav.step : -1;
      return { step, watches: host.panes.watchRows(step).map((w) => ({ exp: w.exp, ...(w.valueBag ? { value: renderValueNode(w.valueBag.data) } : {}), ...(w.text !== undefined ? { text: w.text } : {}), ...(w.error ? { error: w.error } : {}), ...(w.step !== undefined ? { at: w.step } : {}) })) };
    }
    case 'breakpoint': {
      const path = host.main?.path;
      if (!path) throw new Error('no file yet');
      const on = host.debug.setBreakpoint(path, cmd.line, cmd.on, cmd.condition);
      return { line: cmd.line, on, breakpoints: host.debug.specs().map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })) };
    }
    case 'debug':
      return debugCommand(host, cmd, execution);
    case 'story': {
      if (!(await host.openStory())) throw new Error('no recorded run to tell: run the file first');
      return host.storyText();
    }
    case 'profile': {
      execution.effect(() => !host.profilePending);
      const p = await host.profileRun(execution.signal);
      if (p.error || !p.summary) throw new Error(p.error ?? 'no profile');
      return { path: p.path, totalMs: p.summary.totalMs, rows: p.summary.rows.slice(0, 20) };
    }
    case 'values':
      return host.liveValues();
    case 'definition':
      return host.definition(cmd.line, cmd.column);
    case 'scratchpad': {
      if (!host.onScratchpad) throw new Error('this page has no Scratchpad');
      const { action: _, expect: __, ...scratch } = cmd;
      return host.onScratchpad(scratch, { signal: execution.signal, onDispatch: execution.dispatched });
    }
    default:
      throw new Error(`unknown agent command ${(cmd as { action: string }).action}`);
  }
}

/** The live debugger as an agent drives it: each move waits for the next pause (or the end). */
async function debugCommand(host: PageHost, cmd: Extract<AgentCommand, { action: 'debug' }>, execution: CommandExecution): Promise<unknown> {
  const d = host.debug;
  if (!DEBUG_OPS.includes(cmd.op)) throw new Error(`unknown debug op ${String(cmd.op)}`);
  if (cmd.kind !== undefined && !['into', 'over', 'out'].includes(cmd.kind)) throw new Error(`unknown debug step kind ${String(cmd.kind)}`);
  const wait = (): Promise<void> => d.nextStop(10_000, execution.signal);
  switch (cmd.op) {
    case 'start': {
      // the new run's first stop (a breakpoint, or the first statement when none can hit) or its end
      const before = d.run?.runId;
      const waiting = new Promise<void>((resolve, reject) => {
        const aborted = (): void => { clearInterval(t); clearTimeout(timeout); execution.signal?.removeEventListener('abort', aborted); reject(new Error('command cancelled')); };
        execution.signal?.addEventListener('abort', aborted, { once: true });
        const t = setInterval(() => {
          if (d.run && d.run.runId !== before && (d.paused || !d.run.running)) {
            clearInterval(t);
            clearTimeout(timeout);
            execution.signal?.removeEventListener('abort', aborted);
            resolve();
          }
        }, 30);
        const timeout = setTimeout(() => {
          clearInterval(t);
          execution.signal?.removeEventListener('abort', aborted);
          resolve();
        }, 10_000);
      });
      execution.effect(() => !!d.run && d.run.runId !== before && (!!d.paused || !d.run.running));
      d.start();
      await phase(waiting, execution.signal);
      if (!d.run || d.run.runId === before || (d.run.running && !d.paused)) throw new Error('debug start reached neither a pause nor the end in 10 s');
      break;
    }
    case 'continue':
    case 'step':
    case 'pause': {
      if (!d.active) throw new Error('no live debug run: debug start first');
      if (cmd.op !== 'pause' && !d.paused) throw new Error(`debug ${cmd.op} needs a pause; the run is running`);
      if (cmd.op === 'pause' && d.paused) break;
      const before = d.paused;
      const stop = wait();
      void stop.catch(() => {});
      execution.effect(() => !d.active || (!!d.paused && d.paused !== before));
      await phase(d.control(cmd.op === 'continue' ? 'continue' : cmd.op === 'pause' ? 'pause' : cmd.kind === 'over' ? 'stepOver' : cmd.kind === 'out' ? 'stepOut' : 'stepInto', true, execution.signal), execution.signal);
      await stop;
      // still running and no new pause: the move was not confirmed, so the old pause is not reported as its result
      if (d.active && (!d.paused || d.paused === before)) throw new Error(`debug ${cmd.op} reached no new pause in 10 s`);
      break;
    }
    case 'stop': {
      const stopped = wait();
      execution.effect(() => !d.active);
      d.stop();
      await stopped;
      if (d.active) throw new Error('debug stop was not confirmed in 10 s');
      break;
    }
    case 'state':
      return withBlock(host, debugSummary(host) as Record<string, unknown>, 'live');
  }
  // the locals of a new pause (and of the selected frame) arrive just after it
  const localsPending = (): boolean => !!d.paused && (d.locals?.step !== d.paused.step || d.locals.frameId !== d.selectedFrame);
  for (let i = 0; i < 20 && localsPending(); i++) await phase(new Promise((r) => setTimeout(r, 25)), execution.signal);
  checkCancelled(execution.signal);
  if (localsPending()) throw new Error('the pause\'s locals have not arrived; read debug state again');
  if (cmd.say !== undefined && d.paused?.line) host.say(cmd.say, d.paused.line);
  return withBlock(host, debugSummary(host) as Record<string, unknown>, 'live');
}

/**
 * The captured value of a binding of the selected paused frame, as the ValueNode tree the runtime
 * serialized (one level below the binding), walked by a dotted path. A node the path reaches whose
 * children were not captured is expanded once more from the runtime's store; no expression runs.
 */
async function peek(host: PageHost, link: Link, name: string, signal?: AbortSignal): Promise<unknown> {
  const d = host.debug;
  const pause = d.paused;
  const run = d.run;
  if (!pause || !run) throw new Error('peek needs a live pause: pyokka_page {"action": "breakpoint", "line": N, "on": true}, then {"action": "debug", "op": "start"} (CLI: pyokka web ctl break N on, then pyokka web ctl debug start), then {"action": "peek", "name": NAME} (CLI: pyokka web ctl peek NAME)');
  const [binding, ...path] = name.trim().split('.');
  if (!binding) throw new Error('peek needs a NAME');
  for (let i = 0; i < 20 && (d.locals?.step !== pause.step || d.locals.frameId !== d.selectedFrame); i++) await phase(new Promise((r) => setTimeout(r, 25)), signal);
  checkCancelled(signal);
  if (d.locals?.step !== pause.step || d.locals.frameId !== d.selectedFrame) throw new Error('the pause\'s locals have not arrived; read debug state again');
  const local = d.locals.locals.find((v) => v.name === binding);
  if (!local) throw new Error(`no binding ${binding} in the paused frame (${d.locals.locals.map((v) => v.name).join(', ') || 'none'})`);
  let node: ValueNode | undefined = local.valueBag?.data;
  if (!node) throw new Error(`${binding} has no captured value, only its text: ${local.text}`);
  for (const part of path) {
    if (node.expandable && !node.props) node = await phase(expandNode(link, run.runId, node, signal), signal);
    const next: ValueNode | undefined = node.props?.find((p) => p.name === part);
    if (!next) throw new Error(`${name}: ${part} is not among ${(node.props ?? []).map((p) => p.name).join(', ') || 'its children'}`);
    node = next;
  }
  if (node.expandable && !node.props) node = await phase(expandNode(link, run.runId, node, signal), signal);
  if (d.paused !== pause) throw new Error('the pause changed while reading the value; read debug state again');
  const frame = pause.stack[d.selectedFrame];
  return { name, node, text: renderValueNode(node), observed: { runId: run.runId, step: pause.step, frame: d.selectedFrame, file: d.pathOf(frame?.fileId ?? pause.fileId) ?? null, line: frame?.line ?? pause.line ?? null } };
}

async function expandNode(link: Link, runId: string, node: ValueNode, signal?: AbortSignal): Promise<ValueNode> {
  const reply = await link.debugRequest({ type: 'expand', runId, valueId: node.id, queryPath: node.queryPath }, signal);
  if (reply.type === 'value') return reply.node;
  throw new Error(reply.type === 'error' ? reply.message : `unexpected reply ${reply.type}`);
}

export function debugSummary(host: PageHost): unknown {
  const s = host.debug.state();
  // a run that ended says how: its exit code and the uncaught exceptions, which may precede any step
  const run = host.debug.run;
  const ended = run && !run.running ? { exitCode: run.exitCode, errors: run.errors } : {};
  const context = host.state().context;
  if (!s) return { context, running: false, ...ended };
  return { context, runId: s.id, running: s.running, paused: s.paused, reason: s.reasonText, location: s.location, stack: s.stack.map((f) => ({ name: f.name, file: f.file, line: f.line })), locals: s.locals.map((v) => ({ name: v.name, text: v.text })), output: s.output.map((c) => c.text).join('').slice(-2000), ...ended };
}

function afterMove(host: PageHost, say: string | undefined): Promise<PageState> {
  if (say !== undefined) host.say(say);
  else if (host.narration) host.say(null);
  return withBlock(host, host.state());
}

/* ---------- WebMCP ---------- */

type ToolAnnotations = WebMCP.ToolAnnotations;

/** MCP's result shape, which the older `navigator.modelContext` took. */
interface TextResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface WebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** the answer itself, or a throw with the reason */
  run: (input: Record<string, unknown>, options?: AgentExecutionOptions) => Promise<unknown>;
  /** the older `navigator.modelContext` (and MCP) shape: the answer as JSON text, `isError` with the reason */
  execute: (input: Record<string, unknown>) => Promise<TextResult>;
}

/** Compatibility adapter for the older navigator API, whose callback returns MCP text content. */
interface LegacyModelContext {
  registerTool?: (tool: Omit<WebMcpTool, 'run'>) => unknown;
  provideContext?: (ctx: { tools: Omit<WebMcpTool, 'run'>[] }) => unknown;
}

const READ: ToolAnnotations = { readOnlyHint: true, untrustedContentHint: true };
const VALUES: ToolAnnotations = { untrustedContentHint: true };
const RERUN: ToolAnnotations = { consequentialHint: true, untrustedContentHint: true };

const EXPECT = {
  type: 'object',
  description: 'Context from pyokka_state; refuse the command if the run, pause, frame or file changed.',
  properties: { source: { type: 'string', enum: ['live', 'recording'], description: 'Expected execution surface' }, runId: { type: 'string', description: 'Expected run identifier' }, step: { type: ['integer', 'null'], description: 'Expected recorded or paused step' }, frame: { type: 'integer', description: 'Expected selected frame' }, file: { type: ['string', 'null'], description: 'Expected source file' } },
};
const SAY = { type: 'string', description: 'Optional explanation to show in a bubble under the new line, for the person watching' };

const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  step: 'Recorded step number, starting at zero', kind: 'Direction or stepping mode', line: 'Source line, starting at one',
  text: 'Explanation shown to the person watching', expression: 'Expression to evaluate in the current execution context',
  name: 'Variable name; for provenance, empty explains the statement', exp: 'Watch expression', remove: 'Remove the matching watch when true',
  on: 'Enable or disable the breakpoint; omitted toggles it', condition: 'Python condition for the breakpoint',
  op: 'Operation to perform; state reads the current view',
};

const resultCaches = new WeakMap<PageHost, WebMcpResults>();
function resultsFor(host: PageHost): WebMcpResults {
  let results = resultCaches.get(host);
  if (!results) { results = new WebMcpResults(); resultCaches.set(host, results); }
  return results;
}

function toolError(error: unknown): { isError: true; error: string; outcome?: ResultOutcome } {
  const outcome = error && typeof error === 'object' && 'outcome' in error ? error.outcome : undefined;
  return { isError: true, error: error instanceof Error ? error.message : String(error), ...(outcome === 'unknown' || outcome === 'cancelled' || outcome === 'completed' ? { outcome } : {}) };
}

/** The tools, as WebMCP declares them. Exported for tests. */
export function webMcpTools(host: PageHost, link: Link, lifetime?: AbortSignal): WebMcpTool[] {
  const results = resultsFor(host);
  const tool = (name: string, title: string, annotations: ToolAnnotations, description: string, properties: Record<string, unknown>, required: string[], toCommand: (input: Record<string, unknown>) => AgentCommand): WebMcpTool => {
    const run = async (input: Record<string, unknown>, options?: AgentExecutionOptions): Promise<unknown> => {
      try {
        checkCancelled(lifetime);
        const expect = input?.['expect'];
        const value = (await runAgentCommand(host, link, { ...toCommand(input ?? {}), ...(expect !== undefined ? { expect: expect as AgentCommand['expect'] } : {}) }, options)) ?? null;
        return results.format(name, value, { signal: lifetime?.aborted ? lifetime : options?.signal });
      } catch (error) {
        const payload = toolError(error);
        return results.format(name, payload, { signal: lifetime?.aborted ? lifetime : options?.signal, outcome: payload.outcome ?? 'failed' });
      }
    };
    return {
      name,
      title,
      description,
      inputSchema: { type: 'object', properties: { ...Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { description: PARAMETER_DESCRIPTIONS[key], ...(value as object) }])), expect: EXPECT }, required },
      annotations,
      run,
      execute: async (input) => legacyWebMcpResult(await run(input)),
    };
  };
  const tools = [
    tool('pyokka_state', 'Time Machine state', READ, 'Where the Time Machine is in the recorded run: file, line, function, the source line, the enclosing function\'s code (block, the current line marked), variables, call stack, logged values, output and errors. context names the surface commands act on: the live debugger while it has a run (run, step, frame, file, line, locals), else the recording.', {}, [], () => ({ action: 'state' })),
    tool('pyokka_goto', 'Go to step', VALUES, 'Move the Time Machine to a recorded step (0-based) and show it in the code pane.', { step: { type: 'integer', minimum: 0 }, say: SAY }, ['step'], (i) => ({ action: 'goto', step: Number(i['step']), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('pyokka_step', 'Step', VALUES, 'Step the Time Machine like a debugger, forwards or backwards: next (exactly one recorded event), into, over, out, back, backOver, backOut.', { kind: { type: 'string', enum: ['next', 'into', 'over', 'out', 'back', 'backOver', 'backOut'] }, say: SAY }, ['kind'], (i) => ({ action: 'step', kind: String(i['kind']) as Extract<AgentCommand, { action: 'step' }>['kind'], ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('pyokka_line', 'Run to line', VALUES, 'Move the Time Machine to the next time a line of the shown file runs.', { line: { type: 'integer', minimum: 1 }, say: SAY }, ['line'], (i) => ({ action: 'line', line: Number(i['line']), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('pyokka_say', 'Explain under a line', VALUES, 'Explain something to the person watching: a bubble under a line (the current line by default). Empty text clears it.', { text: { type: 'string' }, line: { type: 'integer', minimum: 1 } }, ['text'], (i) => (String(i['text'] ?? '') === '' ? { action: 'clear' } : { action: 'say', text: String(i['text']), ...(typeof i['line'] === 'number' ? { line: i['line'] } : {}) })),
    tool('pyokka_run', 'Run the file again', RERUN, 'Run the file again and wait for it to finish; returns the new state.', {}, [], () => ({ action: 'run' })),
    tool('pyokka_eval', 'Evaluate', READ, 'Evaluate an expression in the live paused frame, or against the finished recording. Use for a value absent from state.', { expression: { type: 'string' } }, ['expression'], (i) => ({ action: 'eval', expression: String(i['expression'] ?? '') })),
    tool('pyokka_var', 'Variable History', VALUES, 'Every recorded change of a variable in the run: step, line, function and value. Also opens the Variable History view.', { name: { type: 'string' } }, ['name'], (i) => ({ action: 'var', name: String(i['name'] ?? '') })),
    tool('pyokka_why', 'Why this value', VALUES, 'Why a variable had its value after a step (default: the Time Machine step): the statements and values it came from. An empty name explains the statement.', { name: { type: 'string' }, step: { type: 'integer', minimum: 0 } }, ['name'], (i) => ({ action: 'why', name: String(i['name'] ?? ''), ...(typeof i['step'] === 'number' ? { step: i['step'] } : {}) })),
    tool('pyokka_watch', 'Watch expression', VALUES, 'Add a Time Machine watch expression (remove: true drops it); returns every watch value at the current step.', { exp: { type: 'string' }, remove: { type: 'boolean' } }, ['exp'], (i) => ({ action: 'watch', exp: String(i['exp'] ?? ''), ...(i['remove'] === true ? { remove: true } : {}) })),
    tool('pyokka_breakpoint', 'Breakpoint', VALUES, 'Set, clear or toggle a breakpoint on a line of the file for the live debugger.', { line: { type: 'integer', minimum: 1 }, on: { type: 'boolean' }, condition: { type: 'string' } }, ['line'], (i) => ({ action: 'breakpoint', line: Number(i['line']), ...(typeof i['on'] === 'boolean' ? { on: i['on'] } : {}), ...(typeof i['condition'] === 'string' ? { condition: i['condition'] } : {}) })),
    tool('pyokka_story', 'Code Story', VALUES, 'Open the Code Story of the recorded run (every pass through a scope, in execution order) in the right panel; returns its text and the row of the Time Machine step.', {}, [], () => ({ action: 'story' })),
    tool('pyokka_profile', 'Profile', RERUN, 'Run the file once under the runtime profiler and show the hottest functions (self and total ms) in the code pane.', {}, [], () => ({ action: 'profile' })),
    tool('pyokka_debug', 'Live debugger', VALUES, 'Drive the live debugger (a real run, nothing recorded): start (pauses at the first statement), continue, step (into/over/out), pause, stop, state. Returns where it paused, the paused function\'s code (block, the paused line marked), the stack and the variables.', { op: { type: 'string', enum: ['start', 'continue', 'step', 'pause', 'stop', 'state'] }, kind: { type: 'string', enum: ['into', 'over', 'out'] }, say: SAY }, ['op'], (i) => ({ action: 'debug', op: String(i['op']) as Extract<AgentCommand, { action: 'debug' }>['op'], ...(typeof i['kind'] === 'string' ? { kind: i['kind'] as 'into' | 'over' | 'out' } : {}), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool(
      'pyokka_scratchpad',
      'Scratchpad',
      VALUES,
      'Edit and run a separate Python scratchpad beside the debugger. Use to test a change while keeping the paused program in place, or recover saved drafts. Values that cannot be rebuilt are listed as unavailable.',
      {
        op: { type: 'string', enum: [...SCRATCH_OPS] },
        id: { type: 'string', description: 'load, history: a saved scratchpad (list names them)' },
        title: { type: 'string', description: "open, experiment, create, update, save: the scratchpad's name" },
        version: { type: 'integer', minimum: 1, description: 'load, history: a saved version; omitted, the latest' },
        line: { type: 'integer', minimum: 1, description: "open, experiment: copy the function around this line of the paused file; say: the line of the scratchpad's code the bubble goes under" },
        code: { type: 'string', description: 'experiment, create, update: the Python code; a `result` variable is shown' },
        inputs: { type: ['object', 'string'], description: 'experiment, create, update: Python assignments, or {name: Python expression}' },
        mocks: { type: ['object', 'string'], description: 'experiment, create, update: one Python dict, or {target: Python expression}' },
        auto_run: { type: 'boolean', description: 'run after each edit' },
        text: { type: 'string', description: 'say: the explanation; empty clears the bubble' },
      },
      ['op'],
      (i) => {
        const op = String(i['op'] ?? 'state') as ScratchCommand['op'];
        const pick = <K extends keyof ScratchCommand>(key: K, value: unknown, ok: boolean): Partial<ScratchCommand> => (ok ? ({ [key]: value } as Partial<ScratchCommand>) : {});
        return {
          action: 'scratchpad',
          op,
          ...pick('id', i['id'], typeof i['id'] === 'string'),
          ...pick('title', i['title'], typeof i['title'] === 'string'),
          ...pick('version', i['version'], typeof i['version'] === 'number'),
          ...pick('line', i['line'], typeof i['line'] === 'number'),
          ...pick('code', i['code'], typeof i['code'] === 'string'),
          ...pick('inputs', i['inputs'], typeof i['inputs'] === 'string' || (typeof i['inputs'] === 'object' && i['inputs'] !== null)),
          ...pick('mocks', i['mocks'], typeof i['mocks'] === 'string' || (typeof i['mocks'] === 'object' && i['mocks'] !== null)),
          ...pick('autoRun', i['auto_run'], typeof i['auto_run'] === 'boolean'),
          ...pick('text', i['text'], typeof i['text'] === 'string'),
        } as AgentCommand;
      },
    ),
  ];
  const read = async (input: Record<string, unknown>, options?: AgentExecutionOptions): Promise<unknown> => results.read(input['cursor'], lifetime?.aborted ? lifetime : options?.signal);
  tools.push({
    name: 'pyokka_result', title: 'Read retained result', annotations: READ,
    description: 'Read omitted details from a large tool result. Follow its cursor, nested refs, or next_cursor without repeating the original action.',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string', minLength: 1, maxLength: 96, description: 'Copy a continuation or detail reference exactly from a previous result. It reads the captured result until expiry.' } }, required: ['cursor'], additionalProperties: false },
    run: read, execute: async (input) => legacyWebMcpResult(await read(input)),
  });
  return tools;
}

/** the current registration: aborting it unregisters every tool, before the page registers them again */
let registration: AbortController | undefined;

/**
 * Register the tools on WebMCP: `document.modelContext` (the current draft), else the older
 * `navigator.modelContext`; a no-op elsewhere. On the draft a tool resolves with its answer, and a
 * refusal resolves with `{ isError: true, error }`: Chrome hides a thrown error's message from the
 * agent ("the invocation failed"), and no answer of these tools has an `isError` key. A
 * registration the browser rejects later (a duplicate name) goes to `onFailed`.
 */
export function registerWebMcp(host: PageHost, link: Link, onFailed: (name: string, err: unknown) => void = () => {}): boolean {
  const draft = typeof document !== 'undefined' ? document.modelContext : undefined;
  const mc = draft ?? (typeof navigator !== 'undefined' ? (navigator as Navigator & { modelContext?: LegacyModelContext }).modelContext : undefined);
  if (!mc) return false;
  registration?.abort();
  resultsFor(host).clear();
  const signal = (registration = new AbortController()).signal;
  signal.addEventListener('abort', () => resultsFor(host).clear(), { once: true });
  const tools = webMcpTools(host, link, signal);
  try {
    if (draft && typeof draft.registerTool === 'function') {
      for (const t of tools) {
        const { run, execute: _mcpShape, ...declared } = t;
        const execute: WebMCP.ToolExecuteCallback = async (input, options) => {
          try {
            return await run(input ?? {}, options);
          } catch (err) {
            return { isError: true, error: err instanceof Error ? err.message : String(err), ...(err && typeof err === 'object' && 'outcome' in err ? { outcome: err.outcome } : {}) };
          }
        };
        Promise.resolve(draft.registerTool({ ...declared, execute } satisfies WebMCP.ModelContextTool, { signal })).catch((err: unknown) => {
          console.warn(`[pyokka] WebMCP did not register ${t.name}`, err);
          onFailed(t.name, err);
        });
      }
      return true;
    }
    const legacy = mc as LegacyModelContext;
    const older = tools.map(({ run: _answer, ...t }) => t);
    if (typeof legacy.registerTool === 'function') for (const t of older) legacy.registerTool(t);
    else if (typeof legacy.provideContext === 'function') legacy.provideContext({ tools: older });
    else return false;
    return true;
  } catch (err) {
    console.warn('[pyokka] WebMCP registration failed', err);
    return false;
  }
}
