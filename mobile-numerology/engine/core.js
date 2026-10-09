// Deterministic mobile-numerology engine. No AI, no I/O, no dependencies: the same input always gives
// the same output, and every story line carries the id of the rule it came from.
// createEngine(rulebook) -> { reading, normaliseMobile, parseDob, ... }

export const GRID = [[3, 1, 9], [6, 7, 5], [2, 8, 4]];
export const MAX_PLANNED = 3;

export function digitSum(n) {
  return String(n).split('').reduce((s, c) => s + Number(c), 0);
}

// Reduce to a single digit 1-9 (11 and 22 are reduced too, as in the sources' examples).
export function reduce(n) {
  let v = Math.abs(Math.trunc(n));
  while (v > 9) v = digitSum(v);
  return v;
}

export function normaliseMobile(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  if (!/^[6-9]\d{9}$/.test(d)) return { ok: false, error: 'Please enter a valid 10-digit Indian mobile number.' };
  return { ok: true, value: d };
}

export function parseDob(input, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input ?? '').trim());
  if (!m) return { ok: false, error: 'Please enter your date of birth.' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return { ok: false, error: 'That date of birth does not exist.' };
  }
  if (y < 1900 || date > today) return { ok: false, error: 'Please check the year of birth.' };
  return { ok: true, value: { y, m: mo, d, iso: m[0] } };
}

// Digits as read for the grid and the pairs: zeros are skipped (owner decision C2).
export const digitsNoZero = str => String(str).split('').map(Number).filter(n => n > 0);

export function gridCounts(digits) {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
  for (const n of digits) if (n >= 1 && n <= 9) c[n]++;
  return c;
}

export const dobDigits = dob => digitsNoZero(
  `${String(dob.d).padStart(2, '0')}${String(dob.m).padStart(2, '0')}${dob.y}`);

export const birthNumber = dob => reduce(dob.d);
export const destinyNumber = dob => reduce(digitSum(`${dob.d}${dob.m}${dob.y}`));
export const personalYear = (dob, year) => reduce(dob.d + dob.m + digitSum(year));

export function nameNumber(name, chaldean) {
  const value = {};
  for (const [num, letters] of Object.entries(chaldean)) for (const l of letters.split(' ')) value[l] = Number(num);
  const letters = String(name ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return null;
  const total = [...letters].reduce((s, l) => s + value[l], 0);
  return { total, number: reduce(total) };
}

// Polarity follows from which story parts a rule has: good and care = mixed.
export function polarity(story = {}) {
  if (story.good && story.care) return 'mixed';
  if (story.good) return 'positive';
  if (story.care) return 'negative';
  return 'neutral';
}

const pairKey = (a, b) => (a === 1 && b === 2) || (a === 2 && b === 1) ? `${a}${b}` : `${Math.min(a, b)}${Math.max(a, b)}`;

function containsRun(seq, run) {
  const s = seq.join('');
  return s.includes(run) || s.includes([...run].reverse().join(''));
}

// Profession code: '19' side by side either order; '371' in a row either direction; '6' anywhere; '3+75' = all terms.
export function codeMatches(code, seq, counts) {
  return code.split('+').every(t => t.length === 1 ? counts[Number(t)] > 0 : containsRun(seq, t));
}

export function concernAreas(text, keywords) {
  const t = ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  const areas = new Set();
  const words = [];
  for (const [area, list] of Object.entries(keywords.areas)) {
    for (const w of list) {
      if (t.includes(` ${w} `)) { areas.add(area); words.push(w); }
    }
  }
  return { areas: [...areas], words: [...new Set(words)] };
}

export function createEngine(rulebook) {
  const { shotgun, yogas, planets, professions, remedies, personalYear: py, conflicts, method, keywords } = rulebook;
  const shotgunByPair = new Map(shotgun.rules.map(r => [r.ordered ? r.pair : [...r.pair].sort().join(''), r]));
  const planetByDigit = new Map(planets.rules.map(r => [r.digit, r]));
  const remedyByBirth = new Map(remedies.rules.map(r => [r.birth_number, r]));
  const pyItem = new Map(Object.values(py.years).flat().map(i => [i.id, i]));
  const decided = new Map(conflicts.conflicts.map(c => [c.id, c]));

  const item = (r, kind, extra = {}) => ({
    id: r.id, kind, title: extra.title ?? r.name ?? r.field, areas: r.areas ?? [],
    polarity: polarity(r.story), ...(r.story ?? {}), ...extra,
    source: { file: r.source_file, ref: r.ref, quote: r.quote }
  });

  function shotgunFor(seq) {
    const counts = new Map();
    for (let i = 0; i + 1 < seq.length; i++) {
      const [a, b] = [seq[i], seq[i + 1]];
      if (a === b) continue;
      const key = pairKey(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([key, count]) => {
      const r = shotgunByPair.get(key);
      const title = r.ordered ? `${key[0]}-${key[1]}` : `${key[0]}-${key[1]} / ${key[1]}-${key[0]}`;
      return item({ ...r, source_file: shotgun.source_file }, 'shotgun', { title, pair: key, count });
    }).sort((x, y) => x.id.localeCompare(y.id));
  }

  function yogasFor(counts) {
    return yogas.rules
      .filter(r => r.present.every(d => counts[d] > 0) && r.absent.every(d => counts[d] === 0))
      .map(r => {
        const extraCare = (r.multiples ?? []).filter(m => counts[m.digit] >= m.min).map(m => m.care);
        const story = { ...r.story };
        if (extraCare.length) story.care = [story.care, ...extraCare].filter(Boolean).join(' ');
        return item({ ...r, story, source_file: yogas.source_file }, 'yoga', {
          group: r.group, planets: r.planets, present: r.present, absent: r.absent,
          remedy: r.remedy?.text, pattern: describePattern(r)
        });
      });
  }

  function professionsFor(seq, counts) {
    return professions.rules
      .map(r => ({ r, codes: r.codes.filter(c => codeMatches(c, seq, counts)) }))
      .filter(x => x.codes.length)
      .map(({ r, codes }) => ({
        id: r.id, kind: 'profession', title: r.field, areas: r.areas, polarity: 'positive',
        good: `Your number carries ${codes.map(c => c.replace('+', ' and ')).join(', ')}, a combination linked with ${r.field.toLowerCase()}.`,
        codes, source: { file: professions.source_file, ref: r.ref, quote: r.quote }
      }));
  }

  function mobileFeatures(mobile) {
    const seq = digitsNoZero(mobile);
    const counts = gridCounts(seq);
    return { mobile, seq, counts, pairs: shotgunFor(seq), yogas: yogasFor(counts), professions: professionsFor(seq, counts) };
  }

  const describePattern = r => {
    const has = r.present.join(', ');
    const without = r.absent.length ? ` without ${r.absent.join(', ')}` : '';
    return `${has}${without}`;
  };

  const planetsFor = counts => Object.entries(counts).filter(([, c]) => c > 0).map(([d, c]) => {
    const r = planetByDigit.get(Number(d));
    return { id: r.id, kind: 'planet', digit: r.digit, planet: r.planet, count: c, trait: r.story.trait, signifies: r.story.signifies,
      source: { file: planets.source_file, ref: r.ref, quote: r.quote } };
  });

  function yearAhead(dob, year, nameNo) {
    return [year, year + 1].map(y => {
      const n = personalYear(dob, y);
      const items = (py.years[n] ?? []).filter(it => {
        if (!it.conflict) return true;
        const c = decided.get(it.conflict);
        const opt = c?.decision && c.options.find(o => o.key === c.decision);
        return opt ? opt.show.includes(it.id) : false; // undecided conflicts are never shown
      }).map(it => ({
        id: it.id, cat: it.cat, text: it.text,
        appliesToName: it.name_numbers && nameNo ? it.name_numbers.includes(nameNo.number) : undefined,
        source: { file: py.sources[it.src], quote: it.quote }
      }));
      for (const c of conflicts.conflicts) {
        const opt = c.decision && c.options.find(o => o.key === c.decision);
        // An option that shows neither side carries its own agreed text (e.g. "leave black out").
        if (opt?.text && !opt.show.length && c.sides.some(s => (py.years[n] ?? []).includes(pyItem.get(s)))) {
          items.push({ id: `${c.id}:${opt.key}`, cat: pyItem.get(c.sides[0]).cat, text: opt.text, source: { conflict: c.id } });
        }
      }
      return { year: y, number: n, items: dedupeById(items) };
    });
  }

  const dedupeById = list => [...new Map(list.map(i => [i.id, i])).values()];

  function protection(dob, mobileYogas, dobYogas) {
    const b = birthNumber(dob);
    const dest = destinyNumber(dob);
    const r = remedyByBirth.get(b);
    const savers = [];
    if (r.screen_saver_from === 'destiny') {
      const dr = remedyByBirth.get(dest);
      if (dest !== b && dr?.screen_saver) savers.push(`For your destiny number ${dest}: ${dr.screen_saver}`);
    }
    if (r.screen_saver) savers.push(r.screen_saver);
    const yogaRemedies = dedupeById([...mobileYogas, ...dobYogas].filter(y => y.remedy))
      .map(y => ({ id: y.id, title: y.title, text: y.remedy }));
    return {
      birthNumber: b, destinyNumber: dest,
      screenSaver: savers, bracelet: r.bracelet, mani: r.mani,
      yogaRemedies, source: { file: remedies.source_file, ref: r.ref, quote: r.quote }
    };
  }

  // Patterns for a better number, built only from the rulebook (owner decision: patterns, never sample numbers).
  function betterNumber(current, areas) {
    const avoid = [...current.pairs, ...current.yogas].filter(x => x.care)
      .map(x => ({ id: x.id, title: x.title, pattern: x.kind === 'shotgun' ? `${x.title} side by side` : x.pattern, why: x.care }));
    const wanted = new Set(areas);
    const pure = [
      ...shotgun.rules.filter(r => r.story.good && !r.story.care).map(r => ({ r, kind: 'shotgun' })),
      ...yogas.rules.filter(r => r.story.good && !r.story.care).map(r => ({ r, kind: 'yoga' }))
    ];
    const ranked = pure
      .map(({ r, kind }) => ({ r, kind, hits: (r.areas ?? []).filter(a => wanted.has(a)).length }))
      .filter(x => !wanted.size || x.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.r.id.localeCompare(b.r.id));
    const have = new Set([...current.pairs, ...current.yogas].map(x => x.id));
    const lookFor = ranked.map(({ r, kind }) => ({
      id: r.id, have: have.has(r.id), title: kind === 'shotgun' ? (r.ordered ? `${r.pair[0]}-${r.pair[1]}` : `${r.pair[0]}-${r.pair[1]} / ${r.pair[1]}-${r.pair[0]}`) : r.name,
      pattern: kind === 'shotgun' ? 'these two digits side by side' : `digits ${describePattern(r)}`,
      why: r.story.good, areas: r.areas
    }));
    return { avoid, lookFor };
  }

  function compare(cur, plan, areas) {
    const all = f => [...f.pairs, ...f.yogas];
    const ids = list => new Set(list.map(x => x.id));
    const careC = all(cur).filter(x => x.care), careP = all(plan).filter(x => x.care);
    const goodC = all(cur).filter(x => x.good), goodP = all(plan).filter(x => x.good);
    const [cC, cP, gC, gP] = [careC, careP, goodC, goodP].map(ids);
    const brief = x => ({ id: x.id, title: x.title, kind: x.kind, areas: x.areas });
    const lists = {
      problemsRemoved: careC.filter(x => !cP.has(x.id)).map(x => ({ ...brief(x), text: x.care })),
      problemsAdded: careP.filter(x => !cC.has(x.id)).map(x => ({ ...brief(x), text: x.care })),
      problemsStay: careC.filter(x => cP.has(x.id)).map(x => ({ ...brief(x), text: x.care })),
      strengthsGained: goodP.filter(x => !gC.has(x.id)).map(x => ({ ...brief(x), text: x.good })),
      strengthsLost: goodC.filter(x => !gP.has(x.id)).map(x => ({ ...brief(x), text: x.good })),
      strengthsKept: goodC.filter(x => gP.has(x.id)).map(x => ({ ...brief(x), text: x.good })),
      professionsGained: plan.professions.filter(p => !cur.professions.some(q => q.id === p.id)).map(p => p.title),
      professionsLost: cur.professions.filter(p => !plan.professions.some(q => q.id === p.id)).map(p => p.title)
    };
    const wanted = new Set(areas);
    const forConcern = wanted.size ? Object.fromEntries(Object.entries(lists)
      .filter(([k]) => !k.startsWith('professions'))
      .map(([k, v]) => [k, v.filter(x => x.areas.some(a => wanted.has(a)))])) : null;
    const counts = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
    return { planned: plan.mobile, lists, forConcern, counts };
  }

  function reading(input) {
    const year = input.year;
    const errors = {};
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) errors.name = 'Please enter your name.';
    const mob = normaliseMobile(input.mobile);
    if (!mob.ok) errors.mobile = mob.error;
    const dob = parseDob(input.dob, input.today ?? new Date());
    if (!dob.ok) errors.dob = dob.error;
    const concern = String(input.concern ?? '').trim().replace(/\s+/g, ' ');
    if (concern.length < 2 || concern.length > 300) errors.concern = 'Please tell us what you are worried about.';
    const planned = [];
    const rawPlanned = (input.planned ?? []).filter(p => String(p ?? '').trim());
    if (rawPlanned.length > MAX_PLANNED) errors.planned = `You can compare up to ${MAX_PLANNED} numbers.`;
    for (const p of rawPlanned.slice(0, MAX_PLANNED)) {
      const n = normaliseMobile(p);
      if (!n.ok) { errors.planned = 'Please check the number(s) you plan to buy.'; break; }
      if (mob.ok && n.value === mob.value) { errors.planned = 'The planned number is the same as your current number.'; break; }
      if (!planned.includes(n.value)) planned.push(n.value);
    }
    if (!Number.isInteger(year)) errors.year = 'year is required';
    if (Object.keys(errors).length) return { ok: false, errors };

    const cur = mobileFeatures(mob.value);
    const dobCounts = gridCounts(dobDigits(dob.value));
    const dobYogas = yogasFor(dobCounts);
    const { areas, words } = concernAreas(concern, keywords);
    const nameNo = nameNumber(name, method.chaldean);
    const wanted = new Set(areas);
    const touches = x => x.areas?.some(a => wanted.has(a));
    const mobileItems = [...cur.pairs, ...cur.yogas];
    const showsHealth = wanted.has('health') || mobileItems.some(x => x.areas.includes('health') && x.care);

    const sections = [];
    sections.push({ id: 'decoded', mobile: cur.mobile, zeros: [...cur.mobile].map((c, i) => c === '0' ? i : -1).filter(i => i >= 0), pairs: cur.pairs });
    sections.push({ id: 'mobile-grid', counts: cur.counts, planets: planetsFor(cur.counts), yogas: cur.yogas });
    sections.push({ id: 'dob-grid', counts: dobCounts, yogas: dobYogas });
    sections.push({ id: 'concern', text: concern, matchedWords: words, areas,
      items: areas.length ? [...mobileItems, ...dobYogas.map(y => ({ ...y, fromDob: true }))].filter(touches) : [] });
    if (cur.professions.length) sections.push({ id: 'career', professions: cur.professions });
    sections.push({ id: 'year-ahead', years: yearAhead(dob.value, year, nameNo), forEveryone: py.for_everyone.filter(i => !i.areas || i.areas.some(a => wanted.has(a))).map(i => ({ id: i.id, text: i.text })) });
    if (nameNo) sections.push({ id: 'name', ...nameNo, method: 'Chaldean' });
    const ifKept = mobileItems.filter(x => x.care);
    if (ifKept.length) sections.push({ id: 'if-kept', items: ifKept.map(x => ({ id: x.id, title: x.title, kind: x.kind, text: x.care, areas: x.areas, forConcern: touches(x) })) });
    sections.push({ id: 'protection', ...protection(dob.value, cur.yogas, dobYogas) });
    sections.push({ id: 'better-number', ...betterNumber(cur, areas) });
    if (planned.length) sections.push({ id: 'compare', current: cur.mobile, comparisons: planned.map(p => compare(cur, mobileFeatures(p), areas)) });
    sections.push({ id: 'cta', healthNote: showsHealth });

    return {
      ok: true,
      input: { name, mobile: mob.value, dob: dob.value.iso, concern, planned, year },
      numbers: { birth: birthNumber(dob.value), destiny: destinyNumber(dob.value), personalYear: personalYear(dob.value, year), name: nameNo?.number ?? null },
      sections
    };
  }

  return { reading, mobileFeatures, yogasFor, shotgunFor, compare, concernAreas: t => concernAreas(t, keywords) };
}

// Removes source references (quotes, slide refs) so the public site never exposes the rulebook text.
export function publicView(result) {
  return JSON.parse(JSON.stringify(result, (k, v) => (k === 'source' ? undefined : v)));
}
