/**
 * "Full value" against the real runtime (python/, run with python/.venv): a recording run of
 * invoices.py, then the replay the panel asks for, through the same code (fullValueReplay.ts).
 * Skipped when the checkout has no python/.venv.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RunnerClient } from '../../src/runtime/runnerClient';
import { decodeSteps, type LocalsEvent, type LogEvent, type RunEvent, type RunRequest } from '../../src/shared/protocol';
import type { InputsRecord } from '../../src/shared/replayProtocol';
import { replayFullValue, type ReplaySource } from '../../src/session/fullValueReplay';
import { pinnedHashSeed } from '../../src/runtime/hashSeed';

const REPO = path.resolve(__dirname, '..', '..');
const PYTHON = path.join(REPO, 'python', '.venv', 'bin', 'python');
const INVOICES = path.join(REPO, 'claude-plugin', 'pyokka-band', 'tests', 'programs', 'invoices.py');
const runtime = fs.existsSync(PYTHON) ? describe : describe.skip;
const runners: RunnerClient[] = [];

/** `env` as a session gives its runners (session.ts): the recording's and the replay's get the same */
function runner(env?: Record<string, string>): RunnerClient {
  const r = new RunnerClient({ command: PYTHON, args: ['-m', 'pyokka_runtime', 'serve'], cwd: path.join(REPO, 'python'), requestTimeoutMs: 30_000, ...(env ? { env } : {}) });
  runners.push(r);
  return r;
}

afterAll(() => {
  for (const r of runners) r.dispose();
});

function request(file: string, runId: string): Omit<RunRequest, 'type' | 'id'> {
  return {
    runId,
    file: { path: file, displayName: path.basename(file), content: fs.readFileSync(file, 'utf8') },
    workspaceRoot: path.dirname(file),
    cwd: path.dirname(file),
    argv: [],
    env: {},
    projectFiles: [],
    config: { recordLocals: true, http: 'off', httpObserve: true, timeoutMs: 30_000 } as RunRequest['config'],
    markers: [],
    expressionsToEvaluate: {},
    watch: [],
    mode: 'normal',
  };
}

/** One recording run, kept the way a session keeps it; `debug` makes it the recording debug run a review starts. */
async function record(file: string, debug = false, env?: Record<string, string>): Promise<{ req: Omit<RunRequest, 'type' | 'id'>; steps: Int32Array; scopes: Map<number, number>; locals: LocalsEvent['entries']; logs: LogEvent[]; inputs?: InputsRecord }> {
  const r = runner(env);
  await r.start();
  const req = request(file, `r-${path.basename(file)}${debug ? '-debug' : ''}`);
  if (debug) req.config = { ...req.config, debug: true, record: true, stopOnEntry: false, breakOnException: 'uncaught' };
  const events: RunEvent[] = [];
  const done = new Promise<void>((resolve) => r.on('event', (ev) => (events.push(ev), ev.type === 'run.finished' && resolve())));
  await r.run(req);
  await done;
  const trace = [...events].reverse().find((e): e is Extract<RunEvent, { type: 'trace' }> => e.type === 'trace' && !e.partial)!;
  const steps = decodeSteps(trace.steps);
  const inputs = events.find((e): e is Extract<RunEvent, { type: 'inputs' }> => e.type === 'inputs');
  return {
    req,
    steps,
    scopes: new Map(Array.from({ length: steps.length / 4 }, (_, i) => [i, steps[4 * i + 1]!])),
    locals: events.flatMap((e) => (e.type === 'locals' ? e.entries : [])),
    logs: events.filter((e): e is LogEvent => e.type === 'log'),
    inputs: inputs ? { seed: inputs.seed, reads: inputs.reads, ...(inputs.truncated ? { truncated: true } : {}) } : undefined,
  };
}

function source(run: Awaited<ReturnType<typeof record>>, overrides: Partial<ReplaySource> = {}): ReplaySource {
  return {
    runId: run.req.runId,
    request: run.req,
    steps: run.steps,
    count: run.steps.length / 4,
    scopeId: (i) => run.scopes.get(i) ?? 0,
    locals: run.locals,
    logs: run.logs,
    inputs: run.inputs,
    httpCount: 0,
    running: false,
    paused: false,
    transport: false,
    locate: (rid) => `rid ${rid}`,
    makeRunner: runner,
    timeoutMs: 60_000,
    ...overrides,
  };
}

runtime('full value, real runtime', () => {
  it('invoices.py: the whole orders, checked against every value the recording kept', async () => {
    const run = await record(INVOICES);
    // the last snapshot of orders in main is where its change row points; ask for it as the row would
    const main = run.locals.filter((e) => e.changes.some((c) => c.name === 'orders' && c.text.startsWith("{'Ana'")));
    const row = main[main.length - 1]!;
    const view = await replayFullValue(source(run), { key: 'k', kind: 'change', step: row.step - 1, name: 'orders', scopeId: row.scopeId });
    expect(view.status, view.summary).toBe('checked');
    expect(view.step).toBe(row.step);
    expect(view.value?.props?.map((p) => p.name)).toEqual(['Ana', 'Ben', 'Caro', 'Dani']);
    const ben = view.value!.props!.find((p) => p.name === 'Ben')!;
    const price = ben.props!.find((p) => p.name === 'items')!.props![0]!.props!.find((p) => p.name === 'unit_price')!;
    expect(price).toMatchObject({ type: 'str', value: '1,299.00' });
    // what the recorder kept of the same value was cut
    expect(row.changes.find((c) => c.name === 'orders')!.text).toContain('…(+');
  }, 60_000);

  it('a recording debug run (what a review of a program starts) replays as a plain run takes the same steps', async () => {
    const run = await record(INVOICES, true);
    const plain = await record(INVOICES);
    expect(Array.from(run.steps)).toEqual(Array.from(plain.steps));
    const last = run.steps.length / 4 - 1;
    const view = await replayFullValue(source(run), { key: 'k', kind: 'at', step: last, name: 'orders' });
    expect(view.status, view.summary).toBe('checked');
  }, 60_000);

  it('a recording that began at a pause replays by running unrecorded to where it began', async () => {
    // the debugger runs invoices.py and starts recording at main's entry; a continue lets it finish
    const r = runner();
    await r.start();
    const req = request(INVOICES, 'r-record-from');
    req.config = { ...req.config, debug: true, record: true, stopOnEntry: false, recordFrom: { function: 'main' } };
    req.breakpoints = [{ function: 'main' }]; // `--record-from main` breaks there, and that pause starts the recording
    const events: RunEvent[] = [];
    const done = new Promise<void>((resolve) =>
      r.on('event', (ev) => {
        events.push(ev);
        if (ev.type === 'debug.paused') void r.debug(req.runId, { action: 'continue' });
        if (ev.type === 'run.finished') resolve();
      }),
    );
    await r.run(req);
    await done;
    const trace = [...events].reverse().find((e): e is Extract<RunEvent, { type: 'trace' }> => e.type === 'trace' && !e.partial)!;
    expect(trace.midRun).toBe(true);
    expect(typeof trace.startedAt).toBe('number');
    const steps = decodeSteps(trace.steps);
    const run = { req, steps, scopes: new Map(Array.from({ length: steps.length / 4 }, (_, i) => [i, steps[4 * i + 1]!])), locals: events.flatMap((e) => (e.type === 'locals' ? e.entries : [])), logs: events.filter((e): e is LogEvent => e.type === 'log'), inputs: undefined };
    const last = steps.length / 4 - 1;
    const view = await replayFullValue(source(run, { midRun: true, startedAt: trace.startedAt }), { key: 'k', kind: 'at', step: last, name: 'orders' });
    expect(view.status, view.summary).toBe('checked');
    expect(view.value?.props?.map((p) => p.name)).toEqual(['Ana', 'Ben', 'Caro', 'Dani']);
    // one statement off is another start point: the replay says so instead of answering
    const off = await replayFullValue(source(run, { midRun: true, startedAt: trace.startedAt! + 1 }), { key: 'k', kind: 'at', step: last, name: 'orders' });
    expect(off.status, off.summary).toBe('diverged');
    expect(off.summary).toContain('start point did not match');
  }, 60_000);

  it('a random program replays with its inputs, and a different seed goes another way at the draw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-full-'));
    const file = path.join(dir, 'draws.py');
    fs.writeFileSync(file, 'import random\nimport time\n\npicked = []\nfor name in ["Ana", "Ben", "Caro", "Dani"]:\n    if random.random() < 0.5:\n        picked.append(name)\nstamp = time.time()\nprint(picked, stamp)\nresult = picked\n');
    const run = await record(file);
    expect(run.inputs?.reads.map(([label]) => label)).toEqual(['time']);
    const last = run.steps.length / 4 - 1;
    const same = await replayFullValue(source(run), { key: 'k', kind: 'at', step: last, name: 'picked' });
    expect(same.status, same.summary).toBe('checked');
    // a seed whose first draw lands on the other side of 0.5 cannot take the same steps
    const first = await firstDrawBelowHalf(run.inputs!.seed);
    let other = 1;
    while ((await firstDrawBelowHalf(other)) === first) other++;
    const off = await replayFullValue(source(run, { inputs: { ...run.inputs!, seed: other } }), { key: 'k', kind: 'at', step: last, name: 'picked' });
    expect(off.status, off.summary).toBe('diverged');
    expect(off.value).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

runtime('full value, real runtime: str hashing', () => {
  it('a set of strings replays in the order the run iterated it, with the seed the session pins for both runners', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-full-'));
    const file = path.join(dir, 'tags.py');
    fs.writeFileSync(file, 'import os\n\ntags = {"tag-%02d" % i for i in range(20)}\nordered = list(tags)\nseen = (os.environ.get("PYTHONHASHSEED"), os.environ.get("PYOKKA_PINNED_HASHSEED"))\nresult = ordered[0]\n');
    const env = pinnedHashSeed();
    const run = await record(file, false, env);
    const last = run.steps.length / 4 - 1;
    const pinned = await replayFullValue(source(run, { makeRunner: () => runner(env) }), { key: 'k', kind: 'at', step: last, name: 'ordered' });
    expect(pinned.status, pinned.summary).toBe('checked');
    // the program never sees the pin
    expect(run.locals.flatMap((e) => e.changes).find((c) => c.name === 'seen')?.text).toBe('(None, None)');
    // an interpreter that salts with another seed (0.7.0 pinned none) iterates the set in another order
    const unpinned = await replayFullValue(source(run, { makeRunner: () => runner() }), { key: 'k', kind: 'at', step: last, name: 'ordered' });
    expect(unpinned.status, unpinned.summary).toBe('differs');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('a seed the user set is theirs: nothing is pinned', () => {
    expect(pinnedHashSeed({ PYTHONHASHSEED: '7' })).toEqual({});
    expect(pinnedHashSeed(undefined, { PYTHONHASHSEED: '0' })).toEqual({});
    const pin = pinnedHashSeed({ PATH: '/usr/bin' });
    expect(pin['PYTHONHASHSEED']).toMatch(/^[1-9]\d*$/);
    expect(pin['PYOKKA_PINNED_HASHSEED']).toBe(pin['PYTHONHASHSEED']);
  });
});

/** `random.Random(seed).random() < 0.5`, asked of Python itself so the generator is the program's. */
async function firstDrawBelowHalf(seed: number): Promise<boolean> {
  const { execFileSync } = await import('node:child_process');
  return execFileSync(PYTHON, ['-c', `import random; print(random.Random(${seed}).random() < 0.5)`]).toString().trim() === 'True';
}
