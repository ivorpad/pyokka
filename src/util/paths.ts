import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/**
 * Where Pyokka keeps its per-user state: `$PYOKKA_HOME`, else `~/.pyokka`. A leading `~` is
 * expanded and an empty value counts as unset. The runtime resolves it with the same rule
 * (`python/pyokka_runtime/home.py`), so a CLI in a terminal finds the sessions of a window that
 * sees the same `PYOKKA_HOME`.
 */
export function pyokkaHome(env: Record<string, string | undefined> = process.env): string {
  const value = env['PYOKKA_HOME'];
  if (!value) return path.join(os.homedir(), '.pyokka');
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(expanded);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(text)) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Good enough for .code-snippets / .pyokka files: strips line and block comments outside strings. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function shortHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function existsSync(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
