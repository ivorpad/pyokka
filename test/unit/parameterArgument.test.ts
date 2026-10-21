/** The TypeScript twin of `parameter_argument` gives the Python answers (`python/tests/test_parameter_argument.py` writes the cases). */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { ArgumentText, CallArguments, DefParameters } from '../../src/shared/protocol';
import { parameterArgument } from '../../src/session/parameterArgument';

interface Case {
  call: string;
  scope: string;
  name: string;
  values: Record<string, string>;
  made: string | null;
  index: number;
  entered: number;
  params: DefParameters;
  args: CallArguments[];
  argument: ArgumentText | null;
}

const cases = (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'parameter-argument.json'), 'utf8')) as { cases: Case[] }).cases;

describe('parameterArgument', () => {
  it.each(cases.map((c) => [`${c.call} ${c.scope}.${c.name}`, c] as const))('%s', (_, c) => {
    expect(parameterArgument(c.name, c.scope, c.params, c.args, (t) => c.values[t], c.made ?? undefined, c.index, c.entered) ?? null).toEqual(c.argument);
  });
});
