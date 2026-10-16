// Keeps the e2e VS Code window minimized for the whole run. The suite runs for many minutes and its
// window would otherwise open over whatever the person is doing and take the focus back every
// time a CLI test opens a vscode:// URI. Every vscode-test config calls keepTestWindowMinimized(),
// so the rule holds whichever command starts the run (npm run test:e2e, vscode-test --config,
// --grep, a second config at the same time). A poll every second finds the Electron process
// started with this checkout's --extensionDevelopmentPath and asks System Events to minimize its
// windows, so a window that comes back up goes down again within a second.
//
// System Events needs the Accessibility permission of the app the terminal runs in (System
// Settings > Privacy & Security > Accessibility). Refused, the run goes on with the window up,
// after one line saying so. PYOKKA_UI_PASS=1 leaves the window up: that pass photographs the screen.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARK = `--extensionDevelopmentPath=${REPO}`;

const run = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => resolve({ err, stdout, stderr })),
  );

// The pids of the test VS Code's main processes: the Electron started with this checkout as its
// extension development path. Chromium helpers (--type=...) have no windows of their own.
async function testWindowPids() {
  const { stdout } = await run('ps', ['-axo', 'pid=,command=']);
  const pids = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes(MARK) || line.includes('--type=')) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (pid && pid !== process.pid) pids.push(pid);
  }
  return pids;
}

const minimizeScript = (pid) => `tell application "System Events"
  set n to 0
  repeat with p in (every process whose unix id is ${pid})
    repeat with w in (every window of p)
      if value of attribute "AXMinimized" of w is false then
        set value of attribute "AXMinimized" of w to true
        set n to n + 1
      end if
    end repeat
  end repeat
  return n
end tell`;

export function keepTestWindowMinimized() {
  if (process.platform !== 'darwin' || process.env.PYOKKA_UI_PASS === '1') return;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const pid of await testWindowPids()) {
        const { err, stderr } = await run('osascript', ['-e', minimizeScript(pid)]);
        if (err) {
          clearInterval(timer);
          const why = stderr.trim().split('\n')[0] || err.message;
          console.error(
            `e2e: the test window stays up, System Events could not minimize it (${why}). ` +
              'Grant the terminal app Accessibility in System Settings > Privacy & Security.',
          );
          return;
        }
      }
    } finally {
      busy = false;
    }
  }, 1000);
  // The vscode-test process waits on VS Code, not on this timer.
  timer.unref();
}
