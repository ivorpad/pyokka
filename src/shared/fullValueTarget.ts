/**
 * Which value a "Rerun value" of a why tree copies: the one on its first line. The tree's root is
 * the change `var` lists at the step when the step's statement made it, and then the value after
 * that statement is the one shown; otherwise the root is the value the name had when the step ran
 * (session/provenance.ts, `root`). The panel's Why header and the bridge's `why` with `rerun` both
 * ask through here, so the two never replay different values.
 */
import type { Provenance } from './protocol';

export interface FullValueTarget {
  kind: 'change' | 'at';
  step: number;
  name: string;
  scopeId?: number;
  /** a recorded change's text, which says which snapshot it came from */
  text?: string;
}

export function whyFullTarget(tree: Pick<Provenance, 'step' | 'name' | 'root'>): FullValueTarget {
  const root = tree.root;
  if (root.step !== tree.step) return { kind: 'at', step: tree.step, name: tree.name };
  return {
    kind: 'change',
    step: tree.step,
    name: tree.name,
    ...(root.scopeId !== undefined ? { scopeId: root.scopeId } : {}),
    // only a recorded local's text is a snapshot's; a logged value or a statement that kept the same object has none to pick by
    ...(root.source === 'locals' && root.name === tree.name && root.text !== undefined ? { text: root.text } : {}),
  };
}
