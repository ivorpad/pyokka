import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The renderer of `skills/pyokka`: it turns what `pyokka history` writes into one
// standalone page, and it refuses data it cannot draw honestly. Both halves are tested here,
// because a page that renders a broken range is worse than a command that failed and said why.

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL = path.join(ROOT, 'skills', 'pyokka');
const RENDERER = path.join(SKILL, 'scripts', 'render-code-history.cjs');
const EXAMPLE = path.join(SKILL, 'templates', 'code-history.example.json');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-history-'));
}

function render(data: unknown, name = 'page.html', args: string[] = []): { html: string; dir: string } {
  const dir = tempDir();
  const input = path.join(dir, 'history.json');
  const output = path.join(dir, name);
  fs.writeFileSync(input, typeof data === 'string' ? data : JSON.stringify(data));
  execFileSync(process.execPath, [RENDERER, input, output, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { html: fs.readFileSync(output, 'utf8'), dir };
}

function example(): Record<string, any> {
  return JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
}

function embedded(html: string): Record<string, any> {
  const after = html.split('<script id="data" type="application/json">')[1];
  expect(after).toBeDefined();
  const json = (after as string).split('</script>')[0];
  return JSON.parse(json as string);
}

function refuse(mutate: (data: Record<string, any>) => void, args: string[] = []): string {
  const data = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  mutate(data);
  const dir = tempDir();
  const input = path.join(dir, 'history.json');
  fs.writeFileSync(input, JSON.stringify(data));
  try {
    execFileSync(process.execPath, [RENDERER, input, path.join(dir, 'page.html'), ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? '');
  }
  throw new Error('expected the renderer to refuse this data');
}

describe('code-history renderer', () => {
  it('renders the bundled example into a standalone page', () => {
    const { html } = render(fs.readFileSync(EXAMPLE, 'utf8'));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Why the total is 15</title>');
    // nothing is fetched at view time: no CDN, no external stylesheet, no browser-side Handlebars
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toContain('https://');
  });

  it('colours the source with Shiki at render time, and the colours stay on their own line', () => {
    const { html } = render(fs.readFileSync(EXAMPLE, 'utf8'));
    const { highlight, files } = embedded(html);
    expect(highlight.theme).toBe('github-dark-dimmed');
    const rows: [number, string][][] = highlight.files['main.py'];
    // One row per source line, and each row joins back to the exact line it came from. Colours
    // that slipped by a line would be describing a different statement, which is the one thing
    // this page may never do.
    expect(rows).toHaveLength(files['main.py'].length);
    rows.forEach((row, index) => expect(row.map(token => token[1]).join('')).toBe(files['main.py'][index]));
    const colour = new Map(rows[0]!.map(([at, text]) => [text, highlight.palette[at]]));
    expect(colour.get('def')).toBeTruthy();
    expect(colour.get('def')).not.toBe(colour.get(' '));
    expect(html).not.toContain('https://');  // the theme is resolved here, not fetched there
  });

  it('takes a theme, and names the ones it does not have', () => {
    const { html } = render(fs.readFileSync(EXAMPLE, 'utf8'), 'page.html', ['--theme', 'rose-pine-moon']);
    expect(embedded(html).highlight.theme).toBe('rose-pine-moon');
    expect(refuse(() => {}, ['--theme', 'a nice blue'])).toContain('Unknown theme "a nice blue"');
  });

  it('generates the colours itself rather than trusting what it was handed', () => {
    const data = example();
    data.highlight = { theme: 'mine', fg: '#fff', palette: ['#fff'], files: { 'main.py': [[[0, 'not the source']]] } };
    const { highlight } = embedded(render(data).html);
    expect(highlight.theme).toBe('github-dark-dimmed');
    expect(highlight.files['main.py'][0].map((token: [number, string]) => token[1]).join('')).toBe('def scale(value, factor=3):');
  });

  it('carries the run identity and every checkpoint with its reproducing command', () => {
    const { html } = render(fs.readFileSync(EXAMPLE, 'utf8'));
    const data = embedded(html);
    expect(data.steps).toHaveLength(4);
    expect(data.steps.map((s: { id: string }) => s.id)).toEqual(['step-7', 'step-8', 'why-22-answer', 'pause-1']);
    for (const step of data.steps) expect(step.verify.startsWith('pyokka ')).toBe(true);
    expect(html).toContain('<b>source</b> 0000000000abcd');
    expect(html).toContain('<b>steps</b> 23');
    // what Pyokka has and a one-frame debugger does not: in/out, hit counts, the arm, the chain
    expect(data.steps[1].call).toEqual({ name: 'scale', in: ['value = 1', 'factor = 3'], out: 'return = 3' });
    expect(data.steps[0].hits).toBe(3);
    expect(data.steps[0].arm).toContain('took False x2, True x1');
    expect(data.steps[2].chain.map((n: { depth: number }) => n.depth)).toEqual([0, 1, 1]);
  });

  it('fills the English navigation labels and leaves lang free', () => {
    const { html } = render(fs.readFileSync(EXAMPLE, 'utf8'));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('← Previous');
    expect(html).toContain('Next →');
    const spanish = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    spanish.lang = 'es';
    spanish.labels = { prev: '← Anterior', next: 'Siguiente →' };
    const out = render(spanish).html;
    expect(out).toContain('<html lang="es">');
    expect(out).toContain('← Anterior');
    expect(out).toContain('verify');  // labels not overridden keep the English default
  });

  it('draws every word of its own in the language `lang` names', () => {
    const page = (lang: string) => {
      const data = example();
      data.lang = lang;
      return render(data).html;
    };
    const es = page('es');
    for (const word of ['← Anterior', 'Siguiente →', 'HISTORIA DEL CÓDIGO', '<b>pasos</b>', '<b>código</b>']) expect(es).toContain(word);
    for (const word of ['Previous', 'Next →', 'CODE STORY', '<b>steps</b>', '<b>source</b>']) expect(es).not.toContain(word);
    expect(embedded(es).labels).toMatchObject({ verify: 'verificar', hits: 'veces', in: 'entra' });
    expect(page('es-MX')).toContain('← Anterior');
    // a language with no label set falls back to English, keeping its own lang attribute
    const fr = page('fr');
    expect(fr).toContain('<html lang="fr">');
    expect(fr).toContain('← Previous');
  });

  it('omits an empty prose box rather than drawing a blank one', () => {
    const bare = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    for (const key of ['eyebrow', 'heading', 'subtitle', 'summary', 'scope']) bare[key] = '';
    const { html } = render(bare);
    expect(html).not.toContain('class="summary"');
    expect(html).not.toContain('<h1>');
    expect(html).toContain('class="chips"');  // the generated identity is still there
  });

  it('refuses data it cannot draw honestly', () => {
    expect(refuse(d => { d.steps[0].end = 9999; })).toContain('invalid source range or focus');
    expect(refuse(d => { d.steps[0].kind = 'a hunch'; })).toContain('unknown evidence kind');
    expect(refuse(d => { d.steps[1].id = 'step-7'; })).toContain('duplicate id');
    expect(refuse(d => { d.steps[0].verify = 'trust me'; })).toContain('verify must be the pyokka command');
    expect(refuse(d => { d.steps[0].bright = [1]; })).toContain('invalid highlighted lines');
    expect(refuse(d => { delete d.meta; })).toContain('Expected meta');
    expect(refuse(d => { d.steps = []; })).toContain('At least one checkpoint');
    expect(refuse(d => { d.steps[0].file = 'ghost.py'; })).toContain('source must be an array of lines');
  });

  it('keeps the four evidence kinds apart', () => {
    // a live pause records nothing behind it, and a static checkpoint observed nothing
    expect(refuse(d => { d.steps[3].chain = [{ depth: 0, via: 'root', name: 'x', text: '1' }]; }))
      .toContain('a live pause records nothing behind it');
    expect(refuse(d => { d.steps[0].kind = 'static source'; }))
      .toContain('a static-source checkpoint has no observed values');
  });

  it('names the checkpoint in every refusal, so the author knows which card to fix', () => {
    expect(refuse(d => { d.steps[2].focus = 1; })).toContain('Checkpoint 3 (why-22-answer)');
  });
});
