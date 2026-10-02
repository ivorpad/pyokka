/** The TOUR section's host: one Python run per session run, resume by file, Narrate Tour cached per run and refused once. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const warnings: string[] = [];
vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined }),
    withProgress: (_o: unknown, fn: (p: unknown, t: unknown) => unknown) => fn({}, { isCancellationRequested: false }),
    showWarningMessage: (m: string) => {
      warnings.push(m);
      return Promise.resolve(undefined);
    },
    showInformationMessage: () => Promise.resolve(undefined),
  },
  ProgressLocation: { Window: 10 },
}));
vi.mock('../../src/agent/bridgeSupport', () => ({ sessionRecording: () => ({ meta: { runId: 'r' }, events: [] }) }));

import { TourHost, TOUR_RESUME_KEY } from '../../src/views/tourPane';
import { TourError } from '../../src/agent/tourRun';
import type { TourDoc } from '../../src/session/tourTypes';
import type { HostToWebview, TourPanel } from '../../src/shared/webviewProtocol';

const fixture = (): TourDoc => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tour-rrf.json'), 'utf8')) as TourDoc;

function fakeSession(runId = 'r-1', locals: { recordLocals: boolean; changes: number } = { recordLocals: true, changes: 1 }) {
  const runs: string[] = [];
  return {
    runs,
    recordLocals: locals.recordLocals,
    setRecordLocals(on: boolean) {
      this.recordLocals = on;
    },
    runNow: async (reason: string) => void runs.push(reason),
    key: 'k',
    filePath: '/w/rrf.py',
    displayName: 'rrf.py',
    running: false,
    isDisposed: false,
    interpreter: { path: 'python3' },
    state: { runId, finished: { exitCode: 0 }, locals: Array.from({ length: locals.changes }, () => ({})), files: { all: () => [{ fileId: 0, path: '/w/rrf.py' }] } },
    displayPath: () => 'rrf.py',
  };
}

function setup(answer = '{"pick": ["s53-189112"], "stops": {}}') {
  const store = new Map<string, unknown>();
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-tour-ext-'));
  fs.mkdirSync(path.join(ext, 'skills', 'pyokka', 'references'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'skills', 'pyokka', 'references', 'tour-prompt.md'), '# Tour prompt\n');
  const context = { extensionPath: ext, workspaceState: { get: (k: string, d: unknown) => store.get(k) ?? d, update: async (k: string, v: unknown) => void store.set(k, v) } };
  const askModel = vi.fn(async (_prompt: string) => answer);
  const narrator = { canNarrate: () => true, askModel };
  const posted: (TourPanel | null)[] = [];
  const calls: string[][] = [];
  let next: (argv: string[]) => TourDoc = () => fixture();
  const run = vi.fn(async (_o: unknown, argv: string[]) => {
    calls.push(argv);
    return next(argv);
  });
  const host = new TourHost(context as never, '/rt', narrator as never, (_s, msg: HostToWebview) => msg.type === 'tour' && posted.push(msg.tour), run as never);
  return { host, store, askModel, posted, calls, setNext: (f: typeof next) => (next = f) };
}

beforeEach(() => {
  warnings.length = 0;
});

describe('TourHost', () => {
  it('computes once per run with `tour RUN --json`, posting computing then the tour', async () => {
    const t = setup();
    const s = fakeSession();
    expect(await t.host.ensure(s as never)).toBeDefined();
    await t.host.ensure(s as never);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]![0]).toBe('tour');
    expect(t.calls[0]![1]).toMatch(/pyokka-tour-.*run\.json$/);
    expect(t.calls[0]!.at(-1)).toBe('--json');
    expect(t.posted[0]?.status).toBe('computing');
    expect(t.posted.at(-1)).toMatchObject({ status: 'ready', runId: 'r-1' });
    expect(t.posted.at(-1)!.stops).toHaveLength(35);
    await t.host.ensure(fakeSession('r-2') as never);
    expect(t.calls).toHaveLength(2);
  });

  it('computes after a run only while the section is open', async () => {
    const t = setup();
    const s = fakeSession();
    t.host.afterRun(s as never);
    expect(t.calls).toHaveLength(0);
    t.host.setOpen(s as never, true);
    await t.host.ensure(s as never);
    expect(t.calls).toHaveLength(1);
  });

  it('remembers the clicked stop per file and reopens at the same statement after a re-run', async () => {
    const t = setup();
    await t.host.ensure(fakeSession() as never);
    await t.host.remember(fakeSession() as never, 's73-66ea63');
    expect((t.store.get(TOUR_RESUME_KEY) as Record<string, unknown>)['/w/rrf.py']).toMatchObject({ stopId: 's73-66ea63', key: '66ea63', pass: 1 });
    expect(t.posted.at(-1)!.resumeStopId).toBe('s73-66ea63');
    t.setNext(() => {
      const d = fixture();
      for (const c of d.candidates) {
        c.step += 3;
        c.id = `s${c.step}-${c.key}`;
      }
      return d;
    });
    await t.host.ensure(fakeSession('r-2') as never);
    expect(t.host.panel(fakeSession('r-2') as never)!.resumeStopId).toBe('s76-66ea63');
  });

  it('narrates with one model call, merges through `tour --prose`, and caches the result for the run', async () => {
    const t = setup();
    const s = fakeSession();
    t.setNext((argv) => {
      const d = fixture();
      if (argv.includes('--prose')) {
        d.pick = ['s53-189112'];
        d.candidates.find((c) => c.id === 's53-189112')!.prose = { title: 'The first score', text: 'Rank 1.', order: 1 };
      }
      return d;
    });
    const merged = await t.host.narrate(s as never);
    expect(merged?.pick).toEqual(['s53-189112']);
    expect(t.askModel).toHaveBeenCalledTimes(1);
    expect(t.askModel.mock.calls[0]![0].startsWith('# Tour prompt\n\n{"tour":1,')).toBe(true);
    const proseArgv = t.calls.at(-1)!;
    expect(proseArgv.slice(proseArgv.indexOf('--prose'), proseArgv.indexOf('--prose') + 2)[1]).toMatch(/prose\.json$/);
    expect(proseArgv[1]).toBe(t.calls[0]![1]);
    expect(t.posted.at(-1)).toMatchObject({ narrated: true, narrating: false });
    await t.host.narrate(s as never);
    expect(t.askModel).toHaveBeenCalledTimes(1);
  });

  it('shows the reasons of a refused narration once and keeps the plain tour', async () => {
    const t = setup();
    const s = fakeSession();
    t.setNext((argv) => {
      if (argv.includes('--prose')) throw new TourError('the prose has 1 problems', 'fix them', ['s12-abc.text: number 37 is not in the stop\'s values or quote']);
      return fixture();
    });
    expect(await t.host.narrate(s as never)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('number 37 is not in the stop');
    expect(t.host.lastError(s as never)).toBe("the prose has 1 problems: s12-abc.text: number 37 is not in the stop's values or quote");
    expect(t.posted.at(-1)).toMatchObject({ narrated: false, narrating: false, status: 'ready' });
    expect(t.posted.at(-1)!.narrationError).toContain('number 37');
  });

  it('says when the run recorded no variable changes, and its button turns them on and runs once', async () => {
    const t = setup();
    const off = fakeSession('r-1', { recordLocals: false, changes: 0 });
    await t.host.ensure(off as never);
    expect(t.host.panel(off as never)!.noLocals).toBe(true);
    expect(t.host.panel(fakeSession() as never)!.noLocals).toBe(false);
    // the setting already on for the next run: no notice
    expect(t.host.panel(fakeSession('r-1', { recordLocals: true, changes: 0 }) as never)!.noLocals).toBe(false);
    await t.host.recordLocalsAndRun(off as never);
    expect(off.recordLocals).toBe(true);
    expect(off.runs).toEqual(['tour: record variable changes']);
  });

  it('reports an answer without JSON as a narration failure, without calling the merge', async () => {
    const t = setup('I cannot do that');
    const s = fakeSession();
    expect(await t.host.narrate(s as never)).toBeUndefined();
    expect(t.calls.some((a) => a.includes('--prose'))).toBe(false);
    expect(t.host.lastError(s as never)).toBe('the model did not answer with a JSON object');
    expect(warnings).toHaveLength(1);
  });
});
