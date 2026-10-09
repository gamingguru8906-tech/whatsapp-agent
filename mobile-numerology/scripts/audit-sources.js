// Source audit, both directions. Run: npm run audit  (part of npm test)
//  1. Nothing added: every word a visitor reads must appear in that rule's source passage, or be listed in
//     rules/audit-reviewed.json as a paraphrase checked by hand (spelling, word form, connecting words).
//  2. Nothing missed: every grid diagram, shot-gun line, profession line, remedy and planet on the slides has a
//     rule, and each yoga's present/absent digits match the diagram transcribed from the slide image.
// --write-reviewed regenerates audit-reviewed.json from the current wording; use it only after reading every
// listed word yourself.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = f => JSON.parse(readFileSync(join(root, 'rules', `${f}.json`), 'utf8'));
const source = f => readFileSync(join(root, 'sources', f), 'utf8');
const norm = s => String(s).normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-').replace(/\*+/g, '').toLowerCase();
const flat = s => norm(s).replace(/\s+/g, ' ').trim();

// Function words that carry no claim of their own.
const STOP = new Set(('a an the and or of to in on for with by at as is are be been being it its this that these those you your yours their they them he his she her we our us i me my mine may can could might will would should must not no nor but if then than so such also too very more most less much many any some all each every both either neither one ones own same other another into onto from up down out over under again further once here there when where why how what which who whom whose do does did doing done have has had having get gets got gives give given brings bring brought comes come makes make made keep keeps let lets take takes taking use used using shows show shown points point linked links link forms form while just only even still yet about around through across before after during until without within between whether part parts way ways thing things time times year years day days well good care need needs needed').split(/\s+/));
const stem = w => w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s|ly)$/, '');
const words = s => (norm(s).match(/[a-z][a-z'-]+/g) || []).map(w => w.replace(/'$/, ''));
const unexplained = (text, context) => {
  const have = new Set(words(context).map(stem));
  const nums = new Set(norm(context).match(/\d+/g) ?? []);
  const newWords = words(text).filter(w => w.length > 2 && !STOP.has(w) && !have.has(stem(w)));
  const newNums = (norm(text).match(/\d+/g) ?? []).filter(n => !nums.has(n));
  return [...new Set([...newWords, ...newNums])].sort();
};

const slides = source('P01-srk-slides.md');
const lines = slides.split('\n');
const lineWith = q => lines.find(l => flat(l).includes(flat(q))) ?? '';
const blockWith = (q, startRe) => {
  const i = lines.findIndex(l => flat(l).includes(flat(q)));
  let a = i; while (a > 0 && !startRe.test(lines[a])) a--;
  let b = i + 1; while (b < lines.length && !startRe.test(lines[b]) && !/^## /.test(lines[b])) b++;
  return lines.slice(a, b).join(' ');
};
const paragraphWith = (file, q) => source(file).split(/\n\s*\n/).find(p => flat(p).includes(flat(q))) ?? '';

// ---- 1. Nothing added ----
const found = {};
const check = (id, text, context) => { const w = unexplained(text, context); if (w.length) found[id] = w; };
const shotgun = rules('shotgun'), yogas = rules('yogas'), planets = rules('planets'), remedies = rules('remedies'), py = rules('personal-year'), professions = rules('professions');
for (const r of shotgun.rules) check(r.id, Object.values(r.story).join(' '), lineWith(r.quote));
for (const r of yogas.rules) check(r.id,
  [...Object.values(r.story), r.remedy?.text ?? '', ...(r.multiples ?? []).map(m => m.care)].join(' '),
  [lineWith(r.quote), r.remedy?.quote ?? '', ...(r.multiples ?? []).map(m => m.quote), r.planets].join(' '));
for (const r of planets.rules) check(r.id, `${r.story.trait} ${r.story.signifies}`, blockWith(r.quote, /^\d: [A-Z]+$/));
for (const r of remedies.rules) check(r.id, [r.screen_saver ?? '', r.bracelet, r.mani].join(' '), blockWith(r.quote, /^\d\. BIRTH NUMBER/));
for (const it of [...Object.values(py.years).flat(), ...py.for_everyone]) {
  const file = py.sources[it.src];
  check(it.id, it.text, [it.quote, ...(it.also ?? [])].map(q => paragraphWith(file, q)).join(' '));
}

const reviewedPath = join(root, 'rules', 'audit-reviewed.json');
if (process.argv.includes('--write-reviewed')) {
  writeFileSync(reviewedPath, JSON.stringify({
    about: 'Words in the site wording that do not appear in the rule\'s source passage, each read by hand and accepted as paraphrase (spelling, word form, connecting words). Anything not listed here fails npm run audit.',
    words: found
  }, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(found).length} reviewed entries.`);
}
const reviewed = JSON.parse(readFileSync(reviewedPath, 'utf8')).words;
const errors = [];
for (const [id, list] of Object.entries(found)) {
  const extra = list.filter(w => !(reviewed[id] ?? []).includes(w));
  if (extra.length) errors.push(`${id}: words not in the source passage and not reviewed: ${extra.join(', ')}`);
}

// ---- 2. Nothing missed ----
const GRID = [[3, 1, 9], [6, 7, 5], [2, 8, 4]];
const sameSet = (a, b) => [...a].sort().join() === [...b].sort().join();
let diagrams = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i] !== '```' || lines[i + 4] !== '```') continue;
  const rows = lines.slice(i + 1, i + 4);
  if (!rows.every(r => /^[0-9X.] [0-9X.] [0-9X.]$/.test(r)) || !(lines[i + 5] ?? '').includes(' — ')) continue;
  diagrams++;
  const present = [], absent = [];
  rows.forEach((row, r) => row.split(' ').forEach((c, k) => {
    if (c === 'X') absent.push(GRID[r][k]);
    else if (c !== '.') { if (Number(c) !== GRID[r][k]) errors.push(`diagram "${lines[i + 5].slice(0, 40)}": digit ${c} in the wrong cell`); present.push(Number(c)); }
  }));
  const name = flat(lines[i + 5].split(' — ')[0]);
  const y = yogas.rules.find(y => flat(y.quote).startsWith(`${name} -`));
  if (!y) errors.push(`diagram "${lines[i + 5].slice(0, 50)}" has no yoga rule`);
  else if (!sameSet(present, y.present) || !sameSet(absent, y.absent)) errors.push(`${y.id}: digits differ from the slide diagram (slide present ${present} absent ${absent})`);
}
if (diagrams !== yogas.rules.length) errors.push(`slides have ${diagrams} yoga diagrams but there are ${yogas.rules.length} yoga rules`);
const sgLines = lines.filter(l => /^- \d ?-? ?\d/.test(l) && l.includes(' — '));
for (const l of sgLines) if (!shotgun.rules.some(r => flat(l).includes(flat(r.quote)))) errors.push(`shot-gun line has no rule: ${l}`);
const s32 = lines.slice(lines.findIndex(l => l.startsWith('## Slide 32')), lines.findIndex(l => l.startsWith('## Slide 33'))).filter(l => l.startsWith('- '));
for (const l of s32) if (!professions.rules.some(r => flat(l).includes(flat(r.quote)))) errors.push(`profession line has no rule: ${l}`);
for (const r of professions.rules) {
  const fromLine = r.quote.split(/[–-]\s/).pop().replace(/Can take '8' in mobile number/, '8').split('/').map(s => s.trim().replace(/\s*AND\s*/i, '+'));
  if (fromLine.join('|') !== r.codes.join('|')) errors.push(`${r.id}: codes ${r.codes} differ from the slide (${fromLine})`);
}
const remedyHeads = lines.filter(l => /^\d\. BIRTH NUMBER/.test(l)).length;
if (remedyHeads !== remedies.rules.length) errors.push(`slides have ${remedyHeads} birth-number remedies, rules have ${remedies.rules.length}`);
const planetHeads = lines.filter(l => /^\d: [A-Z]+$/.test(l)).length;
if (planetHeads !== planets.rules.length) errors.push(`slides have ${planetHeads} planets, rules have ${planets.rules.length}`);

if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\nSource audit FAILED: ${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`Source audit passed. Nothing added: every site word is in its source passage or a hand-checked paraphrase (${Object.keys(found).length} rules have reviewed paraphrases). Nothing missed: ${diagrams}/${yogas.rules.length} yoga diagrams match, ${sgLines.length} shot-gun lines, ${s32.length} profession lines, ${remedyHeads} remedies and ${planetHeads} planets all have rules.`);
