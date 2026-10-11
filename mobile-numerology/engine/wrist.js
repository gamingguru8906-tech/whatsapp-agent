// "Which watch should I wear this year?" — from a photo of the wrist and the birth date.
// Two parts, kept apart so each stays honest:
//  - The year (numerology): the watch named for the person's personal year (rules PY*-T03, approved). It decides the
//    case metal and the dial colour.
//  - The fit (from the photo): wrist size, skin undertone and dress style. They decide the dial size, strap width and
//    strap, and choose between metals only when the year allows more than one. The watch rules on dial size, strap
//    width, strap material and thickness (WATCH-DS/BS/BM/TH) set the direction: a dial that fills the wrist without
//    straining, a strap that is not narrow, a case that is not ultra-thin, no resin strap.
// Deterministic: same input, same answer. The vision model only describes the wrist; it never writes the answer.

import { brainReading } from '../../brain/read.js';
import { braceletFor, BRACELET_SHOP } from '../../brain/calc.js';
import { parseDob, normaliseMobile, personalYear, birthNumber } from './core.js';
import { YEAR_WATCH } from './watch.js';

export const WRIST = {
  size: { q: 'Wrist size', options: { slim: 'Slim', medium: 'Medium', broad: 'Broad' } },
  undertone: { q: 'Skin undertone', options: { warm: 'Warm', cool: 'Cool', neutral: 'Neutral' } },
  style: { q: 'Your usual style', options: { formal: 'Formal', casual: 'Casual', sporty: 'Sporty', traditional: 'Traditional' } }
};

export function cleanWrist(input = {}) {
  const out = {};
  for (const [k, a] of Object.entries(WRIST)) if (typeof input?.[k] === 'string' && input[k] in a.options) out[k] = input[k];
  return out;
}

// ---------- Reading the wrist photo ----------
export function wristSchema() {
  const props = { isWrist: { type: 'boolean' } };
  for (const [k, a] of Object.entries(WRIST)) props[k] = { type: 'string', enum: [...Object.keys(a.options), 'unsure'] };
  return { type: 'object', properties: props, required: ['isWrist', ...Object.keys(WRIST)] };
}

export function wristPrompt() {
  return [
    'You look at a photo of a person\'s wrist to help them choose a wristwatch. Answer with JSON only, using exactly these keys and only the listed codes.',
    'Use "unsure" whenever you cannot clearly tell. Do not guess. A wrong answer is worse than "unsure".',
    'Set isWrist to false if the photo does not show a human wrist or forearm.',
    '- size: slim, medium or broad. Judge the wrist width against the hand and fingers in the photo (slim = narrow, bony wrist; broad = thick, wide wrist).',
    '- undertone: warm, cool or neutral. The undertone of the skin (warm = golden/peachy/olive; cool = pinkish/bluish; neutral = a mix). Ignore how light or dark the skin is; judge only the undertone. Use "unsure" if the lighting is coloured or too dim.',
    '- style: formal, casual, sporty or traditional, from the sleeve, clothes and accessories visible. "unsure" if none are visible.'
  ].join('\n');
}

export function parseWristReply(reply) {
  let data = reply;
  if (typeof reply === 'string') {
    const m = reply.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: 'unreadable' };
    try { data = JSON.parse(m[0]); } catch { return { ok: false, error: 'unreadable' }; }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'unreadable' };
  if (data.isWrist === false) return { ok: false, error: 'not-a-wrist' };
  const wrist = cleanWrist(data);
  return { ok: true, wrist, filled: Object.keys(wrist) };
}

export async function readWristPhoto(ai, model, dataUrl) {
  const res = await ai.run(model, {
    messages: [
      { role: 'system', content: wristPrompt() },
      { role: 'user', content: [
        { type: 'text', text: 'Describe this wrist for choosing a watch. JSON only.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ] }
    ],
    response_format: { type: 'json_schema', json_schema: wristSchema() },
    temperature: 0,
    max_tokens: 200
  });
  return parseWristReply(res?.response ?? res?.choices?.[0]?.message?.content ?? res);
}

// ---------- The recommendation ----------
const METAL = { gold: 'gold', roseGold: 'rose-gold', silver: 'silver', steel: 'steel', twoTone: 'gold-and-silver (two-tone)', black: 'black' };
const COLOUR = { white: 'white', blue: 'blue', green: 'green', gold: 'gold', yellow: 'yellow' };

// Dial width that fills each wrist without straining (WATCH-DS-4 large = confident; DS-6/DS-7 not straining or
// hanging over), and a strap that is not narrow for it (WATCH-BS-1 wide = commitment; BS-3/BS-4 narrow = care).
const FIT = {
  slim: { dial: '38 to 40 mm', strap: '18 to 20 mm' },
  medium: { dial: '40 to 42 mm', strap: '20 to 22 mm' },
  broad: { dial: '42 to 44 mm', strap: '22 to 24 mm' }
};

// When the year allows more than one metal, the undertone chooses: warm skin suits yellow and rose gold, cool skin
// suits silver and steel, neutral suits either (two-tone first).
const BY_UNDERTONE = {
  warm: ['gold', 'roseGold', 'twoTone', 'silver', 'steel'],
  cool: ['silver', 'steel', 'twoTone', 'gold', 'roseGold'],
  neutral: ['twoTone', 'gold', 'silver', 'steel', 'roseGold']
};

function chooseMetal(allowed, undertone) {
  const order = BY_UNDERTONE[undertone] ?? BY_UNDERTONE.neutral;
  return order.find(m => allowed.includes(m)) ?? allowed[0];
}

// Strap: the "metal watch" years ask for a metal bracelet; otherwise the style chooses, among straps the watch rules
// read well (leather BM-3, silicone BM-12, metal BM-1), never resin (BM-10) or an open, gapped bracelet (BX-2).
function chooseStrap(py, style, undertone) {
  if ([5, 6, 7].includes(py)) return { material: 'metal', text: 'a solid metal bracelet' };
  const leather = undertone === 'warm' ? 'brown leather' : undertone === 'cool' ? 'black leather' : 'brown or black leather';
  if (style === 'sporty') return { material: 'silicone', text: 'a silicone strap' };
  if (style === 'formal') return { material: 'leather', text: `${leather} or a solid metal bracelet` };
  return { material: 'leather', text: leather };
}

export function yearWatchChoice(py, wrist = {}) {
  const y = YEAR_WATCH[py];
  if (!y) return null;
  const metals = y.parts.find(p => p.caseMetal)?.caseMetal ?? [];
  const colours = y.parts.find(p => p.dialColour)?.dialColour ?? [];
  const metal = metals.length > 1 ? chooseMetal(y.or ? [...new Set([...metals, 'twoTone'])] : metals, wrist.undertone) : metals[0];
  return { metal, metals, colours, chosenBy: metals.length > 1 && wrist.undertone ? 'undertone' : 'year' };
}

export function wristRecommendation(rulebook, input) {
  const errors = {};
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) errors.name = 'Please enter your name.';
  const mob = normaliseMobile(input.mobile);
  if (!mob.ok) errors.mobile = mob.error;
  const dob = parseDob(input.dob, input.today ?? new Date());
  if (!dob.ok) errors.dob = dob.error;
  const year = input.year;
  if (!Number.isInteger(year)) errors.year = 'year is required';
  if (Object.keys(errors).length) return { ok: false, errors };

  const wrist = cleanWrist(input.wrist);
  const py = personalYear(dob.value, year);
  const pyItems = new Map(Object.values(rulebook.personalYear.years).flat().map(i => [i.id, i]));
  const rule = pyItems.get(YEAR_WATCH[py]?.id);
  const choice = yearWatchChoice(py, wrist);
  const fit = FIT[wrist.size] ?? null;
  const strap = chooseStrap(py, wrist.style, wrist.undertone);

  // The one-line answer.
  // Personal year 7 names white gold; "silver" stands for it in the form's choices.
  const metalName = m => (py === 7 && m === 'silver' ? 'white-gold or silver-toned' : METAL[m]);
  const metalWords = choice.metal ? `${/^[aeiou]/.test(metalName(choice.metal)) ? 'An' : 'A'} ${metalName(choice.metal)} watch` : 'A watch';
  const dial = choice.colours.length ? ` with a ${choice.colours.map(c => COLOUR[c] ?? c).join(' or ')} dial` : '';
  const answer = `${metalWords}${dial}${fit ? `, ${fit.dial} across` : ''}, on ${strap.text}.`;

  // Why, line by line (owner view shows where each comes from).
  const why = [
    { id: rule.id, kind: 'year', text: `For your personal year ${py} (${year}): ${rule.text.split('. ')[0].replace(/\.$/, '')}.` },
    choice.chosenBy === 'undertone' && { id: 'FIT-METAL', kind: 'fit', text: `Your year allows ${choice.metals.filter(m => m !== 'black').map(metalName).join(', ')}; ${metalName(choice.metal)} suits your ${wrist.undertone} skin undertone best.` },
    fit && { id: 'WATCH-DS-4', kind: 'fit', text: `For a ${WRIST.size.options[wrist.size].toLowerCase()} wrist, ${fit.dial} fills the wrist without hanging over it. A dial that sits large but natural is linked with confidence; one too big for the wrist is not.` },
    fit && { id: 'WATCH-BS-1', kind: 'fit', text: `A strap of ${fit.strap} keeps it in proportion. A wider strap is linked with bigger commitments; a very narrow one is best avoided.` },
    { id: 'WATCH-TH-2', kind: 'fit', text: 'Choose a regular or solid case rather than an ultra-thin one: a thicker case is linked with more effort in work and relationships.' }
  ].filter(Boolean);

  const next = pyItems.get(YEAR_WATCH[personalYear(dob.value, year + 1)]?.id);
  const brain = brainReading({ dob: dob.value, name, year, today: input.today ?? new Date(), owner: true });
  // "Does this sound like you?": the first lines the books give for the birth number (strengths and mixed points).
  const profile = brain.numbers.psychic.items.filter(i => i.polarity !== 'care').slice(0, 2);
  const b = birthNumber(dob.value);
  const bracelet = braceletFor(b);

  return {
    ok: true, segment: 'wrist',
    input: { name, mobile: mob.value, dob: dob.value.iso, wrist, year },
    sections: [
      { id: 'wrist-answer', year, personalYear: py, answer, watch: { metal: choice.metal, colours: choice.colours, dial: fit?.dial ?? null, strap: strap.material },
        why, ruleText: rule.text },
      { id: 'next-year', year: year + 1, personalYear: personalYear(dob.value, year + 1), text: next?.text ?? null },
      { id: 'profile', birthNumber: b, items: profile },
      { id: 'bracelet', birthNumber: b, bracelet: bracelet ? { ...bracelet, url: BRACELET_SHOP } : null }
    ]
  };
}

export function wristSummary(result) {
  if (!result?.ok) return '';
  const s = Object.fromEntries(result.sections.map(x => [x.id, x]));
  const w = result.input.wrist;
  return [
    `Watch for the year (wrist photo). Date of birth ${result.input.dob}. Personal year ${s['wrist-answer'].personalYear} in ${s['wrist-answer'].year}.`,
    `Wrist: ${Object.entries(w).map(([k, v]) => `${WRIST[k].q.toLowerCase()} ${v}`).join(', ') || 'not given'}.`,
    `Answer shown: ${s['wrist-answer'].answer}`,
    `Year rule: ${s['wrist-answer'].ruleText}`,
    s['next-year'].text ? `Next year (${s['next-year'].year}, personal year ${s['next-year'].personalYear}): ${s['next-year'].text}` : '',
    s.bracelet.bracelet ? `Bracelet suggested: ${s.bracelet.bracelet.name}.` : ''
  ].filter(Boolean).join('\n');
}

export const wristConcern = result =>
  `Watch for the year: ${Object.entries(result.input.wrist).map(([k, v]) => `${k}=${v}`).join(', ') || 'no photo details'}`.slice(0, 300);
