/**
 * Pretty-print a value tree (protocol `ValueNode`) as Python source.
 * Pure: no DOM, no Monaco. Every emitted line remembers the node it belongs to so
 * the Details editor can map cursor positions back to nodes (copy path/value,
 * click on `…` to load more).
 */
import type { ValueNode, ValueProp } from '../src/shared/protocol';

export const DEFAULT_WIDTH = 100;
export const INDENT = '    ';

export type LineKind = 'value' | 'load' | 'string-capped';

export interface FormattedLine {
  text: string;
  /** innermost node that starts on this line */
  node: ValueNode;
  /** python access path from the root name, e.g. `value['a'][0].x` */
  path: string;
  kind: LineKind;
  /** node whose expansion should be requested when the line is clicked */
  loadNode?: ValueNode;
}

export interface FormatOptions {
  width?: number;
  rootName?: string;
}

const CONTAINER_TYPES = new Set(['list', 'tuple', 'dict', 'set', 'frozenset']);
const PRIMITIVE_TYPES = new Set(['str', 'number', 'bool', 'None', 'bytes', 'function', 'class', 'module']);

export function isContainer(node: ValueNode): boolean {
  return CONTAINER_TYPES.has(node.type);
}

export function isInstance(node: ValueNode): boolean {
  return !CONTAINER_TYPES.has(node.type) && !PRIMITIVE_TYPES.has(node.type);
}

/** dict / list / tuple / set / instance with attributes: anything the diagram or diff treat as structured */
export function isStructured(node: ValueNode): boolean {
  return isContainer(node) || (isInstance(node) && (!!node.props?.length || !!node.expandable));
}

const STRING_LITERAL = /^(?:[rbuf]{0,2})(['"])[\s\S]*\1$/i;

/** Python repr of a string. Values that already look like a literal are kept as they are. */
export function pyQuote(s: string): string {
  if (STRING_LITERAL.test(s) && s.length >= 2) return s;
  const useDouble = s.includes("'") && !s.includes('"');
  const q = useDouble ? '"' : "'";
  let out = q;
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
      else out += ch;
    }
  }
  return out + q;
}

function isLoadNode(p: ValueProp): boolean {
  return !!p.loadActionNode;
}

function childPath(parent: ValueNode, parentPath: string, prop: ValueProp): string {
  if (prop.expressionPath) return prop.expressionPath;
  switch (parent.type) {
    case 'dict':
      return `${parentPath}[${prop.keyRepr ?? pyQuote(prop.name)}]`;
    case 'list':
    case 'tuple':
      return `${parentPath}[${prop.name}]`;
    case 'set':
    case 'frozenset':
      return `${parentPath}{${prop.name}}`;
    default:
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(prop.name) ? `${parentPath}.${prop.name}` : `${parentPath}[${prop.keyRepr ?? pyQuote(prop.name)}]`;
  }
}

function primitiveText(node: ValueNode): string {
  if (node.circular) return '[Circular]';
  if (node.nan) return 'nan';
  if (node.positiveInfinity) return 'inf';
  if (node.negativeInfinity) return '-inf';
  switch (node.type) {
    case 'str':
      return pyQuote(node.value ?? '') + (node.capped ? '…' : '');
    case 'None':
      return 'None';
    case 'bool':
      return node.value === 'True' || node.value === 'true' ? 'True' : node.value === 'False' || node.value === 'false' ? 'False' : (node.value ?? 'False');
    default:
      return node.value ?? '';
  }
}

function brackets(node: ValueNode): [string, string] {
  switch (node.type) {
    case 'list': return ['[', ']'];
    case 'tuple': return ['(', ')'];
    case 'dict': return ['{', '}'];
    case 'set': return ['{', '}'];
    case 'frozenset': return ['frozenset({', '})'];
    default: return [`${node.type}(`, ')'];
  }
}

function entryPrefix(parent: ValueNode, prop: ValueProp): string {
  if (isLoadNode(prop)) return '';
  switch (parent.type) {
    case 'dict': return `${prop.keyRepr ?? pyQuote(prop.name)}: `;
    case 'list':
    case 'tuple':
    case 'set':
    case 'frozenset':
      return '';
    default: return `${prop.name}=`;
  }
}

/** props to render (host may already include a synthetic load node; otherwise we add one for capped containers) */
function children(node: ValueNode): ValueProp[] {
  const props = node.props ?? [];
  const hasLoad = props.some(isLoadNode);
  const capped = !!node.cappedProps || !!node.cappedElements || (node.capped === true);
  if (capped && !hasLoad) {
    return [...props, { ...node, name: '…', loadActionNode: true, props: undefined }];
  }
  return props;
}

/** single-line rendering, used when it fits in the width and for list rows */
export function flat(node: ValueNode): string {
  if (node.circular) return '[Circular]';
  if (!isStructured(node)) return primitiveText(node);
  const [open, close] = brackets(node);
  const props = node.props;
  if (!props) {
    if (node.value && !isContainer(node)) return node.value;
    if (node.value && isContainer(node)) return node.value;
    return `${open}…${close}`;
  }
  if (node.type === 'set' && props.length === 0) return 'set()';
  if (node.type === 'frozenset' && props.length === 0) return 'frozenset()';
  const items = children(node).map((p) => (isLoadNode(p) ? '…' : entryPrefix(node, p) + flat(p)));
  const body = items.join(', ');
  if (node.type === 'tuple' && props.length === 1 && !node.cappedElements) return `(${body},)`;
  return `${open}${body}${close}`;
}

/**
 * Pretty-print `root` into lines. Containers are split over multiple lines when the flat
 * form would overflow `width` (counting the current indentation and the surrounding prefix / suffix).
 */
export function formatValue(root: ValueNode, opts: FormatOptions = {}): FormattedLine[] {
  const width = opts.width ?? DEFAULT_WIDTH;
  const rootPath = opts.rootName ?? root.expressionPath ?? 'value';
  const out: FormattedLine[] = [];

  const emit = (text: string, node: ValueNode, path: string, kind: LineKind = 'value', loadNode?: ValueNode) => {
    const line: FormattedLine = { text, node, path, kind };
    if (loadNode) line.loadNode = loadNode;
    out.push(line);
  };

  const render = (node: ValueNode, path: string, depth: number, prefix: string, suffix: string) => {
    const indent = INDENT.repeat(depth);
    const single = flat(node);
    const structured = isStructured(node) && !node.circular;
    const props = node.props;
    const hasLoadChild = structured && !!props && children(node).some((p) => isLoadNode(p) || (isStructured(p) && !p.props && !!p.expandable));
    const needsSplit = structured && props && props.length > 0 && (hasLoadChild || indent.length + prefix.length + single.length + suffix.length > width);

    if (!needsSplit) {
      const kind: LineKind = node.type === 'str' && node.capped ? 'string-capped' : structured && !props && node.expandable ? 'load' : 'value';
      emit(indent + prefix + single + suffix, node, path, kind, kind === 'value' ? undefined : node);
      return;
    }

    const [open, close] = brackets(node);
    emit(indent + prefix + open, node, path);
    const kids = children(node);
    kids.forEach((p, i) => {
      const last = i === kids.length - 1;
      const comma = last && !(node.type === 'tuple' && kids.length === 1) ? '' : ',';
      const childIndent = INDENT.repeat(depth + 1);
      if (isLoadNode(p)) {
        emit(childIndent + '…', p, path, 'load', p);
        return;
      }
      render(p, childPath(node, path, p), depth + 1, entryPrefix(node, p), comma);
    });
    emit(indent + close + suffix, node, path);
  };

  render(root, rootPath, 0, '', '');
  return out;
}

export function formatText(root: ValueNode, opts: FormatOptions = {}): string {
  return formatValue(root, opts).map((l) => l.text).join('\n');
}

/** the host's node replaces ours entirely; only the prop identity (name / key) is kept */
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

/** kind of a node for compare / diagram compatibility checks */
export function valueCategory(node: ValueNode): 'object' | 'list' | 'string' | 'other' {
  if (node.type === 'str') return 'string';
  if (node.type === 'list' || node.type === 'tuple' || node.type === 'set' || node.type === 'frozenset') return 'list';
  if (node.type === 'dict' || isInstance(node)) return 'object';
  return 'other';
}
