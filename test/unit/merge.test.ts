import { describe, expect, it } from 'vitest';
import { mergeConfigSources, readPyokkaTableFromToml, toRunConfig, parseEnvParams, splitArgs, DEFAULT_RUN_CONFIG } from '../../src/config/merge';

describe('config merge order', () => {
  it('later sources win, nested objects merge', () => {
    const settings = { logLimit: 5, logLimits: { inline: { depth: 2, elements: 10 } } };
    const home = { logLimit: 50, autoLog: true };
    const pyproject = { logLimits: { inline: { depth: 9 } }, runTimeout: 1000 };
    const dotfile = { autoLog: false };
    const merged = mergeConfigSources(settings, home, undefined, pyproject, dotfile);
    expect(merged).toEqual({ logLimit: 50, autoLog: false, logLimits: { inline: { depth: 9, elements: 10 } }, runTimeout: 1000 });
    const run = toRunConfig(merged);
    expect(run.logLimit).toBe(50);
    expect(run.timeoutMs).toBe(1000);
    expect(run.logLimits.inline).toEqual({ depth: 9, elements: 10 });
    expect(run.logLimits.values).toEqual(DEFAULT_RUN_CONFIG.logLimits.values);
    expect(run.autoLog).toBe(false);
  });

  it('maps secrets.mask / secrets.names and defaults to masking', () => {
    expect(toRunConfig({}).secrets).toEqual({ mask: true, names: [] });
    expect(toRunConfig({ secrets: { mask: false, names: ['licence', 3] } }).secrets).toEqual({ mask: false, names: ['licence', '3'] });
    expect(toRunConfig({ secrets: { mask: 'no' } }).secrets.mask).toBe(true);
  });

  it('maps timeMachine.recordLocals and ignores junk', () => {
    const run = toRunConfig({ timeMachine: { recordLocals: true }, maxTraceSteps: 'lots', plugins: ['a', 2] });
    expect(run.recordLocals).toBe(true);
    expect(run.maxTraceSteps).toBe(DEFAULT_RUN_CONFIG.maxTraceSteps);
    expect(run.plugins).toEqual(['a', '2']);
  });

  it('maps http to off / record / replay and defaults to off', () => {
    expect(DEFAULT_RUN_CONFIG.http).toBe('off');
    expect(toRunConfig({}).http).toBe('off');
    expect(toRunConfig({ http: 'record' }).http).toBe('record');
    expect(toRunConfig({ http: 'replay' }).http).toBe('replay');
    expect(toRunConfig({ http: 'on' }).http).toBe('off');
    expect(toRunConfig({ http: true }).http).toBe('off');
  });

  it('maps httpObserve to a boolean that defaults to on', () => {
    expect(DEFAULT_RUN_CONFIG.httpObserve).toBe(true);
    expect(toRunConfig({}).httpObserve).toBe(true);
    expect(toRunConfig({ httpObserve: false }).httpObserve).toBe(false);
    expect(toRunConfig({ httpObserve: 'no' }).httpObserve).toBe(true);
    expect(toRunConfig({ http: 'replay', httpObserve: false })).toMatchObject({ http: 'replay', httpObserve: false });
  });
});

describe('pyproject [tool.pyokka]', () => {
  it('reads scalars, arrays, inline tables and sub-tables', () => {
    const toml = `
[project]
name = "demo"

[tool.pyokka]  # comment
logLimit = 42
autoLog = true
plugins = ["x", 'y']
hints = { ignoreCoverage = "skip" }

[tool.pyokka.logLimits.inline]
depth = 3

[tool.other]
logLimit = 1
`;
    expect(readPyokkaTableFromToml(toml)).toEqual({ logLimit: 42, autoLog: true, plugins: ['x', 'y'], hints: { ignoreCoverage: 'skip' }, logLimits: { inline: { depth: 3 } } });
    expect(readPyokkaTableFromToml('[project]\nname = "x"\n')).toBeUndefined();
  });
});

describe('env / args parsing', () => {
  it('parses A=1;B=2 and quoted args', () => {
    expect(parseEnvParams('A=1; B = two ;bad;=x')).toEqual({ A: '1', B: 'two' });
    expect(splitArgs('--name "John Doe" -v \'x y\'')).toEqual(['--name', 'John Doe', '-v', 'x y']);
  });
});
