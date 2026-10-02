#!/usr/bin/env node
'use strict';

// Renders a tour merged with its prose (`pyokka tour RUN --prose tour.prose.json --out tour.json`)
// into one standalone HTML file: intro, a chapter map, chapters as folding sections, one card per
// picked stop with its quoted slice and its values folded behind a toggle. No scripts, no network,
// no dependencies: folding is <details>, and light and dark come from prefers-color-scheme.
//
// It is a separate script from render-code-history.cjs on purpose. That page is a two-panel,
// script-driven source viewer rendered through Handlebars and Shiki, dark only; this one is a
// document that reads at 400px with no JavaScript. Sharing a stylesheet would force one of the
// two to change, and the history page is in use.

const fs = require('node:fs');
const path = require('node:path');

const USAGE = 'Usage: node render-tour.cjs tour.json page.html [--title TEXT]';
const VALUE_SHOWN = 1200;

const CSS = `
:root{--bg:#f7f5f0;--surface:#fff;--ink:#1f2328;--muted:#5d636b;--line:#e2ded4;--accent:#1f5f99;
  --quote-bg:#fbf4dc;--quote-bar:#c99a1b;--code-bg:#f0eee8;--chip:#eef2ec;--chip-ink:#2f5a2f;--warn:#8a5a00;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#16181b;--surface:#1f2226;--ink:#e7e5e0;
  --muted:#a3a7ad;--line:#33373d;--accent:#8cbcf0;--quote-bg:#2c2716;--quote-bar:#d9ad3a;--code-bg:#272a2f;
  --chip:#24301f;--chip-ink:#a9d39a;--warn:#e0b25c;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#16181b;--surface:#1f2226;--ink:#e7e5e0;--muted:#a3a7ad;--line:#33373d;--accent:#8cbcf0;
  --quote-bg:#2c2716;--quote-bar:#d9ad3a;--code-bg:#272a2f;--chip:#24301f;--chip-ink:#a9d39a;--warn:#e0b25c;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;overflow-wrap:anywhere}
.wrap{max-width:780px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 6px}
.run{font:.78rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin:0 0 14px}
.intro{font-size:1.05rem;margin:0 0 20px}
.map{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:0 0 24px;padding:0;list-style:none}
.map a{display:block;height:100%;text-decoration:none;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.map a:hover,.map a:focus-visible{border-color:var(--accent);outline:none}
.map .n{font-size:.72rem;color:var(--muted);font-weight:700;letter-spacing:.04em}
.map .t{font-weight:700;line-height:1.3;margin:2px 0 6px}
.map .s{font-size:.76rem;color:var(--muted)}
.llm{display:inline-block;font-size:.72rem;font-weight:700;border-radius:999px;padding:1px 8px;background:var(--chip);color:var(--chip-ink);margin-top:4px}
.llm.none{background:transparent;color:var(--muted);padding-left:0}
details.ch{border-top:2px solid var(--line);padding:4px 0 10px}
details.ch>summary{cursor:pointer;list-style:none;padding:10px 0}
details.ch>summary::-webkit-details-marker{display:none}
details.ch>summary h2{display:inline;font-size:1.25rem;margin:0}
details.ch>summary::before{content:"\\25B8";display:inline-block;width:1.2em;color:var(--accent)}
details.ch[open]>summary::before{content:"\\25BE"}
.chmeta{font-size:.78rem;color:var(--muted);margin:2px 0 0 1.2em}
.chtext{margin:4px 0 12px 1.2em}
.stop{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:12px 14px;margin:12px 0}
.stop h3{font-size:1.02rem;margin:0 0 4px;line-height:1.35}
.where{font:.74rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin:0 0 8px}
.stop p{margin:0}
code{font:.86em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code-bg);padding:1px 5px;border-radius:5px}
blockquote{margin:10px 0 0;padding:8px 12px;background:var(--quote-bg);border-left:3px solid var(--quote-bar);border-radius:6px;font-size:.93rem;white-space:pre-wrap}
.qsrc{font-size:.72rem;color:var(--muted);margin-top:3px}
.qsrc .cut{color:var(--warn)}
details.vals{margin-top:10px}
details.vals>summary{cursor:pointer;font-size:.8rem;color:var(--accent);font-weight:700}
.val{margin:8px 0 0}
.vname{font:.74rem ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.vname i{font-style:normal;opacity:.8}
pre{margin:3px 0 0;padding:8px 10px;background:var(--code-bg);border-radius:6px;font:.76rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}
.same{font-size:.8rem;color:var(--muted);margin:3px 0 0}
.ev{font-size:.74rem;color:var(--muted);margin:4px 0 0}
.foot{margin-top:24px;font-size:.76rem;color:var(--muted)}
`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Prose marks names with `backticks`; everything else is text.
function prose(s) {
  return String(s ?? '').split('`').map((part, i) => (i % 2 ? `<code>${esc(part)}</code>` : esc(part))).join('');
}

const n = x => Number(x ?? 0).toLocaleString('en-US');
const plural = (k, word) => `${n(k)} ${word}${k === 1 ? '' : 's'}`;

function parseArgs(argv) {
  const positional = [];
  let title = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--title') {
      title = argv[i += 1];
      if (!title) throw new Error(`--title needs a value. ${USAGE}`);
    } else if (argv[i].startsWith('--')) {
      throw new Error(`Unknown flag ${argv[i]}. ${USAGE}`);
    } else positional.push(argv[i]);
  }
  if (positional.length !== 2) throw new Error(USAGE);
  return { input: positional[0], output: positional[1], title };
}

function validate(tour) {
  if (!tour || tour.tour !== 1) throw new Error('Expected a tour.json from `pyokka tour` ("tour": 1).');
  if (!tour.prose || !Array.isArray(tour.pick)) {
    throw new Error('This tour has no prose. Merge it first: `pyokka tour RUN --prose tour.prose.json --out tour.json`.');
  }
  if (!Array.isArray(tour.chapters) || !Array.isArray(tour.candidates)) throw new Error('Expected chapters and candidates arrays.');
  const ids = new Set(tour.candidates.map(c => c.id));
  for (const id of tour.pick) {
    if (!ids.has(id)) throw new Error(`pick names ${id}, which is not a candidate of this tour.`);
  }
  if (tour.pick.length === 0) throw new Error('The tour picks no stops.');
}

function valueBlock(v, owner) {
  const role = v.role && v.role !== 'set' ? ` <i>${esc(v.role)}</i>` : '';
  const head = `<div class=vname>${esc(v.name)}${role}</div>`;
  if (v.sameAs) {
    const o = owner.get(v.sameAs);
    const where = o ? ` <code>${esc(o.name)}</code> at #${n(o.step)}` : ` ${esc(v.sameAs)}`;
    return `<div class=val>${head}<p class=same>same as${where}</p></div>`;
  }
  let body = String(v.text ?? '');
  let note = '';
  if (v.like) {
    const o = owner.get(v.like);
    note = `<p class=same>only the part that differs from${o ? ` <code>${esc(o.name)}</code> at #${n(o.step)}` : ' the previous value'}: characters ${n(v.from)} to ${n(v.to)} of ${n(v.length)}</p>`;
  } else if (v.cut) {
    note = `<p class=same>first ${n(body.length)} of ${n(v.length)} characters</p>`;
  }
  if (body.length > VALUE_SHOWN) body = `${body.slice(0, VALUE_SHOWN)}…`;
  const ev = (v.evidence || []).map(e => `<p class=ev>characters ${n(e.from)} to ${n(e.to)}: ${esc(e.text)}</p>`).join('');
  return `<div class=val>${head}<pre>${esc(body)}</pre>${note}${ev}</div>`;
}

function stopCard(c, owner) {
  const p = c.prose || {};
  const o = [`<div class=stop id="${esc(c.id)}">`, `<h3>${prose(p.title)}</h3>`,
    `<div class=where>${esc(c.file)}:${c.line} · ${esc(c.function)} · #${n(c.step)}</div>`, `<p>${prose(p.text)}</p>`];
  const q = p.quote;
  if (q) {
    const cut = q.recordingCut
      ? ` <span class=cut>The recording kept only the first ${n(q.length)} characters of this value.</span>` : '';
    o.push(`<blockquote>${esc(q.text)}</blockquote>`,
      `<div class=qsrc>quoted from <code>${esc(q.name)}</code>, characters ${n(q.from)} to ${n(q.to)} of ${n(q.length)}.${cut}</div>`);
  }
  const values = c.values || [];
  o.push(`<details class=vals><summary>statement and ${plural(values.length, 'value')}</summary>`,
    `<div class=val><div class=vname>statement</div><pre>${esc(c.statement)}</pre></div>`,
    ...values.map(v => valueBlock(v, owner)), '</details></div>');
  return o.join('\n');
}

function render(tour, title) {
  const run = tour.run || {};
  const file = path.basename(String(run.file || 'run'));
  const heading = title || `What ${file} did, step by step`;
  const byId = new Map(tour.candidates.map(c => [c.id, c]));
  const owner = new Map();
  for (const c of tour.candidates) for (const v of c.values || []) owner.set(v.id, { name: v.name, step: c.step });
  const picked = tour.pick.map(id => byId.get(id));
  const chapters = tour.chapters
    .map(ch => ({ ch, stops: picked.filter(c => c.chapter === ch.id) }))
    .filter(x => x.stops.length);
  const chTitle = ch => (ch.prose && ch.prose.title) || ch.title;
  const llm = k => (k ? `<span class=llm>${plural(k, 'LLM call')}</span>` : '<span class="llm none">no LLM calls</span>');

  const o = ['<!doctype html>', '<html lang="en"><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">', `<title>${esc(heading)}</title>`,
    `<style>${CSS}</style>`, '<div class=wrap>', `<h1>${esc(heading)}</h1>`,
    `<p class=run>${esc(file)} · ${n(run.steps)} steps · exit ${esc(run.exitCode)} · ${plural(run.http || 0, 'HTTP request')}, ${plural(run.llm || 0, 'model call')}</p>`];
  if (tour.intro) o.push(`<p class=intro>${prose(tour.intro)}</p>`);
  if (chapters.length > 1) {
    o.push('<ol class=map>');
    chapters.forEach(({ ch }, i) => o.push(`<li><a href="#${esc(ch.id)}"><div class=n>${i + 1}</div><div class=t>${prose(chTitle(ch))}</div>`
      + `<div class=s>steps ${n(ch.steps[0])} to ${n(ch.steps[1])}</div>${llm(ch.llm || 0)}</a></li>`));
    o.push('</ol>');
  }
  chapters.forEach(({ ch, stops }, i) => {
    o.push(`<details class=ch id="${esc(ch.id)}" open><summary><h2>${i + 1}. ${prose(chTitle(ch))}</h2>`
      + `<div class=chmeta>steps ${n(ch.steps[0])} to ${n(ch.steps[1])} · opened by <code>${esc(ch.title)}</code> · ${plural(ch.llm || 0, 'LLM call')} · ${plural(stops.length, 'stop')}</div></summary>`);
    if (ch.prose && ch.prose.text) o.push(`<p class=chtext>${prose(ch.prose.text)}</p>`);
    for (const c of stops) o.push(stopCard(c, owner));
    o.push('</details>');
  });
  const truncated = run.recording && run.recording.truncated
    ? ` The recording was cut after ${n(run.recording.kept)} of ${n(run.recording.stepsRun)} steps.` : '';
  o.push(`<p class=foot>Stops, values, quoted slices, step ranges and call counts come from one recording of <code>${esc(file)}</code>`
    + ` through <code>pyokka tour</code>. The titles and text were written from it and checked by <code>pyokka tour --prose</code>:`
    + ` every number in them occurs in the stop's recorded values, and every quote is cut from the recorded value by Pyokka.${truncated}</p>`);
  o.push('</div>');
  return `${o.join('\n')}\n`;
}

function main() {
  const { input, output, title } = parseArgs(process.argv.slice(2));
  const tour = JSON.parse(fs.readFileSync(input, 'utf8'));
  validate(tour);
  const target = path.resolve(output);
  if (target === path.resolve(input)) throw new Error('Output must differ from input.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(tour, title));
  console.log(target);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
