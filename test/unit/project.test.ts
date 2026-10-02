import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { looksLikeProject } from '../../src/config/project';

describe('looksLikeProject', () => {
  it('detects marker files and ignores scratch folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyokka-proj-'));
    const scratch = path.join(root, 'scratch');
    const proj = path.join(root, 'proj');
    fs.mkdirSync(scratch);
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(looksLikeProject([scratch])).toBe(false);
    expect(looksLikeProject([undefined, scratch, proj])).toBe(true);
    expect(looksLikeProject([path.join(root, 'missing')])).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
