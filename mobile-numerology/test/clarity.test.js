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
  assert.equal(c.steps[0].text, 'Set the phone screen saver shown for you, wear the Moon howlite bracelet (or sphatik) and keep Chandramani.');
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
