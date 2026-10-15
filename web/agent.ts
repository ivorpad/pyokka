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

/** pages with a command in progress: a second one is refused rather than raced against the first */
const pending = new WeakSet<PageHost>();

const RECORDING_ACTIONS = ['goto', 'step', 'line', 'start', 'stop', 'run', 'var', 'why', 'watch', 'story'];
const DEBUG_OPS = ['start', 'continue', 'step', 'pause', 'stop', 'state'];

/** The one entry point for HTTP, `ctl` and WebMCP: one command at a time, checked against `expect`. */
export async function runAgentCommand(host: PageHost, link: Link, cmd: AgentCommand): Promise<unknown> {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.action !== 'string') throw new Error('command must be an object with an action');
  if (cmd.action === 'waitPause') {
    // outside the one-at-a-time rule: it waits for a step another command or the person takes
    const event = await host.debug.waitForPause(cmd.after, cmd.timeoutMs);
    return { ...event, ...(event.changed ? { state: debugSummary(host) } : {}) };
  }
  if (pending.has(host)) throw new Error('a command is still pending; wait for its result');
  pending.add(host);
  try {
    checkExpectation(host, cmd);
    return await executeCommand(host, link, cmd);
  } finally {
    pending.delete(host);
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

async function executeCommand(host: PageHost, link: Link, cmd: AgentCommand): Promise<unknown> {
  if (host.debug.active && RECORDING_ACTIONS.includes(cmd.action)) throw new Error('the live debugger is active; use debug step/state/stop before navigating the recording');
  if (cmd.action !== 'state' && cmd.action !== 'say' && cmd.action !== 'clear' && cmd.action !== 'debug' && cmd.action !== 'breakpoint' && cmd.action !== 'profile' && cmd.action !== 'peek' && cmd.action !== 'values' && cmd.action !== 'definition' && cmd.action !== 'scratchpad') await host.idle();
  // waiting for the run may have moved the page
  checkExpectation(host, cmd);
  switch (cmd.action) {
    case 'state':
      return host.state();
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
      return host.state();
    case 'stop':
      host.stop();
      return host.state();
    case 'run':
      host.rerun();
      await new Promise((r) => setTimeout(r, 50));
      await host.idle();
      return host.state();
    case 'eval': {
      // at a pause of the live debugger the paused frame answers, as `pyokka eval --live` does
      if (host.debug.paused) return { text: (await host.debug.evaluateAtPause(cmd.expression)).text, at: host.debug.state()?.location };
      const runId = host.run?.runId;
      if (!runId) throw new Error('no run yet');
      const reply = await link.request({ type: 'evaluate', runId, expression: cmd.expression });
      if (reply.type === 'evaluated') return { text: reply.text };
      throw new Error(reply.type === 'error' ? reply.message : `unexpected reply ${reply.type}`);
    }
    case 'peek':
      return peek(host, link, cmd.name);
    case 'var': {
      const history = await host.panes.variableHistory(cmd.name);
      if (!history) throw new Error('nothing recorded yet: the run has no trace');
      // the Variable History view shows the same answer to the person watching
      void host.panes.queryVariable(cmd.name);
      return { name: history.name, changes: history.changes.map((c) => ({ step: c.step, line: c.line, function: c.function, file: host.displayPath(c.fileId), source: c.source, ...(c.text !== undefined ? { text: c.text } : {}) })) };
    }
    case 'why': {
      const step = cmd.step ?? (host.nav.active ? host.nav.step : undefined);
      if (step === undefined) throw new Error('name a step, or start the Time Machine first');
      const tree = await host.panes.provenance(step, cmd.name);
      if (!tree) throw new Error('nothing recorded yet: the run has no trace');
      void host.panes.queryWhy(step, cmd.name);
      return tree;
    }
    case 'watch': {
      if (cmd.remove) {
        const w = host.panes.watches.find((x) => x.exp === cmd.exp.trim());
        if (w) host.panes.removeWatch(w.id);
      } else {
        if (!host.nav.active) host.start();
        host.panes.addWatch(cmd.exp);
        await new Promise((r) => setTimeout(r, 50));
        await host.idle();
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
      return debugCommand(host, cmd);
    case 'story': {
      if (!(await host.openStory())) throw new Error('no recorded run to tell: run the file first');
      return host.storyText();
    }
    case 'profile': {
      const p = await host.profileRun();
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
      return host.onScratchpad(scratch);
    }
    default:
      throw new Error(`unknown agent command ${(cmd as { action: string }).action}`);
  }
}

/** The live debugger as an agent drives it: each move waits for the next pause (or the end). */
async function debugCommand(host: PageHost, cmd: Extract<AgentCommand, { action: 'debug' }>): Promise<unknown> {
  const d = host.debug;
  if (!DEBUG_OPS.includes(cmd.op)) throw new Error(`unknown debug op ${String(cmd.op)}`);
  if (cmd.kind !== undefined && !['into', 'over', 'out'].includes(cmd.kind)) throw new Error(`unknown debug step kind ${String(cmd.kind)}`);
  const wait = (): Promise<void> => d.nextStop();
  switch (cmd.op) {
    case 'start': {
      // the new run's first stop (a breakpoint, or the first statement when none can hit) or its end
      const before = d.run?.runId;
      const waiting = new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (d.run && d.run.runId !== before && (d.paused || !d.run.running)) {
            clearInterval(t);
            clearTimeout(timeout);
            resolve();
          }
        }, 30);
        const timeout = setTimeout(() => {
          clearInterval(t);
          resolve();
        }, 10_000);
      });
      d.start();
      await waiting;
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
      await d.control(cmd.op === 'continue' ? 'continue' : cmd.op === 'pause' ? 'pause' : cmd.kind === 'over' ? 'stepOver' : cmd.kind === 'out' ? 'stepOut' : 'stepInto', true);
      await stop;
      // still running and no new pause: the move was not confirmed, so the old pause is not reported as its result
      if (d.active && (!d.paused || d.paused === before)) throw new Error(`debug ${cmd.op} reached no new pause in 10 s`);
      break;
    }
    case 'stop': {
      const stopped = wait();
      d.stop();
      await stopped;
      if (d.active) throw new Error('debug stop was not confirmed in 10 s');
      break;
    }
    case 'state':
      break;
  }
  // the locals of a new pause (and of the selected frame) arrive just after it
  const localsPending = (): boolean => !!d.paused && (d.locals?.step !== d.paused.step || d.locals.frameId !== d.selectedFrame);
  for (let i = 0; i < 20 && localsPending(); i++) await new Promise((r) => setTimeout(r, 25));
  if (localsPending()) throw new Error('the pause\'s locals have not arrived; read debug state again');
  if (cmd.say !== undefined && d.paused?.line) host.say(cmd.say, d.paused.line);
  return debugSummary(host);
}

/**
 * The captured value of a binding of the selected paused frame, as the ValueNode tree the runtime
 * serialized (one level below the binding), walked by a dotted path. A node the path reaches whose
 * children were not captured is expanded once more from the runtime's store; no expression runs.
 */
async function peek(host: PageHost, link: Link, name: string): Promise<unknown> {
  const d = host.debug;
  const pause = d.paused;
  const run = d.run;
  if (!pause || !run) throw new Error('peek needs a live pause: debug start, then peek NAME');
  const [binding, ...path] = name.trim().split('.');
  if (!binding) throw new Error('peek needs a NAME');
  for (let i = 0; i < 20 && (d.locals?.step !== pause.step || d.locals.frameId !== d.selectedFrame); i++) await new Promise((r) => setTimeout(r, 25));
  if (d.locals?.step !== pause.step || d.locals.frameId !== d.selectedFrame) throw new Error('the pause\'s locals have not arrived; read debug state again');
  const local = d.locals.locals.find((v) => v.name === binding);
  if (!local) throw new Error(`no binding ${binding} in the paused frame (${d.locals.locals.map((v) => v.name).join(', ') || 'none'})`);
  let node: ValueNode | undefined = local.valueBag?.data;
  if (!node) throw new Error(`${binding} has no captured value, only its text: ${local.text}`);
  for (const part of path) {
    if (node.expandable && !node.props) node = await expandNode(link, run.runId, node);
    const next: ValueNode | undefined = node.props?.find((p) => p.name === part);
    if (!next) throw new Error(`${name}: ${part} is not among ${(node.props ?? []).map((p) => p.name).join(', ') || 'its children'}`);
    node = next;
  }
  if (node.expandable && !node.props) node = await expandNode(link, run.runId, node);
  if (d.paused !== pause) throw new Error('the pause changed while reading the value; read debug state again');
  const frame = pause.stack[d.selectedFrame];
  return { name, node, text: renderValueNode(node), observed: { runId: run.runId, step: pause.step, frame: d.selectedFrame, file: d.pathOf(frame?.fileId ?? pause.fileId) ?? null, line: frame?.line ?? pause.line ?? null } };
}

async function expandNode(link: Link, runId: string, node: ValueNode): Promise<ValueNode> {
  const reply = await link.debugRequest({ type: 'expand', runId, valueId: node.id, queryPath: node.queryPath });
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

function afterMove(host: PageHost, say: string | undefined): PageState {
  if (say !== undefined) host.say(say);
  else if (host.narration) host.say(null);
  return host.state();
}

/* ---------- WebMCP ---------- */

/** The draft's hints about a tool (webmachinelearning.github.io/webmcp, 15 October 2026). */
interface ToolAnnotations {
  /** reads only: no state of the page or the program changes */
  readOnlyHint?: boolean;
  /** the answer carries the program's values or output, which an agent should not take as instructions */
  untrustedContentHint?: boolean;
  /** runs the whole program again: an agent's host may ask the person first */
  consequentialHint?: boolean;
}

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
  run: (input: Record<string, unknown>) => Promise<unknown>;
  /** the older `navigator.modelContext` (and MCP) shape: the answer as JSON text, `isError` with the reason */
  execute: (input: Record<string, unknown>) => Promise<TextResult>;
}

/** The draft's tool: `execute` resolves with the answer, which the browser serializes as JSON for the agent. */
interface DraftTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

interface ModelContext {
  registerTool?: (tool: DraftTool | Omit<WebMcpTool, 'run'>, options?: { signal?: AbortSignal }) => unknown;
  provideContext?: (ctx: { tools: Omit<WebMcpTool, 'run'>[] }) => unknown;
}

const READ: ToolAnnotations = { readOnlyHint: true, untrustedContentHint: true };
const VALUES: ToolAnnotations = { untrustedContentHint: true };
const RERUN: ToolAnnotations = { consequentialHint: true, untrustedContentHint: true };

const EXPECT = {
  type: 'object',
  description: 'The context read from pyokka_state (state.context); the command is refused when the run, pause, frame or file has changed since.',
  properties: { source: { type: 'string', enum: ['live', 'recording'] }, runId: { type: 'string' }, step: { type: ['integer', 'null'] }, frame: { type: 'integer' }, file: { type: ['string', 'null'] } },
};
const SAY = { type: 'string', description: 'Optional explanation to show in a bubble under the new line, for the person watching' };

/** The tools, as WebMCP declares them. Exported for tests. */
export function webMcpTools(host: PageHost, link: Link): WebMcpTool[] {
  const tool = (name: string, title: string, annotations: ToolAnnotations, description: string, properties: Record<string, unknown>, required: string[], toCommand: (input: Record<string, unknown>) => AgentCommand): WebMcpTool => {
    const run = async (input: Record<string, unknown>): Promise<unknown> => {
      const expect = input?.['expect'];
      return (await runAgentCommand(host, link, { ...toCommand(input ?? {}), ...(expect !== undefined ? { expect: expect as AgentCommand['expect'] } : {}) })) ?? null;
    };
    return {
      name,
      title,
      description,
      inputSchema: { type: 'object', properties: { ...properties, expect: EXPECT }, required },
      annotations,
      run,
      execute: async (input) => {
        try {
          return { content: [{ type: 'text', text: JSON.stringify(await run(input), null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    };
  };
  return [
    tool('pyokka_state', 'Time Machine state', READ, 'Where the Time Machine is in the recorded run: file, line, function, the source line, variables, call stack, logged values, output and errors. context names the surface commands act on: the live debugger while it has a run (run, step, frame, file, line, locals), else the recording.', {}, [], () => ({ action: 'state' })),
    tool('pyokka_goto', 'Go to step', VALUES, 'Move the Time Machine to a recorded step (0-based) and show it in the code pane.', { step: { type: 'integer', minimum: 0 }, say: SAY }, ['step'], (i) => ({ action: 'goto', step: Number(i['step']), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('pyokka_step', 'Step', VALUES, 'Step the Time Machine like a debugger, forwards or backwards: next (exactly one recorded event), into, over, out, back, backOver, backOut.', { kind: { type: 'string', enum: ['next', 'into', 'over', 'out', 'back', 'backOver', 'backOut'] }, say: SAY }, ['kind'], (i) => ({ action: 'step', kind: String(i['kind']) as Extract<AgentCommand, { action: 'step' }>['kind'], ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('pyokka_line', 'Run to line', VALUES, 'Move the Time Machine to the next time a line of the shown file runs.', { line: { type: 'integer', minimum: 1 }, say: SAY }, ['line'], (i) => ({ action: 'line', line: Number(i['line']), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool('pyokka_say', 'Explain under a line', {}, 'Explain something to the person watching: a bubble under a line (the current line by default). Empty text clears it.', { text: { type: 'string' }, line: { type: 'integer', minimum: 1 } }, ['text'], (i) => (String(i['text'] ?? '') === '' ? { action: 'clear' } : { action: 'say', text: String(i['text']), ...(typeof i['line'] === 'number' ? { line: i['line'] } : {}) })),
    tool('pyokka_run', 'Run the file again', RERUN, 'Run the file again and wait for it to finish; returns the new state.', {}, [], () => ({ action: 'run' })),
    tool('pyokka_eval', 'Evaluate', READ, 'Evaluate a side-effect-free expression against the finished run (no statement is re-run).', { expression: { type: 'string' } }, ['expression'], (i) => ({ action: 'eval', expression: String(i['expression'] ?? '') })),
    tool('pyokka_var', 'Variable History', READ, 'Every recorded change of a variable in the run: step, line, function and value. Also opens the Variable History view.', { name: { type: 'string' } }, ['name'], (i) => ({ action: 'var', name: String(i['name'] ?? '') })),
    tool('pyokka_why', 'Why this value', READ, 'Why a variable had its value after a step (default: the Time Machine step): the statements and values it came from. An empty name explains the statement.', { name: { type: 'string' }, step: { type: 'integer', minimum: 0 } }, ['name'], (i) => ({ action: 'why', name: String(i['name'] ?? ''), ...(typeof i['step'] === 'number' ? { step: i['step'] } : {}) })),
    tool('pyokka_watch', 'Watch expression', VALUES, 'Add a Time Machine watch expression (remove: true drops it); returns every watch value at the current step.', { exp: { type: 'string' }, remove: { type: 'boolean' } }, ['exp'], (i) => ({ action: 'watch', exp: String(i['exp'] ?? ''), ...(i['remove'] === true ? { remove: true } : {}) })),
    tool('pyokka_breakpoint', 'Breakpoint', {}, 'Set, clear or toggle a breakpoint on a line of the file for the live debugger.', { line: { type: 'integer', minimum: 1 }, on: { type: 'boolean' }, condition: { type: 'string' } }, ['line'], (i) => ({ action: 'breakpoint', line: Number(i['line']), ...(typeof i['on'] === 'boolean' ? { on: i['on'] } : {}), ...(typeof i['condition'] === 'string' ? { condition: i['condition'] } : {}) })),
    tool('pyokka_story', 'Code Story', VALUES, 'Open the Code Story of the recorded run (every pass through a scope, in execution order) in the right panel; returns its text and the row of the Time Machine step.', {}, [], () => ({ action: 'story' })),
    tool('pyokka_profile', 'Profile', RERUN, 'Run the file once under the runtime profiler and show the hottest functions (self and total ms) in the code pane.', {}, [], () => ({ action: 'profile' })),
    tool('pyokka_debug', 'Live debugger', VALUES, 'Drive the live debugger (a real run, nothing recorded): start (pauses at the first statement), continue, step (into/over/out), pause, stop, state. Returns where it paused, the stack and the variables.', { op: { type: 'string', enum: ['start', 'continue', 'step', 'pause', 'stop', 'state'] }, kind: { type: 'string', enum: ['into', 'over', 'out'] }, say: SAY }, ['op'], (i) => ({ action: 'debug', op: String(i['op']) as Extract<AgentCommand, { action: 'debug' }>['op'], ...(typeof i['kind'] === 'string' ? { kind: i['kind'] as 'into' | 'over' | 'out' } : {}), ...(typeof i['say'] === 'string' ? { say: i['say'] } : {}) })),
    tool(
      'pyokka_scratchpad',
      'Scratchpad',
      VALUES,
      "Experiment beside the live debugger in a separate python -I (network denied on macOS); the paused program never moves. op open (at a pause) copies the function around the paused line (or `line`) with the pause's values as Inputs and runs it once; a value a fresh process cannot rebuild is listed in `unavailable`. experiment does the same with your `code`. create starts one with no pause; update changes code, inputs, mocks, title or auto_run; run, restore, close, state. save adds a version, list names the saved scratchpads, history lists one's versions, load reopens one without running it. say shows `text` in a bubble under `line` of the scratchpad's code (empty text clears it). inputs: Python assignments or {name: expression}; mocks: one Python dict or {target: expression}, applied with unittest.mock.",
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
  const draft = typeof document !== 'undefined' ? (document as Document & { modelContext?: ModelContext }).modelContext : undefined;
  const mc = draft ?? (typeof navigator !== 'undefined' ? (navigator as Navigator & { modelContext?: ModelContext }).modelContext : undefined);
  if (!mc) return false;
  const tools = webMcpTools(host, link);
  try {
    if (draft && typeof draft.registerTool === 'function') {
      registration?.abort();
      const signal = (registration = new AbortController()).signal;
      for (const t of tools) {
        const { run, execute: _mcpShape, ...declared } = t;
        const execute = async (input: Record<string, unknown>): Promise<unknown> => {
          try {
            return await run(input ?? {});
          } catch (err) {
            return { isError: true, error: err instanceof Error ? err.message : String(err) };
          }
        };
        Promise.resolve(draft.registerTool({ ...declared, execute }, { signal })).catch((err: unknown) => {
          console.warn(`[pyokka] WebMCP did not register ${t.name}`, err);
          onFailed(t.name, err);
        });
      }
      return true;
    }
    const older = tools.map(({ run: _answer, ...t }) => t);
    if (typeof mc.registerTool === 'function') for (const t of older) mc.registerTool(t);
    else if (typeof mc.provideContext === 'function') mc.provideContext({ tools: older });
    else return false;
    return true;
  } catch (err) {
    console.warn('[pyokka] WebMCP registration failed', err);
    return false;
  }
}
