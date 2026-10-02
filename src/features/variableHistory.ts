/**
 * "Pyokka: Show Variable History" and "Pyokka: Why This Value": which name, and which value, to
 * explain. An argument wins (the panel, a menu, a hover link), then the member chain under the
 * cursor of the session's document, then an input box for the history.
 */
import * as vscode from 'vscode';
import type { Session } from '../session/session';
import { sessionVariableHistory } from '../session/variableQuery';
import { stepOfEntry } from '../session/provenance';
import { expressionAtCursor } from './liveValues';

export async function pickVariableName(session: Session, arg: unknown): Promise<string | undefined> {
  const given = typeof arg === 'string' ? arg : arg && typeof arg === 'object' ? (arg as { name?: string }).name : undefined;
  let name = given?.trim();
  if (!name) {
    const editor = vscode.window.activeTextEditor;
    const found = editor && editor.document === session.document ? expressionAtCursor(editor, false) : undefined;
    name = found?.text;
  }
  if (!name) name = await vscode.window.showInputBox({ prompt: 'Variable history: a name or an attribute path', placeHolder: 'dt, self.balance, r.output_parsed.date', ignoreFocusOut: true });
  return name?.trim() || undefined;
}

/** a log context that names a variable or an attribute path (`acct.balance`), not an expression (`c.bump(5)`) */
const NAME_RE = /^[A-Za-z_][\w.]*$/;

export interface WhyTarget {
  step: number;
  /** empty: the statement at `step` itself */
  name: string;
}

/**
 * The value "Why This Value" explains. `{step, name}` (the panel) wins; `{logId}` (a hover link)
 * means the step of the entry's own statement (not the step it was stamped with, which is inside
 * the last callee) and its context when that is a name. Without an argument, the member chain
 * under the cursor at the Time Machine's step, else at the name's last recorded change.
 */
export async function pickWhyTarget(session: Session, arg: unknown): Promise<WhyTarget | undefined> {
  const a = (arg && typeof arg === 'object' ? arg : {}) as { step?: unknown; name?: unknown; logId?: unknown };
  if (typeof a.step === 'number' && Number.isInteger(a.step)) return { step: a.step, name: typeof a.name === 'string' ? a.name.trim() : '' };
  if (typeof a.logId === 'string') {
    const entry = session.state.entriesById.get(a.logId);
    if (!entry) {
      void vscode.window.showInformationMessage('Pyokka: that value is not part of the last run any more; hover it again.');
      return undefined;
    }
    return { step: session.trace ? stepOfEntry(session.trace, entry) : entry.step, name: entry.context && NAME_RE.test(entry.context) ? entry.context : '' };
  }
  const editor = vscode.window.activeTextEditor;
  const found = editor && editor.document === session.document ? expressionAtCursor(editor, false) : undefined;
  const name = found?.text.trim();
  if (!name) {
    void vscode.window.showInformationMessage('Pyokka: put the cursor on a name in the session file, or use Why on a value in the panel or a hover.');
    return undefined;
  }
  if (session.nav.active) return { step: session.nav.currentStep, name };
  const history = await sessionVariableHistory(session, name);
  const last = history?.changes[history.changes.length - 1];
  if (!last) {
    void vscode.window.showInformationMessage(history ? `Pyokka: the last run recorded no change of ${name}.` : 'Pyokka: no run yet; run the file first (save, or Re-execute).');
    return undefined;
  }
  return { step: last.step, name };
}
