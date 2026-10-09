// The reading summary Kamala gets: short, deterministic, and every point is the rulebook's own wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, publicView } from '../engine/core.js';
import { rulebook } from '../engine/rulebook.js';
import { readingSummary } from '../engine/summary.js';

const engine = createEngine(rulebook);
const read = (mobile, dob, concern = 'Paisa nahi tikta', planned = []) =>
  publicView(engine.reading({ name: 'Rahul Sharma', mobile, dob, concern, planned, year: 2026 }));

test('summary carries the concern, what the reading showed for it, and the planned-number comparison', () => {
  const s = readingSummary(read('9811045672', '1988-10-29', 'Paisa nahi tikta', ['9876500295']));
  assert.match(s, /Their concern, in their words: "Paisa nahi tikta"/);
  assert.match(s, /What the reading showed for this concern \(life areas: money\)/);
  assert.match(s, /pair 5-6 \/ 6-5: You may be unable to ask for money, and that is why money gets stuck\./);
  assert.match(s, /Personal year: 2026 = \d, 2027 = \d\./);
  assert.match(s, /Planned number 9876500295 compared with their current number: problems removed \d+/);
  assert.equal(s, readingSummary(read('9811045672', '1988-10-29', 'Paisa nahi tikta', ['9876500295'])), 'deterministic');
});

test('a concern the rules do not cover says so instead of guessing', () => {
  assert.match(readingSummary(read('9811045672', '1988-10-29', 'xyz qwerty')), /Nothing in their number or birth date speaks directly to this concern/);
});

test('2,000 random readings: at most 3,500 characters, and every point is text from the reading itself', () => {
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 2000; i++) {
    const mobile = `${6 + rnd(4)}${String(rnd(1e9)).padStart(9, '0')}`;
    const dob = `${1950 + rnd(60)}-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
    const r = read(mobile, dob, ['job', 'shaadi', 'paisa', 'health', 'karza'][rnd(5)]);
    const s = readingSummary(r);
    assert.ok(s.length <= 3500, `${s.length} characters`);
    const all = JSON.stringify(r);
    for (const l of s.split('\n').filter(x => x.startsWith('- '))) {
      const text = l.slice(l.indexOf(': ') + 2);
      for (const part of text.split(' Care: ')) assert.ok(all.includes(JSON.stringify(part).slice(1, -1)), `not in the reading: ${part}`);
    }
  }
});
