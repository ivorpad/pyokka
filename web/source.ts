/**
 * The tab a Cmd/Ctrl-clicked definition opens in (web/definitions.ts): the file at `?path=`, read
 * only, at `?line=` and `?column=`. It has no connection to the run or the debugger. Cmd/Ctrl-click
 * here opens the next definition in another tab.
 */
import { applyTheme, bootMonaco, monaco, READONLY_OPTIONS } from '../webview/monaco';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
import './theme.css';
import './web.css';
import { openDefinitionTab, registerPythonDefinitions } from './definitions';

const params = new URLSearchParams(location.search);
const file = params.get('path') ?? '';
const line = Math.max(1, Number(params.get('line')) || 1);
const column = Math.max(1, Number(params.get('column')) || 1);

function fail(message: string): void {
  const el = document.getElementById('pkw-source-error')!;
  el.textContent = message;
  el.hidden = false;
}

async function main(): Promise<void> {
  const light = matchMedia('(prefers-color-scheme: light)').matches;
  document.body.classList.toggle('light', light);
  bootMonaco();
  applyTheme(light ? 'light' : 'dark');
  const response = await fetch(`/api/source?${new URLSearchParams({ path: file })}`);
  if (!response.ok) return fail(`${file}: ${response.status} ${await response.text()}`);
  const { content } = (await response.json()) as { content: string };
  const name = file.split(/[\\/]/).pop() ?? file;
  document.title = `${name}:${line} · Pyokka`;
  const label = document.getElementById('pkw-source-path')!;
  label.textContent = `${name}:${line}`;
  label.title = file;
  registerPythonDefinitions();
  const model = monaco.editor.createModel(content, 'python', monaco.Uri.file(file));
  const editor = monaco.editor.create(document.getElementById('pkw-source-editor')!, {
    ...READONLY_OPTIONS,
    model,
    lineNumbers: 'on',
    fontSize: 13,
    lineHeight: 20,
    renderLineHighlight: 'line',
    minimap: { enabled: false },
    gotoLocation: { multipleDefinitions: 'goto' },
  });
  editor.setSelection(new monaco.Range(line, column, line, model.getLineMaxColumn(line)));
  editor.revealLineInCenter(line);
  editor.focus();
  monaco.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selection) => {
      if (source !== editor || resource.scheme !== 'file' || resource.fsPath === file) return false;
      const at = selection && 'startLineNumber' in selection ? { line: selection.startLineNumber, column: selection.startColumn } : { line: selection?.lineNumber ?? 1, column: selection?.column ?? 1 };
      openDefinitionTab(resource.fsPath, at.line, at.column);
      return true;
    },
  });
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
