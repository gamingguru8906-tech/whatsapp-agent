// "Your answer": the reading turned into one plain verdict and three next steps, for people who do not read
// numerology. Deterministic and honest: it only counts and names what the reading already contains (no new
// meanings, no lucky numbers). The words are the page's own; the facts are the rulebook's.
//
//   against  - more points about their concern need care than help        -> change the number
//   mixed    - as many help as need care                                   -> change the number
//   supports - more help than need care                                    -> keep the number
//   care     - no rule speaks to their concern; more of the number needs care than helps -> change
//   even     - no rule speaks to their concern; as much helps as needs care  -> change
//   good     - no rule speaks to their concern; more of the number helps    -> keep

const AREA_PHRASE = {
  money: 'your money', career: 'your career', relationship: 'your love life and marriage', family: 'your family',
  health: 'your health', mind: 'your peace of mind', education: 'your studies', legal: 'your court and legal matters',
  government: 'your government work', travel: 'your travel', home: 'your home', spiritual: 'your spiritual life'
};

const needsCare = x => x.polarity === 'negative' || x.polarity === 'mixed';
const helps = x => x.polarity === 'positive' || x.polarity === 'mixed';
const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const list = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function clarity(reading) {
  if (!reading?.ok) return null;
  const s = Object.fromEntries((reading.sections || []).map(x => [x.id, x]));
  const concern = s.concern || { items: [], areas: [] };
  const mobileItems = [...(s.decoded?.pairs || []), ...(s['mobile-grid']?.yogas || [])];
  const strengths = mobileItems.filter(x => x.good).length;
  const carePoints = (s['if-kept']?.items || []).length;
  const area = concern.areas?.length === 1 ? AREA_PHRASE[concern.areas[0]] || 'what you shared' : 'what you shared';

  const items = concern.items || [];
  const care = items.filter(needsCare);
  const good = items.filter(helps);
  const mobileCare = care.filter(x => !x.fromDob);
  const dobCare = care.filter(x => x.fromDob);

  // The verdict weighs points that only need care against points that only help (a mixed point does both).
  const neg = items.filter(x => x.polarity === 'negative').length;
  const pos = items.filter(x => x.polarity === 'positive').length;
  let tone;
  if (care.length || good.length) tone = neg > pos ? 'against' : pos > neg ? 'supports' : 'mixed';
  else tone = carePoints > strengths ? 'care' : strengths > carePoints ? 'good' : 'even';
  const change = tone !== 'supports' && tone !== 'good';

  const headline = {
    against: `Your number is working against ${area}.`,
    mixed: `Your number is pulling both ways on ${area}.`,
    supports: `Your number supports ${area}.`,
    care: 'Your number needs care in more places than it helps.',
    good: 'Your number has more strengths than weak spots.',
    even: 'Your number is evenly split between strengths and weak spots.'
  }[tone];

  let why;
  if (tone === 'against' || tone === 'mixed') {
    why = tone === 'against'
      ? `${n(items.length, 'part of your reading touches', 'parts of your reading touch')} ${area}, and ${care.length === items.length ? (items.length === 1 ? 'it needs' : 'all of them need') : `${care.length} of them need`} care.`
      : `${n(items.length, 'part of your reading touches', 'parts of your reading touch')} ${area}, and ${items.length === 1 ? 'it pulls' : 'they pull'} both ways.`;
    if (mobileCare.length) {
      why += mobileCare.length === care.length
        ? ` ${care.length === 1 ? 'It comes' : 'They come'} from your mobile number, so a new number can remove ${care.length === 1 ? 'it' : 'them'}.`
        : ` ${mobileCare.length} of them ${mobileCare.length === 1 ? 'comes' : 'come'} from your mobile number, so a new number can remove ${mobileCare.length === 1 ? 'it' : 'them'}.`;
    }
    if (dobCare.length) why += ` ${n(dobCare.length, 'comes', 'come')} from your birth date and ${dobCare.length === 1 ? 'stays' : 'stay'}; your protection helps with ${dobCare.length === 1 ? 'it' : 'those'}.`;
  } else if (tone === 'supports') {
    why = `${n(items.length, 'part of your reading touches', 'parts of your reading touch')} ${area}, and `
      + `${good.length === items.length ? (items.length === 1 ? 'it helps' : 'all of them help') : `${good.length} of them help`}. Keep it working for you with your protection.`;
  } else {
    const h = strengths === 0 ? 'nothing in your number helps' : `${n(strengths, 'part of your number helps', 'parts of your number help')}`;
    const c = carePoints === 0 ? 'nothing needs care' : `${n(carePoints, 'point needs', 'points need')} care`;
    why = `${h.charAt(0).toUpperCase()}${h.slice(1)}, and ${c}.`;
    if (change && carePoints) why += ` ${carePoints === 1 ? 'It comes' : 'They come'} from your mobile number, so a new number can remove ${carePoints === 1 ? 'it' : 'them'}.`;
  }

  // Step 1: protection they can start today (birth-number remedies from the rulebook).
  const p = s.protection || {};
  const doNow = [
    p.screenSaver?.length ? 'set the phone screen saver shown for you' : null,
    p.bracelet ? `wear the ${p.bracelet}` : null,
    p.mani ? `keep ${p.mani}` : null
  ].filter(Boolean);
  const steps = [];
  if (doNow.length) {
    const t = list(doNow);
    steps.push({ id: 'protect', title: 'Start your protection today', text: `${t.charAt(0).toUpperCase()}${t.slice(1)}.`, jump: 'protection' });
  }

  // Step 2: change or keep the number. "Avoid" names the number's own patterns that need care, about their
  // concern first; "look for" names patterns from the rulebook's good list that their number does not have yet.
  if (change) {
    const fromConcern = mobileCare.map(x => x.title);
    const fromNumber = (s['if-kept']?.items || []).map(x => x.title);
    const avoid = [...new Set([...fromConcern, ...fromNumber])].slice(0, 3);
    const lookFor = (s['better-number']?.lookFor || []).filter(x => !x.have).map(x => x.title).slice(0, 2);
    steps.push({
      id: 'change', title: 'Choose a better number',
      text: avoid.length
        ? `Pick a number without ${list(avoid)}${lookFor.length ? `, and look for ${list(lookFor)}` : ''}. Check it here before you buy it.`
        : `${lookFor.length ? `Look for ${list(lookFor)} in a new number. ` : ''}Check any new number here before you buy it.`,
      avoid, lookFor, action: 'compare'
    });
  } else {
    steps.push({ id: 'keep', title: 'Keep your number', text: 'It is working for you. If you ever switch, check the new number here first.', action: 'compare' });
  }

  // Step 3: the consultation (choosing a number for their birth date is what it offers).
  steps.push(change
    ? { id: 'consult', title: 'Get a number chosen for your birth date', text: 'In a consultation, we choose a new number that removes these and suits your birth date. Your reading comes with you on WhatsApp.', action: 'whatsapp' }
    : { id: 'consult', title: 'Make the most of it', text: 'Ask us how to strengthen what your number already gives you. Your reading comes with you on WhatsApp.', action: 'whatsapp' });

  return { tone, change, area, headline, why, strengths, carePoints, steps };
}
