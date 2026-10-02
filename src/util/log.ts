import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function outputChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Pyokka');
  return channel;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info(msg: string): void {
    outputChannel().appendLine(`[${stamp()}] ${msg}`);
  },
  warn(msg: string): void {
    outputChannel().appendLine(`[${stamp()}] WARN ${msg}`);
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err === undefined ? '' : String(err);
    outputChannel().appendLine(`[${stamp()}] ERROR ${msg}${detail ? `\n${detail}` : ''}`);
  },
  show(): void {
    outputChannel().show(true);
  },
};
