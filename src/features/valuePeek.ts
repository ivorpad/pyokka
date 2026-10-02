/**
 * Value Peek: hover an identifier / member chain while a session runs and see its value,
 * with command links (Explore value / Show as diagram / Copy / Why / Add watch). While the Time
 * Machine navigates, the value shown is the one recorded as of the current step, and a footer
 * names the step and the run's final value when it differs.
 *
 * Where a value comes from, in order: an entry recorded at that spot (a `# ?`, Auto Log, a Show
 * Value marker, or the hidden marker an earlier hover placed); for a bare name, the run's recorded
 * variables (`recordLocals`, or a value logged under the name elsewhere), as of the current step
 * while navigating; in Automatic mode a transient run; otherwise the finished child's final module
 * state. Outside Automatic mode a hover that finds nothing places a hidden marker at the spot so
 * the next run records it, and offers to switch variable recording on and run once.
 */
import * as vscode from 'vscode';
import type { LogEvent, Range4, VariableHistory } from '../shared/protocol';
import type { SessionManager } from '../session/sessionManager';
import type { Session } from '../session/session';
import type { SessionMarker } from '../session/markers';
import { asOfFooter, entryAsOf, finalEntry } from '../session/valuesAsOf';
import { sessionVariableHistory } from '../session/variableQuery';
import { memberChainAt, truncateOneLine } from '../util/text';
import { entryText } from '../views/panelSupport';
import { localFooter, localOwner, pickLocal } from './hoverLocals';

interface CacheEntry {
  runId: string;
  promise: Promise<LogEvent | undefined>;
}

/** hidden markers hovers may leave in one session; the oldest goes when there are more */
const HOVER_MARKERS_MAX = 60;

export class ValuePeekProvider implements vscode.HoverProvider {
  private readonly cache = new Map<string, CacheEntry>();
  /** the hidden markers this provider placed, per session key, oldest first */
  private readonly placed = new Map<string, string[]>();

  constructor(private readonly manager: SessionManager) {
    manager.on('sessionStopped', (s) => this.placed.delete(s.key));
  }

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const s = this.manager.sessionForDocument(document);
    if (!s || !s.valuePeek || s.isDisposed) return undefined;
    const fileId = s.fileIdForDocument(document);
    if (fileId === undefined) return undefined;
    const lineText = document.lineAt(position.line).text;
    const span = memberChainAt(lineText, position.character);
    if (!span || /^\d/.test(span.text) || isKeyword(span.text)) return undefined;
    const range = new vscode.Range(position.line, span.start, position.line, span.end);
    const range4: Range4 = [position.line + 1, span.start, position.line + 1, span.end];

    // a value recorded for exactly this range needs no re-run; while navigating it is the one as of the current step
    const step = s.nav.active ? s.nav.currentStep : undefined;
    const { asOf, final } = this.recorded(s, fileId, range4, span.text, step);
    if (asOf) {
      const md = this.markdown(s, span.text, asOf, range4);
      const footer = asOfFooter(asOf, final, step);
      if (footer) md.appendMarkdown('\n\n' + footer);
      return new vscode.Hover(md, range);
    }
    if (final) {
      // navigating before the statement's first hit: the links keep acting on the run's final
      // entry (Explore / Copy), but its value is not the value at this step, so only the footer names it
      const md = this.header(s, span.text, final, range4);
      const footer = asOfFooter(undefined, final, step);
      if (footer) md.appendMarkdown(footer);
      return new vscode.Hover(md, range);
    }

    // a bare name (a parameter, a local): the run's recorded variables answer without a run, as of
    // the step while navigating; a fresh run would not give the value at this step anyway
    const bare = /^[A-Za-z_]\w*$/.test(span.text);
    const history = bare && (s.nav.active || !s.implicitRunsAllowed) ? await this.history(s, span.text) : undefined;
    if (token.isCancellationRequested) return undefined;
    if (history) {
      const at = step !== undefined && s.trace ? { step, scopes: new Set([s.trace.scopeId(step), 0]) } : undefined;
      const change = pickLocal(span.text, history.changes, at);
      if (change) return new vscode.Hover(this.localMarkdown(s, span.text, change, range4, step !== undefined), range);
    }

    const paused = !!s.debug.paused;
    if (!s.implicitRunsAllowed || paused) {
      // never execute the file from a hover outside Automatic mode: ask the finished run's
      // child for the expression's final value instead (names, attributes, subscripts); a paused
      // debug run answers in the paused frame, which is the value at this step
      const live = await s.evaluateLive(span.text, position.line + 1);
      if (token.isCancellationRequested) return undefined;
      if (live) {
        const md = this.markdown(s, span.text, live, range4);
        md.appendMarkdown(paused ? '\n\n*Live value in the paused frame.*' : s.nav.active ? '\n\n*Final value from the last run (not the value at this step).*' : '\n\n*Value from the last run, evaluated without re-executing.*');
        return new vscode.Hover(md, range);
      }
      return new vscode.Hover(this.pendingMarkdown(s, span.text, range4, history), range);
    }
    const key = `${s.key}|${s.state.runId}|${range4.join(',')}`;
    let entry = this.cache.get(key);
    if (!entry || entry.runId !== s.state.runId) {
      if (this.cache.size > 200) this.cache.clear();
      entry = { runId: s.state.runId, promise: s.evaluateTransient(range4, { context: span.text }) };
      this.cache.set(key, entry);
    }
    const logEv = await entry.promise;
    if (token.isCancellationRequested) return undefined;
    if (!logEv) return undefined;
    const md = this.markdown(s, span.text, logEv, range4);
    // a transient marker's first hit in a fresh run: neither this step's value nor necessarily the run's last
    if (s.nav.active) md.appendMarkdown('\n\n*Value from a fresh run (not the value at this step).*');
    return new vscode.Hover(md, range);
  }

  /**
   * The run's recorded entries for `text` at `range4` (or the same `context` text starting on its
   * line): the one standing for "now" at `step` and the run's last. Off the Time Machine (`step`
   * undefined) both are the last entry; before the statement's first hit `asOf` is undefined.
   * Entries of a hidden hover marker at the spot count too (they are never visible otherwise).
   */
  private recorded(s: Session, fileId: number, range4: Range4, text: string, step: number | undefined): { asOf: LogEvent | undefined; final: LogEvent | undefined } {
    let matching = matchingEntries(s, fileId, range4, text);
    if (!matching.length) {
      const mine = this.hoverMarkerAt(s, range4, text);
      if (mine) matching = s.state.entries.filter((e) => e.markerId === mine.id && e.kind !== 'time');
    }
    return { asOf: entryAsOf(matching, step), final: finalEntry(matching) };
  }

  private async history(s: Session, name: string): Promise<VariableHistory | undefined> {
    try {
      return await sessionVariableHistory(s, name, { limit: 100_000 });
    } catch {
      return undefined;
    }
  }

  /* ---------- hidden hover markers (On Save / On Demand) ---------- */

  private hoverMarkerAt(s: Session, range4: Range4, text: string): SessionMarker | undefined {
    const ids = this.placed.get(s.key);
    if (!ids?.length) return undefined;
    return s.markers.all().find((m) => ids.includes(m.id) && m.context === text && sameRange(m.range, range4));
  }

  /**
   * Leave a hidden value marker at the spot so the next run records the expression there, and
   * queue that run the way any marker change does (the status bar reads "run needed"). Never
   * listed or painted; a session keeps at most HOVER_MARKERS_MAX of them.
   */
  private ensureHoverMarker(s: Session, range4: Range4, text: string): void {
    if (this.hoverMarkerAt(s, range4, text)) return;
    const ids = this.placed.get(s.key) ?? [];
    while (ids.length >= HOVER_MARKERS_MAX) {
      const oldest = ids.shift();
      if (oldest) s.markers.remove(oldest);
    }
    const marker = s.markers.add({ kind: 'value', range: range4, origin: 'transient', context: text, transient: true });
    ids.push(marker.id);
    this.placed.set(s.key, ids);
    s.scheduleImplicitRun('hover');
  }

  /* ---------- markdown ---------- */

  /** A trusted hover opening with the expression in bold and the command links acting on `logEv` (plus Add watch while navigating). */
  private header(s: Session, exp: string, logEv: LogEvent, range4: Range4): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;
    // the links also name the expression, its range and the session: LiveValues.resolveHoverEntry re-evaluates once the id's run is gone
    const target = { logId: logEv.logId, exp, range: range4, sessionKey: s.key };
    const links = [
      `[$(search) Explore value](command:pyokka.exploreEntity?${args(target)} "Explore value")`,
      `[$(type-hierarchy) Show as diagram](command:pyokka.showDiagramForEntry?${args(target)} "Show as diagram")`,
      `[$(copy) Copy](command:pyokka.hoverCopy?${args(target)} "Copy value")`,
      `[$(question) Why](command:pyokka.whyValue?${args({ logId: logEv.logId })} "Why this value: the statements that produced it")`,
    ];
    if (s.nav.active) links.push(watchLink(s, exp, range4));
    md.appendMarkdown(`**${escapeMd(exp)}**&nbsp;&nbsp;${links.join(' &nbsp;|&nbsp; ')}\n\n`);
    return md;
  }

  /** The header followed by the entry's value: one line, then the full text when it spans several. */
  private markdown(s: Session, exp: string, logEv: LogEvent, range4: Range4): vscode.MarkdownString {
    const md = this.header(s, exp, logEv, range4);
    md.appendCodeblock(truncateOneLine(logEv.text, 400), 'python');
    const full = entryText(logEv);
    if (full !== logEv.text && full.includes('\n')) md.appendCodeblock(full.length > 2000 ? full.slice(0, 2000) + '\n…' : full, 'python');
    return md;
  }

  /** A value from the variable history: Copy and Why (and Add watch while navigating), the text, and where it was recorded. */
  private localMarkdown(s: Session, exp: string, change: import('../shared/protocol').VariableChange, range4: Range4, navigating: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;
    const links = [
      `[$(copy) Copy](command:pyokka.hoverCopy?${args({ text: change.text })} "Copy value")`,
      `[$(question) Why](command:pyokka.whyValue?${args({ step: change.step, name: exp })} "Why this value: the statements that produced it")`,
    ];
    if (s.nav.active) links.push(watchLink(s, exp, range4));
    md.appendMarkdown(`**${escapeMd(exp)}**&nbsp;&nbsp;${links.join(' &nbsp;|&nbsp; ')}\n\n`);
    md.appendCodeblock(truncateOneLine(change.text ?? '', 400), 'python');
    md.appendMarkdown('\n\n' + localFooter(change, navigating));
    return md;
  }

  /** Nothing recorded and no run allowed: leave a hidden marker for the next run and say what would record the value. */
  private pendingMarkdown(s: Session, exp: string, range4: Range4, history: VariableHistory | undefined): vscode.MarkdownString {
    this.ensureHoverMarker(s, range4, exp);
    const owner = history ? localOwner(exp, history.changes) : undefined;
    const what = owner ? `a local of \`${owner}\`, not recorded by the last run` : 'nothing in the last run recorded it'; // a code span renders escapes literally
    const mode = s.runMode === 'onSave' ? 'on save' : 'on demand';
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**${escapeMd(exp)}** · ${what}. It is recorded on the next run: [$(play) Re-execute](command:pyokka.reexecute "Run the file now") (run mode *${mode}*: hovering never executes the file).`);
    if (!s.recordLocals) {
      md.appendMarkdown(` [$(symbol-variable) Record variables and re-run](command:pyokka.recordVariablesAndRerun?${args({ sessionKey: s.key })} "Turn on Record Variable Changes for this session and run once") shows every local at every step from then on.`);
    }
    return md;
  }
}

/** The visible entries of the current run for the expression at `range4` in `fileId`: the same range, or the same text on the same line. */
function matchingEntries(s: Session, fileId: number, range4: Range4, text: string): LogEvent[] {
  const matching: LogEvent[] = [];
  for (const e of s.state.entries) {
    if (!s.isEntryVisible(e) || e.kind === 'time') continue;
    const loc = s.locate(e.rid);
    if (!loc || loc.fileId !== fileId) continue;
    const r = loc.range;
    if (r[0] !== range4[0] || r[1] !== range4[1] || r[2] !== range4[2] || r[3] !== range4[3]) {
      if (!(e.context === text && r[0] === range4[0])) continue;
    }
    matching.push(e);
  }
  return matching;
}

/**
 * The entry the hover would show for the expression at `range4`: while navigating, the latest at
 * or before the current step (none before the statement's first hit), otherwise the run's last.
 * The hover's links reuse it instead of evaluating (LiveValues.resolveHoverEntry).
 */
export function existingValue(s: Session, fileId: number, range4: Range4, text: string): LogEvent | undefined {
  const step = s.nav.active ? s.nav.currentStep : undefined;
  return entryAsOf(matchingEntries(s, fileId, range4, text), step);
}

function watchLink(s: Session, exp: string, range4: Range4): string {
  return `[$(eye) Add watch](command:pyokka.addWatchExpression?${args({ exp, range: range4, sessionKey: s.key })} "Add watch expression")`;
}

function args(o: unknown): string {
  return encodeURIComponent(JSON.stringify(o));
}

function sameRange(a: Range4, b: Range4): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

const KEYWORDS = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'print', 'True', 'False', 'None']);

function isKeyword(text: string): boolean {
  return KEYWORDS.has(text);
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
}
