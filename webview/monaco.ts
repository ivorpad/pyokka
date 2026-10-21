/** Monaco bootstrap: worker wiring, the python and javascript languages, transparent themes. */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
// JS/TS sessions: values and code previews in the panel are coloured as JavaScript
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import type { Theme } from './model';

export { monaco };

let booted = false;
let workerSource: Promise<string> | undefined;

export function bootMonaco(): void {
  if (booted) return;
  booted = true;
  const workerUri = window.__pyokka?.workerUri;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => {
      if (!workerUri) {
        // no worker available: fall back to a same-thread stub so the editor still renders
        return new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' })));
      }
      // the bundled worker has no imports: start its text from a same-origin blob. A blob that imports the
      // resource URL fails in a VS Code webview, and without a worker the diff editor computes no diff.
      workerSource ??= fetch(workerUri).then((r) => (r.ok ? r.text() : ''), () => '');
      return workerSource.then((src) => new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' }));
    },
  };

  const transparent = '#00000000';
  const shared = {
    'editor.background': transparent,
    'editorGutter.background': transparent,
    'minimap.background': transparent,
    'editorStickyScroll.background': '#00000000',
  };
  monaco.editor.defineTheme('pyokka-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { ...shared, 'editorStickyScroll.background': '#1f1f1f', 'editorStickyScroll.shadow': '#000000' },
  });
  monaco.editor.defineTheme('pyokka-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { ...shared, 'editorStickyScroll.background': '#f8f8f8' },
  });
  monaco.editor.defineTheme('pyokka-hc', {
    base: 'hc-black',
    inherit: true,
    rules: [],
    colors: { ...shared, 'editorStickyScroll.background': '#000000' },
  });
}

export function monacoTheme(theme: Theme): string {
  return theme === 'light' ? 'pyokka-light' : theme === 'hc' ? 'pyokka-hc' : 'pyokka-dark';
}

export function applyTheme(theme: Theme): void {
  monaco.editor.setTheme(monacoTheme(theme));
}

export const READONLY_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'none',
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  lineDecorationsWidth: 8,
  lineNumbersMinChars: 3,
  glyphMargin: false,
  wordWrap: 'off',
  contextmenu: true,
  fontFamily: 'var(--vscode-editor-font-family)',
  fontSize: 12,
  lineHeight: 18,
  padding: { top: 4, bottom: 4 },
  scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  guides: { indentation: true, bracketPairs: false },
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  renderWhitespace: 'none',
  matchBrackets: 'never',
  links: false,
  quickSuggestions: false,
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
  fixedOverflowWidgets: true,
};
