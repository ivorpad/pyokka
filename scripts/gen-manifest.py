#!/usr/bin/env python3
"""Generate package.json contributions for Pyokka from Quokka's manifest.

Run: python3 scripts/gen-manifest.py  (rewrites package.json, keeps non-contribution fields)

Quokka's manifest (docs/reference/quokka/quokka-package.json) belongs to Wallaby.js and is not in
the repository. Without a local copy this script stops: edit package.json directly instead.
"""
import json, re, copy, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
QUOKKA_MANIFEST = ROOT / 'docs/reference/quokka/quokka-package.json'
if not QUOKKA_MANIFEST.exists():
    raise SystemExit(f"{QUOKKA_MANIFEST.relative_to(ROOT)} is not in the repository (it is Quokka's "
                     "manifest, kept only locally). Edit package.json directly.")
Q = json.load(open(QUOKKA_MANIFEST))
qc = Q['contributes']

DROP_COMMANDS = {
    'quokka.newJavaScript', 'quokka.newTypeScript', 'quokka.createJavaScriptFile',
    'quokka.createTypeScriptFile', 'quokka.installQuokkaPlugin', 'quokka.addImport',
    'quokka.addRequire', 'quokka.showLicense', 'quokka.switchToPro', 'quokka.switchToCommunity',
    'quokka.share', 'quokka.showQuokkaRemotePort', 'quokka.revealInValueExplorer',
    'quokka.stopShowingOutputCodeLens', 'quokka.newRecentInteractive',
}
RENAME_COMMANDS = {
    'quokka.makeQuokkaFromExistingFile': 'pyokka.startOnCurrentFile',
    'quokka.goToLineInQuokkaFile': 'pyokka.focusActiveFile',
    'quokka.editQuokkaSnippets': 'pyokka.editSnippets',
    'quokka.installMissingPackageToQuokka': 'pyokka.installMissingPackageForFile',
}
ADD_COMMANDS = [
    {'command': 'pyokka.newPythonFile', 'title': 'New Python File', 'category': 'Pyokka'},
    {'command': 'pyokka.newRecentOrSnippet', 'title': 'From Recent / Snippet', 'category': 'Pyokka'},
    {'command': 'pyokka.addWatchExpression', 'title': 'Add Watch Expression', 'category': 'Pyokka'},
    {'command': 'pyokka.removeWatchExpression', 'title': 'Remove Watch Expression', 'category': 'Pyokka'},
    {'command': 'pyokka.toggleCodePreview', 'title': 'Toggle Code Preview Display', 'category': 'Pyokka'},
    {'command': 'pyokka.toggleStepEcho', 'title': 'Show/Hide Current Step Echo', 'category': 'Pyokka'},
    {'command': 'pyokka.selectInterpreter', 'title': 'Select Python Interpreter for Pyokka', 'category': 'Pyokka'},
    {'command': 'pyokka.openStartView', 'title': 'Open Start View', 'category': 'Pyokka'},
    {'command': 'pyokka.narrateWalkthrough', 'title': 'Narrate Walkthrough', 'category': 'Pyokka'},
    {'command': 'pyokka.showTour', 'title': 'Show Tour', 'category': 'Pyokka'},
    {'command': 'pyokka.narrateTour', 'title': 'Narrate Tour', 'category': 'Pyokka'},
    {'command': 'pyokka.showVariableHistory', 'title': 'Show Variable History', 'category': 'Pyokka'},
    {'command': 'pyokka.whyValue', 'title': 'Why This Value', 'category': 'Pyokka'},
    {'command': 'pyokka.whyVariable', 'title': 'Why This Value', 'category': 'Pyokka'},
    {'command': 'pyokka.showExecutionDiagram', 'title': 'Show Execution Diagram', 'category': 'Pyokka'},
    {'command': 'pyokka.showHttp', 'title': 'Show HTTP Requests', 'category': 'Pyokka'},
    {'command': 'pyokka.openHttpRecording', 'title': 'Open HTTP Recording', 'category': 'Pyokka'},
    {'command': 'pyokka.clearLibraryCache', 'title': 'Clear Library Cache', 'category': 'Pyokka'},
    {'command': 'pyokka.debugCurrentFile', 'title': 'Debug Current File', 'category': 'Pyokka'},
    {'command': 'pyokka.debugCurrentFileRecording', 'title': 'Debug Current File (Recording)', 'category': 'Pyokka'},
    {'command': 'pyokka.debugContinue', 'title': 'Continue (Debug)', 'category': 'Pyokka'},
    {'command': 'pyokka.debugPause', 'title': 'Pause (Debug)', 'category': 'Pyokka'},
    {'command': 'pyokka.debugStop', 'title': 'Stop Debugging', 'category': 'Pyokka'},
    {'command': 'pyokka.debugStepOver', 'title': 'Step Over (Debug)', 'category': 'Pyokka'},
    {'command': 'pyokka.debugStepInto', 'title': 'Step Into (Debug)', 'category': 'Pyokka'},
    {'command': 'pyokka.debugStepOut', 'title': 'Step Out (Debug)', 'category': 'Pyokka'},
    {'command': 'pyokka.debugRestart', 'title': 'Restart (Debug)', 'category': 'Pyokka'},
    {'command': 'pyokka.showDebugger', 'title': 'Show Debugger', 'category': 'Pyokka'},
]
CODICONS = {
    'profile': '$(dashboard)',
    'showValueOnSelectionDisabled': '$(eye-closed)',
    'showValueOnSelectionEnabled': '$(eye)',
    'showSingleInlineValueDisabled': '$(list-flat)',
    'showSingleInlineValueEnabled': '$(list-selection)',
    'debug-step-into': '$(debug-step-into)',
    'debug-step-into-back': '$(debug-step-back)',
    'debug-continue': '$(debug-continue)',
    'debug-continue-back': '$(debug-reverse-continue)',
    'debug-continue-breakpoint': '$(run-below)',
    'debug-continue-back-breakpoint': '$(run-above)',
    'debug-step-over': '$(debug-step-over)',
    'debug-step-over-back': '$(triangle-left)',
    'debug-step-out': '$(debug-step-out)',
    'debug-step-out-back': '$(reply)',
    'callStack': '$(list-tree)',
    'stop': '$(debug-stop)'
}

# Quokka's `[quokka-timeline]` defaults only turn the unicode highlighter off (the story text is
# generated, so its `…` rows and non-ASCII source would be flagged); those come over as they are.
# The rest is what a generated document needs and Quokka sets in code: each row carries its source
# line number in the text (docs/design/code-story.md, D4), so the editor's own gutter would show a
# second, different number beside it, and nothing in the story answers a breakpoint, a fold or a
# minimap.
STORY_EDITOR_DEFAULTS = {
    'editor.lineNumbers': 'off',
    'editor.glyphMargin': False,
    'editor.folding': False,
    'editor.minimap.enabled': False,
}

DROP_SETTINGS = {
    'quokka.suppressExpirationNotifications', 'quokka.colorizeOutput', 'quokka.compactMessageOutput',
    'quokka.showCodeLensInOutputChannel', 'quokka.codeClipAutoUpload', 'quokka.syncSettings',
    'quokka.rollBackToPreviousGenerationUI', 'quokka.textDecorationRenderScope',
}
ADD_SETTINGS = {
    'pyokka.python.interpreter': {'type': 'string', 'default': '', 'markdownDescription': 'Python executable used to run files (absolute, or relative to the workspace folder, e.g. `.venv/bin/python`). Pick one with "Pyokka: Select Python Interpreter for Pyokka". Empty = the interpreter selected in the Python extension, then `python.defaultInterpreterPath`, then `python3` on PATH. Python 3.12 or newer is required. Variables from `python.envFile` (default `${workspaceFolder}/.env`) are passed to the run.'},
    'pyokka.runTimeout': {'type': 'number', 'default': 30000, 'description': 'Kill a run after this many milliseconds (0 = wait forever).'},
    # the mapped Quokka text spoke of a run only; a debug session brings the panel up the same way
    'pyokka.showOutputOnStart': {'type': 'boolean', 'default': True, 'description': 'Bring the Pyokka panel up when a session starts: the Output view for a run, the Debugger view for a debug session.'},
    'pyokka.http': {'type': 'string', 'default': 'off', 'enum': ['off', 'record', 'replay'], 'enumDescriptions': ['Requests reach the network; nothing is recorded.', 'Requests reach the network and every exchange is written to .pyokka/replay/ in the workspace.', 'Every request is answered from the recording; nothing reaches the network.'], 'markdownDescription': 'The HTTP layer of a run. `record` writes every HTTP exchange of the run (httpx, requests, urllib / http.client) to `.pyokka/replay/` in the workspace, one file per source file. `replay` answers every request from that file without touching the network, so a re-run of API-driven code costs nothing and returns the same values; a request with no recorded response fails as a connection error. Also a per-session choice in the panel Settings ("HTTP"); the next run uses it.'},
    'pyokka.httpObserve': {'type': 'boolean', 'default': True, 'markdownDescription': 'Observe the HTTP clients (httpx, requests, urllib / http.client) in every run so the HTTP view lists the requests with their status, size, time and the statement that made them. Off leaves the clients untouched: no rows, no HTTP view. Record and replay (`pyokka.http`) work either way.'},
    'pyokka.delay': {'type': 'number', 'default': 0, 'description': 'Milliseconds to wait after the last edit before re-running.'},
    'pyokka.runMode': {'type': 'string', 'default': 'onSave', 'enum': ['onSave', 'onDemand', 'auto', 'smart'], 'enumDescriptions': ['Run when the file is saved (the default).', 'Run only on Re-execute.', 'Run on every edit, and for hovers, watches, Show Value and the Time Machine: a paid run each time for a file that calls an API.', 'Scratch files run on every edit; files inside a project (pyproject.toml, requirements.txt, a lock file, ...) run on save.'], 'description': 'Default run mode for new sessions. Only the automatic mode executes the file without an explicit action (hover, watch, Show Value).'},
    'pyokka.autoLog': {'type': 'boolean', 'default': False, 'description': 'Start sessions with Auto Log (show a value for every line) enabled.'},
    'pyokka.showValueOnSelection': {'type': 'boolean', 'default': False, 'description': 'Show the runtime value of an expression when it is selected.'},
    'pyokka.showSingleInlineValue': {'type': 'boolean', 'default': True, 'description': 'Show only the last selected/shown value inline; false shows all of them.'},
    'pyokka.valuePeek': {'type': 'boolean', 'default': True, 'description': 'Evaluate and show values when hovering expressions.'},
    'pyokka.resolveGetters': {'type': 'boolean', 'default': False, 'description': 'Invoke properties/descriptors when serializing values (may run code).'},
    'pyokka.logLimit': {'type': 'number', 'default': 100, 'description': 'Maximum values logged per expression / print site.'},
    'pyokka.maxConsoleMessages': {'type': 'number', 'default': 1000, 'description': 'Maximum logged values per run.'},
    'pyokka.maxTraceSteps': {'type': 'number', 'default': 999999, 'markdownDescription': 'Maximum recorded Time Machine steps per run. Past it the program runs on unrecorded; the Time Machine says where the recording stopped and which files spent the steps, so you can leave them out with `pyokka.timeMachine.exclude`.'},
    'pyokka.maxValueChars': {'type': ['number', 'null'], 'default': None, 'markdownDescription': 'Characters one recorded value keeps in its inline text. Unset: 120 for a local variable, 200 for a logged value. `0` keeps the whole value up to a ceiling of 1,000,000 characters. A cut value ends in `…(+N chars)`. Same as `pyokka run --max-value-chars`.'},
    'pyokka.timeMachine.autoLog': {'type': 'boolean', 'default': True, 'description': 'Turn on Auto Log while the Time Machine is active so every step shows the value its statement produced (assignments, returns, conditions).'},
    'pyokka.timeMachine.inlineValues': {'type': 'string', 'default': 'dimOthers', 'enum': ['dimOthers', 'currentStep', 'all'], 'enumDescriptions': ["Show the values as of the current step: the current step's values in full, values from earlier steps dimmed, nothing for a statement that has not run yet.", 'Show only the values produced at the current step (Quokka behaviour).', 'Show every value unchanged (the last hit of the run).'], 'description': 'Which inline values to show while the Time Machine is navigating.'},
    'pyokka.timeMachine.libraryCode': {'type': 'boolean', 'default': False, 'markdownDescription': 'Instrument third-party packages so the Time Machine can step into their code (Step Into enters the library, values and coverage render in its files). Off by default: the first run of a session instruments every imported module and library steps count toward `pyokka.maxTraceSteps`. The standard library is never instrumented. Also a per-session toggle in the panel menu ("Step Into Library Code").'},
    'pyokka.timeMachine.libraryPackages': {'type': 'array', 'default': [], 'items': {'type': 'string'}, 'markdownDescription': 'With `pyokka.timeMachine.libraryCode` on, limit instrumentation to these top-level package names or dotted globs, e.g. `["requests", "mypkg.*"]`. Empty = every third-party package.'},
    'pyokka.timeMachine.exclude': {'type': 'array', 'default': [], 'items': {'type': 'string'}, 'markdownDescription': 'Leave code out of the recording: dotted module names (`pkg.flash` covers `pkg.flash.*`) or path globs relative to the workspace (`pkg/flash`, `*/parser.py`). Excluded code runs at full speed and records no steps, values or coverage. Same as `pyokka run --exclude`.'},
    'pyokka.timeMachine.recordLocals': {'type': 'boolean', 'default': False, 'markdownDescription': 'Record every changed local variable at every step: the Variable pane lists where a name changed with its values, and the Time Machine shows Step Variables. Costs CPU on hot loops; the runtime keeps at most 100 000 entries per run. Also a per-session toggle in the panel Settings ("Record Variable Changes"); without it the Variable pane knows only logged values and assignment sites.'},
    'pyokka.installPackageCommand': {'type': 'string', 'default': '', 'description': 'Command template for Quick Package Install, e.g. "uv pip install {packageName}". Empty = auto-detect uv / pip for the interpreter.'},
    'pyokka.env': {'type': 'object', 'default': {}, 'description': 'Environment variables for the run child process.'},
    'pyokka.secrets.mask': {'type': 'boolean', 'default': True, 'markdownDescription': 'Mask secrets in every value Pyokka shows. Two rules, both by provenance rather than by what a value looks like: the value of an environment variable with a secret-looking name (`OPENAI_API_KEY`, `DB_PASSWORD`, also ones set by `load_dotenv()`) is replaced wherever it appears, and a string under a secret-looking name (attribute `api_key`, key `password`, keyword `token=`) is replaced. Masking happens in the run process; the value never reaches the editor. Also a per-session toggle in the Settings view.'},
    'pyokka.secrets.names': {'type': 'array', 'default': [], 'items': {'type': 'string'}, 'markdownDescription': 'Extra words that make a name secret, e.g. `["licence", "pin"]`. Built in: api key, access / secret / private / signing key, secret, password, passwd, passphrase, credential(s), token(s), auth, authorization, bearer, dsn.'},
    'pyokka.args': {'type': 'array', 'default': [], 'items': {'type': 'string'}, 'description': 'sys.argv[1:] for the run.'},
    'pyokka.plugins': {'type': 'array', 'default': [], 'items': {'type': 'string'}, 'description': 'Python modules exposing before(config) / before_each(config).'},
    'pyokka.smartStart': {'type': 'array', 'default': [], 'description': 'Auto-start rules: [{"pattern": "**/*.py", "startMode": "always|never|edit|open"}].'},
    'pyokka.agentAccess': {'type': 'boolean', 'default': False, 'description': "Let local agents (the pyokka CLI) read this window's runs and drive the Time Machine over a local socket. Also installs `pyokka` in ~/.local/bin (macOS and Linux), kept pointing at this version's runtime"},
    'pyokka.story.values': {'type': 'string', 'default': 'all', 'enum': ['all', 'asOf', 'step'], 'enumDescriptions': ['Every value a block\'s lines logged during that block\'s steps, so each turn of a loop carries its own.', 'The values logged at or before the current Time Machine step, each in its own block.', 'Only what the current step logged, on its line in its block (what Quokka shows).'], 'markdownDescription': 'Which values the Code Story shows after its lines. `all` (the default) paints every block\'s values; `asOf` hides what the run has not reached yet; `step` shows only the current step\'s, as Quokka does.'},
    'pyokka.story.walkthrough': {'type': 'boolean', 'default': False, 'description': 'List the walkthrough (what happened, in order: one line per moment with its step number) at the top of the Code Story.'},
    'pyokka.explain.command': {'type': 'string', 'default': '', 'markdownDescription': 'Command that narrates the walkthrough and the tour when you click Narrate or Narrate Tour: it gets the prompt on stdin and must answer with a JSON object on stdout. Empty = `claude -p --output-format json` when `claude` is on the PATH, else `codex exec`, else the language model of GitHub Copilot inside VS Code. Never called automatically; no API keys are stored.'},
    'pyokka.diagram.build': {'type': 'string', 'default': 'onOpen', 'enum': ['onOpen', 'onRun'], 'enumDescriptions': ['Build the graph when the Execution Diagram is opened, or when a run finishes while it is open.', 'Build the graph as every run finishes, whether or not the diagram is showing.'], 'markdownDescription': 'When the Execution Diagram walks the run to build its graph. `onOpen` (the default) does it only when the view is open or opened (the command, the rail, the Time Machine toolbar), so a run costs nothing extra while the diagram is closed; `onRun` builds it after every run.'},
    'pyokka.diagram.detail': {'type': 'string', 'default': 'scopes', 'enum': ['scopes', 'statements'], 'enumDescriptions': ['One card per module, function and package with its calls and values; a card opens its statements and decisions on click.', 'Every statement and decision that ran, under its module or function, from the start.'], 'markdownDescription': 'How much of the run the Execution Diagram draws at first. `scopes` (the default) draws the cards only and opens a scope\'s statements when you click its chevron; `statements` draws everything, the shape of `pyokka graph`. The diagram toolbar switches this for the open panel without changing the setting.'},
    'pyokka.diagram.dataEdges': {'type': 'boolean', 'default': False, 'markdownDescription': 'Draw the data edges of the Execution Diagram: a value assigned in one statement flowing into the statements and calls that read it. Off by default, they are the noisiest layer and short literals such as `0` or `None` match by text. The diagram toolbar toggles them for the open panel.'},
    'pyokka.diagram.phases': {'type': 'boolean', 'default': True, 'markdownDescription': 'Group the statements of a scope into phases in the Execution Diagram\'s story tree: consecutive statements the source separates with a blank line or a comment, labelled by the comment above them or the names they assign. Off lists the statements directly under their scope.'},
}

def ren(s: str) -> str:
    s = re.sub(r'\bquokka\.isLiveShareClient\b', 'false', s)
    s = re.sub(r'\bquokka\.isPro\b', 'true', s)
    s = re.sub(r'\bquokka\.prevGenGuiEnabled\b', 'false', s)
    s = re.sub(r'\bquokka\.isActiveEditorRunningQuokka\b', 'pyokka.isActiveEditorRunningPyokka', s)
    s = s.replace('quokka-code-timeline', 'pyokka-code-timeline').replace('quokka-recent', 'pyokka-recent')
    s = s.replace('quokka-timeline', 'pyokka-story').replace('quokka-snap', 'pyokka-snap')
    s = s.replace('quokka.', 'pyokka.').replace('Quokka.js', 'Pyokka').replace('Quokka', 'Pyokka').replace('quokka', 'pyokka')
    # Quokka's "any language but a template one" gate passes for its own story document
    # (language `quokka-timeline`), so its palette keeps the Time Machine commands while the
    # story is focused; Pyokka's equivalent is Python or the story language
    s = s.replace("editorLangId != svelte && editorLangId != vue", '(editorLangId == python || editorLangId == pyokka-story)')
    s = s.replace('!false && ', '').replace(' && !false', '').replace('true && ', '').replace(' && true', '')
    return s

def map_cmd(c):
    if c in DROP_COMMANDS: return None
    if c in RENAME_COMMANDS: return RENAME_COMMANDS[c]
    return ren(c)

def story_title_when(when):
    """The story half of a Quokka `editor/title` clause, without the prev-gen gate.

    Quokka declares every Time Machine button in the editor title twice: once for the editor
    running Quokka, once for the story scheme, both gated on `quokka.prevGenGuiEnabled` (its
    previous-generation UI, which Pyokka maps to false). Pyokka keeps the source editor's half
    off, since its toolbar lives in the panel header, and mirrors the story half without the
    gate: the story document has no panel header of its own (docs/design/code-story.md, T4).
    """
    for part in when.split(' || '):
        if 'resourceScheme == quokka-code-timeline' not in part: continue
        return ren(' && '.join(t.strip() for t in part.split(' && ') if t.strip() != 'quokka.prevGenGuiEnabled'))
    return None

commands = []
for c in qc['commands']:
    nid = map_cmd(c['command'])
    if not nid: continue
    n = copy.deepcopy(c); n['command'] = nid; n['title'] = ren(c['title']); n['category'] = 'Pyokka'
    if 'when' in n: n['when'] = ren(n['when'])
    if 'icon' in n:
        # Quokka ships light/dark SVGs; Pyokka uses codicons so no icon files are needed
        base = re.sub(r'^images/(.+)\.(dark|light)\.svg$', r'\1', n['icon']['dark'])
        n['icon'] = CODICONS[base]
    commands.append(n)
commands += ADD_COMMANDS
# icons for the editor-title run button and the panel
for c in commands:
    if c['command'] == 'pyokka.reexecute': c['icon'] = '$(play)'
    if c['command'] == 'pyokka.startOnCurrentFile': c['icon'] = '$(debug-start)'
    # the debugger's own buttons in the panel title (docs/HANDOFF-debugger.md)
    if c['command'] == 'pyokka.debugCurrentFile': c['icon'] = '$(debug-alt)'
    if c['command'] == 'pyokka.debugCurrentFileRecording': c['icon'] = '$(debug-alt-small)'
    if c['command'] == 'pyokka.debugContinue': c['icon'] = '$(debug-continue)'
    if c['command'] == 'pyokka.debugPause': c['icon'] = '$(debug-pause)'
    if c['command'] == 'pyokka.debugStop': c['icon'] = '$(debug-stop)'
    if c['command'] == 'pyokka.debugStepOver': c['icon'] = '$(debug-step-over)'
    if c['command'] == 'pyokka.debugStepInto': c['icon'] = '$(debug-step-into)'
    if c['command'] == 'pyokka.debugStepOut': c['icon'] = '$(debug-step-out)'
    if c['command'] == 'pyokka.debugRestart': c['icon'] = '$(debug-restart)'
    if c['command'] == 'pyokka.showDebugger': c['icon'] = '$(debug-alt)'

menus = {}
for menu, items in qc['menus'].items():
    if menu == 'file/newFile':
        menus[menu] = [{'command': 'pyokka.newPythonFile'}, {'command': 'pyokka.newRecentOrSnippet'}]
        continue
    out = []
    for it in items:
        nid = map_cmd(it['command'])
        if not nid: continue
        # the panel title carries no step controls: the Time Machine is a debug session in replay, so
        # stepping, the call stack and Stop are the VS Code debug toolbar's (src/debug/replaySession.ts)
        if menu == 'view/title' and (nid == 'pyokka.viewCallStack' or nid == 'pyokka.stopTraceNavigation' or nid.startswith('pyokka.playTrace')): continue
        n = copy.deepcopy(it); n['command'] = nid
        if menu == 'editor/title':
            w = story_title_when(it.get('when', ''))
            if w is None: continue
            n['when'] = w
            out.append(n)
            continue
        # always in the palette: `activeEditor` is unset with focus in the panel or an empty editor
        # area, and the command opens a new Python file when there is no editor anyway
        if menu == 'commandPalette' and nid == 'pyokka.startOnCurrentFile': n.pop('when', None)
        # the panel shows an empty state with Start and Debug buttons when no session runs
        if menu == 'commandPalette' and nid in ('pyokka.showOutput', 'pyokka.focusOutput'): n.pop('when', None)
        if 'when' in n:
            n['when'] = ren(n['when'])
            if n['when'] in ('', 'false') and menu == 'commandPalette' and nid in {c['command'] for c in ADD_COMMANDS}:
                pass
        out.append(n)
    menus[menu] = out
# the editor's run button (VS Code's `editor/title/run` slot): Re-execute while a session runs,
# Start Pyokka for any other Python file. This is the visible "run on demand" control.
menus['editor/title/run'] = [
    {'command': 'pyokka.reexecute', 'when': 'activeEditor && pyokka.isActiveEditorRunningPyokka && !pyokka.traceBeingNavigated', 'group': 'navigation@1'},
    {'command': 'pyokka.startOnCurrentFile', 'when': 'editorLangId == python && !pyokka.isActiveEditorRunningPyokka', 'group': 'navigation@2'},
]
# the debugger in the panel title: the two ways to start one while no debug run exists. Once a
# debug session exists, Continue, Pause, the steps, Restart and Stop are the VS Code debug toolbar's
# over that same session; the panel repeats none of them (one toolbar per session).
menus['view/title'] += [
    {'command': 'pyokka.debugCurrentFile', 'when': 'view =~ /pyokka.output/ && !pyokka.debugActive', 'group': 'navigation@0'},
    {'command': 'pyokka.debugCurrentFileRecording', 'when': 'view =~ /pyokka.output/ && !pyokka.debugActive', 'group': 'navigation@1'},
]
# a row of VS Code's Variables view while the Time Machine replays: the why tree at the step
menus['debug/variables/context'] = [
    {'command': 'pyokka.whyVariable', 'when': 'debugType == pyokka && pyokka.traceBeingNavigated', 'group': 'navigation'},
]
menus['commandPalette'] += [
    {'command': 'pyokka.newPythonFile'},
    {'command': 'pyokka.newRecentOrSnippet', 'when': 'false'},
    {'command': 'pyokka.addWatchExpression', 'when': 'false'},
    {'command': 'pyokka.removeWatchExpression', 'when': 'false'},
    {'command': 'pyokka.toggleCodePreview', 'when': 'pyokka.traceBeingNavigated'},
    {'command': 'pyokka.toggleStepEcho', 'when': 'pyokka.traceBeingNavigated'},
    {'command': 'pyokka.selectInterpreter'},
    {'command': 'pyokka.openStartView'},
    {'command': 'pyokka.showVariableHistory', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.showHttp', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.showTour', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.narrateTour', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.openHttpRecording', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.whyValue', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.whyVariable', 'when': 'false'},
    {'command': 'pyokka.clearLibraryCache'},
    {'command': 'pyokka.debugCurrentFile'},
    {'command': 'pyokka.debugCurrentFileRecording'},
    {'command': 'pyokka.debugContinue', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.debugPause', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.debugStop', 'when': 'pyokka.hasActiveSession'},
    {'command': 'pyokka.debugStepOver', 'when': 'pyokka.debugActive'},
    {'command': 'pyokka.debugStepInto', 'when': 'pyokka.debugActive'},
    {'command': 'pyokka.debugStepOut', 'when': 'pyokka.debugActive'},
    {'command': 'pyokka.debugRestart', 'when': 'pyokka.debugActive'},
    {'command': 'pyokka.showDebugger', 'when': 'pyokka.debugSessionActive'},
]

keys = []
for k in qc['keybindings']:
    nid = map_cmd(k['command'])
    if not nid: continue
    n = copy.deepcopy(k); n['command'] = nid
    if 'when' in n: n['when'] = ren(n['when'])
    keys.append(n)
# Cursor owns Cmd+K, so add ctrl+alt+p twins for every cmd+k chord
twins = []
for k in keys:
    key = k.get('key', '')
    if key.startswith('ctrl+k '):
        t = copy.deepcopy(k)
        t['key'] = 'ctrl+alt+p ' + key.split(' ', 1)[1]
        t['mac'] = 'ctrl+alt+p ' + k.get('mac', key).split(' ', 1)[1]
        twins.append(t)
keys += twins + [
    {'command': 'pyokka.newPythonFile', 'key': 'ctrl+k j', 'mac': 'cmd+k j', 'when': '!terminalFocus'},
    {'command': 'pyokka.newPythonFile', 'key': 'ctrl+alt+p j', 'mac': 'ctrl+alt+p j', 'when': '!terminalFocus'},
]
# F5 gives way when the active file holds a breakpoint that can pause. Both Quokka bindings shadow
# VS Code's Start Debugging as soon as a session exists on the file, so a user who set a breakpoint
# and pressed F5 got a re-run that never pauses, or a Time Machine move. With the guard F5 falls
# through to Start Debugging, and the `pyokka` configuration provider (src/debug/dapAdapter.ts)
# turns the empty launch into a debug run of the file, which stops at that breakpoint. Logpoints
# never set the key (src/features/debugBreakpoints.ts): they are markers and do not pause. While a
# debug session is active F5 is Continue, which the `inDebugMode` in Quokka's own clauses covers.
# The Time Machine clause carries an `||`, so the existing clause is wrapped rather than extended.
# The Time Machine is a debug session in replay (src/debug/replaySession.ts), so `inDebugMode` is
# true whenever it navigates. F5, F10, F11 and Shift+F11 then belong to VS Code's debug commands,
# which reach the Time Machine through the replay session. The moves VS Code has no key or button
# for keep their Pyokka keys inside a Pyokka debug session: the backward twins and Run to Breakpoint.
KEEP_IN_REPLAY = {'pyokka.playTracePrevStep', 'pyokka.playTracePrevStepOver', 'pyokka.playTracePrevStepOut',
                  'pyokka.playTraceBackwardToSelection', 'pyokka.playTraceBackwardToBreakpoint', 'pyokka.playTraceForwardToBreakpoint'}
for k in keys:
    if k['command'] in KEEP_IN_REPLAY and 'when' in k:
        k['when'] = k['when'].replace('!inDebugMode', '(!inDebugMode || debugType == pyokka)')
for k in keys:
    if k.get('key') == 'f5' and k['command'] in ('pyokka.reexecute', 'pyokka.playTraceForwardToSelection'):
        k['when'] = f"({k['when']}) && !pyokka.activeFileHasBreakpoints"

props = {}
for name, spec in qc['configuration']['properties'].items():
    if name in DROP_SETTINGS: continue
    n = copy.deepcopy(spec)
    for f in ('description', 'markdownDescription'):
        if f in n: n[f] = ren(n[f])
    if 'enumDescriptions' in n: n['enumDescriptions'] = [ren(d) for d in n['enumDescriptions']]
    props[ren(name)] = n
props.update(ADD_SETTINGS)

contributes = {
    'viewsContainers': {'panel': [{'id': 'pyokka-output', 'title': 'Pyokka', 'icon': 'media/logo-outline.svg'}]},
    # a debug session with no run-all session must have a panel too
    'views': {'pyokka-output': [{'id': 'pyokka.output', 'name': 'Output', 'type': 'webview', 'visibility': 'visible'}]},
    'commands': commands,
    'menus': menus,
    'keybindings': keys,
    'languages': [{'id': 'pyokka-recent'}, {'id': 'pyokka-story', 'aliases': ['Pyokka Code Story']}],
    'grammars': [
        {'language': 'pyokka-recent', 'scopeName': 'source.pyokka-recent', 'path': './syntaxes/pyokka-recent.tmLanguage.json'},
        {'language': 'pyokka-story', 'scopeName': 'source.pyokka-story', 'path': './syntaxes/pyokka-story.tmLanguage.json'},
        {'injectTo': ['source.python'], 'scopeName': 'source.pyokka-snap', 'path': './syntaxes/pyokka-snap.tmLanguage.json'},
    ],
    'snippets': [{'language': 'python', 'path': './snippets/pyokka.code-snippets'}],
    # the debugger type: F5 / "Run and Debug" over Pyokka's own pause (src/debug/dapAdapter.ts); no debugpy involved
    'debuggers': [{
        'type': 'pyokka', 'label': 'Pyokka', 'languages': ['python'],
        # `required` is empty because a launch may name `module` instead of `program`; parseLaunch
        # (src/debug/debugSessionState.ts) reports a launch with neither
        'configurationAttributes': {'launch': {'required': [], 'properties': {
            'program': {'type': 'string', 'default': '${file}', 'description': 'The Python file to run. Give this or "module".'},
            'module': {'type': 'string', 'description': 'A dotted module name to run like `python -m`, instead of "program".'},
            'args': {'type': 'array', 'items': {'type': 'string'}, 'default': [], 'description': 'Arguments for the program (sys.argv[1:]).'},
            'cwd': {'type': 'string', 'default': '${workspaceFolder}', 'description': 'Working directory the program runs in.'},
            'env': {'type': 'object', 'default': {}, 'additionalProperties': {'type': 'string'}, 'description': "Environment variables added to the program's environment."},
            'python': {'type': 'string', 'description': "Interpreter to run with. Default: the Python extension's environment, then pyokka.python.interpreter, then python3."},
            'stopOnEntry': {'type': 'boolean', 'default': False, 'description': 'Pause before the first statement instead of running to the first breakpoint.'},
            'breakOnException': {'type': 'string', 'enum': ['off', 'uncaught', 'raised'], 'default': 'uncaught', 'description': 'Where the debugger pauses on an exception: never, on one nobody caught, or at every raise in your code.'},
            'libraryCode': {'type': 'boolean', 'default': False, 'description': 'Step into third-party packages (never the standard library).'},
            'record': {'type': 'boolean', 'default': False, 'description': 'Also record the run, so the Time Machine, the Code Story and `why` open over it at every pause. Slower; needs "program".'},
        }}},
        'initialConfigurations': [
            {'type': 'pyokka', 'request': 'launch', 'name': 'Pyokka: Debug Current File', 'program': '${file}'},
            {'type': 'pyokka', 'request': 'launch', 'name': 'Pyokka: Debug Current File (Recording)', 'program': '${file}', 'record': True},
            {'type': 'pyokka', 'request': 'launch', 'name': 'Pyokka: Debug Module', 'module': 'app.server', 'args': [], 'cwd': '${workspaceFolder}'},
        ],
        'configurationSnippets': [
            {
                'label': 'Pyokka: Debug Current File',
                'description': 'Run the current Python file under the Pyokka debugger: it runs at full speed and stops at a breakpoint or an exception.',
                'body': {'type': 'pyokka', 'request': 'launch', 'name': 'Pyokka: Debug Current File', 'program': '^"\\${file}"'},
            },
            {
                'label': 'Pyokka: Debug Current File (Recording)',
                'description': 'The same, and record the run: the Time Machine, the Code Story and `why` open over it at every pause.',
                'body': {'type': 'pyokka', 'request': 'launch', 'name': 'Pyokka: Debug Current File (Recording)', 'program': '^"\\${file}"', 'record': True},
            },
            {
                'label': 'Pyokka: Debug Module',
                'description': 'Run a dotted module like `python -m`, with arguments. A server started with --reload runs your code in a worker the debugger never sees.',
                'body': {'type': 'pyokka', 'request': 'launch', 'name': 'Pyokka: Debug Module', 'module': 'app.server', 'args': [], 'cwd': '^"\\${workspaceFolder}"'},
            },
        ],
    }],
    'breakpoints': [{'language': 'python'}],
    'configurationDefaults': {
        '[pyokka-recent]': qc['configurationDefaults']['[quokka-recent]'],
        '[pyokka-story]': {**qc['configurationDefaults']['[quokka-timeline]'], **STORY_EDITOR_DEFAULTS},
    },
    'configuration': {'type': 'object', 'title': 'Pyokka', 'properties': props},
}

pkg_path = ROOT / 'package.json'
pkg = json.load(open(pkg_path)) if pkg_path.exists() else {}
base = {
    'name': 'pyokka', 'displayName': 'Pyokka', 'publisher': 'ivor',
    'description': 'Python playground in your editor: live values, coverage, and a time-travel debugger with an interactive timeline.',
    'version': '0.3.0', 'license': 'MIT', 'engines': {'vscode': '^1.93.0'},
    'repository': {'type': 'git', 'url': 'https://github.com/ivorpad/pyokka.git'},
    'categories': ['Debuggers', 'Testing', 'Other'], 'keywords': ['python', 'scratchpad', 'playground', 'REPL', 'time travel'],
    'activationEvents': ['onLanguage:python', 'onStartupFinished', 'onUri'], 'main': './dist/extension.js', 'icon': 'media/logo.png',
    'capabilities': {'untrustedWorkspaces': {'supported': 'limited', 'description': 'Pyokka runs your code; it asks before starting in an untrusted workspace.'}},
}
for k, v in base.items(): pkg.setdefault(k, v)
# assigned, not defaulted: `setdefault` would leave the existing package.json value in place and the
# URI handler would never be registered (`onUri`)
pkg['activationEvents'] = base['activationEvents']
pkg['contributes'] = contributes
json.dump(pkg, open(pkg_path, 'w'), indent=2)
open(pkg_path, 'a').write('\n')
print(f"{len(commands)} commands, {len(keys)} keybindings, {len(props)} settings")
