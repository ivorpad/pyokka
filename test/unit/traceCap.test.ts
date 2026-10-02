/** The step cap said in words (src/shared/traceCap.ts) and the recording limits in the run config. */
import { describe, expect, it } from 'vitest';
import { displayCap, excludeFor } from '../../src/shared/traceCap';
import { toRunConfig } from '../../src/config/merge';

describe('traceCap', () => {
  it('suggests a path for a project file and a dotted module for a library file', () => {
    expect(excludeFor('/w/pkg/flash/parser.py', '/w')).toBe('pkg/flash/parser.py');
    expect(excludeFor('/w/.venv/lib/python3.12/site-packages/litellm/utils.py', '/w')).toBe('litellm.utils');
    expect(excludeFor('/w/.venv/lib/python3.12/site-packages/pymupdf/__init__.py', '/w')).toBe('pymupdf');
  });
  it('shows paths relative to the workspace and skips the program file for the exclude', () => {
    const cap = displayCap({ cap: 10, stepsRun: 500, spentBy: [{ path: '/w/run.py', steps: 400 }, { path: '/w/pkg/heavy.py', steps: 90 }] }, '/w', '/w/run.py');
    expect(cap).toEqual({ cap: 10, stepsRun: 500, spentBy: [{ path: 'run.py', steps: 400 }, { path: 'pkg/heavy.py', steps: 90 }], exclude: 'pkg/heavy.py' });
  });
});

describe('recording limits in the run config', () => {
  it('carries timeMachine.exclude and maxValueChars to the runner', () => {
    const run = toRunConfig({ timeMachine: { exclude: ['pkg.flash', ' '] }, maxValueChars: 0 });
    expect(run.exclude).toEqual(['pkg.flash']);
    expect(run.maxValueChars).toBe(0);
  });
  it('leaves both out when unset, so the runtime defaults apply', () => {
    const run = toRunConfig({});
    expect(run.exclude).toBeUndefined();
    expect(run.maxValueChars).toBeUndefined();
  });
});
