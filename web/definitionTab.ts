/** The bridge's definition lookup and the tab a definition opens in; no Monaco here, so the page host can use it (web/definitions.ts). */
import type { DefinitionLocation } from '../src/shared/protocol';

export type DefinitionTarget = DefinitionLocation & { content: string };

/** Ask the bridge; [] when the name is a builtin, a library's or the standard library's, or undefined. */
export async function fetchDefinitions(file: string, content: string, offset: number): Promise<DefinitionTarget[]> {
  const response = await fetch('/api/definitions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, content, offset }) });
  if (!response.ok) throw new Error(`definition: ${response.status} ${await response.text()}`);
  return (await response.json()) as DefinitionTarget[];
}

/** The tab a definition opens in. */
export function definitionTabUrl(path: string, line: number, column: number): string {
  return new URL(`/web/source.html?${new URLSearchParams({ path, line: String(line), column: String(column) })}`, location.href).href;
}

/** Open the definition in a new tab, without a handle back to this page. */
export function openDefinitionTab(path: string, line: number, column: number): void {
  window.open(definitionTabUrl(path, line, column), '_blank', 'noopener');
}
