// Checks the rulebook against the saved sources. Run: npm run lint:rules  (add --strict before launch)
// --strict also fails while any rule is unapproved or any conflict is undecided (see rules/review.json).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const read = p => readFileSync(join(root, p), 'utf8');
const json = p => JSON.parse(read(p));

// Quotes are compared after normalising case, quote marks, dashes, markdown emphasis and whitespace,
// so a quote must exist word for word in the source but formatting differences don't matter.
export const norm = s => String(s).normalize('NFKC')
  .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—−]/g, '-').replace(/\*+/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();

const errors = [];
const warnings = [];
const fail = m => errors.push(m);
const sources = {};
const sourceText = file => (sources[file] ??= norm(read(join('sources', file))));
const checkQuote = (id, file, quote) => {
  if (!quote) return fail(`${id}: missing quote`);
  if (!existsSync(join(root, 'sources', file))) return fail(`${id}: source file ${file} not found`);
  if (!sourceText(file).includes(norm(quote))) fail(`${id}: quote not found in ${file}: "${quote}"`);
};

const ids = new Map();
const addId = (id, where) => {
  if (ids.has(id)) fail(`duplicate id ${id} (${ids.get(id)} and ${where})`);
  ids.set(id, where);
};
const digitsOk = arr => Array.isArray(arr) && arr.every(d => Number.isInteger(d) && d >= 1 && d <= 9);
const hasStory = s => s && (s.good || s.care || s.trait);

// Shot-gun pairs: all 36 unordered pairs of different digits, with 1-2 and 2-1 as separate rules.
const shotgun = json('rules/shotgun.json');
const seen = new Set();
for (const r of shotgun.rules) {
  addId(r.id, 'shotgun');
  checkQuote(r.id, shotgun.source_file, r.quote);
  if (!/^[1-9]{2}$/.test(r.pair) || r.pair[0] === r.pair[1]) fail(`${r.id}: bad pair ${r.pair}`);
  const key = r.ordered ? r.pair : [...r.pair].sort().join('');
  if (seen.has(key)) fail(`${r.id}: pair ${r.pair} covered twice`);
  seen.add(key);
  if (!hasStory(r.story)) fail(`${r.id}: no story text`);
}
for (let a = 1; a <= 9; a++) for (let b = a + 1; b <= 9; b++) {
  const k = `${a}${b}`;
  if (k === '12') { if (!seen.has('12') || !seen.has('21')) fail('shotgun: 1-2 and 2-1 must both exist'); continue; }
  if (!seen.has(k)) fail(`shotgun: pair ${a}-${b} has no rule`);
}

const yogas = json('rules/yogas.json');
for (const r of yogas.rules) {
  addId(r.id, 'yoga');
  checkQuote(r.id, yogas.source_file, r.quote);
  if (!digitsOk(r.present) || r.present.length < 2) fail(`${r.id}: present must list 2+ digits 1-9`);
  if (!digitsOk(r.absent)) fail(`${r.id}: absent must list digits 1-9`);
  if (r.present.some(d => r.absent.includes(d))) fail(`${r.id}: a digit is both present and absent`);
  if (!hasStory(r.story)) fail(`${r.id}: no story text`);
  if (r.remedy) checkQuote(`${r.id} remedy`, yogas.source_file, r.remedy.quote);
  for (const m of r.multiples || []) checkQuote(`${r.id} multiple ${m.digit}`, yogas.source_file, m.quote);
}
const patterns = new Set(yogas.rules.map(r => `${[...r.present].sort()}|${[...r.absent].sort()}`));
if (patterns.size !== yogas.rules.length) fail('yogas: two yogas share the same pattern');

const planets = json('rules/planets.json');
for (const r of planets.rules) { addId(r.id, 'planet'); checkQuote(r.id, planets.source_file, r.quote); }
if (planets.rules.map(r => r.digit).sort().join('') !== '123456789') fail('planets: digits 1-9 must each appear once');

const professions = json('rules/professions.json');
for (const r of professions.rules) {
  addId(r.id, 'profession');
  checkQuote(r.id, professions.source_file, r.quote);
  for (const code of r.codes) if (!/^[1-9]{1,3}(\+[1-9]{1,3})*$/.test(code)) fail(`${r.id}: bad code ${code}`);
}

const remedies = json('rules/remedies.json');
for (const r of remedies.rules) {
  addId(r.id, 'remedy');
  checkQuote(r.id, remedies.source_file, r.quote);
  checkQuote(`${r.id} bracelet`, remedies.source_file, r.bracelet_quote);
  if (!r.screen_saver && r.screen_saver_from !== 'destiny') fail(`${r.id}: no screen saver`);
}
if (remedies.rules.map(r => r.birth_number).sort().join('') !== '123456789') fail('remedies: birth numbers 1-9 must each appear once');

const reviewPath = join(root, 'rules', 'review.json');
const review = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, 'utf8')) : { approved: {} };

const py = json('rules/personal-year.json');
const conflicts = json('rules/conflicts.json');
for (const c of conflicts.conflicts) if (review.conflicts?.[c.id] !== undefined) c.decision = review.conflicts[c.id];
const conflictIds = new Set(conflicts.conflicts.map(c => c.id));
const pyIds = new Set();
for (const m of py.method) { addId(m.id, 'personal-year method'); checkQuote(m.id, py.sources[m.src], m.quote); }
for (let y = 1; y <= 9; y++) {
  const items = py.years[y];
  if (!items?.length) { fail(`personal year ${y}: no items`); continue; }
  for (const it of items) {
    addId(it.id, `personal year ${y}`); pyIds.add(it.id);
    if (!py.sources[it.src]) fail(`${it.id}: unknown source ${it.src}`);
    else { checkQuote(it.id, py.sources[it.src], it.quote); for (const q of it.also || []) checkQuote(`${it.id} (also)`, py.sources[it.src], q); }
    if (!it.text) fail(`${it.id}: no text`);
    if (it.conflict && !conflictIds.has(it.conflict)) fail(`${it.id}: unknown conflict ${it.conflict}`);
  }
}
for (const it of py.for_everyone) {
  addId(it.id, 'personal year (everyone)');
  if (!py.sources[it.src]) fail(`${it.id}: unknown source ${it.src}`); else checkQuote(it.id, py.sources[it.src], it.quote);
}
for (const c of conflicts.conflicts) {
  for (const s of c.sides) if (!pyIds.has(s)) fail(`${c.id}: side ${s} does not exist`);
  for (const o of c.options) for (const s of o.show) if (!pyIds.has(s)) fail(`${c.id}/${o.key}: ${s} does not exist`);
  if (c.decision === null) (strict ? fail : w => warnings.push(w))(`${c.id}: not decided yet`);
  else if (!c.options.some(o => o.key === c.decision)) fail(`${c.id}: decision ${c.decision} is not an option`);
}

const method = json('rules/method.json');
checkQuote('method grid', 'P01-srk-slides.md', method.grid.quote);
for (const s of method.steps) if (s.quote) checkQuote(s.id, s.file, s.quote);
const letters = Object.values(method.chaldean).join(' ').split(/\s+/).sort().join('');
if (letters !== 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') fail('chaldean table must cover A-Z exactly once');

const kw = json('rules/concern-keywords.json');
const ruleAreas = new Set([...shotgun.rules, ...yogas.rules, ...professions.rules].flatMap(r => r.areas || []));
for (const a of ruleAreas) if (!kw.areas[a] && a !== 'personality') fail(`area "${a}" is used by rules but has no concern keywords`);

// Owner approval (filled from the review page). Every rule id must be approved before launch.
for (const id of Object.keys(review.overrides ?? {})) if (!ids.has(id)) fail(`review override for unknown rule ${id}`);
const pending = [...ids.keys()].filter(id => !review.approved?.[id]);
if (pending.length) (strict ? fail : w => warnings.push(w))(`${pending.length} of ${ids.size} rules not yet approved by the owner`);

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\nRulebook check FAILED: ${errors.length} error(s).`);
  process.exit(1);
}
console.log(`Rulebook check passed: ${ids.size} rules (${shotgun.rules.length} shot-gun, ${yogas.rules.length} yogas, ${planets.rules.length} planets, ${professions.rules.length} professions, ${remedies.rules.length} remedies, ${pyIds.size + py.for_everyone.length} personal-year items). Every quote was found in the sources.`);
