/**
 * The moment builder behind `walkthrough.ts`: one pass per kind over a session's state (calls
 * with library scopes merged per user-code call site, decisions and loops from the file map,
 * logged values, prints, errors, start and end). `python/pyokka_runtime/agent/moments.py` is
 * the same builder over a saved run; the fixture test pins both.
 */
import * as path from 'node:path';
import type { LogEvent } from '../shared/protocol';
import type { TraceModel } from '../timeMachine/traceModel';
import { enclosingFunction, fileMap, type Decision, type FileMap } from './decisions';
import { INLINE_MAX, ORDER, PARAM_MAX, PRINT_MAX, SKIP_PARAMS, VALUE_KINDS, VALUE_MAX, cut, displayPath, formatDuration, isUserFile, libraryPackage, type Moment, type MomentLocation, type MomentValue, type WalkthroughInputs } from './walkthroughShared';

/* ---------- the builder ---------- */

/** Whether `name` appears in `text` as a whole identifier. */
function nameIn(name: string, text: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

/** A trace scope as the call rules read it (`TraceScope` fits). */
export interface Scope {
  scopeId: number;
  rid: number;
  name: string;
  parent: number;
  first: number;
  last: number;
  /** What the function returned, as text, recorded at its exit (runtime 0.1.7 on); null when the body ran off its end. */
  returned?: string | null;
  /** The exception type it left by, when it returned nothing. */
  raised?: string;
}
interface CallEntry {
  kind: 'call' | 'tool';
  scope: Scope;
  callSite: number;
  members: Scope[];
  library: boolean;
  /** tool moments: the scope that was running when the callback came in */
  caller?: number;
  key?: string;
}
type Draft = Omit<Moment, 'id' | 'durationMs' | 'gloss'> & { key?: string; _loop?: { kind: string; text: string }; _fid?: number; _line?: number; _end?: number };

export class MomentBuilder {
  private readonly maps = new Map<number, FileMap>();
  private readonly userCache = new Map<number, boolean>();
  /** log entries `params`, `result` and `tookValue` used as `in` / `out` / `took`; the provenance builder clears it so every call node stands alone */
  readonly consumed = new Set<LogEvent>();
  private readonly moments: Draft[] = [];
  private readonly stepsByScope = new Map<number, number[]>();
  private readonly logsByStep = new Map<number, LogEvent[]>();
  private readonly localsByStep = new Map<number, WalkthroughInputs['locals'][number][]>();
  private readonly trace: TraceModel;

  constructor(
    private readonly inputs: WalkthroughInputs,
    private readonly all: boolean,
  ) {
    this.trace = inputs.trace;
    for (let i = 0; i < this.trace.count; i++) {
      const sid = this.trace.scopeId(i);
      const list = this.stepsByScope.get(sid);
      if (list) list.push(i);
      else this.stepsByScope.set(sid, [i]);
    }
    for (const e of inputs.entries) {
      const list = this.logsByStep.get(e.step);
      if (list) list.push(e);
      else this.logsByStep.set(e.step, [e]);
    }
    for (const entry of inputs.locals) {
      const list = this.localsByStep.get(entry.step);
      if (list) list.push(entry);
      else this.localsByStep.set(entry.step, [entry]);
    }
  }

  /* ----- files ----- */
  private map(fid: number): FileMap {
    let m = this.maps.get(fid);
    if (!m) {
      const f = this.inputs.files.get(fid);
      const lines = this.inputs.readSource(fid) ?? [];
      m = fileMap(lines, f ? f.statements.map((local) => f.ranges[local]!).filter(Boolean) : []);
      this.maps.set(fid, m);
    }
    return m;
  }
  /** The file map of a file of the run (cached); the execution graph reads `decisions` from it. */
  fileMapOf(fid: number): FileMap {
    return this.map(fid);
  }
  private filePath(fid: number): string | null {
    return this.inputs.files.get(fid)?.path ?? null;
  }
  private user(fid: number): boolean {
    let u = this.userCache.get(fid);
    if (u === undefined) {
      u = isUserFile(this.filePath(fid), this.inputs.workspaceRoot, this.inputs.mainFile);
      this.userCache.set(fid, u);
    }
    return u;
  }
  private loc(step: number): [number, number, number] {
    const l = this.trace.location(step);
    return l ? [l.fileId, l.range[0], this.trace.rid(step)] : [-1, 0, this.trace.rid(step)];
  }
  private location(step: number, fn?: string): MomentLocation {
    const [fid, line] = this.loc(step);
    return { file: this.filePath(fid), line, function: fn ?? this.scopeQualname(this.trace.scopeId(step)), fileId: fid };
  }
  private display(fid: number): string {
    return displayPath(this.filePath(fid), this.inputs.workspaceRoot);
  }
  private sources(fid: number): string[] {
    return fid >= 0 ? this.inputs.readSource(fid) ?? [] : [];
  }
  /** The main file's id: the file whose path is the run's main file, else the lowest id. */
  mainFileId(): number {
    const exact = this.inputs.files.all().find((f) => path.resolve(f.path) === path.resolve(this.inputs.mainFile));
    if (exact) return exact.fileId;
    const ids = this.inputs.files.all().map((f) => f.fileId);
    return ids.length ? Math.min(...ids) : 1;
  }

  /* ----- names ----- */
  scopeQualname(scopeId: number): string {
    const s = this.trace.scope(scopeId);
    if (!s || s.parent < 0) return '<module>';
    const loc = this.inputs.files.locate(s.rid);
    if (!loc) return s.name;
    if (s.name === '<module>') return '<module>';
    return this.map(loc.fileId).qualnames.get(loc.range[0]) ?? s.name;
  }
  private functionAt(fid: number, line: number): string {
    return enclosingFunction(this.map(fid), line)?.name ?? '<module>';
  }

  /* ----- scopes: the call rules, shared with the provenance builder ----- */
  /** The step that called the scope: the last step of its parent scope before its first step. */
  callSite(scope: Scope): number {
    const steps = this.stepsByScope.get(scope.parent) ?? [];
    let lo = 0;
    let hi = steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid]! < scope.first) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? steps[lo - 1]! : scope.first;
  }
  /** The last step of scope `scopeId` before step `before` (`before` itself when there is none). */
  private siteIn(scopeId: number, before: number): number {
    const steps = this.stepsByScope.get(scopeId) ?? [];
    let lo = 0;
    let hi = steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid]! < before) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? steps[lo - 1]! : before;
  }
  /** The source of the whole statement a step ran (every line of its range). */
  private statementText(step: number): string {
    const loc = this.inputs.files.locate(this.trace.rid(step));
    if (!loc) return '';
    return this.sources(loc.fileId).slice(loc.range[0] - 1, loc.range[2]).join('\n');
  }
  /**
   * The scope that was running when code the recording does not show called `s` back, else undefined.
   * `s` is a callback when the statement at its call site has a call but does not name it (dunders,
   * lambdas and comprehensions never count). Its recorded parent can be too shallow (the tracer looks
   * a few frames up for a caller and a library's frames use them up), so the caller is the
   * latest-entered scope under the recorded parent that still records a step after `s` entered, else
   * the recorded parent. `moments.py` `callback_caller` is the same rule.
   */
  private callbackCaller(s: Scope, site: number, running: Scope[]): number | undefined {
    const name = s.name.split('.').pop() ?? s.name;
    if (name.startsWith('<') || (name.startsWith('__') && name.endsWith('__')) || site >= s.first) return undefined;
    const text = this.statementText(site);
    if (!text.includes('(') || nameIn(name, text) || this.generator(s)) return undefined;
    let best: Scope | undefined;
    for (const q of running) {
      if (q.last > s.first && q.first < s.first && (!best || q.first > best.first) && this.descends(q.scopeId, s.parent)) best = q;
    }
    return best ? best.scopeId : s.parent;
  }
  /** Whether the scope's function has a `yield`: `next(g)` resumes it under a name the statement does not show. */
  private generator(s: Scope): boolean {
    const loc = this.inputs.files.locate(s.rid);
    if (!loc) return false;
    const line = loc.range[0];
    const end = this.map(loc.fileId).functions.get(line)?.end ?? line;
    return this.sources(loc.fileId).slice(line - 1, end).some((l) => nameIn('yield', l));
  }
  /** Whether `scopeId` is a strict descendant of `ancestor` in the recorded parents. */
  private descends(scopeId: number, ancestor: number): boolean {
    let s = this.trace.scope(scopeId);
    for (let hops = 0; s && s.parent >= 0 && hops < 10_000; hops++) {
      if (s.parent === ancestor) return true;
      s = this.trace.scope(s.parent);
    }
    return false;
  }
  /** The arguments of a call as `in` rows: the locals recorded at entry (`self`/`cls` left out), then values logged on the `def` line. */
  params(scope: Scope): MomentValue[] {
    const out: MomentValue[] = [];
    outer: for (const step of [scope.first, scope.first + 1]) {
      for (const entry of this.localsByStep.get(step) ?? []) {
        if (entry.scopeId !== scope.scopeId) continue;
        for (const ch of entry.changes) if (!SKIP_PARAMS.has(ch.name)) out.push({ role: 'in', name: ch.name, text: cut(ch.text, VALUE_MAX) });
        if (out.length) break outer;
      }
    }
    for (const step of [scope.first, scope.first + 1]) {
      for (const ev of this.logsByStep.get(step) ?? []) {
        if (ev.rid === scope.rid && VALUE_KINDS.has(ev.kind) && !this.consumed.has(ev)) {
          this.consumed.add(ev);
          out.push({ role: 'in', name: ev.context || 'value', text: cut(ev.text, VALUE_MAX) });
        }
      }
    }
    return out.slice(0, PARAM_MAX);
  }
  /** What a call produced as an `out` row: the last value logged on a `return` line of the callee, else the value the call statement logged, else the local a bare `return name` returned. */
  result(scope: Scope, callSite: number, last: number): MomentValue[] {
    const loc = this.inputs.files.locate(scope.rid);
    if (scope.returned !== undefined || scope.raised !== undefined) {
      this.consumeReturnLogs(scope, last);
      return typeof scope.returned === 'string' ? [{ role: 'out', name: 'return', text: cut(scope.returned, VALUE_MAX) }] : [];
    }
    // a lambda or a generator expression records no return value, and the value its call site
    // logged (`ranked = sorted(..., key=lambda kv: kv[1])`) is the statement's, not its own
    if (scope.name.startsWith('<') && scope.name !== '<module>') return [];
    if (loc && this.user(loc.fileId)) {
      const returns = this.map(loc.fileId).returns;
      let best: LogEvent | undefined;
      for (let step = scope.first; step <= last; step++) {
        for (const ev of this.logsByStep.get(step) ?? []) {
          if (!VALUE_KINDS.has(ev.kind) || ev.fileId !== loc.fileId || this.consumed.has(ev)) continue;
          const l = this.inputs.files.locate(ev.rid);
          if (l && returns.has(l.range[0])) best = ev;
        }
      }
      if (best) {
        this.consumed.add(best);
        return [{ role: 'out', name: 'return', text: cut(best.text, VALUE_MAX) }];
      }
    }
    const siteRid = this.trace.rid(callSite);
    let site: LogEvent | undefined;
    for (let step = callSite; step <= last + 1; step++) {
      for (const ev of this.logsByStep.get(step) ?? []) if (ev.rid === siteRid && VALUE_KINDS.has(ev.kind) && !this.consumed.has(ev)) site = ev;
    }
    if (site) {
      this.consumed.add(site);
      return [{ role: 'out', name: site.context || 'value', text: cut(site.text, VALUE_MAX) }];
    }
    const [lfid, lline] = this.loc(last);
    const src = this.sources(lfid);
    const stmt = lline > 0 && lline <= src.length ? (src[lline - 1] ?? '').trim() : '';
    const returned = stmt.startsWith('return ') ? stmt.slice('return '.length).trim() : undefined;
    if (returned && /^[A-Za-z_][A-Za-z0-9_]*$/.test(returned)) {
      for (const entry of this.localsByStep.get(last) ?? []) {
        if (entry.scopeId !== scope.scopeId) continue;
        for (const ch of entry.changes) if (ch.name === returned) return [{ role: 'out', name: 'return', text: cut(ch.text, VALUE_MAX) }];
      }
    }
    return [];
  }
  /** The value logs of the scope's own `return` lines (`autoLog`), so they are not listed again as values. `return f(x)` logs at f's last step, so the scan reads on to the caller's next step. */
  private consumeReturnLogs(scope: Scope, last: number): void {
    const loc = this.inputs.files.locate(scope.rid);
    if (!loc || !this.user(loc.fileId)) return;
    const map = this.map(loc.fileId);
    const defLine = loc.range[0];
    const next = (this.stepsByScope.get(scope.parent) ?? []).find((step) => step > last);
    const end = Math.max(next ?? this.trace.count, last + 2);
    for (let step = scope.first; step < end; step++) {
      for (const ev of this.logsByStep.get(step) ?? []) {
        if (!VALUE_KINDS.has(ev.kind) || ev.fileId !== loc.fileId || this.consumed.has(ev)) continue;
        const line = this.inputs.files.locate(ev.rid)?.range[0];
        if (line !== undefined && map.returns.has(line) && enclosingFunction(map, line)?.line === defLine) this.consumed.add(ev);
      }
    }
  }
  /** `raised`, else the exception the scope recorded leaving by (its caller caught it, so no unhandled error event names it). */
  private raisedOrExit(scope: Scope, first: number, last: number): MomentValue[] {
    const raised = this.raised(first, last);
    if (raised.length || !scope.raised) return raised;
    const name = scope.raised;
    const ev = this.inputs.errors.find((e) => e.errorType === name && e.step >= first && e.step <= last);
    const message = ev ? cut(ev.message, VALUE_MAX) : '';
    return [{ role: 'out', name: 'raised', text: `${name}${message ? ': ' + message : ''}` }];
  }
  private raised(first: number, last: number): MomentValue[] {
    for (const ev of this.inputs.errors) {
      if (!ev.handled && ev.step >= first && ev.step <= last) {
        const message = cut(ev.message, VALUE_MAX);
        return [{ role: 'out', name: 'raised', text: `${ev.errorType}${message ? ': ' + message : ''}` }];
      }
    }
    return [];
  }
  private isLibraryScope(scopeId: number): boolean {
    const s = this.trace.scope(scopeId);
    if (!s || s.parent < 0) return false;
    const loc = this.inputs.files.locate(s.rid);
    return !!loc && !this.user(loc.fileId) && s.name !== '<module>';
  }

  private calls(): void {
    const scopes = (this.trace.scopes as Scope[]).filter((s) => s.parent >= 0).sort((a, b) => a.first - b.first);
    const groups = new Map<number, CallEntry>();
    const groupOf = new Map<number, number>();
    const rootBySite = new Map<string, number>();
    const entries: CallEntry[] = [];
    let running: Scope[] = [];
    for (const s of scopes) {
      const loc = this.inputs.files.locate(s.rid);
      const fid = loc?.fileId ?? -1;
      const library = fid >= 0 && !this.user(fid) && s.name !== '<module>';
      running = running.filter((q) => q.last > s.first);
      if (!library) running.push(s);
      if (library && !this.all) {
        const parentRoot = groupOf.get(s.parent);
        if (parentRoot !== undefined) {
          groups.get(parentRoot)!.members.push(s);
          groupOf.set(s.scopeId, parentRoot);
          continue;
        }
        const site = this.callSite(s);
        const pkg = libraryPackage(this.filePath(fid)) ?? '';
        const key = `${site} ${pkg}`;
        const existing = rootBySite.get(key);
        if (existing !== undefined && this.trace.scope(existing)?.parent === s.parent) {
          groups.get(existing)!.members.push(s);
          groupOf.set(s.scopeId, existing);
          continue;
        }
        const entry: CallEntry = { kind: 'call', scope: s, callSite: site, members: [s], library: true };
        groups.set(s.scopeId, entry);
        groupOf.set(s.scopeId, s.scopeId);
        rootBySite.set(key, s.scopeId);
        entries.push(entry);
        continue;
      }
      let kind: CallEntry['kind'] = (groupOf.has(s.parent) || (this.all && this.isLibraryScope(s.parent))) && !library ? 'tool' : 'call';
      let site = this.callSite(s);
      let caller = kind === 'tool' ? s.parent : undefined;
      if (kind === 'call' && !library && s.name !== '<module>') {
        caller = this.callbackCaller(s, site, running);
        if (caller !== undefined) {
          kind = 'tool';
          site = this.siteIn(caller, s.first);
        }
      }
      entries.push({ kind, scope: s, callSite: site, members: [s], library, caller });
    }
    // a call's extent: its own steps and those of every scope under it, so `return f(x)` ends
    // after f ran, not at the `return` statement (children enter after their parent)
    const subtreeLast = new Map<number, number>(scopes.map((s) => [s.scopeId, s.last]));
    for (let i = scopes.length - 1; i >= 0; i--) {
      const s = scopes[i]!;
      const own = subtreeLast.get(s.scopeId)!;
      const up = subtreeLast.get(s.parent);
      if (up !== undefined && own > up) subtreeLast.set(s.parent, own);
    }
    const counts = new Map<string, number>();
    for (const e of entries) {
      e.key = `${e.scope.rid}:${this.trace.rid(e.callSite)}`;
      counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const e of entries) {
      const s = e.scope;
      const key = e.key!;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const n = counts.get(key)!;
      const i = seen.get(key)!;
      const callee = this.scopeQualname(s.scopeId);
      const first = s.first;
      const last = Math.max(...e.members.map((m) => subtreeLast.get(m.scopeId) ?? m.last));
      const site = e.callSite;
      const loc = this.inputs.files.locate(s.rid);
      const fid = loc?.fileId ?? -1;
      let text: string;
      let step: number;
      let location: MomentLocation;
      if (s.name === '<module>') {
        text = `module ${this.display(fid)} runs`;
        step = site;
        location = this.location(site);
      } else if (e.kind === 'tool') {
        const caller = this.scopeQualname(e.caller ?? s.parent);
        const siteFid = this.loc(site)[0];
        const pkg = this.user(siteFid) ? undefined : libraryPackage(this.filePath(siteFid));
        text = pkg ? `${pkg} calls back into ${callee} (${caller})` : `callback into ${callee} from ${caller}`;
        step = first;
        location = this.location(first, callee);
      } else {
        const caller = this.scopeQualname(s.parent);
        const who = callee + (e.library ? ` (${libraryPackage(this.filePath(fid))})` : '');
        text = n > 1 ? `call ${i} of ${n} to ${who} from ${caller}` : `call to ${who} from ${caller}`;
        const nested = e.members.length - 1;
        if (nested) text += `, ${nested} nested call${nested === 1 ? '' : 's'}`;
        step = site;
        location = this.location(site, caller);
      }
      const values = [...this.params(s), ...this.result(s, site, last), ...this.raisedOrExit(s, first, last)];
      const moment: Draft = { kind: e.kind, step, location, text, values, scopeId: s.scopeId, entryStep: first, endStep: last, callee: { file: this.filePath(fid), line: loc?.range[0] ?? 0, function: callee, fileId: fid }, key };
      if (e.kind === 'tool') moment.callerScopeId = e.caller ?? s.parent;
      this.moments.push(moment);
    }
  }

  /* ----- decisions, loops ----- */
  private nextInScope(step: number): number | undefined {
    const steps = this.stepsByScope.get(this.trace.scopeId(step)) ?? [];
    let lo = 0;
    let hi = steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid]! <= step) lo = mid + 1;
      else hi = mid;
    }
    return steps[lo];
  }
  private tookValue(step: number, rid: number): MomentValue[] {
    for (const ev of this.logsByStep.get(step) ?? []) {
      if (ev.rid === rid && VALUE_KINDS.has(ev.kind) && !this.consumed.has(ev)) {
        this.consumed.add(ev);
        return [{ role: 'took', name: ev.context || 'value', text: cut(ev.text, VALUE_MAX) }];
      }
    }
    return [];
  }
  private decisionsAndLoops(): void {
    const openLoops = new Map<number, Draft[]>();
    for (let i = 0; i < this.trace.count; i++) {
      const [fid, line, rid] = this.loc(i);
      if (fid < 0 || !this.user(fid)) continue;
      const sid = this.trace.scopeId(i);
      const loc = this.inputs.files.locate(rid);
      const startsHere = !!loc && loc.range[0] === line;
      let stack = openLoops.get(sid);
      if (!stack) {
        stack = [];
        openLoops.set(sid, stack);
      }
      while (stack.length && !(stack[stack.length - 1]!._fid === fid && stack[stack.length - 1]!._line! <= line && line <= stack[stack.length - 1]!._end!)) stack.pop();
      if (!startsHere) continue;
      const map = this.map(fid);
      const loop = map.loops.get(line);
      if (loop) {
        const top = stack[stack.length - 1];
        if (top && top._line === line && top._fid === fid) top.count!++;
        else {
          const m: Draft = { kind: 'decision', step: i, location: this.location(i), text: '', values: this.tookValue(i, rid), count: 1, _loop: loop, _fid: fid, _line: line, _end: loop.end };
          stack.push(m);
          this.moments.push(m);
        }
        continue;
      }
      const dec = map.decisions.get(line);
      if (!dec) continue;
      const nxt = this.nextInScope(i);
      const nline = nxt !== undefined && this.loc(nxt)[0] === fid ? this.loc(nxt)[1] : -1;
      this.moments.push({ kind: 'decision', step: i, location: this.location(i), text: decisionText(dec, nline), values: this.tookValue(i, rid) });
    }
    for (const m of this.moments) {
      if (!m._loop) continue;
      const runs = m.count! - 1;
      m.text = `${m._loop.kind} ${m._loop.text} ran ${runs} time${runs === 1 ? '' : 's'}`;
      m.count = runs;
      delete m._loop;
      delete m._fid;
      delete m._line;
      delete m._end;
    }
  }

  /* ----- values, prints, errors ----- */
  private values(): void {
    for (const ev of this.inputs.entries) {
      if (this.consumed.has(ev) || !this.user(ev.fileId)) continue;
      const loc = this.inputs.files.locate(ev.rid);
      const line = loc?.range[0] ?? 0;
      const location: MomentLocation = { file: this.filePath(ev.fileId), line, function: this.functionAt(ev.fileId, line), fileId: ev.fileId };
      if (ev.kind === 'log') {
        const where = ev.context === 'stderr' ? ' to stderr' : '';
        this.moments.push({ kind: 'print', step: ev.step, location, text: `prints${where} ${cut(ev.text, PRINT_MAX)}`, values: [] });
      } else if (VALUE_KINDS.has(ev.kind)) {
        const text = ev.context ? `${ev.context} = ${cut(ev.text, INLINE_MAX)}` : cut(ev.text, INLINE_MAX);
        this.moments.push({ kind: 'value', step: ev.step, location, text, values: [{ role: 'value', name: ev.context || 'value', text: cut(ev.text, VALUE_MAX) }] });
      }
    }
  }
  private errorsMoments(): void {
    const seen = new Set<string>();
    const sorted = [...this.inputs.errors].sort((a, b) => Number(!!a.handled) - Number(!!b.handled));
    for (const ev of sorted) {
      const key = `${ev.errorType} ${ev.message} ${ev.step}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const step = ev.step;
      const frame = ev.stack.find((f) => this.user(f.fileId));
      const location: MomentLocation = frame ? { file: this.filePath(frame.fileId), line: frame.line, function: this.functionAt(frame.fileId, frame.line), fileId: frame.fileId } : this.location(step);
      const message = cut(ev.message, INLINE_MAX);
      let text = `raised ${ev.errorType}${message ? ': ' + message : ''}`;
      if (ev.handled) {
        const nxt = this.trace.valid(step + 1) ? step + 1 : undefined;
        if (nxt !== undefined && this.loc(nxt)[0] >= 0) {
          const [nfid, nline] = this.loc(nxt);
          text += `, handled at ${this.display(nfid)}:${nline}`;
        } else text += ' (handled)';
      } else text += ' uncaught';
      this.moments.push({ kind: 'error', step, location, text, values: [] });
    }
  }
  private ends(): void {
    if (this.trace.count === 0) return;
    this.moments.push({ kind: 'start', step: 0, location: this.location(0), text: `module ${this.display(this.mainFileId())} starts`, values: [] });
    const last = this.trace.count - 1;
    const fin = this.inputs.finished;
    let text: string;
    if (fin?.timedOut) text = `run killed by the timeout after ${formatDuration(fin.durationMs)}`;
    else if (fin?.stopped) text = `run stopped after ${formatDuration(fin.durationMs)}`;
    else text = `run ends with exit code ${fin?.exitCode ?? null} after ${formatDuration(fin?.durationMs)}`;
    this.moments.push({ kind: 'end', step: last, location: this.location(last), text, values: [] });
  }

  build(): Moment[] {
    this.calls();
    this.decisionsAndLoops();
    this.values();
    this.errorsMoments();
    this.ends();
    const order = new Map(this.moments.map((m, n) => [m, n]));
    this.moments.sort((a, b) => a.step - b.step || (ORDER[a.kind] ?? 5) - (ORDER[b.kind] ?? 5) || order.get(a)! - order.get(b)!);
    return this.moments.map((m, n) => ({ ...m, id: `m${n}`, durationMs: null, gloss: null }) as Moment & { key?: string });
  }
}

export function decisionText(dec: Decision, nextLine: number): string {
  if (dec.kind === 'match') {
    const arm = dec.arms.find((a) => a.body[0] <= nextLine && nextLine <= a.body[1]);
    return `match ${dec.text} took ${arm ? `case ${arm.text}` : 'no case'}`;
  }
  const took = dec.body[0] <= nextLine && nextLine <= dec.body[1];
  return `${dec.label} ${dec.text} took ${took ? 'True' : 'False'}`;
}
