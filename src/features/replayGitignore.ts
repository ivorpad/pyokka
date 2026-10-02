/**
 * After the first HTTP recording in a workspace (`run.finished` with `http.mode === 'record'`),
 * offer once per workspace root to add `.pyokka/replay/` to its `.gitignore`: the recording holds
 * response bodies and is rewritten by every record run.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunFinishedEvent } from '../shared/protocol';
import type { Session } from '../session/session';
import type { SessionManager } from '../session/sessionManager';
import { log } from '../util/log';

const ASKED_KEY = 'pyokka.replayGitignoreAsked';
const REPLAY_DIR = '.pyokka/replay/';
/** where the runtime records when `<root>/.pyokka` is the Quokka-style config file */
const REPLAY_DIR_ALT = '.pyokka-replay/';

/** lines that ignore the replay directory, after trimming and dropping a leading slash or "any directory" glob */
const COVERING = new Set(['.pyokka', '.pyokka/', '.pyokka/replay', '.pyokka/replay/', '.pyokka-replay', '.pyokka-replay/']);

/** Does this `.gitignore` text already keep the replay directory (either location) out of git? */
export function gitignoreCoversReplay(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const line = trimmed.replace(/^(\/|\*\*\/)/, '');
    // `.pyokka/**`, `.pyokka/*`, `.pyokka/replay/**`: the contents are ignored, and git tracks nothing else
    if (COVERING.has(line) || /^\.pyokka(\/replay|-replay)?\/\*\*?$/.test(line)) return true;
  }
  return false;
}

/** `text` plus `line` on a line of its own; the existing text is kept and ends in exactly one newline first. */
export function appendGitignoreLine(text: string, line: string): string {
  const body = text.replace(/(\r?\n)+$/, '');
  return `${body ? `${body}\n` : ''}${line}\n`;
}

/** Watch every session's `runFinished` for a recording; the disposable stops watching. */
export function offerReplayGitignore(manager: SessionManager, context: vscode.ExtensionContext): vscode.Disposable {
  const handlers = new Map<Session, (ev: RunFinishedEvent) => void>();
  const bind = (s: Session): void => {
    if (handlers.has(s)) return;
    const handler = (ev: RunFinishedEvent): void => {
      if (ev.http?.mode !== 'record' || ev.http.recorded <= 0 || !ev.http.file) return;
      void offer(s.workspaceRoot, ev.http.file, context).catch((err) => log.error('replay .gitignore offer failed', err));
    };
    handlers.set(s, handler);
    s.on('runFinished', handler);
  };
  const unbind = (s: Session): void => {
    const h = handlers.get(s);
    if (h) s.off('runFinished', h);
    handlers.delete(s);
  };
  manager.on('sessionStarted', bind);
  manager.on('sessionStopped', unbind);
  for (const s of manager.all()) bind(s);
  return new vscode.Disposable(() => {
    manager.off('sessionStarted', bind);
    manager.off('sessionStopped', unbind);
    for (const s of [...handlers.keys()]) unbind(s);
  });
}

async function offer(root: string, recording: string, context: vscode.ExtensionContext): Promise<void> {
  if (!root || !fs.existsSync(path.join(root, '.git'))) return;
  const gitignore = path.join(root, '.gitignore');
  if (gitignoreCoversReplay(readText(gitignore))) return;
  const asked = context.workspaceState.get<string[]>(ASKED_KEY, []);
  if (asked.includes(root)) return;
  // remembered before asking: a second session finishing in the same root must not ask again
  await context.workspaceState.update(ASKED_KEY, [...asked, root]);
  const alt = path.basename(path.dirname(recording)) === path.basename(REPLAY_DIR_ALT);
  const pick = await vscode.window.showInformationMessage(`Pyokka recorded HTTP responses to ${alt ? REPLAY_DIR_ALT : REPLAY_DIR}. Add it to .gitignore?`, 'Add', 'Not now');
  if (pick !== 'Add') return;
  let text = readText(gitignore);
  if (gitignoreCoversReplay(text)) return; // edited by hand meanwhile
  for (const line of alt ? [REPLAY_DIR, REPLAY_DIR_ALT] : [REPLAY_DIR]) text = appendGitignoreLine(text, line);
  fs.writeFileSync(gitignore, text, 'utf8');
  log.info(`added ${alt ? REPLAY_DIR_ALT : REPLAY_DIR} to ${gitignore}`);
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
