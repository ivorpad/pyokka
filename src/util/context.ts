import * as vscode from 'vscode';

const cache = new Map<string, unknown>();

/** `setContext` with de-duplication so hot paths (selection changes) do not spam the host. */
export function setContext(key: string, value: unknown): void {
  const full = key.startsWith('pyokka.') ? key : `pyokka.${key}`;
  if (cache.get(full) === value) return;
  cache.set(full, value);
  void vscode.commands.executeCommand('setContext', full, value);
}

export function resetContextCache(): void {
  cache.clear();
}
