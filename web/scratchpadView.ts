/** The Scratchpad pane's markup, and how it shows a run: values beside their lines, the result, the sandbox. */
import { monaco } from '../webview/monaco';
import type { ScratchResult, ScratchSandbox } from './scratchpadProtocol';

export const SCRATCH_MARKUP = `<header><span class="pkw-scratch-name">Scratchpad</span><label title="Run after each edit"><input type="checkbox" class="pkw-scratch-auto" checked> Auto run</label>
      <button type="button" class="pkw-text-btn pkw-scratch-copy" title="Copy the function at the cursor, with the pause's values">Copy function</button>
      <button type="button" class="pkw-btn pkw-scratch-close" aria-label="Close scratchpad"><i class="codicon codicon-close"></i></button></header>
      <div class="pkw-scratch-library"><select class="pkw-scratch-list" aria-label="Saved scratchpads"></select>
      <button type="button" class="pkw-btn pkw-scratch-new" aria-label="New scratchpad" title="New scratchpad"><i class="codicon codicon-new-file"></i></button>
      <input class="pkw-scratch-title" aria-label="Scratchpad name" placeholder="Scratchpad name">
      <button type="button" class="pkw-btn pkw-scratch-save" aria-label="Save a version" title="Save a version"><i class="codicon codicon-save"></i></button>
      <select class="pkw-scratch-history" aria-label="Saved versions"></select></div>
      <div class="pkw-scratch-file"></div><div class="pkw-scratch-sandbox" role="note"></div>
      <div class="pkw-scratch-editor" aria-label="Python scratchpad"></div>
      <details open><summary>Inputs · copied at the pause</summary><div class="pkw-scratch-inputs pkw-scratch-small"></div><p class="pkw-scratch-unavailable"></p></details>
      <details><summary>Mocks · {target: value} for unittest.mock</summary><div class="pkw-scratch-mocks pkw-scratch-small"></div></details>
      <div class="pkw-scratch-results" aria-live="polite"></div>
      <footer><button type="button" class="pkw-text-btn pkw-scratch-run">Run</button><button type="button" class="pkw-text-btn pkw-scratch-restore">Restore copy</button><span class="pkw-scratch-state" role="status"></span></footer>`;

export function renderSandbox(pane: HTMLElement, s: ScratchSandbox | null, unavailable: Record<string, string>): void {
  const node = pane.querySelector<HTMLElement>('.pkw-scratch-sandbox')!;
  node.textContent = s ? (s.network === 'denied' ? `Separate python -I · network denied (${s.how})` : `Separate python -I · network NOT sandboxed: ${s.how}`) : 'Separate python -I · network sandbox reported after the first run';
  node.classList.toggle('open', s?.network === 'open');
  const missing = Object.entries(unavailable);
  const box = pane.querySelector<HTMLElement>('.pkw-scratch-unavailable')!;
  box.textContent = missing.length ? `Not copied (a fresh process cannot rebuild them): ${missing.map(([n, why]) => `${n}: ${why}`).join(' · ')}. Using one raises UnavailableValue; give it a value above, or mock what the code calls on it.` : '';
  box.hidden = !missing.length;
}

export function renderResult(pane: HTMLElement, r: ScratchResult | null, editor: monaco.editor.IStandaloneCodeEditor, shadows: monaco.editor.IEditorDecorationsCollection): void {
  const box = pane.querySelector<HTMLElement>('.pkw-scratch-results')!;
  box.replaceChildren();
  const model = editor.getModel();
  if (!r || !model) return shadows.clear();
  const last = new Map<number, { name: string; value: string }[]>();
  for (const v of r.values) {
    if (v.line < 1 || v.line > model.getLineCount()) continue;
    const row = (last.get(v.line) ?? []).filter((x) => x.name !== v.name);
    last.set(v.line, [...row, { name: v.name, value: v.value }]);
  }
  shadows.set([...last].map(([line, vs]) => ({
    // the whole line, as the code pane does: Monaco drops the injected text of an empty range at a line's end
    range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
    options: { after: { content: `  ${vs.map((v) => `${v.name} = ${v.value}`).join(', ').slice(0, 120)}`, inlineClassName: 'pkw-inline-value' } },
  })));
  const add = (cls: string, label: string, text: string) => {
    const row = document.createElement('div');
    row.className = `pkw-scratch-row ${cls}`;
    const b = document.createElement('b');
    b.textContent = label;
    const pre = document.createElement('pre');
    pre.textContent = text;
    row.append(b, pre);
    box.append(row);
  };
  if (r.result !== undefined) add('pkw-scratch-result', 'result', r.result);
  if (r.error) add('pkw-scratch-error', r.error.stage === 'code' ? 'error' : `error in ${r.error.stage}`, `${r.error.type}: ${r.error.message}${r.error.line ? `\nat line ${r.error.line}` : ''}`);
  if (r.missing?.length) add('pkw-scratch-error', 'unavailable', `used: ${r.missing.join(', ')}`);
  if (r.mocks?.length) add('', 'mocks', r.mocks.map((m) => `${m.target}: called ${m.calls}×`).join('\n'));
  const latest = [...new Map(r.values.map((v) => [v.name, v])).values()].filter((v) => v.name !== 'result');
  if (latest.length) add('', 'values', latest.map((v) => `${v.name} = ${v.value}`).join('\n'));
  if (r.output) add('', 'output', r.output);
}
