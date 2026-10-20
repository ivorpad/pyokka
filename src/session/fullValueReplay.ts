/**
 * Run one replay for "Full value": a runner of its own (so the session's run, its Time Machine
 * and its finished child stay as they are), the recording run's request with a `replay` field,
 * and the events that come back. vscode-free: the session side (fullValueSession.ts) hands in
 * what the run kept and a way to make a runner, so tests drive it with a fake one.
 */
import { MAX_LOCALS_ENTRIES, type LocalsEvent, type LogEvent, type RunEvent, type RunRequest } from '../shared/protocol';
import type { InputsRecord, ReplayResultEvent, FullValueView } from '../shared/replayProtocol';
import { changeTarget, compareRecorded, expectPairs, interpret, lastObservation, nextInScope, refusal, replayRequest, type Observation } from './fullValue';

type LocalsEntry = LocalsEvent['entries'][number];

/** What a replay needs of a runner: the subset of `RunnerClient` it uses. */
export interface ReplayRunner {
  start(): Promise<{ capabilities: string[] }>;
  run(req: Omit<RunRequest, 'type' | 'id'>): Promise<void>;
  on(event: 'event', fn: (ev: RunEvent) => void): unknown;
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null, willRestart: boolean) => void): unknown;
  dispose(): void;
}

/** What the run kept, and how to start a runner like the session's. */
export interface ReplaySource {
  runId: string;
  request?: Omit<RunRequest, 'type' | 'id'>;
  /** the run's trace quads (rid, scope, depth, flags) */
  steps: Int32Array;
  count: number;
  scopeId: (step: number) => number;
  locals: readonly LocalsEntry[];
  logs: readonly LogEvent[];
  inputs?: InputsRecord;
  midRun?: boolean;
  /** with `midRun`: the debugger's statement count where the recording began (`trace.startedAt`) */
  startedAt?: number;
  httpCount: number;
  running: boolean;
  paused: boolean;
  /** the session runs over a transport (a container): no local runner to replay in */
  transport: boolean;
  /** `invoices.py:26` for a statement id of this run */
  locate: (rid: number) => string;
  makeRunner: () => ReplayRunner | undefined;
  timeoutMs: number;
}

export interface FullValueQuery {
  key: string;
  /** `change`: the value the statement at `step` made (a Variable pane row, a why tree's root when its step made it); `at`: the value when `step` began */
  kind: 'change' | 'at';
  step: number;
  name: string;
  /** the change's scope; absent: the scope of `step` */
  scopeId?: number;
  /** the row's recorded text, which says whether its snapshot is at its own step or at the scope's next (`changeTarget`) */
  text?: string;
}

/** The capability a runtime needs to answer a `replay` run. */
export const REPLAY_CAPABILITY = 'replay';

let serial = 0;

export async function replayFullValue(src: ReplaySource, query: FullValueQuery): Promise<FullValueView> {
  const started = Date.now();
  const unavailable = (step: number, summary: string): FullValueView => ({ key: query.key, status: 'unavailable', step, name: query.name, summary });
  // where the value is read, and which snapshot it is compared with
  let target = query.step;
  let observation: Observation | undefined;
  const inRange = query.step >= 0 && query.step < src.count;
  if (query.kind === 'change' && inRange) {
    const scopeId = query.scopeId ?? src.scopeId(query.step);
    const read = changeTarget(src.locals, { step: query.step, scopeId, name: query.name, text: query.text }, nextInScope(src.scopeId, src.count, query.step, scopeId));
    if (!read) return unavailable(query.step, `No later step ran in the scope of step #${query.step}, so none shows the value it gave ${query.name}.`);
    target = read.step;
    observation = read.observation;
  } else if (inRange) {
    observation = lastObservation(src.locals, query.name, target, [src.scopeId(target), 0]);
  }
  const refused = refusal({ request: src.request, midRun: src.midRun, startedAt: src.startedAt, httpCount: src.httpCount, running: src.running, paused: src.paused, transport: src.transport, step: target, count: src.count });
  if (refused) return unavailable(target, refused);
  const runner = src.makeRunner();
  if (!runner) return unavailable(target, 'No runner could be started for the replay.');
  const runId = `${src.runId}-replay-${++serial}`;
  const request = replayRequest(src.request!, runId, {
    expect: expectPairs(src.steps, target),
    at: { step: target, expr: query.name },
    ...(observation ? { check: { step: observation.step, name: query.name } } : {}),
    ...(src.inputs ? { inputs: src.inputs } : {}),
    ...(src.midRun && src.startedAt !== undefined ? { startAt: src.startedAt } : {}),
  });
  const locals: LocalsEntry[] = [];
  const logs: LogEvent[] = [];
  let result: ReplayResultEvent | undefined;
  let timedOut = false;
  try {
    const ready = await runner.start();
    if (!ready.capabilities.includes(REPLAY_CAPABILITY)) return unavailable(target, 'The Pyokka runtime in dist/python is older than the extension and cannot replay. Reinstall the extension.');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the replay did not reach step #${target} within ${Math.round(src.timeoutMs / 1000)} s`)), src.timeoutMs);
      runner.on('event', (ev) => {
        if (ev.runId !== runId) return;
        if (ev.type === 'locals') locals.push(...ev.entries);
        else if (ev.type === 'log') logs.push(ev);
        else if (ev.type === 'replay.result') {
          result = ev;
          // a refused replay (a bad request, a run that records from a pause) lets the program run on unattached: stop here
          if (ev.status === 'error') {
            clearTimeout(timer);
            resolve();
          }
        } else if (ev.type === 'run.finished') {
          timedOut = ev.timedOut;
          clearTimeout(timer);
          resolve();
        }
      });
      runner.on('exit', (code) => {
        clearTimeout(timer);
        if (result) resolve();
        else reject(new Error(`the replay's runner exited (code ${code ?? 'null'}) before it answered`));
      });
      runner.run(request).catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  } catch (err) {
    if (!result) return { key: query.key, status: 'error', step: target, name: query.name, summary: `The replay failed: ${err instanceof Error ? err.message : String(err)}.`, ms: Date.now() - started };
  } finally {
    runner.dispose();
  }
  if (!result && timedOut) {
    const limit = Math.round((request.config.timeoutMs ?? 0) / 1000);
    return { key: query.key, status: 'error', step: target, name: query.name, summary: `The replay hit its time limit (${limit} s, twice the Run Timeout) before step #${target}. Raise the Run Timeout in Settings and ask again.`, ms: Date.now() - started };
  }
  const compare = compareRecorded({ locals: src.locals, logs: src.logs }, { locals, logs }, target);
  const inputs = src.inputs ? 'handed back' : src.paused && src.running ? 'run paused' : 'none recorded';
  // the recorder stops keeping changes at its cap; the steps past the last one kept are compared by path only
  const valuesUntil = src.locals.length >= MAX_LOCALS_ENTRIES ? src.locals[src.locals.length - 1]!.step : undefined;
  return interpret(query.key, { step: target, name: query.name }, result, compare, observation, src.locate, Date.now() - started, { inputs, valuesUntil });
}
