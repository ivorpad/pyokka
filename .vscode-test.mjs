import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';

// A fresh PYOKKA_HOME per run: sessions, the relaunch memory, recent files and the library cache
// of the test window never meet the user's ~/.pyokka or another e2e run. Short and under /tmp so
// the session sockets inside it stay well under the 104-byte sun_path limit of macOS.
const PYOKKA_HOME = mkdtempSync('/tmp/pk-e2e-');

// Note: @vscode/test-electron always passes --disable-workspace-trust, so the
// untrusted-workspace gate (pyokka.untrustedWorkspaceBehavior) cannot be exercised
// here; verify it in a dev host with a fresh --user-data-dir instead.
export default defineConfig({
  files: ['test/e2e/demo.test.js', 'test/e2e/features.test.js', 'test/e2e/uipass.test.js', 'test/e2e/bridge.test.js', 'test/e2e/cli-live.test.js', 'test/e2e/walkthrough.test.js', 'test/e2e/tour.test.js', 'test/e2e/execution-diagram.test.js', 'test/e2e/why.test.js', 'test/e2e/exceptions.test.js', 'test/e2e/values-as-of.test.js', 'test/e2e/http-replay.test.js', 'test/e2e/code-story.test.js', 'test/e2e/library-cache.test.js', 'test/e2e/replay-session.test.js', 'test/e2e/debugger.test.js', 'test/e2e/debug-live.test.js', 'test/e2e/debug-stop.test.js', 'test/e2e/debug-exceptions.test.js', 'test/e2e/debug-session.test.js', 'test/e2e/debug-server.test.js', 'test/e2e/debug-cli-cold.test.js', 'test/e2e/debug-recording.test.js', 'test/e2e/debug-stream.test.js', 'test/e2e/debug-inline-values.test.js', 'test/e2e/diff-live.test.js', 'test/e2e/debug-record-from.test.js', 'test/e2e/debug-band.test.js'],
  workspaceFolder: './examples',
  mocha: { ui: 'bdd', timeout: 180_000 },
  launchArgs: ['--disable-workspace-trust', '--disable-extension=ms-python.vscode-pylance'],
  env: { PYOKKA_E2E: '1', PYOKKA_HOME },
});
