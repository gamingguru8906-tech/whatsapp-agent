// The brain's reading: everything the books say about a person (birth date, name, Lo Shu grid, timing) and, for the
// watch segment, about their watch. Both segments call this and show the same words for the same facts.
// Deterministic: same input, same output. Only approved rules with visitor wording are used.

import * as c from './calc.js';
import { personFacts, matchRules } from './match.js';
import { RULES } from './rules/index.js';
import { WATCH_ATTRIBUTES } from './watch.js';

const APPROVED = RULES.filter(r => r.status === 'approved' && r.say);
const bySet = set => APPROVED.filter(r => r.set === set);
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// What a visitor sees for one rule; the owner view adds where it came from.
const item = (r, owner) => ({
  id: r.id, say: r.say, polarity: r.polarity, areas: r.areas,
  ...(owner ? { source: { book: r.source.book, pages: r.source.pages, quote: r.source.quote } } : {})
});

// A timing rule's period in words, and whether `today` falls inside it.
function periodOf(p, today) {
  const m = today.getUTCMonth() + 1, d = today.getUTCDate();
  const md = m * 100 + d;
  if (p.month) {
    return { label: p.month.map(x => MONTH[x - 1]).join(', '), now: p.month.includes(m) };
  }
  if (p.dateIn) {
    const now = p.dateIn.some(([[m1, d1], [m2, d2]]) => {
      const a = m1 * 100 + d1, b = m2 * 100 + d2;
      return a <= b ? md >= a && md <= b : md >= a || md <= b; // ranges may wrap the year end
    });
    const label = p.dateIn.map(([[m1, d1], [m2, d2]]) => `${d1} ${MONTH[m1 - 1]} to ${d2} ${MONTH[m2 - 1]}`).join(' and ');
    return { label, now };
  }
  return null;
}

// The number relation, in words a visitor understands.
const DIGIT_OF = new Map(APPROVED.filter(r => ['repeats', 'present'].includes(r.set))
  .map(r => [r.id, r.when?.repeat?.digit ?? (r.when?.has?.length === 1 ? r.when.has[0] : null)]));
const digitOf = id => DIGIT_OF.get(id) ?? null;
// "With 1 appearing twice in your birth date, you tend to ..." -> "You tend to ..." (the digit is the heading).
function shorten(say) {
  const t = say.replace(/^With \d+ (appearing [a-z ]+ |[a-z]+ times )?in your birth date, /, '');
  if (t === say) return say;
  return /^this /.test(t) ? `This number ${t.slice(5).replace(/^number /, '')}` : t.charAt(0).toUpperCase() + t.slice(1);
}

const REL = { friend: 'friendly', neutral: 'neutral', enemy: 'unfriendly', mixed: 'mixed' };

export function brainReading({ dob, name, year, today = new Date(), watch = null, owner = false }) {
  const f = personFacts({ dob, name, year, today });
  if (watch) f.watch = watch;
  const pick = set => matchRules(bySet(set), f).filter(r => !r.period).map(r => item(r, owner));
  const cnt = f.dobCounts;

  // Your numbers
  const numbers = {
    psychic: { value: f.psychic, planet: c.PLANET[f.psychic], items: pick('psychic') },
    destiny: { value: f.destiny, planet: c.PLANET[f.destiny], items: pick('destiny') },
    master: f.master ? { value: f.master, items: pick('master') } : null,
    karmic: f.karmic ? { value: f.karmic, items: pick('karmic') } : null,
    pair: { relation: REL[c.relation(f.psychic, f.destiny)] ?? null, items: pick('pairs') },
    personality: f.personality ? { value: f.personality, items: pick('personality') } : null,
    maturity: f.maturity ? { value: f.maturity, items: pick('maturity') } : null
  };

  // Timing: good and difficult periods for the birth number, with the one running today marked.
  const timing = matchRules(bySet('psychic').concat(bySet('destiny')), f).filter(r => r.period)
    .map(r => ({ ...item(r, owner), period: periodOf(r.period, today) })).filter(t => t.period);

  // Lo Shu grid (birth date): planes, missing numbers, repeated numbers
  const loshu = {
    layout: c.LOSHU_GRID, counts: cnt,
    planes: c.loShuPlanes(cnt),
    missing: f.missing,
    repeats: c.repeats(cnt).filter(x => x.times > 1),
    items: {
      planes: pick('planes'), missing: pick('missing'), repeats: pick('repeats'), present: pick('present')
    }
  };
  // The same repeat/present lines, grouped digit by digit so each number in the grid reads as one block.
  loshu.byDigit = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d => cnt[d] > 0).map(d => ({
    digit: d, times: cnt[d],
    items: [...loshu.items.present, ...loshu.items.repeats].filter(i => digitOf(i.id) === d)
      .map(i => ({ ...i, short: shorten(i.say) }))
  })).filter(g => g.items.length);

  // Name
  let nameReading = null;
  if (name && f.nameCompound) {
    const n = c.nameNumbers(name);
    nameReading = {
      total: n.total, root: n.root, parts: n.parts, firstLetter: n.firstLetter,
      withBirth: REL[c.relation(f.psychic, n.root)] ?? null,
      withDestiny: REL[c.relation(f.destiny, n.root)] ?? null,
      items: pick('name'), firstLetterItems: pick('first-letter')
    };
  }

  // Watch: grouped by the detail they read, in the form's order; therapy (what to change) separate.
  let watchReading = null;
  if (watch) {
    const ws = matchRules(bySet('watch'), f);
    const groups = WATCH_ATTRIBUTES.map(a => ({
      key: a.key, label: a.q, value: watch[a.key] ?? null,
      valueLabel: Array.isArray(watch[a.key]) ? watch[a.key].map(v => a.options[v]).join(', ') : a.options[watch[a.key]] ?? null,
      items: ws.filter(r => r.kind !== 'therapy' && Object.keys(flatWatch(r.when)).includes(a.key)).map(r => item(r, owner))
    })).filter(g => g.items.length);
    // A rule that reads two details (e.g. date window + where it sits) is shown once, under its first detail.
    const seen = new Set();
    for (const g of groups) g.items = g.items.filter(i => !seen.has(i.id) && seen.add(i.id));
    watchReading = { groups: groups.filter(g => g.items.length), therapy: ws.filter(r => r.kind === 'therapy').map(r => item(r, owner)) };
  }

  return { facts: { psychic: f.psychic, destiny: f.destiny, personalYear: f.personalYear }, numbers, timing, loshu, name: nameReading, watch: watchReading };
}

function flatWatch(when, out = {}) {
  if (!when) return out;
  if (when.all) when.all.forEach(w => flatWatch(w, out));
  else if (when.any) when.any.forEach(w => flatWatch(w, out));
  else if (when.watch) Object.assign(out, when.watch);
  return out;
}
