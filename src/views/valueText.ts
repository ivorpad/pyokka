/** Multi-line, Python-flavoured rendering of a value node (Compare, Copy Data). Pure. */
import type { ValueNode, ValueProp } from '../shared/protocol';

const OPEN: Record<string, [string, string]> = { list: ['[', ']'], tuple: ['(', ')'], dict: ['{', '}'], set: ['{', '}'], frozenset: ['frozenset({', '})'] };

export function renderValueNode(node: ValueNode | undefined, indent = 0): string {
  if (!node) return '';
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  const props = node.props?.filter((p) => !p.loadActionNode);
  if (node.circular) return '[Circular]';
  if (!props || props.length === 0) {
    if (node.type === 'str' && node.value !== undefined && !/^['"]/.test(node.value)) return JSON.stringify(node.value);
    return node.value ?? node.type;
  }
  const brackets = OPEN[node.type];
  const isSeq = node.type === 'list' || node.type === 'tuple' || node.type === 'set' || node.type === 'frozenset';
  const lines = props.map((p: ValueProp) => {
    const v = renderValueNode(p, indent + 1);
    if (isSeq) return `${inner}${v},`;
    const key = p.keyRepr ?? (node.type === 'dict' ? JSON.stringify(p.name) : p.name);
    return node.type === 'dict' ? `${inner}${key}: ${v},` : `${inner}${p.name}=${v},`;
  });
  const tail = node.cappedProps || node.cappedElements ? `${inner}…` : undefined;
  if (tail) lines.push(tail);
  if (brackets) return `${brackets[0]}\n${lines.join('\n')}\n${pad}${brackets[1]}`;
  return `${node.type}(\n${lines.join('\n')}\n${pad})`;
}
