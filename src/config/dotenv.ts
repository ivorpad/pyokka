/**
 * Minimal `.env` reader for the run child, matching what the Python extension's debugger and
 * terminal load through `python.envFile`. Values are never logged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Parse `KEY=value` lines: comments, blank lines, `export KEY=`, single/double quotes, `\n` in double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (value.startsWith('"')) {
      const m2 = /^"((?:[^"\\]|\\.)*)"?/.exec(value);
      value = (m2 ? m2[1]! : value.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/** Resolve a `python.envFile`-style setting (`${workspaceFolder}` supported) and read it, or {} when absent. */
export function readEnvFile(setting: string | undefined, workspaceRoot: string | undefined): Record<string, string> {
  let file = (setting ?? '').trim();
  if (!file) return {};
  if (file.includes('${workspaceFolder}')) {
    if (!workspaceRoot) return {};
    file = file.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
  }
  if (!path.isAbsolute(file)) {
    if (!workspaceRoot) return {};
    file = path.join(workspaceRoot, file);
  }
  try {
    if (!fs.existsSync(file)) return {};
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
