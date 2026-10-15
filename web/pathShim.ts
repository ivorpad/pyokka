/**
 * `node:path` for the browser bundle, POSIX only: the few calls the walkthrough and exceptions
 * builders (src/session/walkthroughShared.ts, moments.ts) make on the runtime's absolute paths.
 * esbuild.mjs points `node:path` here for the page.
 */
export const sep = '/';

function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return '/' + out.join('/');
}

export function resolve(...paths: string[]): string {
  let parts: string[] = [];
  for (const p of paths) {
    if (p.startsWith('/')) parts = [];
    parts = parts.concat(p.split('/'));
  }
  return normalize(parts);
}

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? (trimmed.startsWith('/') ? '/' : '.') : trimmed.slice(0, i);
}

export default { sep, resolve, basename, dirname };
