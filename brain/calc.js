// The brain's calculations. Pure functions, no I/O: the same input always gives the same numbers.
// Every calculation here is defined by a source (book page or transcript) or by an owner decision; where a book gives
// no formula (personal month and day, soul urge, success and challenge numbers, Kua) the brain does not calculate it.
// Sources: B-CHALDEAN (Chaldean Numerology guide), B-NAMENUM (Name Numerology), B-NUMNAME (Numerology and Name),
// B-LOSHU (Lo Shu file), T01/T03 (personal-year transcripts), P01 (SRK slides).

import loshu from './data/loshu.json' with { type: 'json' };
import relations from './data/relations.json' with { type: 'json' };

export const PLANET = { 1: 'Sun', 2: 'Moon', 3: 'Jupiter', 4: 'Rahu', 5: 'Mercury', 6: 'Venus', 7: 'Ketu', 8: 'Saturn', 9: 'Mars' };

// Chaldean (Cheiro) letter values. B-NUMNAME p. 2 prints this column letter for letter; B-NAMENUM's seven worked totals
// (THOMAS 24, R 2, VINCENT 29, SINGH 17, HITLER 20, PQRLSTOX 33) only add up with it. No letter is 9.
export const CHALDEAN = { 1: 'AIJQY', 2: 'BKR', 3: 'CGLS', 4: 'DMT', 5: 'EHNX', 6: 'UVW', 7: 'OZ', 8: 'FP' };
const LETTER = Object.fromEntries(Object.entries(CHALDEAN).flatMap(([n, ls]) => [...ls].map(l => [l, Number(n)])));
export const letterValue = l => LETTER[String(l).toUpperCase()] ?? null;

export const digitSum = n => String(Math.abs(Math.trunc(n))).split('').reduce((s, c) => s + Number(c), 0);

// Reduce to one digit 1-9 (11, 22 and 33 are reduced too: the sources reduce fully, e.g. T01 personal year).
export function reduce(n) {
  let v = Math.abs(Math.trunc(n));
  while (v > 9) v = digitSum(v);
  return v;
}

// ---------- Date of birth ----------

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

// Zeros are skipped everywhere a digit goes on a grid or forms a pair (owner decision C2).
export const digitsNoZero = str => String(str).split('').map(Number).filter(n => n > 0);
export const dobDigits = dob => digitsNoZero(`${String(dob.d).padStart(2, '0')}${String(dob.m).padStart(2, '0')}${dob.y}`);

export function counts(digits) {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
  for (const n of digits) if (n >= 1 && n <= 9) c[n]++;
  return c;
}

// Birth number (psychic, mulank) = day reduced. B-CHALDEAN pp. 4-30 lists the days for each number.
export const birthNumber = dob => reduce(dob.d);
// Destiny number (conductor, bhagyank) = every digit of the date added and reduced (T01 example: 18 Sep 2001 -> 3).
export const destinyNumber = dob => reduce(digitSum(`${dob.d}${dob.m}${dob.y}`));
// Master destiny (B-CHALDEAN p. 50): month, day and year reduced separately, then added; 11, 22 or 33 is a master number.
// Worked example: May 18 1970 -> 5 + 9 + 8 = 22.
export function masterDestiny(dob) {
  const sum = reduce(dob.m) + reduce(dob.d) + reduce(digitSum(dob.y));
  return [11, 22, 33].includes(sum) ? sum : null;
}
// Personal year = day + month + digits of the calendar year, reduced (T01, method M-PERSONAL-YEAR).
export const personalYear = (dob, year) => reduce(dob.d + dob.m + digitSum(year));
// Karmic debt: a day of birth of 13, 14, 16 or 19, read before it is reduced (B-NUMNAME p. 17).
export const karmicDebtDay = dob => ([13, 14, 16, 19].includes(dob.d) ? dob.d : null);

// ---------- Grids ----------

export const VEDIC_GRID = [[3, 1, 9], [6, 7, 5], [2, 8, 4]];
export const LOSHU_GRID = loshu.layout;
export const LOSHU_PLANES = loshu.planes;

// Lo Shu planes for a set of digit counts: missing = none of the three digits present, full = all three present.
export function loShuPlanes(c) {
  return LOSHU_PLANES.map(p => {
    const present = p.digits.filter(d => c[d] > 0);
    return { id: p.id, name: p.name, kind: p.kind, digits: p.digits, present,
      state: present.length === 0 ? 'missing' : present.length === 3 ? 'full' : 'partial' };
  });
}

export const missingDigits = c => [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d => !c[d]);
// Repeats as the books count them: once, twice, three times, four times (B-CHALDEAN pp. 66-70; B-LOSHU pp. 11-12).
export const repeats = c => [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d => c[d] > 0).map(d => ({ digit: d, times: c[d] }));

// ---------- Name (Chaldean) ----------

// Titles are not counted in a personal name (B-CHALDEAN p. 135: "Dr., Er., Prof. will NOT be considered").
const TITLES = new Set(['DR', 'ER', 'PROF']);

export function nameWords(name) {
  return String(name ?? '').toUpperCase().replace(/[^A-Z\s.]/g, ' ').split(/[\s.]+/)
    .map(w => w.replace(/[^A-Z]/g, '')).filter(w => w && !TITLES.has(w));
}

// The full total is the compound (10-108 in B-NAMENUM); every word and initial counts (THOMAS R. VINCENT = 24 + 2 + 29 = 55).
// The compound is read as it is (owner decision 5); the root (one digit) is shown second.
export function nameNumbers(name) {
  const words = nameWords(name);
  if (!words.length) return null;
  const parts = words.map(w => {
    const total = [...w].reduce((s, l) => s + LETTER[l], 0);
    return { word: w, total, root: reduce(total) };
  });
  const total = parts.reduce((s, p) => s + p.total, 0);
  const first = words[0];
  return { total, root: reduce(total), parts, firstName: parts[0], firstLetter: first[0], firstLetterValue: LETTER[first[0]] };
}

// Personality number (B-CHALDEAN p. 58): consonants only, reduced, 11/22/33 kept. A, E, I, O, U are the vowels.
// Y counts as a consonant here; the book does not say otherwise.
export function personalityNumber(name) {
  const letters = nameWords(name).join('').replace(/[AEIOU]/g, '');
  if (!letters) return null;
  let v = [...letters].reduce((s, l) => s + LETTER[l], 0);
  while (v > 9 && ![11, 22, 33].includes(v)) v = digitSum(v);
  return v;
}

// Maturity number (B-CHALDEAN pp. 103-104): destiny number + full-name number, reduced.
export const maturityNumber = (destiny, nameRoot) => reduce(destiny + nameRoot);

// ---------- Friend, neutral, enemy (B-CHALDEAN p. 31) ----------

export function relation(own, other) {
  const row = relations.rows[String(own)];
  if (!row) return null;
  for (const k of ['friend', 'neutral', 'enemy', 'mixed']) if (row[k].includes(other)) return k;
  return null;
}
