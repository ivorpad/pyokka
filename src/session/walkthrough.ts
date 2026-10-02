/**
 * The walkthrough over a live session's state: what happened, in order, one moment per line
 * (docs/PROTOCOL.md, "Walkthrough"). Pure: the same builder as
 * `python/pyokka_runtime/agent/walkthrough.py` over the trace, file table, log entries, locals and
 * errors; `test/unit/walkthrough.test.ts` checks both against one fixture run.
 */
import { MomentBuilder } from './moments';
import { WALKTHROUGH_CAP, type Moment, type MomentKind, type Walkthrough, type WalkthroughInputs, type WalkthroughOptions } from './walkthroughShared';

export * from './walkthroughShared';
export { decisionText } from './moments';

/* ---------- windows and the cap ---------- */

function collapseBy(moments: Moment[], kind: MomentKind, keyOf: (m: Moment) => string | undefined): Moment[] {
  const firsts = new Map<string, Moment>();
  const out: Moment[] = [];
  for (const m of moments) {
    const key = m.kind === kind ? keyOf(m) : undefined;
    if (key === undefined) {
      out.push(m);
      continue;
    }
    const first = firsts.get(key);
    if (first) {
      first.more = (first.more ?? 0) + 1;
      continue;
    }
    firsts.set(key, m);
    out.push(m);
  }
  return out;
}

export function buildWalkthrough(inputs: WalkthroughInputs, opts: WalkthroughOptions = {}): Walkthrough {
  const builder = new MomentBuilder(inputs, !!opts.all);
  let moments = builder.build() as (Moment & { key?: string })[];
  const total = moments.length;
  const gloss = inputs.gloss ?? {};
  for (const m of moments) m.gloss = typeof gloss[m.id] === 'string' && gloss[m.id] ? gloss[m.id]! : null;
  const windowed = opts.fileId !== undefined || opts.scope !== undefined || opts.from !== undefined || opts.to !== undefined;
  if (opts.fileId !== undefined) moments = moments.filter((m) => m.location.fileId === opts.fileId);
  if (opts.scope !== undefined) {
    const scope = opts.scope;
    const ranges = inputs.trace.scopes.filter((s) => s.name === scope || builder.scopeQualname(s.scopeId).endsWith(scope)).map((s) => [s.first, s.last] as const);
    moments = moments.filter((m) => ranges.some(([a, b]) => a <= m.step && m.step <= b) || ((m.kind === 'call' || m.kind === 'tool') && (m.callee?.function ?? '').endsWith(scope)));
  }
  if (opts.from !== undefined) moments = moments.filter((m) => m.step >= opts.from!);
  if (opts.to !== undefined) moments = moments.filter((m) => m.step <= opts.to!);
  const cap = opts.cap ?? WALKTHROUGH_CAP;
  let capped = false;
  let truncated = false;
  if (!windowed && moments.length > cap) {
    capped = true;
    const before = moments;
    moments = collapseBy(moments, 'call', (m) => (m as { key?: string }).key);
    const kept = new Set(moments);
    const removed = before.filter((m) => !kept.has(m));
    const ranges = removed.filter((m) => m.entryStep !== undefined).map((m) => [m.entryStep!, m.endStep!] as const);
    if (ranges.length) moments = moments.filter((m) => !ranges.some(([a, b]) => a <= m.step && m.step <= b));
    if (moments.length > cap) moments = collapseBy(moments, 'value', (m) => `${m.location.fileId}:${m.location.line}:${m.text.split(' = ')[0]}`);
    if (moments.length > cap) {
      moments = moments.slice(0, cap);
      truncated = true;
    }
  }
  for (const m of moments) delete m.key;
  return {
    count: inputs.trace.count,
    total,
    shown: moments.length,
    capped,
    truncated,
    file: inputs.mainFile || null,
    exitCode: inputs.finished?.exitCode ?? null,
    stale: !!inputs.stale,
    staleFiles: inputs.staleFiles ?? [],
    moments,
  };
}

/** One line per moment, values indented (the CLI's text form; used by Code Story). */
export function renderWalkthroughLines(w: Walkthrough, opts: { limit?: number; values?: boolean } = {}): string[] {
  const limit = opts.limit ?? 100;
  const one = (text: string): string => {
    const indent = text.length - text.trimStart().length;
    const body = text.trimStart().replace(/\s*\n\s*/g, ' ');
    const max = Math.max(10, limit - indent);
    return ' '.repeat(indent) + (body.length <= max ? body : body.slice(0, max - 1) + '…');
  };
  const out: string[] = [];
  for (const m of w.moments) {
    out.push(one(`#${m.step}  ${m.text}`));
    if (m.gloss) out.push(one(`      ${m.gloss}`));
    if (opts.values !== false) for (const v of m.values.filter((v) => v.role !== 'value').slice(0, 8)) out.push(one(`      ${v.role} ${v.name} = ${v.text}`));
    if (m.more) out.push(`      ≡ ${m.more} more ${m.kind === 'call' || m.kind === 'tool' ? 'calls' : 'values'} like this`);
  }
  if (w.truncated) out.push(`… ${w.total - w.shown} more moments`);
  return out;
}
