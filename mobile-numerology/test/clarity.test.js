// "Your answer": one plain verdict and three next steps, built only from what the reading contains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, publicView } from '../engine/core.js';
import { rulebook } from '../engine/rulebook.js';
import { clarity } from '../engine/clarity.js';

const engine = createEngine(rulebook);
const read = (mobile, dob, concern, planned = []) => publicView(engine.reading({ name: 'Rahul Sharma', mobile, dob, concern, planned, year: 2026 }));

test('money concern with more points that need care: working against, change the number, consult', () => {
  const r = read('9811045672', '1988-10-29', 'Paisa nahi tikta');
  const c = clarity(r);
  assert.equal(c.tone, 'against');
  assert.equal(c.headline, 'Your number is working against your money.');
  assert.equal(c.why, '9 parts of your reading touch your money, and 8 of them need care. 7 of them come from your mobile number, so a new number can remove them. 1 comes from your birth date and stays; your protection helps with it.');
  assert.deepEqual(c.steps.map(s => s.id), ['protect', 'change', 'consult']);
  assert.equal(c.steps[0].text, 'Set the phone screen saver shown for you, wear the White Moonstone Bracelet and keep Chandramani.');
  assert.deepEqual(c.steps[1].avoid, ['1-4 / 4-1', '5-6 / 6-5', 'Sun Moon Rahu']);
  assert.match(c.steps[1].text, /^Pick a number without 1-4 \/ 4-1, 5-6 \/ 6-5 and Sun Moon Rahu, and look for /);
  assert.equal(c.steps[2].action, 'whatsapp');
});

test('every name in the answer comes from the reading itself', () => {
  let seed = 11;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let i = 0; i < 1500; i++) {
    const mobile = `${6 + rnd(4)}${String(rnd(1e9)).padStart(9, '0')}`;
    const dob = `${1950 + rnd(60)}-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
    const r = read(mobile, dob, ['paisa', 'job', 'shaadi', 'health', 'xyz', 'karza', 'family'][rnd(7)]);
    const c = clarity(r);
    const all = JSON.stringify(r);
    assert.ok(['against', 'mixed', 'supports', 'care', 'good', 'even'].includes(c.tone));
    assert.ok(c.headline && c.why && c.steps.length >= 2);
    assert.ok(!/undefined|NaN|without \.|  /.test(JSON.stringify(c)), JSON.stringify(c));
    for (const t of [...(c.steps.find(s => s.id === 'change')?.avoid || []), ...(c.steps.find(s => s.id === 'change')?.lookFor || [])]) {
      assert.ok(all.includes(JSON.stringify(t)), `not in the reading: ${t}`);
    }
    // keep vs change follows the tone
    assert.equal(c.steps.some(s => s.id === 'change'), ['against', 'mixed', 'care', 'even'].includes(c.tone));
    // a headline never claims more strengths than there are
    if (c.tone === 'good') assert.ok(c.strengths > c.carePoints);
    if (c.tone === 'care') assert.ok(c.carePoints > c.strengths);
    assert.ok(!/\b1 (parts|points) |\b1 of them come\b/.test(c.why), c.why);
  }
});

test('the same reading always gives the same answer', () => {
  const a = clarity(read('9811045672', '1988-10-29', 'Paisa nahi tikta'));
  const b = clarity(read('9811045672', '1988-10-29', 'Paisa nahi tikta'));
  assert.deepEqual(a, b);
});

test('a concern no rule speaks to falls back to the whole number', () => {
  const c = clarity(read('9811045672', '1988-10-29', 'xyz qwerty'));
  assert.ok(['care', 'good', 'even'].includes(c.tone));
  assert.equal(c.area, 'what you shared');
});

// "Don't use this number for": the owner's list (rules/not-for.json), shown only when the answer is to change the number.
const notForRules = rulebook.notFor.rules;

test('money concern against money: the owner\'s money list, then the other parts of life it works against', () => {
  const c = clarity(read('9811045672', '1988-10-29', 'Paisa nahi tikta'));
  assert.deepEqual(c.notFor.uses, ['Bank accounts and UPI', 'Broker and trading accounts', 'Loans, investments and big purchases', 'Tax, GST and other official money work']);
  assert.deepEqual(c.notFor.others, ['your health', 'your court and legal matters', 'your peace of mind']);
  assert.equal(c.notFor.othersText, "It isn't suitable for your health, your court and legal matters or your peace of mind either.");
});

test('the not-for section counts only the mobile number, and only parts of life where more needs care than helps', () => {
  const r = read('9811045672', '1988-10-29', 'Paisa nahi tikta');
  const s = Object.fromEntries(r.sections.map(x => [x.id, x]));
  const mobileItems = [...s.decoded.pairs, ...s['mobile-grid'].yogas];
  for (const a of s['not-for'].areas) {
    const t = mobileItems.filter(x => x.areas.includes(a.area));
    assert.equal(a.care, t.filter(x => x.polarity === 'negative').length);
    assert.equal(a.help, t.filter(x => x.polarity === 'positive').length);
    assert.ok(a.care > a.help);
    for (const b of a.because) assert.ok(mobileItems.some(x => x.title === b), b);
  }
  // This reading's money concern includes a birth-date point; the counts above match the mobile number alone.
  assert.ok(s.concern.items.some(x => x.fromDob));
});

test('not-for follows the answer: never when the number is kept, uses only for what they asked about, no gaps', () => {
  let seed = 7;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  const allUses = new Set(notForRules.flatMap(r => r.uses));
  let shownUses = 0;
  for (let i = 0; i < 1500; i++) {
    const mobile = `${6 + rnd(4)}${String(rnd(1e9)).padStart(9, '0')}`;
    const dob = `${1950 + rnd(60)}-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
    const r = read(mobile, dob, ['paisa', 'job', 'shaadi', 'health', 'xyz', 'karza', 'court case', 'visa', 'business'][rnd(9)]);
    const c = clarity(r);
    const nf = r.sections.find(x => x.id === 'not-for').areas;
    if (!c.change) { assert.equal(c.notFor, null); continue; }
    if (!c.notFor) { assert.ok(nf.every(a => a.concern && !a.uses.length)); continue; }
    const asked = new Set(r.sections.find(x => x.id === 'concern').areas);
    for (const u of c.notFor.uses) {
      assert.ok(allUses.has(u), u);
      assert.ok(nf.some(a => asked.has(a.area) && a.uses.includes(u)), `${u} shown, but they did not ask about that part of life`);
    }
    shownUses += c.notFor.uses.length;
    assert.ok(c.notFor.uses.length <= 5 && c.notFor.others.length <= 3);
    assert.ok(!/undefined|NaN|  |for \.|for either/.test(JSON.stringify(c.notFor)), JSON.stringify(c.notFor));
    if (c.notFor.others.length) assert.match(c.notFor.othersText, /^(It isn't|This number isn't) suitable for .+\.$/);
  }
  assert.ok(shownUses > 0, 'some random readings show a list');
});

test('every not-for rule names a real part of life and has its own quote', () => {
  const areas = new Set(Object.keys(rulebook.keywords.areas));
  for (const r of notForRules) {
    assert.ok(areas.has(r.area), r.area);
    assert.ok(r.uses.length >= 1 && r.uses.every(u => typeof u === 'string' && u.length > 3));
  }
  assert.equal(new Set(notForRules.map(r => r.area)).size, notForRules.length);
  assert.equal(notForRules.find(r => r.area === 'money').basis, 'owner list');
  for (const a of ['health', 'family', 'mind', 'spiritual']) assert.ok(!notForRules.some(r => r.area === a), `${a} has no list`);
});
