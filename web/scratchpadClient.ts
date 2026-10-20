/** The Scratchpad's calls to the bridge (/api/scratchpad/...), and the source text its commands accept. */
import type { Link } from './pageHost';
import type { ValueNode, ValueProp } from '../src/shared/protocol';

const CONTAINERS = new Set(['list', 'tuple', 'set', 'frozenset', 'dict']);
/** A structured server refusal confirms failure, unlike a disconnected request. */
export class ScratchpadRefusal extends Error {}
export function checkScratchSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('scratchpad cancelled; dispatched work may still continue on the server');
}

/** Retire this invocation's listener even when a transport ignores cancellation. */
export function scratchWait<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => {
      cleanup();
      reject(new Error('scratchpad cancelled; dispatched work may still continue on the server'));
    };
    const cleanup = () => signal.removeEventListener('abort', cancelled);
    signal.addEventListener('abort', cancelled, { once: true });
    work.then((value) => { cleanup(); signal.aborted ? cancelled() : resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) cancelled();
  });
}
export const NEW_CODE = '# An experiment: Inputs are bound first, `result` is shown.\nresult = None\n';

export async function post<T>(what: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  checkScratchSignal(signal);
  const res = await scratchWait(fetch(`/api/scratchpad/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }), signal);
  const text = await scratchWait(res.text(), signal);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(text || res.statusText);
  }
  const error = value && typeof value === 'object' && 'error' in value ? (value as { error: unknown }).error : undefined;
  if (!res.ok || typeof error === 'string') throw new ScratchpadRefusal(typeof error === 'string' ? error : text);
  return value as T;
}

/** `{name: expression}` as Inputs source, one assignment per line. */
export function inputsSource(inputs: string | Record<string, string>): string {
  if (typeof inputs === 'string') return inputs;
  return Object.entries(inputs).map(([name, expr]) => {
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`input ${JSON.stringify(name)} is not a Python name`);
    if (typeof expr !== 'string') throw new Error(`input ${name}: give a Python expression as a string`);
    return `${name} = ${expr}\n`;
  }).join('');
}

/** `{target: expression}` as Mocks source, one dict. */
export function mocksSource(mocks: string | Record<string, string>): string {
  if (typeof mocks === 'string') return mocks;
  const rows = Object.entries(mocks).map(([target, expr]) => {
    if (typeof expr !== 'string') throw new Error(`mock ${target}: give a Python expression as a string`);
    return `    ${JSON.stringify(target)}: ${expr},\n`;
  });
  return rows.length ? `{\n${rows.join('')}}\n` : '';
}

/** A paused value, with the containers the runtime capped expanded from its store, so the seed can be whole. */
export async function completeValue(link: Link, runId: string, node: ValueNode, depth: number, budget: { expansions: number }, signal?: AbortSignal): Promise<ValueNode> {
  checkScratchSignal(signal);
  if (!CONTAINERS.has(node.type) || node.circular || node.secret || depth > 8) return node;
  let full = node;
  if (node.expandable && !node.props && budget.expansions-- > 0) {
    const reply = await scratchWait(link.debugRequest({ type: 'expand', runId, valueId: node.id, queryPath: node.queryPath }, signal), signal);
    if (reply.type === 'value') full = reply.node;
  }
  if (!full.props) return full;
  const props = await Promise.all(full.props.map(async (p: ValueProp) => ({ ...(await completeValue(link, runId, p, depth + 1, budget, signal)), name: p.name, ...(p.keyRepr !== undefined ? { keyRepr: p.keyRepr } : {}) })));
  return { ...full, props };
}

