/**
 * Which argument a call passed for a parameter, from the call site's source alone. The twin of
 * `parameter_argument` in `python/pyokka_runtime/bindings.py` (its docstring has the rules); the
 * fixtures `parameter-argument.json` and the provenance ones pin both, so keep the two identical.
 */
import type { ArgumentText, CallArguments, DefParameters } from '../shared/protocol';

/** The recorded text of a name at the call site; undefined when none was recorded. */
export type ValueOf = (text: string) => string | undefined;

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

const MAKERS = new Set(['__init__', '__new__']);

export function parameterArgument(name: string, scopeName: string, params: DefParameters, calls: readonly CallArguments[], valueOf: ValueOf = () => undefined, made?: string, index = 0, entered = 1): ArgumentText | undefined {
  const classOf = (text: string): string | undefined => (IDENTIFIER.test(text) ? className(valueOf(text) ?? '') : undefined);
  const owner = params.owner;
  const maker = MAKERS.has(scopeName) && !!owner;
  let boundByVariable = false;
  let candidates: CallArguments[];
  if (params.property) candidates = calls.filter((c) => c.attribute && c.callee === scopeName);
  else {
    if ((calls[0]?.passes ?? []).includes(scopeName)) return undefined;
    const plain = calls.filter((c) => !c.attribute);
    candidates = plain.filter((c) => c.callee === scopeName && (!maker || c.receiver !== undefined));
    if (!candidates.length && !maker) {
      const held = plain.filter((c) => c.receiver === undefined && IDENTIFIER.test(c.callee)).map((c) => [c, functionName(valueOf(c.callee) ?? '')] as const);
      const hits = held.filter(([, f]) => f !== undefined && f[0] === scopeName);
      candidates = hits.map(([c]) => c);
      boundByVariable = hits.some(([, f]) => f![1]);
      if (boundByVariable && !hits.every(([, f]) => f![1])) return undefined; // the same function held bound and unbound: which binding a call made is not known
    }
    if (maker) {
      let named = plain.filter((c) => c.callee === owner);
      if (!named.length) named = plain.filter((c) => c.receiver === undefined && made !== undefined && classOf(c.callee) === made);
      candidates = [...named, ...candidates];
    }
  }
  let call: CallArguments;
  if (candidates.length === 1 && (entered === 1 || candidates[0]!.repeats)) call = candidates[0]!;
  else if (candidates.length === entered && entered > 1 && index >= 0 && index < entered && !calls[0]!.unordered && !candidates.some((c) => c.repeats)) call = candidates[index]!;
  else return undefined;
  const positionalParams = [...params.positional];
  const args = call.positional;
  const receiver = call.receiver;
  const binds = params.binds;
  const explicit = call.callee === scopeName && maker; // `super().__init__(x)`, `object.__new__(cls)`
  let first: string | undefined;
  let firstIs: ArgumentText | undefined;
  if (binds && positionalParams.length) {
    let throughClass = receiver !== undefined && (classOf(receiver.text) !== undefined || receiver.text === owner || receiver.text.endsWith('.' + String(owner)));
    if (maker && !explicit) {
      first = positionalParams.shift();
      firstIs = scopeName === '__new__' && receiver === undefined ? { text: call.callee, names: [call.callee] } : undefined;
    } else if (maker) {
      // `super().__init__(x)` binds self; `Base.__init__(self, x)` and `object.__new__(cls)` pass it
      if (scopeName === '__init__' && !throughClass) first = positionalParams.shift();
    } else if (receiver === undefined && call.callee !== scopeName) {
      if (boundByVariable) first = positionalParams.shift(); // the bound method holds its first argument: no argument names it
    } else {
      throughClass = throughClass && binds === 'self';
      if (receiver !== undefined && !throughClass) {
        first = positionalParams.shift();
        firstIs = { text: receiver.text, names: [...receiver.names] };
      } else if (receiver === undefined) return undefined; // a method called by a bare name: not a binding this rule can read
    }
  }
  const keywords = new Map((call.keywords ?? []).map((k) => [k.name, k]));
  const only = (params.positionalOnly ?? 0) - (first !== undefined ? 1 : 0);
  const named = [...positionalParams.slice(Math.max(0, only)), ...(params.keywordOnly ?? [])];
  if (!fits(params, positionalParams, named, args, keywords, call)) return undefined;
  if (first !== undefined && name === first) return firstIs;
  const kw = keywords.get(name);
  if (kw && named.includes(name)) return { text: kw.text, names: [...kw.names] };
  const i = positionalParams.indexOf(name);
  if (i >= 0) return i < args.length ? { text: args[i]!.text, names: [...args[i]!.names] } : undefined;
  if (name === params.vararg && !call.star) return joined(args.slice(positionalParams.length));
  if (name === params.kwarg && !call.kwstar) return joined([...keywords.values()].filter((k) => !named.includes(k.name)).map((k) => ({ text: `${k.name}=${k.text}`, names: k.names })));
  return undefined;
}

/** Whether the call's arguments bind to the parameters as Python would bind them, as far as the source shows. */
function fits(params: DefParameters, positionalParams: string[], named: string[], args: readonly ArgumentText[], keywords: ReadonlyMap<string, ArgumentText>, call: CallArguments): boolean {
  if (args.length > positionalParams.length && !params.vararg) return false;
  if ([...keywords.keys()].some((n) => !named.includes(n)) && !params.kwarg) return false;
  if (call.star || call.kwstar) return true; // what else they pass is unknown; the named and positional ones above still hold
  const required = positionalParams.slice(0, Math.max(0, positionalParams.length - (params.defaults ?? 0)));
  const filled = new Set([...positionalParams.slice(0, args.length), ...keywords.keys()]);
  return required.every((p) => filled.has(p)) && (params.requiredKeywordOnly ?? []).every((p) => keywords.has(p));
}

function joined(args: readonly ArgumentText[]): ArgumentText | undefined {
  if (!args.length) return undefined;
  const names: string[] = [];
  for (const a of args) for (const n of a.names) if (!names.includes(n)) names.push(n);
  return { text: args.map((a) => a.text).join(', '), names };
}

// `\w` as Python's re reads it in a str pattern: any letter or digit, not ASCII only
const CLASS_TEXT = /^<class '(?:[\p{L}\p{N}_.]*\.)?([\p{L}\p{N}_]+)'>$/u;
const INSTANCE_TEXT = /^<(?:[\p{L}\p{N}_.]*\.)?([\p{L}\p{N}_]+) object(?: at 0x[0-9a-f]+)?>$|^([\p{L}\p{N}_]+)\(/u;

/** The class a recorded value names when it is a class: `Plain` for `<class 'shapes.Plain'>`. */
export function className(text: string): string | undefined {
  return CLASS_TEXT.exec(text)?.[1];
}

const FUNCTION_TEXT = /^<(bound method|function) (?:[\p{L}\p{N}_.<>]*\.)?([\p{L}\p{N}_]+)(?: at 0x[0-9a-f]+| of .*)>$/su;

/** The function a recorded value names, and whether it is a bound method: `['identity', false]` for `<function identity at 0x1>`. */
export function functionName(text: string): readonly [string, boolean] | undefined {
  const m = FUNCTION_TEXT.exec(text);
  return m ? [m[2]!, m[1] === 'bound method'] : undefined;
}

/** The class a recorded object's text names: `Plain` for `<shapes.Plain object at 0x1>`, `<Plain object>` or `Plain(name='x')`. */
export function instanceClass(text: string): string | undefined {
  const m = INSTANCE_TEXT.exec(text);
  return m ? (m[1] ?? m[2]) : undefined;
}
