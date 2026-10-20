/**
 * The Scratchpad: an experiment beside the live debugger. Open copies the function around the
 * paused line and the pause's values (as Inputs, Python literals the runtime checked rebuild
 * exactly; anything else is listed as unavailable), then runs it in a separate `python -I` the
 * bridge starts (python/pyokka_runtime/scratchpad.py). The paused program never moves. Every
 * scratchpad is named and saved in versions (web/scratchpadStore.ts) and reopens without running.
 */
import { monaco } from '../webview/monaco';
import type { Link, PageHost } from './pageHost';
import type { CodePane } from './codePane';
import type { ValueNode } from '../src/shared/protocol';
import type { ScratchBaseline, ScratchCommand, ScratchEntry, ScratchProvenance, ScratchResult, ScratchSandbox, ScratchState, ScratchSummary } from './scratchpadProtocol';
import { SCRATCH_OPS } from './scratchpadProtocol';
import { checkScratchSignal, completeValue, inputsSource, mocksSource, NEW_CODE, post, ScratchpadRefusal, scratchWait } from './scratchpadClient';
import { renderResult, renderSandbox, SCRATCH_MARKUP } from './scratchpadView';
import { NarrationZone } from './narrationZone';
import './scratchpad.css';

export class Scratchpad {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly inputs: monaco.editor.IStandaloneCodeEditor;
  private readonly mocks: monaco.editor.IStandaloneCodeEditor;
  private readonly shadows: monaco.editor.IEditorDecorationsCollection;
  /** an agent's explanation under a line of the code (op say), as the code pane shows `ctl say` */
  private readonly explainer: NarrationZone;
  private readonly auto: HTMLInputElement;
  private id: string | null = null;
  private title = '';
  private file = '';
  private provenance: ScratchProvenance | null = null;
  private unavailable: Record<string, string> = {};
  private baseline: ScratchBaseline = { code: '', inputs: '', mocks: '' };
  private status: ScratchState['status'] = 'empty';
  private result: ScratchResult | null = null;
  private error: string | null = null;
  private sandbox: ScratchSandbox | null = null;
  private revision = 0;
  private readonly versions = new Map<string, number>();
  private readonly confirmedDrafts = new Map<string, string>();
  private loadedVersion: number | null = null;
  private saveError: string | null = null;
  private uncertainSave?: { id: string; draft: string; expectedVersion: number; entry: Pick<ScratchEntry, 'id' | 'title' | 'reason' | 'state' | 'baseline'> };
  private saves: Promise<void> = Promise.resolve();
  private updating = false;
  private preserving = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active?: AbortController;

  constructor(private readonly pane: HTMLElement, private readonly host: PageHost, private readonly link: Link, private readonly code: CodePane) {
    pane.innerHTML = SCRATCH_MARKUP;
    const theme = host.theme === 'light' ? 'vs' : 'vs-dark';
    const editor = (cls: string, label: string, numbers: boolean) =>
      monaco.editor.create(pane.querySelector<HTMLElement>(`.${cls}`)!, { value: '', language: 'python', theme, ariaLabel: label, automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: 'on', lineNumbers: numbers ? 'on' : 'off', padding: { top: 8 } });
    this.editor = editor('pkw-scratch-editor', 'Python scratchpad', true);
    this.inputs = editor('pkw-scratch-inputs', 'Inputs: Python assignments', false);
    this.mocks = editor('pkw-scratch-mocks', 'Mocks: one Python dict', false);
    this.shadows = this.editor.createDecorationsCollection();
    this.explainer = new NarrationZone(this.editor);
    this.auto = pane.querySelector('.pkw-scratch-auto')!;
    for (const e of [this.editor, this.inputs, this.mocks]) e.onDidChangeModelContent(() => this.schedule());
    this.auto.onchange = () => this.schedule();
    const report = (e: unknown) => this.say(e instanceof Error ? e.message : String(e));
    const on = (cls: string, fn: () => Promise<unknown> | void) => pane.querySelector(`.${cls}`)!.addEventListener('click', () => void Promise.resolve().then(fn).catch(report));
    on('pkw-scratch-close', () => this.close());
    on('pkw-scratch-copy', () => this.open(this.cursorLine()));
    on('pkw-scratch-run', () => this.run());
    on('pkw-scratch-restore', () => this.restore());
    on('pkw-scratch-new', () => this.create({ op: 'create' }));
    on('pkw-scratch-save', () => this.save(pane.querySelector<HTMLInputElement>('.pkw-scratch-title')!.value));
    pane.querySelector<HTMLSelectElement>('.pkw-scratch-list')!.onchange = (e) => {
      const id = (e.target as HTMLSelectElement).value;
      if (id) void this.load(id).catch(report);
    };
    pane.querySelector<HTMLSelectElement>('.pkw-scratch-history')!.onchange = (e) => {
      const version = Number((e.target as HTMLSelectElement).value);
      if (this.id && version) void this.load(this.id, version).catch(report);
    };
    pane.querySelector<HTMLInputElement>('.pkw-scratch-title')!.onchange = (e) => {
      const title = (e.target as HTMLInputElement).value.trim();
      if (title && title.length <= 200 && title !== this.title) {
        this.title = title;
        this.persist('rename');
      }
    };
  }

  /* ---------- the agent's commands ---------- */

  async control(cmd: ScratchCommand, options: { signal?: AbortSignal; onDispatch?: () => void } = {}): Promise<ScratchState> {
    const { signal, onDispatch } = options;
    checkScratchSignal(signal);
    if (!SCRATCH_OPS.includes(cmd.op)) throw new Error(`scratchpad op is one of ${SCRATCH_OPS.join(', ')}`);
    if (cmd.title !== undefined && (typeof cmd.title !== 'string' || !cmd.title.trim() || cmd.title.length > 200)) throw new Error('a scratchpad title has 1 to 200 characters');
    if (cmd.code !== undefined && (typeof cmd.code !== 'string' || cmd.code.length > 100_000)) throw new Error('code is a string of at most 100000 characters');
    switch (cmd.op) {
      case 'state':
        return this.state();
      case 'open':
        await this.open(cmd.line, cmd, signal, onDispatch);
        await this.whenRun(signal, onDispatch);
        break;
      case 'experiment': {
        if (typeof cmd.code !== 'string' || !cmd.code.trim()) throw new Error('experiment needs the complete code');
        const { code } = await this.request<{ code: string }>('format', { code: cmd.code }, signal);
        const fields = { ...cmd, code, autoRun: cmd.autoRun ?? false };
        if (this.host.debug.paused) await this.open(cmd.line, fields, signal, onDispatch);
        else await this.create(fields, signal, onDispatch);
        checkScratchSignal(signal);
        await this.run(signal, onDispatch);
        break;
      }
      case 'create':
        await this.create(cmd, signal, onDispatch);
        await this.whenRun(signal, onDispatch);
        break;
      case 'update':
        this.requireOpen();
        this.fill(cmd);
        this.schedule();
        break;
      case 'run':
        this.requireOpen();
        await this.run(signal, onDispatch);
        break;
      case 'restore':
        this.requireOpen();
        this.restore();
        await this.whenRun(signal, onDispatch);
        break;
      case 'close':
        this.close();
        break;
      case 'save':
        await this.save(cmd.title, signal, onDispatch);
        break;
      case 'list':
        await scratchWait(this.saves, signal);
        return { ...this.state(), scratchpads: await this.library<ScratchSummary[]>('list', {}, signal) };
      case 'history': {
        await scratchWait(this.saves, signal);
        const id = cmd.id ?? this.id;
        if (!id) throw new Error('history needs a scratchpad id (list names them)');
        return { ...this.state(), history: await this.library<ScratchSummary[]>('history', { id }, signal), ...(cmd.version !== undefined ? { entry: await this.library<ScratchEntry>('get', { id, version: cmd.version }, signal) } : {}) };
      }
      case 'load':
        if (!cmd.id) throw new Error('load needs a scratchpad id (list names them)');
        await this.load(cmd.id, cmd.version, signal, onDispatch);
        break;
      case 'say': {
        this.requireOpen();
        if (cmd.text !== undefined && (typeof cmd.text !== 'string' || cmd.text.length > 4000)) throw new Error('say text is a string of at most 4000 characters');
        const lines = this.editor.getModel()?.getLineCount() ?? 1;
        const line = cmd.line ?? this.editor.getPosition()?.lineNumber ?? 1;
        if (!Number.isInteger(line) || line < 1 || line > lines) throw new Error(`line ${line} is not a line of the scratchpad's code (1-${lines})`);
        this.explainer.set(cmd.text ? { text: cmd.text, line } : null);
        break;
      }
    }
    await scratchWait(this.saves, signal);
    checkScratchSignal(signal);
    return this.state();
  }

  state(): ScratchState {
    return {
      id: this.id, title: this.title, open: !this.pane.hidden, file: this.file,
      code: this.editor.getValue(), inputs: this.inputs.getValue(), mocks: this.mocks.getValue(), unavailable: this.unavailable,
      autoRun: this.auto.checked, revision: this.revision, status: this.status, result: this.result, error: this.error, provenance: this.provenance,
      savedVersion: this.id ? (this.versions.get(this.id) ?? 0) : 0, loadedVersion: this.loadedVersion, saveError: this.saveError, sandbox: this.sandbox,
      explainer: this.explainer.current(),
      liveExecutionChanged: false,
    };
  }

  /* ---------- making one ---------- */

  /** The toolbar's Scratchpad: a copy from the pause, else the latest saved one, else a new one. */
  async toggle(): Promise<void> {
    if (!this.pane.hidden) return this.close();
    await this.preserveDraft();
    if (this.host.debug.paused) return this.open(this.cursorLine());
    const saved = await this.library<ScratchSummary[]>('list');
    if (saved[0]) return this.load(saved[0].id);
    return this.create({ op: 'create' });
  }

  /** Copy the function around `line` (default: the paused line) and the pause's values. */
  async open(line?: number, fields: Partial<ScratchCommand> = {}, signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    checkScratchSignal(signal);
    const d = this.host.debug;
    const paused = d.paused;
    const run = d.run;
    if (!paused || !run) throw new Error('scratchpad open needs a live pause: pyokka_page {"action": "breakpoint", "line": N, "on": true}, then {"action": "debug", "op": "start"} (CLI: pyokka web ctl break N on, then pyokka web ctl debug start), then open again. create and experiment need no pause');
    for (let i = 0; i < 40 && (d.locals?.step !== paused.step || d.locals.frameId !== d.selectedFrame); i++) await this.delay(signal);
    if (d.locals?.step !== paused.step || d.locals.frameId !== d.selectedFrame) throw new Error("the pause's values have not arrived; try again");
    const frameIndex = d.selectedFrame;
    const frame = paused.stack[frameIndex];
    const file = d.pathOf(frame?.fileId || paused.fileId);
    if (!file) throw new Error('the paused frame is in a file the debugger did not instrument');
    const pausedLine = frame?.line ?? paused.line ?? 1;
    const values: Record<string, ValueNode | null> = {};
    const budget = { expansions: 200 };
    for (const v of d.locals.locals) values[v.name] = v.valueBag ? await completeValue(this.link, run.runId, v.valueBag.data, 0, budget, signal) : null;
    const [prepared, seeded] = await Promise.all([
      this.request<{ code: string; name?: string }>('prepare', { file, line: line ?? pausedLine }, signal),
      this.request<{ inputs: string; unavailable: Record<string, string> }>('seed', { values }, signal),
    ]);
    if (d.paused !== paused || d.selectedFrame !== frameIndex) throw new Error('the pause changed while its values were copied; open again');
    await this.begin({
      title: fields.title ?? (prepared.name ? `${prepared.name} at line ${pausedLine}` : `${file.split(/[\\/]/).pop()} line ${pausedLine}`),
      file,
      code: fields.code ?? prepared.code,
      inputs: fields.inputs !== undefined ? inputsSource(fields.inputs) : seeded.inputs,
      mocks: fields.mocks !== undefined ? mocksSource(fields.mocks) : '',
      unavailable: seeded.unavailable,
      provenance: { file, line: pausedLine, function: frame?.name ?? null, runId: run.runId, step: paused.step, frame: frameIndex },
      autoRun: fields.autoRun,
    }, signal, onDispatch);
  }

  /** A scratchpad without a pause, beside the main file (its imports and functions resolve). */
  private async create(cmd: Partial<ScratchCommand>, signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    checkScratchSignal(signal);
    const file = this.host.main?.path;
    if (!file) throw new Error('a scratchpad needs a source file; the page has none yet');
    await this.begin({ title: cmd.title ?? 'Untitled experiment', file, code: cmd.code ?? NEW_CODE, inputs: cmd.inputs !== undefined ? inputsSource(cmd.inputs) : '', mocks: cmd.mocks !== undefined ? mocksSource(cmd.mocks) : '', unavailable: {}, provenance: null, autoRun: cmd.autoRun }, signal, onDispatch);
  }

  private async begin(s: { title: string; file: string; code: string; inputs: string; mocks: string; unavailable: Record<string, string>; provenance: ScratchProvenance | null; autoRun?: boolean }, signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    await this.preserveDraft(signal, onDispatch);
    checkScratchSignal(signal);
    this.updating = true;
    try {
      this.id = crypto.randomUUID();
      this.title = s.title.trim();
      this.file = s.file;
      this.provenance = s.provenance;
      this.unavailable = s.unavailable;
      this.baseline = { code: s.code, inputs: s.inputs, mocks: s.mocks };
      this.explainer.set(null);
      this.editor.setValue(s.code);
      this.inputs.setValue(s.inputs);
      this.mocks.setValue(s.mocks);
      if (s.autoRun !== undefined) this.auto.checked = s.autoRun;
      this.result = null;
      this.error = null;
      this.status = 'dirty';
      this.loadedVersion = null;
      this.saveError = null;
    } finally {
      this.updating = false;
    }
    this.show();
    this.describe(this.provenance ? `${this.file.split(/[\\/]/).pop()} · copied at line ${this.provenance.line} (${this.provenance.function}), step ${this.provenance.step}` : `${this.file.split(/[\\/]/).pop()} · no pause`);
    this.persist('create', signal, onDispatch);
    await scratchWait(this.saves, signal);
    checkScratchSignal(signal);
    this.schedule(true);
  }

  /* ---------- editing and running ---------- */

  private fill(cmd: Partial<ScratchCommand>): void {
    this.updating = true;
    try {
      if (cmd.title !== undefined) this.title = cmd.title.trim();
      if (cmd.autoRun !== undefined) this.auto.checked = cmd.autoRun;
      if (cmd.code !== undefined) {
        this.explainer.set(null);
        this.editor.setValue(cmd.code);
      }
      if (cmd.inputs !== undefined) this.inputs.setValue(inputsSource(cmd.inputs));
      if (cmd.mocks !== undefined) this.mocks.setValue(mocksSource(cmd.mocks));
    } finally {
      this.updating = false;
    }
  }

  private restore(): void {
    this.fill(this.baseline);
    this.schedule();
  }

  /** An edit: the last result no longer describes the code; with Auto run on, run it shortly. */
  private schedule(force = false): void {
    if (this.updating && !force) return;
    ++this.revision;
    this.active?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.result = null;
    this.error = null;
    this.loadedVersion = null;
    this.shadows.clear();
    this.renderResult();
    if (this.pane.hidden || !this.auto.checked || this.preserving) {
      this.status = 'dirty';
      return this.say(this.auto.checked ? '' : 'Not run since the last edit');
    }
    this.status = 'scheduled';
    this.timer = setTimeout(() => void this.run(), 400);
  }

  /** For the agent: the run an edit scheduled, finished. */
  private async delay(signal?: AbortSignal): Promise<void> {
    checkScratchSignal(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await scratchWait(new Promise<void>((resolve) => { timer = setTimeout(resolve, 25); }), signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async whenRun(signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    checkScratchSignal(signal);
    if (this.status === 'scheduled') await this.run(signal, onDispatch);
    for (let i = 0; i < 400 && this.status === 'running'; i++) await this.delay(signal);
  }

  async run(signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    checkScratchSignal(signal);
    if (!this.file) throw new Error('nothing to run: open a scratchpad first');
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const revision = ++this.revision;
    this.active?.abort();
    const active = (this.active = new AbortController());
    const cancel = () => {
      active.abort();
      if (revision === this.revision) {
        ++this.revision;
        this.status = 'dirty';
        this.error = 'Scratchpad cancelled; Python may still be running on the server';
        this.say(this.error);
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    this.status = 'running';
    this.say('Running in a separate python -I…');
    try {
      onDispatch?.();
      const r = await this.request<ScratchResult>('run', { file: this.file, code: this.editor.getValue(), inputs: this.inputs.getValue(), mocks: this.mocks.getValue(), unavailable: this.unavailable }, active.signal);
      checkScratchSignal(signal);
      if (revision !== this.revision) return;
      this.result = r;
      this.sandbox = r.sandbox ?? this.sandbox;
      this.error = r.error ? `${r.error.type}: ${r.error.message}${r.error.line ? ` (line ${r.error.line})` : ''}` : null;
      this.status = r.error ? 'error' : 'completed';
    } catch (e) {
      checkScratchSignal(signal);
      if (revision !== this.revision || active.signal.aborted) return;
      this.result = null;
      this.error = e instanceof Error ? e.message : String(e);
      this.status = 'error';
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    this.say(this.error ?? '');
    this.renderResult();
    this.persist('run', signal, onDispatch);
    await scratchWait(this.saves, signal);
  }

  /* ---------- versions ---------- */

  /** Execution metadata does not make an otherwise unchanged draft need another version. */
  private draftKey(state = this.state(), baseline = this.baseline): string {
    return JSON.stringify({ title: state.title, file: state.file, code: state.code, inputs: state.inputs, mocks: state.mocks, autoRun: state.autoRun, provenance: state.provenance, unavailable: state.unavailable, baseline });
  }

  /** Quiesce old work before saving, so a timer or late result cannot change the saved draft. */
  private async preserveDraft(signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    checkScratchSignal(signal);
    ++this.preserving;
    try {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.active?.abort();
      ++this.revision;
      if (this.status === 'running' || this.status === 'scheduled') this.status = 'dirty';
      await scratchWait(this.saves, signal);
      // A failed request may already have reached the store. Replacement must not blindly retry it.
      if (this.saveError) throw new Error(`draft not preserved: ${this.saveError}; the current draft is still available`);
      while (this.id && this.confirmedDrafts.get(this.id) !== this.draftKey()) {
        checkScratchSignal(signal);
        this.persist('draft', signal, onDispatch);
        await scratchWait(this.saves, signal);
        if (this.saveError) throw new Error(`draft not preserved: ${this.saveError}; the current draft is still available`);
      }
    } finally {
      --this.preserving;
    }
  }

  private async request<T>(what: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    checkScratchSignal(signal);
    return scratchWait(post<T>(what, data, signal), signal);
  }

  private async library<T>(op: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    return this.request<T>('library', { ...data, op }, signal);
  }

  private persist(reason: string, signal?: AbortSignal, onDispatch?: () => void): void {
    if (!this.id) return;
    const id = this.id;
    const entry = { id, title: this.title, reason, state: JSON.parse(JSON.stringify(this.state())) as ScratchState, baseline: { ...this.baseline } };
    const revision = this.revision;
    const draft = this.draftKey();
    this.saves = this.saves.then(async () => {
      let dispatched = false;
      const expectedVersion = this.versions.get(id) ?? 0;
      try {
        checkScratchSignal(signal);
        if (this.uncertainSave) throw new Error('save outcome unknown; use save to reconcile the stored version before saving again');
        dispatched = true;
        onDispatch?.();
        const saved = await this.library<ScratchEntry>('save', { entry: { ...entry, expectedVersion } }, signal);
        this.versions.set(id, saved.version);
        this.confirmedDrafts.set(id, draft);
        if (this.id === id) {
          this.saveError = null;
          if (revision === this.revision) this.loadedVersion = saved.version;
        }
      } catch (e) {
        if (dispatched && !(e instanceof ScratchpadRefusal)) this.uncertainSave = { id, draft, expectedVersion, entry };
        if (this.id === id) this.saveError = e instanceof Error ? e.message : String(e);
      }
      if (this.id === id && !signal?.aborted) await this.refreshLibrary(signal).catch(() => undefined);
    });
  }

  private async save(title?: string, signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    checkScratchSignal(signal);
    if (!this.id) throw new Error('open or create a scratchpad before saving');
    await scratchWait(this.saves, signal);
    if (this.uncertainSave) {
      const uncertain = this.uncertainSave;
      const history = await this.library<ScratchSummary[]>('history', { id: uncertain.id }, signal);
      let latest = history.length ? await this.library<ScratchEntry>('get', { id: uncertain.id }, signal) : undefined;
      if ((latest?.version ?? 0) === uncertain.expectedVersion) {
        // This explicit retry uses the identical snapshot and CAS version. If the original
        // request races it, only one can publish the next version.
        try {
          checkScratchSignal(signal);
          onDispatch?.();
          latest = await this.library<ScratchEntry>('save', { entry: { ...uncertain.entry, expectedVersion: uncertain.expectedVersion } }, signal);
        } catch (error) {
          if (!(error instanceof ScratchpadRefusal)) throw error;
          // A racing original may have won. Confirm its content instead of appending again.
          latest = await this.library<ScratchEntry>('get', { id: uncertain.id }, signal);
          if (latest.version <= uncertain.expectedVersion) throw error;
        }
      }
      if (!latest || latest.version <= uncertain.expectedVersion || this.draftKey(latest.state, latest.baseline) !== uncertain.draft) throw new Error('save outcome unknown or changed in another page; inspect history before retrying; the current draft is still available');
      this.versions.set(uncertain.id, latest.version);
      this.confirmedDrafts.set(uncertain.id, uncertain.draft);
      this.uncertainSave = undefined;
      this.saveError = null;
      if (title === undefined && this.draftKey() === uncertain.draft) return;
    }
    if (title !== undefined && title.trim()) this.title = title.trim();
    this.persist('save', signal, onDispatch);
    await scratchWait(this.saves, signal);
    if (this.saveError) throw new Error(`not saved: ${this.saveError}`);
  }

  /** Reopen a saved version as it was, results included, without running it. */
  private async load(id: string, version?: number, signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    await this.preserveDraft(signal, onDispatch);
    let latest: ScratchEntry;
    let entry: ScratchEntry;
    do {
      latest = await this.library<ScratchEntry>('get', { id }, signal);
      entry = version === undefined ? latest : await this.library<ScratchEntry>('get', { id, version }, signal);
      await this.preserveDraft(signal, onDispatch);
      // Saving edits during the fetch can advance the version being reopened.
    } while (id === this.id && latest.version < (this.versions.get(id) ?? 0));
    checkScratchSignal(signal);
    if (this.timer) clearTimeout(this.timer);
    ++this.revision;
    this.active?.abort();
    this.updating = true;
    try {
      const s = entry.state;
      this.id = id;
      this.title = entry.title;
      this.versions.set(id, latest.version);
      this.loadedVersion = entry.version;
      this.saveError = null;
      this.file = s.file;
      this.provenance = s.provenance;
      this.unavailable = s.unavailable ?? {};
      this.baseline = entry.baseline;
      this.sandbox = s.sandbox;
      this.explainer.set(null);
      this.editor.setValue(s.code);
      this.inputs.setValue(s.inputs);
      this.mocks.setValue(s.mocks);
      this.auto.checked = s.autoRun;
      this.result = s.result;
      this.error = s.error;
      this.status = s.status === 'running' || s.status === 'scheduled' ? 'dirty' : s.status;
      this.confirmedDrafts.set(id, this.draftKey());
    } finally {
      this.updating = false;
    }
    this.show();
    this.describe(`${this.file.split(/[\\/]/).pop()} · saved v${entry.version} · not run on reopen`);
    this.say(this.error ?? '');
    this.renderResult();
    await this.refreshLibrary(signal);
  }

  private async refreshLibrary(signal?: AbortSignal): Promise<void> {
    const list = this.pane.querySelector<HTMLSelectElement>('.pkw-scratch-list')!;
    const entries = await this.library<ScratchSummary[]>('list', {}, signal);
    checkScratchSignal(signal);
    list.replaceChildren(new Option('Saved scratchpads', ''), ...entries.map((e) => new Option(`${e.title} · v${e.version}`, e.id)));
    list.value = this.id && entries.some((e) => e.id === this.id) ? this.id : '';
    const history = this.pane.querySelector<HTMLSelectElement>('.pkw-scratch-history')!;
    const versions = this.id ? await this.library<ScratchSummary[]>('history', { id: this.id }, signal).catch(() => []) : [];
    checkScratchSignal(signal);
    history.replaceChildren(new Option('Versions', ''), ...versions.map((v) => new Option(`v${v.version} · ${v.reason} · ${new Date(v.updatedAt).toLocaleTimeString()}`, String(v.version))));
    history.value = this.loadedVersion === null ? '' : String(this.loadedVersion);
    this.pane.querySelector<HTMLInputElement>('.pkw-scratch-title')!.value = this.title;
  }

  /* ---------- the pane ---------- */

  private requireOpen(): void {
    if (this.pane.hidden || !this.file) throw new Error('no scratchpad is open: open (at a pause), create or load one first');
  }

  private show(): void {
    this.pane.hidden = false;
    document.body.classList.add('pkw-scratch-open');
    if (document.body.dataset.layout === 'code') document.body.dataset.layout = 'split';
    this.editor.layout();
    void this.refreshLibrary().catch(() => undefined);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.active?.abort();
    ++this.revision;
    this.pane.hidden = true;
    this.explainer.set(null);
    this.status = this.status === 'running' || this.status === 'scheduled' ? 'dirty' : this.status;
    document.body.classList.remove('pkw-scratch-open');
  }

  private cursorLine(): number | undefined {
    const pausedFile = this.host.debug.paused ? this.host.debug.pathOf(this.host.debug.paused.stack[this.host.debug.selectedFrame]?.fileId || this.host.debug.paused.fileId) : undefined;
    return pausedFile && this.code.shownPath() === pausedFile ? this.code.cursorLine() : undefined;
  }

  private describe(text: string): void {
    this.pane.querySelector('.pkw-scratch-file')!.textContent = text;
    this.renderSandbox();
  }

  private say(text: string): void {
    this.pane.querySelector('.pkw-scratch-state')!.textContent = text;
  }

  private renderSandbox(): void {
    renderSandbox(this.pane, this.sandbox, this.unavailable);
  }

  private renderResult(): void {
    renderSandbox(this.pane, this.sandbox, this.unavailable);
    renderResult(this.pane, this.result, this.editor, this.shadows);
  }
}
