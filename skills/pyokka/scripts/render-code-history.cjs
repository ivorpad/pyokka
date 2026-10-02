#!/usr/bin/env node
'use strict';

// Renders the data `pyokka history` writes into one standalone HTML file: no CDN, no network,
// no browser-side Handlebars. It validates first, because a page that renders a broken range or
// an unknown evidence kind is worse than a command that failed and said why.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const KINDS = ['recorded step', 'live pause', 'static source', 'gloss'];
// Highlighting happens here, not in the browser: the page has to open with no network, and a
// theme's own tokenizer is worth more than a regex that guesses at Python.
const DEFAULT_THEME = 'github-dark-dimmed';
const LANGUAGES = { '.py': 'python', '.pyi': 'python' };
const USAGE = 'Usage: node render-code-history.cjs history.json page.html [--theme NAME] [--handlebars-module /absolute/path/to/handlebars]';
const VIA = ['root', 'reads', 'calls'];
const META_STRINGS = ['mode', 'run', 'file', 'sourceSha256', 'runSha256', 'python', 'runtimeVersion', 'recordedAt'];
// Every word the page draws itself, per language. `lang` picks the set by its primary subtag
// (`es`, `es-MX`), an unknown language gets English, and `labels` in the data overrides any key.
const LABELS = {
  en: {
    prev: '← Previous', next: 'Next →', checkpoint: 'Checkpoint', nav: 'Browse the evidence',
    source: 'Source', sourceSide: 'SOURCE / CHECKOUT', history: 'CODE STORY',
    relevant: '▪ line that ran', dim: 'dim = context it did not', selected: 'selected checkpoint',
    navigate: 'navigate', verify: 'verify', reads: 'reads', chain: 'where it came from',
    output: 'output so far', stack: 'stack',
    run: 'run', mode: 'mode', sourceHash: 'source', runJson: 'run.json', python: 'python', exit: 'exit',
    steps: 'steps', pausedAt: 'paused at', recorded: 'recorded', leftOut: 'left out',
    hit: 'hit', hits: 'hits', in: 'in', out: 'out',
  },
  es: {
    prev: '← Anterior', next: 'Siguiente →', checkpoint: 'Punto de control', nav: 'Recorrer la evidencia',
    source: 'Código', sourceSide: 'CÓDIGO / CHECKOUT', history: 'HISTORIA DEL CÓDIGO',
    relevant: '▪ línea que se ejecutó', dim: 'atenuado = contexto que no', selected: 'punto de control elegido',
    navigate: 'navegar', verify: 'verificar', reads: 'lee', chain: 'de dónde viene',
    output: 'salida hasta aquí', stack: 'pila',
    run: 'ejecución', mode: 'modo', sourceHash: 'código', runJson: 'run.json', python: 'python', exit: 'código de salida',
    steps: 'pasos', pausedAt: 'en pausa en', recorded: 'grabado', leftOut: 'omitido',
    hit: 'vez', hits: 'veces', in: 'entra', out: 'sale',
  },
};

// Handlebars and the default theme's Shiki come vendored in render-deps.cjs, so a page renders
// with nothing installed. An installed copy is only looked for when --handlebars-module names one
// or --theme asks for a theme the bundle lacks: the working directory first, then the skill's own
// node_modules, then a per-user install. The skill has to work from a project that has never
// heard of either package. Neither file has to exist; `createRequire`
// only needs somewhere to start walking up from.
const ANCHORS = [
  path.join(process.cwd(), 'code-history-resolver.cjs'),
  path.join(__dirname, '..', 'code-history-resolver.cjs'),
  // a per-user install, so a page never needs packages in the project being explained
  path.join(require('node:os').homedir(), '.cache', 'pyokka', 'render', 'code-history-resolver.cjs'),
];

let vendored;
function loadVendored() {
  try {
    vendored ??= require('./render-deps.cjs');
  } catch {
    vendored = null;
  }
  return vendored;
}

function loadHandlebars(modulePath) {
  if (!modulePath && loadVendored()) return vendored.Handlebars;
  const candidates = modulePath ? [path.resolve(modulePath)] : ANCHORS;
  for (const candidate of candidates) {
    try {
      return modulePath ? require(candidate) : createRequire(candidate)('handlebars');
    } catch { /* try the next one */ }
  }
  throw new Error('Handlebars is unavailable. Install it once with `npm install --prefix ~/.cache/pyokka/render handlebars shiki`, or pass --handlebars-module /absolute/path/to/handlebars; this renderer installs nothing.');
}

async function loadShiki(theme) {
  if (loadVendored() && Object.hasOwn(vendored.shiki.bundledThemes, theme)) return vendored.shiki;
  for (const anchor of ANCHORS) {
    try {
      return await import(pathToFileURL(createRequire(anchor).resolve('shiki')).href);
    } catch { /* try the next one */ }
  }
  return null;
}

// Tokens, not markup: the page builds its own spans, so the colours ride along as a palette and
// a per-line list of [colour, text, fontStyle?]. A row count that disagrees with the file would
// paint one line's colours onto another, which is a lie about the source, so that file goes
// unhighlighted instead.
async function highlight(data, theme) {
  const shiki = await loadShiki(theme);
  if (!shiki) return `rendered without syntax highlighting: only ${DEFAULT_THEME} is bundled, and ${theme} needs shiki installed (npm install --prefix ~/.cache/pyokka/render shiki).`;
  if (!Object.hasOwn(shiki.bundledThemes, theme)) {
    throw new Error(`Unknown theme ${JSON.stringify(theme)}. Use a bundled Shiki theme, for example ${DEFAULT_THEME}.`);
  }
  const palette = [];
  const files = {};
  let fg = '';
  for (const [label, lines] of Object.entries(data.files)) {
    const language = LANGUAGES[path.extname(label).toLowerCase()];
    if (!language || lines.length === 0) continue;
    const result = await shiki.codeToTokens(lines.join('\n'), { lang: language, theme });
    if (result.tokens.length !== lines.length) continue;
    fg = result.fg || fg;
    files[label] = result.tokens.map(row => row.map(token => {
      let at = palette.indexOf(token.color);
      if (at < 0) at = palette.push(token.color) - 1;
      return token.fontStyle > 0 ? [at, token.content, token.fontStyle] : [at, token.content];
    }));
  }
  if (Object.keys(files).length) data.highlight = { theme, fg, palette, files };
  return '';
}

function parseArgs(argv) {
  const positional = [];
  let theme = DEFAULT_THEME;
  let modulePath = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--theme' || arg === '--handlebars-module') {
      const value = argv[i += 1];
      if (!value) throw new Error(`${arg} needs a value. ${USAGE}`);
      if (arg === '--theme') theme = value; else modulePath = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag ${arg}. ${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new Error(USAGE);
  return { input: positional[0], output: positional[1], theme, modulePath };
}

function labelsFor(lang) {
  const primary = String(lang).toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(LABELS, primary) ? LABELS[primary] : LABELS.en;
}

function validate(data) {
  for (const key of ['lang', 'title', 'eyebrow', 'heading', 'subtitle', 'summary', 'historyLabel', 'scope', 'footer']) {
    if (typeof data[key] !== 'string') throw new Error(`Expected string: ${key}`);
  }
  if (!data.meta || typeof data.meta !== 'object' || Array.isArray(data.meta)) throw new Error('Expected meta: the run identity as an object.');
  // Handlebars runs strict, so every field the header names has to exist; a live page has no exit
  // code and a saved run has no pause, and an absent chip is simply not drawn.
  data.meta.paused ??= '';
  data.meta.exitCode ??= null;
  data.meta.stepCount ??= null;
  data.meta.truncated ??= [];
  for (const key of META_STRINGS) if (typeof data.meta[key] !== 'string') throw new Error(`Expected string: meta.${key}`);
  if (!Array.isArray(data.meta.truncated)) throw new Error('Expected array: meta.truncated');
  if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
    throw new Error('Expected files: an object mapping source labels to arrays of lines.');
  }
  if (!Array.isArray(data.steps) || data.steps.length === 0) throw new Error('At least one checkpoint is required.');
  const validLink = value => typeof value === 'string' && value.length > 0
    && !/[\u0000-\u0020\u007f]/.test(value)
    && (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^https?:\/\//i.test(value));
  data.reportHref ??= '';
  data.reportLabel ??= '';
  data.labels = { ...labelsFor(data.lang), ...(data.labels || {}) };
  if (data.reportHref && (!validLink(data.reportHref) || !data.reportLabel)) throw new Error('Invalid report link or missing reportLabel.');
  const seen = new Set();
  for (const [index, step] of data.steps.entries()) {
    const fail = message => { throw new Error(`Checkpoint ${index + 1} (${step.id || 'no id'}): ${message}`); };
    // Optional evidence defaults, so a hand-written checkpoint stays as short as what it claims.
    step.step ??= null; step.call ??= null; step.hits ??= null; step.arm ??= null; step.gloss ??= null;
    step.exception ??= null; step.http ??= null; step.modified ??= false; step.reason ??= '';
    for (const key of ['title', 'text', 'note', 'values', 'output']) step[key] ??= '';
    for (const key of ['chain', 'reads', 'stack', 'bright', 'evidence']) step[key] ??= [];
    for (const key of ['id', 'kind', 'tag', 'file', 'title', 'text', 'note', 'values', 'verify', 'output']) {
      if (typeof step[key] !== 'string') fail(`expected string: ${key}`);
    }
    if (seen.has(step.id)) fail('duplicate id; --prose keys on it, so it has to be unique');
    seen.add(step.id);
    if (!KINDS.includes(step.kind)) fail(`unknown evidence kind ${JSON.stringify(step.kind)}; one of ${KINDS.join(', ')}`);
    if (!step.verify.startsWith('pyokka ')) fail('verify must be the pyokka command that reproduces these values');
    if (step.kind === 'static source' && step.values) fail('a static-source checkpoint has no observed values; say so rather than showing some');
    if (step.kind === 'live pause' && step.chain && step.chain.length) fail('a live pause records nothing behind it, so it has no provenance chain');
    const lines = Object.hasOwn(data.files, step.file) ? data.files[step.file] : null;
    if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) fail('source must be an array of lines');
    if (![step.start, step.end, step.focus].every(Number.isInteger)
        || step.start < 1 || step.start > step.focus || step.focus > step.end || step.end > lines.length) fail('invalid source range or focus');
    if (!Array.isArray(step.bright) || !step.bright.every(n => Number.isInteger(n) && n >= step.start && n <= step.end)) fail('invalid highlighted lines');
    if (step.step !== null && !Number.isInteger(step.step)) fail('step must be a step number or null');
    if (!Array.isArray(step.chain) || !step.chain.every(n => Number.isInteger(n.depth) && VIA.includes(n.via))) fail('chain entries need an integer depth and a via of ' + VIA.join('/'));
    for (const key of ['reads', 'stack']) {
      if (!Array.isArray(step[key]) || !step[key].every(v => typeof v === 'string')) fail(`expected an array of strings: ${key}`);
    }
    if (step.call && (typeof step.call.name !== 'string' || !Array.isArray(step.call.in))) fail('call needs a name and an in array');
    if (!Array.isArray(step.evidence) || !step.evidence.every(validLink)) fail('invalid evidence links; use URL-encoded paths');
  }
}

async function main() {
  const { input, output, theme, modulePath } = parseArgs(process.argv.slice(2));
  const Handlebars = loadHandlebars(modulePath);
  const data = JSON.parse(fs.readFileSync(input, 'utf8'));
  delete data._warnings;
  delete data.highlight;
  validate(data);
  const warning = await highlight(data, theme);
  // The JSON sits in an inert script tag: escape the HTML delimiters without changing any value.
  const engine = Handlebars.create();
  engine.registerHelper('json', value => new engine.SafeString(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)));
  engine.registerHelper('chip', (label, value) => (value === '' || value === null || value === undefined
    ? '' : new engine.SafeString(`<span class="chip"><b>${engine.escapeExpression(label)}</b> ${engine.escapeExpression(String(value))}</span>`)));
  const templatePath = path.join(__dirname, '..', 'templates', 'code-history.html.hbs');
  const render = engine.compile(fs.readFileSync(templatePath, 'utf8'), { strict: true });
  const rendered = render(data);
  const target = path.resolve(output);
  if (target === path.resolve(input) || target === templatePath) throw new Error('Output must differ from input and template.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered);
  if (warning) console.error(warning);
  console.log(target);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
