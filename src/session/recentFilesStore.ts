import * as path from 'node:path';
import { pyokkaHome, readJsonFile, writeJsonFile } from '../util/paths';

export interface RecentFile {
  id: string;
  name: string;
  /** on-disk file; absent for untitled files (then `content` is set) */
  path?: string;
  content?: string;
  projectRoot?: string;
  timestamp: number;
}

const MAX_RECENT = 30;

export class RecentFilesStore {
  private readonly file: string;
  private entries: RecentFile[] | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(file = path.join(pyokkaHome(), 'recentFiles.json')) {
    this.file = file;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  list(): RecentFile[] {
    if (!this.entries) {
      const raw = readJsonFile<unknown>(this.file, []);
      this.entries = Array.isArray(raw) ? (raw.filter((e) => e && typeof e === 'object' && typeof (e as RecentFile).id === 'string') as RecentFile[]) : [];
    }
    return [...this.entries].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Insert or refresh an entry (deduped by path, or by id for untitled files). */
  touch(entry: Omit<RecentFile, 'timestamp' | 'id'> & { id?: string }): RecentFile {
    const all = this.list();
    const existing = all.find((e) => (entry.path ? e.path === entry.path : entry.id && e.id === entry.id));
    const rec: RecentFile = {
      id: existing?.id ?? entry.id ?? `rf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: entry.name,
      path: entry.path,
      content: entry.content,
      projectRoot: entry.projectRoot,
      timestamp: Date.now(),
    };
    this.entries = [rec, ...all.filter((e) => e.id !== rec.id)].slice(0, MAX_RECENT);
    this.save();
    return rec;
  }

  remove(ids: string[]): void {
    const set = new Set(ids);
    this.entries = this.list().filter((e) => !set.has(e.id));
    this.save();
  }

  get(id: string): RecentFile | undefined {
    return this.list().find((e) => e.id === id);
  }

  private save(): void {
    try {
      writeJsonFile(this.file, this.entries ?? []);
    } catch {
      /* best effort */
    }
    for (const l of this.listeners) l();
  }
}
