/** Host-side narration: backend resolution, the strict answer parser, the prompt, the gloss cache. No live model. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GlossCache, NarrationError, buildPrompt, collectSources, extractJsonObject, parseGlosses, resolveBackend, runBackend, splitCommand } from '../../src/agent/narrate';
import { FileTable } from '../../src/session/fileTable';
import { REDACTED } from '../../src/util/redact';
import type { Moment } from '../../src/session/walkthrough';

describe('resolveBackend', () => {
  it('prefers the setting, then claude, then codex, else nothing', () => {
    expect(resolveBackend('my-model --fast "two words"', () => false)).toEqual({ name: 'custom', argv: ['my-model', '--fast', 'two words'] });
    expect(resolveBackend('', () => false)).toBeUndefined();
    expect(resolveBackend(undefined, (n) => n === 'claude')?.argv).toEqual(['claude', '-p', '--output-format', 'json', '--tools', '', '--no-session-persistence']);
    const codex = resolveBackend(undefined, (n) => n === 'codex')!;
    expect(codex.name).toBe('codex');
    expect(codex.argv.slice(0, 3)).toEqual(['codex', 'exec', '--skip-git-repo-check']);
    expect(codex.argv.at(-1)).toBe('-');
    expect(codex.argv.at(-2)).toBe(codex.outputFile);
    expect(splitCommand("a 'b c' d")).toEqual(['a', 'b c', 'd']);
  });
});

describe('runBackend', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-narrate-test-'));
  const fake = (name: string, script: string): string => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return p;
  };
  it('reads claude json, codex last message and a custom command stdout; reports failures with redaction', async () => {
    const claude = fake('claude', 'cat > /dev/null; printf \'{"type":"result","is_error":false,"result":"{\\\\"m0\\\\": \\\\"starts\\\\"}"}\'');
    expect(await runBackend({ name: 'claude', argv: [claude] }, 'p')).toBe('{"m0": "starts"}');
    const bad = fake('claude-bad', 'cat > /dev/null; printf \'{"type":"result","is_error":true,"result":"Not logged in"}\'');
    await expect(runBackend({ name: 'claude', argv: [bad] }, 'p')).rejects.toThrow(/claude reported an error: Not logged in/);
    const out = path.join(bin, 'last.md');
    const codex = fake('codex', 'while [ "$1" != "-o" ]; do shift; done; cat > /dev/null; echo noise; printf \'{"m0": "from codex"}\' > "$2"');
    expect(await runBackend({ name: 'codex', argv: [codex, 'exec', '-o', out, '-'], outputFile: out }, 'p')).toBe('{"m0": "from codex"}');
    const mine = fake('mine', 'read -r first; echo "{\\"m0\\": \\"$first\\"}"');
    expect(await runBackend({ name: 'custom', argv: [mine] }, 'hello\nworld')).toBe('{"m0": "hello"}\n');
    const broken = fake('broken', 'echo "boom sk-abcdefghijklmnopqrstuvwxyz012345" >&2; exit 3');
    const err = await runBackend({ name: 'custom', argv: [broken] }, 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NarrationError);
    expect((err as Error).message).toContain('exited with 3');
    expect((err as Error).message).toContain(REDACTED);
    expect((err as Error).message).not.toContain('sk-abc');
    await expect(runBackend({ name: 'custom', argv: ['no-such-command-xyz'] }, 'p')).rejects.toThrow(/not on the PATH/);
    const slow = fake('slow', 'sleep 5');
    await expect(runBackend({ name: 'custom', argv: [slow] }, 'p', { timeoutMs: 200 })).rejects.toThrow(/took longer/);
  });
});

describe('parseGlosses', () => {
  const ids = ['m0', 'm1', 'm2'];
  it('is strict and tolerant of fences', () => {
    expect(parseGlosses('Sure!\n```json\n{"m0": "a", "m1": "b  c", "zz": "dropped"}\n```', ids)).toEqual({ m0: 'a', m1: 'b c' });
    const long = 'x'.repeat(200);
    expect(parseGlosses(JSON.stringify({ m2: long }), ids)).toEqual({ m2: long.slice(0, 139) + '…' });
    expect(() => parseGlosses('I cannot do that', ids)).toThrow(/not answer with a JSON object/);
    expect(() => parseGlosses('{"m0": ["a"]}', ids)).toThrow(/is not a string/);
    expect(() => parseGlosses('{"other": "a"}', ids)).toThrow(/glossed none/);
    expect(extractJsonObject('text {"a": "}"} more {"b": 1}')).toEqual({ a: '}' });
    expect(extractJsonObject('[1, 2]')).toBeUndefined();
  });
});

describe('buildPrompt and collectSources', () => {
  const moment = (over: Partial<Moment>): Moment => ({ id: 'm0', kind: 'value', step: 1, location: { file: '/w/a.py', line: 3, function: '<module>', fileId: 1 }, text: 'x', values: [], durationMs: null, gloss: null, ...over });
  it('redacts values and source, names files by basename, drops internal fields', () => {
    const template = 'HEAD\n{{walkthrough}}\nMID\n{{sources}}\nTAIL';
    const w = { moments: [moment({ text: "key = 'sk-abcdefghijklmnopqrstuvwxyz012345'", values: [{ role: 'value', name: 'key', text: "'sk-abcdefghijklmnopqrstuvwxyz012345'" }], callee: { file: '/w/a.py', line: 1, function: 'add', fileId: 1 } })] };
    const text = buildPrompt(template, w, [{ file: 'a.py', function: 'add', line: 1, text: 'def add(a, b):\n    token = "sk-abcdefghijklmnopqrstuvwxyz012345"\n    return a + b' }]);
    expect(text.startsWith('HEAD\n{')).toBe(true);
    expect(text.endsWith('\nTAIL')).toBe(true);
    expect(text).toContain('### a.py: add (line 1)');
    expect(text).toContain('```python\ndef add(a, b):');
    expect(text).not.toContain('sk-abc');
    expect(text).toContain(REDACTED);
    expect(text).toContain('"file": "a.py"');
    expect(text).not.toContain('callee');
    expect(text).not.toContain('/w/a.py');
    expect(buildPrompt(template, { moments: [] }, [])).toContain('(no user source available)');
  });
  it('collects the module and the functions the moments touch, user files only, capped', () => {
    const files = new FileTable();
    const src = ['def add(a, b):', '    return a + b', '', 'n = add(1, 2)', ''];
    files.add({ fileId: 1, path: '/w/main.py', rangeBase: 0, ranges: [[0, 0, 0, 0], [1, 0, 2, 16], [2, 4, 2, 16], [4, 0, 4, 13]], statements: [1, 2, 3], functions: [{ rid: 1, name: 'add', bodyRange: [1, 0, 2, 16] }], magic: [] });
    files.add({ fileId: 2, path: '/w/venv/site-packages/lib/x.py', rangeBase: 10, ranges: [[0, 0, 0, 0]], statements: [], functions: [], magic: [] });
    const inputs = { files, readSource: (fid: number) => (fid === 1 ? src : ['lib']), mainFile: '/w/main.py', workspaceRoot: '/w' };
    const moments = [moment({ location: { file: '/w/main.py', line: 4, function: '<module>', fileId: 1 }, callee: { file: '/w/main.py', line: 1, function: 'add', fileId: 1 } }), moment({ id: 'm1', location: { file: '/w/venv/site-packages/lib/x.py', line: 1, function: 'f', fileId: 2 } }), moment({ id: 'm2', location: { file: '/w/main.py', line: 4, function: '<module>', fileId: 1 } })];
    expect(collectSources(inputs, moments)).toEqual([
      { file: 'main.py', function: '<module>', line: 1, text: src.join('\n') },
      { file: 'main.py', function: 'add', line: 1, text: 'def add(a, b):\n    return a + b' },
    ]);
  });
});

describe('GlossCache', () => {
  it('keeps glosses per session and run', () => {
    const c = new GlossCache();
    c.set('s1', 'r-1', { m0: 'a' });
    expect(c.get('s1', 'r-1')).toEqual({ m0: 'a' });
    expect(c.get('s1', 'r-2')).toBeUndefined();
    expect(c.get('s2', 'r-1')).toBeUndefined();
    c.set('s1', 'r-2', { m0: 'b' });
    expect(c.get('s1', 'r-1')).toBeUndefined();
    c.clear('s1');
    expect(c.get('s1', 'r-2')).toBeUndefined();
  });
});
