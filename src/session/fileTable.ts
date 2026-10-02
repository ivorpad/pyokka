/**
 * Per-run table of instrumented files: resolves global range ids to (fileId, range).
 * Pure; shared by the session, decorations and the trace model.
 */
import type { FileInstrumentedEvent, Range4 } from '../shared/protocol';

export interface InstrumentedFile {
  fileId: number;
  path: string;
  rangeBase: number;
  ranges: Range4[];
  statements: number[];
  functions: { rid: number; name: string; bodyRange: Range4 }[];
  magic: { rid: number; kind: string }[];
  instrumentedSource?: string;
}

export interface RidLocation {
  fileId: number;
  path: string;
  range: Range4;
  /** local index inside the file's range table */
  localRid: number;
}

export class FileTable {
  private readonly files = new Map<number, InstrumentedFile>();
  private sorted: InstrumentedFile[] = [];

  add(ev: Omit<FileInstrumentedEvent, 'type' | 'runId' | 'seq'>): InstrumentedFile {
    const f: InstrumentedFile = {
      fileId: ev.fileId,
      path: ev.path,
      rangeBase: ev.rangeBase,
      ranges: ev.ranges,
      statements: ev.statements,
      functions: ev.functions,
      magic: ev.magic,
      instrumentedSource: ev.instrumentedSource,
    };
    this.files.set(f.fileId, f);
    this.sorted = [...this.files.values()].sort((a, b) => a.rangeBase - b.rangeBase);
    return f;
  }

  get(fileId: number): InstrumentedFile | undefined {
    return this.files.get(fileId);
  }

  all(): InstrumentedFile[] {
    return this.sorted;
  }

  byPath(path: string): InstrumentedFile | undefined {
    return this.sorted.find((f) => f.path === path);
  }

  locate(rid: number): RidLocation | undefined {
    // binary search over sorted rangeBase
    let lo = 0;
    let hi = this.sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const f = this.sorted[mid]!;
      if (rid < f.rangeBase) hi = mid - 1;
      else if (rid >= f.rangeBase + f.ranges.length) lo = mid + 1;
      else {
        const localRid = rid - f.rangeBase;
        const range = f.ranges[localRid];
        if (!range) return undefined;
        return { fileId: f.fileId, path: f.path, range, localRid };
      }
    }
    return undefined;
  }

  /** Statement ranges of a file that start on `line` (1-based). */
  statementsOnLine(fileId: number, line: number): { rid: number; range: Range4 }[] {
    const f = this.files.get(fileId);
    if (!f) return [];
    const out: { rid: number; range: Range4 }[] = [];
    for (const local of f.statements) {
      const r = f.ranges[local];
      if (r && r[0] === line) out.push({ rid: f.rangeBase + local, range: r });
    }
    return out;
  }

  /** The innermost statement range containing `line` (1-based). */
  statementContaining(fileId: number, line: number): { rid: number; range: Range4 } | undefined {
    const f = this.files.get(fileId);
    if (!f) return undefined;
    let best: { rid: number; range: Range4 } | undefined;
    for (const local of f.statements) {
      const r = f.ranges[local];
      if (!r || r[0] > line || r[2] < line) continue;
      if (!best || r[2] - r[0] <= best.range[2] - best.range[0]) best = { rid: f.rangeBase + local, range: r };
    }
    return best;
  }

  /** The function whose body contains `line`, innermost first. */
  functionAt(fileId: number, line: number): { rid: number; name: string; bodyRange: Range4 } | undefined {
    const f = this.files.get(fileId);
    if (!f) return undefined;
    let best: { rid: number; name: string; bodyRange: Range4 } | undefined;
    for (const fn of f.functions) {
      const r = fn.bodyRange;
      if (r[0] > line || r[2] < line) continue;
      if (!best || r[2] - r[0] <= best.bodyRange[2] - best.bodyRange[0]) best = fn;
    }
    return best;
  }
}
