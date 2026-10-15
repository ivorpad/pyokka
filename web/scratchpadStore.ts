import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScratchEntry, ScratchSummary } from './scratchpadProtocol';

const ID = /^[a-zA-Z0-9-]{1,80}$/;
export const CHANGED_ELSEWHERE = 'Scratchpad changed in another page. Load its latest version before saving.';

/**
 * Saved scratchpads: `<dir>/<id>/<version>.json`, append-only. A save names the version it builds
 * on and is refused when another one got there first; an existing version file is never replaced.
 * The store runs no code.
 */
export class ScratchpadStore {
  constructor(private readonly directory: string) {
    if (!directory) throw new Error('saving scratchpads needs a state directory (the bridge runs with stateDir empty)');
  }

  private folder(id: string): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid scratchpad id');
    return path.join(this.directory, id);
  }

  private versions(id: string): number[] {
    const dir = this.folder(id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).map((n) => Number(n.slice(0, -5))).sort((a, b) => a - b);
  }

  get(id: string, version?: number): ScratchEntry {
    const versions = this.versions(id);
    const selected = version ?? versions.at(-1);
    if (!selected || !versions.includes(selected)) throw new Error(`Scratchpad ${id} has no version ${version ?? '(none saved)'}`);
    return JSON.parse(fs.readFileSync(path.join(this.folder(id), `${selected}.json`), 'utf8')) as ScratchEntry;
  }

  history(id: string): ScratchSummary[] {
    return this.versions(id).map((v) => summary(this.get(id, v))).reverse();
  }

  list(): ScratchSummary[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID.test(d.name))
      .flatMap((d) => (this.versions(d.name).length ? [summary(this.get(d.name))] : []))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(input: Omit<ScratchEntry, 'createdAt' | 'updatedAt' | 'version'> & { expectedVersion: number }): ScratchEntry {
    const dir = this.folder(input.id);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || !input.state || typeof input.state.code !== 'string' || input.state.code.length > 100_000 || !input.baseline || typeof input.baseline.code !== 'string') throw new Error('Invalid saved scratchpad');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let temporary: string | undefined;
    try {
      const version = this.versions(input.id).at(-1) ?? 0;
      if (input.expectedVersion !== version) throw new Error(CHANGED_ELSEWHERE);
      const now = new Date().toISOString();
      const { expectedVersion: _, ...snapshot } = input;
      const entry: ScratchEntry = { ...snapshot, version: version + 1, createdAt: version ? this.get(input.id).createdAt : now, updatedAt: now };
      temporary = path.join(dir, `.${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
      // a hard link publishes the complete file and fails when the version exists: two saves racing
      // on one version leave the first, and a crash leaves only an ignored temporary file
      try {
        fs.linkSync(temporary, path.join(dir, `${entry.version}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(CHANGED_ELSEWHERE);
        throw error;
      }
      return entry;
    } finally {
      if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

function summary(entry: ScratchEntry): ScratchSummary {
  const { id, title, version, createdAt, updatedAt, reason } = entry;
  return { id, title, version, createdAt, updatedAt, reason, file: entry.state.file, status: entry.state.status, error: entry.state.error };
}
