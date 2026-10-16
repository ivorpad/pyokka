/**
 * Pure helpers over value nodes (docs/PROTOCOL.md, "Value node") that the host and the panel both
 * need: splicing an `expand` reply into the tree it was loaded for. The panel used to own this in
 * webview/format.ts; the Debugger view's Frame section loads members on the host side (the cached
 * locals keep them across state pushes), so it lives here. No vscode, no DOM.
 */
import type { ValueNode, ValueProp } from './protocol';

/** the loaded node replaces ours entirely; only the prop identity (name / key) is kept */
function replaceWith(node: ValueNode, target: ValueNode): ValueNode {
  const prop = node as Partial<ValueProp>;
  const out: Partial<ValueProp> = { ...target };
  if (prop.name !== undefined) out.name = prop.name;
  if (prop.keyRepr !== undefined) out.keyRepr = prop.keyRepr;
  return out as ValueNode;
}

const pathKey = (queryPath: string[]): string => JSON.stringify(queryPath);

/** Replace the node whose `queryPath` matches `target.queryPath` inside `root` (immutable). */
export function spliceNode(root: ValueNode, target: ValueNode): ValueNode {
  const key = pathKey(target.queryPath);
  const visit = (node: ValueNode): ValueNode => {
    if (pathKey(node.queryPath) === key && !node.loadActionNode) return replaceWith(node, target);
    if (!node.props) return node;
    let changed = false;
    const props = node.props.map((p) => {
      // a synthetic load node carries its parent's queryPath: never replace it, the parent is replaced instead
      if (p.loadActionNode) return p;
      const next = visit(p) as ValueProp;
      if (next !== p) changed = true;
      return next;
    });
    return changed ? { ...node, props } : node;
  };
  return visit(root);
}
