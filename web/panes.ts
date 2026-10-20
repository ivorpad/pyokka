/**
 * The panel's views beyond the Output and the Time Machine, page side: Variable History, the
 * Details pane's "why" tree, the Execution Diagram, the HTTP table, the TOUR section, Narrate's
 * glosses, Compare, and the Time Machine's watches. Each answers the panel's message with the
 * extension's own pure builders (variableHistory, provenance, executionGraph, httpTable,
 * tourPanel) over the run the page keeps; the tour and Narrate come from the bridge, which owns
 * the machine (the Python tour command, the model CLI). Mirrors src/views/*Pane.ts and
 * src/timeMachine/watches.ts without vscode.
 */
import { indexBindings, matchesName, variableHistory } from '../src/session/variableHistory';
import { provenance, stepOfEntry } from '../src/session/provenance';
import { buildExecutionGraph, graphStack } from '../src/session/executionGraph';
import type { ExecutionGraph, GraphNode } from '../src/session/executionGraphTypes';
import { buildPhases } from '../src/session/executionGraphPhases';
import { nodeHits } from '../src/session/executionGraphHits';
import { buildHttpTable } from '../src/session/httpTable';
import { buildTourPanel, resumeFor, resumeStop, type TourResume } from '../src/session/tourPanel';
import { pickLocal } from '../src/features/hoverLocals';
import { renderValueNode } from '../src/views/valueText';
import type { LogEvent, Provenance, ProvenanceNode, StatementBinding, ValueBag, VariableHistory, WatchEvent, WatchRequest } from '../src/shared/protocol';
import type { DebuggerState, ExecutionGraphPanel, HostToWebview, TourPanel } from '../src/shared/webviewProtocol';
import type { WalkthroughInputs } from '../src/session/walkthroughShared';
import type { BridgeFile, BridgeNarration, BridgeTour, PageToBridge, RequestBody } from './bridgeProtocol';
import type { RunData } from './runState';
import type { RunnerMessage } from '../src/shared/protocol';

/** Files whose bindings one query fetches at most (the extension's BINDINGS_FILE_CAP). */
export const BINDINGS_FILE_CAP = 40;
/** the Execution Diagram's call stack reaches the panel at most this often while the Time Machine moves */
const STACK_THROTTLE_MS = 50;
/** steps after the Time Machine's position whose watch values one run records */
export const WATCH_PREFETCH = 10;
const TOUR_RESUME_KEY = 'pyokka.tour.resume';

/** What the views need from the page host (pageHost.ts). */
export interface PanesHost {
  readonly run: RunData | null;
  readonly main: BridgeFile | null;
  readonly nav: { active: boolean; step: number };
  /** a run is in flight (or about to start) */
  busy(): boolean;
  recordLocals(): boolean;
  post(m: HostToWebview): void;
  send(m: PageToBridge): void;
  request(body: RequestBody): Promise<RunnerMessage>;
  displayPath(fileId: number): string;
  /** the lines of a file of the run when the page has them */
  sourceLines(fileId: number): string[] | undefined;
  /** the lines of a file of the run, asking the bridge for them the first time */
  fetchSource(fileId: number): Promise<string[] | undefined>;
  mainFileId(): number | undefined;
  inputs(): WalkthroughInputs | undefined;
  gotoStep(step: number): void;
  /** re-run the file with the watches, recording them around the Time Machine's step */
  rerunForWatches(): void;
  pushDebugger(): void;
  pushWalkthrough(): void;
  updateSettings(patch: { recordLocals?: boolean }): void;
  /** `name` at the live debugger's pauses while it runs, else undefined */
  pauseHistory(name: string): VariableHistory | undefined;
}

interface WatchValue {
  valueBag?: ValueBag;
  text?: string;
  note?: string;
  error?: string;
  needsRun?: boolean;
}

interface Watch {
  id: string;
  exp: string;
  values: Map<number, WatchValue>;
}

export class Panes {
  private variableName: string | undefined;
  private whyTarget: { step: number; name: string } | undefined;
  private graphCache: { runId: string; key: string; graph: ExecutionGraph } | undefined;
  private graphExpanded: string[] = [];
  private graphSentRun: string | undefined;
  private stackTimer: ReturnType<typeof setTimeout> | undefined;
  private httpTimer: ReturnType<typeof setTimeout> | undefined;
  private tourWanted = false;
  tour: BridgeTour | null = null;
  narration: BridgeNarration | null = null;
  canNarrate = false;
  readonly watches: Watch[] = [];
  private watchCounter = 0;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private requestedStep: number | undefined;
  private lastContent: string | undefined;

  constructor(private readonly host: PanesHost) {}

  /* ---------- run boundaries ---------- */

  /** A new run replaced the one on screen: what was computed belongs to the old one. */
  runAdopted(run: RunData): void {
    this.graphCache = undefined;
    this.graphExpanded = [];
    this.graphSentRun = undefined;
    this.host.post({ type: 'executionGraph', graph: null });
    this.host.post({ type: 'tour', tour: null });
    this.tour = null;
    this.narration = null;
    if (this.lastContent !== undefined && this.lastContent !== run.content) for (const w of this.watches) w.values.clear();
    this.lastContent = run.content;
    this.pushHttp();
  }

  /** The run finished: refresh every view that follows the runs. */
  runFinished(): void {
    void this.pushVariable();
    void this.pushWhy();
    this.pushHttp();
    if (this.tourWanted) this.host.send({ type: 'tour', action: 'compute' });
    // values the run did not record (out of its window, or an error) are final for this run
    this.host.pushDebugger();
  }

  /** The panel (re)connected: resend what it shows. */
  resync(): void {
    void this.pushVariable();
    void this.pushWhy();
    this.pushHttp();
    this.pushTour();
    if (this.graphSentRun && this.graphSentRun === this.host.run?.runId) this.pushGraph();
  }

  /* ---------- Variable History ---------- */

  /** A new live pause: the Variable view follows it when it shows the pauses (`always`: the debug session ended, back to the recording). */
  refreshVariable(always = false): void {
    if (this.variableName && (always || this.host.pauseHistory(this.variableName))) void this.pushVariable();
  }

  queryVariable(name: string, strict = false, signal?: AbortSignal): Promise<void> {
    this.variableName = name.trim() || undefined;
    return this.pushVariable(strict, signal);
  }

  private async pushVariable(strict = false, signal?: AbortSignal): Promise<void> {
    const name = this.variableName;
    if (!name) {
      this.host.post({ type: 'variable', view: { name: '', history: null } });
      return;
    }
    // a live debug session: the values its pauses saw, as the code history beside declarations shows them
    const paused = this.host.pauseHistory(name);
    if (paused) return this.host.post({ type: 'variable', view: { name, history: paused } });
    const run = this.host.run;
    if (!run?.trace) {
      const error = this.host.busy() ? 'A run is in flight; the history follows it.' : 'No run yet: run the file first (save, or Re-execute).';
      this.host.post({ type: 'variable', view: { name, history: null, error } });
      return;
    }
    this.host.post({ type: 'variable', view: { name, history: null } });
    try {
      const history = await this.variableHistory(name);
      if (signal?.aborted) throw new Error('command cancelled');
      if (this.variableName !== name) return;
      if (!history) return this.host.post({ type: 'variable', view: { name, history: null, error: 'No execution trace yet: run the file first.' } });
      this.host.post({ type: 'variable', view: { name, history: { ...history, changes: history.changes.map((c) => ({ ...c, file: this.host.displayPath(c.fileId) })) } } });
    } catch (err) {
      if (!signal?.aborted && this.variableName === name) this.host.post({ type: 'variable', view: { name, history: null, error: err instanceof Error ? err.message : String(err) } });
      if (strict) throw err;
    }
  }

  /** Every recorded change of `name` in the run on screen (the extension's sessionVariableHistory). */
  async variableHistory(name: string, limit?: number): Promise<VariableHistory | undefined> {
    const run = this.host.run;
    const trace = run?.trace;
    if (!run || !trace) return undefined;
    const bindings = await this.bindingsForQuery(run, name);
    if (!bindings || this.host.run !== run) return undefined;
    return variableHistory({ trace, files: run.files, entriesByRid: run.logsByRid, locals: run.locals, bindings, mainFileId: this.host.mainFileId() }, name, limit ? { limit } : {});
  }

  /** What each statement of a file assigns and reads, asked of the runtime once per run and file. */
  private bindingsFor(run: RunData, fileId: number): Promise<ReadonlyMap<number, StatementBinding> | undefined> {
    let pending = run.bindings.get(fileId);
    if (!pending) {
      pending = (async () => {
        const file = run.files.get(fileId);
        const lines = await this.host.fetchSource(fileId);
        if (!file || !lines) return undefined;
        const reply = await this.host.request({ type: 'bindings', source: lines.join('\n') });
        return reply.type === 'bindings' ? indexBindings(file, reply.statements) : undefined;
      })().catch(() => undefined);
      run.bindings.set(fileId, pending);
    }
    return pending;
  }

  private async bindingsForQuery(run: RunData, name: string, extra?: number): Promise<Map<number, ReadonlyMap<number, StatementBinding>> | undefined> {
    const trace = run.trace;
    if (!trace) return undefined;
    const wanted = new Set<number>();
    const main = this.host.mainFileId();
    if (main !== undefined) wanted.add(main);
    for (const f of run.files.all()) if (f.instrumentedSource !== undefined) wanted.add(f.fileId);
    if (extra !== undefined && extra >= 0) wanted.add(extra);
    for (const entry of run.locals) {
      if (!entry.changes.some((c) => matchesName(c.name, name))) continue;
      const loc = trace.location(entry.step);
      if (loc) wanted.add(loc.fileId);
    }
    for (const [rid, entries] of run.logsByRid) {
      if (!entries.some((e) => matchesName(e.context, name))) continue;
      const loc = run.files.locate(rid);
      if (loc) wanted.add(loc.fileId);
    }
    const out = new Map<number, ReadonlyMap<number, StatementBinding>>();
    await Promise.all(
      [...wanted].slice(0, BINDINGS_FILE_CAP).map(async (fileId) => {
        const table = await this.bindingsFor(run, fileId);
        if (table) out.set(fileId, table);
      }),
    );
    return this.host.run === run ? out : undefined;
  }

  /* ---------- why ---------- */

  queryWhy(step: number, name: string, logId?: string, strict = false, signal?: AbortSignal): Promise<void> {
    const run = this.host.run;
    const entry = logId ? run?.logsById.get(logId) : undefined;
    this.whyTarget = { step: entry && run?.trace ? stepOfEntry(run.trace, entry) : step, name: name.trim() };
    return this.pushWhy(strict, signal);
  }

  closeWhy(): void {
    this.whyTarget = undefined;
  }

  private async pushWhy(strict = false, signal?: AbortSignal): Promise<void> {
    const target = this.whyTarget;
    if (!target) return;
    const { step, name } = target;
    const fail = (error: string): void => this.host.post({ type: 'why', view: { step, name, tree: null, error } });
    const trace = this.host.run?.trace;
    if (!trace) return fail(this.host.busy() ? 'A run is in flight; the tree follows it.' : 'No run yet: run the file first (save, or Re-execute).');
    if (!trace.valid(step)) return fail(`Step ${step} is not in this run (it has ${trace.count} steps); ask again from a value of the last run.`);
    this.host.post({ type: 'why', view: { step, name, tree: null } });
    try {
      const tree = await this.provenance(step, name);
      if (signal?.aborted) throw new Error('command cancelled');
      if (this.whyTarget !== target) return;
      if (!tree) return fail(this.host.busy() ? 'A run is in flight; the tree follows it.' : 'No execution trace yet: run the file first.');
      this.host.post({ type: 'why', view: { step, name, tree: withDisplayPathsTree(tree, (fileId) => this.host.displayPath(fileId)) } });
    } catch (err) {
      if (!signal?.aborted && this.whyTarget === target) fail(err instanceof Error ? err.message : String(err));
      if (strict) throw err;
    }
  }

  /** Why `name` had its value after `step` (an empty name explains the statement). */
  async provenance(step: number, name: string) {
    const run = this.host.run;
    const trace = run?.trace;
    if (!run || !trace) return undefined;
    const bindings = await this.bindingsForQuery(run, name, trace.location(step)?.fileId);
    const inputs = this.host.inputs();
    if (!bindings || !inputs || this.host.run !== run) return undefined;
    return provenance({ ...inputs, entriesByRid: run.logsByRid, bindings, mainFileId: this.host.mainFileId() }, { step, name });
  }

  /* ---------- the Execution Diagram ---------- */

  private graph(): ExecutionGraph | undefined {
    const run = this.host.run;
    const inputs = this.host.inputs();
    if (!run || !inputs) return undefined;
    const key = JSON.stringify([...this.graphExpanded].sort());
    if (this.graphCache && this.graphCache.runId === run.runId && this.graphCache.key === key) return this.graphCache.graph;
    const graph = buildExecutionGraph(inputs, this.graphExpanded.length ? { expand: this.graphExpanded } : {});
    this.graphCache = { runId: run.runId, key, graph };
    return graph;
  }

  pushGraph(): void {
    const run = this.host.run;
    const g = !run || this.host.busy() ? undefined : this.graph();
    if (!run || !g) {
      this.graphSentRun = undefined;
      this.host.post({ type: 'executionGraph', graph: null });
      return;
    }
    const phases = buildPhases(g, (fileId) => this.host.sourceLines(fileId));
    const nodes = g.nodes.map((n): GraphNode => (n.fileId !== undefined ? { ...n, file: this.host.displayPath(n.fileId) } : n));
    const panel: ExecutionGraphPanel = { ...g, nodes, phases, runId: run.runId, expanded: [...this.graphExpanded], stack: this.graphStack(), currentStep: this.host.nav.active ? this.host.nav.step : null };
    this.graphSentRun = run.runId;
    this.host.post({ type: 'executionGraph', graph: panel });
  }

  private graphStack(): string[] {
    const trace = this.host.run?.trace;
    if (!this.host.nav.active || !trace) return [];
    const g = this.graph();
    if (!g) return [];
    const step = this.host.nav.step;
    const loc = trace.location(step);
    return graphStack(g, trace.callStack(step), loc ? { fileId: loc.fileId, line: loc.range[0] } : undefined);
  }

  /** The Time Machine moved: the diagram's stack follows, at most every 50 ms. */
  navChanged(): void {
    this.scheduleWatches();
    if (!this.graphSentRun || this.stackTimer) return;
    this.stackTimer = setTimeout(() => {
      this.stackTimer = undefined;
      const run = this.host.run;
      if (!run || this.graphSentRun !== run.runId) return;
      this.host.post({ type: 'executionGraph.stack', runId: run.runId, step: this.host.nav.active ? this.host.nav.step : null, stack: this.graphStack() });
    }, STACK_THROTTLE_MS);
  }

  expandGraph(nodeId: string, collapse?: boolean): void {
    const node = this.graph()?.nodes.find((n) => n.id === nodeId);
    const pkg = node && node.kind !== 'decision' && node.kind !== 'statement' ? node.package : undefined;
    if (!pkg) return;
    const fold = collapse ?? this.graphExpanded.includes(pkg);
    this.graphExpanded = fold ? this.graphExpanded.filter((p) => p !== pkg) : [...new Set([...this.graphExpanded, pkg])];
    this.pushGraph();
  }

  graphHits(nodeId: string): void {
    const run = this.host.run;
    const trace = run?.trace;
    const g = this.graph();
    const node = g?.nodes.find((n) => n.id === nodeId);
    if (!run || !trace || !g || !node || this.host.busy()) return;
    const byStep = new Map<number, string>();
    if (node.kind === 'statement' || node.kind === 'decision') {
      for (const e of run.logs) {
        if (e.fileId !== node.fileId || byStep.has(e.step)) continue;
        const loc = run.files.locate(e.rid);
        if (loc && loc.range[0] === node.line) byStep.set(e.step, entryText(e));
      }
    }
    const hits = nodeHits(g, trace, nodeId, (step) => byStep.get(step));
    if (hits) this.host.post({ type: 'executionGraph.hits', runId: run.runId, nodeId, ...hits });
  }

  /* ---------- HTTP ---------- */

  /** A row arrived: push once at the end of a 100 ms window (an SDK's retries come in bursts). */
  scheduleHttp(): void {
    if (this.httpTimer) return;
    this.httpTimer = setTimeout(() => this.pushHttp(), 100);
  }

  pushHttp(): void {
    if (this.httpTimer) clearTimeout(this.httpTimer);
    this.httpTimer = undefined;
    const run = this.host.run;
    if (!run) return this.host.post({ type: 'http', panel: null });
    const panel = buildHttpTable({
      runId: run.runId,
      running: run.running,
      events: run.http,
      finished: run.finished?.http ?? null,
      locate: (rid) => {
        const loc = run.files.locate(rid);
        return loc && { fileId: loc.fileId, file: this.host.displayPath(loc.fileId), line: loc.range[0], col: loc.range[1] };
      },
    });
    this.host.post({ type: 'http', panel });
  }

  /* ---------- Narrate ---------- */

  /** The glosses of the run on screen, once narrated. */
  glosses(): Record<string, string> | undefined {
    const n = this.narration;
    return n && n.runId === this.host.run?.runId ? n.glosses : undefined;
  }

  narrating(): boolean {
    const n = this.narration;
    return !!n && n.runId === this.host.run?.runId && n.narrating;
  }

  narrationError(): string | undefined {
    const n = this.narration;
    return n && n.runId === this.host.run?.runId ? n.error : undefined;
  }

  narrate(): void {
    if (!this.host.inputs()) return;
    if (this.glosses() || this.narrating()) return;
    this.narration = { runId: this.host.run!.runId, narrating: true };
    this.host.pushWalkthrough();
    this.host.send({ type: 'narrate' });
  }

  onNarration(n: BridgeNarration): void {
    if (n.runId !== this.host.run?.runId) return;
    this.narration = n;
    this.host.pushWalkthrough();
  }

  /* ---------- the tour ---------- */

  setTourOpen(open: boolean): void {
    this.tourWanted = open;
    if (open && this.host.inputs()) this.host.send({ type: 'tour', action: 'compute' });
  }

  narrateTour(): void {
    if (!this.host.inputs()) return;
    this.host.send({ type: 'tour', action: 'narrate' });
  }

  tourGoto(step: number, stopId: string): void {
    const t = this.tour;
    const runId = this.host.run?.runId;
    const r = t?.doc && runId ? resumeFor(t.doc, runId, stopId) : undefined;
    if (r && this.host.main) {
      const all = readResume();
      all[this.host.main.path] = r;
      writeResume(all);
    }
    this.host.gotoStep(step);
    this.pushTour();
  }

  recordLocalsAndRun(): void {
    this.host.updateSettings({ recordLocals: true });
  }

  onTour(t: BridgeTour): void {
    if (t.runId !== this.host.run?.runId) return;
    this.tour = t;
    this.pushTour();
  }

  tourPanel(): TourPanel | null {
    const t = this.tour;
    const run = this.host.run;
    if (!t || !run || t.runId !== run.runId) return null;
    const noLocals = !this.host.recordLocals() && run.locals.length === 0;
    const base = { runId: t.runId, steps: 0, goal: null, intro: null, chapters: [], stops: [], narrated: false, narrating: t.narrating, canNarrate: this.canNarrate, resumeStopId: null, noLocals };
    if (t.status === 'computing' && !t.doc) return { ...base, status: 'computing' };
    if (!t.doc) return { ...base, status: 'error', error: t.error ?? 'no tour' };
    const files = run.files.all();
    const fileIdOf = (display: string): number => {
      const f = files.find((x) => this.host.displayPath(x.fileId) === display) ?? files.find((x) => x.path === display || x.path.endsWith(`/${display}`));
      return f ? f.fileId : -1;
    };
    const resume = this.host.main ? readResume()[this.host.main.path] : undefined;
    return buildTourPanel(t.doc, { runId: t.runId, fileIdOf, narrating: t.narrating, narrationError: t.narrationError, canNarrate: this.canNarrate, resumeStopId: resumeStop(t.doc, t.runId, resume), noLocals });
  }

  pushTour(): void {
    this.host.post({ type: 'tour', tour: this.tourPanel() });
  }

  /* ---------- Compare ---------- */

  compare(leftLogId: string, rightLogId: string): void {
    const run = this.host.run;
    const left = run?.logsById.get(leftLogId);
    const right = run?.logsById.get(rightLogId);
    if (!run || !left || !right) return;
    const title = (e: LogEvent): string => `${this.host.displayPath(e.fileId)}:${run.files.locate(e.rid)?.range[0] ?? '?'}${e.context ? ` ${e.context}` : ''}`;
    this.host.post({ type: 'diff', left: { title: title(left), text: entryText(left) }, right: { title: title(right), text: entryText(right) } });
    this.host.post({ type: 'showView', view: 'diff' });
  }

  /* ---------- the Time Machine's watches ---------- */

  watchRequests(): WatchRequest[] {
    return this.watches.map((w) => ({ id: w.id, exp: w.exp }));
  }

  addWatch(exp: string, rerun = true): boolean {
    const trimmed = exp.trim();
    if (!trimmed || this.watches.some((w) => w.exp === trimmed)) return false;
    this.watches.push({ id: `w-${Date.now().toString(36)}-${++this.watchCounter}`, exp: trimmed, values: new Map() });
    if (rerun) this.requestWatchWindow(true);
    else {
      this.requestedStep = this.host.nav.step;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.host.pushDebugger();
    return true;
  }

  removeWatch(id: string): void {
    const i = this.watches.findIndex((w) => w.id === id);
    if (i < 0) return;
    this.watches.splice(i, 1);
    this.host.pushDebugger();
  }

  editWatch(id: string, exp: string): void {
    const w = this.watches.find((x) => x.id === id);
    const trimmed = exp.trim();
    if (!w || !trimmed || trimmed === w.exp) return;
    if (this.watches.some((x) => x.id !== id && x.exp === trimmed)) return this.removeWatch(id);
    w.exp = trimmed;
    w.values.clear();
    this.requestWatchWindow(true);
    this.host.pushDebugger();
  }

  refreshWatch(id: string): void {
    const w = this.watches.find((x) => x.id === id);
    if (!w) return;
    w.values.clear();
    this.requestWatchWindow(true);
  }

  onWatchEvent(ev: WatchEvent): void {
    const w = this.watches.find((x) => x.id === ev.watchId);
    if (!w) return;
    w.values.set(ev.step, ev.valueBag ? { valueBag: ev.valueBag } : { error: ev.error ?? 'no value' });
    this.host.pushDebugger();
  }

  private scheduleWatches(): void {
    if (!this.watches.length || !this.host.nav.active) return;
    const step = this.host.nav.step;
    if (!this.watches.some((w) => !w.values.has(step))) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      this.requestWatchWindow(false);
    }, 120);
  }

  /** Record the watches around the Time Machine's step: the browser runs like Automatic mode, one run per window. */
  private requestWatchWindow(force: boolean): void {
    if (!this.host.nav.active || !this.watches.length) return;
    const step = this.host.nav.step;
    const req = this.requestedStep;
    if (!force && req !== undefined && step >= req && step <= req + WATCH_PREFETCH && this.host.busy()) return;
    if (!force && req === step && !this.host.busy()) {
      // this window already ran: what it did not answer it cannot; say so instead of re-running forever
      void this.answerFromRecording(step);
      return;
    }
    this.requestedStep = step;
    this.host.rerunForWatches();
  }

  /** After a window's run: a bare name with no value at the step answers from the recorded variables. */
  private async answerFromRecording(step: number): Promise<void> {
    const trace = this.host.run?.trace;
    for (const w of this.watches) {
      if (w.values.has(step)) continue;
      // the runtime skips some steps (a call's entry): the row shows the value just before
      if ([...w.values.keys()].some((s) => s < step && s >= step - WATCH_PREFETCH)) continue;
      if (trace && /^[A-Za-z_$][\w$]*$/.test(w.exp)) {
        const history = await this.variableHistory(w.exp, 100_000).catch(() => undefined);
        const change = history ? pickLocal(w.exp, history.changes, { step, scopes: new Set([trace.scopeId(step), 0]) }) : undefined;
        if (change?.text !== undefined) {
          w.values.set(step, { text: change.text, note: `as of step ${change.step}, ${change.source === 'locals' ? 'recorded' : 'logged'} in ${change.function}, line ${change.line}` });
          continue;
        }
      }
      w.values.set(step, { error: 'not recorded at this step', needsRun: true });
    }
    this.host.pushDebugger();
  }

  /** The row's Evaluate action: one run recording the watches around the current step. */
  evaluateWatch(id: string): void {
    if (!this.watches.some((w) => w.id === id)) return;
    const step = this.host.nav.step;
    for (const w of this.watches) if (w.values.get(step)?.needsRun) w.values.delete(step);
    this.requestedStep = step;
    this.host.rerunForWatches();
  }

  /** The watch rows at `step`: the value recorded there, else the last one before it. */
  watchRows(step: number): DebuggerState['watches'] {
    return this.watches.map((w) => {
      const exact = w.values.get(step);
      if (exact) return { id: w.id, exp: w.exp, valueBag: exact.valueBag, text: exact.valueBag ? undefined : exact.text, note: exact.note, error: exact.error, needsRun: exact.needsRun, step };
      let best = -1;
      for (const s of w.values.keys()) if (s <= step && s > best) best = s;
      const near = best >= 0 ? w.values.get(best) : undefined;
      return { id: w.id, exp: w.exp, valueBag: near?.valueBag, text: near?.valueBag ? undefined : near?.text, note: near?.note, error: near?.error, needsRun: near?.needsRun, step: best >= 0 ? best : undefined };
    });
  }

  async complete(requestId: number, text: string): Promise<void> {
    const runId = this.host.run?.runId;
    let prefix = '';
    let items: Extract<HostToWebview, { type: 'watch.completions' }>['items'] = [];
    if (runId) {
      const reply = await this.host.request({ type: 'complete', runId, expression: text, limit: 50 }).catch(() => undefined);
      if (reply?.type === 'completed') {
        prefix = reply.prefix;
        items = reply.items;
      }
    }
    this.host.post({ type: 'watch.completions', requestId, prefix, items });
  }
}

/** The why tree with display paths on every node and call (whyPane.ts's withDisplayPaths). */
export function withDisplayPathsTree(tree: Provenance, displayPath: (fileId: number) => string): Provenance {
  const node = (n: ProvenanceNode): ProvenanceNode => ({
    ...n,
    ...(n.fileId !== undefined ? { file: displayPath(n.fileId) } : {}),
    ...(n.reads ? { reads: n.reads.map(node) } : {}),
    ...(n.calls ? { calls: n.calls.map((c) => ({ ...c, file: displayPath(c.fileId) })) } : {}),
  });
  return { ...tree, root: node(tree.root) };
}

/** The text an entry shows in full: its value tree rendered, else its text. */
export function entryText(e: LogEvent): string {
  return e.valueBag ? renderValueNode(e.valueBag.data) : e.text;
}

function readResume(): Record<string, TourResume> {
  try {
    return JSON.parse(localStorage.getItem(TOUR_RESUME_KEY) ?? '{}') as Record<string, TourResume>;
  } catch {
    return {};
  }
}

function writeResume(all: Record<string, TourResume>): void {
  try {
    localStorage.setItem(TOUR_RESUME_KEY, JSON.stringify(all));
  } catch {
    /* private window: the resume lasts for the visit */
  }
}
