import { describe, expect, it, vi } from 'vitest';
import { appendGitignoreLine, gitignoreCoversReplay } from '../../src/features/replayGitignore';

// the module imports vscode for the prompt; the pure helpers under test never touch it
vi.mock('vscode', () => ({}));

describe('gitignoreCoversReplay', () => {
  it('accepts the replay directory, its parent and the alternate directory, anchored or not, with or without a slash', () => {
    for (const line of ['.pyokka', '.pyokka/', '.pyokka/replay', '.pyokka/replay/', '.pyokka-replay', '.pyokka-replay/', '/.pyokka/replay/', '**/.pyokka/', '  .pyokka/replay/  ', '.pyokka/**', '.pyokka/*', '.pyokka/replay/**', '.pyokka-replay/*']) {
      expect(gitignoreCoversReplay(`node_modules/\n${line}\ndist/\n`), line).toBe(true);
    }
  });
  it('rejects unrelated, commented or negated lines and an empty file', () => {
    for (const text of ['', 'node_modules/\ndist/\n', '# .pyokka/replay/\n', '!.pyokka/replay/\n', '.pyokka.json\n', '.pyokka/cache/\n', 'pyokka/replay/\n', '*.jsonl\n']) {
      expect(gitignoreCoversReplay(text), JSON.stringify(text)).toBe(false);
    }
  });
  it('reads CRLF files', () => {
    expect(gitignoreCoversReplay('dist/\r\n.pyokka/replay/\r\n')).toBe(true);
  });
});

describe('appendGitignoreLine', () => {
  it('starts a missing file with the line', () => {
    expect(appendGitignoreLine('', '.pyokka/replay/')).toBe('.pyokka/replay/\n');
  });
  it('keeps the text and ends it with exactly one newline before the line', () => {
    expect(appendGitignoreLine('dist/', '.pyokka/replay/')).toBe('dist/\n.pyokka/replay/\n');
    expect(appendGitignoreLine('dist/\n', '.pyokka/replay/')).toBe('dist/\n.pyokka/replay/\n');
    expect(appendGitignoreLine('dist/\n\n\n', '.pyokka/replay/')).toBe('dist/\n.pyokka/replay/\n');
    expect(appendGitignoreLine('# keep\ndist/\r\n', '.pyokka-replay/')).toBe('# keep\ndist/\n.pyokka-replay/\n');
  });
});
