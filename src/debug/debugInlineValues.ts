/**
 * Inline values at a Debugger pause: `name = value` at the end of each line of the paused function,
 * the way a recording shows them. A `record: false` session recorded nothing, so the values come
 * from the paused frame: this provider only names the variables on each line, and VS Code looks
 * each one up in the frame through the adapter's `scopes` and `variables`. A name the frame does not
 * hold shows nothing, so naming too many is harmless.
 *
 * A `record: true` session is skipped: the run-all decorator already draws its values.
 */
import * as vscode from 'vscode';
import { DEBUG_TYPE } from './dapAdapter';

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'case', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'self', 'cls', 'print', 'len', 'range', 'str', 'int', 'float',
  'list', 'dict', 'set', 'tuple', 'bool', 'isinstance', 'sorted', 'enumerate', 'zip', 'min', 'max', 'sum', 'any', 'all',
]);

/** the most lines one pause annotates, so a long module-level script stays readable */
export const MAX_LINES = 200;

export interface NameAt {
  line: number;
  start: number;
  end: number;
  name: string;
}

/** `line` with strings and the comment blanked to spaces, so columns stay where they were. */
function codeOnly(line: string): string {
  return line
    .replace(/(['"])(?:\\.|(?!\1).)*\1/g, (m) => ' '.repeat(m.length))
    .replace(/#.*$/, (m) => ' '.repeat(m.length));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The `def` line of the function enclosing `stop`, or a window above `stop` when it is at module level. */
export function enclosingStart(lines: string[], stop: number): number {
  const target = indentOf(lines[stop] ?? '');
  for (let i = stop - 1; i >= 0 && target > 0; i--) {
    const text = lines[i] ?? '';
    if (!text.trim() || indentOf(text) >= target) continue;
    if (/^\s*(async\s+)?def\s/.test(text)) return i;
    if (indentOf(text) === 0) break; // inside a module-level `if`, `for` or `with`, not a function
  }
  return Math.max(0, stop - MAX_LINES + 1);
}

/** The variable names on lines `first`..`last`: identifiers that are not keywords, attributes or keyword arguments. */
export function namesOnLines(lines: string[], first: number, last: number): NameAt[] {
  const out: NameAt[] = [];
  for (let line = Math.max(0, first); line <= last && line < lines.length; line++) {
    const code = codeOnly(lines[line] ?? '');
    // on a `def` line `k=60` is a parameter, which the frame holds; elsewhere it is a call's keyword
    const isDef = /^\s*(async\s+)?def\s/.test(code);
    const seen = new Set<string>();
    for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = m[0];
      const start = m.index ?? 0;
      const before = code.slice(0, start).trimEnd();
      const after = code.slice(start + name.length).trimStart();
      if (KEYWORDS.has(name) || seen.has(name)) continue;
      if (before.endsWith('.')) continue; // an attribute: the frame has no variable by that name
      if (/^\s*(async\s+)?def\s*$|^\s*class\s*$/.test(before)) continue; // the name being defined
      if (!isDef && after.startsWith('=') && !after.startsWith('==') && /[(,]\s*$/.test(before)) continue; // f(key=value)
      seen.add(name);
      out.push({ line, start, end: start + name.length, name });
    }
  }
  return out;
}

export function registerDebugInlineValues(): vscode.Disposable {
  return vscode.languages.registerInlineValuesProvider({ language: 'python' }, {
    provideInlineValues(document, viewPort, context) {
      const session = vscode.debug.activeDebugSession;
      if (session?.type !== DEBUG_TYPE || session.configuration['record'] === true) return [];
      const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
      const stop = context.stoppedLocation.end.line;
      const first = Math.max(enclosingStart(lines, stop), viewPort.start.line);
      const last = Math.min(stop, viewPort.end.line);
      return namesOnLines(lines, first, last).map((n) => new vscode.InlineValueVariableLookup(new vscode.Range(n.line, n.start, n.line, n.end), n.name, true));
    },
  });
}
