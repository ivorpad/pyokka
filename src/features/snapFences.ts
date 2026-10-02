/** Pure snap-fence discovery, shared by the Snaps feature and unit tests. */
export interface SnapFence {
  /** 0-based lines */
  openLine: number;
  closeLine: number;
}

const OPEN_RE = /^\s*(?:[rRbBuUfF]{0,2})"""\{\{\s*$/;
const CLOSE_RE = /^\s*\}\}"""\s*$/;
export const OUTPUT_PREFIX = '#» ';

export function findSnaps(text: string): SnapFence[] {
  const lines = text.split(/\r?\n/);
  const out: SnapFence[] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (open < 0 && OPEN_RE.test(l)) open = i;
    else if (open >= 0 && CLOSE_RE.test(l)) {
      out.push({ openLine: open, closeLine: i });
      open = -1;
    }
  }
  return out;
}

export function fenceAt(fences: SnapFence[], line: number): SnapFence | undefined {
  return fences.find((f) => line >= f.openLine && line <= f.closeLine);
}
