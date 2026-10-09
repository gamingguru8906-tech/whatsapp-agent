import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createEngine, reduce, personalYear, birthNumber, destinyNumber, normaliseMobile, parseDob,
  gridCounts, dobDigits, codeMatches, digitsNoZero, nameNumber, publicView, polarity
} from '../engine/core.js';
import { rulebook, baseRulebook, applyReview } from '../engine/rulebook.js';

const engine = createEngine(rulebook);
const dob = iso => parseDob(iso).value;
const ids = list => list.map(x => x.id).sort();
const base = { name: 'Asha Verma', mobile: '9876543210', dob: '1990-05-14', concern: 'money is not staying', year: 2026 };

test('rulebook passes the source check', () => {
  const script = fileURLToPath(new URL('../scripts/lint-rulebook.js', import.meta.url));
  execFileSync(process.execPath, [script], { stdio: 'pipe' });
});

// ---- Golden tests taken from the sources ----
test('P01 example: Rajiv Gandhi 20/8/1944 has Moon-Saturn-Rahu (2-8-4) on the birth grid', () => {
  const y = engine.yogasFor(gridCounts(dobDigits(dob('1944-08-20'))));
  assert.ok(ids(y).includes('YG-P-284'));
});

test('P01 example: Sania Mirza 15/11/1986 has the 1-6-5-8 Raj Yog on the birth grid', () => {
  const y = engine.yogasFor(gridCounts(dobDigits(dob('1986-11-15'))));
  assert.ok(ids(y).includes('YG-Q-1658'));
});

test('T01/T03 personal-year examples', () => {
  const cases = [
    ['2001-08-18', 2025, 8], ['2001-09-18', 2025, 9], ['2001-09-18', 2026, 1],
    ['2007-11-10', 2025, 3], ['2007-11-10', 2026, 4], ['1987-12-15', 2025, 9], ['1987-12-15', 2026, 1],
    ['1999-06-28', 2026, 8], ['1997-09-05', 2025, 5], ['1997-09-05', 2026, 6],
    ['2000-05-01', 2025, 6], ['2000-06-10', 2025, 7], ['2000-08-01', 2025, 9], ['2000-11-02', 2025, 4],
    ['2000-03-05', 2025, 8], ['2000-11-18', 2025, 2], ['2000-10-10', 2025, 2]
  ];
  for (const [d, y, want] of cases) assert.equal(personalYear(dob(d), y), want, `${d} in ${y}`);
});

test('T01 example: 18 September 2001 is birth number 9, destiny number 3', () => {
  assert.equal(birthNumber(dob('2001-09-18')), 9);
  assert.equal(destinyNumber(dob('2001-09-18')), 3);
});

// ---- Method decisions ----
test('reduce never keeps 11 or 22', () => {
  assert.equal(reduce(11), 2); assert.equal(reduce(22), 4); assert.equal(reduce(38), 2); assert.equal(reduce(9), 9);
});

test('X on a diagram means absent: 7+5 without 6 is Easy Money Yoga; with 6 it becomes the Raj Yog plane', () => {
  const a = ids(engine.mobileFeatures('7575757575').yogas);
  assert.ok(a.includes('YG-C-75'));
  assert.ok(!a.includes('YG-P-675'));
  const b = ids(engine.mobileFeatures('7575757576').yogas);
  assert.ok(!b.includes('YG-C-75'));
  assert.ok(b.includes('YG-P-675'));
});

test('zero is skipped: 9-8-0-5 reads as 9-8 and 8-5', () => {
  const f = engine.mobileFeatures('9805999999');
  assert.deepEqual(f.seq, [9, 8, 5, 9, 9, 9, 9, 9, 9]);
  assert.deepEqual(ids(f.pairs), ['SG-58', 'SG-59', 'SG-89']);
  assert.equal(f.counts[0], undefined);
});

test('1-2 and 2-1 are different; other pairs read both ways; repeats are counted; same-digit pairs ignored', () => {
  const f = engine.mobileFeatures('9121212133');
  const by = Object.fromEntries(f.pairs.map(p => [p.id, p.count]));
  assert.equal(by['SG-12'], 3);
  assert.equal(by['SG-21'], 3);
  assert.equal(by['SG-19'], 1);
  assert.equal(by['SG-13'], 1);
  assert.equal(f.pairs.length, 4);
});

test('mobile number normalisation: only the 10-digit number is read', () => {
  assert.equal(normaliseMobile('+91 98765 43210').value, '9876543210');
  assert.equal(normaliseMobile('09876543210').value, '9876543210');
  assert.equal(normaliseMobile('919876543210').value, '9876543210');
  assert.equal(normaliseMobile('5876543210').ok, false);
  assert.equal(normaliseMobile('98765').ok, false);
  assert.equal(normaliseMobile('').ok, false);
});

test('date of birth validation', () => {
  assert.equal(parseDob('1990-02-30').ok, false);
  assert.equal(parseDob('1890-01-01').ok, false);
  assert.equal(parseDob('2999-01-01').ok, false);
  assert.equal(parseDob('14/05/1990').ok, false);
  assert.deepEqual(parseDob('1990-05-14').value, { y: 1990, m: 5, d: 14, iso: '1990-05-14' });
});

test('profession codes: side by side in either order, triples in a row either direction, AND terms anywhere', () => {
  const m = s => { const seq = digitsNoZero(s); return c => codeMatches(c, seq, gridCounts(seq)); };
  assert.ok(m('9100000000')('19'));
  assert.ok(m('9800000019')('19'));
  assert.ok(!m('9200000001')('19'));
  assert.ok(m('9173000000')('371'));
  assert.ok(m('9371000000')('371'));
  assert.ok(!m('9317000000')('371'));
  assert.ok(m('9300000007')('3+7'));
  assert.ok(m('9375000000')('3+75') && !m('9735000000')('3+75'));
  assert.ok(m('9800000000')('8'));
});

test('zero skipping applies to profession codes too: 1-0-9 counts as 19', () => {
  const seq = digitsNoZero('9810900000');
  assert.ok(codeMatches('19', seq, gridCounts(seq)));
});

test('Chaldean name number', () => {
  assert.deepEqual(nameNumber('Abc', baseRulebook.method.chaldean), { total: 6, number: 6 });
  assert.equal(nameNumber('राम', baseRulebook.method.chaldean), null);
});

test('concern keywords (free text, English and Hinglish)', () => {
  assert.deepEqual(engine.concernAreas('Paisa nahi tikta').areas, ['money']);
  assert.ok(engine.concernAreas('shaadi mein deri ho rahi hai').areas.includes('relationship'));
  assert.ok(engine.concernAreas('My JOB, and loans!').areas.includes('career'));
  assert.deepEqual(engine.concernAreas('xyz abc').areas, []);
  assert.deepEqual(engine.concernAreas('homework').areas, [], 'whole words only');
});

test('polarity comes from the story parts', () => {
  assert.equal(polarity({ good: 'a', care: 'b' }), 'mixed');
  assert.equal(polarity({ good: 'a' }), 'positive');
  assert.equal(polarity({ care: 'b', trait: 't' }), 'negative');
  assert.equal(polarity({ trait: 't' }), 'neutral');
});

// ---- Comparison ----
test('comparison mirrors when current and planned are swapped', () => {
  const a = engine.mobileFeatures('9876543210');
  const b = engine.mobileFeatures('7575757575');
  const ab = engine.compare(a, b, []).lists;
  const ba = engine.compare(b, a, []).lists;
  assert.deepEqual(ids(ab.problemsRemoved), ids(ba.problemsAdded));
  assert.deepEqual(ids(ab.strengthsGained), ids(ba.strengthsLost));
  assert.deepEqual(ids(ab.problemsStay), ids(ba.problemsStay));
  assert.deepEqual(ids(ab.strengthsKept), ids(ba.strengthsKept));
});

test('comparing a number with itself changes nothing', () => {
  const a = engine.mobileFeatures('9876543210');
  const c = engine.compare(a, a, []).counts;
  assert.equal(c.problemsRemoved + c.problemsAdded + c.strengthsGained + c.strengthsLost, 0);
});

test('planned numbers: same as current is rejected; up to 3; invalid rejected', () => {
  assert.equal(engine.reading({ ...base, planned: ['9876543210'] }).ok, false);
  assert.equal(engine.reading({ ...base, planned: ['1', '2', '3', '4'].map(x => `98765432${x}0`) }).ok, false);
  assert.equal(engine.reading({ ...base, planned: ['12345'] }).ok, false);
  const r = engine.reading({ ...base, planned: ['7575757575', '+91 9123456789', ''] });
  assert.equal(r.ok, true);
  assert.equal(r.sections.find(s => s.id === 'compare').comparisons.length, 2);
});

// ---- Conflicts ----
test('an undecided conflict shows neither side; a decision shows only the chosen side', () => {
  // 2001-09-18 in 2025 is personal year 9.
  const py9 = book => createEngine(book).reading({ ...base, dob: '2001-09-18', year: 2025 })
    .sections.find(s => s.id === 'year-ahead').years[0].items.map(i => i.id);
  const undecided = applyReview(baseRulebook, { conflicts: {} });
  const undecidedIds = py9(undecided);
  assert.ok(!undecidedIds.includes('PY9-T01-g') && !undecidedIds.includes('PY9-T03-f'));
  const t01 = py9(applyReview(baseRulebook, { conflicts: { 'CF-PY9-BLACK': 't01' } }));
  assert.ok(t01.includes('PY9-T01-g') && !t01.includes('PY9-T03-f'));
  const neither = py9(applyReview(baseRulebook, { conflicts: { 'CF-PY9-BLACK': 'neither' } }));
  assert.ok(neither.includes('CF-PY9-BLACK:neither') && !neither.includes('PY9-T01-g') && !neither.includes('PY9-T03-f'));
});

// ---- Whole reading ----
test('a full reading is deterministic and has the core sections', () => {
  const r1 = engine.reading(base);
  const r2 = engine.reading(base);
  assert.deepEqual(r1, r2);
  const s = r1.sections.map(x => x.id);
  for (const id of ['decoded', 'mobile-grid', 'dob-grid', 'concern', 'year-ahead', 'protection', 'better-number', 'cta']) assert.ok(s.includes(id), id);
  assert.equal(r1.numbers.personalYear, personalYear(dob('1990-05-14'), 2026));
});

test('the public view never contains source quotes', () => {
  const pub = JSON.stringify(publicView(engine.reading({ ...base, planned: ['7575757575'] })));
  assert.ok(!pub.includes('"source"'));
  assert.ok(!pub.includes('Slide '));
});

test('every shot-gun pair and every yoga can be reached', () => {
  for (const r of rulebook.shotgun.rules) {
    const [a, b] = r.pair;
    const f = engine.mobileFeatures(`9${a}${b}${'9'.repeat(7)}`);
    assert.ok(f.pairs.some(p => p.id === r.id), r.id);
  }
  for (const r of rulebook.yogas.rules) {
    const counts = gridCounts(r.present);
    assert.ok(engine.yogasFor(counts).some(y => y.id === r.id), r.id);
  }
});

test('100,000 random numbers: no crash, every section well formed', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const seen = new Set();
  for (let i = 0; i < 100000; i++) {
    const mobile = String(6 + Math.floor(rnd() * 4)) + Array.from({ length: 9 }, () => Math.floor(rnd() * 10)).join('');
    const f = engine.mobileFeatures(mobile);
    for (const x of [...f.pairs, ...f.yogas]) {
      assert.ok(x.good || x.care || x.trait, `${x.id} has no text`);
      seen.add(x.id);
    }
  }
  const r = engine.reading({ ...base, planned: ['6000000000', '9999999999'] });
  assert.equal(r.ok, true);
  assert.ok(seen.size > 60, `only ${seen.size} rules seen`);
});
