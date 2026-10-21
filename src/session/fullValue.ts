/**
 * "Rerun value": what a rerun of the program has to match, and what its answer means. Pure, so the
 * rules are tested without a runner; fullValueReplay.ts runs the replay.
 *
 * The recorder keeps a local as 120 characters of repr, three levels deep, at the start of the
 * step after the statement that changed it. A replay runs the program again in a runner of its
 * own, compares every step with the recording (the runtime does that), and copies the value
 * whole at the step asked for. A matching path is not enough to call the copy this run's value:
 * an answer from outside the program (a file, a database, an API) can differ while the same lines
 * run. So the host also compares every value the recording kept on the way, and everything it
 * logged, with what the replay recorded at the same steps; only when all of them match is the
 * copy `checked`.
 */
import { MAX_LOCALS_ENTRIES, type LocalsEvent, type LogEvent, type RunRequest } from '../shared/protocol';
import type { InputsRecord, ReplayResultEvent, FullValueStatus, FullValueView } from '../shared/replayProtocol';

type LocalsEntry = LocalsEvent['entries'][number];

/** Where the recorder kept a value: the step whose start-of-step snapshot holds it, its scope and its text. */
export interface Observation {
  step: number;
  scopeId: number;
  text: string;
}

/** The first step after `step` that ran in scope `scopeId`; undefined when the scope ran no later step. */
export function nextInScope(scopeOf: (step: number) => number, count: number, step: number, scopeId: number): number | undefined {
  for (let j = step + 1; j < count; j++) if (scopeOf(j) === scopeId) return j;
  return undefined;
}

/**
 * Where a change is read, and the snapshot it is compared with. The recorder keeps a change at
 * the start of a step: the scope's next step (`next`) for a statement's own write, the row's own
 * step for a loop target at an iteration or a parameter at a call's first step (`History.attribute`).
 * A row from a snapshot carries that snapshot's text, which says which of the two it is. A row
 * without one (the statement kept the same object, the recorder was past its cap, the text was
 * masked for display) is read at `next`, the value after its statement. The snapshot at the start
 * of the row's own step is taken only when the text says so, since it can hold the value from
 * before the change. A --follow-objects change (`exact`) is kept at its statement's own step but
 * holds the value after it, so it is read at `next` and compared with its own text.
 */
export function changeTarget(locals: readonly LocalsEntry[], change: { step: number; scopeId: number; name: string; text?: string }, next: number | undefined): { step: number; observation?: Observation } | undefined {
  const snapshotAt = (step: number | undefined): (Observation & { exact: boolean }) | undefined => {
    if (step === undefined) return undefined;
    for (const entry of locals) {
      if (entry.step > step) break;
      if (entry.step !== step || entry.scopeId !== change.scopeId) continue;
      const ch = entry.changes.find((c) => c.name === change.name);
      if (ch) return { step, scopeId: entry.scopeId, text: ch.text, exact: !!ch.exact };
    }
    return undefined;
  };
  const seen = (o: Observation & { exact: boolean }): Observation => ({ step: o.step, scopeId: o.scopeId, text: o.text });
  const after = snapshotAt(next);
  if (change.text !== undefined) {
    if (after && !after.exact && after.text === change.text) return { step: after.step, observation: seen(after) };
    const own = snapshotAt(change.step);
    if (own && own.text === change.text) {
      if (!own.exact) return { step: own.step, observation: seen(own) };
      if (next !== undefined) return { step: next, observation: { step: next, scopeId: own.scopeId, text: own.text } };
    }
  }
  if (next === undefined) return undefined;
  return after && !after.exact ? { step: next, observation: seen(after) } : { step: next };
}

/** The last snapshot of `name` at or before `step` in one of `scopes` (the step's own, then the module's). */
export function lastObservation(locals: readonly LocalsEntry[], name: string, step: number, scopes: readonly number[]): Observation | undefined {
  let best: Observation | undefined;
  let rank = Infinity;
  for (const entry of locals) {
    if (entry.step > step) break;
    const r = scopes.indexOf(entry.scopeId);
    if (r < 0) continue;
    const ch = entry.changes.find((c) => c.name === name);
    // the step's own scope wins over the module's, and a later snapshot over an earlier one in the same scope
    if (ch && (r < rank || (r === rank && (!best || entry.step >= best.step)))) {
      best = { step: entry.step, scopeId: entry.scopeId, text: ch.text };
      rank = r;
    }
  }
  return best;
}

/** `replay.expect`: base64 of little-endian int32 pairs (rid, depth) for steps 0..`last` of a trace's quads. */
export function expectPairs(quads: Int32Array, last: number): string {
  const n = last + 1;
  const pairs = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pairs[2 * i] = quads[4 * i]!;
    pairs[2 * i + 1] = quads[4 * i + 2]!;
  }
  return Buffer.from(pairs.buffer, pairs.byteOffset, pairs.byteLength).toString('base64');
}

/** A recorded text as it compares across runs: object addresses (`at 0x10719ce00`) differ from process to process. */
export function comparable(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{4,}/g, '0x…');
}

/** Why this run cannot be replayed, in a sentence; undefined when it can. */
export function refusal(input: { request?: Omit<RunRequest, 'type' | 'id'>; midRun?: boolean; startedAt?: number; httpCount: number; running: boolean; paused: boolean; transport: boolean; step: number; count: number }): string | undefined {
  if (input.running && !input.paused) return 'A run is in flight. Ask again when it finishes or pauses.';
  if (input.transport) return 'This session runs in a container or another machine; a rerun needs a local interpreter for now.';
  if (!input.request) return 'Pyokka did not keep how this run was started. Run the file again, then ask.';
  if (input.request.module) return 'A module launch cannot be rerun: the recording needs a file.';
  if (input.request.mode !== 'normal') return 'Only a normal run can be rerun (not a profile or snaps run).';
  // a recording that began at a pause replays by running unrecorded to the statement it began at; a runtime older than that kept no such point
  if (input.midRun && input.startedAt === undefined) return 'This recording began at a pause, and the runtime that made it did not keep where. Record it again with this version, or record the whole run (--record).';
  if (input.step < 0 || input.step >= input.count) return `Step ${input.step} is not in this run (it has ${input.count} steps).`;
  const config = input.request.config;
  if (config.httpObserve === false) return 'HTTP observation is off for this session, so Pyokka cannot tell whether this run called the network, and a rerun could call it again. Turn httpObserve on and run once.';
  if (config.http === 'off' && input.httpCount > 0) {
    const n = input.httpCount === 1 ? 'one request' : `${input.httpCount} requests`;
    return `This run called the network (${n}) and the answers were not recorded, so a rerun would call it again, could get other answers and spend tokens. Switch HTTP to Record in Settings, run once, then ask again.`;
  }
  return undefined;
}

/**
 * The run request a replay sends: the recording run's own (same file content, project files,
 * markers and limits, so the instrumentation and the steps are the same), with no debugger, no
 * watches, recorded HTTP answers instead of the network, and the `replay` field.
 */
export function replayRequest(original: Omit<RunRequest, 'type' | 'id'>, runId: string, replay: { expect: string; at: { step: number; expr: string }; check?: { step: number; name: string }; inputs?: InputsRecord }): Omit<RunRequest, 'type' | 'id'> {
  const { debug: _debug, record: _record, stopOnEntry: _stop, breakOnException: _brk, recordFrom: _from, ...config } = original.config;
  const { breakpoints: _bps, traceContext: _ctx, ...rest } = original;
  return {
    ...rest,
    runId,
    // twice the run's own limit: a run that just fit should not fail on the replay's check of every step
    config: { ...config, http: config.http === 'off' ? 'off' : 'replay', timeoutMs: replayTimeout(config.timeoutMs) },
    watch: [],
    expressionsToEvaluate: {},
    replay,
  };
}

/** A replay's time limit from the run's (0 or none is no limit, as for the run). */
export function replayTimeout(runTimeoutMs: number | undefined): number {
  return runTimeoutMs && runTimeoutMs > 0 ? runTimeoutMs * 2 : 0;
}

export interface Difference {
  step: number;
  name: string;
  recorded: string;
  replay: string;
}

/** Log kinds whose text is the program's own output or values (a timing differs every run; a system line is the runtime's). */
const COMPARED_LOGS: ReadonlySet<string> = new Set(['log', 'value', 'autoLog', 'autoExpand', 'logpoint', 'error']);

interface Flat {
  step: number;
  key: string;
  name: string;
  text: string;
}

function flatLocals(entries: readonly LocalsEntry[], before: number): Flat[] {
  const out: Flat[] = [];
  for (const e of entries) {
    if (e.step >= before) continue;
    for (const c of e.changes) out.push({ step: e.step, key: `${e.step}|${e.scopeId}|${c.name}`, name: c.name, text: comparable(c.text) });
  }
  return out;
}

function flatLogs(logs: readonly LogEvent[], before: number): Flat[] {
  return logs.filter((l) => l.step < before && COMPARED_LOGS.has(l.kind)).map((l) => ({ step: l.step, key: `${l.step}|${l.rid}|${l.kind}`, name: l.kind === 'log' ? 'printed' : (l.context ?? 'logged'), text: comparable(l.text) }));
}

function firstMismatch(recorded: Flat[], replay: Flat[]): Difference | undefined {
  const n = Math.max(recorded.length, replay.length);
  for (let i = 0; i < n; i++) {
    const a = recorded[i];
    const b = replay[i];
    if (a && b && a.key === b.key) {
      if (a.text !== b.text) return { step: a.step, name: a.name, recorded: a.text, replay: b.text };
      continue;
    }
    // one run saw a change, or a log, the other did not: the earlier of the two is where they part
    if (a && (!b || a.step <= b.step)) return { step: a.step, name: a.name, recorded: a.text, replay: 'nothing at this step' };
    if (b) return { step: b.step, name: b.name, recorded: 'nothing at this step', replay: b.text };
  }
  return undefined;
}

/**
 * The first value the replay produced differently, before step `before`: every recorded local
 * and every logged value of the recording against the replay's, in order. `compared` counts what
 * was compared on the recording's side.
 */
export function compareRecorded(recorded: { locals: readonly LocalsEntry[]; logs: readonly LogEvent[] }, replay: { locals: readonly LocalsEntry[]; logs: readonly LogEvent[] }, before: number): { difference?: Difference; compared: number } {
  const rl = flatLocals(recorded.locals, before);
  const rg = flatLogs(recorded.logs, before);
  const candidates = [firstMismatch(rl, flatLocals(replay.locals, before)), firstMismatch(rg, flatLogs(replay.logs, before))].filter((d): d is Difference => !!d);
  candidates.sort((x, y) => x.step - y.step);
  return { difference: candidates[0], compared: rl.length + rg.length };
}

/** `#12 invoices.py:26 parse_orders`, for a divergence message: where a step ran in the recording. */
export type Locate = (rid: number) => string;

/**
 * The pane's view of a replay's answer. `observation` is the snapshot compared at its step
 * (`check`); `compare` is the comparison of everything recorded on the way.
 */
export function interpret(
  key: string,
  query: { step: number; name: string },
  result: ReplayResultEvent | undefined,
  compare: { difference?: Difference; compared: number },
  observation: Observation | undefined,
  locate: Locate,
  ms: number,
  notes: { inputs: 'handed back' | 'none recorded' | 'run paused'; valuesUntil?: number; console?: boolean },
): FullValueView {
  const base = { key, step: query.step, name: query.name, ms: Math.round(ms) };
  // code typed at a pause ran in the recording only: said after whatever the replay found
  const view = (status: FullValueStatus, summary: string, extra: Partial<FullValueView> = {}): FullValueView => ({ ...base, status, summary: summary + (notes.console && status !== 'error' ? CONSOLE_NOTE : ''), ...extra });
  if (!result) return view('error', 'The rerun ended without an answer. The Pyokka log has what the runtime printed.');
  const matched = result.matched;
  switch (result.status) {
    case 'diverged': {
      const where = result.expected && result.actual ? ` The recording ran ${locate(result.expected.rid)}, the rerun ran ${locate(result.actual.rid)}.` : result.message ? ` ${result.message}.` : '';
      return view('diverged', `The rerun went another way at step #${result.step}, so it has no value from this run.${where}${inputsNote(notes.inputs)}`, { matched });
    }
    case 'input':
      return view('diverged', `The rerun went another way at step #${result.step}: ${result.message ?? 'the program read something the recording does not have'}.`, { matched });
    case 'ended':
      return view('diverged', `The rerun finished at step #${result.step}, before step #${query.step}: it went another way.${inputsNote(notes.inputs)}`, { matched });
    case 'error':
      return view('error', `The rerun failed: ${result.message ?? 'no reason given'}.`, { matched });
    case 'reached':
      break;
  }
  if (result.missing) return view('unavailable', `${query.name} is not defined at step #${query.step}: ${result.missing}.`, { matched });
  if (result.error || !result.value) return view('error', `Evaluating ${query.name} at step #${query.step} failed: ${result.error ?? 'no value came back'}.`, { matched });
  let difference = compare.difference;
  let compared = compare.compared;
  const itself = !!observation && result.check?.step === observation.step && result.check.text !== undefined;
  if (itself) {
    compared++;
    const replayed = comparable(result.check!.text!);
    const kept = comparable(observation!.text);
    if (replayed !== kept && (!difference || observation!.step < difference.step)) difference = { step: observation!.step, name: query.name, recorded: kept, replay: replayed };
  }
  const value = result.value.data;
  if (difference) {
    return view('differs', `The rerun took the same ${matched} steps, but ${difference.name} at step #${difference.step} came out different from what the recording kept, so this copy is not quite your run's value.`, { value, difference, matched });
  }
  if (compared === 0) {
    return view('path', `The rerun took the same ${matched} steps. The recording kept no values on the way to compare with, so only the path is checked.${inputsNote(notes.inputs)}`, { value, matched });
  }
  const count = compared === 1 ? 'the one value' : `all ${compared} values`;
  const own = itself ? '' : ` The recording kept no text of ${query.name} itself to compare with.`;
  // past the recorder's cap on changes nothing was kept: those steps were compared by the path alone
  const capped = notes.valuesUntil !== undefined && notes.valuesUntil < query.step ? ` The recording stopped keeping values at step #${notes.valuesUntil} (its limit of ${MAX_LOCALS_ENTRIES.toLocaleString('en-US')} changes), so after it only the path was compared.` : '';
  return view('checked', `The rerun took the same ${matched} steps, and ${count} the recording kept on the way came out the same.${KEPT_LIMIT}${own}${capped}${inputsNote(notes.inputs)}`, { value, matched });
}

/** A recording whose run had code typed in the Debug Console at a pause: the replay ran without it. */
export const CONSOLE_NOTE = ' Code typed in the Debug Console ran at a pause of this run. A rerun runs the program without it, so a value that code changed comes out as the program made it.';

/** What "checked" cannot cover: the comparison stops where the recorder's text of each value stops. */
export const KEPT_LIMIT = ' Each was compared as far as the recording kept it (by default 120 characters, three levels deep), so a difference deeper in this copy, from a file or a database that changed since, would not show.';

function inputsNote(inputs: 'handed back' | 'none recorded' | 'run paused'): string {
  if (inputs === 'none recorded') return ' No outside inputs were recorded for this run, so the clock and random numbers were read fresh.';
  if (inputs === 'run paused') return ' The run is paused, so its outside inputs are not recorded yet; the clock and random numbers were read fresh.';
  return '';
}
