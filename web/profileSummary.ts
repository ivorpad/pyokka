/**
 * What Profile shows in the browser: a Chrome `.cpuprofile` (V8's own from the JS runtime, the flat
 * one python/pyokka_runtime/profile.py writes from cProfile) folded into one row per function with
 * its self and total time, the table VS Code's profile editor opens on. The bridge also serves the
 * file itself (`/api/profile`) for Chrome DevTools or VS Code.
 */

export interface ProfileRow {
  name: string;
  /** the function's file (a path, `file://` stripped), '' for native code */
  file: string;
  /** 1-based */
  line: number;
  selfMs: number;
  totalMs: number;
  /** cProfile's call count (the Python runtime only) */
  calls?: number;
}

export interface ProfileSummary {
  totalMs: number;
  rows: ProfileRow[];
}

interface CpuNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
  callCount?: number;
  /** ms, written by the Python runtime's flat profile */
  totalTime?: number;
}

interface CpuProfile {
  nodes: CpuNode[];
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
  endTime?: number;
}

/** V8's synthetic nodes, which say where time went but are no function of the program */
const SYNTHETIC = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

export function summarizeProfile(profile: CpuProfile, limit = 200): ProfileSummary {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  // self time per node: the deltas of the samples that landed on it
  const self = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  // V8: a sample's time is the gap to the next one (the last takes the mean); the Python runtime's
  // flat profile (nodes with `totalTime`) gives each sample its own time as its delta
  const own = profile.nodes.some((n) => n.totalTime !== undefined);
  const mean = deltas.length > 1 ? deltas.slice(1).reduce((a, b) => a + b, 0) / (deltas.length - 1) : 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = own ? (deltas[i] ?? 0) : (deltas[i + 1] ?? mean);
    self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + Math.max(0, dt));
  }
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = (n: CpuNode) => `${n.callFrame.functionName}\u0000${n.callFrame.url}\u0000${n.callFrame.lineNumber}`;
  // total per node: itself and everything under it
  const total = new Map<number, number>();
  const subtree = (id: number): number => {
    const have = total.get(id);
    if (have !== undefined) return have;
    const n = byId.get(id);
    let t = self.get(id) ?? 0;
    for (const c of n?.children ?? []) t += subtree(c);
    total.set(id, t);
    return t;
  };
  const rows = new Map<string, ProfileRow>();
  for (const n of profile.nodes) {
    if (SYNTHETIC.has(n.callFrame.functionName)) continue;
    const key = keyOf(n);
    let row = rows.get(key);
    if (!row) {
      const name = n.callFrame.functionName || '(anonymous)';
      row = { name, file: nativeUrl(n.callFrame.url) ? '' : n.callFrame.url.replace(/^file:\/\//, ''), line: n.callFrame.lineNumber + 1, selfMs: 0, totalMs: 0 };
      rows.set(key, row);
    }
    row.selfMs += (self.get(n.id) ?? 0) / 1000;
    if (n.totalTime !== undefined) row.totalMs = Math.max(row.totalMs, n.totalTime);
    else {
      // a recursive call is already inside its outer call's total
      let p = parent.get(n.id);
      let nested = false;
      while (p !== undefined && !nested) {
        const pn = byId.get(p);
        if (pn && keyOf(pn) === key) nested = true;
        p = parent.get(p);
      }
      if (!nested) row.totalMs += subtree(n.id) / 1000;
    }
    if (n.callCount !== undefined) row.calls = (row.calls ?? 0) + n.callCount;
  }
  const sampled = [...self.values()].reduce((a, b) => a + b, 0) / 1000;
  const span = profile.endTime !== undefined && profile.startTime !== undefined ? (profile.endTime - profile.startTime) / 1000 : 0;
  const list = [...rows.values()].filter((r) => r.selfMs > 0 || r.totalMs > 0).sort((a, b) => b.selfMs - a.selfMs || b.totalMs - a.totalMs);
  return { totalMs: Math.max(sampled, span), rows: list.slice(0, limit) };
}

/** cProfile names a builtin's file `~`; V8 gives native code no url */
function nativeUrl(url: string): boolean {
  return url === '' || url.endsWith('/~') || url === '~';
}

/** The summary as a text table, one function per row; `rows[i]` is on line `i + 3`. */
export function renderProfile(s: ProfileSummary, title: string, displayPath: (file: string) => string): string {
  const lines = [`# Profile of ${title}: ${s.totalMs.toFixed(1)} ms, ${s.rows.length} functions (Ctrl/Cmd+click a row to open it)`, `${'Self ms'.padStart(10)} ${'Total ms'.padStart(10)} ${'Calls'.padStart(7)}  Function  Location`];
  for (const r of s.rows) {
    const where = r.file ? `${displayPath(r.file)}:${r.line}` : '(native)';
    lines.push(`${r.selfMs.toFixed(2).padStart(10)} ${r.totalMs.toFixed(2).padStart(10)} ${(r.calls === undefined ? '' : String(r.calls)).padStart(7)}  ${r.name}  ${where}`);
  }
  if (s.rows.length === 0) lines.push('# no samples: the program ran too briefly for the profiler');
  return lines.join('\n') + '\n';
}
