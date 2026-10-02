import { defineConfig } from '@vscode/test-cli';
export default defineConfig({
  files: ['test/e2e/libdiag.test.js'],
  workspaceFolder: './examples',
  mocha: { ui: 'bdd', timeout: 300_000 },
  launchArgs: ['--disable-workspace-trust'],
  env: { PYOKKA_E2E: '1' },
});
