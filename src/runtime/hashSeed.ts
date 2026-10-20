/**
 * One seed for str hashing per session. Python salts `hash()` of str and bytes per interpreter,
 * so a set of strings, and anything built by iterating one, comes out in another order in every
 * process, and on macOS every run is a fresh interpreter (runner.py, spawn mode). A full value is
 * replayed in a runner of its own, so the session pins one seed in the environment it gives its
 * runners, which the replay's runner copies (session.ts). The runtime takes the pin back out of
 * the program's environment (child.py, `unpin_hash_seed`), so the program and the processes it
 * starts see what they would without Pyokka. A seed the user set is theirs and stays.
 */
import * as crypto from 'node:crypto';

/** Marks PYTHONHASHSEED as Pyokka's own: its value, for the runtime to check before removing it. */
export const PINNED_HASHSEED = 'PYOKKA_PINNED_HASHSEED';

export function pinnedHashSeed(...envs: (Record<string, string | undefined> | undefined)[]): Record<string, string> {
  if (envs.some((env) => env?.['PYTHONHASHSEED'] !== undefined)) return {};
  // 0 turns the salt off, which no plain `python` run does; 4294967295 is the largest Python accepts
  const seed = String(crypto.randomInt(1, 4_294_967_296));
  return { PYTHONHASHSEED: seed, [PINNED_HASHSEED]: seed };
}
