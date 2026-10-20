import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScratchEntry, ScratchResult } from '../../web/scratchpadProtocol';

const doubles = vi.hoisted(() => ({ post: vi.fn(), editors: [] as any[] }));
vi.mock('../../webview/monaco', () => ({ monaco: { editor: { create: () => {
  let value = '';
  const listeners: (() => void)[] = [];
  const editor = {
    getValue: () => value,
    setValue: (next: string) => { value = next; listeners.forEach((fn) => fn()); },
    onDidChangeModelContent: (fn: () => void) => listeners.push(fn),
    createDecorationsCollection: () => ({ clear() {} }), layout() {},
  };
  doubles.editors.push(editor);
  return editor;
} } } }));
vi.mock('../../web/scratchpadClient', async (original) => ({ ...await original<typeof import('../../web/scratchpadClient')>(), post: doubles.post }));
vi.mock('../../web/scratchpadView', () => ({ SCRATCH_MARKUP: '', renderResult() {}, renderSandbox() {} }));
vi.mock('../../web/narrationZone', () => ({ NarrationZone: class { set() {} current() { return null; } } }));
import { Scratchpad } from '../../web/scratchpad';
import { ScratchpadRefusal } from '../../web/scratchpadClient';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const entries = new Map<string, ScratchEntry[]>();
  const saves: any[] = [];
  let saveFailure: string | undefined;
  let pendingSave: ReturnType<typeof deferred<void>> | undefined;
  let pendingRun: ReturnType<typeof deferred<ScratchResult>> | undefined;
  let pendingGet: ReturnType<typeof deferred<void>> | undefined;
  doubles.post.mockImplementation(async (what, data) => {
    if (what === 'format') return { code: data.code };
    if (what === 'prepare') return { code: 'result = paused\n', name: 'paused' };
    if (what === 'seed') return { inputs: 'paused = 1\n', unavailable: {} };
    if (what === 'run') return pendingRun ? pendingRun.promise : { values: [], output: '', result: 'done' };
    if (what !== 'library') throw Error(what);
    if (data.op === 'save') {
      saves.push(structuredClone(data.entry));
      const waiting = pendingSave;
      pendingSave = undefined;
      if (waiting) await waiting.promise;
      if (saveFailure) throw Error(saveFailure);
      const history = entries.get(data.entry.id) ?? [];
      if (data.entry.expectedVersion !== history.length) throw new ScratchpadRefusal('changed elsewhere');
      const entry = { ...structuredClone(data.entry), version: history.length + 1 };
      history.push(entry);
      entries.set(entry.id, history);
      return entry;
    }
    if (data.op === 'list') return [...entries.values()].map((v) => v.at(-1)).reverse();
    if (data.op === 'history') return entries.get(data.id) ?? [];
    if (data.op === 'get') {
      const versions = entries.get(data.id)!;
      const entry = structuredClone(versions[data.version ? data.version - 1 : versions.length - 1]);
      const waiting = pendingGet;
      pendingGet = undefined;
      if (waiting) await waiting.promise;
      return entry;
    }
  });
  const nodes = new Map<string, any>();
  const pane = { hidden: true, innerHTML: '', querySelector(selector: string) {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false, addEventListener() {}, replaceChildren() {} });
    return nodes.get(selector);
  } };
  const debug: any = { paused: null, run: null, selectedFrame: 0, pathOf: () => '/demo.py' };
  const scratch = new Scratchpad(pane as any, { main: { path: '/demo.py' }, theme: 'dark', debug } as any, {} as any, { shownPath: () => '/demo.py', cursorLine: () => 1 } as any);
  return { scratch, saves, entries, debug,
    failSave: (message?: string) => { saveFailure = message; },
    deferSave: () => (pendingSave = deferred<void>()),
    deferRun: () => (pendingRun = deferred<ScratchResult>()),
    deferGet: () => (pendingGet = deferred<void>()),
  };
}

beforeEach(() => {
  doubles.editors.length = 0;
  doubles.post.mockReset();
  vi.stubGlobal('document', { body: { classList: { add() {}, remove() {} }, dataset: {} } });
  vi.stubGlobal('Option', class {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const draft = { code: 'result = edited\n', inputs: 'edited = 42\n', mocks: '{"demo.call": 7}', title: 'My draft' };

describe('scratchpad draft preservation', () => {
  it('recovers all material edits after creating another scratchpad without running Python', async () => {
    const { scratch, saves } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft });
    await scratch.control({ op: 'create', autoRun: false });
    expect(saves.filter((entry) => entry.id === first.id).at(-1).state).toMatchObject(draft);
    expect(await scratch.control({ op: 'load', id: first.id! })).toMatchObject(draft);
    expect(doubles.post.mock.calls.some(([what]) => what === 'run')).toBe(false);
  });

  it.each(['open', 'experiment', 'load', 'toggle'] as const)('preserves edits through %s', async (operation) => {
    const { scratch, saves, debug } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft });
    if (operation === 'open') {
      debug.paused = { step: 1, fileId: 'file', line: 1, stack: [] };
      debug.run = { runId: 'run' };
      debug.locals = { step: 1, frameId: 0, locals: [] };
      await scratch.control({ op: 'open', autoRun: false });
    } else if (operation === 'experiment') await scratch.control({ op: 'experiment', code: 'result = 2' });
    else if (operation === 'load') await scratch.control({ op: 'load', id: first.id! });
    else { scratch.close(); await scratch.toggle(); }
    expect(saves.filter((entry) => entry.id === first.id).at(-1).state).toMatchObject(draft);
    expect(await scratch.control({ op: 'load', id: first.id! })).toMatchObject(draft);
  });

  it('skips preservation versions for unchanged drafts including closed drafts', async () => {
    const { scratch, saves } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    scratch.close();
    await scratch.toggle();
    await scratch.control({ op: 'create', autoRun: false });
    expect(saves.filter((entry) => entry.id === first.id)).toHaveLength(1);
  });

  it.each(['disk unavailable', 'changed elsewhere'])('keeps the editor intact after %s and does not blindly retry', async (message) => {
    const { scratch, failSave, saves } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft });
    failSave(message);
    await expect(scratch.control({ op: 'create', autoRun: false })).rejects.toThrow(message);
    expect(scratch.state()).toMatchObject({ ...draft, id: first.id });
    const attempted = saves.length;
    await expect(scratch.control({ op: 'create', autoRun: false })).rejects.toThrow(message);
    expect(saves).toHaveLength(attempted);
  });

  it('cancels an auto-run timer before awaiting draft preservation', async () => {
    vi.useFakeTimers();
    const { scratch, deferSave } = setup();
    await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft, autoRun: true });
    const pending = deferSave();
    const replacement = scratch.control({ op: 'create', autoRun: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(doubles.post.mock.calls.some(([what]) => what === 'run')).toBe(false);
    pending.resolve();
    await replacement;
  });

  it('rejects late run results while preservation is pending', async () => {
    const { scratch, deferRun, deferSave, saves } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft });
    const run = deferRun();
    const running = scratch.run();
    const pending = deferSave();
    const replacement = scratch.control({ op: 'create', code: 'result = replacement', autoRun: false });
    await Promise.resolve();
    run.resolve({ values: [], output: 'late' });
    await Promise.resolve();
    pending.resolve();
    await Promise.all([replacement, running]);
    expect(scratch.state()).toMatchObject({ code: 'result = replacement', result: null });
    expect(saves.filter((entry) => entry.id === first.id).at(-1).state).toMatchObject({ ...draft, result: null });
  });

  it('preserves edits made while a save is pending and cancels their new auto-run timer', async () => {
    vi.useFakeTimers();
    const { scratch, deferSave, saves } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft, autoRun: true });
    const pending = deferSave();
    const replacement = scratch.control({ op: 'create', autoRun: false });
    await Promise.resolve();
    // These are direct editor changes, as the person can still type during a save.
    doubles.editors[0].setValue('result = newest');
    await vi.advanceTimersByTimeAsync(500);
    expect(doubles.post.mock.calls.some(([what]) => what === 'run')).toBe(false);
    pending.resolve();
    await replacement;
    expect(saves.filter((entry) => entry.id === first.id).at(-1).state.code).toBe('result = newest');
    expect(doubles.post.mock.calls.some(([what]) => what === 'run')).toBe(false);
  });

  it('loads the latest version when the person edits during the load request', async () => {
    const { scratch, deferGet } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    const pending = deferGet();
    const loading = scratch.control({ op: 'load', id: first.id! });
    await Promise.resolve();
    await Promise.resolve();
    doubles.editors[0].setValue('result = newest');
    pending.resolve();
    expect(await loading).toMatchObject({ code: 'result = newest', savedVersion: 2 });
  });
});

describe('scratchpad invocation cancellation', () => {
  it('does nothing for an already cancelled invocation', async () => {
    const { scratch } = setup();
    const abort = new AbortController();
    const onDispatch = vi.fn();
    abort.abort();
    await expect(scratch.control({ op: 'create' }, { signal: abort.signal, onDispatch })).rejects.toThrow(/cancel/i);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(scratch.state().id).toBeNull();
    expect(doubles.post).not.toHaveBeenCalled();
  });

  it('forwards format cancellation, returns promptly, and never replaces or runs after its late answer', async () => {
    const { scratch } = setup();
    await scratch.control({ op: 'create', autoRun: false });
    const before = scratch.state();
    const formatted = deferred<{ code: string }>();
    doubles.post.mockImplementationOnce(() => formatted.promise);
    const abort = new AbortController();
    const running = scratch.control({ op: 'experiment', code: 'result = 3' }, { signal: abort.signal });
    const rejected = expect(running).rejects.toThrow(/cancel/i);
    expect(doubles.post.mock.calls.at(-1)?.[2]).toBe(abort.signal);
    abort.abort();
    await rejected;
    formatted.resolve({ code: 'result = 3' });
    await Promise.resolve();
    expect(scratch.state()).toMatchObject({ id: before.id, code: before.code });
    expect(doubles.post.mock.calls.some(([what]) => what === 'run')).toBe(false);
  });

  it('cancels a seeded open without replacing the draft or moving the paused program', async () => {
    const { scratch, debug } = setup();
    const before = await scratch.control({ op: 'create', autoRun: false });
    const pause = { step: 1, fileId: 'file', line: 1, stack: [] };
    debug.paused = pause;
    debug.run = { runId: 'run' };
    debug.locals = { step: 1, frameId: 0, locals: [] };
    const seeded = deferred<unknown>();
    const transport = doubles.post.getMockImplementation()!;
    doubles.post.mockImplementation((what, ...args) => what === 'seed' ? seeded.promise : transport(what, ...args));
    const abort = new AbortController();
    const opening = scratch.control({ op: 'open', autoRun: false }, { signal: abort.signal });
    const rejected = expect(opening).rejects.toThrow(/cancel/i);
    expect(doubles.post.mock.calls.find(([what]) => what === 'seed')?.[2]).toBe(abort.signal);
    abort.abort();
    await rejected;
    seeded.resolve({ inputs: '', unavailable: {} });
    await Promise.resolve();
    expect(scratch.state().id).toBe(before.id);
    expect(debug.paused).toBe(pause);
  });

  it('invalidates cancelled run results and permits a later experiment', async () => {
    const { scratch, deferRun } = setup();
    await scratch.control({ op: 'create', autoRun: false });
    const pending = deferRun();
    const abort = new AbortController();
    const onDispatch = vi.fn();
    const running = scratch.control({ op: 'run' }, { signal: abort.signal, onDispatch });
    const rejected = expect(running).rejects.toThrow(/cancel/i);
    const runSignal = doubles.post.mock.calls.find(([what]) => what === 'run')?.[2] as AbortSignal;
    expect(onDispatch).toHaveBeenCalledOnce();
    abort.abort();
    await rejected;
    pending.resolve({ values: [], output: 'stale' });
    expect(runSignal.aborted).toBe(true);
    expect(scratch.state().result).toBeNull();
    await scratch.control({ op: 'experiment', code: 'result = 9' });
    expect(scratch.state().code).toBe('result = 9');
  });

  it('keeps an ambiguous saved draft and reconciles explicitly without a duplicate save', async () => {
    const { scratch, deferSave, saves } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft });
    const pending = deferSave();
    const abort = new AbortController();
    const replacing = scratch.control({ op: 'create', autoRun: false }, { signal: abort.signal });
    const rejected = expect(replacing).rejects.toThrow(/cancel|unknown/i);
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    const saveSignal = doubles.post.mock.calls.filter(([what, data]) => what === 'library' && data.op === 'save').at(-1)?.[2];
    expect(saveSignal).toBe(abort.signal);
    abort.abort();
    await rejected;
    expect(scratch.state()).toMatchObject({ ...draft, id: first.id });
    expect(await scratch.control({ op: 'state' })).toMatchObject(draft);
    await expect(scratch.control({ op: 'create' })).rejects.toThrow(/unknown|preserv/i);
    expect(saves).toHaveLength(2);
    await scratch.control({ op: 'save' });
    expect(saves).toHaveLength(3);
    expect(saves[2]).toEqual(saves[1]);
    pending.resolve();
    await Promise.resolve();
    expect(scratch.state().savedVersion).toBe(2);
    await scratch.control({ op: 'create', autoRun: false });
  });

  it('recovers a save that never reached the store by explicitly retrying its original version and snapshot', async () => {
    const { scratch, failSave, saves, entries } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft });
    failSave('connection lost');
    await expect(scratch.control({ op: 'save' })).rejects.toThrow('connection lost');
    const attempts = saves.length;
    await expect(scratch.control({ op: 'create' })).rejects.toThrow(/preserv/i);
    expect(saves).toHaveLength(attempts);
    failSave();
    doubles.editors[0].setValue('result = newest');
    await scratch.control({ op: 'save' });
    expect(saves[2]).toEqual(saves[1]);
    expect(entries.get(first.id!)!.map((entry) => entry.state.code)).toEqual([saves[0].state.code, draft.code, 'result = newest']);
    expect(scratch.state()).toMatchObject({ ...draft, code: 'result = newest', savedVersion: 3 });
    await scratch.control({ op: 'create', autoRun: false });
  });

  it('recovers an initial save when the scratchpad has no stored version yet', async () => {
    const { scratch, failSave, saves } = setup();
    failSave('connection lost');
    await scratch.control({ op: 'create', autoRun: false });
    failSave();
    await scratch.control({ op: 'save' });
    expect(saves[1]).toEqual(saves[0]);
    expect(scratch.state().savedVersion).toBe(1);
    await scratch.control({ op: 'create', autoRun: false });
  });

  it('recognizes the original save winning the CAS race during explicit recovery', async () => {
    const { scratch, deferSave, saves, entries } = setup();
    const first = await scratch.control({ op: 'create', autoRun: false });
    await scratch.control({ op: 'update', ...draft });
    const pending = deferSave();
    const abort = new AbortController();
    const saving = scratch.control({ op: 'save' }, { signal: abort.signal });
    const rejected = expect(saving).rejects.toThrow(/cancel/i);
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    abort.abort();
    await rejected;
    const transport = doubles.post.getMockImplementation()!;
    doubles.post.mockImplementation(async (what, data, ...args) => {
      if (what === 'library' && data.op === 'save') {
        pending.resolve();
        await Promise.resolve();
      }
      return transport(what, data, ...args);
    });
    await scratch.control({ op: 'save' });
    expect(saves[2]).toEqual(saves[1]);
    expect(entries.get(first.id!)).toHaveLength(2);
    expect(scratch.state()).toMatchObject({ ...draft, savedVersion: 2, saveError: null });
  });
});
