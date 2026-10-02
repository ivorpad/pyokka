/**
 * Hovering a name on a Code Story row shows the value the editor would show for it
 * (docs/design/code-story.md, V3): the row maps back to its source file and line, and Value Peek
 * answers on the real document, so the hover is the same markdown, links and footer.
 *
 * Value Peek reads the step from the session (the Time Machine's current step), so a row of an
 * earlier or later pass gets the value as of the current step, which its own "as of step N"
 * footer names. A note says which step the row belongs to when the two differ.
 */
import * as vscode from 'vscode';
import type { CodeStory } from './codeStory';
import type { ValuePeekProvider } from './valuePeek';

export class StoryHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly story: CodeStory,
    private readonly peek: ValuePeekProvider,
  ) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const row = this.story.resolve(document, position.line);
    if (!row) return undefined;
    const uri = row.session.uriForFileId(row.fileId);
    if (!uri) return undefined;
    const source = await vscode.workspace.openTextDocument(uri);
    if (token.isCancellationRequested || row.line < 1 || row.line > source.lineCount) return undefined;

    // a row is `<line number right-aligned>  <source line>`: the source text starts at `prefix`
    const text = source.lineAt(row.line - 1).text.trimEnd();
    const prefix = text ? document.lineAt(position.line).text.lastIndexOf(text) : -1;
    if (prefix < 0 || position.character < prefix) return undefined;

    const hover = await this.peek.provideHover(source, new vscode.Position(row.line - 1, position.character - prefix), token);
    if (!hover || token.isCancellationRequested) return undefined;
    const contents = [...hover.contents];
    const current = row.session.nav.active ? row.session.nav.currentStep : undefined;
    if (row.step !== undefined && current !== undefined && row.step !== current) {
      contents.push(new vscode.MarkdownString(`*This row ran at step ${row.step}; the value above is the one as of the current step.*`));
    }
    // the hover's range is in the source document: shift it back onto the story row
    const r = hover.range;
    return new vscode.Hover(contents, r ? new vscode.Range(position.line, r.start.character + prefix, position.line, r.end.character + prefix) : undefined);
  }
}
