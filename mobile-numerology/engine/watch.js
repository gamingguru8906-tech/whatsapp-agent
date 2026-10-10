// Wristwatch Numerology segment: the person's watch and numbers, on one screen. Deterministic, no AI.
// The watch lines come from the brain (approved watch rules); the "right watch for your year" comes from the
// personal-year transcript rules (T03) already in the rulebook; the bracelet is Veshannastro's own.

import { brainReading } from '../../brain/read.js';
import { cleanWatch } from '../../brain/watch.js';
import { braceletFor, BRACELET_SHOP } from '../../brain/calc.js';
import { parseDob, normaliseMobile, personalYear, birthNumber } from './core.js';

const METAL = ['gold', 'roseGold', 'silver', 'steel', 'twoTone', 'black'];

// The watch each personal year names (T03, approved), as conditions on case metal and dial colour.
// parts: each part is one thing the source names; a watch that meets every part matches, some parts = partly.
export const YEAR_WATCH = {
  1: { id: 'PY1-T03-f', parts: [{ caseMetal: ['gold'] }] },
  2: { id: 'PY2-T03-g', parts: [{ caseMetal: ['silver'] }, { dialColour: ['white', 'blue'] }] },
  3: { id: 'PY3-T03-f', parts: [{ caseMetal: ['gold', 'twoTone'] }] },
  4: { id: 'PY4-T03-f', parts: [{ caseMetal: ['steel'] }, { dialColour: ['blue'] }] },
  5: { id: 'PY5-T03-i', parts: [{ caseMetal: METAL }, { dialColour: ['green'] }] },
  6: { id: 'PY6-T03-h', parts: [{ caseMetal: METAL }, { dialColour: ['green'] }], or: [{ caseMetal: ['twoTone'] }] },
  7: { id: 'PY7-T03-i', parts: [{ caseMetal: ['gold', 'silver', 'twoTone'] }] },
  8: { id: 'PY8-T03-f', parts: [{ caseMetal: ['silver'] }, { dialColour: ['white', 'blue'] }] },
  9: { id: 'PY9-T03-g', parts: [{ caseMetal: ['gold'] }, { dialColour: ['gold'] }] }
};

const meets = (w, part) => Object.entries(part).every(([k, vs]) => w[k] !== undefined && vs.includes(w[k]));
const known = (w, part) => Object.keys(part).every(k => w[k] !== undefined);

// full / partly / different, or unknown when the person did not say the metal or dial colour.
export function yearMatch(watch, py) {
  const y = YEAR_WATCH[py];
  if (!y) return null;
  if (y.or && y.or.every(p => meets(watch, p))) return 'full';
  if (!y.parts.every(p => known(watch, p))) return 'unknown';
  const n = y.parts.filter(p => meets(watch, p)).length;
  return n === y.parts.length ? 'full' : n > 0 ? 'partly' : 'different';
}

export function watchReading(rulebook, input) {
  const errors = {};
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) errors.name = 'Please enter your name.';
  const mob = normaliseMobile(input.mobile);
  if (!mob.ok) errors.mobile = mob.error;
  const dob = parseDob(input.dob, input.today ?? new Date());
  if (!dob.ok) errors.dob = dob.error;
  const watch = cleanWatch(input.watch);
  if (!watch.dialColour && !watch.dialShape) errors.watch = 'Please pick at least the dial colour and shape.';
  const year = input.year;
  if (!Number.isInteger(year)) errors.year = 'year is required';
  if (Object.keys(errors).length) return { ok: false, errors };

  const brain = brainReading({ dob: dob.value, name, year, today: input.today ?? new Date(), watch, owner: true });
  const py = personalYear(dob.value, year);
  const pyNext = personalYear(dob.value, year + 1);
  const pyItems = new Map(Object.values(rulebook.personalYear.years).flat().map(i => [i.id, i]));
  const yearWatch = [[year, py], [year + 1, pyNext]].map(([y, n]) => {
    const r = pyItems.get(YEAR_WATCH[n]?.id);
    return r ? { year: y, personalYear: n, id: r.id, text: r.text, match: yearMatch(watch, n),
      source: { file: rulebook.personalYear.sources?.[r.src] ?? r.src, quote: r.quote } } : null;
  }).filter(Boolean);

  const items = brain.watch.groups.flatMap(g => g.items);
  const count = p => items.filter(i => i.polarity === p).length;
  const b = birthNumber(dob.value);
  const bracelet = braceletFor(b);
  const sections = [
    { id: 'watch-answer', strengths: count('good'), care: count('care'), mixed: count('mixed'), total: items.length,
      thisYear: yearWatch[0] ?? null },
    { id: 'brain', ...brain },
    { id: 'year-watch', items: yearWatch },
    { id: 'bracelet', birthNumber: b, bracelet: bracelet ? { ...bracelet, url: BRACELET_SHOP } : null }
  ];
  return { ok: true, segment: 'watch', input: { name, mobile: mob.value, dob: dob.value.iso, watch, year }, sections };
}

// Plain-text summary saved with the lead so Kamala can talk about this exact watch reading on WhatsApp.
export function watchSummary(result) {
  if (!result?.ok) return '';
  const s = Object.fromEntries(result.sections.map(x => [x.id, x]));
  const b = s.brain, out = [];
  out.push(`Wristwatch reading. Date of birth ${result.input.dob}. Birth number ${b.numbers.psychic.value}, destiny ${b.numbers.destiny.value}.`);
  out.push(`Watch details given: ${b.watch.groups.map(g => `${g.label.replace(/\?$/, '')}: ${g.valueLabel}`).join('; ')}.`);
  for (const y of s['year-watch'].items) out.push(`Watch named for ${y.year} (personal year ${y.personalYear}): ${y.text} Their watch: ${y.match}.`);
  out.push('What their watch says (shown to them):');
  for (const g of b.watch.groups) for (const i of g.items) out.push(`- ${g.valueLabel}: ${i.say}`);
  for (const t of b.watch.therapy) out.push(`- Advice shown: ${t.say}`);
  if (s.bracelet.bracelet) out.push(`Bracelet suggested: ${s.bracelet.bracelet.name}.`);
  const text = out.join('\n');
  return text.length > 3800 ? `${text.slice(0, 3797).replace(/\n[^\n]*$/, '')}\n...` : text;
}

// A short description of the watch for the lead's "concern" column (and its duplicate check).
export function watchConcern(result) {
  const w = result.input.watch;
  return `Wristwatch: ${Object.entries(w).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(', ')}`.slice(0, 300);
}
