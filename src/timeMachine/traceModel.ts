/**
 * Time Machine navigation model: pure index arithmetic over the recorded step quads.
 * Nothing here touches vscode so it is unit-testable.
 */
import type { Range4, TraceCap, TraceScope } from '../shared/protocol';
import { StepFlag } from '../shared/protocol';
import type { StepInfo, TimelineModel } from '../shared/webviewProtocol';

export interface StepLocation {
  fileId: number;
  range: Range4;
}

export type RidResolver = (rid: number) => StepLocation | undefined;

export interface CallFrame {
  scopeId: number;
  step: number;
  function: string;
  fileId: number;
  line: number;
  col: number;
  rid?: number;
}

export const ECHO_LIMIT = 100;

export class TraceModel {
  readonly count: number;
  private readonly scopeById = new Map<number, TraceScope>();
  private readonly locationCache = new Map<number, StepLocation | null>();
  private functionColorsCache: Record<number, number> | undefined;

  constructor(
    readonly steps: Int32Array,
    readonly scopes: TraceScope[],
    readonly truncated: boolean,
    private readonly resolve: RidResolver,
    /** a run cut at the step cap: the cap, the steps it ran, the files that ran most (absent on older runtimes and partial traces) */
    readonly cap?: TraceCap,
  ) {
    this.count = Math.floor(steps.length / 4);
    for (const s of scopes) this.scopeById.set(s.scopeId, s);
  }

  static empty(): TraceModel {
    return new TraceModel(new Int32Array(0), [], false, () => undefined);
  }

  rid(i: number): number {
    return this.steps[i * 4] ?? -1;
  }
  scopeId(i: number): number {
    return this.steps[i * 4 + 1] ?? -1;
  }
  depth(i: number): number {
    return this.steps[i * 4 + 2] ?? 0;
  }
  flags(i: number): number {
    return this.steps[i * 4 + 3] ?? 0;
  }
  scope(scopeId: number): TraceScope | undefined {
    return this.scopeById.get(scopeId);
  }
  valid(i: number): boolean {
    return i >= 0 && i < this.count;
  }
  clamp(i: number): number {
    if (this.count === 0) return -1;
    return Math.max(0, Math.min(this.count - 1, i));
  }

  location(i: number): StepLocation | undefined {
    if (!this.valid(i)) return undefined;
    const rid = this.rid(i);
    let loc = this.locationCache.get(rid);
    if (loc === undefined) {
      loc = this.resolve(rid) ?? null;
      this.locationCache.set(rid, loc);
    }
    return loc ?? undefined;
  }

  /* ---------- navigation table (plan) ---------- */

  stepInto(i: number): number {
    return i + 1 < this.count ? i + 1 : -1;
  }
  stepBackInto(i: number): number {
    return i - 1 >= 0 && this.count > 0 ? i - 1 : -1;
  }
  /**
   * Over and out follow the scope's parent chain, not step depth: the next step in the current
   * scope or an ancestor (over), or in an ancestor only (out). A scope entered from another
   * task or a sibling call at the same depth is never a landing spot, so stepping over an
   * `await gather(...)` skips every step of the gathered tasks and lands on the next statement
   * of the awaiting coroutine.
   */
  private lineage(i: number, strict: boolean): Set<number> {
    const out = new Set<number>();
    let sid = this.scopeId(i);
    if (strict) {
      const s = this.scopeById.get(sid);
      sid = s ? s.parent : -1;
    }
    while (sid >= 0 && !out.has(sid)) {
      out.add(sid);
      const s = this.scopeById.get(sid);
      sid = s ? s.parent : -1;
    }
    return out;
  }
  private nextIn(i: number, scopes: Set<number>, dir: 1 | -1): number {
    if (!this.valid(i) || scopes.size === 0) return -1;
    for (let j = i + dir; j >= 0 && j < this.count; j += dir) if (scopes.has(this.scopeId(j))) return j;
    return -1;
  }
  stepOver(i: number): number {
    return this.nextIn(i, this.lineage(i, false), 1);
  }
  stepBackOver(i: number): number {
    return this.nextIn(i, this.lineage(i, false), -1);
  }
  stepOut(i: number): number {
    return this.nextIn(i, this.lineage(i, true), 1);
  }
  stepBackOut(i: number): number {
    return this.nextIn(i, this.lineage(i, true), -1);
  }

  private startsOnLine(j: number, fileId: number, line: number): boolean {
    const loc = this.location(j);
    return !!loc && loc.fileId === fileId && loc.range[0] === line;
  }
  private containsLine(j: number, fileId: number, line: number): boolean {
    const loc = this.location(j);
    return !!loc && loc.fileId === fileId && loc.range[0] <= line && loc.range[2] >= line;
  }

  /** Next step (after i) whose statement starts on `line`; falls back to statements spanning the line. */
  runToLine(i: number, fileId: number, line: number): number {
    for (let j = i + 1; j < this.count; j++) if (this.startsOnLine(j, fileId, line)) return j;
    for (let j = i + 1; j < this.count; j++) if (this.containsLine(j, fileId, line)) return j;
    return -1;
  }
  runBackToLine(i: number, fileId: number, line: number): number {
    for (let j = i - 1; j >= 0; j--) if (this.startsOnLine(j, fileId, line)) return j;
    for (let j = i - 1; j >= 0; j--) if (this.containsLine(j, fileId, line)) return j;
    return -1;
  }

  /** `targets` are `${fileId}:${line}` keys of enabled breakpoints. */
  runToBreakpoint(i: number, targets: ReadonlySet<string>): number {
    if (targets.size === 0) return -1;
    for (let j = i + 1; j < this.count; j++) {
      const loc = this.location(j);
      if (loc && targets.has(`${loc.fileId}:${loc.range[0]}`)) return j;
    }
    return -1;
  }
  runBackToBreakpoint(i: number, targets: ReadonlySet<string>): number {
    if (targets.size === 0) return -1;
    for (let j = i - 1; j >= 0; j--) {
      const loc = this.location(j);
      if (loc && targets.has(`${loc.fileId}:${loc.range[0]}`)) return j;
    }
    return -1;
  }

  /** Start step: first step on `line`, else the first step on a following line of that file, else the first step. */
  startStep(fileId: number, line: number): number {
    if (this.count === 0) return -1;
    for (let j = 0; j < this.count; j++) if (this.startsOnLine(j, fileId, line)) return j;
    for (let j = 0; j < this.count; j++) if (this.containsLine(j, fileId, line)) return j;
    let best = -1;
    let bestLine = Number.POSITIVE_INFINITY;
    for (let j = 0; j < this.count; j++) {
      const loc = this.location(j);
      if (loc && loc.fileId === fileId && loc.range[0] > line && loc.range[0] < bestLine) {
        bestLine = loc.range[0];
        best = j;
      }
    }
    return best >= 0 ? best : 0;
  }

  canStep(i: number): { into: boolean; back: boolean; over: boolean; backOver: boolean; out: boolean; backOut: boolean } {
    return {
      into: this.stepInto(i) >= 0,
      back: this.stepBackInto(i) >= 0,
      over: this.stepOver(i) >= 0,
      backOver: this.stepBackOver(i) >= 0,
      out: this.stepOut(i) >= 0,
      backOut: this.stepBackOut(i) >= 0,
    };
  }

  /** Other executions of the same range, at most `limit` in each direction, ascending. */
  echoSteps(i: number, limit = ECHO_LIMIT): number[] {
    if (!this.valid(i)) return [];
    const rid = this.rid(i);
    const before: number[] = [];
    for (let j = i - 1; j >= 0 && before.length < limit; j--) if (this.rid(j) === rid) before.push(j);
    const after: number[] = [];
    for (let j = i + 1; j < this.count && after.length < limit; j++) if (this.rid(j) === rid) after.push(j);
    return [...before.reverse(), ...after];
  }

  /** Steps that produced logs (used by the panel filter and the Steps strip). */
  isLogStep(i: number): boolean {
    return (this.flags(i) & StepFlag.Log) !== 0;
  }
  isErrorStep(i: number): boolean {
    return (this.flags(i) & StepFlag.Error) !== 0;
  }

  /** Call stack for step i, innermost frame first. Frames beyond the innermost point at call sites. */
  callStack(i: number): CallFrame[] {
    if (!this.valid(i)) return [];
    const frames: CallFrame[] = [];
    const push = (scopeId: number, step: number, name: string): void => {
      const loc = this.location(step);
      frames.push({
        scopeId,
        step,
        function: name,
        fileId: loc?.fileId ?? -1,
        line: loc?.range[0] ?? 0,
        col: loc?.range[1] ?? 0,
        rid: this.rid(step),
      });
    };
    let scope = this.scopeById.get(this.scopeId(i));
    push(this.scopeId(i), i, scope?.name ?? '<module>');
    const seen = new Set<number>();
    while (scope && scope.parent >= 0 && scope.parent !== scope.scopeId && !seen.has(scope.scopeId)) {
      seen.add(scope.scopeId);
      const parent = this.scopeById.get(scope.parent);
      if (!parent) break;
      let callSite = -1;
      for (let j = Math.min(scope.first, this.count) - 1; j >= 0; j--) {
        if (this.scopeId(j) === parent.scopeId) {
          callSite = j;
          break;
        }
      }
      if (callSite < 0) break;
      push(parent.scopeId, callSite, parent.name);
      scope = parent;
    }
    return frames;
  }

  /** Palette index per scope *name* (the Timeline Guide lists function -> colour). */
  functionColors(): Record<number, number> {
    if (this.functionColorsCache) return this.functionColorsCache;
    const byName = new Map<string, number>();
    const out: Record<number, number> = {};
    for (const s of this.scopes) {
      let idx = byName.get(s.name);
      if (idx === undefined) {
        idx = byName.size;
        byName.set(s.name, idx);
      }
      out[s.scopeId] = idx;
    }
    this.functionColorsCache = out;
    return out;
  }

  stepInfo(i: number): StepInfo | undefined {
    if (!this.valid(i)) return undefined;
    const loc = this.location(i);
    return {
      index: i,
      rid: this.rid(i),
      fileId: loc?.fileId ?? -1,
      line: loc?.range[0] ?? 0,
      col: loc?.range[1] ?? 0,
      scopeId: this.scopeId(i),
      depth: this.depth(i),
      flags: this.flags(i),
    };
  }

  toTimelineModel(): TimelineModel {
    const n = this.count;
    const scopeIds = new Array<number>(n);
    const flags = new Array<number>(n);
    const lines = new Array<number>(n);
    const cols = new Array<number>(n);
    const fileIds = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      scopeIds[i] = this.scopeId(i);
      flags[i] = this.flags(i);
      const loc = this.location(i);
      lines[i] = loc?.range[0] ?? 0;
      cols[i] = loc?.range[1] ?? 0;
      fileIds[i] = loc?.fileId ?? -1;
    }
    return { stepCount: n, scopeIds, flags, lines, cols, fileIds, scopes: this.scopes, functionColors: this.functionColors(), truncated: this.truncated, ...(this.cap ? { cap: this.cap } : {}) };
  }
}

export interface StoryBlockRange {
  scopeId: number;
  firstStep: number;
  lastStep: number;
  fileId: number;
}

/**
 * Split a trace into the blocks the Code Story lists. A block runs while the scope holds and no
 * line comes back around: a line reached again after leaving it is the code running again, so a
 * loop body becomes one block per iteration and each block reads as a straight run down the source.
 * Several steps can share a line (a call and its arguments, a comprehension), so only a line
 * returned to after leaving it starts a block. Steps in another file belong to that file's own
 * block: they neither end the current one nor count as a line coming back.
 */
export function storyBlocks(trace: TraceModel): StoryBlockRange[] {
  const out: StoryBlockRange[] = [];
  let i = 0;
  while (i < trace.count) {
    const scopeId = trace.scopeId(i);
    const loc = trace.location(i);
    const fileId = loc?.fileId ?? -1;
    const seen = new Set<number>();
    let prevLine = loc?.range[0];
    if (prevLine !== undefined) seen.add(prevLine);
    let j = i;
    while (j + 1 < trace.count && trace.scopeId(j + 1) === scopeId) {
      const next = trace.location(j + 1);
      const line = next && next.fileId === fileId ? next.range[0] : undefined;
      if (line !== undefined && line !== prevLine) {
        if (seen.has(line)) break;
        seen.add(line);
      }
      if (line !== undefined) prevLine = line;
      j++;
    }
    out.push({ scopeId, firstStep: i, lastStep: j, fileId });
    i = j + 1;
  }
  return out;
}

/** Build the quads array from readable tuples (tests and fixtures). */
export function packSteps(quads: [rid: number, scopeId: number, depth: number, flags?: number][]): Int32Array {
  const arr = new Int32Array(quads.length * 4);
  quads.forEach(([rid, scopeId, depth, flags], i) => {
    arr[i * 4] = rid;
    arr[i * 4 + 1] = scopeId;
    arr[i * 4 + 2] = depth;
    arr[i * 4 + 3] = flags ?? 0;
  });
  return arr;
}
