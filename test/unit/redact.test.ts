import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redact, redactValueBag, REDACTED } from '../../src/util/redact';

// Slack-shaped tokens are spelled `<xox>` in the fixture so secret scanners do not take the fake one for a real token.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'redact.json'), 'utf8').replaceAll('<xox>', 'xox')) as { cases: [string, string][] };

describe('redact', () => {
  for (const [input, expected] of fixture.cases) {
    it(`fixture: ${input.slice(0, 50)}`, () => {
      expect(redact(input)).toBe(expected);
    });
  }

  it('is idempotent', () => {
    for (const [, expected] of fixture.cases) expect(redact(expected)).toBe(expected);
  });

  it('keeps empty and plain text', () => {
    expect(redact('')).toBe('');
    expect(redact("{'is_awesome': True, 'python': '3.12.4'}")).toBe("{'is_awesome': True, 'python': '3.12.4'}");
  });

  it('keeps a URL readable: a token in its path goes, a query with its values stripped stays', () => {
    expect(redact(`POST https://hooks.slack.com/services/T000/B000/${'xox'}b-123456789012-abcdefghijklmnop`)).toBe(`POST https://hooks.slack.com/services/T000/B000/${REDACTED}`);
    expect(redact('https://api.openai.com/v1/responses?key&v=1')).toBe('https://api.openai.com/v1/responses?key&v=1');
    expect(redact('https://user:pw@localhost:8765/hello')).toBe('https://user:pw@localhost:8765/hello');
  });

  it('redacts a quoted Authorization value as a whole', () => {
    expect(redact("headers = {'Authorization': 'Bearer abcdefghijklmnop'}")).toBe(`headers = {'Authorization': '${REDACTED}'}`);
  });

  it('walks value trees', () => {
    const bag = redactValueBag({
      runtimeKey: 'k',
      data: { type: 'dict', id: '1', queryPath: [], props: [{ name: 'OPENAI_API_KEY', type: 'str', id: '2', queryPath: ['OPENAI_API_KEY'], value: "'sk-abcdefghijklmnopqrstuvwxyz'" }] },
    });
    expect(bag.data.props?.[0]?.value).toBe(`'${REDACTED}'`);
    expect(bag.data.props?.[0]?.name).toBe('OPENAI_API_KEY');
  });
});

describe('redact cost', () => {
  it('is linear in the length of a line, not quadratic', () => {
    // KEY_VALUE_RE's leading `[A-Za-z0-9_.-]*` used to restart at every offset of a run of those
    // characters and backtrack the length of the run at each one. A guard, not a benchmark: the
    // budget is loose enough to survive a busy machine and tight enough to catch the quadratic.
    const cost = (text: string): number => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        redact(text);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const small = cost('a'.repeat(8 * 1024));
    const large = cost('a'.repeat(64 * 1024));
    expect(large).toBeLessThan(200);
    expect(large).toBeLessThan(small * 24 + 10);
  });
});
