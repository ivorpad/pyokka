import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface LaunchAttribute {
  type?: string;
  default?: unknown;
  enum?: string[];
  description?: string;
  items?: { type: string };
  additionalProperties?: { type: string };
}

interface Manifest {
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings: { command: string; key: string; mac?: string; when?: string }[];
    views: Record<string, { id: string; when?: string }[]>;
    configurationDefaults: Record<string, Record<string, unknown>>;
    configuration: { properties: Record<string, { type?: string; default?: unknown; enum?: string[]; enumDescriptions?: string[]; description?: string; markdownDescription?: string }> };
    debuggers: {
      type: string;
      configurationAttributes: { launch: { required: string[]; properties: Record<string, LaunchAttribute> } };
      initialConfigurations: Record<string, unknown>[];
      configurationSnippets: { label: string; description?: string; body: Record<string, unknown> }[];
    }[];
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as Manifest;
const palette = manifest.contributes.menus.commandPalette ?? [];
const settings = manifest.contributes.configuration.properties;
const commands = manifest.contributes.commands;
const keybindings = manifest.contributes.keybindings;

describe('package.json contributions', () => {
  it('keeps Start on Current File in the command palette without an editor gate', () => {
    // `activeEditor` is unset with focus in the panel or an empty editor area; the command
    // opens a new Python file when there is no editor, so it needs no gate
    const entries = palette.filter((e) => e.command === 'pyokka.startOnCurrentFile');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.when ?? '').toBe('');
  });
  it('lists the interpreter picker, the start view, the logs and the cache clear unconditionally', () => {
    for (const cmd of ['pyokka.selectInterpreter', 'pyokka.openStartView', 'pyokka.showLogs', 'pyokka.clearLibraryCache']) {
      const e = palette.find((x) => x.command === cmd);
      expect(e, cmd).toBeDefined();
      expect(e?.when ?? '', cmd).not.toBe('false');
    }
  });
  it('offers pyokka.http as an off / record / replay choice that defaults to off', () => {
    const http = settings['pyokka.http'];
    expect(http).toBeDefined();
    expect(http?.type).toBe('string');
    expect(http?.default).toBe('off');
    expect(http?.enum).toEqual(['off', 'record', 'replay']);
    expect(http?.enumDescriptions?.length).toBe(3);
    expect(http?.markdownDescription).toContain('.pyokka/replay/');
  });
  it('offers pyokka.httpObserve as a boolean that defaults to on', () => {
    const observe = settings['pyokka.httpObserve'];
    expect(observe).toBeDefined();
    expect(observe?.type).toBe('boolean');
    expect(observe?.default).toBe(true);
    expect(observe?.markdownDescription ?? observe?.description).toContain('HTTP view');
  });
  it('offers the Execution Diagram settings with the folded defaults', () => {
    expect(settings['pyokka.diagram.build']).toMatchObject({ type: 'string', default: 'onOpen', enum: ['onOpen', 'onRun'] });
    expect(settings['pyokka.diagram.build']?.enumDescriptions?.length).toBe(2);
    expect(settings['pyokka.diagram.detail']).toMatchObject({ type: 'string', default: 'scopes', enum: ['scopes', 'statements'] });
    expect(settings['pyokka.diagram.dataEdges']).toMatchObject({ type: 'boolean', default: false });
    expect(settings['pyokka.diagram.phases']).toMatchObject({ type: 'boolean', default: true });
    expect(settings['pyokka.story.walkthrough']?.default).toBe(false);
    expect(settings['pyokka.story.values']).toMatchObject({ type: 'string', default: 'all', enum: ['all', 'asOf', 'step'] });
  });
  it('mirrors the editor-title Time Machine buttons for the Code Story scheme', () => {
    // Quokka declares them twice, both halves gated on its previous-generation UI flag, which
    // Pyokka maps to false; only the story half is kept, without the gate (design doc T4)
    const title = manifest.contributes.menus['editor/title'] ?? [];
    expect(title.map((e) => e.command)).toEqual([
      'pyokka.playTraceBackwardToSelection',
      'pyokka.playTracePrevStepOut',
      'pyokka.playTracePrevStep',
      'pyokka.playTracePrevStepOver',
      'pyokka.stopTraceNavigation',
      'pyokka.playTraceNextStepOver',
      'pyokka.playTraceNextStep',
      'pyokka.playTraceNextStepOut',
      'pyokka.playTraceForwardToSelection',
      'pyokka.playTraceBackwardToBreakpoint',
      'pyokka.playTraceForwardToBreakpoint',
    ]);
    for (const e of title) {
      expect(e.when ?? '', e.command).toContain('resourceScheme == pyokka-code-timeline');
      expect(e.when ?? '', e.command).toContain('pyokka.traceBeingNavigated');
      expect(e.when ?? '', e.command).not.toContain('false');
      expect(commands.find((c) => c.command === e.command)?.icon, e.command).toMatch(/^\$\(/);
    }
  });
  it('gives the story document the editor defaults a generated document needs', () => {
    const story = manifest.contributes.configurationDefaults['[pyokka-story]'] ?? {};
    // every row carries its source line number in the text, so the editor's own gutter is off
    expect(story['editor.lineNumbers']).toBe('off');
    expect(story['editor.glyphMargin']).toBe(false);
    expect(story['editor.folding']).toBe(false);
    expect(story['editor.minimap.enabled']).toBe(false);
    // Quokka's own defaults for the language, kept as they are
    expect(story['editor.unicodeHighlight.nonBasicASCII']).toBe(false);
    expect(story['editor.unicodeHighlight.invisibleCharacters']).toBe(false);
  });
  it('lets F5 fall through to Start Debugging when the active file has a breakpoint', () => {
    // both Pyokka bindings on F5 shadow VS Code's Start Debugging while a session exists on the
    // file; the guard hands the key back so the run can pause at the breakpoint
    const f5 = keybindings.filter((k) => k.key === 'f5');
    expect([...f5.map((k) => k.command)].sort()).toEqual(['pyokka.playTraceForwardToSelection', 'pyokka.reexecute']);
    for (const k of f5) expect(k.when ?? '', k.command).toContain('!pyokka.activeFileHasBreakpoints');
  });
  it('puts only the two debug starts in the panel title: once a session exists the VS Code debug toolbar steps it', () => {
    const title = (manifest.contributes.menus['view/title'] ?? []).filter((e) => e.when?.includes('pyokka.output'));
    expect(title.map((e) => e.command)).toEqual(['pyokka.debugCurrentFile', 'pyokka.debugCurrentFileRecording']);
    const debug = title.find((e) => e.command === 'pyokka.debugCurrentFile');
    expect(debug?.when).toContain('!pyokka.debugActive');
    expect(debug?.group).toBe('navigation@0');
    expect(commands.find((c) => c.command === 'pyokka.debugCurrentFile')?.icon).toBe('$(debug-alt)');
  });
  it('declares every launch attribute of the Pyokka debugger, with no required one', () => {
    const dbg = manifest.contributes.debuggers[0]!;
    expect(dbg.type).toBe('pyokka');
    const launch = dbg.configurationAttributes.launch;
    // a launch may name `module` instead of `program`, so nothing is required here
    expect(launch.required).toEqual([]);
    const p = launch.properties;
    expect(Object.keys(p).sort()).toEqual(['args', 'breakOnException', 'cwd', 'env', 'libraryCode', 'module', 'program', 'python', 'record', 'stopOnEntry']);
    expect(p['program']).toMatchObject({ type: 'string', default: '${file}' });
    expect(p['module']).toMatchObject({ type: 'string' });
    expect(p['args']).toMatchObject({ type: 'array', default: [] });
    expect(p['args']!.items).toEqual({ type: 'string' });
    expect(p['cwd']).toMatchObject({ type: 'string', default: '${workspaceFolder}' });
    expect(p['env']).toMatchObject({ type: 'object', default: {} });
    expect(p['env']!.additionalProperties).toEqual({ type: 'string' });
    expect(p['python']).toMatchObject({ type: 'string' });
    expect(p['stopOnEntry']).toMatchObject({ type: 'boolean', default: false });
    expect(p['breakOnException']).toMatchObject({ type: 'string', default: 'uncaught', enum: ['off', 'uncaught', 'raised'] });
    expect(p['libraryCode']).toMatchObject({ type: 'boolean', default: false });
    expect(p['record']).toMatchObject({ type: 'boolean', default: false });
    for (const [name, spec] of Object.entries(p)) expect(spec.description, name).toBeTruthy();
  });

  it('shows the three launch shapes in launch.json and in the snippets', () => {
    const dbg = manifest.contributes.debuggers[0]!;
    expect(dbg.initialConfigurations.map((c) => c.name)).toEqual(['Pyokka: Debug Current File', 'Pyokka: Debug Current File (Recording)', 'Pyokka: Debug Module']);
    expect(dbg.initialConfigurations[1]).toMatchObject({ program: '${file}', record: true });
    expect(dbg.initialConfigurations[2]).toMatchObject({ module: 'app.server', args: [], cwd: '${workspaceFolder}' });
    expect(dbg.configurationSnippets.map((s) => s.label)).toEqual(['Pyokka: Debug Current File', 'Pyokka: Debug Current File (Recording)', 'Pyokka: Debug Module']);
    for (const s of dbg.configurationSnippets) expect(s.body.type).toBe('pyokka');
  });

  it('activates on a URI', () => {
    // assigned, not defaulted: without `onUri` the URI handler would never be registered
    expect(manifest.activationEvents).toEqual(['onLanguage:python', 'onStartupFinished', 'onUri']);
  });

  it('shows the panel and Show / Focus Output with no session, where the panel offers Start and Debug', () => {
    expect(manifest.contributes.views['pyokka-output']?.[0]?.when).toBeUndefined();
    for (const cmd of ['pyokka.showOutput', 'pyokka.focusOutput']) {
      const entry = palette.find((e) => e.command === cmd);
      expect(entry, cmd).toBeTruthy();
      expect(entry?.when, cmd).toBeUndefined();
    }
  });

  it("offers Why This Value on a row of VS Code's Variables view while the Time Machine replays", () => {
    const menu = (manifest.contributes.menus as Record<string, { command: string; when?: string }[]>)['debug/variables/context'] ?? [];
    expect(menu.map((e) => e.command)).toEqual(['pyokka.whyVariable']);
    expect(menu[0]?.when).toBe('debugType == pyokka && pyokka.traceBeingNavigated');
    expect(commands.find((c) => c.command === 'pyokka.whyVariable')?.title).toBe('Why This Value');
  });

  it('keeps the backward keys in the replay debug session, and gives F10, F11 and Shift+F11 to VS Code there', () => {
    const when = (command: string) => keybindings.find((k) => k.command === command)?.when ?? '';
    for (const c of ['pyokka.playTracePrevStep', 'pyokka.playTracePrevStepOver', 'pyokka.playTracePrevStepOut', 'pyokka.playTraceBackwardToSelection', 'pyokka.playTraceBackwardToBreakpoint', 'pyokka.playTraceForwardToBreakpoint']) {
      expect(when(c), c).toContain('(!inDebugMode || debugType == pyokka)');
    }
    for (const c of ['pyokka.playTraceNextStep', 'pyokka.playTraceNextStepOver', 'pyokka.playTraceNextStepOut']) {
      expect(when(c), c).toContain('!inDebugMode');
      expect(when(c), c).not.toContain('debugType == pyokka');
    }
  });

  it('keeps the debugger commands in the palette for a keyboard or an agent', () => {
    for (const command of ['pyokka.debugStepOver', 'pyokka.debugStepInto', 'pyokka.debugStepOut', 'pyokka.debugRestart']) {
      expect(palette.find((e) => e.command === command)?.when, command).toBe('pyokka.debugActive');
    }
  });

  it('offers the recording start next to Debug in the panel and in the palette with no gate', () => {
    const title = (manifest.contributes.menus['view/title'] ?? []).filter((e) => e.when?.includes('pyokka.output'));
    const entry = title.find((e) => e.command === 'pyokka.debugCurrentFileRecording');
    // right next to Debug; both are gated on !debugActive, so it never shows at the same time as Stop
    expect(entry?.group).toBe('navigation@1');
    expect(entry?.when).toBe('view =~ /pyokka.output/ && !pyokka.debugActive');
    expect(commands.find((c) => c.command === 'pyokka.debugCurrentFileRecording')?.title).toBe('Debug Current File (Recording)');
    expect(commands.find((c) => c.command === 'pyokka.debugCurrentFileRecording')?.icon).toBe('$(debug-alt-small)');
    // like Debug Current File: always offered, because it starts a session of its own
    const inPalette = palette.find((e) => e.command === 'pyokka.debugCurrentFileRecording');
    expect(inPalette).toBeTruthy();
    expect(inPalette?.when).toBeUndefined();
  });

  it('lists Show HTTP Requests and Open HTTP Recording, in the palette while a session is active', () => {
    for (const [cmd, title] of [['pyokka.showHttp', 'Show HTTP Requests'], ['pyokka.openHttpRecording', 'Open HTTP Recording']] as const) {
      expect(commands.find((c) => c.command === cmd)?.title, cmd).toBe(title);
      expect(palette.find((e) => e.command === cmd)?.when, cmd).toBe('pyokka.hasActiveSession');
    }
  });
});
