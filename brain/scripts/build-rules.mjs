// Builds the brain's rule files from the book notes.
//   node scripts/build-rules.mjs <notes dir> <book text dir>
// For every table row in the chosen sections: parse the condition, verify the quote word for word against the book's
// text, apply the owner's four limits, and decide the status:
//   approved = condition readable + quote found + inside the limits + the reader did not mark it MAYBE/SKIP
//   review   = everything else that is inside the limits (the owner decides in batches)
//   dropped  = outside the four limits (cure claims, death predictions, crime accusations, guaranteed wealth),
//              or the reader marked it SKIP
// Writes rules/<set>.json and rules/REVIEW.md (the list the owner sees). The book texts are not copied anywhere.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNotes } from './parse-notes.mjs';
import { parseCondition } from './conditions.mjs';
import { WATCH_MAP } from './watch-map.mjs';

const [notesDir, textDir] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BOOKS = {
  'B-CHALDEAN': { notes: 'notes-chaldean.md', text: 'chaldean-numerology-guide.txt', rank: 4 },
  'B-NAMENUM': { notes: 'notes-name-numerology.md', text: 'name-numerology.txt', rank: 5 },
  'B-NUMNAME': { notes: 'notes-numerology-and-name.md', text: 'numerology-and-name.txt', rank: 6 },
  'B-LOSHU': { notes: 'notes-lo-shu.md', text: 'lo-shu.txt', rank: 7 },
  'B-WATCH': { notes: 'notes-wristwatch.md', text: 'wristwatch-analysis-ampamp-therapy-masterclass-final.txt', rank: 3 }
};

// Which sections feed which rule set. Sections not listed are not used (no formula in the book, Kua, yantras, etc.).
const PLAN = [
  { book: 'B-CHALDEAN', section: /^3\.1 /, set: 'psychic' },
  { book: 'B-CHALDEAN', section: /^3\.3 /, set: 'destiny' },
  { book: 'B-CHALDEAN', section: /^3\.4 /, set: 'master' },
  { book: 'B-CHALDEAN', section: /^3\.6 /, set: 'personality' },
  { book: 'B-CHALDEAN', section: /^3\.7 /, set: 'missing' },
  { book: 'B-CHALDEAN', section: /^3\.8 /, set: 'planes', skip: r => /^remedy/i.test(r.condition) },
  { book: 'B-CHALDEAN', section: /^3\.9 /, set: 'repeats' },
  { book: 'B-CHALDEAN', section: /^3\.10 /, set: 'karmic' },
  { book: 'B-CHALDEAN', section: /^3\.13 /, set: 'pairs' },
  { book: 'B-CHALDEAN', section: /^3\.14 /, set: 'maturity' },
  { book: 'B-CHALDEAN', section: /^3\.20 /, set: 'name' },
  { book: 'B-CHALDEAN', section: /^3\.22 /, set: 'first-letter' },
  { book: 'B-NAMENUM', section: /^3\.[1-9] /, set: 'name' },
  { book: 'B-NAMENUM', section: /^3\.12 /, set: 'name' },
  { book: 'B-NUMNAME', section: /^3\.2 /, set: 'name' },
  { book: 'B-NUMNAME', section: /^3\.6 /, set: 'karmic' },
  { book: 'B-LOSHU', section: /^3\.2 /, set: 'planes' },
  { book: 'B-LOSHU', section: /^3\.3 /, set: 'present' },
  { book: 'B-LOSHU', section: /^3\.4 /, set: 'repeats' },
  { book: 'B-WATCH', section: /^3\.(1|3|4|5|6|7|8|9|10|11|12|13|14|15|17) /, set: 'watch' }
];

// The owner's four limits (10 Oct 2026). Warnings about health, accidents, money, legal trouble stay as care points.
const LIMITS = [
  ['cure claim', /\b(cure[sd]?|curing|cures? (?:of|for)|heal(?:s|ed)? (?:the )?(?:disease|illness|cancer))\b/i],
  ['death prediction', /\b(death|die[sd]?|dying|dead|killer|kill(?:s|ed|ing)?|fatal|untimely end|assassinat\w*|suicid\w*)\b/i],
  ['crime accusation', /\b(crim(?:e|es|inal|inals)|prison|jail|murder\w*|thie(?:f|ves)|theft|trickster|fraud\w*|swindl\w*|smuggl\w*)\b/i],
  ['guaranteed wealth', /\b(guarantee[ds]?|never fail\w*|sure to (?:be|become|get|earn)|certainly (?:rich|wealthy)|millionaire|billionaire|crorepati|unlimited wealth)\b/i]
];

const norm = s => String(s).normalize('NFKC').toLowerCase()
  .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-').replace(/\*+/g, '')
  .replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim();
const texts = {};
const bookText = b => (texts[b] ??= norm(readFileSync(join(textDir, BOOKS[b].text), 'utf8')));

function quoteFound(book, quote) {
  const q = String(quote || '').replace(/^"+|"+$/g, '').replace(/\\"/g, '"').replace(/\s*\(sic\)\s*/gi, ' ');
  const frags = q.split(/\s*(?:\.\.\.|…|" \/ "|"; "|" \+ ")\s*/).map(f => norm(f.replace(/^"|"$/g, ''))).filter(f => f.length > 3);
  if (!frags.length) return false;
  const t = bookText(book);
  return frags.every(f => t.includes(f) || t.includes(f.replace(/"/g, '')));
}

const col = (r, ...names) => { for (const n of names) for (const k of Object.keys(r)) if (k.startsWith(n)) return r[k]; return ''; };
const pages = s => (String(s).match(/\d+/g) || []).map(Number);

// Dates and months in a condition are when the effect happens, not when it is shown: they move to `period`.
function splitPeriod(when) {
  if (!when) return { when, period: null };
  const parts = when.all ? when.all : [when];
  const period = parts.find(p => p.month || p.dateIn) || null;
  const rest = parts.filter(p => !(p.month || p.dateIn));
  return { when: rest.length === 0 ? null : rest.length === 1 ? rest[0] : { all: rest }, period };
}

const rules = [];
const counters = {};
for (const plan of PLAN) {
  const rows = parseNotes(join(notesDir, BOOKS[plan.book].notes)).filter(r => plan.section.test(r.section));
  for (const r of rows) {
    const condition = col(r, 'condition');
    const text = col(r, 'meaning or advice', 'meaning (keyword)', 'meaning');
    if (!condition || !text) continue;
    if (plan.skip && plan.skip(r)) continue;
    const quote = col(r, 'short quote').replace(/^"|"$/g, '');
    const verdict = (r.v || '').trim();
    const key = `${plan.book}-${plan.set}`;
    counters[key] = (counters[key] ?? 0) + 1;
    const id = r.id ? `${plan.book.slice(2)}-${r.id}` : `${plan.book.slice(2)}-${plan.set.toUpperCase()}-${String(counters[key]).padStart(3, '0')}`;
    const mapped = plan.book === 'B-WATCH' ? WATCH_MAP[r.id] : null;
    const { when, period } = plan.book === 'B-WATCH' ? { when: mapped?.when ?? null, period: null } : splitPeriod(parseCondition(condition));
    const limit = LIMITS.find(([, re]) => re.test(text) || re.test(quote));
    const found = quoteFound(plan.book, quote);
    let status = 'approved', reason = '';
    if (limit) { status = 'dropped'; reason = `outside the limits: ${limit[0]}`; }
    else if (verdict === 'S') { status = 'dropped'; reason = 'the reader marked it SKIP'; }
    else if (!when) { status = 'review'; reason = 'condition needs a person (partner, gender, profession, wording) or is not computable'; }
    else if (!found) { status = 'review'; reason = 'quote not found word for word in the book text'; }
    else if (verdict === 'M' && !mapped?.approve) { status = 'review'; reason = 'the reader marked it MAYBE'; }
    rules.push({
      id, set: plan.set, ...(mapped?.kind ? { kind: mapped.kind } : {}), when, period, text: text.trim(), polarity: (r.polarity || 'neutral').trim(),
      areas: col(r, 'life areas').split(/,\s*/).filter(Boolean),
      source: { book: plan.book, pages: pages(r.page), quote, quoteFound: found, rank: BOOKS[plan.book].rank },
      condition, status, ...(reason ? { reason } : {})
    });
  }
}

// One file per set, ids unique.
const ids = new Set();
for (const r of rules) { if (ids.has(r.id)) throw new Error(`duplicate id ${r.id}`); ids.add(r.id); }
mkdirSync(join(root, 'rules'), { recursive: true });
const sets = [...new Set(rules.map(r => r.set))];
for (const s of sets) {
  writeFileSync(join(root, 'rules', `${s}.json`), JSON.stringify({ set: s, rules: rules.filter(r => r.set === s) }, null, 1) + '\n');
}
const sum = st => rules.filter(r => r.status === st).length;
const lines = ['# Rules waiting for the owner', '', `Built from the book notes: ${rules.length} rules, ${sum('approved')} approved, ${sum('review')} waiting for you, ${sum('dropped')} dropped.`, ''];
for (const s of sets) {
  const rs = rules.filter(r => r.set === s);
  lines.push(`## ${s}: ${rs.filter(r => r.status === 'approved').length} approved, ${rs.filter(r => r.status === 'review').length} to review, ${rs.filter(r => r.status === 'dropped').length} dropped`, '');
  for (const r of rs.filter(r => r.status !== 'approved')) lines.push(`- **${r.id}** (${r.status}: ${r.reason}) — when ${r.condition}: ${r.text}`);
  lines.push('');
}
writeFileSync(join(root, 'rules', 'REVIEW.md'), lines.join('\n'));
console.log(`${rules.length} rules: ${sum('approved')} approved, ${sum('review')} review, ${sum('dropped')} dropped`);
for (const s of sets) {
  const rs = rules.filter(r => r.set === s);
  console.log(`  ${s.padEnd(13)} ${String(rs.length).padStart(4)}  approved ${rs.filter(r => r.status === 'approved').length}, review ${rs.filter(r => r.status === 'review').length}, dropped ${rs.filter(r => r.status === 'dropped').length}`);
}
