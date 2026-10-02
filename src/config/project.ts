/**
 * "Is this file part of a project?" A project file defaults to Run on Save: its code is likely
 * to have side effects, while a scratch file wants live values as you type.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PROJECT_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock'];

/** True when any of `dirs` contains a project marker file. */
export function looksLikeProject(dirs: (string | undefined)[]): boolean {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const m of PROJECT_MARKERS) {
      try {
        if (fs.existsSync(path.join(dir, m))) return true;
      } catch {
        /* unreadable dir: not a project */
      }
    }
  }
  return false;
}
