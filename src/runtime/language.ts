/**
 * Which documents Pyokka runs: Python files, with `pyokka_runtime`. `runtimeLanguage` classifies a
 * file; `isRunnable` and `RUNNABLE_SELECTOR` are what the extension runs.
 * vscode-free so the rules can be unit tested.
 */

/**
 * The language a run's code and values are spelled in. Pyokka's runtime records Python; the
 * panel's readers also accept a run of another runtime that speaks the protocol (the browser
 * page's `--runtime "CMD ARGS"`), so they keep the second spelling.
 */
export type RuntimeLanguage = 'python' | 'javascript';

/** The document selector of the language Pyokka runs. */
export const RUNNABLE_SELECTOR = [{ language: 'python' }];

export interface DocLike {
  languageId: string;
  fileName: string;
}

export function runtimeLanguage(doc: DocLike): RuntimeLanguage | undefined {
  if (doc.languageId === 'python' || doc.fileName.endsWith('.py')) return 'python';
  return undefined;
}

/** A file Pyokka runs: a Python file. */
export function isRunnable(doc: DocLike): boolean {
  return runtimeLanguage(doc) === 'python';
}

const PYTHON_KEYWORDS = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'print', 'True', 'False', 'None']);

/** A Python word that is syntax, not a value. */
export function isKeyword(word: string): boolean {
  return PYTHON_KEYWORDS.has(word);
}
