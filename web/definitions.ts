/**
 * Cmd/Ctrl-click a name in the code pane: the bridge asks the runtime where it is defined (`ast`
 * only, the project's own files; docs/WEB.md) and the target opens in a separate read-only tab
 * (web/source.html), so the page's run, pause and cursor stay as they were. A definition in the
 * same file moves the cursor there instead.
 */
import { monaco } from '../webview/monaco';
import { fetchDefinitions, type DefinitionTarget } from './definitionTab';

export { definitionTabUrl, fetchDefinitions, openDefinitionTab, type DefinitionTarget } from './definitionTab';

let registered = false;

/** Monaco's Cmd/Ctrl-click (and F12) for python models backed by a file; the targets get a model so the peek can show them. */
export function registerPythonDefinitions(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerDefinitionProvider('python', {
    async provideDefinition(model, position, token) {
      if (model.uri.scheme !== 'file') return null;
      const version = model.getVersionId();
      let targets: DefinitionTarget[];
      try {
        targets = await fetchDefinitions(model.uri.fsPath, model.getValue(), model.getOffsetAt(position));
      } catch {
        return null;
      }
      if (token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId()) return null;
      return targets.map((t) => {
        const uri = monaco.Uri.file(t.path);
        if (!monaco.editor.getModel(uri)) monaco.editor.createModel(t.content, 'python', uri);
        return { uri, range: new monaco.Range(t.line, t.column, t.line, t.column) };
      });
    },
  });
}
