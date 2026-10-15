/**
 * An agent's explanation as a bubble under a line of a Monaco editor (a view zone): the code pane's
 * narration and the Scratchpad's explainers. Monaco keeps the zone under its line as the text above
 * it changes; a new document needs `set(null)`, since a zone outlives `setValue`.
 */
import { monaco } from '../webview/monaco';

export interface Narration {
  text: string;
  line: number;
}

export class NarrationZone {
  private zone: { id: string; line: number; text: string } | null = null;

  constructor(private readonly editor: monaco.editor.ICodeEditor) {}

  /** The bubble on show (its line as placed, clamped to the document), null when none. */
  current(): Narration | null {
    return this.zone ? { text: this.zone.text, line: this.zone.line } : null;
  }

  /** Show `n` under its line (clamped to the document) and scroll to it; null removes the bubble. */
  set(n: Narration | null): void {
    if (this.zone && n && this.zone.line === n.line && this.zone.text === n.text) return;
    this.clear();
    const model = this.editor.getModel();
    if (!n || !model) return;
    const line = Math.max(1, Math.min(n.line, model.getLineCount()));
    // Monaco positions and shows/hides the zone's own node, so the bubble is a child of it
    const node = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'pkw-narration';
    node.appendChild(bubble);
    const icon = document.createElement('i');
    icon.className = 'codicon codicon-comment-discussion';
    const text = document.createElement('div');
    text.className = 'pkw-narration-text';
    text.textContent = n.text;
    bubble.append(icon, text);
    // estimate the height from the text: about 90 characters a row at the pane's usual width
    const rows = n.text.split('\n').reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / 90)), 0);
    this.editor.changeViewZones((acc) => {
      const id = acc.addZone({ afterLineNumber: line, heightInPx: rows * 19 + 22, domNode: node });
      this.zone = { id, line, text: n.text };
    });
    this.editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  }

  private clear(): void {
    const zone = this.zone;
    if (!zone) return;
    this.zone = null;
    this.editor.changeViewZones((acc) => acc.removeZone(zone.id));
  }
}
