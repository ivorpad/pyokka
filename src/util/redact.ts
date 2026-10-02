/**
 * Redaction of secret-looking text before it leaves the process (bridge replies).
 * The rules are the ones of docs/PROTOCOL.md "Redaction" and must stay identical to
 * python/pyokka_runtime/redact.py; test/unit/fixtures/redact.json checks both.
 */
import type { ValueBag, ValueNode } from '../shared/protocol';

export const REDACTED = '«redacted»';

// whole tokens: sk-… (16+), AKIA… (16 upper/digits), ghp_… (30+), xox[abp]-…, JWTs
const TOKEN_RES: RegExp[] = [
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9_-])xox[abp]-[A-Za-z0-9-]+/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const BEARER_RE = /\b(Bearer\s+)(?!«)[A-Za-z0-9._~+/=-]+/g;

// key=value, key: value, 'key': 'value', key='value' where the key name contains a secret word; an
// unquoted value ends at `&` so a URL's `?api_key=…&v=1` keeps its other query parameters
const KEY_WORDS = 'api_key|apikey|secret|token|password|passwd|authorization';
// The lookbehind after the quote is what keeps this linear, and must stay in step with
// python/pyokka_runtime/redact.py, which explains it. Without it the leading `[A-Za-z0-9_.-]*`
// restarts at every offset of a run of those characters and backtracks the length of the run at
// each one: O(n²), seconds for a line of a few tens of KB. It rules out only starts that could
// never have won, because a match inside a run always has an equivalent where the run begins.
const KEY_VALUE_RE = new RegExp(
  `(["']?)(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*(?:${KEY_WORDS})[A-Za-z0-9_.-]*)\\1(\\s*[:=]\\s*)(?:(["'])((?:\\\\.|(?!\\4).)*)\\4|((?:Bearer\\s+)?)([^\\s,;()\\[\\]{}'"&]+))`,
  'gi',
);

/** None, numbers and short words are never redacted. */
function isPlain(value: string): boolean {
  if (value === REDACTED) return true;
  if (/^(None|True|False|null|true|false)$/.test(value)) return true;
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) return true;
  return value.length < 6;
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of TOKEN_RES) out = out.replace(re, REDACTED);
  out = out.replace(BEARER_RE, `$1${REDACTED}`);
  out = out.replace(KEY_VALUE_RE, (m, q1: string, key: string, sep: string, q4: string | undefined, quoted: string | undefined, bearer: string | undefined, bare: string | undefined, offset: number, whole: string) => {
    if (q4 !== undefined) return isPlain(quoted ?? '') ? m : `${q1}${key}${q1}${sep}${q4}${REDACTED}${q4}`;
    const value = bare ?? '';
    if (!bearer && isPlain(value)) return m;
    const next = whole[offset + m.length];
    if (!bearer && (next === '(' || next === '[')) return m; // `api_key = getenv("X")`, `token = cfg["t"]`: code, not a secret
    return `${q1}${key}${q1}${sep}${bearer ?? ''}${REDACTED}`;
  });
  return out;
}

/** Redact every `value` of a value tree (and the property names' keyReprs are left alone). */
export function redactValueNode<T extends ValueNode>(node: T): T {
  const out: T = { ...node };
  if (typeof out.value === 'string') out.value = redact(out.value);
  if (out.props) out.props = out.props.map((p) => redactValueNode(p));
  return out;
}

export function redactValueBag(bag: ValueBag): ValueBag {
  return { ...bag, data: redactValueNode(bag.data) };
}
