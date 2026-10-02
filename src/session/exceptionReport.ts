/**
 * The exceptions report over a run's `error` events (docs/PROTOCOL.md, "Exceptions report"): one row
 * per (kind, error type, raise site, handler), uncaught first, with how often each was raised and
 * whether the handler was broad. Pure: the same rules as `python/pyokka_runtime/agent/exceptions.py`;
 * `test/unit/fixtures/exceptions.json` pins both over the fixture run `exceptions-run.json`.
 */
import type { ErrorEvent } from '../shared/protocol';
import { EXCEPTION_MESSAGE_MAX, type ExceptionHandlerSite, type ExceptionReport, type ExceptionReportInputs, type ExceptionRow, type ExceptionRowKind, type ExceptionSite } from './exceptionReportTypes';
import { cut } from './walkthroughShared';

export type { ExceptionHandlerSite, ExceptionReport, ExceptionReportInputs, ExceptionRow, ExceptionRowKind, ExceptionSite } from './exceptionReportTypes';
export { EXCEPTION_MESSAGE_MAX } from './exceptionReportTypes';

/** The events of one row while folding: the runtime aggregates already, older runs may not have. */
interface Group {
  kind: ExceptionRowKind;
  /** the event with the smallest step: its message, stack and handler describe the row */
  first: ErrorEvent;
  count: number;
  step: number;
  lastStep: number;
}

const KIND_ORDER: Record<ExceptionRowKind, number> = { uncaught: 0, caught: 1 };

export function buildExceptionReport(inputs: ExceptionReportInputs): ExceptionReport {
  const groups = new Map<string, Group>();
  for (const ev of inputs.errors) {
    const kind: ExceptionRowKind = ev.handled ? 'caught' : 'uncaught';
    const handler = kind === 'caught' && ev.handledAt ? ev.handledAt.rid : '';
    const key = `${kind}\0${ev.errorType}\0${ev.rid}\0${handler}`;
    const count = ev.count ?? 1;
    const lastStep = ev.lastStep ?? ev.step;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { kind, first: ev, count, step: ev.step, lastStep });
      continue;
    }
    g.count += count;
    g.lastStep = Math.max(g.lastStep, lastStep);
    if (ev.step < g.step) {
      g.step = ev.step;
      g.first = ev;
    }
  }
  const rows = [...groups.values()]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.step - b.step || (a.first.errorType < b.first.errorType ? -1 : a.first.errorType > b.first.errorType ? 1 : 0))
    .map((g, n): ExceptionRow => {
      const ev = g.first;
      const h = g.kind === 'caught' ? ev.handledAt : undefined;
      const handledAt: ExceptionHandlerSite | null = h ? { file: inputs.files.get(h.fileId)?.path ?? null, line: h.line, function: h.function, fileId: h.fileId, rid: h.rid, broad: !!h.broad } : null;
      return { id: `x${n}`, kind: g.kind, errorType: ev.errorType, message: cut(ev.message, EXCEPTION_MESSAGE_MAX), count: g.count, step: g.step, lastStep: g.lastStep, raisedAt: raiseSite(inputs, ev), handledAt };
    });
  return {
    count: inputs.trace.count,
    file: inputs.mainFile || null,
    exitCode: inputs.finished?.exitCode ?? null,
    stale: !!inputs.stale,
    staleFiles: inputs.staleFiles ?? [],
    total: rows.length,
    raises: rows.reduce((n, r) => n + r.count, 0),
    uncaught: rows.filter((r) => r.kind === 'uncaught').length,
    caught: rows.filter((r) => r.kind === 'caught').length,
    broad: rows.filter((r) => !!r.handledAt?.broad).length,
    rows,
  };
}

/** Where the event raised: its statement's first line, the frame of that statement (else the innermost, else the module). */
function raiseSite(inputs: ExceptionReportInputs, ev: ErrorEvent): ExceptionSite {
  const loc = inputs.files.locate(ev.rid);
  const frame = ev.stack.find((f) => f.rid === ev.rid) ?? ev.stack[0];
  return { file: inputs.files.get(ev.fileId)?.path ?? null, line: loc?.range[0] ?? 0, function: frame?.function ?? '<module>', fileId: ev.fileId, rid: ev.rid };
}

/* ---------- text form ---------- */

const LINE_MAX = 100;

function fit(text: string): string {
  const s = text.replace(/\s*\n\s*/g, ' ');
  return s.length <= LINE_MAX ? s : s.slice(0, LINE_MAX - 1) + '…';
}

/** The summary line: `8 exceptions over 412 steps: 1 uncaught, 7 caught (10 raises), 2 by a broad handler`. */
export function exceptionSummary(report: ExceptionReport): string {
  if (report.total === 0) return `no exceptions over ${report.count} steps`;
  const caughtRaises = report.rows.filter((r) => r.kind === 'caught').reduce((n, r) => n + r.count, 0);
  let s = `${report.total} exception${report.total === 1 ? '' : 's'} over ${report.count} steps: ${report.uncaught} uncaught, ${report.caught} caught`;
  if (caughtRaises !== report.caught) s += ` (${caughtRaises} raises)`;
  if (report.broad) s += `, ${report.broad} by a broad handler`;
  return s;
}

/**
 * The CLI's text form (docs/PROTOCOL.md): the summary, then two lines per row, `#step  kind [×count]
 * errorType: message` and where it was raised and caught; ≤ 100 chars each. `displayPath` names a
 * site's file (the host passes the session's display path; the default is the path itself).
 */
export function renderExceptionLines(report: ExceptionReport, displayPath: (site: ExceptionSite) => string = (s) => s.file ?? '<unknown>'): string[] {
  const at = (site: ExceptionSite): string => `${displayPath(site)}:${site.line} ${site.function}`;
  const out = [exceptionSummary(report)];
  for (const r of report.rows) {
    const times = r.count > 1 ? ` ×${r.count}` : '';
    out.push(fit(`#${r.step}  ${r.kind}${times} ${r.errorType}${r.message ? ': ' + r.message : ''}`));
    let where = `      raised ${at(r.raisedAt)}`;
    if (r.kind === 'caught') where += r.handledAt ? ` · caught ${at(r.handledAt)}${r.handledAt.broad ? ' broad handler' : ''}` : ' · caught outside stepped code';
    if (r.lastStep !== r.step) where += ` · last #${r.lastStep}`;
    out.push(fit(where));
  }
  return out;
}
