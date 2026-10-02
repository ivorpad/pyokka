# Pyokka QA plan

A test plan for the whole extension and the `pyokka` CLI, written for a QA agent with shell
access to this checkout. A person can follow the same steps. `README.md` is the specification
each case checks against; when the two disagree, that is a finding.

Baseline this plan was written against: commit `9aa2534` (main, 2026-09-12), macOS arm64,
VS Code 1.137.0, Python 3.14.6 on the PATH and 3.12.9 in `python/.venv`. Automated suites on
that day: typecheck clean, vitest 40 files / 362 tests passing, pytest 295 passed and 1 skipped.

## 0. Read this first

**What to record for every case.** ID, harness used, PASS / FAIL / BLOCKED / N-A, and evidence:
the command and its output, the API values you asserted, or a screenshot path. A FAIL also gets
a bug entry (section 6). Do not mark PASS on a case you did not run; mark it BLOCKED and say why.

**Harnesses**, lowest first. Each case names the lowest one that can prove it; a higher one is
always allowed.

- **H1 CLI.** `pyokka` over a saved run or a live session. No VS Code needed for saved runs.
- **H2 Scripted VS Code.** A mocha spec run by `@vscode/test-cli` inside a real VS Code with
  the extension loaded. It reaches the extension API (`activate()`'s return value), every
  command, hover / code lens / code action providers, the editor decorations through
  `api.inlineValues`, and the host side of the panel. It cannot see inside the panel's webview.
- **H3 GUI.** A dev host driven with `cua-driver` (pixel clicks and screenshots), or a person.
  Needed for what only the webview or a native dialog shows.
- **H4 Installed build.** The packaged `.vsix` in a normal VS Code window, a person at the
  keyboard. Needed for keybinding chords, the untrusted-workspace prompt, Cursor, themes.

**Hygiene rules.** These protect the user's machine and other tests.

1. Some cases use a separate example project (`<example>` below) with its own venv
   (`openai`, `pydantic`, `httpx2`) and a `.env` holding a real API key. Never `cat`, print,
   hover or log it. A program there that calls an LLM costs tokens on every run: run it only in
   **HTTP Replay** mode (with a recording under its `.pyokka/replay/`) or not at all.
2. Scratch files you create under `examples/` must be deleted afterwards, and their entries
   removed from the real recent-files store (`~/.pyokka/recentFiles.json`; from H2:
   `api.manager.recentFiles.remove(ids)`). `examples/` must end with only `demo.py`, `tour_small.py`, `rrf/` and
   `.vscode/`, no `.env`, no `.pyokka/`.
3. Before any `--live` test or the e2e suite, `ls ~/.pyokka/sessions/` must list no descriptor
   from another window running `demo.py` (a dev host or the user's window); the CLI refuses an
   ambiguous session. Close or stop the extra session first.
4. Kill every dev host you launch (`kill <pid>`); each has its own `--user-data-dir` under
   `$TMPDIR`.
5. Do not commit QA scratch specs or configs. Keep them under `test/qa/` (untracked) or the
   session scratchpad and delete them at the end.
6. `PYOKKA_CACHE_DIR=$TMPDIR/pk-cache` isolates the library cache when a case
   needs a cold cache; an empty value disables the cache. Never clear `~/.pyokka/cache` itself,
   not even through TM-23: point `PYOKKA_CACHE_DIR` at the isolated directory first.
7. The e2e launcher and the H2 config below set `PYOKKA_E2E=1`, which suppresses the one-time
   run-mode notices. Cases about notices (CFG-08) need a spec run without it.
8. Read `docs/HANDOFF.md` "Quirks" once: `npm` may be `npq` (run
   `node_modules/.bin/*` directly), `cat`/`grep` are aliased (`command cat`), parallel shell
   calls share one cwd (use absolute paths).
9. Other sessions may edit this checkout while you test (on 2026-09-12 a parallel session had
   uncommitted Code Story changes in the tree, including a flip of the
   `pyokka.story.walkthrough` default). Start with `command git status --short`, record HEAD
   and every dirty file in your report, test the tree as it is, and never revert, stage or
   overwrite a change you did not make.

**Fixtures you can reuse.**

| Program | Exercises |
|---|---|
| `examples/demo.py` | prints, `# ?`, `# ?.`, partial coverage, classes, a three-pass loop for values-as-of, an uncaught `ValueError` on the last line |
| `test/unit/fixtures/walkthrough/main.py` (+ `helper.py`, fake package `libq`) | loops, `if/elif/else`, `match`, a class, a lambda callback into a library, a caught and an uncaught `ValueError` |
| `test/unit/fixtures/exceptions/main.py` (+ fake package `libx`) | every exception shape the report must show; ends in `ZeroDivisionError` |
| `test/unit/fixtures/provenance/main.py` (+ `helper.py`) | the why tree: a dataclass, a generator, calls into a helper |
| `test/unit/fixtures/graph/main.py` | the execution diagram's statement nodes and data edges |
| `test/e2e/fixtures/pylib/libdemo/__init__.py` | a stand-in third-party package for library stepping (`sys.path.insert` it) |
| `python/tests/test_agent_cli.py` (`MAIN`, `HELPER` strings) | a two-file program for the CLI: 28 steps, 2 files, exit 1 |
| `examples/rrf/demo.py` | the RRF program: three rankings fused, a loop whose `contribution` differs per pass |
| `examples/rrf/api/main.py` | a FastAPI service over the same arithmetic, for the live debugger (needs `fastapi`, `uvicorn`) |

Fixture packages under `venv/site-packages` are found with
`sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "site-packages"))`,
which the fixtures already do. Copy a fixture folder into `examples/` (or a temp folder opened
as the workspace) rather than running it in place, and delete the copy afterwards.

`examples/demo.py` line numbers at this commit, for the cases below (the e2e suites locate
these lines by text; do the same if the file changes): 9 `pyokka = {...}`, 11 `print(pyokka)`,
14 `pyokka`, 18 `working_dir = os.getcwd()`, 20 `os.cpu_count()  # ?`, 23 `sum(...)  # ?.`,
29 `print("partial", False and True)`, 31 `if False:`, 32 `print("noCoverage", True)`,
41 `def __init__(self, x, y)`, 70 `def generate_random_point`, 73 `return Point(x, y)`,
82 `point_a = Point(5, 10)`, 83 `point_b = generate_random_point(100, 100)`, 85 `rect1 = ...`,
88 to 90 the three `print({...})`, 97 `total = 0`, 98 `for n in range(1, 4):`, 99 `total += n`,
105 `raise ValueError("Kaboom! ...")`.

## 1. Preflight

Run these first and stop if PRE-02 to PRE-05 fail: everything after assumes a build that passes
its own suites.

- **PRE-01 Toolchain.** `node --version` (20 or newer), `python3 --version` (3.12 or newer),
  `uv --version`, `code --version`, `ls .vscode-test` (a `vscode-darwin-*` folder exists, else
  the first e2e run downloads one). Record the versions.
- **PRE-02 Build.** `node esbuild.mjs`. Expect `dist/extension.js`, `dist/webview/panel.js`,
  `dist/webview/codicons/codicon.ttf` and `dist/python/pyokka_runtime/` present afterwards.
- **PRE-03 Typecheck.** `./node_modules/.bin/tsc --noEmit -p .` exits 0 with no output.
- **PRE-04 Unit tests.** `./node_modules/.bin/vitest run`. Expect every file to pass; record the
  file and test counts against the baseline (40 / 362). A lower count with no failure is a
  finding too (a suite went missing).
- **PRE-05 Runtime tests.** `cd python && uv run --group dev pytest -q`. Expect all passed, at
  most 1 skipped (a test that needs Python 3.14's annotation protocol skips on 3.12). Then, from
  the repository root, `uv run --isolated --python 3.14 --directory python --group dev pytest -q`
  for the newest interpreter; both must pass.
- **PRE-06 End-to-end suite.** Check hygiene rule 3, then `./node_modules/.bin/vscode-test`.
  Expect every suite in `.vscode-test.mjs` to pass (demo, features, bridge, cli-live,
  walkthrough, execution-diagram, why, exceptions, values-as-of, http-replay; `uipass` skips
  without `PYOKKA_UI_PASS=1`). One known flake: the bridge test "steps into" can fail once in a
  full run and pass alone; a second failure is a bug. Takes several minutes and opens a window.
- **PRE-07 Package and install.** `node esbuild.mjs --production && ./node_modules/.bin/vsce package --no-dependencies --allow-missing-repository`,
  then `code --install-extension "$PWD/pyokka-0.0.1.vsix" --force`, reload the window, hover the
  status bar item: the tooltip ends in `build <timestamp>` matching this build (no `dev`
  suffix). Needed for H4 cases only.
- **PRE-08 Manifest.** `python3 scripts/gen-manifest.py && command git diff --stat package.json`
  shows no change (the committed manifest is what the generator produces).

## 2. Harnesses in detail

### H1: the CLI over saved runs

```sh
cd /path/to/pyokka
S="${TMPDIR:-/tmp}/pk-qa" && mkdir -p "$S"
uvx --from ./python pyokka run examples/demo.py --save "$S/demo.json"
uvx --from ./python pyokka walkthrough "$S/demo.json"
```

`python -m pyokka_runtime ...` from `python/` is the same program. Add `--json` to any command
for the raw shape; errors go to stderr as `error: ...` plus a hint line, exit status 2. Saved
runs live in the scratchpad, never in the repository.

### H2: a scripted VS Code

Create `.vscode-test.qa.mjs` in the repository root (untracked) and specs under `test/qa/`:

```js
import { defineConfig } from '@vscode/test-cli';
export default defineConfig({
  files: ['test/qa/*.test.js'],
  workspaceFolder: './examples',
  mocha: { ui: 'bdd', timeout: 180_000 },
  launchArgs: ['--disable-workspace-trust', '--disable-extension=ms-python.vscode-pylance'],
  env: { PYOKKA_E2E: '1' },
});
```

Run one spec at a time while writing: `./node_modules/.bin/vscode-test --config .vscode-test.qa.mjs`.
A spec skeleton, copied from `test/e2e/demo.test.js`:

```js
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('QA <area>', function () {
  let api, doc, editor, session;
  before(async () => {
    api = await vscode.extensions.getExtension('ivor.pyokka').activate();
    doc = await vscode.workspace.openTextDocument(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'demo.py'));
    editor = await vscode.window.showTextDocument(doc);
    api.manager.stopAll();
    await vscode.commands.executeCommand('pyokka.startOnCurrentFile');
    session = api.manager.sessionForDocument(doc);
    await api.waitForIdle(session, 60_000);
  });
  after(async () => {
    if (session && session.nav.active) await vscode.commands.executeCommand('pyokka.stopTraceNavigation');
    api.manager.stopAll();
  });
  it('CASE-ID', async () => { /* steps and asserts */ });
});
```

What the API gives you (`src/api.ts`): `api.manager` (`sessionForDocument(doc)`, `get(doc)`,
`start(doc, opts)`, `stop(doc)`, `stopAll()`, `all()`, `active()`, `recentFiles`),
`api.timeMachine` (`start(session, {line})`, `stop`, `addWatch(session, exp)`, `removeWatch`),
`api.panel` (`show()`, `selectEntries(session, [logId])`), `api.agentBridge.descriptorFor(session)`,
`api.narrator`, `api.graph(session)`, `api.exceptions(session)`, `api.variableHistory(session, name)`,
`api.provenance(session, step, name)`, `api.inlineValues(editor)` (what the editor paints:
`{line, text, kind, dim}`), `api.waitForIdle(session)`, `api.waitForNextRun(session)`.

On a session: `state.entries` (each with `kind`, `context`, `text`, `logId`, `step`, `runId`),
`state.errors`, `state.coverage.get(fileId).states` (0 not run, 1 covered, 2 partial, 3 error
source, 4 error path, 5 ignored), `state.trace.count`, `state.runId`, `state.finished`
(`exitCode`, `durationMs`, `timedOut`, `http`, `replayed`, `profile`), `nav.active`,
`nav.currentStep`, `trace.location(step)` (`fileId`, `range`), `trace.callStack(step)`,
`trace.toTimelineModel().scopes`, `runMode` / `setRunMode(m)`, `pendingRun`, `dirtyLines`,
`shadowValues`, `pinnedEntries`, `watches`, `evaluateLive(expr)`, `evaluateTransient(range, {context})`,
`runNow(reason, {mode})`, `setLibraryCode(b)`, `setMaskSecrets(b)`, `setRecordLocals(b)`,
`libraryCode`, `maskSecrets`, `mode`, `interpreter.path`, `files.all()`, `mainFileId()`,
`fileIdForDocument(doc)`, `key`, `displayName`, `status`, `running`.

Providers through VS Code: hovers with
`vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(l, c))`
(each `contents[i].value` is the markdown), code lenses with `vscode.executeCodeLensProvider`,
quick fixes with `vscode.executeCodeActionProvider`, the story's definitions with
`vscode.executeDefinitionProvider`. Notifications cannot be read from a spec; assert their effect
instead, or use H3.

Files outside `examples/` (a temp folder) do not inherit its `pyokka.runMode: auto` workspace
setting, so open a scratch file from `$TMPDIR/...` when a case needs the
default On Save mode, and `session.setRunMode(...)` for the others.

### H3: a dev host under cua-driver

```sh
node esbuild.mjs
cua-driver launch_app '{"bundle_id":"com.microsoft.VSCode","creates_new_application_instance":true,"additional_arguments":["--extensionDevelopmentPath=/path/to/pyokka","--user-data-dir=/tmp/pk-qa-host","--disable-workspace-trust","--new-window","/path/to/pyokka/examples","/path/to/pyokka/examples/demo.py"]}'
```

The window titled `[Extension Development Host] examples` appears after about ten seconds.
What is known to work and not (from `docs/HANDOFF.md` and earlier sessions): two welcome pages
need pixel clicks ("Continue without Signing In", "Get Started"); accessibility presses do
nothing anywhere in VS Code here, pixel clicks do; the start view's "Launch Interactive Demo"
button is the reliable way to start a session, the editor title's run dropdown and the command
palette are not (typed text can land in the editor); panel buttons take pixel clicks, whose
frames are in the snapshot's `.elements[].frame` (screen coordinates; subtract the window
origin); clicks on Monaco text inside the panel do not fire; a window covered by another one
stops painting, so trust the accessibility tree and `pyokka state --live` over a stale
screenshot. Drop `--disable-workspace-trust` for the trust prompt case. `scripts/ui-drive.sh`
is a sequence runner (key, hotkey, type, click, screenshot) you can adapt: edit its `S` and
session values first.

### H4: the installed build

PRE-07, then a normal window on `examples/` or on a temp folder. Keyboard chords, the Cursor
chords, themes and the trust prompt are checked here.

## 3. Test cases

Format: **ID Title** · harness · steps · expected. "Scratch" means a new Python file you write
for the case (under `examples/` for H2 unless the case says otherwise, deleted afterwards).

### SES: sessions, status bar, start view

- **SES-01 Start on the current file** · H2 · Open `demo.py`, run `pyokka.startOnCurrentFile`,
  wait idle. · `sessionForDocument(doc)` exists; `state.entries.length >= 8`; one error whose
  message matches `Kaboom`; coverage for `mainFileId()` contains state 2; `state.trace.count > 50`;
  the "Pyokka" panel tab exists (`pyokka.showOutput` succeeds).
- **SES-02 Start with no Python editor** · H2 · Close all editors, run `pyokka.startOnCurrentFile`.
  · A new untitled Python document opens with the starter comment and a session starts on it.
  With a non-Python editor active the notice "Pyokka runs Python files..." appears (H3).
- **SES-03 Toggle** · H2 · `pyokka.toggle` on a file without a session, then again. · First call
  starts a session, second stops it (`sessionForDocument` undefined, decorations gone).
- **SES-04 Stop Current / Stop All** · H2 · Start sessions on `demo.py` and a scratch; run
  `pyokka.stopCurrent` with the scratch active, then `pyokka.stopAll`. · Only the scratch session
  ends first; then none remain; `pyokka.hasActiveSession` context is false (the panel view hides).
- **SES-05 Two sessions, panel follows the editor** · H2 + H3 · Two sessions open; switch editors.
  · `api.manager.active()` follows the active editor's session; in H3 the panel header shows the
  active file's name and its entries.
- **SES-06 Focus Active Pyokka File** · H2 · With the panel focused or another editor active, run
  `pyokka.focusActiveFile`. · The active session's document becomes the active editor.
- **SES-07 Status bar states** · H3 · Observe the left status bar item: before any session
  (`Pyokka`, tooltip "idle ... build ..."), while running (spinner), after (`✓ <ms>`), after a
  failing run (`⚠ <ms>` with the error in the tooltip and a warning background; demo.py ends in
  an error so this is the normal state for it), and `Pyokka: run needed` after a hover in On
  Demand mode. Click it: the actions quick pick lists start view, output, stop, Auto Log,
  selection toggles, recent files, session settings, interpreter, logs.
- **SES-08 Start view on first activation** · H3 · Launch a dev host with a fresh
  `--user-data-dir`. · The "Welcome to Pyokka" tab opens once; its five buttons work (demo starts
  a session on an untitled copy of demo.py; New Python File; Recent Files; Select Python
  Interpreter; Settings opens the settings UI filtered to `pyokka`); the shortcut table shows
  `⌘` on macOS. Reload the window: it does not open again. `pyokka.openStartView` reopens it.
  With `pyokka.showStartViewOnFeatureRelease: false` a fresh profile never shows it.
- **SES-09 Recent files record the session** · H2 · After SES-01, `api.manager.recentFiles.list()`
  has an entry for `demo.py` with a timestamp and the project root.
- **SES-10 Interpreter change prompt** · H3 · With a session running, change the Python
  extension's interpreter (Python: Select Interpreter). · Notice "the Python interpreter changed.
  Restart running sessions to use it?"; "Restart" re-runs with the new interpreter (the session
  settings quick pick's placeholder shows the interpreter path and version).
- **SES-11 Show Logs** · H2 · `pyokka.showLogs`. · The "Pyokka" output channel opens and contains
  the activation line with the build stamp, the interpreter chosen and one line per run with its
  reason (`start`, `manual`, `save`, `edit`, `watch`, ...).

### LV: live values

- **LV-01 print and identifier statements** · H2 · demo.py. · Entries include the dict printed
  on line 11 and the identifier `pyokka` on line 14 (`context === 'pyokka'`), both with text
  starting `{'is_awesome': True`; `api.inlineValues(editor)` shows them on lines 11 and 14.
- **LV-02 `# ?`, `# ?.`, `# ?+`** · H2 · demo.py lines 20 and 23; a scratch with
  `d = {"a": list(range(20))}` then `d  # ?+` and `d  # ?`. · Line 20 has a `value` entry (an
  integer); line 23 has a `time` entry whose text ends in `ms`; the `# ?+` entry's `valueBag`
  holds more of the list than the `# ?` one (autoExpand kind, deeper elements).
- **LV-03 `# ?.+` and `# ?+.`** · H2 · Scratch: `sum(range(10))  # ?.+` and `sum(range(10))  # ?+.`.
  · Each line produces both a value and a timing.
- **LV-04 `# ? $.code`** · H2 · Scratch: `s = "abc"` then `s  # ? $.upper()` and
  `s  # ? just a question`. · The first shows `'ABC'`; the second produces no entry (a human
  comment). A `# ?` inside a string literal (`x = "# ?"`) produces no entry either.
- **LV-05 Library files ignore live comments** · H2 · With Step Into Library Code on and a
  fixture package that contains a `# ?` line. · No entry from the library file.
- **LV-06 Log limits** · H2 · Scratch: `for i in range(300): i  # ?`. · At most 100 hits for the
  site (`pyokka.logLimit`); set `pyokka.logLimit` to 5 and re-run: 5. Then a scratch that prints
  2000 lines: entries stop at `pyokka.maxConsoleMessages` (1000).
- **LV-07 Load more / full string** · H3 · Scratch: `big = list(range(20000))` and
  `s = "x" * 20000`, both `# ?`. · Details shows a truncated value; context menu "Load more"
  extends the list, "Load full string value" shows the whole string; no re-run happened
  (`state.runId` unchanged, check from H2 before and after via a companion spec, or the status bar
  duration unchanged).
- **LV-08 Awaitables** · H2 · Scratch with `import asyncio`, `async def f(): return 1`,
  `f()  # ?`, `c = f()`, `c  # ?`. · Line 3 logs `1`; line 5 logs `<coroutine ...>`.
- **LV-09 Show Value on a selection** · H2 · Select `working_dir` (line 18, cols 0 to 11), run
  `pyokka.showValue`, wait for the next run (Automatic in `examples/`). · An entry with
  `context` `working_dir` whose text contains `/examples`; the value is painted on line 18 and
  survives a re-execute (sticky marker).
- **LV-10 Show Value on the member chain under the cursor** · H2 · Cursor inside `self.x` on
  line 42 with no selection, `pyokka.showValue`. · An entry for `self.x` (hit count > 1 since
  `__init__` runs several times).
- **LV-11 Show Line Values and Show Line Timings** · H2 · Cursor on line 88, run
  `pyokka.showLineValues`; then `pyokka.showLineTimings`. · Entries appear for the expressions of
  the line (at least the `rectangles_overlap(...)` call); the timing command adds a `time` entry.
- **LV-12 Show Last Displayed Value Only vs Show All** · H2 · Show Value on two different
  expressions with the default. · Only the second marker remains visible. Run
  `pyokka.disableShowSingleInlineValue` (title "Show All Displayed Values"), repeat: both remain.
- **LV-13 Copy Value** · H2 · Cursor on `pyokka` (line 14), `pyokka.copyValue`. · The clipboard
  (`vscode.env.clipboard.readText()`) holds the dict text.
- **LV-14 Clear Value / Clear File Values** · H2 + H4 · After LV-09, `pyokka.clearValue` on line
  18 removes that marker only; `pyokka.clearFileValues` removes all markers; `# ?` values stay.
  H4: `Esc` on the line clears it only when the line has a removable value (the key is otherwise
  free for VS Code); `Esc Esc` with no selection clears the file's markers.
- **LV-15 Show Value On Selection** · H2 · Enable with `pyokka.enableShowValueOnSelection`,
  select `rect1` on line 85, wait. · A value appears for the selection without a command. Select
  across two lines: nothing (unless `pyokka.showValueOnMultilineSelection` is true).
- **LV-16 Auto Log** · H2 · `pyokka.enableAutoLog`, wait for the run. · Entries of kind
  `autoLog` exist for assignments such as line 82 (`point_a = ...`) and for returns inside
  functions (line 73); `pyokka.disableAutoLog` removes them on the next run. With `pyokka.autoLog:
  true` a new session starts with them.
- **LV-17 Logpoints** · H2 · Add `new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(72, 0)), true, undefined, undefined, 'y is {y}')`
  through `vscode.debug.addBreakpoints`, wait for the next run. · An entry of kind `logpoint`
  with text `y is <number>` on line 73; removing the breakpoint removes the entry after the next
  run. In On Demand mode the change sets `pendingRun` instead of running.
- **LV-18 Value Peek hover, Automatic mode** · H2 · `executeHoverProvider` on `point_a` (line
  82, col 2). · One hover whose markdown starts with `**point\_a**` and contains the links
  `Explore value`, `Show as diagram`, `Copy`, `Why`, then a code block with the value. Hover
  over the keyword `print` or a number: no Pyokka hover.
- **LV-19 Hover in On Save mode without re-running** · H2 · `session.setRunMode('onSave')`,
  note `state.runId`, hover `rect1` on line 88 (a recorded value exists for line 85 only). ·
  The hover shows the value and the footer "Value from the last run, evaluated without
  re-executing"; `state.runId` unchanged. Hover a name the run never touched: the hover says
  nothing recorded it, offers `[Re-execute]` and "Record variables and re-run", and
  `session.pendingRun` turns true.
- **LV-25 Hover a parameter or a local** · H2 · On Save on demo.py; hover `max_x` on line 71
  (col 27) with nothing recorded. · The hover says it is a local of `generate_random_point`,
  recorded on the next run; `pendingRun` is true; after `pyokka.reexecute` the same hover shows
  `100` (a hidden marker recorded it; nothing is painted inline on line 71). Then
  `setRecordLocals(true)`, re-execute, start the Time Machine on line 72 and hover `max_y`: `100`
  with the footer `as of step N · recorded in generate_random_point, line 70`; off the Time
  Machine the footer reads `last change at step N`. The "Record variables and re-run" link turns
  recording on and runs once (`session.recordLocals` true, a new `runId`). A session keeps at most
  60 hidden hover markers (hover 61 distinct names: the first is recorded no more).
- **LV-20 Hover links survive a re-run** · H2 · As `features.test.js` "resolves a hover link":
  `evaluateLive('point_a.x')`, switch to On Save, re-execute, then
  `pyokka.exploreEntity` with the stale `logId`, `exp`, `range` and `sessionKey`. · A pinned
  entry with context `point_a.x` and text `5` appears for the current run.
- **LV-21 Explore, Compare, Diagram from the panel** · H3 · Click an entry: Details renders it
  in Monaco with Find and Copy with highlighting working; select two entries (click, then
  shift-click): the Compare button enables and shows a diff, two values that cannot be diffed
  show "Diff is not available for these values"; Show as diagram draws the value tree; zoom
  in/out/fit work; right-click a node: Copy path / Copy value.
- **LV-22 Inline colours per theme** · H4 · Set `pyokka.darkTheme.log.decorationAttachmentRenderOptions.color`
  to `#ff00ff`, reload. · Inline log values render magenta in a dark theme; light theme keeps
  its own setting.
- **LV-23 Values on edited lines hide** · H2 · On Save mode; insert `  # edited` at the end of
  line 20. · `session.dirtyLines` has 20 and `api.inlineValues` no longer paints line 20; line 23
  keeps its value. Undo restores it.
- **LV-24 Shadow values** · H2 · On Save mode; change line 14 `pyokka` to `pyokka["python"]`. ·
  Within a second `session.shadowValues.get(14)` exists with text starting `'3.` and context
  `pyokka['python']`; the editor paints `≈ '3....'` on line 14; `state.runId` unchanged. Change
  it to `len(pyokka)`: no shadow value (calls wait for a run). Restore the file.

### COV: coverage

- **COV-01 States on demo.py** · H2 · `state.coverage.get(mainFileId()).states` indexed by the
  file's local range ids (`session.locate(rid)` maps back). · Line 29 partial (2), line 32 not
  run (0), line 105 error source (3), lines 8 to 23 covered (1). H3: green, yellow, grey and red
  squares at those lines, pink on the error path when the raise is inside a call (a scratch
  whose last line calls a function that raises).
- **COV-02 Ignore hints** · H2 · Scratch: a line with `# pragma: no cover`, a line with
  `# ignore coverage`, an `if` block with the hint on its header, then another scratch with
  `# ignore file coverage`. · Hinted lines have state 5 and are absent from
  `file.instrumented.statements` (no inline value on them); the block under the hinted `if` is
  ignored whole; the file-level hint leaves no coverage decorations at all.
- **COV-03 def / class are coverage-only** · H2 · Start the Time Machine at line 40 (`class
  Point:`) of demo.py. · It lands on the next executable statement after the class, never on
  the `class`, `def` or the class-body lines; the gutter still shows them green.
- **COV-04 Stale coverage after an edit** · H3 · On Save mode; type a new line. · Coverage
  squares dim (stale variant) until the next run repaints them.
- **COV-05 Gutter colours setting** · H4 · Set `pyokka.colors.covered` to `#0000ff`, restart. ·
  Covered squares are blue.

### RM: run modes and code with side effects

- **RM-01 Default is On Save outside a project** · H2 · Open a scratch in a temp folder outside
  `examples/` (no pyproject etc.), start. · `session.runMode === 'onSave'`. Same for a file
  inside a folder with a `pyproject.toml`. (`examples/` pins `auto` by workspace setting: check
  `session.runMode === 'auto'` there.)
- **RM-02 Smart** · H2 · `pyokka.runMode: 'smart'` in user settings; start a session on an
  untitled file and on a file next to a `requirements.txt`. · `auto` and `onSave` respectively.
  Each of the eight marker names in `PROJECT_MARKERS` (`src/config/project.ts`) turns a folder
  into a project.
- **RM-03 Automatic triggers** · H2 · Automatic session on demo.py; for each trigger note
  `state.runId` before and after: an edit (after `pyokka.delay`), a hover on an expression with
  no recorded value, `api.timeMachine.addWatch`, `pyokka.showValue`, a logpoint change, editing
  an imported project module, enabling Auto Log. · Each produced a new run.
- **RM-04 On Save triggers** · H2 · `setRunMode('onSave')`; edit, hover, watch, Show Value: no
  run and `pendingRun === true` after the first queued request; `doc.save()` runs once and
  clears `pendingRun`; saving an imported project module re-runs too.
- **RM-05 On Demand never runs implicitly** · H2 · Reproduce `features.test.js` "never executes
  implicitly": transient evaluate returns undefined and sets `pendingRun`; `evaluateLive('rect1.width * 2')`
  gives `100` with no run; `evaluateLive('rect1.area()')` is refused; starting the Time Machine
  and adding a watch `point_a.x` does not run and the watch's value carries an error mentioning
  re-execute; stopping does not run; `pyokka.reexecute` runs and clears `pendingRun`.
- **RM-06 Explicit runs in On Demand** · H2 + H3 · Each of these runs the file once: `F5`
  (`pyokka.reexecute`), the editor title run button ("Re-execute file"), the panel rail play
  button, the status bar item while it reads "run needed", a profile run, a snaps run, a package
  install completing, `pyokka.stopCurrent` + start (restart).
- **RM-07 Run mode switches** · H2 · `pyokka.runOnDemand`, `pyokka.runOnSave`,
  `pyokka.runAutomatically` on the active file. · `session.runMode` follows; switching to
  Automatic with a dirty document runs at once; the user settings `pyokka.runMode` is never
  written by any of these nor by the panel's Save as defaults (inspect
  `vscode.workspace.getConfiguration('pyokka').inspect('runMode').globalValue`).
- **RM-08 Delay** · H2 · `pyokka.delay: 1500` in a fresh session, Automatic; edit. · No run
  within 1 s; one run after about 1.5 s.
- **RM-09 Timeout** · H2 + H3 · Scratch: `import time; time.sleep(5); print("late")` with
  `session.setRunTimeout(1000)` from H2, or `pyokka.runTimeout: 1000` before starting (the
  Settings dropdown offers nothing under 30 s). · `state.finished.timedOut === true`, `exitCode === null`, no
  `late` entry; the status bar shows a warning; H3: the entries pane says the run was killed and
  links to Settings; with `0` the run waits forever (sleep 35 s finishes).
- **RM-10 Timeout dropdown** · H3 · Settings view, Run Timeout: choices 30 s, 1 min, 2 min,
  5 min, 10 min, No limit; picking one applies on the next run; Save as defaults writes
  `pyokka.runTimeout`.
- **RM-11 Inline config dict** · H2 · Scratch starting with `{"runMode": "onDemand"}` then
  `x = 1` and `x`. · The dict is not a step and produces no entry (stripped by the runtime);
  the session's run mode is unchanged by it. README documents this as not applied: record
  the actual behaviour; a run mode change would be a doc finding, a crash a bug.
- **RM-12 Config file layering** · H2 · Temp workspace with `.pyokka` containing
  `{"runMode": "onDemand", "runTimeout": 120000, "args": ["--fast"], "env": {"QA_X": "1"}}`
  and a scratch printing `sys.argv[1:]` and `os.environ.get("QA_X")`. · Session starts On
  Demand with `runTimeoutMs === 120000`; the run prints `['--fast']` and `'1'`. Then a
  `pyproject.toml` with `[tool.pyokka]` `runMode = "auto"` in the same folder: `.pyokka` still
  wins (later layer). `~/.pyokka/config.json` is read below both (do not leave one behind).
- **RM-13 Project files sent unsaved** · H2 · Temp workspace: `main.py` importing `helper.py`;
  edit `helper.py` without saving; re-execute `main.py`. · The run reflects the unsaved edit.

### PAN: the panel

- **PAN-01 Rail** · H3 · Buttons top to bottom: play, output, clock, book, `(x)`, globe,
  pulse, gear, `…`. Tooltips appear after about 150 ms next to the icon with the titles in
  README. The play button spins while a run is in flight and the entries pane shows "RUNNING…".
- **PAN-02 More menu** · H3 · `…` lists Show Execution Diagram, View Recent Files, Show
  Instrumented File, Edit Session Settings, Show Pyokka Logs; each opens what it says.
- **PAN-03 Entries list and tree** · H3 · Toggle list/tree; the tree groups by file then line;
  the menu of a tree line hides it and "Show all" restores; the filter box narrows entries by
  text; menu toggles change the kind icon, the file name in links, the context; "Clear
  selection" (also Escape inside the pane) clears.
- **PAN-04 Source links** · H3 · Click `demo.py:20`: the editor reveals line 20; the eye icon
  opens it to the side. With H2, `openLocation` is the message; not needed.
- **PAN-05 Details menu** · H3 · Line numbers, minimap, sticky scroll, folding toggles change
  the Monaco editor; the preferences survive a window reload (`loadPrefs`).
- **PAN-06 Empty and running states** · H3 · A file with no output: "NO LOGS OR ERRORS";
  during a run "RUNNING…"; after a timeout the notice from RM-09.
- **PAN-07 Settings view** · H3 · Seven checkboxes and three dropdowns as in README; each
  checkbox changes the session at once (verify one end to end, for instance Value Peek off
  makes LV-18's hover disappear); Save as defaults writes the corresponding `pyokka.*` settings
  except the run mode; Reset restores defaults; the history icon opens Recent Files; the Run
  Mode dropdown opens as a list, not a clipped strip.
- **PAN-08 Font size** · H4 · `pyokka.fontSize: 18` enlarges the panel text.
- **PAN-09 Session settings quick pick** · H2 + H3 · `pyokka.editSessionSettings`: sections
  Run mode (Automatic / On save / On demand), Values (Auto Log, Value Peek, Show Value On
  Selection, Show Last Displayed Value Only), Session (Re-execute, Stop session, Open Pyokka
  settings); the checked item reflects the session; picking one applies it.
- **PAN-10 Panel visibility setting** · H2 · `pyokka.showOutputOnStart: false`; start a session
  · The panel does not open by itself; `pyokka.showOutput` opens it.
- **PAN-11 Panel keeps state across views** · H3 · Switch Output to Settings and back, and to
  the Time Machine view and back: the entries selection and filter persist; closing and
  reopening the panel keeps the view (`retainContextWhenHidden`).

### TM: Time Machine

- **TM-01 Start on a line** · H2 · Cursor on line 20, `pyokka.debug`. · `nav.active`; the
  current step's line is 20; the editor highlights the line; the panel switches to the Time
  Machine view (H3: strips visible, header shows step `N/total`, stop button red).
- **TM-02 Moves on demo.py** · H2 · From TM-01: `playTraceNextStepOver` → line 23, again → 29;
  `playTracePrevStepOver` → 23; cursor on line 83 and `playTraceForwardToSelection` → 83;
  `playTraceNextStep` → a line in 70..74 and `currentStep` increased; `playTraceNextStepOut` →
  line ≥ 83; `playTracePrevStepOut` moves back into the callee's caller position;
  `playTraceBackwardToSelection` with the cursor on line 20 → 20. `playTracePrevStep` from
  step 1: stays (no crash).
- **TM-03 Keys** · H4 · `Shift+F5`, `F10`, `Ctrl+F10`, `F11`, `Ctrl+F11`, `Shift+F11`,
  `Ctrl+Shift+F11`, `F5`, `Ctrl+F5` do the moves in TM-02 while the session file is active;
  with a non-Pyokka editor active they do nothing Pyokka-related; `F5` outside navigation
  re-executes; with a VS Code debug session running they are VS Code's.
- **TM-04 Breakpoints** · H2 · Add a plain breakpoint on line 73, start at line 20,
  `playTraceForwardToBreakpoint`. · Lands on line 73; `playTraceBackwardToBreakpoint` from the
  end lands there too; with no enabled breakpoint the context key
  `pyokka.hasAnyEnabledBreakpointsInActiveEditor` is false and the command is a no-op.
- **TM-05 Step Into / Over / Out semantics** · H2 · Scratch: `def g(): return 2`, `def f():
  return g() + 1`, `x = f()`, `print(x)`. Start at `x = f()`. · Into → `return g() + 1`;
  Into → `return 2`; Out → back on `return g() + 1` (or its completion), Out → `print(x)`.
  From `x = f()`, Over → `print(x)`; from inside `f`, Over never lands in `g`.
- **TM-06 Gathered coroutines** · H2 · The `_aio_e2e.py` program from `features.test.js` (or
  `async_demo.py` from the test bed). · `turn` scopes have depths `[2, 1, 1]`; no scope deeper
  than 3; from the `gather` line Step Over lands on `print(one, both)` with call stack
  `['main', '<module>']`.
- **TM-07 No steps on def / class, loop header per iteration** · H2 · Start at line 97
  (`total = 0`), step over three times. · Lines 98, 99, 98 (the header steps once per
  iteration); a step that lands on line 40, 41, 55 or 56 is a bug.
- **TM-08 Strips and blocks** · H3 · The steps strip shows one block per step, coloured per
  function, each with `#N` over `line:col`; clicking a block moves there; dragging the timeline
  window scrolls; the wheel zooms; hovering a block shows the code preview with the step number,
  function and, inside a call, `called from #<step> <function> line <n>`.
- **TM-09 Timeline guide and call stack** · H2 + H3 · Inside `__init__` (step into line 85's
  constructor), `pyokka.viewCallStack`. · H2: `trace.callStack(currentStep)` is
  `['__init__', '<module>']`; H3: the right pane title reads CALL STACK with two rows carrying
  their steps; clicking `<module>` (`pyokka.openCallStackFrame`) reveals line 85;
  `pyokka.hideCallStack` returns to TIMELINE GUIDE, which lists `<module>`, `__init__`,
  `generate_random_point`, `rectangles_overlap`, `contains`, `distance` with their colours.
- **TM-10 Echo and code preview toggles** · H3 · `pyokka.toggleStepEcho` highlights the other
  blocks of the current statement on the strip (a step inside `__init__` echoes the other
  constructions); `pyokka.toggleCodePreview` hides and shows the hover preview.
- **TM-11 Auto play** · H2 · `pyokka.debugAutoPlay` (or `pyokka.autoPlayCode` while
  navigating) with `pyokka.codeAutoPlayDelay: 200`. · `nav.autoPlaying` true and
  `currentStep` advances about five steps per second; `pyokka.pauseCodeExecution` stops it;
  the context key `pyokka.traceBeingAutoPlayed` hides the stepping buttons meanwhile (H3).
- **TM-12 Auto Log while navigating** · H2 · Start with Auto Log off. · While navigating,
  `session.autoLog` is true and return values inside functions are painted (line 73);
  stopping restores the previous setting. With `pyokka.timeMachine.autoLog: false` nothing
  changes.
- **TM-13 Values as of this step** · H2 · Repeat `values-as-of.test.js`: start at line 99 →
  line 99 shows `1` in full, line 97 `0` dimmed, lines after 99 show nothing; hover `total`
  on line 99 → footer `as of step N; final: 6`; step over → line 99 reads `×2 3`, again `×3 6`,
  back → `×2 3`; start at line 18 → nothing painted on 97..99 and the hover on `total` says
  `not run yet as of step N; final: 6`; stop → final values, none dim. Then
  `pyokka.timeMachine.inlineValues: 'currentStep'`: only the current step's line has a value;
  `'all'`: every value stays undimmed at its last hit.
- **TM-14 Watches** · H2 · While navigating, `api.timeMachine.addWatch(session, 'point_a.x')`.
  · `session.watches[0].values.get(currentStep)` resolves to `5` after line 82; stepping to the
  next ten steps needs no run (prefetch); `pyokka.addWatchExpression` with a selection uses it,
  without one prompts (H3); the hover's "Add watch" link appears only while navigating;
  refresh / remove work (`pyokka.removeWatchExpression`, panel buttons); H3: the LOGS pane
  lists them with explore and copy.
- **TM-15 Step Variables** · H2 + H3 · `session.setRecordLocals(true)`, re-run, navigate into
  `distance`. · H3: the right pane shows STEP VARIABLES with `dx`, `dy` as they change; H2:
  `api.variableHistory(session, 'dx')` has recorded values (see VH-02).
- **TM-16 Edit and continue** · H2 · Repeat `features.test.js` "re-anchors": navigate to line
  85, insert a blank line above it, wait for the run. · `nav.active` still true and the current
  step's line is now 86 (the same statement).
- **TM-17 Stop restores the editor** · H2 · `pyokka.stopTraceNavigation`. · `nav.active`
  false, the current-step highlight gone, final values back (TM-13), Auto Log restored
  (TM-12); `Shift+F5` starts it again (H4).
- **TM-18 Start without a trace** · H2 + H3 · On Demand session before any run (start, then
  stop and start the session with the mode preset, or set `pyokka.runMode: onDemand` and open a
  fresh scratch): `pyokka.debug`. · No navigation; warning "no execution trace yet and the run
  mode is on demand. Re-execute the file first." A file with only comments: "ran no statement".
- **TM-19 Library code off and on** · H2 · Repeat `features.test.js` "steps into library code":
  `libdemo.twice(21)` with the fixture on `sys.path`. · Off: no `twice` scope, one file; on
  (`setLibraryCode(true)` re-runs in Automatic): a `twice` scope, a `libdemo` file registered,
  Step Into from the call lands in the library file, Step Out returns. `libraryPackages:
  ["nothing"]` keeps it opaque again.
- **TM-20 Library cache** · H1 · `PYOKKA_CACHE_DIR=$TMPDIR/pk-cache` and the
  example venv interpreter (`<example>/.venv/bin/python`, with `openai`):
  run `python -m pyokka_runtime run <scratch importing openai> --library-code` twice from
  `python/`. · The cache directory fills on the first run; the second run's total time is
  lower (record both; `scripts/measure-library-run.py` prints cold and warm). Stdlib modules
  never appear among instrumented files.
- **TM-21 Trace cap** · H2 · `pyokka.maxTraceSteps: 200`, a scratch looping 1000 times. ·
  `state.trace.count <= 200`, the timeline model reports `truncated`; H3: a "Trace truncated"
  mark on the strip.
- **TM-22 Panel title buttons** · H3 · While navigating, the panel's title bar shows run back
  to line, back out, back into, back over, stop, over, into, out, run to line; each performs
  its move. The source editor's title shows none of them. The Code Story editor's title shows
  the same buttons plus run to and back to a breakpoint (`editor/title` in `package.json`,
  mirrored from Quokka for the story scheme), and each performs its move.
- **TM-23 Clear Library Cache** · H1 + H3 · `PYOKKA_CACHE_DIR` at the isolated directory (in the
  dev host's environment, or `pyokka.env` in the workspace settings); fill it with a
  `--library-code` run, add a `keep.txt`, then "Pyokka: Clear Library Cache"; H1: `pyokka cache`,
  `pyokka cache --json`, `pyokka cache --clear`. · The notice names the directory, the files
  removed and their size; `keep.txt` stays, every `*.bin` is gone; one more run and the entries
  are back; a second clear says the cache is already empty; with the variable empty it says the
  cache is off. The CLI prints `<dir>: N entries, S`, then `removed N entries (S) from <dir>`;
  `--json` is `{dir, entries, bytes}` and `{dir, removed, bytes, failed}`; a missing directory
  is `0 entries, 0 B`, never an error.

### CS: Code Story

The contract these cases check is `docs/design/code-story.md`; its rule numbers (D3, L2, V1,
T1) are cited where a case pins one.

- **CS-01 Open** · H2 · `pyokka.viewCodeStory` with the Time Machine off. · The Time Machine
  starts; an editor with scheme `pyokka-code-timeline` and language `pyokka-story` opens beside
  the source. Row 1 is empty (D3). Every other row is either `<number right-aligned>  <source
  line>` or a row holding only `…`. No row after the first is blank, no `…` row is the first or
  last non-empty row, and two blocks are separated by exactly one `…` row: no heading, no code
  lens row, no zero-width fence characters in the text (`getText()` matches
  `/^[^\u200b]*$/`).
- **CS-02 Follows the step** · H3 · Step with F10 in the source. · The box in the story moves to
  the current step's range in the block that holds it (T1), the story scrolls it into view and
  the story's cursor sits on that row at the range's start column (T2). Put the cursor on
  another story row: the Time Machine does not move (T3). Select a name on a single story row:
  the Time Machine moves to that row's first step in that block and a Show Value marker appears
  on the source line.
- **CS-03 Go to Definition and hover** · H2 · `executeDefinitionProvider` and
  `executeHoverProvider` on a name on a story code row. · Definition gives one location in
  `demo.py` at that row's line and column. The hover is the one Value Peek gives for that name
  in the source (same value text and links); when the row belongs to another step than the
  current one, the hover ends with the note that it is the value as of the current step (V3).
- **CS-04 Library and project blocks** · H2 · With library code on (TM-19). · Blocks from the
  library file show its source read from disk, not "(no source available)".
- **CS-05 Walkthrough setting both ways** · H2 · Open the story with
  `pyokka.story.walkthrough` false (the default), then true (reload the story between the
  two). · Without it the story starts with the first source block; with it the walkthrough
  leads. Pyokka's own addition, not Quokka's.
- **CS-06 Stopping closes the story** · H2 · With the story open, run
  `pyokka.stopTraceNavigation`; repeat with `api.manager.stopSession(...)` instead. · Both
  times the story editor is gone: no tab in `vscode.window.tabGroups.all` whose input URI has
  the scheme `pyokka-code-timeline`, and no such visible editor. There is no stopped-text state
  (D2).
- **CS-07 Lines of a block** · H2 · A file with a function whose loop body is more than two
  lines below its `def` (write a scratch file; `examples/demo.py` has no such function). · The
  first pass through the function lists the `def` line because it is inside the window; a later
  turn through the loop lists only the lines its pass ran plus two lines either side of them,
  clamped to the function, and does not list the `def` line (L2, L5). A stretch of more than
  four lines the pass did not run inside that window is one `…` row (L4). Blank lines at the
  edges of the window are dropped, a blank line between two listed lines stays (L3).
- **CS-08 Values by mode** · H3 · Stand on a step inside a loop body that logged a value
  (`examples/demo.py` line 99 on the second turn); try `pyokka.story.values` at `all`, `asOf`
  and `step`. · `all` (the default): each turn's block shows its own value after that line.
  `asOf`: the same, but a turn the run has not reached yet shows nothing. `step`: the value is
  shown once, after the end of that step's line in the block that holds the step, and every
  other line carries nothing (Quokka's V1). A statement whose tail the block folded carries its
  value on the `…` row under it. H3 because `api.inlineValues` returns nothing for the story
  scheme: read the values from a screenshot.

### WT: walkthrough and narration

- **WT-01 Moments on demo.py** · H1 + H2 · `pyokka walkthrough demo.json` and
  `api.narrator.walkthrough(session)`. · Both list: the module start, the prints of lines 11,
  29, 88 to 90 as `print` moments, the `if False` decision with the arm it took (else, nothing
  ran), calls to `generate_random_point`, `Rectangle`/`Point` constructors, `rectangles_overlap`,
  `contains`, `distance` with arguments (saved run) and results, the loop with its count of 3,
  the uncaught `ValueError` and the end with exit code 1; step numbers agree between CLI and
  API; the same `kind`/`line` sequence on a second run (values differ, the shape does not).
- **WT-02 Windows** · H1 · `--from N --to M`, `--scope generate_random_point`, `--file demo.py`,
  `--all` on the walkthrough fixture with `libq`. · Each narrows as documented; `--all` lists
  one moment per library call instead of one per call site; the cap is 400 moments.
- **WT-03 Panel section** · H3 · WALKTHROUGH under the entries: collapsible; a click on a
  moment starts or moves the Time Machine to its step; the active moment follows the step and
  past moments dim; the section stays visible in the Time Machine view.
- **WT-04 Narrate with a fake backend** · H1 + H2 + H3 · Write an executable script that reads
  stdin and prints `{"glosses": {"<step>": "sentence", ...}}` for the moments (see
  `walkthrough.test.js` "narrates with pyokka.explain.command" for the exact shape it emits),
  set `pyokka.explain.command` to it. · `pyokka narrate demo.json --command <script>` writes the
  glosses into the saved run and `walkthrough` prints them under the moments; in VS Code
  `pyokka.narrateWalkthrough` fills the section, the Code Story and the bridge reply; the
  sparkle spins while narrating and is disabled once narrated for that run; a re-run clears the
  glosses.
- **WT-05 Narrate failures** · H2 + H3 · Backend prints garbage; backend exits 1; no backend
  at all (`pyokka.explain.command` empty on a PATH without `claude`/`codex` and no Copilot). ·
  The warning "narration failed: ..." appears once with a hint, glosses stay empty; with no
  backend the button is disabled and the command says nothing to narrate or that no backend
  exists. `--dry-run` prints the prompt and calls nothing.
- **WT-06 Never automatic** · H2 · Run, re-run, step, open the Code Story with a fake backend
  configured that logs every invocation. · The backend is invoked only by the explicit
  Narrate action.
- **WT-07 Redaction before narration** · H1 · A scratch with `token = "sk-" + "a" * 30` and
  a print of it; narrate with a backend that saves its stdin. · The prompt holds `«redacted»`,
  never the token.

### VH: variable history

- **VH-01 Assignment sites without recording** · H2 · `api.variableHistory(session, 'total')`
  on demo.py without Record Variable Changes. · Rows for line 97 and line 99 with values from
  Auto Log / logged entries where they exist, otherwise "assigned here (value not recorded)".
- **VH-02 Recorded values** · H2 · `setRecordLocals(true)`, re-run, query `total`. · One row
  per change with values `0`, `1`, `3`, `6`, each with the step and the names the statement
  read (`n` with its value at that moment).
- **VH-03 Paths** · H1 · On `example.py` from the test bed (saved run): `pyokka var run.json
  self.balance`, `pyokka var run.json acct`. · `self.balance` lists the deposits and the
  withdrawal with values; `acct` also lists `acct.deposit(amount)` lines (paths under the name).
- **VH-04 Filters** · H1 · `--file`, `--scope deposit`, `--limit 2`. · Rows narrow accordingly.
- **VH-05 Panel pane** · H3 · `(x)` opens the VARIABLE pane; the input accepts a name; a row
  click moves the Time Machine to its step; a read name button re-queries; the `?` on a row
  opens the why tree; `pyokka.showVariableHistory` with the cursor on a name fills it; with no
  session the command says to start one; with a name that never changed: "the last run recorded
  no change of NAME".
- **VH-06 (unchanged) rows** · H1 · A statement that assigns the same value again (`x = 1`
  twice with locals recorded). · The second row reads `= 1 (unchanged)`.

### WHY: provenance

- **WHY-01 Statement, reads, calls** · H1 + H2 · On the provenance fixture (saved run with
  locals) `pyokka why run.json <step of "area = scale(width, base)"> area` and
  `api.provenance` on the same program. · Root: the statement with the value; reads `width`
  and `base` with their values and the statements that made them (`width = base + 1`, `base =
  3`); a call `scale(width, base)` whose body was stepped, with arguments and result; depth
  five by default, `--depth 1` cuts it; CLI, saved run and API trees agree (the e2e `why.test.js`
  asserts the shape on demo.py).
- **WHY-02 Not-stepped calls as leaves** · H1 · Same fixture, `why` on `acct` after
  `acct = Account("ivor")`. · The dataclass constructor shows as `... not stepped` leaf; a
  builtin call (`len(label)`) too.
- **WHY-03 Without a name** · H1 · `pyokka why run.json STEP`. · Explains the statement at
  that step.
- **WHY-04 Panel entry points** · H3 · The `?` on an entry, on a Variable pane row, the hover's
  Why link and `pyokka.whyValue` with the cursor on a name all open the tree in DETAILS with a
  "Back to entries" close button; a line click moves the Time Machine; the tree follows re-runs
  while open; `pyokka.whyValue` with no name under the cursor shows the info message; a Why on
  an entry from a replaced run says to hover again.
- **WHY-05 Arguments need locals** · H2 · Same query with and without Record Variable Changes.
  · Call arguments are `?` without, values with (the e2e "carries the arguments once the
  session records locals").

### EG: execution diagram

- **EG-01 Nodes and edges** · H1 · `pyokka graph` on the graph fixture and on demo.py. · The
  module node; `parse_event`, `shout`, `Event.__init__` with `×N`, `in ... · out ...` on the
  first call; statement nodes under each scope in run order with hit counts and what they
  printed or raised; decision nodes with the arm taken and `not run: L`; call edges `→` with
  counts and steps; data edges `⇢` labelled with the parameter; the raised `ValueError` on
  `shout("")` marked; `--no-statements` drops the statement nodes; `--dot` prints a Graphviz
  digraph that `dot -Tsvg` accepts when Graphviz is installed; `--scope NAME` narrows;
  200-node cap on a program with more functions (generate one).
- **EG-02 Library packages** · H1 · The walkthrough fixture with `--library-code`: one
  collapsed `libq` node with the nested call count; `--expand libq` and `--all` unroll it.
- **EG-03 Agreement live / saved / host** · H2 · `execution-diagram.test.js` asserts the same
  nodes and edges through the bridge, the CLI and `api.graph(session)`; run that suite alone
  and read its output.
- **EG-04 Panel view** · H3 · `pyokka.showExecutionDiagram` (also the rail More menu and the
  Time Machine toolbar button): with the default settings the canvas shows one card per scope
  in column segments, callees beside the calling card, no statements; a card's chevron (`▸ N`)
  opens that scope's statements and decisions stacked under it, callees beside the calling
  statement, and folds them again (`▾ N`); the toolbar's list-tree button opens or folds every
  scope, the arrow-both button shows or hides the data edges (hidden by default); zoom in /
  out / fit width; the step scrubber moves the Time Machine and follows it; the left pane's
  STORY tab lists the run as an outline (module, phases named by the comment above them or the
  names they assign, statements, the called scopes nested and folded), a row click selects the
  node, moves the Time Machine and opens the scope; the WALKTHROUGH tab is the walkthrough
  list; the inspector on the right shows the selected node's rows and, once answered, every
  step it ran at with the value logged there, the current one marked, and previous / next hit
  buttons (a statement of a folded scope still shows); nodes not entered yet are dimmed,
  finished ones ticked, the current call stack highlighted (a folded scope's merged call edge
  lights when the stack runs through one of its calls); clicking a node jumps to its first
  call; clicking a package node unrolls it (requires library code on, `unrolls a package node
  when Step Into Library Code is on` in the e2e); a click on a scope frame selects the scope;
  with no run yet the command shows "nothing to draw yet".
- **EG-05 Diagram settings** · H2 + H3 · `pyokka.diagram.build` defaults to `onOpen`: after a
  run with the diagram closed no graph is sent (H2: the panel host's `executionGraph` message
  is null; observe with the extension logs or a webview message trace), opening the view asks
  for it and it appears; `onRun` sends it as the run finishes. `pyokka.diagram.detail:
  statements` opens every scope from the start; `pyokka.diagram.dataEdges: true` draws the
  data edges; `pyokka.diagram.phases: false` lists the statements directly under their scope
  in the STORY tab. Changing any of them while the view is open re-sends the settings and
  drops the toolbar's overrides. `pyokka graph` and `api.graph(session)` are unchanged by all
  four (EG-01, EG-03).

### EXC: exceptions report

- **EXC-01 Fixture rows** · H1 + H2 · Copy `test/unit/fixtures/exceptions/` into a temp
  workspace, run with library code on (the CLI flag, the session toggle) and read
  `pyokka exceptions run.json` and `api.exceptions(session)`. · Rows in this order and shape:
  uncaught `ZeroDivisionError` first; `KeyError` raised in `lookup` caught at the bare `except:`
  in `<module>`, count 3, `broad handler`; `ValueError` caught in `parse_amount`'s `except
  ValueError` (not broad); `OSError` caught at `except Exception` in `load` (broad), not at the
  `finally` or the `with`; `RuntimeError` caught by the outer `except RuntimeError as err` (the
  inner handler re-raised); `IndexError` caught at the `with contextlib.suppress` line;
  `TypeError` raised in `libx.unwrap` caught in `<module>`; no row for the `TypeError` that
  `libx.safe_unwrap` catches itself; `AttributeError` from `Lazy.__getattr__` "caught outside
  stepped code" with count 2. Rows agree between CLI, bridge and API (`exceptions.test.js`).
- **EXC-02 demo.py** · H1 · `pyokka exceptions demo.json`. · Exactly one row, the uncaught
  `ValueError`, not also listed as caught.
- **EXC-03 Panel section** · H3 · EXCEPTIONS under the entries: "NO EXCEPTIONS" for a clean
  program, rows as above otherwise, `broad handler` flagged, a row click moves the Time Machine
  to the raising step.
- **EXC-04 Errors in the editor** · H2 · demo.py's error: the message painted beside line 105
  in the error colour, the red gutter square, `state.errors[0].traceback` present; a scratch
  with a `SyntaxError`: one error entry of type `SyntaxError` on the offending line and no
  trace; a `ModuleNotFoundError`: the error entry plus PKG-01.

### HTTP: observe, record, replay

Use a local server as `http-replay.test.js` does (`http.createServer` in a spec, or
`python3 -m http.server` for GETs) so nothing leaves the machine.

- **HTTP-01 Observe by default** · H2 + H3 · A scratch that GETs `http://127.0.0.1:<port>/hello`
  with `urllib.request`, then with `requests` and `httpx`. `python/.venv/bin/python` (3.12,
  the runtime's dev venv) has `httpx` 0.28 and `requests`; point `pyokka.python.interpreter`
  at it for this case. The example venv at `<example>/.venv/bin/python`
  has the `httpx2` fork instead (no plain `httpx`): use it for one extra run with `import httpx2`.
  · `state.finished.http.mode === 'off'`, `requests === N`, nothing written under `.pyokka/`;
  H3: the HTTP view lists one row per request with name, method, status, `file:line`,
  size, time and source `live`; the row's link moves the Time Machine to the request's step;
  the footer sums the requests; the program's output is unchanged by observation.
- **HTTP-02 httpObserve off** · H2 · `pyokka.httpObserve: false` (or `"httpObserve": false`
  in `.pyokka`), same scratch. · `state.finished.http` absent; the view says "HTTP clients
  untouched".
- **HTTP-03 Record** · H2 · Session HTTP mode `record` (`session.setHttp('record')`, the
  panel's dropdown, or `pyokka.http: 'record'` before starting), re-execute. · `.pyokka/replay/<16 hex>.jsonl`
  appears in the workspace with a header line and one line per exchange (`request`,
  `response`, `key`, `elapsedMs`); `finished.http.recorded === N`; the status bar reads
  `· recorded N` and, while the mode stays record, `· HTTP record`; the rail globe carries a
  badge (H3); a notice offers to add `.pyokka/replay/` to `.gitignore` once per workspace
  (H3; accept: the line is appended; "Not now": never asked again in that workspace state).
- **HTTP-04 Replay with the server gone** · H2 · Stop the server, switch to `replay`, edit a
  `print` line, re-execute. · Same values as recorded, `finished.replayed === true`,
  `served === N`, `misses === 0`, header `· replayed`, rows' source `replayed` with
  `recordedMs`; the run is fast.
- **HTTP-05 Miss** · H2 · In replay mode add a request the recording lacks (a new URL). ·
  `finished.http.misses === 1`, a `runner.error` "no recorded response for GET ...; run once
  in record mode", the program sees a `ConnectionError` (its traceback in `state.errors`),
  the status bar reads `replayed, 1 missing`, the row's source is `miss` with `MISS` status.
- **HTTP-06 Identical requests replay in order; last one repeats** · H2 · Record a program that
  GETs `/hello` three times (the server answers with a counter), replay a version that calls it
  four times. · The first three replay `n: 1, 2, 3`, the fourth repeats the third.
- **HTTP-07 Secrets never in the recording** · H1 · A program sending `Authorization: Bearer
  <env value>` and a body containing the env value, recorded with `pyokka run --http record`
  and `QA_API_KEY=<random>` in the environment. · The JSONL has no `authorization` header and
  the body shows `••••••••`; the `url` in `http.exchange` rows keeps query names but not values.
- **HTTP-08 Streamed responses** · H2 · An SSE-style endpoint answered in chunks read through
  `httpx` streaming. · Recorded with `streamed: true` and `chunks`; replay delivers the same
  pieces (the consumer sees the same events).
- **HTTP-09 Open recording** · H2 + H3 · `pyokka.openHttpRecording` (and the view's button). ·
  The JSONL opens beside the editor (with `{n}` the row's line is selected); with no recording
  the info message names the session; a rewritten recording shows the status bar message.
- **HTTP-10 Mode Off with a recording on disk** · H3 · After HTTP-03, set the mode Off. · The
  view's footer says a recording from <date> (N requests) exists and offers Replay; the
  status bar keeps the last run's `· recorded N`.
- **HTTP-11 CLI parity** · H1 · `pyokka run scratch.py --save r.json --http record`, then
  `--http replay`, `pyokka http r.json` (and `--json`). · The text header `N requests · size ·
  time · recorded to <file> (<date>)` then one line per row; the table equals the one the
  bridge serves for the same program live (`state.finished.http` fields agree).
- **HTTP-12 Real API through replay only** · H3, optional, with the user present · On the
  test bed's `agent.py` with HTTP Replay and the existing recording: the run returns the
  recorded response with no network (unplug or observe `served`); do not run it in Off or
  Record.

### SEC: secrets

- **SEC-01 Env value by name, literal under a secret name** · H2 · Repeat `features.test.js`
  "masks secrets": `examples/.env` with `E2E_API_KEY=<random>`, a scratch reading it, printing
  `"Bearer " + from_env` and a dict `{"api_key": "hardcoded-literal", "model": "gpt"}`. ·
  Entries never contain the key or the literal; texts include `Bearer ••••••••` and
  `{'api_key': '••••••••', 'model': 'gpt'}`; `session.maskSecrets` is true by default; delete
  the `.env` afterwards.
- **SEC-02 Reveal per session** · H2 · `setMaskSecrets(false)` (Automatic re-runs). · The
  values appear in full; a new session on another file is masked again; the user setting
  `pyokka.secrets.mask` is unchanged.
- **SEC-03 None stays visible; extra names** · H2 · `missing = os.environ.get("QA_NOPE_KEY")`
  printed; `pyokka.secrets.names: ["licence"]` and `licence = "abc-123"` printed. · `None`
  shows; the licence value is masked; a name outside the list (`colour`) is not.
- **SEC-04 Masking reaches everything** · H2 + H3 · With SEC-01's file: the hover on
  `from_env`, a watch on it, Step Variables, the exception message of `raise ValueError(from_env)`,
  the `pyokka` output channel. · Each shows `••••••••`; the panel renders it blurred (H3).
- **SEC-05 CLI redaction by shape** · H1 · `test_agent_cli.py`'s program has
  `secret = "sk-abcdefghijklmnopqrstuvwxyz012345"`; `pyokka find run.json sk-` and `context`
  on that line. · Values show `«redacted»`; the source line in `story` still shows the literal
  (documented). `python/tests/test_redact.py` and `test/unit/redact.test.ts` share the fixture.

### PKG: quick package install

- **PKG-01 Hover and quick fix on a missing module** · H2 · Scratch `import yaml_missing_qa` (a
  name not installed). · The run reports `ModuleNotFoundError`; `executeHoverProvider` on the
  import line returns a hover with links "Install ... into project" and "Install only for this
  Pyokka file"; `executeCodeActionProvider` returns two quick fixes; the mapping table turns
  `cv2` into `opencv-python` (hover text on `import cv2`).
- **PKG-02 Install into a throwaway venv** · H3 · Create a venv in a temp folder, point
  `pyokka.python.interpreter` at it, scratch `import six`, run the "into project" action. · A
  terminal runs `uv pip install --python <venv> six` (or `pip install`), the notice "installing
  in the terminal. Re-execute the file when it finishes" offers "Re-execute now", the file
  re-runs after the install and the error is gone; `Cmd/Ctrl+K I` runs the per-file variant,
  which installs into a Pyokka-owned target directory and leaves the venv untouched (check with
  `<venv>/bin/python -c "import six"` failing after the per-file install).
- **PKG-03 Template** · H2 · `pyokka.installPackageCommand: "echo QA {packageName} {python} {target}"`.
  · The terminal runs the echo with the substitutions.
- **PKG-04 Failure** · H3 · A package name that does not exist. · Warning "install command
  exited with code N"; the session is unchanged.

### PROF: profiler

- **PROF-01 Profile run** · H2 · `session.runNow('profile', { mode: 'profile' })` (or
  `pyokka.profile`). · `finished.profile.path` exists and parses as JSON with more than one
  node; `session.mode` stays `normal`; `pyokka.profile` then opens the `.cpuprofile` in the
  editor (H3: VS Code's profile table, functions under `(root)`, no `pyokka_runtime` frames)
  and the inline values and coverage are back after the automatic re-run.
- **PROF-02 Without a session** · H2 · `pyokka.profile` with none active. · "start a session
  first" and nothing runs.

### SNAP: snaps

- **SNAP-01 Discovery hover and allow** · H2 · Scratch `x = 40`, `"""{{`, `x + 2`, `}}"""`,
  `y = x + 1`. · Hover on the opening line returns "Pyokka snaps detected ... [Allow]";
  `pyokka.allowFileSnapsExecution` starts a session in `snaps` mode whose entries include a
  `value` `42`; the hover now offers Insert output / Delete output.
- **SNAP-02 Double Space allows** · H3 · Inside the fence press Space twice quickly. · The two
  spaces are removed and execution is allowed (session starts).
- **SNAP-03 Insert and delete output** · H2 · `pyokka.insertSnapOutput` with the cursor in
  the fence, then `pyokka.deleteSnapOutput`. · A `#» 42` line is written under the fence, then
  removed; with the cursor outside any fence: "no snap fence at the cursor".
- **SNAP-04 Confirmations** · H3 · Reopen the allowed file: "has N snap(s) allowed earlier.
  Run them?" with Run snaps / Not now; add a second fence: "a new snap was added. Run all snaps
  in this file?" with Run / Stop running snaps (the latter returns the session to normal mode);
  `pyokka.snapsAutoRunConfirmOnOpen: false` and `...OnEdit: false` skip the prompts.
- **SNAP-05 Discovery off** · H2 · `pyokka.stopFileSnapsDiscovery` then hover the fence. · No
  snap hover; `pyokka.startFileSnapsDiscovery` restores it; `pyokka.snapsAutoDiscovery: false`
  disables it everywhere.
- **SNAP-06 Errors inside snaps continue** · H2 · A fence whose first statement raises and a
  second that logs. · Both an error entry and the second value; the top-level statements after
  the fence still run.
- **SNAP-07 Snippets `snap` / `snapo`** · H4 · In a Python file type `snap` and accept the
  suggestion. · A fence is inserted; `snapo` adds the `#» ` line; `?` inserts `# ?`.

### SNIP: snippets, new files, recent files

- **SNIP-01 New Python File** · H2 · `pyokka.newPythonFile`. · An untitled Python document
  with the starter comment, cursor at the end, a session started (`sessionForDocument`
  exists) in Automatic mode (untitled is a scratch under `smart`; under the `onSave` default it
  is On Save: record which).
- **SNIP-02 New File picker** · H3 · `pyokka.createFile` (`Cmd/Ctrl+K L`). · Items: Empty
  Python file, the Pyokka snippets (when the snippets file exists), up to 15 recent files, Edit
  Pyokka snippets…, View all recent files…; picking a snippet opens its body as an untitled
  file with a session started and Auto Log on.
- **SNIP-03 Edit snippets and create from selection** · H2 · `pyokka.editSnippets` with no
  `~/.pyokka/pyokka.code-snippets` (move an existing one aside first and restore it after). ·
  The starter file is created and opened as JSONC with two snippets; select some code and run
  `pyokka.createSnippetFromSelection` (H3 for the two input boxes): the snippet is appended and
  "snippet saved" offers to open the file; with no selection: "select the code ... first".
- **SNIP-04 Recent files view** · H2 + H3 · `pyokka.viewRecentFiles`. · A `pyokka-recent`
  document listing each entry with its name, date and project root and a 40-line preview; code
  lenses Run, Clone and Run, Run in <other folder> (multi-root only), Remove from recent files
  (`executeCodeLensProvider` on the document URI); Run opens and starts the file; Clone and
  Run starts an untitled copy; Remove drops the entry; a deleted file's Run warns "no longer
  exists". Empty store: the `# No recent Pyokka files yet` line.
- **SNIP-05 File > New File menu** · H4 · The menu lists "New Python File" and "From Recent /
  Snippet" under Pyokka.

### INT: interpreter and environment

- **INT-01 Resolution order** · H2 · With `pyokka.python.interpreter` set to a relative
  `.venv/bin/python` inside a temp workspace that has one, start. · `session.interpreter.path`
  is that venv and `source` is `setting`; unset it: the Python extension's environment (when
  installed), else `python.defaultInterpreterPath`, else `python3` on the PATH (`source: 'PATH'`).
- **INT-02 Too old** · H2 + H3 · Point the setting at a Python 3.11 or older executable (or a
  shell script printing `3.10.0` for `sys.version_info`). · The session does not start; error
  "Pyokka needs Python 3.12 or newer ..." with actions; a non-Python executable: "does not run
  as a Python interpreter".
- **INT-03 Picker and Browse** · H3 · `pyokka.selectInterpreter`. · Candidates listed with
  their source and version, plus Browse; Browse opens a file dialog in the file's folder;
  choosing a venv inside the workspace writes `pyokka.python.interpreter` to the workspace
  settings as a relative path and offers to restart sessions.
- **INT-04 .env** · H2 · `examples/.env` with `QA_FROM_ENV=1` and a scratch printing it. ·
  `1`; with `pyokka.env: {"QA_FROM_ENV": "2"}` the explicit value wins; `python.envFile`
  pointing elsewhere is honoured; delete the `.env` afterwards.
- **INT-05 args** · H2 · `pyokka.args: ["a", "b"]`, scratch printing `sys.argv`. · `[..., 'a',
  'b']` with the script path first.
- **INT-06 Plugins** · H1 + H2 · A module on `sys.path` with `before(config)`,
  `before_each(config)` and `after(config)` that write marker files; `pyokka.plugins:
  ["qa_plugin"]`. · The markers appear once per run in that order; `after`'s returned dict is
  merged into `run.finished`.
- **INT-07 Spawn mode** · H1 · `PYOKKA_SPAWN=1 python -m pyokka_runtime run examples/demo.py`
  from `python/`. · The same events as without it (the Windows code path on macOS).
- **INT-08 Working directory** · H2 · A scratch printing `os.getcwd()` in a single-folder
  workspace, then in a multi-root one after `pyokka.selectWorkspaceFolder` (visible only with
  two or more folders). · The chosen folder is the cwd and the session's project root.

### CFG: configuration, auto start, trust

- **CFG-01 Save as defaults** · H3 · Change Auto Log, Value Peek, Step Into Library Code and
  the timeout in the Settings view, press save. · `pyokka.autoLog`, `pyokka.valuePeek`,
  `pyokka.timeMachine.libraryCode`, `pyokka.runTimeout` change in the user settings;
  `pyokka.runMode` does not.
- **CFG-02 automaticRestart** · H2 · `pyokka.automaticRestart: true`; start on a file, close
  the editor, reopen the file. · A session starts by itself (`start mode open`); with the
  setting off it does not.
- **CFG-03 automaticStartRegex** · H2 · `pyokka.automaticStartRegex: "scratch_.*\\.py$"`; open
  `scratch_qa.py`. · A session starts on open; an invalid regex logs a warning and starts
  nothing.
- **CFG-04 smartStart rules** · H2 · `pyokka.smartStart: [{"pattern": "**/auto_*.py",
  "startMode": "edit"}]` and the other modes. · `always`/`open` start on open, `edit` starts on
  the first edit, `never` never (even with the regex matching).
- **CFG-05 Untrusted workspace prompt** · H3 (dev host without `--disable-workspace-trust`,
  fresh user-data-dir, choose "No, I don't trust" on the folder) · Start a session. · A modal
  "This workspace is not trusted. Pyokka executes the file with your Python interpreter. Run
  anyway?" with Run and "Always run in untrusted workspaces"; Run starts once; Always writes
  `pyokka.untrustedWorkspaceBehavior: Always allow` and later starts do not ask; `Never allow`
  shows the disabled warning and starts nothing; the output channel logs the decision.
- **CFG-06 Multi-root** · H2 + H3 · A workspace with two folders. · `pyokka.selectWorkspaceFolder`
  is in the palette; Recent Files lenses offer "Run in <folder>"; INT-08 holds.
- **CFG-07 Cursor chords** · H4 (Cursor installed) · `Ctrl+Alt+P Q`, `Ctrl+Alt+P J`,
  `Ctrl+Alt+P L`, `Ctrl+Alt+P V`, `Ctrl+Alt+P X`, `Ctrl+Alt+P I`, `Ctrl+Alt+P S` (stop). · Each
  equals its `Cmd+K` twin.
- **CFG-08 One-time notices** · H3 (spec or dev host without `PYOKKA_E2E`, fresh
  user-data-dir) · Start On Save in a project: "Pyokka runs project files on save ..." with
  "Run automatically" switching the session; start Automatic: "Pyokka re-runs ... on every
  edit, hover and watch ..." with Run on save / Run on demand / Keep automatic. Each appears
  once per profile.
- **CFG-09 Glyph margin** · H4 · `editor.glyphMargin: false`. · Coverage squares are not
  shown and, with `pyokka.suppressGlyphMarginNotifications` true (default), no notice; record
  whether a notice appears when set to false.
- **CFG-10 Session settings survive re-runs, not new sessions** · H2 · Set library code and a
  timeout on a session, re-run, then stop and start again. · Kept across the re-run; the new
  session reads the settings defaults.

### CLI: the pyokka command line over saved runs

Program: the two-file `MAIN`/`HELPER` from `python/tests/test_agent_cli.py` copied to a temp
folder as `main.py` / `helper.py`.

- **CLI-01 run --save** · `pyokka run main.py --save run.json`. · Prints `saved run.json: 28
  steps, 2 files, exit 1` and `ValueError: too small: 6`; exit status 1 (the program's);
  `run.json` holds `meta` with file hashes and redacted events; `--no-locals` drops the
  `locals` events; `--auto-log` adds `autoLog` entries; `--timeout 1` on a sleeping program
  reports the kill; `--library-code` and `--http` as elsewhere; `pyokka run main.py`
  without `--save` prints the pretty event listing, `--json` the NDJSON, `--instrumented` the
  rewritten source.
- **CLI-02 story** · `pyokka story run.json`, `--file helper.py`, `--scope double`, `--line
  main.py:10`, `--limit 5`. · Blocks per scope with a step number per line; filters narrow;
  the limit truncates with a note.
- **CLI-03 steps** · `pyokka steps run.json --from 0 --count 5`, `--line helper.py:2`. ·
  Numbered lines `file:line function`; the `--line` form lists every hit (three for `double`).
- **CLI-04 step and context** · `pyokka step run.json N --into` from the `helper.double(i)`
  call, then `--over`, `--out`, `--back`, `--back-over`, `--back-out`, `--to M`; `pyokka
  context run.json N`, `--line main.py:9`, `--scope`. · Every answer has location, stack, the
  block with `>` and `#N`, values, never-ran lines, errors and `moves:` with `—` for
  impossible moves; `--scope` lifts the 60-line / 20-value caps; an out-of-range `--to` is an
  `error:` with a hint and exit 2.
- **CLI-05 values and find** · `pyokka values run.json --line helper.py:2`; `pyokka find
  run.json hello`, `find run.json too\ small`, `find run.json sk-`. · Values by hit; find
  lists values, output, errors and source lines; the token is `«redacted»`.
- **CLI-06 var and why** · `pyokka var run.json total`, `pyokka why run.json <step> total`,
  `--depth 2`. · As VH-02 / WHY-01 on this program (`total` changes 0, 0, 2, 6).
- **CLI-07 eval, expand, release with --keep** · `pyokka run main.py --save k.json --keep`,
  `pyokka eval k.json "total * 2"` → `12`; `eval k.json "greet('x')"` refused (calls); `pyokka
  eval k.json total --json` gives a `valueBag.data.id`, `pyokka expand k.json <id>` expands
  it; `pyokka release k.json` shuts the runner down; `eval` afterwards says the run is not kept.
  Without `--keep`, `eval` explains it needs `--keep` or `--live`.
- **CLI-08 state and staleness** · `pyokka state run.json`; edit `helper.py`; `state` again
  and any other command. · `stale: helper.py changed since the run` printed first;
  `--json` has `"stale": true`.
- **CLI-09 walkthrough, graph, exceptions, http, narrate** · Each command on `run.json` (see
  WT, EG, EXC, HTTP, WT-04). · Text and `--json` forms; `narrate --dry-run` prints the prompt.
- **CLI-10 Error handling** · Missing run file; a command without `RUN` and without `--live`;
  `--line` without a colon; `step` with two move flags; `--live` and a run file together. ·
  Each is an `error: ...` line plus a hint on stderr, exit 2, no traceback.
- **CLI-11 uvx entry point** · `uvx --from ./python pyokka --help` from the repository root. ·
  Lists every subcommand including `http` and `narrate`.

### LIVE: the bridge and --live

Preconditions: hygiene rule 3, `pyokka.agentAccess: true`, a session on `examples/demo.py`.

- **LIVE-01 Descriptor lifecycle** · H2 · Toggle `pyokka.agentAccess`. · Off: no descriptor
  (`api.agentBridge.descriptorFor(session)` undefined, nothing new under `~/.pyokka/sessions/`);
  on: a `<pid>-<n>.json` with `socket`, `token`, `pid`, `workspace`, `file`, `displayName`;
  off again: socket and descriptor removed; a stale descriptor from a dead pid is swept on
  activation.
- **LIVE-02 Token** · H2 · Connect to the socket and send a wrong token line. · The connection
  closes; the right token gets replies.
- **LIVE-03 Requests** · H2 + H1 · Through a small NDJSON client (copy the `Client` class from
  `test/e2e/why.test.js`) and through the CLI: `state` (file, steps, exit code, Time Machine
  inactive), `step {kind:'into'}` (starts the Time Machine at step 1, replies a context slice,
  moves the editor), `step {to: N}` and an out-of-range `to` (refused with a hint), `context
  {file, line}`, `values {file, line}`, `var {name}`, `why {step, name}`, `eval {expression}`
  (no run; `state.runId` unchanged), `expand`, `select {file, range}` (the editor selection
  moves), `walkthrough`, `graph`, `exceptions`, `http`, `watch` (events stream while stepping in
  the editor; `unwatch` stops them), an unknown type (error plus hint). Every reply is redacted.
- **LIVE-04 CLI live commands** · H1 · `pyokka state --live --session demo.py --json`; `pyokka
  step --live --into` (the editor follows; the user sees the move); `pyokka step --live --to
  20`; `pyokka context --live --line demo.py:11` (shows the printed dict); `pyokka values
  --live --line demo.py:20`; `pyokka var --live total`; `pyokka why --live total` (defaults to
  the Time Machine's step) and `pyokka why --live 30 total`; `pyokka walkthrough --live`;
  `pyokka graph --live`; `pyokka exceptions --live`; `pyokka http --live`; `pyokka eval --live
  "point_a.x"` → `5`; `pyokka expand --live <id>`; `pyokka watch --live` prints one line per
  F10 in the editor, `stopped` when the Time Machine is closed and `rerun` after a save, then
  Ctrl-C ends it.
- **LIVE-05 Refused live commands** · H1 · `pyokka story --live`, `find --live x`, `steps
  --live --line demo.py:20`. · `error:` naming the saved-run alternative, exit 2.
- **LIVE-06 Session selection** · H1 · Two live sessions on different files: a command with
  `--line other.py:1` picks the other file's session; `--session demo.py` picks by name; two
  windows with `demo.py`: "2 live sessions match" and a hint to pass the descriptor path; no
  session: "no live session" with the hint to turn the setting on.
- **LIVE-07 Staleness live** · H1 · Edit `demo.py` without saving; `pyokka state --live`. ·
  `stale: demo.py changed since the run`; save (Automatic re-runs) and it clears; step numbers
  from before are void (documented).
- **LIVE-08 Windows notice** · N-A on macOS · The bridge shows a notice once on Windows where
  Unix sockets are unavailable; record N-A.

### DBG: the debugger

Program: `test/e2e/fixtures/debug_target.py` (a loop calling a small function and mutating a
dict; the e2e specs pin its lines) opened in a workspace, or a scratch copy. The debugger is
the runtime's own pause at the frontier (`docs/HANDOFF-debugger.md`); nothing here needs
debugpy. Rule 3 applies: no other window may hold a session on the same file during the
`--live` cases.

- **DBG-01 Start** · H2 + H3 · "Pyokka: Debug Current File" on the fixture with a gutter
  breakpoint in the loop body and no `launch.json`; then a launch configuration with
  `"stopOnEntry": true`; then `pyokka debug --live`. · A VS Code debug session of type `pyokka`
  opens (toolbar, Variables, Call Stack) alongside the panel and the run stops at the
  breakpoint, nothing at the entry; with no breakpoint it runs to the end and the debug session
  closes, the Pyokka session staying. With `stopOnEntry`, and from the CLI, the run
  pauses before its first statement (reason `start`, step 0); the status bar reads
  "Debug: paused at debug_target.py:<line> (start)"; the Time Machine is attached at step 0
  with the frontier marker there; the panel header says where and why; `session.debug.paused`
  has `stack` `[<module>]`. Nothing printed yet.
- **DBG-02 Breakpoints and conditions** · H2 · A gutter breakpoint inside the loop body; a
  second one with the condition `i == 1`; Continue. · Each hit pauses before the statement
  with the values before it (hover `total` shows the pre-addition value); the conditional one
  pauses once; a breakpoint on a `def` line pauses at every entry of the function; one on a
  blank line resolves to the next statement (`breakpoint.resolvedLine` in the paused info);
  a breakpoint set on an imported project module before it is imported is honoured when the
  module loads; a condition that raises pauses and shows `conditionError`.
- **DBG-03 Step into, over, out** · H2 + H3 · From the call line: Step Into lands on the
  function's entry step (its `def` line, one deeper scope); Step Into again on its first
  statement; Step Out on the caller's next statement; Step Over from a call line runs the call
  to completion and lands on the next statement of the same scope; at module level Step Out
  runs to the end and the run finishes. Each stop reports `kind`.
- **DBG-04 Behind the frontier** · H2 + H3 · While paused, Step Back and Step Over backward. ·
  They replay the recording (the position decreases, no new pause, values as of the step
  with earlier passes dimmed); moving forward again stops at the frontier (dead-end flash);
  at the frontier a forward move executes. The strip keeps the frontier band while the
  position is behind it.
- **DBG-05 Live frame** · H2 + H3 · At a pause inside the function: hover a parameter and an
  expression; STEP VARIABLES. · Hover evaluates in the paused frame with no re-run (Value
  Peek shows the live value); watches added while paused evaluate at the frontier and never
  re-run the file; STEP VARIABLES lists `debugLocals()` (name, type, value); a list of dicts
  renders as a table with one column per key and a footer with the counts; a local that is
  `None` offers "why?"; two names bound to the same object show `= other`.
- **DBG-06 Break-when watches** · H2 · Add a watch `total` with break when it changes, then
  one `total > 2` with break when true; Continue repeatedly. · The change watch pauses at
  every step where the text differs from the last observation (the first observation is the
  baseline); the true watch pauses once on the rising edge; the paused header names the watch
  and its text; a name not in scope never fires.
- **DBG-07 Pause on request and the clock** · H2 · A fixture that sleeps 50 ms per iteration;
  Continue, then Pause after 300 ms. · The run pauses at its next statement (reason `pause`);
  with `pyokka.runTimeout` shorter than the time spent paused, the run does not time out:
  the clock stops while paused and resumes on Continue.
- **DBG-08 Stop and finish** · H2 · Stop Debugging while paused; separately Continue to the
  end. · Stop ends the run with `stopped: true` and a final trace; the finished debug run is
  a normal finished run the Time Machine owns (complete trace, position kept); an implicit
  re-run (edit, hover in Automatic mode) while a debug run is in flight is refused, logged
  once, and never kills the paused run.
- **DBG-09 Gutter sync** · H2 · Add and remove gutter breakpoints while paused and while
  running. · The run's breakpoint list follows (`debug breakpoints` echo); a breakpoint added
  during a pause is hit on the next Continue; logpoints stay markers.
- **DBG-10 The null hunt from the CLI** · H1 + H2 · `pyokka.agentAccess` on; `pyokka debug
  --live`, `watches --live --add "normalized is None" --break-when true` (a name the fixture
  assigns), `continue --live`, `locals --live`, `why --live <name>`, `state --live`, `watch
  --live` in a second terminal. · Each stop prints `paused at file:line (reason)` and the
  slice like `step`, and the editor moved there; `why` prints the tree and a closing
  sentence built from recorded values (the conclusion; empty when nothing was recorded);
  `state --live` has a `debug:` line; the watch stream prints `paused …`, `resumed`,
  `finished: exit 0`; `break --live FILE:LINE --when EXPR` shows in the gutter; `--json` on
  every command is the raw reply; on a saved run each debugger command exits 2 with the
  `--live` hint.
- **DBG-11 The standard debug views** · H3 · A launch configuration `{"type": "pyokka",
  "request": "launch", "program": "${file}"}`, F5 on the fixture. · VS Code's debug toolbar
  drives the same run: Variables shows the paused frame's locals (nested values expand), the
  Call Stack lists the scope chain (caller lines are the scopes' `def` lines, an
  approximation), Watch and hover evaluate in the frame, Continue / Step Over / Step Into /
  Step Out / Pause map to the debugger; the run's end terminates the debug session. The
  Pyokka panel shows the same frontier at the same time.
- **DBG-12 Why, the conclusion** · H1 · `pyokka why run.json <step> <name>` on a value from a
  conditional expression and on one from a call (`examples/demo.py` has both). · The tree is
  unchanged and ends with one or two sentences naming the arm that ran and the test's value,
  or the call and what it returned, each with its step and `file:line`; identical text from
  the CLI and the panel (twin fixtures).
- **DBG-13 Watch expression completion** · H1 + H3 · Paused at a breakpoint inside the loop
  of `test/e2e/fixtures/debug_target.py`; the + in the panel's Watch expressions header, type
  `pay`, then `payload.`; the same in VS Code's Watch pane of the debug session; then
  `bump().`. · A dropdown lists `payload` (variable, dict) for the prefix and the dict's
  methods after the dot, no dunders until `_` is typed; Down/Tab lands `payload.items` in the
  input with the caret after it, Enter adds the watch; the Watch pane shows the same list from
  `.`; `bump().` shows no list (calls are refused) and the run stays paused throughout.
- **DBG-14 A debug session on its own** · H2 + H3 · `F5` on a fresh copy of
  `test/e2e/fixtures/debug_target.py` with a gutter breakpoint in the loop body and no Pyokka
  session on the file. · The program pauses at the breakpoint. No Pyokka session appears in the
  status bar's session list; the Debugger view shows where it paused and why, the call stack with
  each frame's own line, the frame's variables, the watches, the breakpoints and what the program
  printed; the Time Machine view is not attached and there are no values behind the pause; the
  status bar reads `Debugger: paused at debug_target.py:NN (breakpoint)`. Editing the file while
  paused is accepted, does not re-run and does not move the pause; the next Restart runs the
  edited file. With `pyokka.runTimeout` set to 800 ms the pause survives a 2 s wait and Continue
  finishes the run normally. Stop leaves nothing: the Debugger view goes, the rail's Debugger
  button goes, and `~/.pyokka/sessions` holds no debug descriptor.
- **DBG-15 A server** · H2 + H3 · A launch configuration for a `ThreadingHTTPServer` (or a
  uvicorn app **without** `--reload`) with a breakpoint in the handler. · The program runs and
  nothing pauses until a request arrives; then it pauses in the handler with the request's
  variables in scope and the thread named in the view. Continue answers the request. Two requests
  in flight pause one after the other. Stop kills the server and the port stops accepting. With
  `--reload` the breakpoint never hits and the panel shows a program doing nothing, which is the
  documented case: the debugger runs the parent and the code runs in a worker.
- **DBG-16 The CLI cold start** · H1 + H2 · `pyokka.agentAccess` on, the folder open in VS Code,
  no session on the file, and `ivor.pyokka` **not** in
  `extensions.confirmedUriHandlerExtensionIds` (the first-time state).
  `pyokka debug examples/demo.py --at demo.py:41` from a terminal. · VS Code asks whether to let
  Pyokka open the URI and waits. Click Open within the 20 s and the start goes through as below.
  Let the question sit instead: the CLI exits 2 with a hint whose first sentence is the dialog and
  the setting that silences it, and clicking Open a minute later still starts the session, which
  `pyokka state --live` then finds (a second `pyokka debug` is not needed). With `ivor.pyokka`
  added to the setting, no question comes and the start is immediate. Then, with the dialog out of
  the way: the window starts a debug session, the standard debug views open with the panel, and
  the CLI prints `paused at demo.py:41 (breakpoint)` with the block, the locals and the output.
  `state --live`
  lists both kinds of session for the file with `debug` first and `[this]` on the connected one.
  `continue --live --no-wait` prints `resumed` at once; `pause --live` stops it again.
  `why --live` and `walkthrough --live` exit 2 with `<verb> needs a recording`. With
  `pyokka.agentAccess` off the same command shows a warning toast with Open Settings, starts
  nothing, and the CLI exits 2 within 25 s with a message whose first check is the setting.
  `--at 9lives` exits 2 with `--at wants FILE:LINE or a function name`.
- **DBG-17 A module launch** · H3 · A launch configuration with `"module": "app.server"` and
  `"args": ["--port", "8000"]` against a two-file package. · The program runs as `__main__` with
  its arguments, a breakpoint inside the module hits, the status bar and the Debugger view name
  `-m app.server`, and the launch line in the view's header reads
  `<python> -m app.server --port 8000`. A launch with both `"module"` and `"record": true` is
  refused with a message that names `record: false`.
- **DBG-18 The console writes** · H2 + H3 · Paused at a breakpoint in `debug_target.py`. In the
  Debug Console run `total = 100`, then `items.pop()`, then `import json`, then `1/0`. Edit
  `total` in the Variables view to `7`. · `total = 100` answers nothing and the Variables view
  shows 100 on its next read; `items.pop()` prints what it returned; the import succeeds and a
  later `json.dumps({})` works; `1/0` prints `ZeroDivisionError: division by zero` and the
  session is still paused, with Continue working. The Variables edit takes and the row shows `7`.
  From the first of them on, the Debugger view carries the banner "Values were changed from the
  console", the status bar tooltip says `modified: values were changed from the console`, and
  every later stop line the CLI prints ends in ` (values modified from the console)`. Hovering a
  name and adding it to the Watch pane still only read: neither changes anything. From a
  terminal, `pyokka exec --live 'total = 100'` prints `ok` and the program's output after
  Continue shows 100; `pyokka exec --live '1/0'` prints the error on stderr, exits 0, and prints
  `still paused at …` on stdout.
- **DBG-19 Agent navigation** · H1 · A debug session paused near the top of `examples/demo.py`.
  · `pyokka continue --live --to demo.py:82` stops at line 82 and the editor follows.
  `pyokka continue --live --until 'rank == 3'` stops at the first statement where that holds,
  with `(watch rank == 3: True)` on the stop line. `pyokka step --live --over --count 3` prints
  one stop, three statements on. With a breakpoint two steps away, the same command stops there
  and the reply names `stopped early after 2 steps: breakpoint`. `pyokka break --live --at rrf`
  lists the breakpoint with `rrf` and its resolved line, the Breakpoints view shows a function
  breakpoint for `rrf`, and the next Continue pauses at the function's entry. Set before the
  module that defines the name is imported, the same spec is listed `(not resolved yet)` and
  still pauses once the module loads. `pyokka debug
  demo.py --at rrf` from cold does the same in one command.
- **DBG-20 Recording, opt-in** · H1 + H2 + H3 · "Pyokka: Debug Current File (Recording)" on
  `examples/demo.py`, and `pyokka debug examples/demo.py --record` from a terminal. · Both start
  a recording debug session: the Time Machine attaches at every pause with values as of the step,
  Step Back replays behind the pause, the Code Story opens, and `why --live <step> total` answers
  over the bridge. The Debugger view and the second status bar item stay empty: a recording
  session is presented in the Time Machine view and the run-all status item, as before. When the
  program exits it is a finished run the Time Machine still owns. A launch with `"module"` and
  `"record": true` is refused with a message that names `record: false`, and so is `pyokka debug
  --module app.server --record`.

### ERR: robustness

- **ERR-01 Syntax error** · H2 · A scratch with a syntax error. · One `SyntaxError` entry on
  the right line, no crash, coverage empty, the session stays alive and recovers on the next
  valid edit.
- **ERR-02 Empty file and comments only** · H2 · Start on an empty file and on a comments-only
  file. · Runs finish with no entries; the Time Machine says it ran no statement (TM-18).
- **ERR-03 Runaway output** · H2 · `for i in range(100000): print(i)`. · The run finishes
  within the timeout, the panel shows up to `maxConsoleMessages` entries, VS Code stays
  responsive (the `libdiag` suite's event-loop lag monitor is the reference for library runs).
- **ERR-04 Long lines and unicode** · H2 · A 10 000-character string, emoji, right-to-left
  text, `\x00` in a value. · Inline text is truncated to one line, Details shows the full
  value on Load, nothing garbles.
- **ERR-05 Close the editor mid-run** · H2 · A 5 s sleeping scratch; close the editor
  during the run. · The session stops (or finishes and is discarded) without an error toast
  other than expected; no orphan Python process (`pgrep -f pyokka_runtime` after 10 s lists
  only runners of live sessions).
- **ERR-06 Kill the runner** · H3 · `kill` the `pyokka_runtime serve` process of a session,
  then re-execute. · The error "Pyokka runtime error: ..." with Show Logs, and the next run
  spawns a new runner.
- **ERR-07 Reload window with sessions** · H4 · Reload with two sessions running. · No error
  on activation; sessions are gone (or restored with `automaticRestart`); the panel is
  consistent.
- **ERR-08 Non-file schemes** · H2 · Start on an untitled file (works), on the Code Story
  document (refused: not Python), on a file from a remote or virtual scheme if available
  (record).
- **ERR-09 Deep recursion and exceptions in reprs** · H2 · A class whose `__repr__` raises;
  a self-referencing list; a recursion `RecursionError`. · Values render a placeholder instead
  of crashing the run; the error report lists the `RecursionError` once.
- **ERR-10 Threads** · H2 · A program that prints from two threads and makes an HTTP request
  from a worker thread (HTTP-01 server). · Prints attributed to their lines; the HTTP row's
  initiator is the user statement that spawned the work (documented behaviour of the frame
  walk).
- **ERR-11 Large trace and deltas** · H2 · A 300 000-step loop under the default cap. · The
  status bar shows progress; partial trace deltas arrive (the Time Machine strip fills before
  the run ends is not required, but the final trace is complete); `state.trace.count` equals
  the step count in `run.finished`.
- **ERR-12 The vsix runs without node_modules** · H4 · The installed build (PRE-07) shows the
  panel's codicons (no missing-glyph boxes) and Monaco works in Details.

- **ERR-13 A child killed by a signal is reported, not silent** · H1 + H2 · Scratch:
  `import os, signal`, `print("before")`, `os.kill(os.getpid(), signal.SIGABRT)`. · H1
  (`python -m pyokka_runtime serve` driven by hand, or the pytest `Client`): an `output`
  event `before`, then a `runner.error` whose message starts `run child killed by SIGABRT
  (exit -6) before it finished`, then `run.finished` with `exitCode -6`, `stepCount 0`,
  `timedOut false`. H2: the toast "Pyokka runtime error: run child killed by SIGABRT …" with
  Show Logs, the status bar in the failed state, and the run is not repeated
  (`state.runId` changes once). A timeout (RM-09) and a stop produce no such error.
- **ERR-14 Second run of a file that reaches an Apple framework (macOS)** · H1 + H2 · Run
  this case with `env -u OBJC_DISABLE_INITIALIZE_FORK_SAFETY -u PYOKKA_FORK -u PYOKKA_SPAWN`:
  a developer shell that exports the first hides the bug entirely, which is how it stayed
  invisible on the machine where it was diagnosed. On macOS
  `printf '{"type":"hello","id":1,"version":"0.0.1"}\n' | python -m pyokka_runtime serve | head -1`
  from `python/` prints a `ready` line whose `capabilities` start with `spawn`; with
  `PYOKKA_FORK=1` it starts with `fork`. Then a scratch `import httpx`, `c = httpx.Client()`,
  `print("built")` (no network; `python/.venv/bin/python` has httpx) re-executed three times
  in one session, and `import urllib.request`, `print(urllib.request.getproxies())` the same
  way. · Every run exits 0 with steps and the print; no `runner.error`. Negative check, H1
  only: the same three runs with `PYOKKA_FORK=1` die on run 2 and 3 with exit -6, a
  `runner.error` naming SIGABRT with the `PYOKKA_FORK` hint, and
  `+[NSCharacterSet initialize] may have been in progress in another thread when fork() was
  called` on stderr; with `PYOKKA_FORK=1 OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` they pass.
  Before the fix (2026-09-12) the default behaved like the negative check, and so did the
  test bed's `agent.py` in HTTP Replay mode.

### UI: themes, layout, accessibility

- **UI-01 Dark and light themes** · H3 / H4 · Repeat the `uipass` captures manually (or run
  `PYOKKA_UI_PASS=1 ./node_modules/.bin/vscode-test`, which writes to
  `docs/reference/pyokka-live/`; move the new files to the scratchpad afterwards so the
  reference set is not changed). · Inline values readable in both themes (blue `log` in dark,
  `#0000ff` in light; `error` red variants), the panel follows the theme, the Monaco details
  switch theme with the window.
- **UI-02 Splitter and layout** · H3 · Drag the splitter between ENTRIES and DETAILS. · It
  moves within its bounds and the position persists across reloads.
- **UI-03 Keyboard inside the panel** · H3 · Tab through the rail: every icon button has an
  `aria-label` equal to its tooltip; Escape in the entries clears the selection.
- **UI-04 Vim extension** · H4 · With VSCodeVim installed: `Esc` clears a value only in Normal
  mode with a removable value on the line and does not break Vim's Escape otherwise.

## 4. What the automated suites already cover

| Suite | Covers (cases above it stands in for) |
|---|---|
| `test/e2e/demo.test.js` | SES-01, TM-01, TM-02, TM-09 (view), CS-01, LV-09 |
| `test/e2e/code-story.test.js` | CS-01, CS-02 (cursor and step), CS-06, CS-07 |
| `test/e2e/features.test.js` | TM-14, TM-16, LV-17, VH-01/02, RM-05, TM-19, TM-06, SEC-01/02, PROF-01, SNAP-01, LV-20 |
| `test/e2e/bridge.test.js` | LIVE-01, LIVE-02, LIVE-03 |
| `test/e2e/cli-live.test.js` | LIVE-04 (state, step, context, var, watch) |
| `test/e2e/walkthrough.test.js` | WT-01, WT-03 (click path), WT-04 |
| `test/e2e/execution-diagram.test.js` | EG-03, EG-04 (command, scrubber), EG-02 (unroll) |
| `test/e2e/why.test.js` | WHY-01, WHY-05 |
| `test/e2e/exceptions.test.js` | EXC-01, EXC-02 |
| `test/e2e/values-as-of.test.js` | TM-13 |
| `test/e2e/http-replay.test.js` | HTTP-03, HTTP-04, HTTP-05 |
| `test/e2e/libdiag.test.js` (own config) | TM-20 timings, ERR-03 for library runs |
| `test/e2e/uipass.test.js` (`PYOKKA_UI_PASS=1`) | UI-01 screenshots of LV, TM, hover, diagram, compare, settings, recent files, profiler, package hover |
| `test/unit/webview/*.test.tsx` | PAN-01 rail order and tooltips, Settings view contents, Time Machine toolbar, why tree, execution diagram rendering; `watchInput.test.tsx` DBG-13 (the prefix, the landing, the dropdown) |
| `python/tests/test_complete.py`, `test/unit/dapTranslator.test.ts` (completions), `test/e2e/debugger.test.js` | DBG-13 the runtime's list in the paused frame and over the runner, the DAP mapping, the API in a real pause |
| `python/tests/test_agent_cli.py`, `test_agent_live.py` | CLI-01 to CLI-08, CLI-10, HTTP-11 |
| `python/tests/test_secrets.py`, `test_redact.py` | SEC-01, SEC-03, SEC-05 |
| `python/tests/test_http_record*.py` | HTTP-06, HTTP-07, HTTP-08 |
| `python/tests/test_magic.py`, `test_instrument.py` | LV-02 to LV-04, COV-02, SNAP-06, RM-11 (the strip) |
| `python/tests/test_library.py`, `test_agent_cli.py` (cache), `test/unit/libraryCache.test.ts`, `test/e2e/library-cache.test.js` | TM-23 (the functions, the CLI, the command's notice, the command in a host) |
| `python/tests/test_debug.py`, `test_agent_live.py` (debug), `test/unit/debugState.test.ts`, `test/e2e/debugger.test.js`, `test/e2e/debug-live.test.js`, `test/unit/dapTranslator.test.ts`, `test/unit/webview` (debug views) | DBG-01 to DBG-04, DBG-06 to DBG-10 (the runtime, the host, the CLI over the bridge); DBG-11 translation only; DBG-05 table and alias rendering |
| `test/e2e/debug-session.test.js`, `test/unit/debugSession.test.ts`, `test/unit/debugLaunch.test.ts`, `test/unit/stopSlice.test.ts`, `test/unit/webview/debuggerView.test.tsx` | DBG-14 (the session on its own, the view, the timeout, the edit while paused, Stop); DBG-17 the module launch and the `record: true` refusal |
| `test/e2e/debug-server.test.js` | DBG-15 (the handler pause, `--no-wait`, two requests, Stop kills the server) |
| `test/e2e/debug-cli-cold.test.js`, `test/unit/debugUri.test.ts`, `python/tests/test_agent_debug.py` | DBG-16 (the three routes, the URI codec, the descriptor preference, the refusals, the agent-access gate) |
| `test/e2e/debug-stop.test.js`, `test/e2e/debug-exceptions.test.js` | DBG-08 and the exception pauses, now on a `record: false` session |
| `test/unit/debugExec.test.ts`, `test/unit/dapTranslator.test.ts` (repl, setVariable, function breakpoints), `python/tests/test_debug_exec.py`, `python/tests/test_agent_debug.py` (the exec flags and text forms) | DBG-18 (the `exec` result shapes, the console and `setVariable` paths, `modified`, the CLI's forms) |
| `test/e2e/debug-cli-cold.test.js` (wave-2 cases), `test/unit/debugExec.test.ts` (until / to / count), `python/tests/test_debug_at.py` | DBG-19 (`--at NAME`, `--until`, `--to`, `--count`, the early-exit replies) |
| `test/e2e/debug-recording.test.js`, `test/unit/manifest.test.ts` (the recording command) | DBG-20 (the recording command, `record: true` through a launch, the `module` refusal) |
| `python/tests/test_provenance.py`, `test/unit/provenance.test.ts` | DBG-12 |

A green suite counts as evidence for the cases it stands in for. Everything else in section 3
needs a run of its own; the webview-only cases (H3) and the H4 cases are the ones no suite
reaches.

## 5. Known limitations and decisions: do not file these

- Only Automatic mode executes implicitly. A hover, watch or Show Value in On Save / On Demand
  that shows nothing and sets "run needed" is correct.
- `def` and `class` statements and class bodies are never steps. Library import-time code is
  coverage-only. The standard library is never instrumented. Library files honour no `# ?`.
- Secrets are masked by provenance, never by value shape, inside the run; the shape rules
  apply only to what the CLI, saved runs and the bridge emit. A hard-coded key under a
  non-secret name shows in the panel by design.
- The panel never writes the run mode to the user settings; a `pyokka.runMode` found there is
  a leftover from an older build.
- The inline config dict is stripped and not applied (README, "Configuration").
- `story --live`, `find --live` and `steps --live --line` are refused with a hint.
- Copy Path / Copy Data are hidden palette entries with no tree view behind them.
- The e2e launcher cannot show the untrusted-workspace prompt (trust is forced off).
- Windows is not exercised; the bridge needs Unix sockets.
- The bridge e2e "steps into" can flake once in a full run.
- Values shown by the panel and hovers are the user's own screen and are not shape-redacted.
- A recording is rewritten by every record run that made a request; a record run with no
  request leaves it alone.
- The Marketplace links and the README screenshots are deliberately not embedded (no
  repository URL yet).

## 6. Reporting

Results table, one row per case:

```
| ID | Harness | Result | Evidence | Notes |
|----|---------|--------|----------|-------|
| LV-02 | H2 | PASS | test/qa/lv.test.js: "LV-02" green, entries dump in log | |
| HTTP-05 | H2 | FAIL | log: misses === 0, expected 1 | bug QA-7 |
```

Bug entry, one per failure (attach to the results):

```
QA-<n>  <one-line title>
Area:        <README section>
Severity:    S1 data loss / crash / secret exposed · S2 feature does not work · S3 wrong detail · S4 cosmetic or doc
Build:       <commit> · <build stamp from the status bar tooltip> · VS Code <version> · Python <version> · <harness>
Steps:       numbered, minimal, with the exact file contents used
Expected:    <from README or the case>
Actual:      <what happened, verbatim messages>
Evidence:    <log excerpt, command output, screenshot path, spec name>
Frequency:   always / intermittent (n of m)
```

Exit criteria for a build: PRE-02 to PRE-06 green; no open S1 or S2; every S3 either fixed or
listed with its case ID in the release notes; every case in section 3 marked PASS, N-A with a
reason, or BLOCKED with the blocker named. Finish by confirming the hygiene rules: `examples/`
clean, no scratch in the recent files store, no descriptors in `~/.pyokka/sessions/` from your
dev hosts, dev hosts killed, QA scratch files removed from the checkout, `command git status
--short` empty apart from what you were asked to leave.
