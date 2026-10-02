import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// skills/pyokka/scripts/render-tour.cjs: a merged tour (`pyokka tour RUN --prose P --out F`)
// becomes one page with no scripts. The example is the RRF fixture merged with
// python/tests/fixtures/tour/rrf.prose.json.

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL = path.join(ROOT, 'skills', 'pyokka');
const RENDERER = path.join(SKILL, 'scripts', 'render-tour.cjs');
const EXAMPLE = path.join(SKILL, 'templates', 'tour.example.json');

function example(): Record<string, any> {
  return JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
}

function run(data: unknown, args: string[] = []): { html: string; stderr: string; ok: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-'));
  const input = path.join(dir, 'tour.json');
  const output = path.join(dir, 'tour.html');
  fs.writeFileSync(input, JSON.stringify(data));
  try {
    execFileSync(process.execPath, [RENDERER, input, output, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { html: fs.readFileSync(output, 'utf8'), stderr: '', ok: true };
  } catch (error) {
    return { html: '', stderr: String((error as { stderr?: string }).stderr ?? ''), ok: false };
  }
}

describe('render-tour.cjs', () => {
  it('renders intro, chapter map, folding chapters and one card per pick, with no script', () => {
    const data = example();
    const { html, ok } = run(data);
    expect(ok).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(`<p class=intro>${data.intro.split(' ').slice(0, 4).join(' ')}`);
    expect(html.match(/<details class=ch /g)?.length).toBe(new Set(data.pick.map((id: string) => data.candidates.find((c: any) => c.id === id).chapter)).size);
    expect(html.match(/<div class=stop /g)?.length).toBe(data.pick.length);
    expect(html).toContain('<ol class=map>');
    expect(html).toContain('steps 53 to 103');
    expect(html).toContain('<details class=vals>');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('shows the quoted slice Pyokka cut and says when the recording had cut the value', () => {
    const { html } = run(example());
    expect(html).toContain('<blockquote>&#39;C&#39;: 0.03252247488101534</blockquote>');
    expect(html).toContain('characters 54 to 78 of 119');
    expect(html).toContain('The recording kept only the first 119 characters');
  });

  it('turns backticks into code and escapes everything else', () => {
    const data = example();
    const first = data.candidates.find((c: any) => c.id === data.pick[0]);
    first.prose.text = 'calls `rank<k>` with <b>bold</b>';
    const { html } = run(data);
    expect(html).toContain('calls <code>rank&lt;k&gt;</code> with &lt;b&gt;bold&lt;/b&gt;');
  });

  it('writes a repeated value as "same as" the first one', () => {
    const data = example();
    const c = data.candidates.find((x: any) => x.id === data.pick[1]);
    const target = data.candidates.find((x: any) => x.id === data.pick[0]).values[0];
    c.values.push({ id: `${c.id}.v9`, role: 'set', name: 'again', length: target.length, sameAs: target.id });
    const { html } = run(data);
    expect(html).toContain(`same as <code>${target.name}</code> at #3`);
  });

  it('refuses a tour without prose and a pick that is not a candidate', () => {
    const plain = example();
    delete plain.prose;
    expect(run(plain).stderr).toContain('This tour has no prose');
    const bad = example();
    bad.pick.push('s999-ffffff');
    expect(run(bad).stderr).toContain('pick names s999-ffffff');
  });

  it('takes --title', () => {
    const { html } = run(example(), ['--title', 'Why C wins']);
    expect(html).toContain('<title>Why C wins</title>');
    expect(html).toContain('<h1>Why C wins</h1>');
  });
});
