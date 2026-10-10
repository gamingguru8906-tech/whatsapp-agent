// A short plain-text summary of a reading, saved with the lead in Kamala's database (numerology_leads.reading_summary)
// so that Kamala can answer the same person on WhatsApp. Built only from the reading itself: every line is the
// rulebook's own wording (rule titles and story text), nothing is added or rephrased. Deterministic.

import { clarity } from './clarity.js';

const MAX_CHARS = 3800; // most important first, so a cut only ever drops the last lines

const kindLabel = item => (item.kind === 'shotgun' ? `pair ${item.title}` : item.kind === 'yoga' ? `${item.title} yoga` : item.title);
const goodText = item => item.good || '';
const careText = item => item.care || item.text || '';

function line(item, mode) {
  const text = mode === 'good' ? goodText(item) : mode === 'care' ? careText(item)
    : [item.good, item.care].filter(Boolean).join(' Care: ');
  return text ? `- ${kindLabel(item)}: ${text}` : null;
}

const take = (items, n, mode) => items.map(i => line(i, mode)).filter(Boolean).slice(0, n);

/** reading: the engine result (public view is enough). Returns the summary text, at most MAX_CHARS long, most important first. */
export function readingSummary(reading) {
  if (!reading?.ok) return '';
  const s = Object.fromEntries((reading.sections || []).map(x => [x.id, x]));
  const out = [];
  const input = reading.input || {};
  out.push(`Mobile number read: ${input.mobile} (zeros skipped). Date of birth: ${input.dob}.`);
  // The plain answer the page showed first (page wording built from the counts below, see engine/clarity.js).
  const a = clarity(reading);
  if (a) {
    out.push(`Plain answer shown to them: ${a.headline} ${a.why}`);
    out.push(`Next steps shown to them: ${a.steps.map((st, i) => `${i + 1}) ${st.title}: ${st.text}`).join(' ')}`);
    if (a.notFor?.uses.length) out.push(`Told not to use this number for: ${a.notFor.uses.join('; ')}.`);
    if (a.notFor?.others.length) out.push(`Also shown: ${a.notFor.othersText}`);
  }

  const concern = s.concern;
  if (concern) {
    out.push(`Their concern, in their words: "${String(concern.text || input.concern || '').slice(0, 200)}"`);
    if (concern.items?.length) {
      out.push(`What the reading showed for this concern (life areas: ${(concern.areas || []).join(', ')}):`);
      out.push(...take(concern.items, 5, 'both'));
    } else {
      out.push('Nothing in their number or birth date speaks directly to this concern; the full reading was shown instead.');
    }
  }

  for (const c of s.compare?.comparisons || []) {
    const l = c.lists || {};
    const n = k => (l[k] || []).length;
    out.push(`Planned number ${c.planned} compared with their current number: problems removed ${n('problemsRemoved')}, new problems ${n('problemsAdded')}, problems that stay ${n('problemsStay')}, strengths gained ${n('strengthsGained')}, strengths lost ${n('strengthsLost')}.`);
  }

  const kept = s['if-kept']?.items || [];
  if (kept.length) {
    out.push(`If they keep this number (${kept.length} points that need care):`);
    out.push(...kept.slice(0, 5).map(i => `- ${kindLabel(i)}: ${i.text}`));
  }

  const mobilePairs = s.decoded?.pairs || [];
  const mobileYogas = s['mobile-grid']?.yogas || [];
  const strengths = [...mobilePairs, ...mobileYogas].filter(i => i.polarity === 'positive' || i.polarity === 'mixed');
  if (strengths.length) {
    out.push('Strengths in their mobile number:');
    out.push(...take(strengths, 3, 'good'));
  }

  const dobYogas = s['dob-grid']?.yogas || [];
  if (dobYogas.length) out.push(`Yogas in their birth date: ${dobYogas.slice(0, 6).map(y => y.title).join('; ')}.`);

  const years = s['year-ahead']?.years || [];
  if (years.length) out.push(`Personal year: ${years.map(y => `${y.year} = ${y.number}`).join(', ')}.`);
  if (s.name?.number) out.push(`Name number (Chaldean): ${s.name.number}.`);

  const p = s.protection;
  if (p) {
    const parts = [`birth number ${p.birthNumber}`, `destiny number ${p.destinyNumber}`];
    if (p.bracelet) parts.push(`bracelet: ${p.bracelet}`);
    if (p.mani) parts.push(`mani: ${p.mani}`);
    out.push(`Protection shown: ${parts.join('; ')}.`);
    if (p.screenSaver?.length) out.push(`Screen saver shown: ${p.screenSaver[0]}`);
    for (const r of (p.yogaRemedies || []).slice(0, 3)) out.push(`- Remedy for ${r.title}: ${r.text}`);
  }

  const careers = s.career?.professions || [];
  if (careers.length) out.push(`Career fields linked with their number: ${careers.slice(0, 6).map(c => c.title).join(', ')}.`);


  let text = out.join('\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 3).replace(/\n[^\n]*$/, '')}\n...`;
  return text;
}
