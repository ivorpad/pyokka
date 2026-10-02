/**
 * Scopes assembled from mid-run `trace` deltas. Each delta carries only the scopes created since
 * the previous one, and `last` of the earlier scopes is not re-sent: it is derived here from the
 * steps of every delta seen so far. The final `trace` (no `partial`) replaces all of this.
 */
import type { TraceScope } from '../shared/protocol';

export class PartialScopes {
  private readonly byId = new Map<number, TraceScope>();

  /** Merge one delta (`steps` are its quads, `offset` its first step index) and return the full table. */
  apply(scopes: TraceScope[], steps: Int32Array, offset: number): TraceScope[] {
    for (const s of scopes) this.byId.set(s.scopeId, { ...s });
    for (let i = 0; i + 1 < steps.length; i += 4) {
      const scope = this.byId.get(steps[i + 1]!);
      const step = offset + (i >> 2);
      if (scope && scope.last < step) scope.last = step;
    }
    return [...this.byId.values()].sort((a, b) => a.scopeId - b.scopeId);
  }
}
