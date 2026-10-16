import { defineConfig } from '@vscode/test-cli';
import { keepTestWindowMinimized } from './test/e2e/minimized.mjs';

// The test window stays minimized for the whole run (test/e2e/minimized.mjs).
keepTestWindowMinimized();
export default defineConfig({
  files: ['test/e2e/libdiag.test.js'],
  workspaceFolder: './examples',
  mocha: { ui: 'bdd', timeout: 300_000 },
  launchArgs: ['--disable-workspace-trust'],
  env: { PYOKKA_E2E: '1' },
});
