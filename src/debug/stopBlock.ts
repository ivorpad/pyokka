/**
 * The block a stop shows: the enclosing function's source with the paused line marked, cut on the
 * code's own structure when it is long. The VS Code stop slice (debugSessionState.ts) and the
 * browser page's agent replies (web/agent.ts) both build it, so this imports nothing from Node.
 */
import type { Range4 } from '../shared/protocol';
import type { BlockLine, SliceBlock, SliceOptions } from '../session/contextSlice';

/** Lines of the enclosing function a stop slice spends before it cuts on the code's own structure. */
export const BLOCK_LINES = 60;

/** Lines of the `def` header a cut block keeps however far down the function the pause is. */
export const BLOCK_SIGNATURE_LINES = 8;

/** What a block is built from: where the pause is, the run's files, and the file's text. */
export interface StopBlockInputs {
  paused: { fileId: number; line: number | null; scopeId: number; stack: readonly { name: string }[] };
  /** the absolute path of a fileId; undefined when the file is not instrumented (`fileId: 0`) */
  pathForFileId: (fileId: number) => string | undefined;
  /** source lines of a file; undefined when unavailable */
  readSource: (fileId: number) => string[] | undefined;
  /** the function whose body contains a line, as `file.instrumented` reported it */
  functionAt: (fileId: number, line: number) => { name: string; bodyRange: Range4 } | undefined;
}

/** Leading whitespace of a line, in characters: Python's own structure, and all this needs of it. */
function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** A line with no code on it: the structure reads straight through it. */
function isBlank(text: string): boolean {
  const t = text.trim();
  return t === '' || t.startsWith('#');
}

/** Does this line open a suite (`def f():`, `for r in rows:`, `else:`)? A trailing comment is not in the way. */
function opensSuite(text: string): boolean {
  return text.replace(/#[^'"]*$/, '').trimEnd().endsWith(':');
}

/** The last line with code on it in `from..to`, which for a function body is what it answers with. */
function lastCode(source: string[], from: number, to: number): number {
  for (let line = to; line >= from; line--) if (!isBlank(source[line - 1] ?? '')) return line;
  return to;
}

/** The `def` line down to the `:` that ends the signature: one line unless the parameters wrap. */
function signatureEnd(source: string[], first: number, last: number): number {
  const to = Math.min(last, first + BLOCK_SIGNATURE_LINES - 1);
  for (let line = first; line <= to; line++) if (opensSuite(source[line - 1] ?? '')) return line;
  return first;
}

/**
 * The suite the paused line sits in: the `for` / `if` / `with` header above it, and the lines
 * under that header. This is the boundary a reader of one line actually wants — the loop body it
 * is in, whole — where a window of N lines centred on the pause cuts wherever the number lands and
 * can open on the tail of one statement and close on the head of another.
 */
function enclosingSuite(source: string[], line: number, first: number, last: number): [number, number] {
  const own = indentOf(source[line - 1] ?? '');
  let header = first;
  for (let l = line - 1; l >= first; l--) {
    const text = source[l - 1] ?? '';
    if (isBlank(text)) continue;
    if (indentOf(text) < own && opensSuite(text)) {
      header = l;
      break;
    }
  }
  const headerIndent = indentOf(source[header - 1] ?? '');
  let end = header;
  for (let l = header + 1; l <= last; l++) {
    const text = source[l - 1] ?? '';
    if (isBlank(text)) continue;
    if (indentOf(text) <= headerIndent) break;
    end = l;
  }
  // nothing encloses the line (module level, or a header at the function's own indent): the pause
  // itself is the boundary, and the caller widens it into the room it has
  return end >= line ? [header, end] : [line, line];
}

/**
 * The enclosing function's source as the stop shows it: its `def` line to its last line when that
 * fits `BLOCK_LINES`, `current` on the paused line. Without a function (module level) the window is
 * the paused line's neighbourhood.
 *
 * When it does not fit, the block is cut on the code's structure rather than on a line count: the
 * signature always stays (a reader who cannot see the parameters cannot read the body), and the
 * rest of the budget goes to the suite the pause is in, widened into the lines around it when there
 * is room to spare. `totalLines` says how long the function really is, and the gaps between the
 * pieces are visible in the line numbers, so what is missing is never silent.
 */
export function stopBlock(inputs: StopBlockInputs, opts: SliceOptions = {}): SliceBlock {
  const p = inputs.paused;
  const file = inputs.pathForFileId(p.fileId) ?? '';
  const fn = p.line !== null ? inputs.functionAt(p.fileId, p.line) : undefined;
  const block: SliceBlock = { file, function: fn?.name ?? p.stack[0]?.name ?? '<module>', scopeId: p.scopeId, lines: [] };
  const source = inputs.readSource(p.fileId);
  if (!source || p.line === null) return block;
  const first = Math.max(1, fn ? fn.bodyRange[0] : 1);
  const last = Math.min(source.length, fn ? fn.bodyRange[2] : source.length);
  const total = last - first + 1;
  const budget = opts.scope ? Number.MAX_SAFE_INTEGER : BLOCK_LINES;
  const spans: [number, number][] = total <= budget ? [[first, last]] : cutSpans(source, p.line, first, last, budget, !!fn);
  const lines: BlockLine[] = [];
  let shown = 0;
  for (const [from, to] of spans) {
    for (let line = Math.max(first, from); line <= Math.min(last, to); line++) {
      if (shown && line <= lines[lines.length - 1]!.line) continue; // spans can meet: the signature and the suite
      const entry: BlockLine = { line, text: source[line - 1] ?? '' };
      if (line === p.line) entry.current = true;
      lines.push(entry);
      shown++;
    }
  }
  block.lines = lines;
  if (lines.length < total) {
    block.capped = true;
    block.totalLines = total;
  }
  return block;
}

/**
 * The pieces of a block too long to show whole: the signature, and the suite the pause is in.
 * Module level has no signature to keep (the first lines of a file are not a header for the line
 * that is running), so the whole budget goes to the pause's own neighbourhood.
 */
function cutSpans(source: string[], line: number, first: number, last: number, budget: number, hasSignature: boolean): [number, number][] {
  const sigEnd = hasSignature ? signatureEnd(source, first, last) : first - 1;
  const spans: [number, number][] = hasSignature ? [[first, sigEnd]] : [];
  const [suiteFrom, suiteTo] = enclosingSuite(source, line, first, last);
  // the last line of a function is what it answers with, and a cut that drops the `return` drops
  // the point of reading the body at all; one line of the budget buys it
  const tailLine = hasSignature ? lastCode(source, Math.max(first, sigEnd + 1), last) : 0;
  const keepTail = tailLine > suiteTo && tailLine > line;
  let room = Math.max(1, budget - (sigEnd - first + 1) - (keepTail ? 1 : 0));
  let from = Math.max(suiteFrom, sigEnd + 1);
  let to = Math.max(suiteTo, from);
  if (to - from + 1 > room) {
    // the suite itself is over budget: keep its header line, then centre the rest on the pause
    if (suiteFrom > sigEnd && room > 1) {
      spans.push([suiteFrom, suiteFrom]);
      room -= 1;
      from = suiteFrom + 1;
    }
    from = Math.max(from, Math.min(line - Math.floor(room / 2), to - room + 1));
    to = from + room - 1;
  } else {
    // room to spare: spend it on the lines around the suite, inside the function
    let left = room - (to - from + 1);
    while (left > 0 && (from > sigEnd + 1 || to < last)) {
      if (to < last) {
        to++;
        left--;
      }
      if (left > 0 && from > sigEnd + 1) {
        from--;
        left--;
      }
    }
  }
  spans.push([from, Math.min(to, last)]);
  if (keepTail && tailLine > to) spans.push([tailLine, tailLine]);
  return spans;
}
