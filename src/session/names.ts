/**
 * The names a statement assigns and reads, from its source lines, for the execution graph's
 * statement nodes (docs/PROTOCOL.md, "statement"). A character scanner, not a parser: string
 * literals are blanked (the `{…}` parts of an f-string stay), comments end their line, then the
 * identifiers outside attributes, keywords and keyword arguments are the reads and the names
 * left of a plain `=` at bracket depth 0 are the targets. `python/pyokka_runtime/agent/names.py`
 * is the same scanner, step for step, so both builders label the same edges.
 */

export const PYTHON_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '),
);

// the lookbehind keeps `10_000` and `0x1f` from yielding `_000` / `x1f` as names (the Python side has the same guard)
const NAME = /(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*/g;
const PREFIX_LETTER = /[rRbBfFuU]/;
const AUGMENTED = ['//', '**', '<<', '>>', '+', '-', '*', '/', '%', '@', '&', '|', '^'];
const TARGET_LIST = /^\s*[A-Za-z_]\w*(\s*,\s*[A-Za-z_]\w*)*\s*(:\s*[^=]*)?\s*$/;

interface Literal {
  quote: string;
  triple: boolean;
  fstring: boolean;
}

/**
 * One walk over the lines: per line, the code with its comment removed (`kept`, literals intact)
 * and the code with its literals blanked to one space (`stripped`, f-string expressions kept).
 * The literal state carries across lines (triple quotes); a plain literal ends with its line.
 */
function scan(lines: string[]): { kept: string[]; stripped: string[] } {
  const kept: string[] = [];
  const stripped: string[] = [];
  let literal: Literal | undefined;
  for (const line of lines) {
    let keep = '';
    let out = '';
    let i = 0;
    while (i < line.length) {
      const c = line[i]!;
      if (!literal) {
        if (c === '#') break;
        if (c === '"' || c === "'") {
          let n = 0;
          while (n < 2 && out.length - 1 - n >= 0 && PREFIX_LETTER.test(out[out.length - 1 - n]!)) n++;
          const prefix = n ? out.slice(-n) : '';
          if (n) out = out.slice(0, -n);
          const triple = line[i + 1] === c && line[i + 2] === c;
          literal = { quote: c, triple, fstring: /[fF]/.test(prefix) };
          out += ' ';
          const open = triple ? 3 : 1;
          keep += line.slice(i, i + open);
          i += open;
          continue;
        }
        out += c;
        keep += c;
        i++;
        continue;
      }
      if (c === '\\') {
        keep += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === literal.quote && (!literal.triple || (line[i + 1] === c && line[i + 2] === c))) {
        const close = literal.triple ? 3 : 1;
        keep += line.slice(i, i + close);
        i += close;
        literal = undefined;
        continue;
      }
      if (literal.fstring && c === '{') {
        if (line[i + 1] === '{') {
          keep += '{{';
          i += 2;
          continue;
        }
        // an expression part: its characters go to `stripped` until the matching `}`
        keep += c;
        out += c;
        i++;
        let depth = 0;
        while (i < line.length) {
          const ch = line[i]!;
          if (ch === '{') depth++;
          else if (ch === '}') {
            if (depth === 0) break;
            depth--;
          }
          out += ch;
          keep += ch;
          i++;
        }
        if (i < line.length) {
          keep += '}';
          out += '}';
          i++;
        }
        continue;
      }
      if (literal.fstring && c === '}' && line[i + 1] === '}') {
        keep += '}}';
        i += 2;
        continue;
      }
      keep += c;
      i++;
    }
    if (literal && !literal.triple) literal = undefined;
    kept.push(keep);
    stripped.push(out);
  }
  return { kept, stripped };
}

/** The lines with their comments removed (string literals kept; a `#` inside one is not a comment). */
export function stripComments(lines: string[]): string[] {
  return scan(lines).kept;
}

/** The statement's code: its lines without comments, joined by a single space (whitespace not yet collapsed). */
export function stripCode(lines: string[]): string {
  return stripComments(lines).join(' ');
}

/** The names a statement assigns (`targets`) and uses (`reads`), per the contract's scanner. */
export function namesOf(lines: string[]): { targets: string[]; reads: string[] } {
  const stripped = scan(lines).stripped.join(' ');

  // b. identifiers: not after a `.`, not keywords, not keyword-argument names inside brackets
  const identifiers: string[] = [];
  let depth = 0;
  let scanned = 0;
  for (const m of stripped.matchAll(NAME)) {
    const at = m.index!;
    for (; scanned < at; scanned++) {
      const ch = stripped[scanned]!;
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    const name = m[0];
    if (at > 0 && stripped[at - 1] === '.') continue;
    if (PYTHON_KEYWORDS.has(name)) continue;
    let j = at + name.length;
    while (stripped[j] === ' ') j++;
    if (depth > 0 && stripped[j] === '=' && stripped[j + 1] !== '=') continue;
    identifiers.push(name);
  }

  // c. targets: the names left of the first plain `=` at depth 0
  let targets: string[] = [];
  let augmented = false;
  depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      const before = stripped[i - 1] ?? '';
      if ('=!<>:'.includes(before) && before !== '') continue;
      if (stripped[i + 1] === '=') continue;
      let left = stripped.slice(0, i);
      const op = AUGMENTED.find((o) => left.endsWith(o));
      if (op) {
        left = left.slice(0, -op.length);
        augmented = true;
      }
      if (TARGET_LIST.test(left)) targets = left.split(':')[0]!.match(NAME) ?? [];
      break;
    }
  }

  // d. reads: the identifiers once each, minus the targets unless the assignment is augmented
  const reads: string[] = [];
  const seen = new Set<string>();
  for (const name of identifiers) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!augmented && targets.includes(name)) continue;
    reads.push(name);
  }
  return { targets, reads };
}
