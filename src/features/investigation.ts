/**
 * Investigate a Value, Learn from This Run, Pin Run as Baseline, Verify Fix: the `investigate`,
 * `learn`, `pin` and `verify` commands of the CLI over the active session's run.
 *
 * Each one writes the session's recording to a private run.json (`sessionRecording`), runs
 * `python -m pyokka_runtime VERB` on it from the runtime directory, and shows the command's text
 * in a Markdown preview. Only Verify Fix runs the program, and only as a normal run of the session.
 * Each takes its inputs as a command argument too (`{name}`, `{step, prediction}`, `{expect}`),
 * so a keybinding, an agent or a test skips the prompts.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Session } from '../session/session';
import { awaitIdle, sessionRecording } from '../agent/bridgeSupport';

export interface InvestigationArgs {
  name?: string;
  step?: number;
  prediction?: string;
  expect?: string;
}

/** The text a command showed last, for tests (`api.lastInvestigation`). */
let shown: string | undefined;
export const lastInvestigation = (): string | undefined => shown;

export function registerInvestigation(context: vscode.ExtensionContext, runtimeDir: string, active: () => Session | undefined): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-investigation-'));
  const baselines = new Map(Object.entries(context.workspaceState.get<Record<string, string>>('pyokka.investigation.baselines', {})));
  const pinnedDir = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'baselines');
  let serial = 0;
  context.subscriptions.push({ dispose: () => fs.rmSync(dir, { recursive: true, force: true }) });

  async function snapshot(s: Session): Promise<string> {
    await awaitIdle(s);
    if (s.running && !s.debug.paused) throw new Error('Wait for the run to finish, or pause it, before reading it.');
    const doc = sessionRecording(s);
    if (!doc) throw new Error('Run the file first: there is no recording to read.');
    // what `verify --rerun` and Verify Fix read back: the settings and arguments this run had
    Object.assign(doc.meta as Record<string, unknown>, { config: { ...s.config.run, recordLocals: s.recordLocals, http: s.http }, argv: s.argvOverride ?? s.config.argv });
    const file = path.join(dir, `run-${++serial}.json`);
    fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    return file;
  }

  /** `python -m pyokka_runtime ARGS` with the session's interpreter; a nonzero exit with output is an answer (verify FAIL). */
  function cli(s: Session, args: string[]): Promise<string> {
    return new Promise((resolve, reject) =>
      execFile(s.interpreter.path, ['-m', 'pyokka_runtime', ...args], { cwd: runtimeDir, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (error, stdout, stderr) => {
        if (error && !stdout) reject(new Error((stderr || error.message).trim()));
        else resolve(stdout);
      }),
    );
  }

  async function show(content: string): Promise<void> {
    shown = content;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'markdown' }), { preview: true });
  }

  const register = (name: string, action: (s: Session, args: InvestigationArgs) => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(`pyokka.${name}`, async (arg?: unknown) => {
        const s = active();
        if (!s) {
          void vscode.window.showInformationMessage('Start Pyokka on a file first.');
          return;
        }
        const args = arg && typeof arg === 'object' && !Array.isArray(arg) && !(arg instanceof vscode.Uri) ? (arg as InvestigationArgs) : {};
        try {
          await action(s, args);
        } catch (error) {
          void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
        }
      }),
    );
  };

  register('investigateValue', async (s, args) => {
    const name = args.name ?? (await vscode.window.showInputBox({ prompt: 'Which value is wrong? A variable or attribute path (total, self.balance).', ignoreFocusOut: true }));
    if (!name) return;
    await show(await cli(s, ['investigate', await snapshot(s), '--value', name]));
  });

  register('learnRun', async (s, args) => {
    const run = await snapshot(s);
    let step = args.step;
    if (step === undefined) {
      const lesson = JSON.parse(await cli(s, ['learn', run, '--json'])) as { checkpoints?: { step: number; kind: string; source?: string }[] };
      const chosen = (await vscode.window.showQuickPick(
        (lesson.checkpoints ?? []).map((c) => ({ label: `Step ${c.step}`, description: c.kind, detail: c.source, step: c.step })),
        { title: 'Choose a checkpoint to predict' },
      )) as { step: number } | undefined;
      if (!chosen) return;
      step = chosen.step;
    }
    const prediction = args.prediction ?? (await vscode.window.showInputBox({ prompt: 'What value, branch or outcome do you expect at this checkpoint?', ignoreFocusOut: true }));
    if (prediction === undefined) return;
    await show(await cli(s, ['learn', run, '--at', String(step), '--prediction', prediction, '--reveal']));
  });

  register('pinRun', async (s) => {
    const run = await snapshot(s);
    fs.mkdirSync(pinnedDir, { recursive: true, mode: 0o700 });
    const pinned = path.join(pinnedDir, `${createHash('sha256').update(s.filePath).digest('hex').slice(0, 16)}-${Date.now()}.json`);
    await show(await cli(s, ['pin', run, '--out', pinned]));
    baselines.set(s.filePath, pinned);
    await context.workspaceState.update('pyokka.investigation.baselines', Object.fromEntries(baselines));
    void vscode.window.showInformationMessage('Baseline pinned for this file. Edit the code, then run Verify Fix.');
  });

  register('verifyFix', async (s, args) => {
    const baseline = baselines.get(s.filePath);
    if (!baseline || !fs.existsSync(baseline)) throw new Error('Pin the failing run first (Pyokka: Pin Run as Baseline).');
    if (s.debug.paused) throw new Error('Continue or stop the paused program before running the fix.');
    const expected = args.expect ?? (await vscode.window.showInputBox({ prompt: 'Expected final value, NAME=VALUE as its repr (total=42). Leave empty to compare only.', ignoreFocusOut: true }));
    if (expected === undefined) return;
    const originalHttp = s.http;
    const baselineConfig = (JSON.parse(fs.readFileSync(baseline, 'utf8')) as { meta?: { config?: { http?: string } } }).meta?.config;
    try {
      // a baseline that recorded its HTTP calls is compared with a rerun that replays them, not new live calls
      if (baselineConfig?.http === 'record') s.setHttp('replay');
      s.setRecordLocals(true);
      await s.runNow('verify fix');
      const after = await snapshot(s);
      await show(await cli(s, ['verify', baseline, '--after', after, ...(expected ? ['--expect', expected] : [])]));
    } finally {
      s.setHttp(originalHttp);
    }
  });
}
