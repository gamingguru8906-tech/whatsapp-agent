// Facts and rule matching. A rule applies only when every part of its `when` holds on the person's facts;
// a fact that is unknown never holds (the brain never guesses).

import * as c from './calc.js';

// Everything the rules can ask about a person, from their date of birth and name.
export function personFacts({ dob, name, year, today }) {
  const cnt = c.counts(c.dobDigits(dob));
  const n = name ? c.nameNumbers(name) : null;
  const psychic = c.birthNumber(dob);
  const destiny = c.destinyNumber(dob);
  return {
    psychic, destiny,
    dayIs: dob.d,
    destinyCompound: c.digitSum(`${dob.d}${dob.m}${dob.y}`),
    age: today ? ageOn(dob, today) : null,
    master: c.masterDestiny(dob),
    karmic: c.karmicDebtDay(dob),
    personalYear: year ? c.personalYear(dob, year) : null,
    dobCounts: cnt,
    missing: c.missingDigits(cnt),
    planes: Object.fromEntries(c.loShuPlanes(cnt).map(p => [p.id, p.state])),
    nameCompound: n?.total ?? null,
    nameRoot: n?.root ?? null,
    firstNameRoot: n?.firstName.root ?? null,
    firstLetter: n?.firstLetter ?? null,
    initials: n ? n.parts.filter(p => p.word.length === 1).map(p => p.word) : [],
    partRoots: n ? n.parts.map(p => p.root) : [],
    maturity: n ? c.maturityNumber(destiny, n.root) : null,
    personality: name ? c.personalityNumber(name) : null
  };
}

// Completed years on `today` (UTC date parts).
function ageOn(dob, today) {
  const y = today.getUTCFullYear(), m = today.getUTCMonth() + 1, d = today.getUTCDate();
  return y - dob.y - ((m < dob.m || (m === dob.m && d < dob.d)) ? 1 : 0);
}

const inList = (v, list) => v !== null && v !== undefined && list.includes(v);

export function holds(when, f) {
  if (!when) return false;
  if (when.all) return when.all.every(w => holds(w, f));
  if (when.any) return when.any.some(w => holds(w, f));
  if (when.not) return !holds(when.not, f) && Object.keys(when.not).every(k => f[k] !== null && f[k] !== undefined);
  return Object.entries(when).every(([k, v]) => {
    switch (k) {
      case 'psychic': case 'destiny': case 'master': case 'karmic': case 'maturity': case 'personality':
      case 'personalYear': case 'nameCompound': case 'nameRoot': case 'firstNameRoot':
      case 'dayIs': case 'destinyCompound': case 'age':
        return inList(f[k], v);
      case 'firstLetter': return inList(f.firstLetter, v);
      case 'initialLetter': return f.initials.some(i => v.includes(i));
      case 'partRoot': return f.partRoots.some(p => v.includes(p));
      case 'lacks': return v.every(d => f.missing.includes(d));
      case 'has': return v.every(d => (f.dobCounts[d] ?? 0) > 0);
      case 'repeat': return v.times.includes(f.dobCounts[v.digit] ?? 0);
      case 'plane': return f.planes[v.id] === v.state;
      case 'pair': return v.some(([p, d]) => f.psychic === p && f.destiny === d);
      case 'watch': return Object.entries(v).every(([attr, vals]) => {
        const have = f.watch?.[attr];
        return Array.isArray(have) ? have.some(h => vals.includes(h)) : inList(have, vals);
      });
      default: return false; // an unknown condition never holds
    }
  });
}

// Approved rules that apply, best source first within each set.
export function matchRules(rules, facts) {
  return rules.filter(r => r.status === 'approved' && holds(r.when, facts))
    .sort((a, b) => (a.source.rank - b.source.rank) || a.id.localeCompare(b.id));
}
