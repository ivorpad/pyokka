/**
 * Narration backend, host side (no vscode here): the prompt, the command that answers it,
 * strict parsing of the answer, the per-run gloss cache. Mirrors
 * `python/pyokka_runtime/agent/narrate.py`; the prompt template is the runtime's
 * `narrate_prompt.md`. A model only ever adds `gloss`; anything unparseable keeps `null`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redact } from '../util/redact';
import { enclosingFunction, fileMap } from '../session/decisions';
import { displayPath, isUserFile, type Moment, type Walkthrough, type WalkthroughInputs } from '../session/walkthrough';

export const GLOSS_MAX = 140;
export const SOURCE_LINES_MAX = 200;
export const SOURCE_FUNCTIONS_MAX = 20;
export const NARRATE_TIMEOUT_MS = 180_000;
export const CLAUDE_ARGS = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence'];
export const CODEX_ARGS = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '-o'];

export class NarrationError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface Backend {
  name: 'claude' | 'codex' | 'custom';
  argv: string[];
  /** codex writes its last message here */
  outputFile?: string;
}

/** `sh`-style split: spaces separate, quotes group (the setting is a command line). */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

function onPath(name: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The explicit command, else `claude`, else `codex`; undefined when none exists (the host may fall back to vscode.lm). */
export function resolveBackend(command: string | undefined, which: (name: string) => boolean = onPath): Backend | undefined {
  if (command && command.trim()) return { name: 'custom', argv: splitCommand(command.trim()) };
  if (which('claude')) return { name: 'claude', argv: ['claude', ...CLAUDE_ARGS] };
  if (which('codex')) {
    const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-narrate-')), 'last-message.md');
    return { name: 'codex', argv: ['codex', ...CODEX_ARGS, outputFile, '-'], outputFile };
  }
  return undefined;
}

/** Run the backend with the prompt on stdin; resolves with the model's answer text. */
export function runBackend(backend: Backend, prompt: string, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  const cwd = opts.cwd ?? (backend.name === 'custom' ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-narrate-')));
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = backend.argv;
    if (!cmd) return reject(new NarrationError('empty narration command', 'set pyokka.explain.command to a command that reads the prompt on stdin'));
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new NarrationError(`${cmd} could not start: ${err instanceof Error ? err.message : String(err)}`, 'check pyokka.explain.command'));
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new NarrationError(`${cmd} took longer than ${Math.round((opts.timeoutMs ?? NARRATE_TIMEOUT_MS) / 1000)} s`, 'try again, or a faster model in pyokka.explain.command')));
    }, opts.timeoutMs ?? NARRATE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(err.code === 'ENOENT' ? new NarrationError(`${cmd} is not on the PATH`, 'install it, or set pyokka.explain.command to a command that reads the prompt on stdin') : new NarrationError(`${cmd} failed: ${err.message}`, 'run the command by hand to see why'))));
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) return reject(new NarrationError(`${cmd} exited with ${code}: ${redact((stderr || stdout).trim().slice(-400))}`, 'run the command by hand to see why'));
        if (backend.outputFile) {
          try {
            return resolve(fs.readFileSync(backend.outputFile, 'utf8'));
          } catch {
            return reject(new NarrationError(`${cmd} wrote no last message`, 'check `codex exec --help` for the -o flag'));
          }
        }
        if (backend.name === 'claude') {
          try {
            const doc = JSON.parse(stdout) as { is_error?: boolean; result?: unknown };
            if (doc && typeof doc === 'object') {
              if (doc.is_error) return reject(new NarrationError(`claude reported an error: ${redact(String(doc.result ?? '')).slice(0, 300)}`, 'run `claude -p` by hand to see why'));
              if (typeof doc.result === 'string') return resolve(doc.result);
            }
          } catch {
            /* plain text: use it as is */
          }
        }
        resolve(stdout);
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);
  });
}

/** The first JSON object in `text` (answers come fenced or wrapped in prose); undefined when none parses. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  let start = text.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            const doc: unknown = JSON.parse(text.slice(start, i + 1));
            if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc as Record<string, unknown>;
          } catch {
            /* not this one */
          }
          break;
        }
      }
    }
    start = text.indexOf('{', start + 1);
  }
  return undefined;
}

/** Strict: a JSON object of `{id: sentence}`; unknown ids dropped, sentences cut at 140 chars; throws when nothing usable came back. */
export function parseGlosses(answer: string, ids: readonly string[]): Record<string, string> {
  const doc = extractJsonObject(answer);
  if (!doc) throw new NarrationError('the model did not answer with a JSON object', `the answer started: ${redact(answer.trim().slice(0, 120))}`);
  const wanted = new Set(ids);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!wanted.has(key)) continue;
    if (typeof value !== 'string') throw new NarrationError(`the gloss for ${key} is not a string`, 'the model must answer {id: sentence}');
    const s = value.trim().split(/\s+/).join(' ');
    if (s) out[key] = s.length <= GLOSS_MAX ? s : s.slice(0, GLOSS_MAX - 1) + '…';
  }
  if (Object.keys(out).length === 0) throw new NarrationError(`the answer glossed none of the ${ids.length} moments`, 'the keys must be the moment ids (m0, m1, …)');
  return out;
}

export interface SourceBlock {
  file: string;
  function: string;
  line: number;
  text: string;
}

/** Fill the template: the moments (redacted, locations by basename) and the source blocks. */
export function buildPrompt(template: string, walkthrough: Pick<Walkthrough, 'moments'>, sources: SourceBlock[]): string {
  const moments = walkthrough.moments.map((m) => ({
    kind: m.kind,
    step: m.step,
    location: { file: path.basename(m.location.file ?? ''), line: m.location.line, function: m.location.function },
    text: redact(m.text),
    values: m.values.map((v) => ({ role: v.role, name: redact(v.name), text: redact(v.text) })),
    id: m.id,
  }));
  const blocks = sources.length ? sources.map((s) => `### ${s.file}: ${s.function} (line ${s.line})\n\n\`\`\`python\n${redact(s.text)}\n\`\`\``) : ['(no user source available)'];
  return template.replace('{{walkthrough}}', JSON.stringify({ moments }, null, 1)).replace('{{sources}}', blocks.join('\n\n'));
}

/** The user functions the moments touch (≤ 200 lines each, ≤ 20 functions), the module first. */
export function collectSources(inputs: Pick<WalkthroughInputs, 'files' | 'readSource' | 'mainFile' | 'workspaceRoot'>, moments: readonly Moment[]): SourceBlock[] {
  const seen = new Set<string>();
  const out: SourceBlock[] = [];
  const maps = new Map<number, ReturnType<typeof fileMap>>();
  const add = (fid: number, fn: string): void => {
    const key = `${fid}:${fn}`;
    if (fid < 0 || seen.has(key) || out.length >= SOURCE_FUNCTIONS_MAX) return;
    const file = inputs.files.get(fid);
    if (!file || !isUserFile(file.path, inputs.workspaceRoot, inputs.mainFile)) return;
    const lines = inputs.readSource(fid);
    if (!lines || lines.length === 0) return;
    let map = maps.get(fid);
    if (!map) {
      map = fileMap(lines, file.statements.map((local) => file.ranges[local]!).filter(Boolean));
      maps.set(fid, map);
    }
    let start: number;
    let end: number;
    if (fn === '<module>') {
      start = 1;
      end = Math.min(lines.length, SOURCE_LINES_MAX);
    } else {
      const span = [...map.functions.values()].find((f) => f.name === fn);
      if (!span) return;
      start = span.line;
      end = Math.min(span.end, span.line + SOURCE_LINES_MAX - 1);
    }
    seen.add(key);
    out.push({ file: displayPath(file.path, inputs.workspaceRoot), function: fn, line: start, text: lines.slice(start - 1, end).join('\n') });
  };
  for (const m of moments) {
    add(m.location.fileId, m.location.function || '<module>');
    if (m.callee) add(m.callee.fileId, m.callee.function);
  }
  return out;
}

/** Glosses per (session, run): a narration is asked for once per run and shown until the next run. */
export class GlossCache {
  private readonly byKey = new Map<string, { runId: string; glosses: Record<string, string> }>();

  get(sessionKey: string, runId: string): Record<string, string> | undefined {
    const e = this.byKey.get(sessionKey);
    return e && e.runId === runId ? e.glosses : undefined;
  }

  set(sessionKey: string, runId: string, glosses: Record<string, string>): void {
    this.byKey.set(sessionKey, { runId, glosses });
  }

  clear(sessionKey: string): void {
    this.byKey.delete(sessionKey);
  }
}

export { enclosingFunction };
